// Редактор текста субтитров перед экспортом.
//
// Источник правды — список фраз со временем каждого слова (из распознавания
// или из файла). Человек правит текст фразы как обычную строку; слова,
// которые остались на месте, сохраняют своё точное время, новые слова
// получают время из промежутка между соседями (или из времени слов, которые
// они заменили). После правки всё снова сохраняется как WebVTT с меткой
// перед и после каждого слова — его одинаково читают и готовые стили
// TSCaps, и печатная машинка.

function normalise(token) {
  return token.toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}]+/gu, "");
}

function tokens(text) {
  return String(text || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
}

function vttTime(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
}

export function formatShortTime(seconds) {
  const value = Math.max(0, seconds);
  const m = Math.floor(value / 60);
  const s = value - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

function cleanWord(text) {
  return String(text).replace(/[<>]/g, "");
}

const RTL_LETTERS = /[֐-ࣿיִ-﷿ﹰ-﻿]/g;

/** Текст написан справа налево (арабский), если таких букв больше половины. */
function isRtl(text) {
  const rtl = (String(text).match(RTL_LETTERS) || []).length;
  const letters = (String(text).match(/\p{L}/gu) || []).length;
  return rtl > 0 && rtl * 2 >= letters;
}

const SENTENCE_END = /[.!?…؟۔]["»)]*$/;
const CLAUSE_END = /[,;:—–-]["»)]*$/;

function phraseLength(words) {
  return words.reduce((sum, word) => sum + Array.from(word.text).length, 0) + Math.max(0, words.length - 1);
}

function splitLong(words, maxChars) {
  if (words.length < 2 || phraseLength(words) <= maxChars) return [words];
  // Лучшее место разреза: после запятой ближе к середине, иначе — самая
  // длинная пауза между словами.
  let best = 1;
  let bestScore = -Infinity;
  const middle = phraseLength(words) / 2;
  let position = 0;
  for (let index = 1; index < words.length; index += 1) {
    position += Array.from(words[index - 1].text).length + 1;
    const pause = words[index].start - words[index - 1].end;
    const clause = CLAUSE_END.test(words[index - 1].text) ? 0.6 : 0;
    const centre = 1 - Math.abs(position - middle) / middle;
    const score = clause + Math.min(1, Math.max(0, pause)) + centre * 0.5;
    if (score > bestScore) {
      bestScore = score;
      best = index;
    }
  }
  return [...splitLong(words.slice(0, best), maxChars), ...splitLong(words.slice(best), maxChars)];
}

/**
 * Делит длинные фразы на короткие, удобные для чтения: по концу предложения,
 * затем по запятой или паузе, чтобы фраза была не длиннее maxChars знаков.
 * Время каждого слова не меняется.
 */
export function resegmentCues(cues, maxChars = 42) {
  const pieces = [];
  for (const cue of cues) {
    let current = [];
    cue.words.forEach((word, index) => {
      current.push(word);
      const next = cue.words[index + 1];
      const longPause = next && next.start - word.end > 0.9;
      if (SENTENCE_END.test(word.text) || longPause || !next) {
        for (const part of splitLong(current, maxChars)) pieces.push({ words: part, estimated: cue.estimated, cueEnd: cue.end });
        current = [];
      }
    });
  }
  return pieces.map((piece, index) => {
    const first = piece.words[0];
    const last = piece.words[piece.words.length - 1];
    const next = pieces[index + 1];
    let end = Math.max(last.end, Math.min(piece.cueEnd, last.end + 0.6));
    if (next) end = Math.min(end, Math.max(last.end, next.words[0].start - 0.04));
    return { start: first.start, end, words: piece.words, estimated: piece.estimated };
  });
}

/** Список фраз → WebVTT с меткой до и после каждого слова. */
/**
 * Субтитры без вырезанных слов (hidden: true). Слова, попавшие в вырезанный
 * кусок, не показываются и после склейки; время фразы сжимается до
 * оставшихся слов.
 */
export function visibleCues(cues) {
  const result = [];
  for (const cue of cues || []) {
    const words = (cue.words || []).filter((word) => !word.hidden);
    if (!words.length) continue;
    if (words.length === cue.words.length) {
      result.push(cue);
      continue;
    }
    const lastHidden = cue.words[cue.words.length - 1].hidden;
    result.push({
      ...cue,
      words,
      start: Math.max(cue.start, words[0].start - 0.05),
      end: lastHidden ? Math.min(cue.end, words[words.length - 1].end + 0.3) : cue.end,
    });
  }
  return result;
}

export function serializeCues(cues) {
  const lines = ["WEBVTT", ""];
  visibleCues(cues).forEach((cue, index) => {
    if (!cue.words.length) return;
    const parts = cue.words.map((word, number) => `${number ? " " : ""}<${vttTime(word.start)}>${cleanWord(word.text)}<${vttTime(word.end)}>`);
    lines.push(String(index + 1), `${vttTime(cue.start)} --> ${vttTime(cue.end)}`, parts.join(""), "");
  });
  return lines.join("\n");
}

// Наибольшая общая подпоследовательность слов: какие старые слова остались.
function matchWords(oldWords, newTokens) {
  const a = oldWords.map((word) => normalise(word.text));
  const b = newTokens.map(normalise);
  const table = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] && a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] && a[i] === b[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}

function spread(texts, start, end, estimated) {
  const weights = texts.map((text) => Array.from(text).length + 1);
  const total = weights.reduce((sum, value) => sum + value, 0) || 1;
  const span = Math.max(0.06 * texts.length, end - start);
  let cursor = start;
  return texts.map((text, index) => {
    const duration = span * (weights[index] / total);
    const word = { text, start: cursor, end: cursor + duration * 0.9, estimated };
    cursor += duration;
    return word;
  });
}

/**
 * Новое время слов после правки текста фразы. Если число слов не изменилось,
 * каждое слово просто получает новый текст и сохраняет своё время.
 */
export function realignWords(cue, newText) {
  const newTokens = tokens(newText);
  const old = cue.words;
  if (!newTokens.length) return [];
  if (newTokens.length === old.length) {
    return old.map((word, index) => ({ ...word, text: newTokens[index] }));
  }
  const pairs = matchWords(old, newTokens);
  const result = new Array(newTokens.length);
  for (const [i, j] of pairs) result[j] = { ...old[i], text: newTokens[j] };
  // Заполняем промежутки между сохранившимися словами.
  const anchors = [[-1, -1], ...pairs, [old.length, newTokens.length]];
  for (let k = 0; k < anchors.length - 1; k += 1) {
    const [oi, nj] = anchors[k];
    const [oi2, nj2] = anchors[k + 1];
    const gapTokens = newTokens.slice(nj + 1, nj2);
    if (!gapTokens.length) continue;
    const replaced = old.slice(oi + 1, oi2);
    let start;
    let end;
    if (replaced.length) {
      start = replaced[0].start;
      end = replaced[replaced.length - 1].end;
    } else {
      start = oi >= 0 ? old[oi].end : cue.start;
      end = oi2 < old.length ? old[oi2].start : Math.max(cue.end - 0.1, start + 0.2);
    }
    const filled = spread(gapTokens, start, Math.max(end, start + 0.12 * gapTokens.length), true);
    filled.forEach((word, offset) => { result[nj + 1 + offset] = word; });
  }
  // Время должно идти строго вперёд.
  let previous = cue.start;
  return result.map((word) => {
    const start = Math.max(word.start, previous);
    const end = Math.max(word.end, start + 0.06);
    previous = end;
    return { ...word, start, end };
  });
}

/**
 * Рисует список фраз. `onChange(cues)` вызывается после каждой правки.
 * `isKeyword(word)` и `onToggleKeyword(word)` — выделение слов цветом.
 */
export function renderEditor(container, cues, { onChange, isKeyword, onToggleKeyword, onSeek }) {
  container.innerHTML = "";
  cues.forEach((cue, index) => {
    const row = document.createElement("div");
    row.className = "cue-row";

    const time = document.createElement("button");
    time.type = "button";
    time.className = "cue-time";
    time.textContent = formatShortTime(cue.start);
    time.title = "Показать этот момент в предпросмотре";
    time.addEventListener("click", () => onSeek?.(cue.start + 0.01));

    const body = document.createElement("div");
    body.className = "cue-body";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "cue-text";
    input.dir = "auto";
    input.value = cue.words.map((word) => word.text).join(" ");
    input.setAttribute("aria-label", `Фраза ${index + 1}`);
    input.spellcheck = true;
    input.lang = isRtl(input.value) ? "ar" : "ru";

    const chips = document.createElement("div");
    chips.className = "cue-words";
    const drawChips = () => {
      chips.innerHTML = "";
      // Арабская фраза: слова под строкой идут справа налево, как в тексте.
      chips.dir = isRtl(cue.words.map((word) => word.text).join(" ")) ? "rtl" : "ltr";
      cue.words.forEach((word) => {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = `cue-word${isKeyword(word.text) ? " is-key" : ""}${word.estimated ? " is-estimated" : ""}`;
        chip.dir = "auto";
        chip.textContent = word.text;
        chip.title = `${formatShortTime(word.start)}–${formatShortTime(word.end)} · нажми, чтобы выделить цветом`;
        chip.addEventListener("click", () => {
          onToggleKeyword(word.text);
        });
        chips.append(chip);
      });
    };
    drawChips();

    const commit = () => {
      const words = realignWords(cue, input.value);
      if (!words.length) {
        input.value = cue.words.map((word) => word.text).join(" ");
        return;
      }
      const changed = words.map((w) => w.text).join(" ") !== cue.words.map((w) => w.text).join(" ");
      if (!changed) return;
      cue.words = words;
      cue.start = Math.min(cue.start, words[0].start);
      cue.end = Math.max(cue.end, words[words.length - 1].end);
      drawChips();
      onChange(cues);
    };
    input.addEventListener("change", commit);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        input.blur();
      }
    });

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "cue-remove";
    remove.textContent = "✕";
    remove.title = "Удалить фразу";
    remove.addEventListener("click", () => {
      cues.splice(index, 1);
      renderEditor(container, cues, { onChange, isKeyword, onToggleKeyword, onSeek });
      onChange(cues);
    });

    body.append(input, chips);
    row.append(time, body, remove);
    container.append(row);
  });
}
