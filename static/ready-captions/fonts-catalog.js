// Шрифты, которые можно выбрать для любого стиля. У всех, кроме арабских, есть
// кириллица; арабские буквы есть у всех (fonts-arabic.css). Все лежат в проекте
// (fonts.css, fonts-extra.css, fonts-arabic.css), лицензии — SIL OFL.
// weight — начертание, в котором шрифт выглядит лучше всего в субтитрах.
// accentScaleX — сжатие по ширине для крупного акцентного слова
// (Poiret One сжат так же, как шрифт в референсе IMG_6068).

export const FONT_CHOICES = [
  { id: "poiret", label: "Poiret One · ар-деко", family: '"Poiret One"', weight: 400, accentScaleX: 0.78 },
  { id: "advent", label: "Advent Pro · узкий", family: '"Advent Pro"', weight: 500 },
  { id: "sofia", label: "Sofia Sans Extra Condensed · очень узкий", family: '"Sofia Sans Extra Condensed"', weight: 500 },
  { id: "jura", label: "Jura · технический", family: '"Jura"', weight: 600 },
  { id: "montserrat", label: "Montserrat · современный", family: '"Montserrat"', weight: 600 },
  { id: "unbounded", label: "Unbounded · широкий", family: '"Unbounded"', weight: 700 },
  { id: "dela", label: "Dela Gothic One · жирный", family: '"Dela Gothic One"', weight: 400 },
  { id: "russo", label: "Russo One · спортивный", family: '"Russo One"', weight: 400 },
  { id: "rubik", label: "Rubik · округлый жирный", family: '"Rubik"', weight: 800 },
  { id: "comfortaa", label: "Comfortaa · мягкий (д и т рукописные)", family: '"Comfortaa"', weight: 700 },
  { id: "lobster", label: "Lobster · рукописный", family: '"Lobster"', weight: 400 },
  { id: "oswald", label: "Oswald · узкий плакатный", family: '"Anton"', weight: 700 },
  { id: "inter", label: "Inter · нейтральный", family: '"Reel Typewriter"', weight: 500 },
  { id: "playfair", label: "Playfair Display · с засечками", family: '"Playfair Display Variable"', weight: 700 },
  { id: "garamond", label: "EB Garamond · книжный", family: '"EB Garamond Variable"', weight: 500 },
  { id: "caveat", label: "Caveat · от руки", family: '"Kalam"', weight: 700 },
  // Для арабских субтитров (без кириллицы: русский текст в них — запасным шрифтом).
  { id: "cairo", label: "Cairo · арабский современный", family: '"Cairo"', weight: 700, arabic: true },
  { id: "lalezar", label: "Lalezar · арабский плакатный", family: '"Lalezar"', weight: 400, arabic: true },
  { id: "changa", label: "Changa · арабский технический", family: '"Changa"', weight: 600, arabic: true },
  { id: "reemkufi", label: "Reem Kufi · арабский куфи", family: '"Reem Kufi"', weight: 600, arabic: true },
  // Арабская каллиграфия — для нашидов, аятов и цитат.
  { id: "amiri", label: "Amiri · насх, как в Коране", family: '"Amiri"', weight: 700, arabic: true },
  { id: "scheherazade", label: "Scheherazade · книжный насх", family: '"Scheherazade New"', weight: 700, arabic: true },
  { id: "arefruqaa", label: "Aref Ruqaa · рукъа", family: '"Aref Ruqaa"', weight: 700, arabic: true },
  { id: "katibeh", label: "Katibeh · каллиграфия для заголовков", family: '"Katibeh"', weight: 400, arabic: true },
  { id: "qahiri", label: "Qahiri · куфи каирский", family: '"Qahiri"', weight: 400, arabic: true },
  { id: "mirza", label: "Mirza · мягкий насх", family: '"Mirza"', weight: 700, arabic: true },
  { id: "elmessiri", label: "El Messiri · современный с каллиграфией", family: '"El Messiri"', weight: 600, arabic: true },
  { id: "rakkas", label: "Rakkas · жирный плакатный", family: '"Rakkas"', weight: 400, arabic: true },
];

export function fontById(id) {
  return FONT_CHOICES.find((font) => font.id === id) || null;
}

/**
 * CSS-переменные, которыми готовые стили берут выбранный шрифт.
 * Передаются движку как inline-стили (withInlineStyles): правила `:root`
 * движок ограничивает своим классом, и они перестают действовать.
 */
export function fontOverrideVars(fontId, accentId) {
  const main = fontById(fontId);
  const accent = fontById(accentId);
  const vars = {};
  if (main) {
    vars["--tscaps-font-family"] = main.family;
    vars["--tscaps-font-weight"] = String(main.weight);
  }
  if (accent) {
    vars["--tscaps-accent-font-family"] = accent.family;
    vars["--tscaps-accent-font-weight"] = String(accent.weight);
    vars["--tscaps-accent-scale-x"] = String(accent.accentScaleX ?? 1);
    vars["--tscaps-tag-font-family"] = accent.family;
    vars["--tscaps-tag-font-weight"] = String(accent.weight);
  }
  return vars;
}

/** То же самое в виде CSS-правила — для обычных страниц (предпросмотр). */
export function fontOverrideCss(fontId, accentId, selector = ":root") {
  const vars = fontOverrideVars(fontId, accentId);
  const body = Object.entries(vars).map(([key, value]) => `${key}: ${value};`).join(" ");
  return body ? `${selector} { ${body} }` : "";
}

export function fontOptionsHtml(selectedId, defaultLabel = "Как в стиле") {
  const escape = (value) => String(value).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const option = (font) => `<option value="${font.id}"${font.id === selectedId ? " selected" : ""} style="font-family:${escape(font.family)};font-weight:${font.weight}">${escape(font.label)}</option>`;
  const groups = [
    ["Русский и латиница", FONT_CHOICES.filter((font) => !font.arabic)],
    ["Арабский", FONT_CHOICES.filter((font) => font.arabic && !CALLIGRAPHY.has(font.id))],
    ["Арабская каллиграфия", FONT_CHOICES.filter((font) => CALLIGRAPHY.has(font.id))],
  ];
  return [`<option value="">${escape(defaultLabel)}</option>`,
    ...groups.map(([label, fonts]) => `<optgroup label="${escape(label)}">${fonts.map(option).join("")}</optgroup>`)].join("");
}

const CALLIGRAPHY = new Set(["amiri", "scheherazade", "arefruqaa", "katibeh", "qahiri", "mirza", "elmessiri", "rakkas"]);

/** Шрифт только с арабскими буквами (русский текст в нём — запасным шрифтом). */
export function isArabicFont(id) {
  return Boolean(fontById(id)?.arabic);
}
