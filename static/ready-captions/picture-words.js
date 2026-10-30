// «Слова с картинками».
//
// Слова появляются по одному и разбросаны по кадру; фразы копятся на экране
// (до трёх), потом уходят вместе. Важные слова подсвечены цветом по смыслу,
// рядом с ключевым словом всплывает небольшая картинка без фона. Какие слова
// подсветить и что нарисовать, решает ИИ-режиссёр (сервер, ai_pictures.py);
// здесь — раскладка, вырезание фона и анимация. Один и тот же код рисует
// предпросмотр, ролик в браузере и ролик на сервере.

export const PICTURES_ID = "pictures";

export const ACCENT_PALETTE = Object.freeze({
  gold: "#ffc94a",
  green: "#4fd86b",
  red: "#ff4b4b",
  blue: "#5cb8ff",
  violet: "#b48cff",
  pink: "#ff7cc4",
});
export const ACCENT_ORDER = ["gold", "green", "red", "blue", "violet", "pink"];

import { gluedToPrevious, isPunctuationOnly, rtlPositions } from "./bidi.js";

export const PICTURE_DEFAULTS = Object.freeze({
  fontFamily: '"Rubik", "Reel Typewriter", sans-serif',
  fontWeight: 800,
  fontSize: 5.8,            // % от √(ширина × высота) кадра
  lineHeight: 1.06,
  textColor: "#ffffff",
  highlightColor: ACCENT_PALETTE.gold,
  maxWordsPerPhrase: 4,
  maxWordsPerLine: 2,
  stack: 3,                 // сколько фраз копится на экране
  pageGap: 1.1,             // пауза в речи, после которой экран очищается
  lead: 0.06,               // слово появляется чуть раньше звука
  wordIn: 0.32,
  hold: 0.75,
  outro: 0.38,
  glow: 0.6,
  pictureSize: 0.36,        // доля короткой стороны кадра
  pictureOpacity: 0.94,
  pictureBlend: "cutout",   // "cutout" — вырезать фон, "screen" — вплавить
  pictureIn: 0.55,
  accents: [],              // [{ w, color }] — от ИИ-режиссёра или из правки
  keywords: [],             // слова, отмеченные человеком в тексте (золотые)
  pictures: [],             // [{ w, url, dx, dy, scale, layer }]
  // Правка композиции человеком: сдвиг (доли кадра) и масштаб фраз и строк.
  // Ключ — номер первого слова фразы или строки.
  layout: { phrases: {}, lines: {} },
  autoAccent: true,         // без плана ИИ — самое длинное слово фразы
  showPending: false,       // предпросмотр: место под картинку, которая ещё рисуется
});

const SPACE = " ";
const SHORT_WORD = /^[\p{L}]{1,2}[,.!?…:;،؛؟]?$/u;
// Конец предложения и знаки внутри него, в том числе арабские (؟ ، ؛).
const SENTENCE_END = /[.!?…؟۔]["»)]*$/;
const PHRASE_PUNCTUATION = /[,:;—–\-،؛]$/;
const STOP = new Set(("это этот эта эти того тому такой такая также когда потому чтобы который которая которые "
  + "очень всегда сегодня сейчас просто только здесь вообще можно нужно будет будут было была были есть "
  + "которыми которых меня тебя себя тоже даже потом теперь").split(" "));

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function easeOutCubic(x) {
  const t = clamp(x, 0, 1);
  return 1 - (1 - t) ** 3;
}

function easeInCubic(x) {
  const t = clamp(x, 0, 1);
  return t * t * t;
}

function easeOutBack(x) {
  const t = clamp(x, 0, 1);
  const c = 1.4;
  return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2;
}

// Детерминированный «случай»: одинаковая раскладка в предпросмотре и в ролике.
function seeded(seed) {
  let value = (seed * 2654435761) >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function cleanWord(text) {
  return String(text || "").replace(/[^\p{L}\p{N}-]+/gu, "");
}

function keyOf(text) {
  return cleanWord(text).toLowerCase().replace(/ё/g, "е");
}

export function fontString(options, px) {
  return `${options.fontWeight} ${px}px ${options.fontFamily}`;
}

// ---------------------------------------------------------------------------
// Фразы: короткие, по 1–4 слова, как в монтаже Reels

function splitWords(words, max) {
  if (words.length <= 1) return [words];
  // Конец предложения или длинная пауза внутри — всегда новая фраза.
  for (let i = 1; i < words.length; i += 1) {
    const gap = words[i].start - words[i - 1].end;
    if (!words[i].glue && (SENTENCE_END.test(words[i - 1].text) || gap > 0.55)) {
      return [...splitWords(words.slice(0, i), max), ...splitWords(words.slice(i), max)];
    }
  }
  // Отдельный знак («—») в счёт слов не идёт.
  if (words.filter((word) => !isPunctuationOnly(word.text)).length <= max) return [words];
  let best = 1;
  let bestScore = -Infinity;
  for (let i = 1; i < words.length; i += 1) {
    const gap = words[i].start - words[i - 1].end;
    const punctuation = PHRASE_PUNCTUATION.test(words[i - 1].text) ? 0.5 : 0;
    const left = i;
    const right = words.length - i;
    const balance = -Math.abs(left - right) * 0.08;
    const orphan = left < 2 || right < 2 ? -0.35 : 0;
    // Предлог в конце фразы читается плохо: «загляни в | своё сердце».
    const dangling = SHORT_WORD.test(words[i - 1].text) && !punctuation ? -0.4 : 0;
    // Название латиницей («Reel Lab») и отдельное тире не отрываются.
    const glued = words[i].glue ? -3 : 0;
    const score = gap * 2 + punctuation + balance + orphan + dangling + glued;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return [...splitWords(words.slice(0, best), max), ...splitWords(words.slice(best), max)];
}

/** Фразы стиля со сквозным номером каждого слова (w) — по нему план ИИ ссылается на слова. */
export function picturePhrases(cues, maxWords = PICTURE_DEFAULTS.maxWordsPerPhrase) {
  const phrases = [];
  let index = 0;
  for (const cue of cues || []) {
    // Номер слова считается по всем словам, вырезанные при монтаже просто не показываются.
    const words = (cue.words || []).map((word) => ({ text: word.text, start: word.start, end: word.end, w: index++, hidden: word.hidden }))
      .filter((word) => !word.hidden);
    const glue = gluedToPrevious(words.map((word) => word.text));
    words.forEach((word, i) => { word.glue = glue[i]; });
    for (const part of splitWords(words, maxWords)) {
      if (part.length) phrases.push({ words: part, start: part[0].start, end: part[part.length - 1].end });
    }
  }
  return phrases;
}

export function flatWords(cues) {
  const words = [];
  for (const cue of cues || []) for (const word of cue.words || []) words.push(word);
  return words;
}

// ---------------------------------------------------------------------------
// Вырезание фона у картинки

const prepared = new Map();

function makeCanvas(width, height) {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function median(values) {
  const sorted = Array.from(values).sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] || 0;
}

function boxBlurAlpha(alpha, width, height, radius) {
  const tmp = new Float32Array(alpha.length);
  const size = radius * 2 + 1;
  for (let y = 0; y < height; y += 1) {
    let sum = 0;
    const row = y * width;
    for (let x = -radius; x <= radius; x += 1) sum += alpha[row + clamp(x, 0, width - 1)];
    for (let x = 0; x < width; x += 1) {
      tmp[row + x] = sum / size;
      sum += alpha[row + clamp(x + radius + 1, 0, width - 1)] - alpha[row + clamp(x - radius, 0, width - 1)];
    }
  }
  for (let x = 0; x < width; x += 1) {
    let sum = 0;
    for (let y = -radius; y <= radius; y += 1) sum += tmp[clamp(y, 0, height - 1) * width + x];
    for (let y = 0; y < height; y += 1) {
      alpha[y * width + x] = sum / size;
      sum += tmp[clamp(y + radius + 1, 0, height - 1) * width + x] - tmp[clamp(y - radius, 0, height - 1) * width + x];
    }
  }
}

/**
 * Картинка художника нарисована на однотонном (обычно чёрном) фоне. Фон —
 * всё, что связано с краем кадра и близко к цвету края; он становится
 * прозрачным с мягким краем. Тёмные «окна» внутри предмета, совпадающие с
 * фоном, тоже вырезаются. Своя картинка с прозрачностью остаётся как есть.
 */
function cutOut(data, width, height) {
  const n = width * height;
  const px = data.data;
  const alpha = new Float32Array(n);
  const border = [];
  for (let x = 0; x < width; x += 1) border.push(x, (height - 1) * width + x, width + x, (height - 2) * width + x);
  for (let y = 0; y < height; y += 1) border.push(y * width, y * width + width - 1, y * width + 1, y * width + width - 2);
  const transparentEdge = border.filter((i) => px[i * 4 + 3] < 245).length > border.length * 0.3;
  if (transparentEdge) {
    for (let i = 0; i < n; i += 1) alpha[i] = px[i * 4 + 3] / 255;
    return { alpha, mode: "alpha" };
  }
  const bg = [0, 1, 2].map((c) => median(border.map((i) => px[i * 4 + c])));
  const dist = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) {
    const o = i * 4;
    dist[i] = Math.max(Math.abs(px[o] - bg[0]), Math.abs(px[o + 1] - bg[1]), Math.abs(px[o + 2] - bg[2]));
  }
  const T0 = 9;
  const T1 = 34;
  const visited = new Uint8Array(n);
  const stack = new Int32Array(n);
  let top = 0;
  for (const i of border) {
    if (!visited[i] && dist[i] < T1) {
      visited[i] = 1;
      stack[top++] = i;
    }
  }
  while (top > 0) {
    const i = stack[--top];
    const x = i % width;
    const neighbours = [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, i - width, i + width];
    for (const j of neighbours) {
      if (j < 0 || j >= n || visited[j] || dist[j] >= T1) continue;
      visited[j] = 1;
      stack[top++] = j;
    }
  }
  // Предмет: всё, что не фон. Мелкие крошки шума в фоне убираются, крупные
  // «окна» цвета фона внутри предмета вырезаются.
  const label = new Int32Array(n).fill(-1);
  const areas = [];
  for (let start = 0; start < n; start += 1) {
    if (visited[start] || label[start] >= 0) continue;
    const id = areas.length;
    let area = 0;
    label[start] = id;
    stack[0] = start;
    top = 1;
    while (top > 0) {
      const i = stack[--top];
      area += 1;
      const x = i % width;
      const neighbours = [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, i - width, i + width];
      for (const j of neighbours) {
        if (j < 0 || j >= n || visited[j] || label[j] >= 0) continue;
        label[j] = id;
        stack[top++] = j;
      }
    }
    areas.push(area);
  }
  const largest = Math.max(0, ...areas);
  const keep = areas.map((area) => area >= Math.max(60, largest * 0.012));
  for (let i = 0; i < n; i += 1) {
    if (visited[i]) {
      const t = clamp((dist[i] - T0) / (T1 * 1.6 - T0), 0, 1);
      alpha[i] = t ** 1.4 * 0.85;
    } else {
      alpha[i] = keep[label[i]] ? 1 : 0;
    }
  }
  // Окна внутри предмета: связные области почти точного цвета фона.
  const hole = new Uint8Array(n);
  const holeLimit = n * 0.012;
  for (let start = 0; start < n; start += 1) {
    if (visited[start] || hole[start] || dist[start] >= 7) continue;
    const members = [];
    stack[0] = start;
    top = 1;
    hole[start] = 1;
    while (top > 0) {
      const i = stack[--top];
      members.push(i);
      const x = i % width;
      const neighbours = [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, i - width, i + width];
      for (const j of neighbours) {
        if (j < 0 || j >= n || visited[j] || hole[j] || dist[j] >= 7) continue;
        hole[j] = 1;
        stack[top++] = j;
      }
    }
    if (members.length > holeLimit) for (const i of members) alpha[i] = 0;
  }
  boxBlurAlpha(alpha, width, height, 1);
  // Возвращаем краям цвет без примеси фона.
  for (let i = 0; i < n; i += 1) {
    const a = alpha[i];
    if (a <= 0.02 || a >= 0.98) continue;
    const o = i * 4;
    for (let c = 0; c < 3; c += 1) px[o + c] = clamp((px[o + c] - bg[c] * (1 - a)) / a, 0, 255);
  }
  return { alpha, mode: "cut" };
}

async function loadAndCut(url) {
  const response = await fetch(url, { credentials: "same-origin" });
  if (!response.ok) throw new Error(`Картинка не загрузилась (${response.status}).`);
  const bitmap = await createImageBitmap(await response.blob());
  const scale = Math.min(1, 640 / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(8, Math.round(bitmap.width * scale));
  const height = Math.max(8, Math.round(bitmap.height * scale));
  const source = makeCanvas(width, height);
  const sctx = source.getContext("2d", { willReadFrequently: true });
  sctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  const original = sctx.getImageData(0, 0, width, height);
  const data = new ImageData(new Uint8ClampedArray(original.data), width, height);
  const { alpha, mode } = cutOut(data, width, height);
  if (/\/f[0-9a-f]{39}\.(?:jpg|png|webp)$/.test(url)) {
    // Бесплатный генератор подписывает картинку в правом нижнем углу.
    for (let y = Math.floor(height * 0.88); y < height; y += 1) {
      for (let x = Math.floor(width * 0.58); x < width; x += 1) alpha[y * width + x] = 0;
    }
  }
  // Мягкое затухание у самых краёв: никакого прямоугольного среза.
  const edge = Math.max(2, Math.round(Math.min(width, height) * 0.035));
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      const d = Math.min(x, y, width - 1 - x, height - 1 - y);
      let a = alpha[i] * clamp(d / edge, 0, 1);
      if (mode === "alpha") a = alpha[i];
      data.data[i * 4 + 3] = Math.round(a * 255);
      if (a > 0.12) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0 || (maxX - minX) * (maxY - minY) < width * height * 0.03) {
    // Фон не отделился (например, фото без однотонного фона): вся картинка
    // с мягкой круглой виньеткой.
    minX = 0; minY = 0; maxX = width - 1; maxY = height - 1;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = y * width + x;
        const dx = (x / width - 0.5) * 2;
        const dy = (y / height - 0.5) * 2;
        const r = Math.sqrt(dx * dx + dy * dy);
        data.data[i * 4 + 3] = Math.round(255 * (1 - clamp((r - 0.62) / 0.36, 0, 1)));
      }
    }
  }
  const pad = Math.round(Math.max(maxX - minX, maxY - minY) * 0.06);
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(width - 1, maxX + pad);
  maxY = Math.min(height - 1, maxY + pad);
  const cropW = maxX - minX + 1;
  const cropH = maxY - minY + 1;
  const full = makeCanvas(width, height);
  full.getContext("2d").putImageData(data, 0, 0);
  const cut = makeCanvas(cropW, cropH);
  cut.getContext("2d").drawImage(full, minX, minY, cropW, cropH, 0, 0, cropW, cropH);
  // «Вплавить»: исходная картинка с тёмным фоном и мягкой овальной маской,
  // рисуется режимом «экран» — чёрное исчезает, светлое светится.
  const screen = makeCanvas(cropW, cropH);
  const screenCtx = screen.getContext("2d");
  screenCtx.drawImage(source, minX, minY, cropW, cropH, 0, 0, cropW, cropH);
  screenCtx.globalCompositeOperation = "destination-in";
  const mask = screenCtx.createRadialGradient(cropW / 2, cropH / 2, Math.min(cropW, cropH) * 0.3, cropW / 2, cropH / 2, Math.max(cropW, cropH) * 0.62);
  mask.addColorStop(0, "rgba(0,0,0,1)");
  mask.addColorStop(1, "rgba(0,0,0,0)");
  screenCtx.fillStyle = mask;
  screenCtx.fillRect(0, 0, cropW, cropH);
  return { cut, screen, width: cropW, height: cropH, mode };
}

/** Загружает картинку и вырезает фон (результат кешируется по адресу). */
export function preparePicture(url) {
  if (!url) return Promise.reject(new Error("Нет адреса картинки."));
  if (!prepared.has(url)) {
    const task = loadAndCut(url);
    prepared.set(url, task);
    task.catch(() => prepared.delete(url));
  }
  return prepared.get(url);
}

/** Уже готовые картинки (для предпросмотра, без ожидания). */
export async function preparedPictures(pictures) {
  const images = new Map();
  await Promise.all((pictures || []).map(async (picture) => {
    if (!picture?.url) return;
    try {
      images.set(picture.url, await preparePicture(picture.url));
    } catch (error) {
      console.warn("[reel-lab] picture", picture.url, error);
    }
  }));
  return images;
}

// ---------------------------------------------------------------------------
// Раскладка

function rect(x, y, w, h) {
  return { x, y, w, h };
}

function overlapArea(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

function inflate(r, m) {
  return rect(r.x - m, r.y - m, r.w + m * 2, r.h + m * 2);
}

function safeArea(W, H) {
  const portrait = H >= W;
  return {
    left: W * 0.06,
    right: W * (portrait ? 0.86 : 0.94),
    top: H * (portrait ? 0.1 : 0.08),
    bottom: H * (portrait ? 0.8 : 0.9),
  };
}

function layoutLines(words, measure, options, W, H) {
  const space = measure(SPACE);
  const widths = words.map((word) => measure(word.text));
  const longest = Math.max(...widths);
  // В вертикальном кадре строка — до половины ширины, в горизонтальном — до трети.
  const maxWidth = Math.max(longest, W * (H >= W ? 0.5 : 0.3));
  // Слова, которые нельзя разрывать переносом («Reel Lab», «Lab —»), идут
  // одним куском; отдельный знак в счёт слов строки не идёт.
  const units = [];
  words.forEach((word, i) => {
    const item = { ...word, width: widths[i] };
    const count = isPunctuationOnly(word.text) ? 0 : 1;
    const last = units[units.length - 1];
    if (word.glue && last) {
      last.words.push(item);
      last.width += space + widths[i];
      last.count += count;
    } else {
      units.push({ words: [item], width: widths[i], count });
    }
  });
  const lines = [];
  let current = [];
  let width = 0;
  let count = 0;
  for (const unit of units) {
    const add = (current.length ? space : 0) + unit.width;
    if (current.length && (count + unit.count > options.maxWordsPerLine || width + add > maxWidth)) {
      lines.push(current);
      current = [];
      width = 0;
      count = 0;
    }
    width += (current.length ? space : 0) + unit.width;
    current.push(...unit.words);
    count += unit.count;
  }
  if (current.length) lines.push(current);
  // Короткий предлог не остаётся в конце строки: «в» уходит к своему слову.
  for (let i = 0; i < lines.length - 1; i += 1) {
    const line = lines[i];
    const last = line[line.length - 1];
    if (line.length > 1 && !last.glue && SHORT_WORD.test(last.text) && lines[i + 1].length < options.maxWordsPerLine + 1) {
      lines[i + 1].unshift(line.pop());
    }
  }
  const rtl = options.direction === "rtl";
  return lines.map((line) => {
    const total = line.reduce((sum, word) => sum + word.width, 0) + space * Math.max(0, line.length - 1);
    if (rtl) {
      // Справа налево (арабский): первое слово — у правого края строки,
      // латиница внутри фразы — слева направо.
      const { xs } = rtlPositions(line.map((word) => word.text), line.map((word) => word.width), space);
      return { words: line.map((word, i) => ({ ...word, x: xs[i] })), width: total };
    }
    let x = 0;
    const placed = line.map((word, i) => {
      if (i) x += space;
      const item = { ...word, x };
      x += word.width;
      return item;
    });
    return { words: placed, width: total };
  });
}

/** Картинка перед текстом: 0 — за всем текстом, n — перед n первыми строками своей фразы, 9 — перед всем. */
export const LAYER_FRONT = 9;

function override(table, key) {
  const item = table?.[key] || table?.[String(key)] || null;
  const number = (value, fallback, min, max) => {
    const n = Number(value);
    return Number.isFinite(n) ? clamp(n, min, max) : fallback;
  };
  return {
    dx: number(item?.dx, 0, -1.5, 1.5),
    dy: number(item?.dy, 0, -1.5, 1.5),
    scale: number(item?.scale, 1, 0.3, 4),
  };
}

function pictureBox(image, picture, options, W, H) {
  const base = Math.min(W, H) * options.pictureSize * clamp(Number(picture.scale) || 1, 0.4, 2.5);
  const aspect = image ? image.width / image.height : 1;
  const w = aspect >= 1 ? base : base * aspect;
  const h = aspect >= 1 ? base / aspect : base;
  return { w, h };
}

const PICTURE_SPOTS = [
  ["above", 0], ["right", 0.06], ["left", 0.06], ["aboveRight", 0.1], ["aboveLeft", 0.1], ["below", 0.22],
];

function placePicture(block, size, others, texts, W, H, gap) {
  let best = null;
  for (const [spot, preference] of PICTURE_SPOTS) {
    let x;
    let y;
    if (spot === "above") { x = block.x + block.w / 2 - size.w / 2; y = block.y - gap - size.h; }
    if (spot === "below") { x = block.x + block.w / 2 - size.w / 2; y = block.y + block.h + gap; }
    if (spot === "right") { x = block.x + block.w + gap; y = block.y + block.h / 2 - size.h / 2; }
    if (spot === "left") { x = block.x - gap - size.w; y = block.y + block.h / 2 - size.h / 2; }
    if (spot === "aboveRight") { x = block.x + block.w - size.w * 0.35; y = block.y - gap - size.h * 0.85; }
    if (spot === "aboveLeft") { x = block.x - size.w * 0.65; y = block.y - gap - size.h * 0.85; }
    const box = rect(x, y, size.w, size.h);
    const outside = Math.max(0, W * 0.02 - box.x) + Math.max(0, box.x + box.w - W * 0.98)
      + Math.max(0, H * 0.05 - box.y) + Math.max(0, box.y + box.h - H * 0.9);
    let score = preference + (outside / Math.max(size.w, size.h)) * 6;
    for (const text of texts) score += (overlapArea(box, inflate(text, gap * 0.5)) / (size.w * size.h)) * 5;
    for (const other of others) score += (overlapArea(box, other) / (size.w * size.h)) * 3;
    if (!best || score < best.score) best = { box, score };
  }
  return best;
}

/**
 * Полное расписание: экраны (страницы) с фразами, строками, словами и
 * картинками, их места в кадре и время появления. Одно и то же для
 * предпросмотра, экспорта и звуков.
 */
export function buildPictureTimeline(cues, W, H, userOptions = {}, images = new Map()) {
  const options = { ...PICTURE_DEFAULTS, ...userOptions };
  const px = Math.max(10, (options.fontSize / 100) * Math.sqrt(W * H));
  const lineHeight = px * options.lineHeight;
  const measureCanvas = makeCanvas(8, 8);
  const mctx = measureCanvas.getContext("2d");
  mctx.font = fontString(options, px);
  const measure = (text) => mctx.measureText(text).width;
  const safe = safeArea(W, H);
  const gap = px * 0.35;

  // Цвета слов: план ИИ → отмеченные человеком → самое длинное слово фразы.
  const accentOf = new Map();
  for (const item of options.accents || []) {
    if (Number.isInteger(item?.w) && ACCENT_PALETTE[item.color]) accentOf.set(item.w, item.color);
  }
  const phrases = picturePhrases(cues, options.maxWordsPerPhrase);
  const userKeys = new Set((options.keywords || []).map(keyOf).filter(Boolean));
  for (const phrase of phrases) {
    for (const word of phrase.words) if (userKeys.has(keyOf(word.text)) && !accentOf.has(word.w)) accentOf.set(word.w, "gold");
    if (options.autoAccent && !(options.accents || []).length && phrase.words.length > 1) {
      let best = null;
      for (const word of phrase.words) {
        const clean = cleanWord(word.text);
        if (Array.from(clean).length < 5 || STOP.has(clean.toLowerCase())) continue;
        if (!best || clean.length > cleanWord(best.text).length) best = word;
      }
      if (best && !accentOf.has(best.w)) accentOf.set(best.w, "gold");
    }
  }
  const pictureOf = new Map();
  for (const picture of options.pictures || []) {
    if (Number.isInteger(picture?.w) && picture.url) pictureOf.set(picture.w, picture);
  }

  const pages = [];
  let page = null;
  let previous = null;
  phrases.forEach((phrase, phraseIndex) => {
    const lines = layoutLines(phrase.words, measure, options, W, H);
    const blockW = Math.max(...lines.map((line) => line.width));
    const blockH = lines.length * lineHeight;
    const picture = phrase.words.map((word) => pictureOf.get(word.w)).find(Boolean) || null;
    const image = picture ? images.get(picture.url) || null : null;
    const size = picture ? pictureBox(image, picture, options, W, H) : null;

    const tryPlace = (target) => {
      const rng = seeded(phraseIndex * 7919 + pages.length * 104729 + 17);
      const texts = target ? target.phrases.map((item) => item.box) : [];
      const pics = target ? target.pictures.map((item) => item.box) : [];
      const last = target?.phrases.at(-1)?.box || null;
      const xs = [0.3, 0.5, 0.7];
      const ys = [0.22, 0.34, 0.46, 0.58, 0.7];
      let best = null;
      for (const cy of ys) {
        for (const cx of xs) {
          const x = clamp(W * cx - blockW / 2, safe.left, Math.max(safe.left, safe.right - blockW));
          const y = clamp(H * cy - blockH / 2, safe.top, Math.max(safe.top, safe.bottom - blockH));
          const box = rect(x, y, blockW, blockH);
          let score = rng() * 0.35;
          let overlap = 0;
          for (const other of [...texts, ...pics]) overlap += overlapArea(inflate(box, gap), other) / (blockW * blockH);
          score += overlap * 10;
          // Центр верхней половины — обычно лицо: туда текст ставится реже.
          const face = overlapArea(box, rect(W * 0.32, H * 0.16, W * 0.36, H * 0.3)) / (blockW * blockH);
          score += face * 0.7;
          if (last) {
            const d = Math.hypot((box.x + box.w / 2 - last.x - last.w / 2) / W, (box.y + box.h / 2 - last.y - last.h / 2) / H);
            if (d < 0.22) score += (0.22 - d) * 2;
          }
          let spot = null;
          if (size) {
            spot = placePicture(box, size, pics, [...texts, box], W, H, gap);
            score += spot.score;
          }
          if (!best || score < best.score) best = { box, spot, score, overlap };
        }
      }
      return best;
    };

    const gapBefore = previous ? phrase.start - previous.end : Infinity;
    let placement = page && page.phrases.length < options.stack && gapBefore <= options.pageGap ? tryPlace(page) : null;
    if (!placement || placement.overlap > 0.02 || (placement.spot && placement.spot.score > 1.2)) {
      page = { phrases: [], pictures: [], start: 0, end: 0 };
      pages.push(page);
      placement = tryPlace(page);
    }
    const { box } = placement;
    // Правка человека: фраза целиком (сдвиг и масштаб вокруг её центра), затем каждая строка.
    const phraseKey = phrase.words[0].w;
    const po = override(options.layout?.phrases, phraseKey);
    const pcx = box.x + box.w / 2;
    const pcy = box.y + box.h / 2;
    const placedLines = lines.map((line, li) => {
      const lineKey = line.words[0].w;
      const lo = override(options.layout?.lines, lineKey);
      const scale = po.scale * lo.scale;
      // Строки выровнены по началу: слева, а справа налево (арабский) — справа.
      const lineLeft = options.direction === "rtl" ? box.x + box.w - line.width : box.x;
      const cx = pcx + (lineLeft + line.width / 2 - pcx) * po.scale + po.dx * W + lo.dx * W;
      const cy = pcy + (box.y + li * lineHeight + lineHeight / 2 - pcy) * po.scale + po.dy * H + lo.dy * H;
      return {
        key: lineKey,
        width: line.width,
        scale,
        cx,
        cy,
        words: line.words.map((word) => {
          const wcx = cx + (word.x + word.width / 2 - line.width / 2) * scale;
          return {
            text: word.text,
            w: word.w,
            start: word.start,
            end: word.end,
            x: wcx - (word.width * scale) / 2,
            width: word.width,
            scale,
            cx: wcx,
            cy: cy + px * 0.02 * scale,
            baseline: cy + px * 0.36 * scale,
            accent: accentOf.get(word.w) || null,
          };
        }),
      };
    });
    const slot = page.phrases.length;
    page.phrases.push({ key: phraseKey, box, lines: placedLines, start: phrase.start, end: phrase.end });
    if (picture && placement.spot) {
      const anchorWord = phrase.words.find((word) => word.w === picture.w);
      const box2 = placement.spot.box;
      // Картинка держится своей фразы: едет вместе с ней, плюс собственный сдвиг.
      const bx = pcx + (box2.x + box2.w / 2 - pcx) * po.scale + po.dx * W + (Number(picture.dx) || 0) * W;
      const by = pcy + (box2.y + box2.h / 2 - pcy) * po.scale + po.dy * H + (Number(picture.dy) || 0) * H;
      const moved = rect(bx - box2.w / 2, by - box2.h / 2, box2.w, box2.h);
      const layer = Math.round(clamp(Number(picture.layer) || 0, 0, LAYER_FRONT));
      page.pictures.push({ box: moved, base: box2, url: picture.url, w: picture.w, appearAt: (anchorWord?.start ?? phrase.start) - 0.12, seed: picture.w, layer, phrase: slot });
    }
    previous = phrase;
  });

  pages.forEach((item, index) => {
    const words = item.phrases.flatMap((phrase) => phrase.lines.flatMap((line) => line.words));
    const first = words[0];
    const last = words[words.length - 1];
    item.start = Math.max(0, first.start - options.lead);
    const lastAppear = Math.max(item.start, last.start - options.lead);
    let end = last.end + options.hold;
    const next = pages[index + 1];
    if (next) {
      const nextFirst = next.phrases[0].lines[0].words[0];
      end = Math.min(end, nextFirst.start - options.lead - 0.02);
    }
    item.end = Math.max(end, lastAppear + 0.4);
    item.outroSeconds = clamp(item.end - lastAppear - 0.12, 0.12, options.outro);
    item.outroStart = item.end - item.outroSeconds;
    for (const word of words) word.appear = Math.max(item.start, word.start - options.lead);
    for (const picture of item.pictures) picture.appear = clamp(picture.appearAt, item.start, item.outroStart - 0.1);
  });
  // Экраны не накладываются: следующий начинается после ухода предыдущего.
  for (let i = 1; i < pages.length; i += 1) {
    if (pages[i].start < pages[i - 1].end) pages[i - 1].end = pages[i].start;
    const prev = pages[i - 1];
    prev.outroStart = Math.min(prev.outroStart, prev.end - 0.08);
    prev.outroSeconds = prev.end - prev.outroStart;
  }

  return { options, px, lineHeight, pages, images, frameWidth: W, frameHeight: H };
}

// ---------------------------------------------------------------------------
// Отрисовка

export function pageAt(timeline, time) {
  return timeline.pages.find((page) => time >= page.start && time < page.end) || null;
}

function hexToRgba(hex, alpha) {
  const value = String(hex || "#ffffff").replace("#", "");
  const n = parseInt(value.length === 3 ? value.split("").map((c) => c + c).join("") : value, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function colorFor(timeline, accent) {
  const { options } = timeline;
  if (!accent) return options.textColor;
  if (accent === "gold") return options.highlightColor || ACCENT_PALETTE.gold;
  return ACCENT_PALETTE[accent] || options.highlightColor;
}

/**
 * Что видно на экране в момент `time`, в порядке отрисовки (сзади вперёд):
 * строки и картинки с их рамками — для правки композиции прямо на видео.
 */
export function compositionAt(timeline, time) {
  const page = pageAt(timeline, time);
  if (!page) return [];
  const { px } = timeline;
  const items = [];
  const phraseRects = page.phrases.map((phrase) => {
    let r = null;
    for (const line of phrase.lines) {
      const lr = lineRect(line, px);
      r = r ? union(r, lr) : lr;
    }
    return r;
  });
  const picture = (item) => ({
    kind: "picture", key: item.w, url: item.url, layer: item.layer || 0,
    phraseKey: page.phrases[item.phrase]?.key ?? null, lines: page.phrases[item.phrase]?.lines.length || 0,
    rect: { x: item.box.x, y: item.box.y, w: item.box.w, h: item.box.h },
  });
  const shown = (item) => time >= item.appear;
  for (const item of page.pictures) if (!item.layer && shown(item)) items.push(picture(item));
  page.phrases.forEach((phrase, pi) => {
    phrase.lines.forEach((line, li) => {
      if (line.words.some(shown)) {
        items.push({ kind: "line", key: line.key, phraseKey: phrase.key, lineIndex: li, lines: phrase.lines.length,
          rect: lineRect(line, px), phraseRect: phraseRects[pi] });
      }
      for (const item of page.pictures) {
        if (item.phrase === pi && item.layer === li + 1 && item.layer < LAYER_FRONT && shown(item)) items.push(picture(item));
      }
    });
    for (const item of page.pictures) {
      if (item.phrase === pi && item.layer > phrase.lines.length && item.layer < LAYER_FRONT && shown(item)) items.push(picture(item));
    }
  });
  for (const item of page.pictures) if (item.layer >= LAYER_FRONT && shown(item)) items.push(picture(item));
  return items;
}

function lineRect(line, px) {
  const left = Math.min(...line.words.map((word) => word.cx - (word.width * word.scale) / 2));
  const right = Math.max(...line.words.map((word) => word.cx + (word.width * word.scale) / 2));
  const half = px * 0.62 * line.scale;
  return { x: left, y: line.cy - half, w: right - left, h: half * 2 };
}

function union(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/** Где на экране картинки в момент `time` (для перетаскивания в предпросмотре). */
export function pictureRectsAt(timeline, time) {
  const page = pageAt(timeline, time);
  if (!page) return [];
  return page.pictures.filter((picture) => time >= picture.appear).map((picture) => ({
    x: picture.box.x, y: picture.box.y, width: picture.box.w, height: picture.box.h, word: picture.w, url: picture.url,
  }));
}

function drawPicture(ctx, timeline, page, picture, time) {
  const { options, frameHeight } = timeline;
  if (time < picture.appear) return;
  const image = timeline.images.get(picture.url);
  const p = (time - picture.appear) / options.pictureIn;
  let alpha = easeOutCubic(p) * options.pictureOpacity;
  let scale = 0.8 + 0.2 * easeOutBack(p);
  let blur = (1 - easeOutCubic(p)) * 10;
  if (time >= page.outroStart) {
    const q = (time - page.outroStart) / page.outroSeconds;
    alpha *= 1 - easeInCubic(q);
    blur += q * 8;
    scale *= 1 - 0.06 * q;
  }
  if (alpha <= 0.002) return;
  const { box } = picture;
  const since = time - picture.appear;
  const float = Math.sin(since * 1.3 + picture.seed) * frameHeight * 0.006;
  const drift = 1 + 0.035 * clamp(since / 5, 0, 1);
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2 + float;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(scale * drift, scale * drift);
  ctx.globalAlpha = alpha;
  if (!image) {
    if (options.showPending) {
      // Картинка ещё рисуется: мягкое мерцающее пятно на её месте.
      const pulse = 0.5 + 0.5 * Math.sin(time * 4);
      const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, box.w * 0.5);
      gradient.addColorStop(0, `rgba(255,255,255,${0.1 + 0.08 * pulse})`);
      gradient.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = gradient;
      ctx.fillRect(-box.w / 2, -box.h / 2, box.w, box.h);
    }
    ctx.restore();
    return;
  }
  if (blur > 0.4) ctx.filter = `blur(${blur.toFixed(1)}px)`;
  if (options.pictureBlend === "screen") {
    ctx.globalCompositeOperation = "screen";
    ctx.drawImage(image.screen, -box.w / 2, -box.h / 2, box.w, box.h);
  } else {
    ctx.drawImage(image.cut, -box.w / 2, -box.h / 2, box.w, box.h);
  }
  ctx.restore();
}

/**
 * Слово с тенью и свечением. ctx уже сдвинут в центр слова и масштабирован
 * на размер строки; тени и свечение — в пикселях кадра.
 */
function paintWord(ctx, timeline, word, color) {
  const { options } = timeline;
  const px = timeline.px * (word.scale || 1);
  const base = timeline.px;
  ctx.font = fontString(options, base);
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = color;
  ctx.textAlign = "left";
  if (options.direction === "rtl") ctx.direction = "rtl";
  // Тень для читаемости на светлом видео…
  ctx.shadowColor = "rgba(0, 0, 0, 0.55)";
  ctx.shadowBlur = px * 0.18;
  ctx.shadowOffsetY = px * 0.04;
  ctx.fillText(word.text, -word.width / 2, base * 0.34);
  // …и мягкое свечение цветом слова.
  const glow = clamp(options.glow, 0, 1);
  if (glow > 0) {
    ctx.shadowColor = word.accent ? hexToRgba(color, 0.7 * glow) : `rgba(255, 255, 255, ${0.5 * glow})`;
    ctx.shadowBlur = px * (word.accent ? 0.6 : 0.5) * glow;
    ctx.shadowOffsetY = 0;
    ctx.fillText(word.text, -word.width / 2, base * 0.34);
  }
}

const SPRITE_LIMIT = 48;

/**
 * Готовая картинка слова (с тенью и свечением) — рисуется один раз и потом
 * только переносится на кадр. Размытие теней на каждом кадре — самая тяжёлая
 * часть стиля; так предпросмотр и экспорт не тормозят. fx, fy — дробная часть
 * места слова на кадре, чтобы буквы легли в те же доли пикселя, что и без картинки.
 */
function wordSprite(timeline, word, color, fx, fy) {
  const cache = timeline.sprites || (timeline.sprites = new Map());
  const key = `${word.w}|${word.text}|${color}|${word.scale || 1}|${fx}|${fy}`;
  let sprite = cache.get(key);
  if (sprite) {
    cache.delete(key);
    cache.set(key, sprite);
    return sprite;
  }
  const size = word.scale || 1;
  const px = timeline.px * size;
  const glow = clamp(timeline.options.glow, 0, 1);
  const pad = Math.ceil(px * (0.3 + 0.75 * glow)) + 4;
  const left = Math.ceil((word.width * size) / 2) + pad;
  const top = Math.ceil(px * 1.1) + pad;
  const bottom = Math.ceil(px * 1.05) + pad;
  const canvas = makeCanvas(left * 2 + 1, top + bottom + 1);
  const sctx = canvas.getContext("2d");
  sctx.translate(left + fx, top + fy);
  sctx.scale(size, size);
  paintWord(sctx, timeline, word, color);
  sprite = { canvas, ox: left, oy: top };
  cache.set(key, sprite);
  if (cache.size > SPRITE_LIMIT) cache.delete(cache.keys().next().value);
  return sprite;
}

function drawWord(ctx, timeline, page, word, time) {
  const { options } = timeline;
  if (time < word.appear) return;
  const size = word.scale || 1;
  const px = timeline.px * size;
  const p = (time - word.appear) / options.wordIn;
  let alpha = easeOutCubic(p);
  let blur = (1 - easeOutCubic(p)) * px * 0.16;
  let scale = 1 + 0.2 * (1 - easeOutCubic(p));
  let rise = (1 - easeOutCubic(p)) * px * 0.08;
  if (time >= page.outroStart) {
    const q = (time - page.outroStart) / page.outroSeconds;
    alpha *= 1 - easeInCubic(q);
    blur += q * px * 0.2;
    scale *= 1 - 0.05 * q;
    rise -= q * px * 0.06;
  }
  if (alpha <= 0.002) return;
  const color = colorFor(timeline, word.accent);
  const cx = word.cx ?? word.x + (word.width * size) / 2;
  const cy = word.cy ?? word.baseline - px * 0.34;
  const outer = typeof ctx.getTransform === "function" ? ctx.getTransform() : null;
  const plain = outer && outer.a === 1 && outer.b === 0 && outer.c === 0 && outer.d === 1;
  if (!plain) {
    // Кадр рисуется в другом масштабе (редкий случай при экспорте) — слово
    // рисуется напрямую, чтобы не потерять резкость.
    ctx.save();
    ctx.translate(cx, cy + rise);
    ctx.scale(scale * size, scale * size);
    ctx.globalAlpha = alpha;
    if (blur > 0.4) ctx.filter = `blur(${blur.toFixed(1)}px)`;
    paintWord(ctx, timeline, word, color);
    ctx.restore();
    return;
  }
  // Место слова на кадре в пикселях: целая часть — куда переносить картинку,
  // дробная (с точностью 1/8 пикселя) уже учтена в самой картинке.
  const x = outer.e + cx;
  const y = outer.f + cy;
  const fx = Math.round((x - Math.floor(x)) * 8) / 8;
  const fy = Math.round((y - Math.floor(y)) * 8) / 8;
  const sprite = wordSprite(timeline, word, color, fx, fy);
  ctx.save();
  ctx.globalAlpha = alpha;
  if (scale === 1 && Math.abs(rise) < 0.01 && blur <= 0.4) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(sprite.canvas, Math.floor(x) - sprite.ox, Math.floor(y) - sprite.oy);
  } else {
    // Появление и уход: слово растёт, всплывает и размывается целиком.
    ctx.translate(cx, cy + rise);
    ctx.scale(scale, scale);
    if (blur > 0.4) ctx.filter = `blur(${blur.toFixed(1)}px)`;
    ctx.drawImage(sprite.canvas, -sprite.ox - fx, -sprite.oy - fy);
  }
  ctx.restore();
}

/** Рисует кадр стиля в момент `time` в прямоугольник кадра. */
export function drawPictureWords(ctx, timeline, time, dx = 0, dy = 0, dWidth = timeline.frameWidth, dHeight = timeline.frameHeight) {
  const page = pageAt(timeline, time);
  if (!page) return false;
  const { options, px, frameWidth, frameHeight } = timeline;
  ctx.save();
  ctx.translate(dx, dy);
  ctx.scale(dWidth / frameWidth, dHeight / frameHeight);
  // Картинки «за текстом» — первыми; картинка со слоем n ложится поверх n строк своей фразы.
  for (const picture of page.pictures) if (!picture.layer) drawPicture(ctx, timeline, page, picture, time);
  ctx.font = fontString(options, px);
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  page.phrases.forEach((phrase, pi) => {
    phrase.lines.forEach((line, li) => {
      for (const word of line.words) drawWord(ctx, timeline, page, word, time);
      for (const picture of page.pictures) {
        if (picture.phrase === pi && picture.layer === li + 1 && picture.layer < LAYER_FRONT) drawPicture(ctx, timeline, page, picture, time);
      }
    });
    for (const picture of page.pictures) {
      if (picture.phrase === pi && picture.layer > phrase.lines.length && picture.layer < LAYER_FRONT) drawPicture(ctx, timeline, page, picture, time);
    }
  });
  for (const picture of page.pictures) if (picture.layer >= LAYER_FRONT) drawPicture(ctx, timeline, page, picture, time);
  ctx.restore();
  return true;
}

// ---------------------------------------------------------------------------
// Экспорт и звуки

export class PictureFrameRenderer {
  constructor(cues, options) {
    this.cues = cues;
    this.options = options;
    this.timeline = null;
  }

  async open(_document, _styles, width, height) {
    await ensurePictureFont(this.options);
    const images = await preparedPictures(this.options.pictures);
    this.timeline = buildPictureTimeline(this.cues, width, height, { ...this.options, showPending: false }, images);
  }

  async getMaxTilesPerBatch() {
    return 12;
  }

  async getFrames(timestamps) {
    return timestamps.map((time) => {
      if (!this.timeline || !pageAt(this.timeline, time)) return null;
      return {
        draw: (ctx, dx, dy, dWidth, dHeight) => {
          drawPictureWords(ctx, this.timeline, time, dx, dy, dWidth, dHeight);
        },
      };
    });
  }

  close() {
    this.timeline = null;
  }
}

/** Моменты для звуков: фразы, слова, буквы; «ключевые» — появления картинок. */
export function soundMomentsFromPictures(timeline) {
  const moments = { phrases: [], words: [], letters: [], keywords: [] };
  for (const page of timeline?.pages || []) {
    for (const phrase of page.phrases) {
      const words = phrase.lines.flatMap((line) => line.words);
      if (words.length) moments.phrases.push({ time: words[0].appear });
      for (const word of words) {
        moments.words.push({ time: word.appear, keyword: Boolean(word.accent) });
        const chars = Array.from(cleanWord(word.text));
        const span = Math.min(Math.max(0.05, word.end - word.start), chars.length / 16);
        chars.forEach((_, i) => moments.letters.push({ time: word.appear + (span * i) / chars.length, wordStart: i === 0 }));
      }
    }
    for (const picture of page.pictures) moments.keywords.push({ time: picture.appear });
  }
  if (!moments.keywords.length) {
    for (const word of moments.words) if (word.keyword) moments.keywords.push({ time: word.time });
  }
  for (const list of Object.values(moments)) list.sort((a, b) => a.time - b.time);
  return moments;
}

export async function ensurePictureFont(options = PICTURE_DEFAULTS, text = "") {
  if (typeof document === "undefined" || !document.fonts) return;
  // Пример — с буквами самих субтитров (арабский и другие алфавиты), см. ensureTypewriterFont.
  const sample = `Слова с картинками Abc 0123 ${text}`;
  try {
    await document.fonts.load(`${options.fontWeight} 48px ${options.fontFamily}`, sample);
  } catch (_) { /* останется запасной шрифт */ }
  await document.fonts.ready;
}
