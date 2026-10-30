// Общая сборка ролика со стилем субтитров.
//
// Одни и те же функции работают в окне мастерской (сборка в браузере
// пользователя) и на сервере (Reel Lab открывает render.html в Chrome/Edge
// без экрана). Поэтому ролик из Telegram выглядит точно так же, как в
// предпросмотре на ПК.
import { GapFreeEffect, RenderPipelineBuilder, Tag, Tagger, VttTranscriber, WordlistTagger } from "./engine-api.js";
import { fontById, fontOverrideVars } from "./fonts-catalog.js";
import {
  TYPEWRITER_DEFAULTS,
  TypewriterFrameRenderer,
  buildTimeline,
  ensureTypewriterFont,
  keyStrikeTimes,
  textSample,
} from "./typewriter.js";
import {
  PICTURES_ID,
  PICTURE_DEFAULTS,
  PictureFrameRenderer,
  buildPictureTimeline,
  ensurePictureFont,
  preparedPictures,
  soundMomentsFromPictures,
} from "./picture-words.js";
import { hasActiveSound, hasAnyAudio, planMusic, planSoundEvents, renderSoundTrack, speechIntervals } from "./sfx.js";
import { TimeMap, effectsActive, setRenderEffects, sharedPersonMasker } from "./effects.js";
import { serializeCues } from "./subtitle-editor.js";

export const TYPEWRITER_ID = "typewriter-547";
export { PICTURES_ID };
const ASSET_ROOT = new URL("../vendor/tscaps/", import.meta.url);
const FONT_CSS_URL = new URL("./fonts.css", import.meta.url);
const EXTRA_FONT_CSS_URL = new URL("./fonts-extra.css", import.meta.url);
const ARABIC_FONT_CSS_URL = new URL("./fonts-arabic.css", import.meta.url);

function stageText(stage) {
  if (stage === "rendering") return "Собираю кадры";
  if (stage === "decoding") return "Читаю видео";
  if (stage === "encoding") return "Кодирую MP4";
  if (stage === "muxing") return "Сохраняю звук и видео";
  if (stage === "complete") return "Кадры готовы";
  return "Подготавливаю";
}

async function fetchText(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Не удалось загрузить компонент стиля (${response.status}).`);
  return response.text();
}

/**
 * Загружает все шрифты, которые упомянуты в CSS стиля, ДО разбиения на строки.
 * Движок меряет ширину строк через canvas: если шрифт ещё не загружен, он
 * меряет запасным (узким) шрифтом, и широкие стили вылезают за края кадра.
 */
export async function ensureFontsLoaded(cssText) {
  if (typeof document === "undefined" || !document.fonts) return;
  const families = new Set();
  for (const match of String(cssText).matchAll(/font-family\s*:([^;}]+)/gi)) {
    for (const name of match[1].matchAll(/["']([^"']+)["']/g)) families.add(name[1].trim().toLowerCase());
  }
  const sample = "АБВГДЕЁЖЗабвгдеёжз ABCabc 0123";
  const pending = [];
  const seen = new Set();
  for (const face of document.fonts) {
    const family = face.family.replace(/^["']|["']$/g, "").trim().toLowerCase();
    if (!families.has(family)) continue;
    seen.add(family);
    if (face.status !== "loaded") pending.push(face.load().catch(() => null));
  }
  for (const family of families) {
    if (seen.has(family)) continue;
    for (const weight of [400, 700]) pending.push(document.fonts.load(`${weight} 40px "${family}"`, sample).catch(() => null));
  }
  await Promise.all(pending);
  await document.fonts.ready;
}

const CAPACITY_SAMPLE = "Счастья тебе здоровья братское сердце будь всегда силён передаю привет каждому";

/**
 * Сколько символов помещается в одну фразу этого стиля (2 строки по 72 %
 * ширины кадра). Широкие жирные шрифты (Unbounded, Dela Gothic) вмещают
 * вдвое меньше узких — без этого длинная фраза вылезает за края кадра.
 */
export function segmentCapacity(templateCss, vars, videoSize, { maxLines = 2, widthRatio = 0.72 } = {}) {
  if (typeof document === "undefined" || !videoSize?.width || !videoSize?.height) return 40;
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:-99999px;top:0;visibility:hidden;pointer-events:none;";
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = String(templateCss).replace(/@font-face[^{]*\{[^}]*\}/g, "");
  const container = document.createElement("div");
  container.style.cssText = `container-type:size;width:${videoSize.width}px;height:${videoSize.height}px;`;
  for (const [key, value] of Object.entries(vars || {})) container.style.setProperty(key, value);
  const pin = (element) => {
    element.style.animationPlayState = "paused";
    element.style.animationDelay = "-1000s";
    element.style.animationFillMode = "both";
  };
  const segment = document.createElement("div");
  segment.className = "segment";
  const line = document.createElement("div");
  line.className = "line";
  [segment, line].forEach(pin);
  line.style.setProperty("display", "inline-block", "important");
  line.style.setProperty("white-space", "nowrap", "important");
  CAPACITY_SAMPLE.split(" ").forEach((text, index) => {
    if (index) line.append(" ");
    const word = document.createElement("span");
    word.className = "word";
    word.textContent = text;
    pin(word);
    line.append(word);
  });
  segment.append(line);
  container.append(segment);
  shadow.append(style, container);
  document.body.append(host);
  try {
    const width = line.offsetWidth;
    if (!width) return 40;
    const perChar = width / CAPACITY_SAMPLE.length;
    // 0.85 — запас на неровный перенос слов между строками.
    const capacity = Math.floor((maxLines * widthRatio * videoSize.width * 0.85) / perChar);
    return Math.max(8, Math.min(40, capacity));
  } finally {
    host.remove();
  }
}

export function normaliseHex(value, fallback) {
  return /^#[0-9A-Fa-f]{6}$/.test(String(value || "")) ? value : fallback;
}

export function keywordKey(text) {
  return String(text || "").toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}-]+/gu, "");
}

/** Все написания выбранных слов в тексте (готовые стили сравнивают слово целиком). */
export function keywordSpellings(cues, keywords) {
  const keys = new Set((keywords || []).map(keywordKey).filter(Boolean));
  const spellings = new Set();
  for (const cue of cues) for (const word of cue.words) if (keys.has(keywordKey(word.text))) spellings.add(word.text);
  return [...spellings];
}

export function typewriterOptionsFromSpec(spec) {
  const tw = spec.typewriter || {};
  const font = fontById(spec.font);
  return {
    ...TYPEWRITER_DEFAULTS,
    ...(font ? { fontFamily: `${font.family}, "Reel Typewriter", sans-serif`, fontWeight: font.weight } : {}),
    maxCharsPerSecond: Number(tw.maxCharsPerSecond) || TYPEWRITER_DEFAULTS.maxCharsPerSecond,
    softness: Number.isFinite(Number(tw.softness)) ? Number(tw.softness) : TYPEWRITER_DEFAULTS.softness,
    fontSize: Number(tw.fontSize) || TYPEWRITER_DEFAULTS.fontSize,
    cursor: tw.cursor === "|" ? "|" : tw.cursor === "" ? "" : "_",
    cursorBlink: tw.cursorBlink !== false,
    align: tw.align === "left" ? "left" : "center",
    outro: tw.outro === "fade" ? "fade" : "wave",
    keywords: spec.keywords || [],
    textColor: normaliseHex(spec.colors?.primary, "#ffffff"),
    highlightColor: normaliseHex(spec.colors?.highlight, "#f5c982"),
    verticalAlign: spec.alignment?.verticalAlign || TYPEWRITER_DEFAULTS.verticalAlign,
    verticalOffset: Number(spec.alignment?.verticalOffset ?? TYPEWRITER_DEFAULTS.verticalOffset),
    horizontalOffset: Math.min(1, Math.max(0, Number(spec.alignment?.horizontalOffset ?? 0.5))),
    direction: spec.textDirection === "rtl" ? "rtl" : "ltr",
  };
}

/** Правка композиции: { phrases: {w: {dx, dy, scale}}, lines: {...} } — только числа. */
function cleanLayout(layout) {
  const result = { phrases: {}, lines: {} };
  for (const kind of ["phrases", "lines"]) {
    for (const [key, value] of Object.entries(layout?.[kind] || {})) {
      if (!/^\d+$/.test(key) || !value || typeof value !== "object") continue;
      const dx = Number(value.dx) || 0;
      const dy = Number(value.dy) || 0;
      const scale = Number(value.scale) || 1;
      if (Math.abs(dx) < 1e-4 && Math.abs(dy) < 1e-4 && Math.abs(scale - 1) < 1e-3) continue;
      result[kind][key] = { dx, dy, scale };
    }
  }
  return result;
}

/** Настройки стиля «Слова с картинками» из задания сборки. */
export function picturesOptionsFromSpec(spec) {
  const pics = spec.pictures || {};
  const font = fontById(spec.font);
  const number = (value, fallback, min, max) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  return {
    ...PICTURE_DEFAULTS,
    ...(font ? { fontFamily: `${font.family}, "Rubik", sans-serif`, fontWeight: font.weight } : {}),
    fontSize: number(pics.fontSize, PICTURE_DEFAULTS.fontSize, 2, 14),
    textColor: normaliseHex(spec.colors?.primary, "#ffffff"),
    highlightColor: normaliseHex(spec.colors?.highlight, PICTURE_DEFAULTS.highlightColor),
    keywords: spec.keywords || [],
    accents: Array.isArray(pics.accents) ? pics.accents.filter((item) => Number.isInteger(item?.w)) : [],
    autoAccent: pics.autoAccent !== false,
    pictures: Array.isArray(pics.items)
      ? pics.items.filter((item) => Number.isInteger(item?.w) && typeof item.url === "string" && item.url).map((item) => ({
        w: item.w, url: item.url, dx: Number(item.dx) || 0, dy: Number(item.dy) || 0, scale: Number(item.scale) || 1,
        layer: Math.round(Number(item.layer) || 0),
      }))
      : [],
    layout: cleanLayout(pics.layout),
    direction: spec.textDirection === "rtl" ? "rtl" : "ltr",
    pictureBlend: pics.blend === "screen" ? "screen" : "cutout",
    pictureSize: number(pics.size, PICTURE_DEFAULTS.pictureSize, 0.15, 0.7),
    pictureOpacity: number(pics.opacity, PICTURE_DEFAULTS.pictureOpacity, 0.2, 1),
    stack: Math.round(number(pics.stack, PICTURE_DEFAULTS.stack, 1, 4)),
    glow: number(pics.glow, PICTURE_DEFAULTS.glow, 0, 1),
  };
}

/** Цвета, выбранные человеком, — как CSS-переменные для inline-стилей движка. */
export function colorVars(spec) {
  const primary = normaliseHex(spec.colors?.primary, "#ffffff");
  const highlight = normaliseHex(spec.colors?.highlight, "#f5c982");
  const vars = {
    "--tscaps-primary-color": primary,
    "--tscaps-highlight-color": highlight,
    "--tscaps-tag-color": highlight,
    "--tscaps-quote-color": highlight,
  };
  if (spec.styleId === "pastor") vars["--tscaps-behind-font-family"] = '"Anton"';
  return vars;
}

/** Все переменные стиля: цвета + выбранные шрифты. */
export function styleVars(spec) {
  return { ...colorVars(spec), ...fontOverrideVars(spec.font, spec.accentFont), ...(spec.extraVars || {}) };
}

// Слова, которые почти никогда не бывают ключевыми.
const STOP_WORDS = new Set(("это этот эта эти того тому такой такая также когда потому чтобы который которая которые "
  + "очень всегда сегодня сейчас просто только здесь вообще можно нужно будет будут было была были есть").split(" "));

/**
 * Для стилей с крупным ключевым словом: если человек не отметил ключевые
 * слова сам, в каждой фразе выделяется самое длинное содержательное слово.
 */
class AutoKeywordTagger extends Tagger {
  tag(document) {
    const sections = document.sections.map((section) => section.with({
      segments: section.segments.map((segment) => this.tagSegment(segment)),
    }));
    return document.with({ sections });
  }

  tagSegment(segment) {
    let best = null;
    let count = 0;
    for (const line of segment.lines) {
      for (const word of line.words) {
        count += 1;
        const clean = word.text.replace(/[^\p{L}\p{N}-]+/gu, "");
        if (Array.from(clean).length < 5 || STOP_WORDS.has(clean.toLowerCase())) continue;
        if (!best || Array.from(clean).length > best.length) best = { id: word.id, length: Array.from(clean).length };
      }
    }
    if (!best || count < 2) return segment;
    const emphasis = Tag.of("emphasis");
    return segment.with({
      lines: segment.lines.map((line) => line.with({
        words: line.words.map((word) => (word.id === best.id
          ? word.with({ semanticTags: new Set([...word.semanticTags, emphasis]) })
          : word)),
      })),
    });
  }
}

async function runPipeline(pipeline, onProgress, scale) {
  let lastPercent = -1;
  return pipeline.run((event) => {
    const current = event?.inner?.currentFrame;
    const total = event?.inner?.totalFrames;
    const innerPercent = Number(event?.inner?.percent);
    const calculated = Number.isFinite(innerPercent)
      ? innerPercent
      : (Number.isFinite(current) && Number.isFinite(total) && total > 0 ? (current / total) * 100 : null);
    if (event?.stage !== "rendering" || calculated === null || calculated >= lastPercent + 1 || calculated === 100) {
      lastPercent = calculated ?? lastPercent;
      const suffix = event?.stage === "rendering" && Number.isFinite(current) && Number.isFinite(total) ? ` ${current}/${total}` : "";
      onProgress?.(`${stageText(event?.stage)}…${suffix}`, calculated === null ? 8 : calculated * scale);
    }
  });
}

const DEFAULT_RENDERING = {
  splitWordsIntoLetters: false,
  videoFrame: { required: false, jpegQuality: 1 },
  padding: null,
  textDirection: "ltr",
};

/** Настройки рендера стиля поверх значений по умолчанию (videoFrame — вложенный объект). */
export function renderingFor(spec) {
  const extra = spec.rendering || {};
  return {
    ...DEFAULT_RENDERING,
    ...extra,
    // Арабский текст: движок сам раскладывает слова справа налево и не режет их на буквы.
    textDirection: spec.textDirection === "rtl" ? "rtl" : (extra.textDirection || DEFAULT_RENDERING.textDirection),
    videoFrame: { ...DEFAULT_RENDERING.videoFrame, ...(extra.videoFrame || {}) },
  };
}

/**
 * Поправки стилей для арабского текста. Разрядка (letter-spacing) рвёт связки
 * арабских букв — у арабского её нет. В «Вылете с размытием» слова влетают
 * со стороны, куда продолжается текст: справа налево — слева.
 */
function rtlStyleCss(spec) {
  if (spec.textDirection !== "rtl") return "";
  let css = "\n.segment, .segment * { letter-spacing: 0 !important; }\n";
  if (String(spec.customCss || "").includes("rl-karaoke")) {
    // Караоке справа налево: слово заливается с правого края.
    css += ".word { background-image: linear-gradient(270deg, var(--tscaps-highlight-color, #ffd400) 0 50%, var(--tscaps-primary-color, #ffffff) 50% 100%); background-position: 0 0; }\n"
      + "@keyframes rl-karaoke { 0% { background-position: 0 0; } 100% { background-position: 100% 0; } }\n"
      + ".word-already-narrated { background-position: 100% 0; }\n";
  }
  if (spec.styleId === "rush") {
    css += ".word { animation-name: rush-in-left !important; }\n.line + .line .word { animation-name: rush-in-right !important; }\n";
  }
  if (spec.styleId === "gild") {
    // Крупное слово стоит отдельной строкой. Справа налево движок кладёт слова
    // строки в порядке показа (слева направо), и без этого слова, сказанные до
    // крупного, оказывались под ним, а сказанные после — над ним.
    css += ".line { display: flex !important; flex-wrap: wrap; justify-content: center; align-items: baseline; }\n"
      + ".word.emphasis { flex-basis: 100%; }\n"
      + ".word.emphasis ~ .word { order: -1; }\n"
      + ".word:has(~ .word.emphasis) { order: 1; }\n";
  }
  return css;
}

/**
 * Язык субтитров для CSS: заглавные буквы по правилам языка. Стили пишут
 * капсом через text-transform, а без языка турецкое «bir» становится «BIR»
 * вместо «BİR». -webkit-locale — то же, что атрибут lang, но задаётся в CSS
 * (разметку кадра строит движок).
 */
function localeCss(spec) {
  const lang = String(spec.textLang || "").toLowerCase();
  if (!/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/.test(lang)) return "";
  return `\n.segment { -webkit-locale: "${lang}"; }\n`;
}

const cssCache = new Map();

/** CSS стиля: свой стиль из конструктора или файл шаблона. */
export async function styleCssFor(spec) {
  if (spec.customCss) return String(spec.customCss);
  const url = new URL(`templates/${encodeURIComponent(spec.styleId)}/style.build.css`, ASSET_ROOT);
  if (!cssCache.has(url.href)) cssCache.set(url.href, fetchText(url));
  return cssCache.get(url.href);
}

let fontCssPromise = null;
function allFontCss() {
  if (!fontCssPromise) {
    fontCssPromise = Promise.all([fetchText(FONT_CSS_URL), fetchText(EXTRA_FONT_CSS_URL), fetchText(ARABIC_FONT_CSS_URL).catch(() => "")])
      .then(([a, b, c]) => `${a}\n${b}\n${c}`);
  }
  return fontCssPromise;
}

/** «U+0400-045F, U+4??» → [[0x400, 0x45f], [0x400, 0x4ff]]. */
function parseUnicodeRange(text) {
  const ranges = [];
  for (const part of String(text).split(",")) {
    const match = /U\+([0-9A-F?]+)(?:-([0-9A-F]+))?/i.exec(part.trim());
    if (!match) continue;
    if (match[1].includes("?")) {
      ranges.push([parseInt(match[1].replace(/\?/g, "0"), 16), parseInt(match[1].replace(/\?/g, "F"), 16)]);
    } else {
      const from = parseInt(match[1], 16);
      ranges.push([from, match[2] ? parseInt(match[2], 16) : from]);
    }
  }
  return ranges;
}

function familiesIn(cssText) {
  const families = new Set();
  for (const match of String(cssText).matchAll(/font-family\s*:([^;}]+)/gi)) {
    for (const name of match[1].matchAll(/["']([^"']+)["']/g)) families.add(name[1].trim().toLowerCase());
  }
  return families;
}

/** Весь текст субтитров одной строкой — для подбора шрифтов. */
export function cuesText(cues) {
  return (cues || []).map((cue) => (cue.words || []).map((word) => word.text).join(" ")).join("\n");
}

/**
 * Только нужные ролику @font-face: семейства из CSS стиля и наборы символов,
 * которые есть в тексте (с заглавными — стили пишут капсом). Движок встраивает
 * каждый шрифт из CSS в каждый лист кадров data:-ссылкой, поэтому лишние
 * шрифты (арабские для русского текста, польские буквы для казахского) только
 * замедляют сборку.
 */
export function usedFontCss(fontCss, styleCss, text) {
  const families = familiesIn(styleCss);
  const source = String(text || "");
  let upper = source.toUpperCase();
  try {
    upper += source.toLocaleUpperCase("tr");
  } catch {
    // нет турецкой локали — хватит обычных заглавных
  }
  const codes = new Set();
  for (const char of `${source}${upper}${source.toLowerCase()} 0123456789.,!?…:;—–-«»"'()%+`) codes.add(char.codePointAt(0));
  const blocks = String(fontCss).match(/@font-face\s*\{[^}]*\}/g) || [];
  return blocks.filter((block) => {
    const family = /font-family\s*:\s*["']?([^"';}]+)["']?/i.exec(block)?.[1]?.trim().toLowerCase();
    if (!family || !families.has(family)) return false;
    const range = /unicode-range\s*:\s*([^;}]+)/i.exec(block)?.[1];
    if (!range) return true;
    const ranges = parseUnicodeRange(range);
    for (const code of codes) {
      if (ranges.some(([from, to]) => code >= from && code <= to)) return true;
    }
    return false;
  }).join("\n");
}

/**
 * Один и тот же конвейер движка для предпросмотра и для MP4: разбиение на
 * фразы и строки, ключевые слова, удержание фразы — всё совпадает.
 */
export async function buildStylePipeline(spec, video, videoSize, { knownSize = false } = {}) {
  // Без текста тоже собираем: монтаж, музыка, эффекты — просто без субтитров.
  const cues = spec.cues || [];
  // Текста нет — стиль не нужен (у «Печатной машинки» и «Картинок» его и нет в виде CSS).
  const [fontCss, templateCss] = await Promise.all([allFontCss(), cues.length ? styleCssFor(spec) : Promise.resolve("")]);
  const vars = styleVars(spec);
  const chosenFamilies = Object.entries(vars)
    .filter(([key]) => key.endsWith("font-family"))
    .map(([, value]) => `font-family: ${value};`)
    .join("\n");
  await ensureFontsLoaded(`${templateCss}\n${chosenFamilies}`);
  // «Длина фразы»: короткие фразы по 1–3 слова или длиннее обычного.
  const lengthFactor = { short: 0.45, normal: 1, long: 1.3 }[spec.phraseLength] || 1;
  const maxChars = Math.max(6, Math.round(segmentCapacity(templateCss, vars, videoSize) * lengthFactor));
  const neededFontCss = usedFontCss(fontCss, `${templateCss}\n${chosenFamilies}`, cuesText(cues));
  let builder = new RenderPipelineBuilder()
    .withInputVideo(video)
    .withTranscriber(new VttTranscriber(serializeCues(cues)))
    .withCss(`${neededFontCss}\n${templateCss}${rtlStyleCss(spec)}${localeCss(spec)}`)
    .withInlineStyles(vars)
    // Длина фразы под ширину шрифта: крупные стили показывают меньше слов за раз.
    .withDefaultSegmentSplitterConfig({ maxChars, minChars: Math.min(10, Math.max(2, Math.floor(maxChars / 2.5))) })
    .withAlignment(spec.alignment)
    .withRenderingConfig(renderingFor(spec))
    // Фраза не исчезает в тот же миг, когда прозвучало последнее слово:
    // держится до 0,7 с или до начала следующей фразы.
    .withEffects([new GapFreeEffect(() => true, 700)]);
  const spellings = keywordSpellings(cues, spec.keywords);
  if (spellings.length) builder = builder.withTaggers([new WordlistTagger("emphasis", spellings)]);
  else if (spec.autoKeywords) builder = builder.withTaggers([new AutoKeywordTagger()]);
  // Размер кадра уже известен (предпросмотр) — движку не нужно открывать сам файл, чтобы его узнать:
  // открытый из сохранённого проекта ролик идёт с сервера потоком, целиком его в браузере нет.
  if (knownSize && videoSize?.width && videoSize?.height) builder = builder.withOutputResolution(videoSize.width, videoSize.height);
  return { pipeline: builder.build(), templateCss, fontCss, vars, maxChars };
}

/** Готовый документ (фразы, строки, слова со временем) без сборки видео. */
export async function prepareStyleDocument(spec, video, videoSize) {
  const built = await buildStylePipeline(spec, video, videoSize, { knownSize: true });
  const { pipeline } = built;
  await pipeline.runTranscriptionStep();
  pipeline.runSegmentSplittingStep();
  await pipeline.runSemanticTaggingStep();
  pipeline.runEffectsStep();
  await pipeline.runLineSplittingStep();
  pipeline.runStructuralTaggingStep();
  const doc = pipeline.getDocument();
  return { ...built, doc, styles: pipeline.resolveStylesForDocument(doc) };
}

/** Моменты для звуков из документа движка: фразы, слова, буквы, ключевые слова. */
export function soundMomentsFromDocument(doc) {
  const moments = { phrases: [], words: [], letters: [], keywords: [] };
  for (const section of doc.sections) {
    for (const segment of section.segments) {
      if (segment.hidden) continue;
      moments.phrases.push({ time: segment.time.start });
      for (const line of segment.lines) {
        for (const word of line.words) {
          const start = word.time.start;
          const keyword = [...(word.semanticTags || [])].some((tag) => tag?.name === "emphasis");
          moments.words.push({ time: start, keyword });
          if (keyword) moments.keywords.push({ time: start });
          const chars = Array.from(String(word.text || "").replace(/[^\p{L}\p{N}]+/gu, ""));
          if (!chars.length) continue;
          // Буквы «печатаются» внутри слова, не быстрее 16 знаков в секунду.
          const span = Math.min(Math.max(0.05, word.time.end - start), chars.length / 16);
          chars.forEach((_, index) => moments.letters.push({ time: start + (span * index) / chars.length, wordStart: index === 0 }));
        }
      }
    }
  }
  for (const list of Object.values(moments)) list.sort((a, b) => a.time - b.time);
  return moments;
}

/** Моменты для звуков печатной машинки: настоящие удары клавиш по её таймлайну. */
export function soundMomentsFromTypewriter(timeline) {
  const moments = { phrases: [], words: [], letters: [], keywords: [] };
  for (const segment of timeline?.segments || []) {
    moments.phrases.push({ time: segment.firstTime });
    for (const char of segment.chars) {
      if (char.isSpace) continue;
      if (char.whole) {
        // Слово справа налево: удар клавиши на каждую набранную букву.
        char.times.forEach((time, k) => moments.letters.push({ time, wordStart: k === 0 }));
      } else moments.letters.push({ time: char.time, wordStart: char.wordStart });
      if (!char.wordStart) continue;
      moments.words.push({ time: char.time, keyword: Boolean(char.emphasis) });
      if (char.emphasis) moments.keywords.push({ time: char.time });
    }
  }
  return moments;
}

/** Вырезанные куски и обрезка: движок пропускает их сам (видео и звук). */
function applySkips(pipeline, skips) {
  if (!skips || skips.isEmpty()) return pipeline;
  const original = pipeline.buildRenderJob.bind(pipeline);
  pipeline.buildRenderJob = (document, styles) => ({ ...original(document, styles), skipRanges: skips.toEngine() });
  return pipeline;
}

/** Моменты звуков стиля плюс склейки и вставки (spec.cutMoments, время сборки). */
function withCuts(moments, spec) {
  const cuts = (spec?.cutMoments || []).filter(Number.isFinite).map((time) => ({ time }));
  return cuts.length ? { ...moments, cuts } : moments;
}

/** Моменты звуков переводятся во время готового ролика; вырезанные — выпадают. */
export function remapMoments(moments, skips) {
  if (!skips || skips.isEmpty()) return moments;
  const result = {};
  for (const [key, list] of Object.entries(moments)) {
    result[key] = list.filter((item) => !skips.isSkipped(item.time)).map((item) => ({ ...item, time: skips.toOutput(item.time) }));
  }
  return result;
}

/**
 * Собирает ролик. Возвращает { blob, sfx }: видео со стилем и дорожку
 * звуков (WAV), которую сервер сводит с голосом. Монтаж (обрезка,
 * вырезанные куски) и эффекты кадра берутся из spec.edit и spec.fx.
 */
export async function renderWithStyle(spec, video, options = {}) {
  const fx = spec.fx || null;
  const skips = new TimeMap(spec.edit?.skip || []);
  let masker = null;
  if (fx?.behind) {
    options.onProgress?.("Готовлю поиск человека в кадре…", 2);
    try {
      masker = await sharedPersonMasker();
    } catch (error) {
      console.warn("[reel-lab] текст за человеком недоступен", error);
    }
  }
  // Шрифт подписи должен быть загружен до первого кадра, иначе первые кадры уйдут запасным шрифтом.
  if (fx?.signature?.text && typeof document !== "undefined" && document.fonts) {
    try {
      await document.fonts.load(`${fx.signature.weight || 700} 48px ${fx.signature.font}`, fx.signature.text);
    } catch (_) { /* останется запасной шрифт */ }
  }
  // Шрифт водяного знака — до первого кадра.
  if (fx?.watermark && typeof document !== "undefined" && document.fonts) {
    try {
      await document.fonts.load('800 48px "Montserrat"', "Reel Lab Сделано в @_abcdefghijklmnopqrstuvwxyz0123456789");
    } catch (_) { /* останется запасной шрифт */ }
  }
  // Шрифт перевода второй строкой — тоже заранее, со всеми буквами перевода.
  if (fx?.translation?.cues?.length && typeof document !== "undefined" && document.fonts) {
    try {
      const sample = fx.translation.cues.map((cue) => cue.text).join(" ").slice(0, 4000);
      await document.fonts.load(`${fx.translation.weight || 600} 48px ${fx.translation.font || '"Montserrat"'}`, sample);
    } catch (_) { /* останется запасной шрифт */ }
  }
  // source — тот же файл: из него второй декодер берёт крайние кадры для переходов.
  setRenderEffects(effectsActive(fx) || masker ? fx : null, masker, { source: video });
  try {
    return await renderStyled(spec, video, { ...options, skips });
  } finally {
    setRenderEffects(null);
  }
}

async function renderStyled(spec, video, { videoSize, duration, onProgress, skips } = {}) {
  const cues = spec.cues || [];
  const outputLength = (length) => Math.max(0.5, length - (skips?.totalSkipped() || 0));

  if (spec.styleId === TYPEWRITER_ID && cues.length) {
    if (!videoSize?.width || !videoSize?.height) throw new Error("Не удалось прочитать размер кадра видео.");
    const fontCss = await allFontCss();
    const options = typewriterOptionsFromSpec(spec);
    await ensureTypewriterFont(options, textSample(cues));
    onProgress?.("Готовлю печатную машинку…", 5);
    const pipeline = new RenderPipelineBuilder()
      .withInputVideo(video)
      .withTranscriber(new VttTranscriber(serializeCues(cues)))
      .withCss(`${usedFontCss(fontCss, '.segment{font-family:"Reel Typewriter"}', cuesText(cues))}\n.segment{font-family:"Reel Typewriter",sans-serif;font-weight:500;font-size:${options.fontSize}cqh}`)
      .withSubtitleFrameRenderer(new TypewriterFrameRenderer(cues, options))
      .build();
    const result = await runPipeline(applySkips(pipeline, skips), onProgress, 0.85);
    if (!result?.blob) throw new Error("Сборка завершилась, но MP4 не получен.");
    const timeline = buildTimeline(cues, videoSize.width, videoSize.height, options);
    const length = outputLength(duration || timeline.segments.at(-1)?.visibleEnd || 1);
    const sfx = await soundTrackFor(spec, remapMoments(withCuts(soundMomentsFromTypewriter(timeline), spec), skips), length, onProgress);
    return { blob: result.blob, sfx };
  }

  if (spec.styleId === PICTURES_ID && cues.length) {
    if (!videoSize?.width || !videoSize?.height) throw new Error("Не удалось прочитать размер кадра видео.");
    const fontCss = await allFontCss();
    const options = picturesOptionsFromSpec(spec);
    await ensurePictureFont(options, textSample(cues));
    onProgress?.("Готовлю картинки…", 4);
    const images = await preparedPictures(options.pictures);
    const missing = options.pictures.filter((picture) => !images.has(picture.url)).length;
    if (missing) console.warn(`[reel-lab] ${missing} картинок не загрузились — ролик собирается без них`);
    const pipeline = new RenderPipelineBuilder()
      .withInputVideo(video)
      .withTranscriber(new VttTranscriber(serializeCues(cues)))
      .withCss(`${usedFontCss(fontCss, '.segment{font-family:"Rubik"}', cuesText(cues))}\n.segment{font-family:"Rubik",sans-serif;font-weight:800;font-size:${options.fontSize}cqh}`)
      .withSubtitleFrameRenderer(new PictureFrameRenderer(cues, options))
      .build();
    const result = await runPipeline(applySkips(pipeline, skips), onProgress, 0.85);
    if (!result?.blob) throw new Error("Сборка завершилась, но MP4 не получен.");
    const timeline = buildPictureTimeline(cues, videoSize.width, videoSize.height, options, images);
    const length = outputLength(duration || timeline.pages.at(-1)?.end || 1);
    const sfx = await soundTrackFor(spec, remapMoments(withCuts(soundMomentsFromPictures(timeline), spec), skips), length, onProgress);
    return { blob: result.blob, sfx };
  }

  onProgress?.("Создаю видеорендер…", 8);
  const { pipeline, maxChars } = await buildStylePipeline(spec, video, videoSize);
  console.info("[reel-lab] segment capacity", spec.styleId, spec.font || "default", maxChars);
  const result = await runPipeline(applySkips(pipeline, skips), onProgress, 0.92);
  if (!result?.blob) throw new Error("Сборка завершилась, но MP4 не получен.");
  const length = outputLength(duration || cues.at(-1)?.end || 1);
  const sfx = await soundTrackFor(spec, remapMoments(withCuts(soundMomentsFromDocument(pipeline.getDocument()), spec), skips), length, onProgress);
  return { blob: result.blob, sfx };
}

async function soundTrackFor(spec, moments, length, onProgress) {
  const clips = (spec.audioClips || []).filter((clip) => clip?.url && Number(clip.out) > Number(clip.in));
  if (!hasAnyAudio(spec.sound) && !clips.length) return null;
  onProgress?.("Готовлю звуки…", 94);
  const events = hasActiveSound(spec.sound) ? await planSoundEvents(moments, spec.sound) : [];
  // Свой текст (стихи нашида) — это и есть музыка: под его словами её не приглушаем.
  const speech = spec.lyrics ? { phrases: [], words: [], letters: [], keywords: [] } : moments;
  // Музыка идёт по готовому ролику (после склеек) и приглушается под голос и вставки со звуком.
  const music = planMusic(speech, spec.sound, length, spec.montage?.duck || []);
  // Музыка и звуки с ленты монтажа — там, куда их положили (время готового ролика).
  const clipPlan = clips.length ? { list: clips, speech: speechIntervals(speech, spec.montage?.duck || []) } : null;
  if (!events.length && !music && !clipPlan) return null;
  return renderSoundTrack(events, spec.sound, length, music, clipPlan);
}

/** Размер кадра и длительность — так, как их видит сам браузер. */
export function readVideoMeta(file) {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    const url = URL.createObjectURL(file);
    const done = (value, error) => {
      URL.revokeObjectURL(url);
      video.removeAttribute("src");
      if (error) reject(error); else resolve(value);
    };
    video.preload = "metadata";
    video.muted = true;
    video.onloadedmetadata = () => done({ width: video.videoWidth, height: video.videoHeight, duration: video.duration });
    video.onerror = () => done(null, new Error("Браузер не смог прочитать видео."));
    video.src = url;
  });
}
