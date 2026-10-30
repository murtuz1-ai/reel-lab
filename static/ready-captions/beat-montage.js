// «Собери под музыку»: где резать (по долям трека) и какой кусок какого видео ставить.
// Модуль без DOM — проверяется в Node. Студия превращает план в вставки на ленте.

export const RHYTHMS = [
  { id: "auto", label: "Авто", hint: "Тихо — склейки реже, громко — чаще" },
  { id: "calm", label: "Спокойно", hint: "Склейка раз в такт (4 доли)" },
  { id: "beat", label: "В ритм", hint: "Склейка каждые 2 доли" },
  { id: "fast", label: "Быстро", hint: "Склейка на каждую долю" },
];
const STEPS = { calm: 4, beat: 2, fast: 1 };
export const MIN_SHOT = 0.42;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round3 = (value) => Math.round(value * 1000) / 1000;

/** Сколько долей в кадре при такой громкости музыки (для «Авто»). */
export function stepForEnergy(energy) {
  if (!(energy >= 0)) return 2;
  if (energy < 0.33) return 4;
  if (energy < 0.72) return 2;
  return 1;
}

/**
 * Длина ролика: ближе к желаемой (target), на сильной доле, не длиннее музыки и видео.
 * beats — [{ o, strong }] по ролику; available — сколько секунд всего есть.
 */
export function pickLength(beats, target, available) {
  const limit = Math.max(1, Math.min(available, target || available));
  if (!beats?.length) return round3(limit);
  const strong = beats.filter((beat) => beat.strong && beat.o <= limit + 0.01 && beat.o > 2);
  const pool = strong.length ? strong : beats.filter((beat) => beat.o <= limit + 0.01 && beat.o > 2);
  if (!pool.length) return round3(limit);
  // Последняя сильная доля, не позже предела: ролик кончается на «раз».
  return round3(pool[pool.length - 1].o);
}

/**
 * Точки склеек [0, c1, …, length] по долям.
 * rhythm — "auto" | "calm" | "beat" | "fast"; energyAt(o) — громкость 0…1 (для «Авто»).
 * Без долей — равные куски по 1.6 с.
 */
export function cutPoints({ beats = [], length, rhythm = "auto", energyAt = () => 0.5, minShot = MIN_SHOT }) {
  const cuts = [0];
  const usable = (beats || []).filter((beat) => beat.o > minShot && beat.o < length - minShot);
  if (usable.length < 2) {
    const step = rhythm === "fast" ? 0.8 : rhythm === "calm" ? 2.6 : 1.6;
    for (let o = step; o < length - minShot; o += step) cuts.push(round3(o));
    cuts.push(round3(length));
    return cuts;
  }
  // Первая склейка — на первой сильной доле (если она близко), иначе на первой доле.
  let index = usable.findIndex((beat) => beat.strong);
  if (index < 0 || usable[index].o > 3.2) index = 0;
  cuts.push(usable[index].o);
  while (index < usable.length) {
    const here = usable[index];
    const step = rhythm === "auto" ? stepForEnergy(energyAt(here.o)) : STEPS[rhythm] || 2;
    let next = index + step;
    // Длинный шаг лучше закончить на сильной доле (если она рядом).
    if (step >= 2) {
      for (let k = next - 1; k <= next + 1; k += 1) {
        if (usable[k]?.strong && Math.abs(k - next) <= 1 && k > index) {
          next = k;
          break;
        }
      }
    }
    while (next < usable.length && usable[next].o - here.o < minShot) next += 1;
    if (next >= usable.length) break;
    cuts.push(usable[next].o);
    index = next;
  }
  if (length - cuts[cuts.length - 1] < minShot && cuts.length > 1) cuts.pop();
  cuts.push(round3(length));
  return cuts.map(round3);
}

/**
 * Какой кусок какого видео в каждый кадр.
 * clips — [{ key, duration }] по порядку (по кругу); cuts — из cutPoints().
 * Каждый раз из видео берётся новый кусок (дальше по видео); короткое видео
 * замедляется до 0.5×, чтобы заполнить кадр; совсем короткое — пропускается.
 * Возвращает [{ key, in, out, speed, o0, o1, index }].
 */
export function planShots({ cuts, clips, minSpeed = 0.5, gap = 0.35 }) {
  const usable = (clips || []).filter((clip) => clip.duration > 0.3);
  if (!usable.length || !cuts || cuts.length < 2) return [];
  const cursors = new Map(usable.map((clip) => [clip.key, Math.min(0.25, clip.duration * 0.05)]));
  const shots = [];
  let turn = 0;
  for (let i = 0; i + 1 < cuts.length; i += 1) {
    const o0 = cuts[i];
    const o1 = cuts[i + 1];
    const length = o1 - o0;
    let placed = null;
    for (let attempt = 0; attempt < usable.length && !placed; attempt += 1) {
      const clip = usable[(turn + attempt) % usable.length];
      const need = length;
      let start = cursors.get(clip.key);
      if (start + need > clip.duration - 0.05) start = Math.min(0.25, clip.duration * 0.05); // по кругу — с начала
      const room = clip.duration - start - 0.05;
      if (room >= need) {
        placed = { clip, start, speed: 1, take: need };
      } else if (room >= need * minSpeed) {
        // Видео короче кадра — чуть замедлить, чтобы заполнить его целиком.
        placed = { clip, start, speed: clamp(room / need, minSpeed, 1), take: room };
      }
      if (placed) turn = (turn + attempt + 1) % usable.length;
    }
    if (!placed) {
      // Ни одно видео не тянет такой длинный кадр: самое длинное — медленно.
      const clip = usable.reduce((a, b) => (b.duration > a.duration ? b : a));
      const start = Math.min(0.25, clip.duration * 0.05);
      const take = Math.max(0.2, clip.duration - start - 0.05);
      placed = { clip, start, speed: clamp(take / length, 0.25, 1), take };
    }
    const { clip, start, speed } = placed;
    const take = length * speed;
    shots.push({ key: clip.key, in: round3(start), out: round3(start + take), speed: round3(speed), o0: round3(o0), o1: round3(o1), index: i });
    cursors.set(clip.key, start + take + gap);
  }
  return shots;
}

/** Громкость музыки в момент o ролика: energy — { step, values } по времени трека. */
export function energyAtFactory(analysis, place) {
  const values = analysis?.energy?.values;
  const step = analysis?.energy?.step || 0.5;
  const length = analysis?.duration || 0;
  if (!values?.length) return () => 0.5;
  return (o) => {
    let t = (Number(place.trackStart) || 0) + (o - (Number(place.start) || 0));
    if (place.loop && length > 1) t %= length;
    // Среднее за секунду вокруг: склейки не дёргаются от одного удара.
    const from = Math.max(0, Math.floor((t - 0.5) / step));
    const to = Math.min(values.length - 1, Math.floor((t + 0.5) / step));
    let sum = 0;
    let count = 0;
    for (let i = from; i <= to; i += 1) {
      sum += values[i];
      count += 1;
    }
    return count ? sum / count : 0.5;
  };
}
