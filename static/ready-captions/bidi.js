// Порядок слов в строке справа налево (арабский) для стилей, которые сами
// раскладывают слова на холсте (печатная машинка, слова с картинками).
//
// Арабские слова идут справа налево, а латиница внутри арабской фразы
// (Reel Lab, iPhone, YouTube Shorts) — слева направо, как в любом тексте:
// «هذا هو Reel Lab» читается справа налево, но «Reel Lab» не переворачивается.
// Это упрощённый двунаправленный алгоритм Unicode на уровне слов.

const RTL_CHAR = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
const LTR_LETTER = /[A-Za-zÀ-ɏͰ-ϿЀ-ԯ]/;
const DIGIT = /[0-9٠-٩۰-۹]/;

/**
 * Направление каждого слова в строке справа налево: "R" или "L".
 * Слово без букв (тире, многоточие) берёт направление соседей: внутри
 * латиницы — слева направо, иначе — как строка. Число само по себе стоит
 * как отдельное слово справа налево (так его ставит и браузер).
 */
export function wordDirections(texts) {
  const kinds = texts.map((text) => {
    const value = String(text || "");
    if (RTL_CHAR.test(value)) return "R";
    if (LTR_LETTER.test(value)) return "L";
    if (DIGIT.test(value)) return "R";
    return "N";
  });
  return kinds.map((kind, index) => {
    if (kind !== "N") return kind;
    let before = index - 1;
    while (before >= 0 && kinds[before] === "N") before -= 1;
    let after = index + 1;
    while (after < kinds.length && kinds[after] === "N") after += 1;
    return before >= 0 && after < kinds.length && kinds[before] === "L" && kinds[after] === "L" ? "L" : "R";
  });
}

const WORDISH = /[\p{L}\p{N}]/u;
const LATIN_LETTER = /\p{Script=Latin}/u;
const NON_LATIN_LETTER = /(?!\p{Script=Latin})\p{L}/u;

/** Слово без букв и цифр: отдельное тире, многоточие, кавычка. */
export function isPunctuationOnly(text) {
  return !WORDISH.test(String(text ?? ""));
}

/**
 * Какие слова нельзя отрывать от предыдущего, когда фраза делится на строки
 * или на части: отдельный знак («—», «…») и короткое латинское название
 * внутри арабской или русской фразы («Reel Lab», «YouTube Shorts»).
 * Длинный кусок латиницы (4 слова и больше) — это уже фраза, его можно делить.
 */
export function gluedToPrevious(texts) {
  const list = texts.map((text) => String(text ?? ""));
  const glued = list.map((text, i) => i > 0 && isPunctuationOnly(text));
  if (!list.some((text) => NON_LATIN_LETTER.test(text))) return glued;
  const latin = list.map((text) => LATIN_LETTER.test(text) && !NON_LATIN_LETTER.test(text));
  let i = 0;
  while (i < list.length) {
    if (!latin[i]) {
      i += 1;
      continue;
    }
    let end = i;
    while (end + 1 < list.length && latin[end + 1]) end += 1;
    if (end > i && end - i < 3) for (let k = i + 1; k <= end; k += 1) glued[k] = true;
    i = end + 1;
  }
  return glued;
}

/**
 * Левый край каждого слова строки справа налево (в логическом порядке слов)
 * и ширина строки. widths — ширины слов, space — ширина пробела.
 */
export function rtlPositions(texts, widths, space) {
  const directions = wordDirections(texts);
  const total = widths.reduce((sum, value) => sum + value, 0) + space * Math.max(0, widths.length - 1);
  const xs = new Array(widths.length);
  let edge = total;
  let index = 0;
  while (index < widths.length) {
    if (directions[index] === "L") {
      // Подряд идущие слова латиницей — одним куском слева направо.
      let end = index;
      let runWidth = 0;
      while (end < widths.length && directions[end] === "L") {
        runWidth += widths[end] + (end > index ? space : 0);
        end += 1;
      }
      let x = edge - runWidth;
      for (let k = index; k < end; k += 1) {
        xs[k] = x;
        x += widths[k] + space;
      }
      edge -= runWidth + space;
      index = end;
    } else {
      xs[index] = edge - widths[index];
      edge = xs[index] - space;
      index += 1;
    }
  }
  return { xs, total, directions };
}
