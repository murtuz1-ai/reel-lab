// Свой текст (стихи нашида, цитаты): строки → фразы субтитров по времени готового ролика.
// Время задаётся двумя способами: ровно по длине строк или нажатиями под музыку.
// Модуль без DOM: его можно проверять в Node.

const GAP = 0.08;          // пауза между фразами, с
const MIN_LINE = 0.6;      // фраза не короче, с

/** Строки текста: пустые выбрасываются, лишние пробелы убираются. */
export function lyricLines(text) {
  return String(text || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 400);
}

/** Слова строки со временем: длинное слово звучит дольше короткого. */
export function timedWords(line, start, end) {
  const parts = line.split(" ").filter(Boolean);
  const weights = parts.map((word) => Math.max(1, [...word].length) + 1.5);
  const total = weights.reduce((sum, value) => sum + value, 0) || 1;
  const span = Math.max(0.05, end - start);
  let cursor = start;
  return parts.map((text, index) => {
    const length = (span * weights[index]) / total;
    const word = { text, start: cursor, end: Math.min(end, cursor + length) };
    cursor += length;
    return word;
  });
}

function cue(line, start, end) {
  const s = Math.max(0, start);
  const e = Math.max(s + 0.2, end);
  return { start: s, end: e, words: timedWords(line, s, e), estimated: true };
}

/** Ровно по ролику: каждой строке — время по её длине, между строками короткая пауза. */
export function spreadLyrics(lines, start, end) {
  if (!lines.length) return [];
  const span = Math.max(lines.length * MIN_LINE, end - start);
  const weights = lines.map((line) => Math.max(6, [...line].length));
  const total = weights.reduce((sum, value) => sum + value, 0);
  const free = Math.max(0, span - GAP * (lines.length - 1));
  let cursor = start;
  return lines.map((line, index) => {
    const length = Math.max(MIN_LINE, (free * weights[index]) / total);
    const item = cue(line, cursor, cursor + length);
    cursor += length + GAP;
    return item;
  });
}

/**
 * По нажатиям: starts[i] — когда началась строка i, finish — конец последней.
 * Строки без нажатия (человек нажал «Готово» раньше) ровно делят остаток до конца.
 */
export function lyricsFromTaps(lines, starts, finish) {
  const marks = starts.filter(Number.isFinite).slice(0, lines.length);
  if (!marks.length) return spreadLyrics(lines, 0, finish);
  const result = [];
  for (let i = 0; i < marks.length; i += 1) {
    const next = i + 1 < marks.length ? marks[i + 1] : null;
    let end;
    if (next != null) end = next - GAP;
    else if (marks.length === lines.length) end = finish;
    else end = marks[i] + Math.max(MIN_LINE, (finish - marks[i]) / (lines.length - i));
    result.push(cue(lines[i], marks[i], Math.max(marks[i] + MIN_LINE * 0.5, end)));
  }
  if (marks.length < lines.length) {
    const from = result[result.length - 1].end + GAP;
    result.push(...spreadLyrics(lines.slice(marks.length), from, Math.max(from + MIN_LINE, finish)));
  }
  return result;
}

/** Текст фраз обратно в строки — чтобы поправить уже расставленный текст. */
export function cuesToLyrics(cues) {
  return (cues || []).map((item) => (item.words || []).map((word) => word.text).join(" ")).filter(Boolean).join("\n");
}

/**
 * Слова строки — по голосу: начало каждого слова тянется к ближайшей «вспышке»
 * в полосе голоса (согласная, новый слог), но не уходит далеко от ровной расстановки.
 * cue — фраза со словами (время ролика); vocal — { rate, offset, values } из beats.js;
 * toAudio(o) — секунда звука в момент o ролика. Возвращает новую фразу (или ту же, если звука нет).
 */
export function alignWordsToVocal(cue, vocal, toAudio) {
  const words = cue?.words || [];
  if (words.length < 2 || !vocal?.values?.length) return cue;
  const n = words.length;
  const start = cue.start;
  const end = cue.end;
  const span = end - start;
  if (span < 0.4) return cue;
  const rate = vocal.rate;
  const frameOf = (o) => Math.round((toAudio(o) - (vocal.offset || 0)) * rate);
  const valueAt = (o) => {
    const f = frameOf(o);
    let peak = 0;
    for (let k = f - 1; k <= f + 1; k += 1) if (k >= 0 && k < vocal.values.length) peak = Math.max(peak, vocal.values[k]);
    return peak;
  };
  // Шкала строки шагом 10 мс.
  const step = 0.01;
  const cells = Math.max(2, Math.round(span / step));
  const prior = words.map((word) => (word.start - start) / span);
  const minGap = Math.min(0.12, span / n / 2);
  const minCells = Math.max(1, Math.round(minGap / step));
  const reach = Math.max(4, Math.round((span / n) * 1.4 / step));
  // Насколько строка вообще «слышна» в голосе: тихая — оставляем как было.
  let level = 0;
  const strength = new Float32Array(cells + 1);
  for (let c = 0; c <= cells; c += 1) {
    strength[c] = valueAt(start + c * step);
    level = Math.max(level, strength[c]);
  }
  if (level < 1) return cue;
  // Только пики (начала слогов): середина тянущейся гласной не притягивает слово.
  const peak = new Float32Array(cells + 1);
  for (let c = 0; c <= cells; c += 1) {
    let isPeak = true;
    for (let k = Math.max(0, c - 4); k <= Math.min(cells, c + 4); k += 1) if (strength[k] > strength[c]) { isPeak = false; break; }
    peak[c] = isPeak ? Math.min(1, strength[c] / (0.5 * level)) * 3 : 0;
  }
  const score = (i, c) => {
    const delta = (c / cells - prior[i]) * n;  // отклонение в «словах»
    return peak[c] - 1.1 * delta * delta;
  };
  // Динамика: начало слова i — в ячейке c; слова по порядку, промежуток не меньше minCells.
  // layers[i] = { cells: [...], values: [...], back: [индекс в слое i-1] }.
  const layers = [{ cells: [0], values: [0], back: [-1] }];
  for (let i = 1; i < n; i += 1) {
    const prev = layers[i - 1];
    const center = Math.round(prior[i] * cells);
    const layer = { cells: [], values: [], back: [] };
    const from = Math.max(1, center - reach);
    const to = Math.min(cells - minCells * (n - i), center + reach);
    for (let c = from; c <= to; c += 1) {
      let bestValue = -Infinity;
      let bestIndex = -1;
      for (let k = 0; k < prev.cells.length; k += 1) {
        if (c - prev.cells[k] < minCells) continue;
        if (prev.values[k] > bestValue) {
          bestValue = prev.values[k];
          bestIndex = k;
        }
      }
      if (bestIndex < 0) continue;
      layer.cells.push(c);
      layer.values.push(bestValue + score(i, c));
      layer.back.push(bestIndex);
    }
    if (!layer.cells.length) return cue;
    layers.push(layer);
  }
  // Лучшее начало последнего слова (ему тоже нужно время до конца строки).
  const last = layers[n - 1];
  let index = -1;
  let top = -Infinity;
  for (let k = 0; k < last.cells.length; k += 1) {
    if (end - (start + last.cells[k] * step) < minGap) continue;
    if (last.values[k] > top) {
      top = last.values[k];
      index = k;
    }
  }
  if (index < 0) return cue;
  const starts = new Array(n).fill(0);
  for (let i = n - 1; i >= 1; i -= 1) {
    starts[i] = layers[i].cells[index];
    index = layers[i].back[index];
  }
  const timed = words.map((word, i) => {
    const s = start + starts[i] * step;
    const e = i + 1 < n ? start + starts[i + 1] * step : end;
    return { ...word, start: Math.round(s * 1000) / 1000, end: Math.round(Math.max(s + 0.05, e) * 1000) / 1000 };
  });
  return { ...cue, words: timed, aligned: true };
}
