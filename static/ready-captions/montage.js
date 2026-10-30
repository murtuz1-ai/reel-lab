// Монтаж: вставки других видео между кусками, видео поверх и время ролика.
//
// Три шкалы времени:
//   S — время исходного видео: на нём текст, склейки ИИ, обрезка;
//   M — время «сборки»: исходник со вставками между кусками (вырезанное ещё на месте);
//   O — время готового ролика: M без вырезанных кусков.
//
// Предпросмотр и сборка работают в M: движок сам пропускает вырезанное, а
// субтитры, звуки и эффекты строятся по тем же словам, что и в предпросмотре.
// Лента монтажа показывает O — так, как ролик увидит зритель.
//
// Модуль без DOM и без движка: его можно проверять в Node.

export const MIN_CLIP = 0.2;
const EPS = 1e-6;

// Скорость клипа: 0.5 — замедление вдвое, 2 — ускорение вдвое. Длина в ролике = (out − in) / speed.
export const SPEEDS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3];
export const MIN_SPEED = 0.25;
export const MAX_SPEED = 4;
// Вставка с mediaKey "main" — кусок самого исходника (замедленный или ускоренный).
export const SELF_MEDIA = "main";

const finite = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** Скорость клипа (1 — как снято). */
export function clipSpeed(item) {
  const value = finite(item?.speed, 1);
  return value > 0 ? clamp(value, MIN_SPEED, MAX_SPEED) : 1;
}

/** Отрезки [start, end): по порядку, без наложений (соседние сливаются). */
export function normaliseRanges(ranges, { minLength = 0.02, join = 0.01 } = {}) {
  const sorted = (ranges || [])
    .map((range) => ({ start: finite(range?.start ?? range?.[0], NaN), end: finite(range?.end ?? range?.[1], NaN) }))
    .filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end) && range.end - range.start > minLength)
    .sort((a, b) => a.start - b.start);
  const merged = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end + join) last.end = Math.max(last.end, range.end);
    else merged.push({ start: Math.max(0, range.start), end: range.end });
  }
  return merged;
}

/** Вырезанные куски на одной шкале и перевод во время без них. */
export class RangeMap {
  constructor(ranges = [], options) {
    this.ranges = normaliseRanges(ranges, options);
    // before[i] — сколько вырезано до начала i-го куска.
    this.before = [];
    let sum = 0;
    for (const range of this.ranges) {
      this.before.push(sum);
      sum += range.end - range.start;
    }
    this.total = sum;
  }

  isEmpty() {
    return this.ranges.length === 0;
  }

  /** Номер последнего куска, начавшегося не позже t (или -1). */
  indexAt(t) {
    let lo = 0;
    let hi = this.ranges.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.ranges[mid].start <= t) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found;
  }

  rangeAt(t) {
    const index = this.indexAt(t);
    if (index < 0) return null;
    const range = this.ranges[index];
    return t < range.end ? range : null;
  }

  isSkipped(t) {
    return Boolean(this.rangeAt(t));
  }

  toOutput(t) {
    const index = this.indexAt(t);
    if (index < 0) return t;
    const range = this.ranges[index];
    return t - this.before[index] - (Math.min(t, range.end) - range.start);
  }

  /** Обратно; попадание точно в склейку — правая сторона (после вырезанного). */
  fromOutput(o) {
    let t = o;
    for (const range of this.ranges) {
      if (range.start <= t + EPS) t += range.end - range.start;
      else break;
    }
    return t;
  }

  /** Обратно; попадание точно в склейку — левая сторона (до вырезанного). */
  fromOutputLeft(o) {
    let t = o;
    for (const range of this.ranges) {
      if (range.start < t - EPS) t += range.end - range.start;
      else break;
    }
    return t;
  }

  totalSkipped() {
    return this.total;
  }

  /** Для движка: { startSec, endSec }. */
  toEngine() {
    return this.ranges.map((range) => ({ startSec: range.start, endSec: range.end }));
  }
}

function cleanClip(item, duration, kind) {
  const media = item?.media || {};
  const length = Math.max(MIN_CLIP, finite(media.duration, 0));
  const inPoint = clamp(finite(item.in, 0), 0, Math.max(0, length - MIN_CLIP));
  const outPoint = clamp(finite(item.out, length), inPoint + MIN_CLIP, Math.max(inPoint + MIN_CLIP, length));
  const speed = clipSpeed(item);
  return {
    ...item,
    kind,
    at: clamp(finite(item.at, 0), 0, duration),
    in: inPoint,
    out: outPoint,
    speed,
    // len — длина в ролике (с учётом скорости), out − in — сколько секунд клипа берётся.
    len: (outPoint - inPoint) / speed,
    seq: finite(item.seq, 0),
  };
}

/** Кадр клипа через delta секунд ролика от его начала. */
export function clipTimeAt(item, delta) {
  return item.in + clamp(delta, 0, item.len) * (item.speed || 1);
}

/**
 * Модель монтажа.
 *  duration — длина исходника (S);
 *  inserts  — [{ id, at, in, out, media: { duration } }] — видео между кусками;
 *  overlays — [{ id, at, in, out, media }] — видео поверх, голос продолжается;
 *  splits   — точки разреза на кусках исходника (S);
 *  skips    — вырезанные отрезки исходника (S), уже со склейками и обрезкой.
 */
export function buildMontage({ duration = 0, inserts = [], overlays = [], splits = [], skips = [] } = {}) {
  return new Montage({ duration, inserts, overlays, splits, skips });
}

export class Montage {
  constructor({ duration, inserts, overlays, splits, skips }) {
    const D = Math.max(0, finite(duration, 0));
    this.duration = D;
    this.inserts = (inserts || []).map((item) => cleanClip(item, D, "insert"))
      .sort((a, b) => a.at - b.at || a.seq - b.seq);
    // Накопленная длина вставок: lens[i] — сумма длин вставок 0..i-1.
    this.lens = [0];
    for (const item of this.inserts) this.lens.push(this.lens[this.lens.length - 1] + item.len);
    this.totalInserts = this.lens[this.lens.length - 1];
    this.totalM = D + this.totalInserts;
    this.splitsS = [...new Set((splits || []).map((value) => finite(value, NaN)).filter((value) => value > 0.05 && value < D - 0.05))].sort((a, b) => a - b);
    this.skipsS = new RangeMap(skips || []);

    // Отрезки сборки по порядку: куски исходника и вставки.
    this.segments = [];
    let curS = 0;
    let curM = 0;
    this.inserts.forEach((item) => {
      if (item.at > curS + EPS) {
        this.segments.push({ kind: "main", s0: curS, s1: item.at, m0: curM, m1: curM + (item.at - curS) });
        curM += item.at - curS;
        curS = item.at;
      }
      item.m0 = curM;
      item.m1 = curM + item.len;
      this.segments.push({ kind: "insert", item, m0: item.m0, m1: item.m1 });
      curM += item.len;
    });
    if (D > curS + EPS || !this.segments.length) this.segments.push({ kind: "main", s0: curS, s1: D, m0: curM, m1: curM + Math.max(0, D - curS) });

    // Вырезанное в шкале M: вставки внутри вырезанного куска остаются в ролике.
    const skipsM = [];
    for (const range of this.skipsS.ranges) {
      let start = this.toM(range.start);
      for (const item of this.inserts) {
        if (item.at <= range.start + EPS || item.at >= range.end - EPS) continue;
        if (item.m0 > start + EPS) skipsM.push({ start, end: item.m0 });
        start = Math.max(start, item.m1);
      }
      const end = this.toMLeft(range.end);
      if (end > start + EPS) skipsM.push({ start, end });
    }
    // Хвост обрезки может выходить за конец исходника: в M он упирается в конец сборки.
    this.skipsM = new RangeMap(skipsM.map((range) => ({ start: range.start, end: Math.min(range.end, this.totalM + 0.05) })), { minLength: 0.005, join: 0.002 });
    this.totalO = Math.max(0, this.skipsM.toOutput(this.totalM));
    this.firstM = this.fromO(0);

    this.overlays = (overlays || []).map((item) => this.placeOverlay(cleanClip(item, D, "overlay")));
  }

  get isEmpty() {
    return !this.inserts.length && !this.overlays.length;
  }

  /** Сколько вставок стоит не позже s (strict = строго раньше s). */
  countBefore(s, strict = false) {
    let lo = 0;
    let hi = this.inserts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const at = this.inserts[mid].at;
      if (strict ? at < s - EPS : at <= s + EPS) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** S → M; вставки, стоящие ровно в s, идут перед s. */
  toM(s) {
    return s + this.lens[this.countBefore(s)];
  }

  /** S → M; вставки, стоящие ровно в s, идут после s. */
  toMLeft(s) {
    return s + this.lens[this.countBefore(s, true)];
  }

  segmentIndexAt(m) {
    const list = this.segments;
    let lo = 0;
    let hi = list.length - 1;
    let found = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].m0 <= m + EPS) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    // Ровно на стыке побеждает следующий отрезок (кроме самого конца).
    return found;
  }

  segmentAt(m) {
    return this.segments[this.segmentIndexAt(m)] || null;
  }

  /** Время исходника в момент m сборки или null, если идёт вставка. */
  sourceAt(m) {
    const segment = this.segmentAt(m);
    if (!segment || segment.kind !== "main") return null;
    return clamp(segment.s0 + (m - segment.m0), segment.s0, segment.s1);
  }

  /** Кусок исходника, где стоит s (правая сторона для вставок ровно в s). */
  mainSegmentForSource(s) {
    const m = this.toM(s);
    const segment = this.segmentAt(m);
    return segment?.kind === "main" ? segment : this.segments.find((item) => item.kind === "main" && s >= item.s0 - EPS && s <= item.s1 + EPS) || null;
  }

  toO(m) {
    return clamp(this.skipsM.toOutput(m), 0, this.totalO);
  }

  fromO(o) {
    return clamp(this.skipsM.fromOutput(clamp(o, 0, this.totalO)), 0, this.totalM);
  }

  fromOLeft(o) {
    return clamp(this.skipsM.fromOutputLeft(clamp(o, 0, this.totalO)), 0, this.totalM);
  }

  /** S → O (вырезанное — к правому краю склейки). */
  sourceToO(s) {
    return this.toO(this.toM(s));
  }

  isSkippedM(m) {
    return this.skipsM.isSkipped(m);
  }

  insertPiecesO() {
    return this.inserts.map((item) => ({ item, o0: this.toO(item.m0), o1: this.toO(item.m1) }));
  }

  /** Видео поверх: где оно в ролике (O), где в сборке (M) и какой кадр клипа когда. */
  placeOverlay(item) {
    const oStart = this.toO(this.toM(item.at));
    let limit = this.totalO;
    for (const insert of this.inserts) {
      const o0 = this.toO(insert.m0);
      if (o0 >= oStart - EPS && o0 < limit) limit = o0;
    }
    // Вставка, на которой «стоит» якорь, уже позади: поверх идёт после неё.
    const oEnd = Math.max(oStart, Math.min(oStart + item.len, limit));
    const m0 = this.fromO(oStart);
    const m1 = this.fromOLeft(oEnd);
    const warp = [];
    for (const range of this.skipsM.ranges) {
      if (range.start <= m0 + EPS) continue;
      if (range.start >= m1 - EPS) break;
      warp.push({ d: this.toO(range.start) - oStart, len: range.end - range.start });
    }
    return { item, o0: oStart, o1: oEnd, m0, m1, warp, visible: oEnd - oStart >= 0.1 };
  }

  overlayAt(m) {
    if (this.isSkippedM(m)) return [];
    return this.overlays.filter((place) => place.visible && m >= place.m0 - EPS && m < place.m1 - EPS);
  }

  /** Кадр клипа поверх в момент m сборки. */
  overlayClipTime(place, m) {
    return clipTimeAt(place.item, this.toO(m) - place.o0);
  }

  /**
   * Куски ленты монтажа (время O): куски исходника (с разрезами) и вставки.
   * У куска исходника: s0..s1 в исходнике, m0..m1 в сборке, o0..o1 в ролике.
   */
  pieces() {
    const result = [];
    for (const segment of this.segments) {
      if (segment.kind === "insert") {
        const o0 = this.toO(segment.m0);
        result.push({ kind: "insert", key: `i:${segment.item.id}`, item: segment.item, m0: segment.m0, m1: segment.m1, o0, o1: o0 + segment.item.len });
        continue;
      }
      const offset = segment.m0 - segment.s0;
      // Видимые части отрезка: без вырезанного.
      let visible = [{ start: segment.m0, end: segment.m1 }];
      for (const range of this.skipsM.ranges) {
        if (range.end <= segment.m0 || range.start >= segment.m1) continue;
        const next = [];
        for (const part of visible) {
          if (range.end <= part.start || range.start >= part.end) next.push(part);
          else {
            if (range.start > part.start) next.push({ start: part.start, end: range.start });
            if (range.end < part.end) next.push({ start: range.end, end: part.end });
          }
        }
        visible = next;
      }
      for (const part of visible) {
        const cuts = this.splitsS.map((s) => s + offset).filter((m) => m > part.start + 0.05 && m < part.end - 0.05);
        const bounds = [part.start, ...cuts, part.end];
        for (let i = 0; i + 1 < bounds.length; i += 1) {
          const m0 = bounds[i];
          const m1 = bounds[i + 1];
          const o0 = this.toO(m0);
          const o1 = this.toO(m1);
          if (o1 - o0 < 0.01) continue;
          result.push({ kind: "main", key: `p:${(m0 - offset).toFixed(3)}`, s0: m0 - offset, s1: m1 - offset, m0, m1, o0, o1 });
        }
      }
    }
    return result.sort((a, b) => a.o0 - b.o0 || (a.kind === "insert" ? -1 : 1));
  }

  /** Склейки в ролике: где (O) и что вырезано (S). */
  junctions() {
    return this.skipsM.ranges.map((range) => {
      const segment = this.segmentAt(range.start + EPS);
      const offset = segment?.kind === "main" ? segment.m0 - segment.s0 : 0;
      const s0 = Math.max(0, range.start - offset);
      const s1 = Math.min(this.duration, range.end - offset);
      return { key: `j:${s0.toFixed(3)}`, o: this.toO(range.start), m0: range.start, m1: range.end, s0, s1, seconds: s1 - s0 };
    }).filter((junction) => junction.s1 - junction.s0 > 0.005);
  }

  /**
   * Фразы в шкале M. Фраза, через которую проходит вставка, делится на две:
   * во время вставки субтитров нет.
   */
  cuesToM(cues) {
    if (!this.inserts.length) return cues;
    const result = [];
    for (const cue of cues || []) {
      const words = cue.words || [];
      if (!words.length) {
        const offset = this.toM(cue.start) - cue.start;
        result.push({ ...cue, start: cue.start + offset, end: cue.end + offset });
        continue;
      }
      const parts = [];
      let current = null;
      for (const word of words) {
        const offset = this.toM(word.start) - word.start;
        if (!current || Math.abs(current.offset - offset) > EPS) {
          current = { offset, words: [] };
          parts.push(current);
        }
        current.words.push({ ...word, start: word.start + offset, end: word.end + offset });
      }
      parts.forEach((part, index) => {
        const segment = this.segmentAt(part.words[0].start + EPS);
        const lo = segment?.kind === "main" ? segment.m0 : -Infinity;
        const hi = segment?.kind === "main" ? segment.m1 : Infinity;
        const first = part.words[0];
        const last = part.words[part.words.length - 1];
        const start = index === 0 ? Math.max(lo, Math.min(first.start, cue.start + part.offset)) : first.start;
        const end = index === parts.length - 1 ? Math.min(hi, Math.max(last.end, cue.end + part.offset)) : last.end;
        result.push({ ...cue, start, end, words: part.words });
      });
    }
    return result;
  }

  /** Отрезки для сервера: в каком порядке склеить исходник и вставки. */
  exportSegments(uploadFor) {
    return this.segments.filter((segment) => segment.m1 - segment.m0 > 0.001).map((segment, index, list) => {
      if (segment.kind === "main") {
        const last = index === list.length - 1 || !list.slice(index + 1).some((item) => item.kind === "main");
        return { kind: "main", start: round(segment.s0), end: last && segment.s1 >= this.duration - 0.001 ? null : round(segment.s1) };
      }
      const item = segment.item;
      const entry = { kind: "insert", in: round(item.in), out: round(item.out), volume: round(finite(item.volume, 1), 3), fit: item.fit === "blur" ? "blur" : "cover" };
      if (Math.abs(item.speed - 1) > 1e-3) entry.speed = round(item.speed);
      // Кусок самого исходника: сервер берёт его из главного видео.
      if (item.mediaKey === SELF_MEDIA) entry.main = true;
      else entry.upload_id = uploadFor(item);
      return entry;
    });
  }

  exportOverlays(uploadFor) {
    return this.overlays.filter((place) => place.visible).map((place) => {
      const entry = {
        upload_id: uploadFor(place.item),
        in: round(place.item.in),
        len: round(place.o1 - place.o0),
        m0: round(place.m0),
        warp: place.warp.map((step) => [round(step.d), round(step.len)]),
        volume: round(finite(place.item.volume, 0), 3),
        fit: place.item.fit === "blur" ? "blur" : "cover",
      };
      if (Math.abs(place.item.speed - 1) > 1e-3) entry.speed = round(place.item.speed);
      return entry;
    });
  }

  /** Отрезки ролика (O), где звучит не голос: под ними музыка тоже приглушается. */
  duckRanges() {
    const ranges = [];
    for (const item of this.inserts) if (finite(item.volume, 1) > 0.05) ranges.push([this.toO(item.m0), this.toO(item.m0) + item.len]);
    for (const place of this.overlays) if (place.visible && finite(place.item.volume, 0) > 0.05) ranges.push([place.o0, place.o1]);
    return ranges;
  }

  /** Отрезки сборки (M), где камера стоит: вставки и видео поверх без зума и тряски. */
  stillRanges() {
    const ranges = this.inserts.map((item) => [item.m0, item.m1]);
    for (const place of this.overlays) if (place.visible) ranges.push([place.m0, place.m1]);
    return ranges.sort((a, b) => a[0] - b[0]);
  }
}

function round(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// Правка вырезанного: что показать снова и что вырезать (время S).

function subtract(range, cut) {
  const parts = [];
  if (cut.start > range.start + EPS) parts.push({ start: range.start, end: Math.min(range.end, cut.start) });
  if (cut.end < range.end - EPS) parts.push({ start: Math.max(range.start, cut.end), end: range.end });
  return parts.filter((part) => part.end - part.start > 0.02);
}

/**
 * Вернуть в ролик кусок [a, b) исходника.
 * edit: { trimStart, trimEnd, cuts: [{start, end, kind, enabled, ...}], manual: [{start, end}] }.
 * Склейки ИИ выключаются (их видно в списке), остаток вне [a, b) становится ручным.
 */
export function revealRange(edit, a, b, duration) {
  const next = {
    trimStart: finite(edit.trimStart, 0),
    trimEnd: edit.trimEnd == null ? null : finite(edit.trimEnd, duration),
    cuts: (edit.cuts || []).map((cut) => ({ ...cut })),
    manual: (edit.manual || []).map((cut) => ({ ...cut })),
  };
  const range = { start: Math.max(0, a), end: Math.min(duration, b) };
  if (range.end - range.start <= EPS) return next;
  if (next.trimStart > range.start + EPS) {
    if (range.end < next.trimStart - 0.02) next.manual.push({ start: range.end, end: next.trimStart });
    next.trimStart = range.start;
  }
  const trimEnd = next.trimEnd ?? duration;
  if (trimEnd < range.end - EPS) {
    if (range.start > trimEnd + 0.02) next.manual.push({ start: trimEnd, end: range.start });
    next.trimEnd = range.end >= duration - 0.02 ? null : range.end;
  }
  next.manual = next.manual.flatMap((cut) => (cut.end > range.start && cut.start < range.end ? subtract(cut, range) : [cut]));
  for (const cut of next.cuts) {
    if (cut.kind === "manual" || cut.enabled === false) continue;
    if (cut.end <= range.start + EPS || cut.start >= range.end - EPS) continue;
    cut.enabled = false;
    next.manual.push(...subtract(cut, range));
  }
  next.manual = normaliseRanges(next.manual);
  return next;
}

/** Вырезать кусок [a, b) исходника (ручная склейка). */
export function coverRange(edit, a, b, duration) {
  const manual = normaliseRanges([...(edit.manual || []), { start: Math.max(0, a), end: Math.min(duration, b) }]);
  return { trimStart: finite(edit.trimStart, 0), trimEnd: edit.trimEnd ?? null, cuts: (edit.cuts || []).map((cut) => ({ ...cut })), manual };
}

/**
 * Куда поставить вставку рядом с точкой s исходника: не посреди слова.
 * words — [{start, end}] по порядку; edges — склейки и разрезы (S), к ним тянет сильнее.
 */
export function snapInsertPoint(s, words, edges = [], tolerance = 0.25) {
  let best = s;
  let bestDistance = Infinity;
  for (const edge of edges) {
    const distance = Math.abs(edge - s);
    if (distance < bestDistance && distance <= tolerance) {
      best = edge;
      bestDistance = distance;
    }
  }
  if (bestDistance <= tolerance) return best;
  for (const word of words || []) {
    if (word.end < s - 2) continue;
    if (word.start > s + 2) break;
    if (s > word.start && s < word.end) {
      // Посреди слова: к ближайшему краю.
      return s - word.start < word.end - s ? word.start : word.end;
    }
  }
  return s;
}
