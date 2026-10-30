// Конструктор своего стиля субтитров.
//
// Человек двигает понятные настройки (размер, обводка, подложка, как
// появляются слова, чем выделено активное слово), а здесь из них собирается
// CSS-шаблон для движка — тот же формат, что у готовых стилей. Поэтому свой
// стиль видно в живом предпросмотре и он так же собирается в MP4.

export const CUSTOM_ID = "custom";

export const BUILDER_DEFAULTS = {
  name: "Мой стиль",
  fontSize: 4.4,
  weight: 700,
  textCase: "none",
  letterSpacing: 0.01,
  lineHeight: 1.14,
  outlineWidth: 0,
  outlineColor: "#000000",
  shadow: "soft",
  background: "none",
  bgColor: "#0b0b0f",
  bgOpacity: 0.6,
  radius: 0.4,
  active: "color",
  dimFuture: false,
  wordIn: "rise",
  phraseIn: "none",
  phraseOut: "fade",
  speed: 0.34,
  emphasisScale: 1.08,
};

export const BUILDER_PRESETS = [
  {
    id: "clean",
    label: "Чистый",
    values: { fontSize: 4.2, weight: 600, textCase: "none", shadow: "soft", background: "none", active: "color", wordIn: "fade", phraseIn: "none", phraseOut: "fade", outlineWidth: 0 },
    colors: { primary: "#ffffff", highlight: "#ffd76a" },
    font: "montserrat",
  },
  {
    id: "karaoke-fill",
    label: "Караоке",
    values: { fontSize: 4.8, weight: 800, textCase: "none", shadow: "strong", background: "none", active: "karaoke", wordIn: "none", phraseIn: "fade", phraseOut: "fade", outlineWidth: 0.04, outlineColor: "#000000", lineHeight: 1.22 },
    colors: { primary: "#ffffff", highlight: "#ffd400" },
    font: "montserrat",
  },
  {
    id: "karaoke",
    label: "Караоке-плашка",
    values: { fontSize: 4.6, weight: 800, textCase: "uppercase", shadow: "strong", background: "none", active: "pill", wordIn: "pop", phraseIn: "none", phraseOut: "fade", outlineWidth: 0 },
    colors: { primary: "#ffffff", highlight: "#ffd400" },
    font: "montserrat",
  },
  {
    id: "bold",
    label: "Жирный акцент",
    values: { fontSize: 5.6, weight: 800, textCase: "uppercase", shadow: "strong", outlineWidth: 0.07, outlineColor: "#000000", background: "none", active: "scale", wordIn: "zoom", phraseIn: "none", phraseOut: "drop", letterSpacing: 0 },
    colors: { primary: "#ffffff", highlight: "#b6ff3b" },
    font: "rubik",
  },
  {
    id: "cinema",
    label: "Кинотитр",
    values: { fontSize: 3.1, weight: 500, textCase: "uppercase", letterSpacing: 0.16, shadow: "soft", background: "none", active: "none", wordIn: "blur", phraseIn: "fade", phraseOut: "blur", speed: 0.6 },
    colors: { primary: "#f4efe6", highlight: "#f4efe6" },
    font: "jura",
  },
  {
    id: "plate",
    label: "Плашка",
    values: { fontSize: 3.9, weight: 700, textCase: "none", shadow: "none", background: "box", bgColor: "#111114", bgOpacity: 0.72, radius: 0.35, active: "underline", wordIn: "none", dimFuture: true, phraseIn: "rise", phraseOut: "fade" },
    colors: { primary: "#ffffff", highlight: "#ff5c8a" },
    font: "montserrat",
  },
  {
    id: "letters",
    label: "Буква за буквой",
    values: { fontSize: 4.6, weight: 700, textCase: "none", shadow: "glow", background: "none", active: "glow", wordIn: "letters", phraseIn: "none", phraseOut: "blur", speed: 0.4 },
    colors: { primary: "#ffffff", highlight: "#8fe3ff" },
    font: "unbounded",
  },
];

export const BUILDER_OPTIONS = {
  textCase: [["none", "Как написано"], ["uppercase", "ВСЕ ЗАГЛАВНЫЕ"]],
  shadow: [["none", "Нет"], ["soft", "Мягкая"], ["strong", "Плотная"], ["glow", "Свечение"]],
  background: [["none", "Нет"], ["box", "Плашка"], ["glass", "Матовое стекло"], ["band", "Полоса"]],
  active: [["none", "Нет"], ["color", "Цветом"], ["karaoke", "Караоке (заливка)"], ["pill", "Плашкой"], ["underline", "Подчёркиванием"], ["scale", "Увеличением"], ["glow", "Свечением"]],
  wordIn: [["none", "Сразу всё"], ["fade", "Проявление"], ["rise", "Снизу вверх"], ["pop", "Хлопок"], ["zoom", "Из крупного"], ["blur", "Из размытия"], ["slide", "Слева"], ["drop", "Сверху с отскоком"], ["letters", "По буквам"], ["typewriter", "Печать"]],
  phraseIn: [["none", "Нет"], ["fade", "Проявление"], ["rise", "Снизу"], ["scale", "Увеличение"]],
  phraseOut: [["none", "Нет"], ["fade", "Растворение"], ["drop", "Вниз"], ["blur", "В размытие"]],
};

const clampNumber = (value, min, max, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
};

const hex = (value, fallback) => (/^#[0-9a-fA-F]{6}$/.test(String(value || "")) ? value : fallback);

function rgba(hexColor, alpha) {
  const value = hex(hexColor, "#000000");
  const r = parseInt(value.slice(1, 3), 16);
  const g = parseInt(value.slice(3, 5), 16);
  const b = parseInt(value.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${Math.round(alpha * 1000) / 1000})`;
}

function pick(value, list, fallback) {
  return list.some(([id]) => id === value) ? value : fallback;
}

/** Значения конструктора, приведённые к допустимым. */
export function normaliseBuilder(raw = {}) {
  const v = { ...BUILDER_DEFAULTS, ...raw };
  return {
    name: String(v.name || BUILDER_DEFAULTS.name).slice(0, 40),
    fontSize: clampNumber(v.fontSize, 2.4, 8, BUILDER_DEFAULTS.fontSize),
    weight: Math.round(clampNumber(v.weight, 300, 900, 700) / 100) * 100,
    textCase: pick(v.textCase, BUILDER_OPTIONS.textCase, "none"),
    letterSpacing: clampNumber(v.letterSpacing, -0.04, 0.3, 0.01),
    lineHeight: clampNumber(v.lineHeight, 0.9, 1.6, 1.14),
    outlineWidth: clampNumber(v.outlineWidth, 0, 0.14, 0),
    outlineColor: hex(v.outlineColor, "#000000"),
    shadow: pick(v.shadow, BUILDER_OPTIONS.shadow, "soft"),
    background: pick(v.background, BUILDER_OPTIONS.background, "none"),
    bgColor: hex(v.bgColor, "#0b0b0f"),
    bgOpacity: clampNumber(v.bgOpacity, 0, 1, 0.6),
    radius: clampNumber(v.radius, 0, 1.4, 0.4),
    active: pick(v.active, BUILDER_OPTIONS.active, "color"),
    dimFuture: Boolean(v.dimFuture),
    wordIn: pick(v.wordIn, BUILDER_OPTIONS.wordIn, "rise"),
    phraseIn: pick(v.phraseIn, BUILDER_OPTIONS.phraseIn, "none"),
    phraseOut: pick(v.phraseOut, BUILDER_OPTIONS.phraseOut, "fade"),
    speed: clampNumber(v.speed, 0.12, 1.2, 0.34),
    emphasisScale: clampNumber(v.emphasisScale, 1, 1.6, 1.08),
  };
}

function outlineShadows(width, color) {
  if (!(width > 0)) return [];
  const steps = 16;
  const shadows = [];
  for (let i = 0; i < steps; i += 1) {
    const angle = (i / steps) * Math.PI * 2;
    shadows.push(`${(Math.cos(angle) * width).toFixed(4)}em ${(Math.sin(angle) * width).toFixed(4)}em 0 ${color}`);
  }
  return shadows;
}

function shadowLayers(kind) {
  if (kind === "soft") return ["0 0.05em 0.18em rgba(0, 0, 0, 0.55)"];
  if (kind === "strong") return ["0 0.06em 0 rgba(0, 0, 0, 0.6)", "0 0.1em 0.3em rgba(0, 0, 0, 0.75)"];
  if (kind === "glow") return ["0 0 0.25em color-mix(in srgb, var(--tscaps-highlight-color, #ffffff) 70%, transparent)", "0 0 0.7em color-mix(in srgb, var(--tscaps-highlight-color, #ffffff) 45%, transparent)"];
  return [];
}

/** Для светлой плашки — тёмный текст, для тёмной — светлый. */
function readableOn(hexColor) {
  const value = hex(hexColor, "#ffd400");
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16) / 255);
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.55 ? "#111111" : "#ffffff";
}

const WORD_IN = {
  fade: "0% { opacity: 0; } 100% { opacity: 1; }",
  rise: "0% { opacity: 0; transform: translateY(0.45em); } 100% { opacity: 1; transform: none; }",
  pop: "0% { opacity: 0; transform: scale(0.4); } 55% { opacity: 1; transform: scale(1.14); } 100% { opacity: 1; transform: none; }",
  zoom: "0% { opacity: 0; transform: scale(2.1); filter: blur(0.06em); } 100% { opacity: 1; transform: none; filter: none; }",
  blur: "0% { opacity: 0; transform: scale(1.12); filter: blur(0.28em); } 100% { opacity: 1; transform: none; filter: none; }",
  slide: "0% { opacity: 0; transform: translateX(-0.7em); } 100% { opacity: 1; transform: none; }",
  drop: "0% { opacity: 0; transform: translateY(-0.8em); } 60% { opacity: 1; transform: translateY(0.08em); } 80% { transform: translateY(-0.03em); } 100% { opacity: 1; transform: none; }",
};

/** Собирает CSS-шаблон для движка из настроек конструктора. */
export function buildCustomCss(raw) {
  const v = normaliseBuilder(raw);
  const speed = v.speed.toFixed(3);
  const lead = 0.04;
  const textShadows = [...outlineShadows(v.outlineWidth, v.outlineColor), ...shadowLayers(v.shadow)];
  const segmentAnimations = [];
  const css = [];
  css.push(`@charset "UTF-8";`, `/* Свой стиль Reel Lab: ${v.name.replace(/\*\//g, "")} */`);

  if (v.phraseIn !== "none") segmentAnimations.push(`rl-phrase-in ${Math.max(0.2, v.speed).toFixed(3)}s var(--on-segment-starts) cubic-bezier(0.2, 0.8, 0.25, 1) both`);
  if (v.phraseOut !== "none") segmentAnimations.push(`rl-phrase-out 0.26s calc(var(--on-segment-ends) - 0.26s) cubic-bezier(0.6, 0, 0.8, 0.4) forwards`);

  const box = v.background === "box" || v.background === "glass";
  css.push(`.segment {
  font-family: var(--tscaps-font-family, "Montserrat");
  font-weight: ${v.weight};
  font-size: calc(${v.fontSize}cqh * var(--tscaps-font-size-scale, 1));
  line-height: ${v.lineHeight};
  text-align: center;
  text-transform: ${v.textCase};
  letter-spacing: ${v.letterSpacing}em;
  color: var(--tscaps-primary-color, #ffffff);
  position: relative;${box ? `
  display: inline-block;
  isolation: isolate;
  overflow: hidden;
  padding: 0.34em 0.7em 0.38em;
  border-radius: ${v.radius}em;` : ""}${v.background === "box" ? `
  background: ${rgba(v.bgColor, v.bgOpacity)};
  box-shadow: 0 0.3em 0.9em -0.3em rgba(0, 0, 0, 0.5);` : ""}${v.background === "glass" ? `
  box-shadow: 0 0.45em 1.3em -0.4em rgba(0, 0, 0, 0.45);` : ""}${segmentAnimations.length ? `
  animation: ${segmentAnimations.join(", ")};` : ""}
}`);

  if (v.background === "glass") {
    css.push(`.tscaps-video-frame-layer { filter: blur(0.9cqh) saturate(1.45) brightness(0.92); transform: scale(1.06); z-index: -3; }
.segment::before {
  content: ""; position: absolute; inset: 0; border-radius: inherit; z-index: -2; pointer-events: none;
  background: radial-gradient(120% 90% at 18% -10%, rgba(255, 255, 255, 0.34) 0%, rgba(255, 255, 255, 0) 55%),
    linear-gradient(180deg, ${rgba(v.bgColor === "#0b0b0f" ? "#ffffff" : v.bgColor, Math.min(0.5, v.bgOpacity * 0.35))} 0%, ${rgba(v.bgColor === "#0b0b0f" ? "#ffffff" : v.bgColor, Math.min(0.4, v.bgOpacity * 0.22))} 100%);
}
.segment::after {
  content: ""; position: absolute; inset: 0; border-radius: inherit; z-index: -1; pointer-events: none;
  box-shadow: inset 0 0.045em 0 rgba(255, 255, 255, 0.5), inset 0 -0.045em 0 rgba(0, 0, 0, 0.16), inset 0 0 0 0.03em rgba(255, 255, 255, 0.22);
}`);
  }

  if (v.background === "band") {
    css.push(`.line {
  display: block;
  width: fit-content;
  margin: 0 auto;
  padding: 0.06em 0.32em 0.1em;
  background: ${rgba(v.bgColor, v.bgOpacity)};
  border-radius: ${Math.min(v.radius, 0.3)}em;
}
.line + .line { margin-top: 0.08em; }`);
  } else {
    css.push(`.line { display: block; }`);
  }

  const wordAnimations = [];
  if (WORD_IN[v.wordIn]) {
    css.push(`@keyframes rl-word-in { ${WORD_IN[v.wordIn]} }`);
    wordAnimations.push(`rl-word-in ${speed}s calc(var(--on-word-being-narrated-starts) - ${lead}s) cubic-bezier(0.2, 0.8, 0.25, 1) both`);
  } else if (v.dimFuture) {
    css.push(`@keyframes rl-word-on { 0% { opacity: 0.45; } 100% { opacity: 1; } }`);
    wordAnimations.push(`rl-word-on 0.25s var(--on-word-being-narrated-starts) ease-out both`);
  }

  // Караоке: слово заливается цветом акцента слева направо, пока его поют (справа налево — у арабского,
  // см. render-core). Текст «прозрачный» с фоном по буквам, поэтому тень — через drop-shadow.
  const karaoke = v.active === "karaoke";
  const karaokeShadows = [
    ...(v.outlineWidth > 0 ? [0, 1, 2, 3].map((i) => {
      const angle = (i / 4) * Math.PI * 2 + Math.PI / 4;
      return `drop-shadow(${(Math.cos(angle) * v.outlineWidth * 0.7).toFixed(4)}em ${(Math.sin(angle) * v.outlineWidth * 0.7).toFixed(4)}em 0 ${v.outlineColor})`;
    }) : []),
    v.shadow === "none" ? "" : v.shadow === "glow" ? "drop-shadow(0 0 0.22em color-mix(in srgb, var(--tscaps-highlight-color, #ffd400) 60%, transparent))"
      : v.shadow === "strong" ? "drop-shadow(0 0.06em 0.05em rgba(0, 0, 0, 0.75)) drop-shadow(0 0.1em 0.3em rgba(0, 0, 0, 0.6))"
        : "drop-shadow(0 0.05em 0.16em rgba(0, 0, 0, 0.6))",
  ].filter(Boolean);
  css.push(`.word {
  display: inline-block;
  margin: 0 0.12em;
  border-radius: 0.2em;${textShadows.length && !karaoke ? `
  text-shadow: ${textShadows.join(", ")};` : ""}${karaoke ? `
  background-image: linear-gradient(90deg, var(--tscaps-highlight-color, #ffd400) 0 50%, var(--tscaps-primary-color, #ffffff) 50% 100%);
  background-size: 200% 100%;
  background-repeat: no-repeat;
  background-position: 100% 0;
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  -webkit-text-fill-color: transparent;${karaokeShadows.length ? `
  filter: ${karaokeShadows.join(" ")};` : ""}` : ""}${wordAnimations.length ? `
  animation: ${wordAnimations.join(", ")};` : ""}
}`);

  if (v.wordIn === "letters" || v.wordIn === "typewriter") {
    const letterIn = v.wordIn === "letters"
      ? "0% { opacity: 0; transform: translateY(0.35em) scale(0.6); filter: blur(0.08em); } 100% { opacity: 1; transform: none; filter: none; }"
      : "0% { opacity: 0; } 100% { opacity: 1; }";
    const timing = v.wordIn === "letters" ? "cubic-bezier(0.2, 0.8, 0.25, 1)" : "steps(1, start)";
    const duration = v.wordIn === "letters" ? speed : "0.02";
    css.push(`@keyframes rl-letter-in { ${letterIn} }
.letter {
  display: inline-block;
  animation: rl-letter-in ${duration}s calc(var(--on-word-being-narrated-starts) - ${lead}s + var(--letter-index, 0) * min(0.045s, var(--word-being-narrated-duration, 0.3s) / var(--letter-count, 6))) ${timing} both;
}`);
  }

  const activeColor = "var(--tscaps-highlight-color, #ffd400)";
  if (karaoke) {
    css.push(`@keyframes rl-karaoke { 0% { background-position: 100% 0; } 100% { background-position: 0 0; } }
.word-being-narrated { animation: ${wordAnimations.length ? `${wordAnimations.join(", ")}, ` : ""}rl-karaoke var(--word-being-narrated-duration, 0.3s) var(--on-word-being-narrated-starts) linear both; }
.word-already-narrated { background-position: 0 0; }`);
  } else if (v.active === "color") {
    css.push(`.word-being-narrated { color: ${activeColor}; }`);
  } else if (v.active === "pill") {
    css.push(`.word-being-narrated {
  color: var(--rl-pill-text, ${readableOn("#ffd400")});
  background: ${activeColor};
  box-shadow: 0 0 0 0.1em ${activeColor}, 0 0.12em 0.4em rgba(0, 0, 0, 0.35);
  text-shadow: none;
}`);
  } else if (v.active === "underline") {
    css.push(`@keyframes rl-underline { 0% { background-size: 0% 0.11em; } 100% { background-size: 100% 0.11em; } }
.word-being-narrated {
  background-image: linear-gradient(${activeColor}, ${activeColor});
  background-repeat: no-repeat;
  background-position: 0 100%;
  background-size: 100% 0.11em;
}
.word-being-narrated { animation: ${wordAnimations.length ? `${wordAnimations.join(", ")}, ` : ""}rl-underline var(--word-being-narrated-duration, 0.3s) var(--on-word-being-narrated-starts) linear both; }`);
  } else if (v.active === "scale") {
    css.push(`@keyframes rl-active-scale { 0% { transform: scale(1); } 40% { transform: scale(1.2); } 100% { transform: scale(1.12); } }
.word-being-narrated { color: ${activeColor}; animation: ${wordAnimations.length ? `${wordAnimations.join(", ")}, ` : ""}rl-active-scale 0.28s var(--on-word-being-narrated-starts) cubic-bezier(0.2, 0.8, 0.3, 1) both; }`);
  } else if (v.active === "glow") {
    css.push(`.word-being-narrated { color: ${activeColor}; text-shadow: ${[...outlineShadows(v.outlineWidth, v.outlineColor), `0 0 0.3em ${activeColor}`, `0 0 0.8em color-mix(in srgb, var(--tscaps-highlight-color, #ffd400) 60%, transparent)`].join(", ")}; }`);
  }

  css.push(karaoke
    ? `.emphasis, .accent, .entity { font-family: var(--tscaps-accent-font-family, var(--tscaps-font-family, "Montserrat")); font-size: ${v.emphasisScale}em; }`
    : `.emphasis, .accent, .entity { color: ${activeColor}; font-family: var(--tscaps-accent-font-family, var(--tscaps-font-family, "Montserrat")); font-size: ${v.emphasisScale}em; }`);

  if (v.phraseIn === "fade") css.push(`@keyframes rl-phrase-in { 0% { opacity: 0; } 100% { opacity: 1; } }`);
  if (v.phraseIn === "rise") css.push(`@keyframes rl-phrase-in { 0% { opacity: 0; transform: translateY(0.5em); } 100% { opacity: 1; transform: none; } }`);
  if (v.phraseIn === "scale") css.push(`@keyframes rl-phrase-in { 0% { opacity: 0; transform: scale(0.85); } 100% { opacity: 1; transform: none; } }`);
  if (v.phraseOut === "fade") css.push(`@keyframes rl-phrase-out { 0% { opacity: 1; } 100% { opacity: 0; } }`);
  if (v.phraseOut === "drop") css.push(`@keyframes rl-phrase-out { 0% { opacity: 1; transform: none; } 100% { opacity: 0; transform: translateY(0.6em); } }`);
  if (v.phraseOut === "blur") css.push(`@keyframes rl-phrase-out { 0% { opacity: 1; filter: none; } 100% { opacity: 0; filter: blur(0.2em); transform: scale(1.06); } }`);

  return css.join("\n\n");
}

/** Текст на плашке активного слова — читаемый на выбранном цвете акцента. */
export function builderVars(raw, highlight) {
  const v = normaliseBuilder(raw);
  return v.active === "pill" ? { "--rl-pill-text": readableOn(highlight) } : {};
}

/** Настройки рендера: стеклу нужен кадр видео, печати по буквам — буквы. */
export function builderRendering(raw) {
  const v = normaliseBuilder(raw);
  const rendering = {};
  if (v.wordIn === "letters" || v.wordIn === "typewriter") rendering.splitWordsIntoLetters = true;
  if (v.background === "glass") rendering.videoFrame = { required: true, jpegQuality: 0.82 };
  return Object.keys(rendering).length ? rendering : null;
}

// --- сохранённые стили (в этом браузере) -----------------------------------

const STORAGE_KEY = "reel-lab.custom-styles.v1";

export function loadSavedStyles() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter((item) => item && item.id && item.values) : [];
  } catch (_) {
    return [];
  }
}

export function saveStyles(list) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, 40)));
    return true;
  } catch (_) {
    return false;
  }
}
