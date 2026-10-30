// Печатная машинка «547».
//
// Повторяет логику шаблона пользователя Mixkit «Quick Type Title»
// (547/Title_01 (typewriter).aep), разобранного по самому файлу:
//   * исходный текст слоя: substr(0, N) + "_"  — курсор является ещё одной
//     буквой, приклеенной к концу набранного текста, поэтому никогда не
//     отрывается от последней буквы;
//   * N (число набранных знаков) растёт линейно слово за словом с короткими
//     остановками между словами;
//   * шрифт Roboto Medium, белый; отдельный аниматор красит часть текста
//     другим цветом (Fill range);
//   * в конце текст уходит волной прозрачности слева направо
//     (Opacity range selector со Smoothness 100 → 0).
//
// Отличие от шаблона: скорость печати берётся не из ключевых кадров, а из
// времени каждого произнесённого слова. Слово печатается, пока оно звучит.

import { gluedToPrevious, rtlPositions } from "./bidi.js";

// Знак препинания в конце слова, в том числе арабские (، ؛ ؟).
const PUNCTUATION_END = /[,.!?…:;،؛؟۔]$/;

export const TYPEWRITER_DEFAULTS = Object.freeze({
  // В шаблоне Roboto Medium. Roboto нет в комплекте страницы, поэтому до его
  // установки используется Inter 500 — близкий нейтральный гротеск с кириллицей.
  fontFamily: '"Roboto", "Reel Typewriter", "Segoe UI", sans-serif',
  fontWeight: 500,
  fontSize: 4.6,            // % высоты кадра
  lineHeight: 1.2,
  align: "center",          // "center" | "left" (в шаблоне текст выровнен влево)
  verticalAlign: "bottom",  // "top" | "center" | "bottom"
  verticalOffset: 0.8,      // доля высоты кадра
  horizontalOffset: 0.5,    // центр блока по горизонтали, доля ширины кадра (перетаскивание)
  maxWidthRatio: 0.84,
  maxLines: 2,
  textColor: "#ffffff",
  highlightColor: "#f5c982",
  keywords: [],
  cursor: "_",              // "_" как в шаблоне или "|"
  cursorBlink: true,
  maxCharsPerSecond: 18,    // мягкий предел скорости
  minCharsPerSecond: 11,    // медленнее этого слово не печатается (конец слова у распознавания бывает растянут паузой)
  hardMaxCharsPerSecond: 40,
  softness: 0.55,           // 0 — жёсткое появление, 1 — мягкое проявление буквы
  leadSeconds: 0.03,        // буква появляется чуть раньше звука слова
  preRollSeconds: 0.22,     // курсор появляется перед первой буквой фразы
  holdSeconds: 0.7,         // сколько фраза стоит после последнего слова
  outro: "wave",            // "wave" — как в шаблоне, "fade" — общее растворение
  outroSeconds: 0.38,
  shadow: 0.55,
  // "rtl" — арабский: строки справа налево. Слово печатается по буквам, как
  // на арабской клавиатуре: набранная часть слова каждый раз рисуется
  // целиком, поэтому буквы остаются соединёнными, а последняя набранная
  // буква стоит в конечной форме.
  direction: "ltr",
});

const SPACE = " ";
const RTL_LETTER = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
const GRAPHEMES = typeof Intl !== "undefined" && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

/** Буквы слова вместе с огласовками (харакаты не отрываются от своей буквы). */
function graphemes(text) {
  if (GRAPHEMES) return Array.from(GRAPHEMES.segment(text), (part) => part.segment);
  return text.match(/\P{M}\p{M}*/gu) || [];
}

/** Сколько букв слова справа налево уже набрано к моменту time. */
function shownUnits(char, time) {
  let count = 0;
  while (count < char.times.length && char.times[count] <= time) count += 1;
  return count;
}

/** Время последней набранной буквы (для слова — последней буквы слова). */
function charEnd(char) {
  return char.whole ? char.times[char.times.length - 1] : char.time;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function easeOutCubic(x) {
  const t = clamp(x, 0, 1);
  return 1 - (1 - t) ** 3;
}

function normaliseWord(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function keywordKey(text) {
  return normaliseWord(text).toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}-]+/gu, "");
}

export function fontString(options, px) {
  return `${options.fontWeight} ${px}px ${options.fontFamily}`;
}

// ---------------------------------------------------------------------------
// Разбор субтитров

const TIMECODE = /(?:(\d{1,3}):)?(\d{2}):(\d{2})[.,](\d{1,3})/;
const INLINE_MARK = /<((?:\d{1,3}:)?\d{2}:\d{2}[.,]\d{1,3})>/g;

function seconds(code) {
  const match = TIMECODE.exec(code);
  if (!match) return NaN;
  const [, h = "0", m, s, ms] = match;
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms.padEnd(3, "0")) / 1000;
}

function stripTags(text) {
  return text.replace(/<[^>]*>/g, "");
}

// Время слов, которого нет в файле (обычный SRT), распределяется по длине
// слов — так же, как это делает движок TSCaps. Такие слова помечаются, чтобы
// интерфейс честно показывал, что тайминг примерный.
function estimateWords(text, start, end) {
  const words = normaliseWord(stripTags(text)).split(SPACE).filter(Boolean);
  const weights = words.map((word) => Math.max(1, Array.from(word).length) + 1);
  const total = weights.reduce((sum, value) => sum + value, 0) || 1;
  let cursor = start;
  return words.map((word, index) => {
    const duration = (end - start) * (weights[index] / total);
    const item = { text: word, start: cursor, end: cursor + duration * 0.86, estimated: true };
    cursor += duration;
    return item;
  });
}

// Метки <00:00:01.230> перед и после каждого слова (так их пишет Reel Lab
// из ответа GigaAM). Текст между меткой конца слова и меткой начала
// следующего — только пробел, поэтому пауза остаётся паузой.
function markedWords(text, start, end) {
  const pieces = [];
  let from = 0;
  let stretchStart = start;
  for (const match of text.matchAll(INLINE_MARK)) {
    pieces.push({ text: text.slice(from, match.index), start: stretchStart, end: seconds(match[1]) });
    from = match.index + match[0].length;
    stretchStart = seconds(match[1]);
  }
  pieces.push({ text: text.slice(from), start: stretchStart, end });
  const words = [];
  for (const piece of pieces) {
    const clean = normaliseWord(stripTags(piece.text));
    if (!clean) continue;
    if (clean.includes(SPACE)) {
      // Метка стоит раз в несколько слов: внутри отрезка время распределяется.
      words.push(...estimateWords(clean, piece.start, piece.end));
    } else {
      words.push({ text: clean, start: piece.start, end: Math.max(piece.start + 0.02, piece.end), estimated: false });
    }
  }
  return words;
}

export function parseCues(source) {
  const text = String(source || "").replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const blocks = text.split(/\n{2,}/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split("\n").filter((line) => line.trim() !== "");
    const timeIndex = lines.findIndex((line) => line.includes("-->"));
    if (timeIndex < 0) continue;
    const [left, right] = lines[timeIndex].split("-->");
    const start = seconds(left);
    const end = seconds(right);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const body = lines.slice(timeIndex + 1).join(" ");
    const hasMarks = INLINE_MARK.test(body);
    INLINE_MARK.lastIndex = 0;
    const words = hasMarks ? markedWords(body, start, end) : estimateWords(body, start, end);
    if (words.length) cues.push({ start, end, words, estimated: !hasMarks });
  }
  cues.sort((a, b) => a.start - b.start);
  return cues;
}

// ---------------------------------------------------------------------------
// Раскладка по строкам и расписание печати

function measureContext() {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(8, 8).getContext("2d");
  return document.createElement("canvas").getContext("2d");
}

function splitIntoLines(words, measure, maxWidth, maxLines) {
  // Возвращает null, если слова не помещаются в maxLines строк.
  const widths = words.map((word) => measure(word.text));
  const space = measure(SPACE);
  const total = widths.reduce((sum, value) => sum + value, 0) + space * Math.max(0, words.length - 1);
  if (total <= maxWidth) return [words.slice()];
  if (maxLines < 2) return null;
  // Две строки: перенос, при котором более длинная строка самая короткая,
  // с лёгким предпочтением переноса после знака препинания.
  let best = null;
  for (let cut = 1; cut < words.length; cut += 1) {
    const first = widths.slice(0, cut).reduce((s, v) => s + v, 0) + space * (cut - 1);
    const second = widths.slice(cut).reduce((s, v) => s + v, 0) + space * (words.length - cut - 1);
    if (first > maxWidth || second > maxWidth) continue;
    const punctuationBonus = PUNCTUATION_END.test(words[cut - 1].text) ? 0.92 : 1;
    // Название латиницей («Reel Lab») и отдельное тире не переносятся по частям.
    const gluePenalty = words[cut].glue ? 4 : 1;
    const score = Math.max(first, second) * punctuationBonus * gluePenalty;
    if (!best || score < best.score) best = { cut, score };
  }
  if (!best) return null;
  return [words.slice(0, best.cut), words.slice(best.cut)];
}

// Фраза, которая не помещается в две строки, делится на несколько фраз по
// словам — там, где длиннее всего пауза в речи.
function splitPhrase(words, measure, maxWidth, maxLines) {
  const lines = splitIntoLines(words, measure, maxWidth, maxLines);
  if (lines || words.length === 1) return [words];
  let cut = 1;
  let bestGap = -Infinity;
  const middle = words.length / 2;
  for (let index = 1; index < words.length; index += 1) {
    const gap = words[index].start - words[index - 1].end;
    const punctuation = PUNCTUATION_END.test(words[index - 1].text) ? 0.25 : 0;
    const centre = -Math.abs(index - middle) / words.length * 0.2;
    const glued = words[index].glue ? -3 : 0;
    const score = gap + punctuation + centre + glued;
    if (score > bestGap) {
      bestGap = score;
      cut = index;
    }
  }
  return [
    ...splitPhrase(words.slice(0, cut), measure, maxWidth, maxLines),
    ...splitPhrase(words.slice(cut), measure, maxWidth, maxLines),
  ];
}

/**
 * Строит полное расписание: какие фразы, в каких строках, когда появляется
 * каждая буква и когда фраза уходит. Одно и то же расписание используется
 * для предпросмотра, для экспорта видео и для звуков клавиш.
 */
export function buildTimeline(allCues, frameWidth, frameHeight, userOptions = {}) {
  const options = { ...TYPEWRITER_DEFAULTS, ...userOptions };
  // Вырезанные при монтаже слова не печатаются. glue — слово нельзя
  // отрывать от предыдущего (латинское название в арабской фразе, тире).
  const cues = (allCues || []).map((cue) => {
    const words = cue.words.filter((word) => !word.hidden).map((word) => ({ ...word }));
    const glue = gluedToPrevious(words.map((word) => word.text));
    words.forEach((word, i) => { word.glue = glue[i]; });
    return { ...cue, words };
  }).filter((cue) => cue.words.length);
  const px = Math.max(8, (options.fontSize / 100) * frameHeight);
  const ctx = measureContext();
  ctx.font = fontString(options, px);
  const measure = (text) => ctx.measureText(text).width;
  const maxWidth = frameWidth * options.maxWidthRatio;
  const keywords = new Set((options.keywords || []).map(keywordKey).filter(Boolean));

  const rtl = options.direction === "rtl";
  const phrases = [];
  for (const cue of cues) {
    for (const words of splitPhrase(cue.words, measure, maxWidth, options.maxLines)) {
      phrases.push({ words, cueEnd: cue.end, estimated: cue.estimated });
    }
  }

  const minCharSeconds = 1 / options.maxCharsPerSecond;
  const maxCharSeconds = 1 / options.minCharsPerSecond;
  const hardCharSeconds = 1 / options.hardMaxCharsPerSecond;
  const fadeSeconds = 0.02 + 0.1 * clamp(options.softness, 0, 1);

  const segments = [];
  let previousTypingEnd = -Infinity;
  phrases.forEach((phrase, phraseIndex) => {
    const lines = splitIntoLines(phrase.words, measure, maxWidth, options.maxLines)
      || phrase.words.map((word) => [word]);
    // Буквы по строкам; пробел между словами одной строки печатается как
    // первая буква следующего слова, на перенос строки пробел не ставится.
    const layoutLines = lines.map((lineWords) => ({ words: lineWords, chars: [] }));
    const ordered = [];
    layoutLines.forEach((line, lineIndex) => {
      line.words.forEach((word, wordIndex) => {
        const emphasis = keywords.has(keywordKey(word.text));
        if (rtl) {
          // Слово — один кусок текста: печатается по буквам, но рисуется
          // целиком (набранная часть), чтобы буквы были соединены.
          const units = graphemes(word.text);
          const typed = wordIndex > 0 ? [SPACE, ...units] : units;
          ordered.push({ word, lineIndex, typed, emphasis, whole: true, units });
          return;
        }
        const glyphs = Array.from(word.text);
        const typed = wordIndex > 0 ? [SPACE, ...glyphs] : glyphs;
        ordered.push({ word, lineIndex, typed, emphasis });
      });
    });

    const nextPhrase = phrases[phraseIndex + 1];
    ordered.forEach((item, index) => {
      const next = ordered[index + 1];
      const count = item.typed.length;
      let start = Math.max(item.word.start - options.leadSeconds, previousTypingEnd);
      const spoken = Math.max(0.001, item.word.end - item.word.start);
      let duration = clamp(spoken, count * minCharSeconds, count * maxCharSeconds);
      const limit = next
        ? next.word.start - options.leadSeconds
        : (nextPhrase ? nextPhrase.words[0].start - options.leadSeconds - options.preRollSeconds : Infinity);
      if (start + duration > limit - 0.02) {
        // Речь быстрее мягкого предела: печатаем быстрее, но не быстрее
        // жёсткого предела, иначе текст превращается в мгновенный вброс.
        duration = Math.max(count * hardCharSeconds, limit - 0.02 - start);
      }
      const line = layoutLines[item.lineIndex];
      if (item.whole) {
        // Время каждой буквы — как у письма слева направо (пробел перед
        // словом тоже занимает свой шаг, но не рисуется).
        const lead = item.typed.length - item.units.length;
        const times = item.units.map((_, k) => start + duration * ((k + lead) / count));
        line.chars.push({
          glyph: item.word.text,
          units: item.units,
          times,
          time: times[0],
          whole: true,
          // Слово без арабских букв (латиница, цифры) внутри арабской строки
          // набирается слева направо.
          ltr: !RTL_LETTER.test(item.word.text) && /[\p{L}\p{N}]/u.test(item.word.text),
          emphasis: item.emphasis,
          isSpace: false,
          wordStart: true,
        });
        previousTypingEnd = start + duration;
        return;
      }
      item.typed.forEach((glyph, k) => {
        line.chars.push({
          glyph,
          time: start + duration * (k / count),
          emphasis: item.emphasis && glyph !== SPACE,
          isSpace: glyph === SPACE,
          wordStart: k === (glyph === SPACE ? 1 : 0) || (k === 0 && glyph !== SPACE),
        });
      });
      previousTypingEnd = start + duration;
    });

    // Позиции букв: ширина строки до буквы включительно учитывает кернинг.
    let blockWidth = 0;
    for (const line of layoutLines) {
      if (rtl) {
        // Справа налево: первое слово — у правого края строки; латиница внутри
        // арабской фразы идёт слева направо, как в обычном тексте.
        const space = measure(SPACE);
        const widths = line.chars.map((char) => measure(char.glyph));
        const { xs, total, directions } = rtlPositions(line.chars.map((char) => char.glyph), widths, space);
        line.chars.forEach((char, index) => {
          char.x = xs[index];
          char.right = xs[index] + widths[index];
          // Ширина набранной части слова — для курсора.
          char.prefix = char.units.map((_, k) => measure(char.units.slice(0, k + 1).join("")));
          if (directions[index] === "L") {
            // Кусок латиницы («Reel Lab»): где он начинается слева и
            // последнее ли это его слово — туда встаёт курсор после набора.
            let first = index;
            while (first > 0 && directions[first - 1] === "L") first -= 1;
            char.latinRun = true;
            char.runLeft = xs[first];
            char.runEnd = index === line.chars.length - 1 || directions[index + 1] !== "L";
          }
        });
        line.text = line.chars.map((char) => char.glyph).join(SPACE);
        line.width = total;
        blockWidth = Math.max(blockWidth, total);
        continue;
      }
      let text = "";
      line.chars.forEach((char) => {
        char.x = measure(text);
        text += char.glyph;
        char.right = measure(text);
      });
      line.text = text;
      line.width = measure(text);
      blockWidth = Math.max(blockWidth, line.width);
    }

    const allChars = layoutLines.flatMap((line) => line.chars);
    const firstTime = allChars[0].time;
    const lastTime = charEnd(allChars[allChars.length - 1]);
    const lastWord = phrase.words[phrase.words.length - 1];
    let visibleEnd = Math.max(lastWord.end + options.holdSeconds, lastTime + 0.35);
    if (nextPhrase) {
      const nextVisibleStart = nextPhrase.words[0].start - options.leadSeconds - options.preRollSeconds;
      visibleEnd = Math.min(visibleEnd, Math.max(lastTime + 0.12, nextVisibleStart - 0.02));
    }
    const outroSeconds = Math.min(options.outroSeconds, Math.max(0.08, visibleEnd - lastTime - 0.05));
    segments.push({
      lines: layoutLines,
      chars: allChars,
      blockWidth,
      visibleStart: firstTime - options.preRollSeconds,
      firstTime,
      lastTime,
      outroStart: visibleEnd - outroSeconds,
      outroSeconds,
      visibleEnd,
      estimated: phrase.estimated,
    });
  });

  // Не даём предкурсору следующей фразы наложиться на уход предыдущей.
  for (let index = 1; index < segments.length; index += 1) {
    const previous = segments[index - 1];
    const current = segments[index];
    if (current.visibleStart < previous.visibleEnd) current.visibleStart = Math.min(current.firstTime, previous.visibleEnd);
  }

  return { options, px, fadeSeconds, segments, frameWidth, frameHeight };
}

// ---------------------------------------------------------------------------
// Отрисовка

export function segmentAt(timeline, time) {
  return timeline.segments.find((segment) => time >= segment.visibleStart && time < segment.visibleEnd) || null;
}

function charAlpha(timeline, segment, char, index, time) {
  const { options, fadeSeconds } = timeline;
  if (time < char.time) return 0;
  let alpha = options.softness <= 0.001 ? 1 : easeOutCubic((time - char.time) / fadeSeconds);
  if (time >= segment.outroStart) {
    const progress = (time - segment.outroStart) / segment.outroSeconds;
    if (options.outro === "fade") {
      alpha *= 1 - easeOutCubic(progress);
    } else {
      // Волна прозрачности слева направо, как Smoothness 100 → 0 в шаблоне.
      const count = Math.max(1, segment.chars.length - 1);
      const local = clamp(progress * 1.6 - (index / count) * 0.6, 0, 1);
      alpha *= 1 - easeOutCubic(local);
    }
  }
  return alpha;
}

function cursorState(timeline, segment, time) {
  const { options } = timeline;
  if (time >= segment.outroStart) return null;
  let lineIndex = 0;
  // До первой буквы курсор ждёт в начале строки: справа налево — у правого края.
  let rtl = options.direction === "rtl";
  let x = rtl ? segment.lines[0]?.width || 0 : 0;
  let lastTyped = null;
  let lastTime = 0;
  segment.lines.forEach((line, li) => {
    line.chars.forEach((char) => {
      if (char.time <= time) {
        lastTyped = char;
        lineIndex = li;
        if (char.whole) {
          // Справа налево: курсор стоит у левого края набранной части слова.
          const shown = shownUnits(char, time);
          lastTime = char.times[shown - 1];
          rtl = true;
          if (char.ltr && shown < char.units.length) {
            // Латиница внутри арабской строки набирается слева направо.
            rtl = false;
            x = char.x + char.prefix[shown - 1];
            return;
          }
          if (char.latinRun && !char.runEnd) {
            // «Reel» набрано, «Lab» ещё нет — курсор ждёт справа от «Reel».
            rtl = false;
            x = char.right;
            return;
          }
          // Кусок латиницы набран целиком — арабский текст продолжится слева
          // от него, туда и встаёт курсор (справа он залез бы на соседнее слово).
          x = char.latinRun ? char.runLeft : char.ltr ? char.x : char.right - char.prefix[shown - 1];
          return;
        }
        lastTime = char.time;
        // Курсор стоит ровно у видимого края текста: пока буква проявляется,
        // он плавно проходит её ширину вместе с ней и не убегает вперёд
        // прозрачной буквы.
        const appear = options.softness <= 0.001 ? 1 : easeOutCubic((time - char.time) / timeline.fadeSeconds);
        x = char.x + (char.right - char.x) * appear;
      }
    });
  });
  const since = lastTyped ? time - lastTime : time - segment.visibleStart;
  let visible = true;
  // Пока идёт набор — курсор горит. В паузе — мигает раз в секунду, как
  // выражение шаблона blink = Math.round(time % 1).
  if (options.cursorBlink && since > 0.2) visible = Math.floor((since - 0.2) / 0.5) % 2 === 0;
  return { lineIndex, x, visible, rtl };
}

/** Рисует состояние печатной машинки в момент `time` в прямоугольник кадра. */
export function drawTypewriter(ctx, timeline, time, dx = 0, dy = 0, dWidth = timeline.frameWidth, dHeight = timeline.frameHeight) {
  const segment = segmentAt(timeline, time);
  if (!segment) return false;
  const { options, px, frameWidth, frameHeight } = timeline;
  const lineHeight = px * options.lineHeight;
  const blockHeight = lineHeight * segment.lines.length;
  const anchorY = options.verticalOffset * frameHeight;
  let top = anchorY - blockHeight;
  if (options.verticalAlign === "top") top = anchorY;
  if (options.verticalAlign === "center") top = anchorY - blockHeight / 2;
  top = clamp(top, frameHeight * 0.03, frameHeight * 0.97 - blockHeight);
  // Центр блока можно сдвинуть перетаскиванием; блок не уходит за край кадра.
  const centerX = clamp(Number(options.horizontalOffset ?? 0.5), 0, 1) * frameWidth;
  const fitLeft = (width) => clamp(centerX - width / 2, frameWidth * 0.02, Math.max(frameWidth * 0.02, frameWidth * 0.98 - width));
  const blockLeft = fitLeft(segment.blockWidth);

  ctx.save();
  ctx.translate(dx, dy);
  ctx.scale(dWidth / frameWidth, dHeight / frameHeight);
  ctx.font = fontString(options, px);
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  const shadow = clamp(options.shadow, 0, 1);
  if (shadow > 0) {
    ctx.shadowColor = `rgba(0, 0, 0, ${0.62 * shadow})`;
    ctx.shadowBlur = px * 0.22 * shadow;
    ctx.shadowOffsetY = px * 0.05 * shadow;
  }
  const rise = px * 0.07 * clamp(options.softness, 0, 1);
  const baselineOffset = lineHeight * 0.5 + px * 0.36;

  const rtl = options.direction === "rtl";
  if (rtl) ctx.direction = "rtl";
  ctx.textAlign = "left";
  let index = 0;
  segment.lines.forEach((line, li) => {
    // «По краю» для письма справа налево — по правому краю блока.
    const left = options.align === "left" ? (rtl ? blockLeft + segment.blockWidth - line.width : blockLeft) : fitLeft(line.width);
    const baseline = top + li * lineHeight + baselineOffset;
    line.left = left;
    line.baseline = baseline;
    for (const char of line.chars) {
      const alpha = char.isSpace ? 0 : charAlpha(timeline, segment, char, index, time);
      index += 1;
      if (alpha <= 0.001) continue;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = char.emphasis ? options.highlightColor : options.textColor;
      const appear = time < segment.outroStart ? 1 - easeOutCubic((time - char.time) / timeline.fadeSeconds) : 0;
      if (char.whole) {
        const shown = time >= segment.outroStart ? char.units.length : shownUnits(char, time);
        if (shown < char.units.length) {
          // Набранная часть слова рисуется как отдельное слово: буквы
          // соединены, последняя — в конечной форме, как при наборе.
          const typed = char.units.slice(0, shown).join("");
          ctx.textAlign = char.ltr ? "left" : "right";
          ctx.fillText(typed, left + (char.ltr ? char.x : char.right), baseline + rise * appear);
          ctx.textAlign = "left";
          continue;
        }
      }
      ctx.fillText(char.glyph, left + char.x, baseline + rise * appear);
    }
  });

  const cursor = cursorState(timeline, segment, time);
  if (cursor && cursor.visible && options.cursor) {
    const line = segment.lines[cursor.lineIndex];
    ctx.globalAlpha = 1;
    ctx.fillStyle = options.textColor;
    if (options.cursor === "|") {
      const width = Math.max(1.5, px * 0.075);
      const x = cursor.rtl ? line.left + cursor.x - px * 0.05 - width : line.left + cursor.x + px * 0.05;
      ctx.fillRect(x, line.baseline - px * 0.8, width, px * 0.98);
    } else {
      // Как в шаблоне: курсор — это знак "_", напечатанный сразу после
      // последней буквы тем же шрифтом на той же базовой линии.
      // Справа налево курсор стоит с зазором: прижатый к букве «_» выглядит
      // как растянутая связка арабских букв.
      const x = cursor.rtl ? line.left + cursor.x - ctx.measureText("_").width - px * 0.16 : line.left + cursor.x;
      ctx.fillText("_", x, line.baseline);
    }
  }
  ctx.restore();
  return true;
}

// ---------------------------------------------------------------------------
// Рендерер для движка TSCaps (тот же экспорт MP4, что и у готовых стилей)

export class TypewriterFrameRenderer {
  constructor(cues, options) {
    this.cues = cues;
    this.options = options;
    this.timeline = null;
  }

  async open(_document, _styles, width, height) {
    this.timeline = buildTimeline(this.cues, width, height, this.options);
  }

  async getMaxTilesPerBatch() {
    return 24;
  }

  async getFrames(timestamps) {
    return timestamps.map((time) => {
      if (!this.timeline || !segmentAt(this.timeline, time)) return null;
      return {
        draw: (ctx, dx, dy, dWidth, dHeight) => {
          drawTypewriter(ctx, this.timeline, time, dx, dy, dWidth, dHeight);
        },
      };
    });
  }

  close() {
    this.timeline = null;
  }
}

/** Моменты ударов клавиш: по одному на каждую видимую букву. */
export function keyStrikeTimes(timeline) {
  const times = [];
  for (const segment of timeline.segments) {
    for (const char of segment.chars) {
      if (char.isSpace) continue;
      if (char.whole) {
        // Слово справа налево: удар клавиши на каждую набранную букву.
        char.times.forEach((time, k) => times.push({ time, wordStart: k === 0 }));
        continue;
      }
      times.push({ time: char.time, wordStart: char.wordStart });
    }
  }
  return times;
}

/** Буквы текста субтитров (без повторов) — чтобы загрузились и шрифты для арабского и других алфавитов. */
export function textSample(cues, limit = 400) {
  const seen = new Set();
  for (const cue of cues || []) {
    for (const word of cue.words || []) {
      for (const char of String(word.text || "")) {
        if (char.trim()) seen.add(char);
        if (seen.size >= limit) return [...seen].join("");
      }
    }
  }
  return [...seen].join("");
}

export async function ensureTypewriterFont(options = TYPEWRITER_DEFAULTS, text = "") {
  if (typeof document === "undefined" || !document.fonts) return;
  // Пример — с буквами самих субтитров: иначе шрифт для арабских букв загрузится
  // позже, чем строки будут измерены, и слова съедут.
  const sample = `Печатная машинка Abc 0123 ${text}`;
  try {
    await document.fonts.load(`${options.fontWeight} 48px "Roboto"`, sample);
  } catch (_) { /* Roboto может отсутствовать — это нормально */ }
  await document.fonts.load(`${options.fontWeight} 48px "Reel Typewriter"`, sample);
  // Шрифт, выбранный человеком для этого стиля (если выбран).
  try {
    await document.fonts.load(`${options.fontWeight} 48px ${options.fontFamily}`, sample);
  } catch (_) { /* останется запасной шрифт */ }
  await document.fonts.ready;
}
