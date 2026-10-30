// Reel Lab — студия субтитров.
//
// Видео → текст (распознавание или SRT) → стиль → живой предпросмотр со
// звуком → сборка MP4. Всё, что видно и слышно в предпросмотре, строится
// тем же кодом, что и готовый ролик.
import { buildTimeline, drawTypewriter, ensureTypewriterFont, parseCues, segmentAt, textSample } from "./typewriter.js";
import {
  ADJUST_DEFAULTS,
  LOOKS,
  sharedPersonMasker,
  PreviewPersonMasker,
  TimeMap,
  cssFilterFor,
  drawCameraFrame,
  drawPersonLayer,
  drawPost,
  drawUnderlays,
  lookById,
  overlaysActive,
  overlaysFor,
  scanFaces,
  signatureLayout,
  skipRangesFor,
  translationLayout,
} from "./effects.js";
import {
  ACCENT_ORDER,
  ACCENT_PALETTE,
  PICTURES_ID,
  LAYER_FRONT,
  buildPictureTimeline,
  compositionAt,
  drawPictureWords,
  ensurePictureFont,
  flatWords,
  pageAt,
  picturePhrases,
  pictureRectsAt,
  preparePicture,
  preparedPictures,
  soundMomentsFromPictures,
} from "./picture-words.js";
import { renderEditor, resegmentCues, serializeCues } from "./subtitle-editor.js";
import { gluedToPrevious } from "./bidi.js";
import {
  TYPEWRITER_ID,
  keywordKey,
  picturesOptionsFromSpec,
  remapMoments,
  renderWithStyle,
  soundMomentsFromDocument,
  soundMomentsFromTypewriter,
  typewriterOptionsFromSpec,
} from "./render-core.js";
import { fontById, fontOptionsHtml, isArabicFont } from "./fonts-catalog.js";
import { MONTAGE_PRESETS, presetById } from "./presets.js";
import { keepAlignmentSafe, rectUnsafe, safePlatform } from "./safe-zones.js";
import {
  applyMe, closePaywall, closeToChat, downloadFile, drawAccountChip, guardClose, haptic, openPaywall, paywallOpen,
  refreshMe, server, setBackAction, startServerMode, syncBackButton, toast, uploadInChunks,
} from "./server-mode.js";
import { StylePreview } from "./live-preview.js";
import {
  MUSIC_DEFAULTS,
  SOUND_LAYERS,
  SoundPlayer,
  clipPeaks,
  loadClipBuffer,
  speechIntervals,
  hasActiveSound,
  hasMusic,
  kitSettings,
  loadSoundCuration,
  loadSoundManifest,
  planMusic,
  planSoundEvents,
  reloadOwnSounds,
  resolveSoundId,
  sameSound,
  setSoundCuration,
  styleSounds,
} from "./sfx.js";
import { SoundBoard } from "./sound-board.js";
import { createAssistant } from "./assistant-ui.js";
import { installDialogFallback } from "./dialog-fallback.js";
import { SoundClipEditor } from "./sound-clip.js";
import { ComposeEditor } from "./compose-editor.js";
import { MIN_CLIP, SELF_MEDIA, SPEEDS, buildMontage, clipSpeed, coverRange, revealRange, snapInsertPoint } from "./montage.js";
import { beatsForUrl, beatsInVideo, cachedBeats, nearestBeat } from "./beats.js";
import { RHYTHMS, cutPoints, energyAtFactory, pickLength, planShots } from "./beat-montage.js";
import { MontagePlayer, drawFitted } from "./montage-player.js";
import { MontageTimeline } from "./timeline.js";
import { alignWordsToVocal, cuesToLyrics, lyricLines, lyricsFromTaps, spreadLyrics } from "./lyrics.js";
import {
  PreviewFrameGrabber, TRANSITIONS, TRANSITION_SPEEDS, drawTransition, junctionsOf, normaliseTransitions, planTransitions, transitionAt,
  transitionById, transitionFor, transitionsNear,
} from "./transitions.js";
import {
  RemoteVideo, dropLocalCopy, loadLocalCopy, newProjectId, sameVideoFile, saveLocalCopy, summaryText, uploadFileUrl, whenText,
} from "./projects.js";
import {
  BUILDER_DEFAULTS,
  BUILDER_OPTIONS,
  BUILDER_PRESETS,
  CUSTOM_ID,
  buildCustomCss,
  builderRendering,
  builderVars,
  loadSavedStyles,
  normaliseBuilder,
  saveStyles,
} from "./style-builder.js";

const ASSET_ROOT = "/vendor/tscaps";

// Звуки стилей по умолчанию: [звук, громкость]. Главный источник — наборы
// стилей в библиотеке (manifest.json → styles); этот список нужен, пока
// библиотека грузится, и совпадает с первым набором каждого стиля.
const SOUND_PRESETS = {
  [TYPEWRITER_ID]: { typing: ["typewriter", 0.7] },
  // Мягкий поп на каждое слово и «вжух», когда появляется картинка.
  [PICTURES_ID]: { word: ["fs_pop", 0.25], accent: ["fs_whoosh", 0.5] },
  gild: { word: ["fs_coin", 0.25], accent: ["fs_coin_shimmer", 0.45] },
  rush: { word: ["fs_snap", 0.25], phrase: ["fs_whoosh", 0.55] },
  stardust: { word: ["fs_sparkle", 0.3], phrase: ["fs_gleam", 0.35] },
  // Треск электричества повторяет то, как слово моргает при загорании.
  neon: { word: ["neonflick", 0.6] },
  chrome: { word: ["metal_ping", 0.25], phrase: ["fs_metal_whoosh", 0.45], accent: ["metal_hit", 0.5] },
  enzo: { word: ["fs_pop", 0.35] },
  selene: { word: ["fs_drop", 0.3], phrase: ["fs_wind", 0.35] },
  [CUSTOM_ID]: { word: ["fs_pop", 0.35] },
};

const TYPEWRITER_TEMPLATE = {
  id: TYPEWRITER_ID,
  label_ru: "Печатная машинка",
  note_ru: "Печать в такт голосу, курсор у последней буквы, звук клавиш",
  layout: { verticalAlign: "bottom", verticalOffset: 0.8 },
  style_controls: [
    { id: "primary-color", default: "#ffffff" },
    { id: "highlight-color", default: "#f5c982" },
  ],
};

const PICTURES_TEMPLATE = {
  id: PICTURES_ID,
  label_ru: "Слова с картинками",
  note_ru: "ИИ подсвечивает слова по смыслу и рисует к ним картинки",
  layout: { verticalAlign: "center", verticalOffset: 0.5 },
  style_controls: [
    { id: "primary-color", default: "#ffffff" },
    { id: "highlight-color", default: "#ffc94a" },
  ],
  isNew: true,
};

// Караоке: слово заливается цветом, пока его поют. Это готовый «свой стиль» (детали можно менять).
const KARAOKE_ID = "karaoke";
const KARAOKE_TEMPLATE = {
  id: KARAOKE_ID,
  label_ru: "Караоке",
  note_ru: "Слово заливается цветом, пока его поют — для песен и нашидов",
  layout: { verticalAlign: "bottom", verticalOffset: 0.8 },
  style_controls: [
    { id: "primary-color", default: "#ffffff" },
    { id: "highlight-color", default: "#ffd400" },
  ],
  badge: "Новое",
};
const KARAOKE_PRESET = BUILDER_PRESETS.find((item) => item.id === "karaoke-fill");

const CUSTOM_TEMPLATE = {
  id: CUSTOM_ID,
  label_ru: "Свой стиль",
  note_ru: "Собери из готовых деталей: шрифт, подложка, анимация, акцент",
  layout: { verticalAlign: "bottom", verticalOffset: 0.78 },
  style_controls: [
    { id: "primary-color", default: "#ffffff" },
    { id: "highlight-color", default: "#ffd76a" },
  ],
};

// --- Подпись поверх видео ----------------------------------------------------

const SIGNATURE_KEY = "reellab.signature";
const SIGNATURE_PLACES = {
  top: { x: 0.5, y: 0.06 },
  bottom: { x: 0.5, y: 0.94 },
  "top-left": { x: 0, y: 0 },
  "bottom-right": { x: 1, y: 1 },
};
const SAFE_KEY = "reellab.safe";

const TRANSITIONS_KEY = "reellab.transitions";

/** Общий выбор переходов запоминается для следующих роликов; свои переходы стыков — только в проекте. */
function loadTransitions() {
  try {
    return { ...normaliseTransitions(JSON.parse(localStorage.getItem(TRANSITIONS_KEY) || "null")), custom: {} };
  } catch (_) {
    return normaliseTransitions(null);
  }
}

function saveTransitions() {
  const { clip, cut, speed, edges } = state.transitions;
  try { localStorage.setItem(TRANSITIONS_KEY, JSON.stringify({ clip, cut, speed, edges })); } catch (_) { /* не запомнится — не страшно */ }
}

function loadSafe() {
  try {
    const saved = JSON.parse(localStorage.getItem(SAFE_KEY) || "null");
    if (saved && typeof saved === "object") return { keep: true, platform: "all", ...saved, show: Boolean(saved.show) };
  } catch (_) { /* браузер не хранит — по умолчанию */ }
  return { show: false, keep: true, platform: "all" };
}

function saveSafe() {
  try { localStorage.setItem(SAFE_KEY, JSON.stringify(state.safe)); } catch (_) { /* не запомнится — не страшно */ }
}

const SECOND_LINE_KEY = "reellab.secondLine";
const SECOND_DEFAULTS = { x: 0.5, y: 0.86, size: 1, color: "#ffffff", look: "shadow", font: "", opacity: 1, placed: false };

function loadSecondStyle() {
  try {
    const saved = JSON.parse(localStorage.getItem(SECOND_LINE_KEY) || "null");
    if (saved && typeof saved === "object") return { ...SECOND_DEFAULTS, ...saved };
  } catch (_) { /* браузер не хранит — оформление по умолчанию */ }
  return { ...SECOND_DEFAULTS };
}

function saveSecondStyle() {
  try { localStorage.setItem(SECOND_LINE_KEY, JSON.stringify(state.translation.secondStyle)); } catch (_) { /* не запомнится — не страшно */ }
}

const SIGNATURE_COLORS = ["#ffffff", "#f5c982", "#ffd23f", "#7cf3c8", "#b9a9ff", "#ff5c7a", "#111111"];

function signatureDefaults() {
  return { show: false, text: "", x: 0.5, y: 0.94, size: 1, color: "#ffffff", opacity: 0.9, font: "montserrat", look: "shadow" };
}

function loadSignature() {
  try {
    const saved = JSON.parse(localStorage.getItem(SIGNATURE_KEY) || "null");
    return { ...signatureDefaults(), ...(saved && typeof saved === "object" ? saved : {}) };
  } catch (_) {
    return signatureDefaults();
  }
}

function saveSignature() {
  try { localStorage.setItem(SIGNATURE_KEY, JSON.stringify(state.signature)); } catch (_) { /* не запомнится — не страшно */ }
}

/** Подпись для кадра (null — не показывать). */
function signatureSpec() {
  const sig = state.signature;
  const text = String(sig.text || "").trim();
  if (!sig.show || !text) return null;
  const font = fontById(sig.font) || fontById("montserrat");
  return { text, x: sig.x, y: sig.y, size: sig.size, color: sig.color, opacity: sig.opacity, look: sig.look, font: font.family, weight: font.weight };
}

const state = {
  manifest: null,
  video: null,
  videoUrl: null,
  videoSize: null,
  duration: 0,
  cues: [],
  subtitlesAreTest: false,
  keywords: [],
  styleId: TYPEWRITER_ID,
  perStyle: {},
  builders: { [CUSTOM_ID]: { ...BUILDER_DEFAULTS, ...BUILDER_PRESETS[0].values } },
  builderPreset: { [CUSTOM_ID]: BUILDER_PRESETS[0].id },
  savedStyles: loadSavedStyles(),
  typewriter: { maxCharsPerSecond: 18, softness: 0.55, cursor: "_", cursorBlink: true, align: "center", outro: "wave" },
  voice: 1,
  soundOn: true,
  // Звуки, убранные на доске прослушивания (не показываются в студии).
  soundRemoved: new Set(),
  // Музыка на фон — одна на ролик, не зависит от стиля субтитров.
  music: { ...MUSIC_DEFAULTS },
  playing: false,
  preview: { timeline: null, kind: null, images: null, moments: null, events: [], ready: false },
  // Стиль «Слова с картинками»: план ИИ (цвета слов и картинки) и настройки.
  pictures: {
    density: "medium",
    look: "cinema",
    blend: "cutout",
    size: 0.36,
    opacity: 0.94,
    stack: 3,
    plan: null,
    busy: false,
    run: 0,
    label: "",
    note: "",
    autoStarted: "",
    uploadFor: null,
    // Правка композиции человеком: сдвиг и масштаб фраз и строк (ключ — номер первого слова).
    layout: { phrases: {}, lines: {} },
  },
  ai: { configured: false, provider: "free", account_hint: "", source: null },
  // Монтаж (время исходного видео): обрезка и вырезанные куски.
  // auto — паузы найдены умным монтажом; manual — куски, вырезанные человеком на ленте.
  edit: { trimStart: 0, trimEnd: null, cuts: [], aiCuts: [], manual: [], auto: false, strength: "normal", voice: { clean: false, level: false }, enhance: { stabilize: false, denoise: false, sharpen: false }, busy: false },
  // Вставки других видео между кусками, видео поверх и разрезы (время исходника).
  // audios — музыка и звуки на ленте: { id, url, name, duration, o (начало в ролике), in, out, volume, duck, fade }.
  montage: { inserts: [], overlays: [], splits: [], audios: [], media: new Map(), open: false, selection: null, version: 0, seq: 0 },
  // Эффекты кадра.
  // zoomEdits — правка зумов человеком: off — убранные зумы ИИ, on — свои зумы ({ w, scale }); w — номер слова.
  fx: { look: "none", adjust: { ...ADJUST_DEFAULTS }, zoom: "off", zoomEdits: { off: [], on: [] }, followFace: false, faces: [], facesFor: "", scanning: false, jumpZoom: true, shake: false, flash: false, behind: false },
  // Переходы на стыках: между видео (clip), на склейках (cut), свои для отдельных стыков (custom), плавные начало и конец.
  transitions: loadTransitions(),
  hook: { busy: false, data: null, text: "", show: false },
  // Подпись поверх видео (ник, канал): запоминается в браузере для следующих роликов.
  signature: loadSignature(),
  moments: { busy: false, list: [], length: "30-60" },
  // mode: «second» — перевод второй строкой под субтитрами, «replace» — вместо текста.
  translation: { busy: false, original: null, language: null, mode: "second", second: null, secondStyle: loadSecondStyle(), autoY: null },
  // Язык речи, на котором распознан текст (null — текст из файла).
  speechLanguage: null,
  // Аккаунт в боте: тариф, сколько роликов осталось, нужен ли водяной знак.
  account: { plan: "local", watermark: false, handle: "" },
  // Безопасные зоны площадок: показать на видео, не пускать туда субтитры.
  safe: loadSafe(),
  // Готовый монтаж: выбранная карточка и шаги ИИ, которые ждут текста.
  preset: null,
  pendingMagic: [],
  mode: "simple",
  csrf: null,
  rendering: false,
  resultBlob: null,
  resultUrl: null,
  uploadId: null,
  transcription: { busy: false, csrf: null, jobId: null, controller: null, run: 0 },
  // Есть ли в видео звук (узнаём при загрузке) и почему не получилось распознать — для подсказки в карточке.
  videoHasAudio: null,
  speechError: "",
  // Шкала текста: "S" — речь исходного видео (по умолчанию), "O" — свой текст по времени готового ролика
  // (стихи нашида): он идёт поверх всего ролика, и через вставки тоже.
  cuesBase: "S",
};

// Старые телефоны без <dialog>: окна студии работают через простую замену.
installDialogFallback();

const $ = (selector) => document.querySelector(selector);
const el = {
  browserWarning: $("#browserWarning"),
  fileChip: $("#fileChip"),
  fileChipText: $("#fileChipText"),
  exportButton: $("#exportButton"),
  screen: $("#screen"),
  video: $("#video"),
  twCanvas: $("#twCanvas"),
  captionHost: $("#captionHost"),
  dropZone: $("#dropZone"),
  screenHint: $("#screenHint"),
  loadingVeil: $("#loadingVeil"),
  playButton: $("#playButton"),
  timeNow: $("#timeNow"),
  timeTotal: $("#timeTotal"),
  ribbon: $("#ribbon"),
  ribbonTrack: $("#ribbonTrack"),
  playhead: $("#playhead"),
  soundToggle: $("#soundToggle"),
  montageToggle: $("#montageToggle"),
  montageMedia: $("#montageMedia"),
  timelinePanel: $("#timelinePanel"),
  tlBar: document.querySelector(".tl-bar"),
  tlHost: $("#tlHost"),
  tlInfo: $("#tlInfo"),
  tlNote: $("#tlNote"),
  clipInput: $("#clipInput"),
  openTimeline: $("#openTimeline"),
  simpleTimeline: $("#simpleTimeline"),
  aiReport: $("#aiReport"),
  aiReportPro: $("#aiReportPro"),
  exportPanel: $("#exportPanel"),
  exportLabel: $("#exportLabel"),
  exportPercent: $("#exportPercent"),
  exportFill: $("#exportFill"),
  exportResult: $("#exportResult"),
  resultTitle: $("#resultTitle"),
  resultMeta: $("#resultMeta"),
  resultWatch: $("#resultWatch"),
  downloadButton: $("#downloadButton"),
  exportError: $("#exportError"),
  resultDialog: $("#resultDialog"),
  resultVideo: $("#resultVideo"),
  tabs: [...document.querySelectorAll(".tab")],
  panels: [...document.querySelectorAll(".panel")],
  videoInput: $("#videoInput"),
  srtInput: $("#srtInput"),
  transcribeButton: $("#transcribeButton"),
  srtButton: $("#srtButton"),
  testTextButton: $("#testTextButton"),
  demoButton: $("#demoButton"),
  demoLink: $("#demoLink"),
  transcription: $("#transcription"),
  transcriptionLabel: $("#transcriptionLabel"),
  transcriptionFill: $("#transcriptionFill"),
  cancelTranscription: $("#cancelTranscription"),
  sourceNote: $("#sourceNote"),
  translateMode: $("#translateMode"),
  secondLineOptions: $("#secondLineOptions"),
  secondLook: $("#secondLook"),
  secondColors: $("#secondColors"),
  secondFont: $("#secondFont"),
  secondSize: $("#secondSize"),
  secondSizeValue: $("#secondSizeValue"),
  secondRemove: $("#secondRemove"),
  speechLangs: [...document.querySelectorAll("[data-speech-lang]")],
  speechNote: $("#speechNote"),
  editorBlock: $("#editorBlock"),
  editorCounter: $("#editorCounter"),
  keywordSummary: $("#keywordSummary"),
  cueList: $("#cueList"),
  styleGrid: $("#styleGrid"),
  customGrid: $("#customGrid"),
  styleCounter: $("#styleCounter"),
  tuneTitle: $("#tuneTitle"),
  resetTune: $("#resetTune"),
  fontSelect: $("#fontSelect"),
  accentFontField: $("#accentFontField"),
  accentFontSelect: $("#accentFontSelect"),
  primaryColor: $("#primaryColor"),
  highlightColor: $("#highlightColor"),
  sizeScale: $("#sizeScale"),
  sizeScaleValue: $("#sizeScaleValue"),
  positionSeg: $("#positionSeg"),
  heightSlider: $("#heightSlider"),
  heightValue: $("#heightValue"),
  phraseLengthField: $("#phraseLengthField"),
  phraseLengthSeg: $("#phraseLengthSeg"),
  typewriterBlock: $("#typewriterBlock"),
  twSpeed: $("#twSpeed"),
  twSpeedValue: $("#twSpeedValue"),
  twSoft: $("#twSoft"),
  twSoftValue: $("#twSoftValue"),
  twCursorSeg: $("#twCursorSeg"),
  twBlink: $("#twBlink"),
  twAlignSeg: $("#twAlignSeg"),
  twOutroSeg: $("#twOutroSeg"),
  builderBlock: $("#builderBlock"),
  builderPresets: $("#builderPresets"),
  builderControls: $("#builderControls"),
  builderName: $("#builderName"),
  builderSave: $("#builderSave"),
  builderSaved: $("#builderSaved"),
  soundLayers: $("#soundLayers"),
  soundKits: $("#soundKits"),
  musicChoose: $("#musicChoose"),
  simpleMusic: $("#simpleMusic"),
  musicName: $("#musicName"),
  musicListen: $("#musicListen"),
  musicClear: $("#musicClear"),
  musicControls: $("#musicControls"),
  musicVolume: $("#musicVolume"),
  musicVolumeValue: $("#musicVolumeValue"),
  musicDuck: $("#musicDuck"),
  musicDuckValue: $("#musicDuckValue"),
  musicStart: $("#musicStart"),
  musicStartValue: $("#musicStartValue"),
  soundNote: $("#soundNote"),
  soundPanel: document.querySelector('[data-panel="sound"]'),
  openSoundBoard: $("#openSoundBoard"),
  simpleSound: $("#simpleSound"),
  simpleKits: $("#simpleKits"),
  resetSound: $("#resetSound"),
  voiceVolume: $("#voiceVolume"),
  voiceValue: $("#voiceValue"),
  serverRender: $("#serverRender"),
  aiKeyButton: $("#aiKeyButton"),
  undoButton: $("#undoButton"),
  redoButton: $("#redoButton"),
  draftButton: $("#draftButton"),
  draftCount: $("#draftCount"),
  assistantKey: $("#assistantKey"),
  assistantButton: $("#assistantButton"),
  assistantEmpty: $("#assistantEmpty"),
  aiKeyText: $("#aiKeyText"),
  aiBadge: $("#aiBadge"),
  aiBadgeText: $("#aiBadgeText"),
  picturesBlock: $("#picturesBlock"),
  layoutReset: $("#layoutReset"),
  picturesCount: $("#picturesCount"),
  aiNotice: $("#aiNotice"),
  aiNoticeButton: $("#aiNoticeButton"),
  picturesRun: $("#picturesRun"),
  picturesProgress: $("#picturesProgress"),
  picturesLabel: $("#picturesLabel"),
  picturesStop: $("#picturesStop"),
  picturesFill: $("#picturesFill"),
  picturesNote: $("#picturesNote"),
  picDensitySeg: $("#picDensitySeg"),
  picLookSeg: $("#picLookSeg"),
  picBlendSeg: $("#picBlendSeg"),
  picSize: $("#picSize"),
  picSizeValue: $("#picSizeValue"),
  picOpacity: $("#picOpacity"),
  picOpacityValue: $("#picOpacityValue"),
  picStackSeg: $("#picStackSeg"),
  picturesList: $("#picturesList"),
  pictureInput: $("#pictureInput"),
  aiDialog: $("#aiDialog"),
  aiClose: $("#aiClose"),
  aiAccount: $("#aiAccount"),
  aiToken: $("#aiToken"),
  aiTokenShow: $("#aiTokenShow"),
  aiStatus: $("#aiStatus"),
  aiSave: $("#aiSave"),
  aiDelete: $("#aiDelete"),
  fxCanvas: $("#fxCanvas"),
  personCanvas: $("#personCanvas"),
  postCanvas: $("#postCanvas"),
  trimInfo: $("#trimInfo"),
  trimStartBtn: $("#trimStartBtn"),
  trimEndBtn: $("#trimEndBtn"),
  trimReset: $("#trimReset"),
  cutsInfo: $("#cutsInfo"),
  cutStrengthSeg: $("#cutStrengthSeg"),
  smartCutRun: $("#smartCutRun"),
  smartCutNote: $("#smartCutNote"),
  cutList: $("#cutList"),
  momentsBlock: $("#momentsBlock"),
  momentLenSeg: $("#momentLenSeg"),
  momentsRun: $("#momentsRun"),
  momentsNote: $("#momentsNote"),
  momentList: $("#momentList"),
  voiceClean: $("#voiceClean"),
  voiceLevel: $("#voiceLevel"),
  lookGrid: $("#lookGrid"),
  fxReset: $("#fxReset"),
  autoEnhance: $("#autoEnhance"),
  adjustControls: $("#adjustControls"),
  atmoBlock: $("#atmoBlock"),
  atmoReset: $("#atmoReset"),
  atmoPresets: $("#atmoPresets"),
  atmoControls: $("#atmoControls"),
  simpleAtmo: $("#simpleAtmo"),
  simpleAtmoChips: $("#simpleAtmoChips"),
  zoomSeg: $("#zoomSeg"),
  followFace: $("#followFace"),
  faceNote: $("#faceNote"),
  jumpZoom: $("#jumpZoom"),
  fxShake: $("#fxShake"),
  fxFlash: $("#fxFlash"),
  fxBehind: $("#fxBehind"),
  enhanceStabilize: $("#enhanceStabilize"),
  enhanceDenoise: $("#enhanceDenoise"),
  enhanceSharpen: $("#enhanceSharpen"),
  hookBlock: $("#hookBlock"),
  hookRun: $("#hookRun"),
  hookNote: $("#hookNote"),
  hookResult: $("#hookResult"),
  hookText: $("#hookText"),
  hookShow: $("#hookShow"),
  sigShow: $("#sigShow"),
  audioInput: $("#audioInput"),
  audioToTimeline: $("#audioToTimeline"),
  tlVolume: $("#tlVolume"),
  tlVolumeInput: $("#tlVolumeInput"),
  tlVolumeValue: $("#tlVolumeValue"),
  simpleSig: $("#simpleSig"),
  sigText: $("#sigText"),
  sigOptions: $("#sigOptions"),
  sigPlace: $("#sigPlace"),
  sigLook: $("#sigLook"),
  sigColors: $("#sigColors"),
  sigFont: $("#sigFont"),
  sigSize: $("#sigSize"),
  sigSizeValue: $("#sigSizeValue"),
  sigOpacity: $("#sigOpacity"),
  sigOpacityValue: $("#sigOpacityValue"),
  hookDesc: $("#hookDesc"),
  hookTags: $("#hookTags"),
  translateBlock: $("#translateBlock"),
  translateLang: $("#translateLang"),
  translateRun: $("#translateRun"),
  translateNote: $("#translateNote"),
  inspector: document.querySelector(".inspector"),
  simplePanel: $("#simplePanel"),
  stepSource: $("#stepSource"),
  stepSourceNote: $("#stepSourceNote"),
  simpleSourceActions: $("#simpleSourceActions"),
  simplePick: $("#simplePick"),
  simpleDemo: $("#simpleDemo"),
  simpleProgress: $("#simpleProgress"),
  simpleProgressLabel: $("#simpleProgressLabel"),
  simpleProgressFill: $("#simpleProgressFill"),
  simpleTextReady: $("#simpleTextReady"),
  simpleTextCount: $("#simpleTextCount"),
  simpleEditText: $("#simpleEditText"),
  simpleSrt: $("#simpleSrt"),
  simpleTranslate: $("#simpleTranslate"),
  simpleNoText: $("#simpleNoText"),
  simpleTranscribe: $("#simpleTranscribe"),
  simpleNoTextMore: $("#simpleNoTextMore"),
  simpleSrtEmpty: $("#simpleSrtEmpty"),
  simpleLyrics: $("#simpleLyrics"),
  simpleLyricsEdit: $("#simpleLyricsEdit"),
  lyricsButton: $("#lyricsButton"),
  lyricsDialog: $("#lyricsDialog"),
  lyricsText: $("#lyricsText"),
  lyricsSpan: $("#lyricsSpan"),
  lyricsClose: $("#lyricsClose"),
  lyricsTapStart: $("#lyricsTapStart"),
  lyricsTranslateBox: $("#lyricsTranslateBox"),
  lyricsTranslation: $("#lyricsTranslation"),
  lyricsTranslationCount: $("#lyricsTranslationCount"),
  lyricsSpread: $("#lyricsSpread"),
  lyricsTap: $("#lyricsTap"),
  lyricsTapLine: $("#lyricsTapLine"),
  lyricsTapCount: $("#lyricsTapCount"),
  lyricsTapNext: $("#lyricsTapNext"),
  lyricsTapDone: $("#lyricsTapDone"),
  lyricsTapCancel: $("#lyricsTapCancel"),
  stepExportNote: $("#stepExportNote"),
  stepStyle: $("#stepStyle"),
  stepPreset: $("#stepPreset"),
  safeOverlay: $("#safeOverlay"),
  safeToggle: $("#safeToggle"),
  safePlatformSeg: $("#safePlatformSeg"),
  safeKeep: $("#safeKeep"),
  safeShow: $("#safeShow"),
  safeNote: $("#safeNote"),
  presetStrip: $("#presetStrip"),
  presetGrid: $("#presetGrid"),
  presetCounter: $("#presetCounter"),
  presetNote: $("#presetNote"),
  presetNotePro: $("#presetNotePro"),
  simpleStyleGrid: $("#simpleStyleGrid"),
  simpleTune: $("#simpleTune"),
  stepMagic: $("#stepMagic"),
  magicRun: $("#magicRun"),
  magicChips: $("#magicChips"),
  magicNote: $("#magicNote"),
  stepExport: $("#stepExport"),
  simpleExport: $("#simpleExport"),
  simplePro: $("#simplePro"),
  resumeBox: $("#resumeBox"),
  resumeName: $("#resumeName"),
  resumeMeta: $("#resumeMeta"),
  resumeNote: $("#resumeNote"),
  resumeGo: $("#resumeGo"),
  resumeMore: $("#resumeMore"),
  resumeClose: $("#resumeClose"),
  projectsOpen: $("#projectsOpen"),
  projectsOpenPro: $("#projectsOpenPro"),
  projectsDialog: $("#projectsDialog"),
  projectsClose: $("#projectsClose"),
  projectsList: $("#projectsList"),
  transitionGrid: $("#transitionGrid"),
  transitionsInfo: $("#transitionsInfo"),
  transitionsNote: $("#transitionsNote"),
  transitionSpeedSeg: $("#transitionSpeedSeg"),
  transitionCuts: $("#transitionCuts"),
  transitionEdges: $("#transitionEdges"),
  tlTransitions: $("#tlTransitions"),
  tlTransitionsLabel: $("#tlTransitionsLabel"),
  tlTransitionChips: $("#tlTransitionChips"),
  beatOpen: $("#beatOpen"),
  simpleBeat: $("#simpleBeat"),
  beatDialog: $("#beatDialog"),
  beatClose: $("#beatClose"),
  beatClips: $("#beatClips"),
  beatClipsCount: $("#beatClipsCount"),
  beatAddClips: $("#beatAddClips"),
  beatClipInput: $("#beatClipInput"),
  beatMusic: $("#beatMusic"),
  beatRhythm: $("#beatRhythm"),
  beatRhythmHint: $("#beatRhythmHint"),
  beatLength: $("#beatLength"),
  beatAccent: $("#beatAccent"),
  beatKeepSound: $("#beatKeepSound"),
  beatStatus: $("#beatStatus"),
  beatGo: $("#beatGo"),
  tlSpeed: $("#tlSpeed"),
  tlSpeedLabel: $("#tlSpeedLabel"),
  tlSpeedChips: $("#tlSpeedChips"),
  tlSpeedSelect: $("#tlSpeedSelect"),
  tlTransitionSelect: $("#tlTransitionSelect"),
  transport: $("#transport"),
  tlDockStart: $("#tlDockStart"),
  tlDockEnd: $("#tlDockEnd"),
  simpleTransitions: $("#simpleTransitions"),
  simpleTransitionChips: $("#simpleTransitionChips"),
};

const stylePreview = new StylePreview(el.captionHost);
const player = new SoundPlayer();
// Предпросмотр монтажа: исходник, вставки и видео поверх как один ролик (часы — время сборки M).
const montagePlayer = new MontagePlayer({ main: el.video, host: el.montageMedia, onEvent: (type, detail) => onPlayerEvent(type, detail) });

// ---------------------------------------------------------------------------
// Мелочи

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function formatClock(seconds) {
  const value = Math.max(0, seconds || 0);
  return `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, "0")}`;
}

function humanSize(bytes) {
  if (!Number.isFinite(bytes)) return "";
  const units = ["Б", "КБ", "МБ", "ГБ"];
  let size = bytes;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(index ? 1 : 0)} ${units[index]}`;
}

function countRu(n, forms) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  const form = a > 10 && a < 20 ? forms[2] : b > 1 && b < 5 ? forms[1] : b === 1 ? forms[0] : forms[2];
  return `${n} ${form}`;
}
const phrasesRu = (n) => countRu(n, ["фраза", "фразы", "фраз"]);
const wordsRu = (n) => countRu(n, ["слово", "слова", "слов"]);
const stylesRu = (n) => countRu(n, ["стиль", "стиля", "стилей"]);

function hasWebCodecs() {
  return ["VideoEncoder", "VideoDecoder", "AudioEncoder", "AudioDecoder", "VideoFrame", "OffscreenCanvas"].every((name) => name in window);
}

function setRangeFill(input) {
  const min = Number(input.min || 0);
  const max = Number(input.max || 100);
  const fill = ((Number(input.value) - min) / (max - min || 1)) * 100;
  input.style.setProperty("--fill", `${Math.max(0, Math.min(100, fill))}%`);
}

function setSeg(container, attribute, value) {
  container.querySelectorAll("button").forEach((button) => {
    button.classList.toggle("is-active", button.dataset[attribute] === value);
  });
}

function wait(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Стили и их настройки

function manifestTemplates() {
  return state.manifest?.templates || [];
}

function savedTemplate(saved) {
  return {
    id: saved.id,
    label_ru: saved.name,
    note_ru: "Свой стиль",
    layout: CUSTOM_TEMPLATE.layout,
    style_controls: [
      { id: "primary-color", default: saved.colors?.primary || "#ffffff" },
      { id: "highlight-color", default: saved.colors?.highlight || "#ffd76a" },
    ],
    saved,
  };
}

function allTemplates() {
  return [PICTURES_TEMPLATE, TYPEWRITER_TEMPLATE, KARAOKE_TEMPLATE, ...manifestTemplates(), CUSTOM_TEMPLATE, ...state.savedStyles.map(savedTemplate)];
}

function templateById(id) {
  return allTemplates().find((template) => template.id === id) || null;
}

function currentTemplate() {
  return templateById(state.styleId) || TYPEWRITER_TEMPLATE;
}

const isTypewriter = () => state.styleId === TYPEWRITER_ID;
const isPictures = () => state.styleId === PICTURES_ID;
const isCustom = (id = state.styleId) => id === CUSTOM_ID || id === KARAOKE_ID || String(id).startsWith("my-");

function controlDefault(template, id, fallback) {
  return template?.style_controls?.find((control) => control.id === id)?.default || fallback;
}

function soundStyleKey(id = state.styleId) {
  return isCustom(id) ? CUSTOM_ID : id;
}

function soundPresetFor(id) {
  const kit = soundManifest ? styleSounds(soundManifest, soundStyleKey(id))?.kits?.[0] : null;
  if (kit) return kitSettings(soundManifest, soundStyleKey(id), kit, state.soundRemoved);
  const preset = SOUND_PRESETS[isCustom(id) ? CUSTOM_ID : id] || {};
  const layers = {};
  for (const layer of SOUND_LAYERS) {
    const [sound, volume] = preset[layer.id] || layer.fallback || ["", 0.5];
    layers[layer.id] = { sound, volume };
  }
  return { layers };
}

function defaultsFor(template) {
  const saved = template?.saved;
  return {
    font: saved?.font || (template?.id === CUSTOM_ID ? BUILDER_PRESETS[0].font : template?.id === KARAOKE_ID ? KARAOKE_PRESET.font : ""),
    accent: "",
    colors: {
      primary: controlDefault(template, "primary-color", "#ffffff"),
      highlight: controlDefault(template, "highlight-color", controlDefault(template, "tag-color", "#f5c982")),
    },
    sizeScale: 1,
    position: "template",
    height: null,
    phraseLength: "normal",
    sound: soundPresetFor(template?.id),
  };
}

function settings(id = state.styleId) {
  if (!state.perStyle[id]) state.perStyle[id] = defaultsFor(templateById(id));
  return state.perStyle[id];
}

function builderValues(id = state.styleId) {
  if (!isCustom(id)) return null;
  if (!state.builders[id]) {
    const saved = state.savedStyles.find((item) => item.id === id);
    state.builders[id] = normaliseBuilder(saved?.values || (id === KARAOKE_ID ? { ...BUILDER_DEFAULTS, ...KARAOKE_PRESET.values, name: "Караоке" } : BUILDER_DEFAULTS));
  }
  return state.builders[id];
}

function templateAlignment(template) {
  return {
    verticalAlign: template?.layout?.verticalAlign || "bottom",
    verticalOffset: Number(template?.layout?.verticalOffset ?? 0.78),
    horizontalAlign: template?.layout?.horizontalAlign || "center",
    horizontalOffset: Number(template?.layout?.horizontalOffset ?? 0.5),
  };
}

const POSITION_PRESETS = {
  top: { verticalAlign: "top", verticalOffset: 0.12 },
  center: { verticalAlign: "center", verticalOffset: 0.5 },
  bottom: { verticalAlign: "bottom", verticalOffset: 0.84 },
};

function alignmentFor(template, ps) {
  const base = templateAlignment(template);
  let preset = ps.position === "template" ? base : { ...base, ...POSITION_PRESETS[ps.position], horizontalAlign: "center", horizontalOffset: 0.5 };
  if (ps.height != null) preset = { ...preset, verticalOffset: ps.height };
  // Блок перетащили по горизонтали: его центр стоит там, куда его поставил человек.
  if (ps.x != null) preset = { ...preset, horizontalAlign: "center", horizontalOffset: ps.x };
  return preset;
}

/**
 * Где на самом деле встанет блок субтитров: как задано в стиле и настройках,
 * но не в шапке и не под кнопками/подписью площадки, если включена защита.
 * Если есть перевод второй строкой, под блоком остаётся место для него.
 */
function effectiveAlignment(template = currentTemplate(), ps = settings()) {
  let alignment = alignmentFor(template, ps);
  if (!state.safe.keep || isPictures()) return alignment;
  const zone = safePlatform(state.safe.platform);
  const second = state.translation?.second;
  let reserve = 0;
  if (second?.cues?.length && !state.translation.secondStyle.placed) {
    // Две строки перевода и зазор: перевод встанет под блок, внутри безопасной зоны.
    reserve = 0.085 * Math.min(2, Number(state.translation.secondStyle.size) || 1);
  }
  const shifted = { ...zone, bottom: zone.bottom + reserve };
  alignment = keepAlignmentSafe(alignment, shifted, isTypewriter() ? 0.07 : 0.06);
  return alignment;
}

function soundSettings() {
  return settings().sound;
}

/** Слои звуков стиля плюс музыка ролика — то, что звучит и попадает в MP4. */
function audioSettings() {
  return { ...settings().sound, music: { ...state.music } };
}

const RTL_LETTER = /[\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\u0870-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/u;
const ANY_LETTER = /\p{L}/u;
let directionCache = { cues: null, value: "ltr" };

const TURKIC_LETTER = /[ığİĞ]/u;

/**
 * Язык субтитров, когда он важен для отрисовки: после перевода — язык перевода,
 * иначе турецкий узнаётся по буквам ı, ğ, İ (у турецкого своя заглавная İ).
 */
function subtitleLanguage() {
  if (state.translation.original && state.translation.language) return state.translation.language;
  if (state.speechLanguage && state.speechLanguage !== "ru") return state.speechLanguage;
  for (const cue of state.cues) {
    for (const word of cue.words) if (TURKIC_LETTER.test(word.text)) return "tr";
  }
  return null;
}

/** Направление письма текста: «rtl», если букв арабского (или иврита) больше остальных. */
function textDirection() {
  if (directionCache.cues === state.cues) return directionCache.value;
  let rtl = 0;
  let other = 0;
  for (const cue of state.cues) {
    for (const word of cue.words) {
      for (const char of word.text) {
        if (RTL_LETTER.test(char)) rtl += 1;
        else if (ANY_LETTER.test(char)) other += 1;
      }
    }
  }
  directionCache = { cues: state.cues, value: rtl > other ? "rtl" : "ltr" };
  return directionCache.value;
}

function buildSpec() {
  const template = currentTemplate();
  const ps = settings();
  const model = montage();
  // Всё — во времени сборки (M): исходник со вставками, вырезанное пропускает движок.
  const skips = model.skipsM.ranges.map((range) => ({ start: range.start, end: range.end }));
  const spec = {
    styleId: isCustom() ? CUSTOM_ID : template.id,
    cues: previewCues(),
    colors: { ...ps.colors },
    alignment: effectiveAlignment(template, ps),
    keywords: [...state.keywords],
    typewriter: { ...state.typewriter, fontSize: 4.6 * ps.sizeScale },
    font: ps.font,
    accentFont: ps.accent,
    autoKeywords: Boolean(template.auto_keywords),
    rendering: template.rendering || null,
    phraseLength: ps.phraseLength,
    extraVars: { "--tscaps-font-size-scale": String(ps.sizeScale) },
    sound: JSON.parse(JSON.stringify({ ...ps.sound, music: state.music })),
    voiceGain: state.voice,
    // Арабский текст — справа налево во всех стилях.
    textDirection: textDirection(),
    // Язык текста: заглавные буквы по его правилам (турецкое i → İ).
    textLang: subtitleLanguage(),
    edit: { skip: skips, voice: { ...state.edit.voice }, enhance: { ...state.edit.enhance } },
    fx: fxSpec(),
    // Где звучит звук склеек: вставки, видео поверх и свои склейки (время сборки).
    cutMoments: cutMoments(model),
    // Музыка и звуки, положенные на ленту (время готового ролика).
    audioClips: audioClipsPlan(model),
    // Свой текст (стихи): музыку под ним не приглушаем.
    lyrics: lyricsMode(),
  };
  if (!model.isEmpty) spec.montage = montagePlan(model);
  if (template.id === PICTURES_ID) spec.pictures = picturesSpec(ps);
  if (isCustom()) {
    const values = builderValues();
    spec.customCss = buildCustomCss(values);
    spec.rendering = builderRendering(values);
    spec.extraVars = { ...spec.extraVars, ...builderVars(values, ps.colors.highlight) };
    spec.styleName = values.name;
  }
  return spec;
}

// ---------------------------------------------------------------------------
// Вкладки

function openTab(name) {
  if (name === "fx") {
    const thumb = captureLookThumb();
    if (thumb && thumb !== lookThumb) {
      lookThumb = thumb;
      drawLookGrid();
    }
  }
  el.tabs.forEach((tab) => {
    const active = tab.dataset.tab === name;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
  });
  el.panels.forEach((panel) => {
    const active = panel.dataset.panel === name;
    panel.classList.toggle("is-active", active);
    panel.hidden = !active;
  });
}

// ---------------------------------------------------------------------------
// Видео

/**
 * Новое видео в студии. url — откуда его играть, если это не файл с компьютера,
 * а видео сохранённого проекта на сервере (RemoteVideo). keepProject — тот же
 * проект (открываем сохранённый), иначе начинается новый.
 */
function setVideo(file, { url = null, keepProject = false } = {}) {
  if (!file) return;
  void cancelTranscription({ quiet: true });
  pausePreview();
  if (!keepProject) startNewProject();
  dropMainUpload(file);
  transitionFrames.reset();
  state.transitions.custom = {};
  state.video = file;
  state.uploadId = null;
  state.videoHasAudio = null;
  state.speechError = "";
  state.videoSize = null;
  state.edit.trimStart = 0;
  state.edit.trimEnd = null;
  state.edit.cuts = [];
  state.edit.aiCuts = [];
  state.edit.manual = [];
  state.edit.auto = false;
  resetMontage();
  state.fx.faces = [];
  state.fx.facesFor = "";
  state.moments.list = [];
  state.hook.data = null;
  state.hook.text = "";
  state.hook.show = false;
  previewMasker?.reset();
  state.duration = 0;
  clearSubtitles();
  if (state.videoUrl?.startsWith("blob:")) URL.revokeObjectURL(state.videoUrl);
  state.videoUrl = url || URL.createObjectURL(file);
  el.video.src = state.videoUrl;
  el.fileChipText.textContent = `${file.name} · ${humanSize(file.size)}`;
  el.fileChip.classList.add("has-file");
  el.screen.classList.remove("is-empty");
  // Видео открыто — окошко «Черновик» больше не нужно (кадр занимает всё место).
  el.resumeBox.hidden = true;
  el.screen.classList.remove("has-resume");
  stageElement.classList.remove("has-draft");
  hideResult();
  updateUi();
  undoReset();   // новое видео — своя история отмены
}

// Экран всегда точно повторяет пропорции видео, чтобы субтитры поверх него
// стояли там же, где окажутся в готовом ролике.
const stageElement = el.screen.parentElement;
function fitScreen() {
  const size = state.videoSize || { width: 9, height: 16 };
  const styles = getComputedStyle(stageElement);
  const width = stageElement.clientWidth - parseFloat(styles.paddingLeft) - parseFloat(styles.paddingRight);
  const height = stageElement.clientHeight - parseFloat(styles.paddingTop) - parseFloat(styles.paddingBottom);
  if (!(width > 0 && height > 0)) return;
  // Хватает ли места сбоку от кадра для окошка «Черновик» (считаем без полоски сверху, иначе раскладка дёргалась бы).
  const bar = stageElement.classList.contains("is-tight") && stageElement.classList.contains("has-draft")
    ? parseFloat(styles.paddingTop) - parseFloat(styles.paddingBottom) : 0;
  const frame = Math.min(width / size.width, (height + bar) / size.height) * size.width;
  stageElement.classList.toggle("is-tight", width - frame < 2 * 262);
  const scale = Math.min(width / size.width, height / size.height);
  el.screen.style.width = `${Math.floor(size.width * scale)}px`;
  el.screen.style.height = `${Math.floor(size.height * scale)}px`;
  stylePreview.fit();
}
if (typeof ResizeObserver !== "undefined") new ResizeObserver(fitScreen).observe(stageElement);

// Шапка подгоняется под ширину сама: если пункты не помещаются, по шагам прячется второстепенное
// (классы fit-1…fit-N накапливаются, см. styles.css). Набор кнопок меняется (черновики, тариф, файл) —
// шапка подгоняется заново, поэтому она не вылезает за край ни на каком экране.
const barElement = document.querySelector("header.bar");
const BAR_FIT_MAX = 10;
let barFitFrame = 0;
function fitBar() {
  barFitFrame = 0;
  if (!barElement) return;
  for (let level = 0; level <= BAR_FIT_MAX; level += 1) {
    for (let step = 1; step <= BAR_FIT_MAX; step += 1) barElement.classList.toggle(`fit-${step}`, step <= level);
    if (barElement.scrollWidth <= barElement.clientWidth + 1) break;
  }
}
function scheduleFitBar() {
  if (!barFitFrame) barFitFrame = requestAnimationFrame(fitBar);
}
if (barElement) {
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(scheduleFitBar).observe(barElement);
  // Свои классы шапки (fit-N) не считаются: иначе подгонка запускала бы сама себя.
  new MutationObserver((records) => { if (records.some((r) => r.target !== barElement)) scheduleFitBar(); })
    .observe(barElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["hidden", "class", "disabled"] });
  window.addEventListener("resize", scheduleFitBar);
  if (document.fonts?.ready) document.fonts.ready.then(scheduleFitBar).catch(() => {});
  scheduleFitBar();
}

el.video.addEventListener("loadedmetadata", () => {
  if (pendingAutoTranscribe && state.mode === "simple" && !state.cues.length) {
    pendingAutoTranscribe = false;
    window.setTimeout(() => { if (!state.cues.length && !state.transcription.busy) void transcribeVideo({ auto: true }); }, 50);
  }
  pendingAutoTranscribe = false;
  state.videoSize = { width: el.video.videoWidth, height: el.video.videoHeight };
  drawSafeOverlay();
  drawSafeNote();
  state.duration = el.video.duration || 0;
  fitScreen();
  el.twCanvas.width = state.videoSize.width;
  el.twCanvas.height = state.videoSize.height;
  touchMontage();
  timeline.setMedia("main", { url: state.videoUrl, aspect: state.videoSize.width / Math.max(1, state.videoSize.height), duration: state.duration, peaks: null });
  el.timeTotal.textContent = formatClock(montage().totalO);
  drawRibbon();
  refreshTimeline();
  updateUi();
  schedulePreview(0);
  if (state.montage.open) void ensureMainPeaks();
});

// ---------------------------------------------------------------------------
// Текст: распознавание, файл, правка

function isSubtitleText(value) {
  return /\d{2}:\d{2}[,.]\d{3}\s*-->/.test(value);
}

function setSubtitles(text, { test = false, label = "", language = null, base = "S" } = {}) {
  const clean = String(text || "").replace(/^﻿/, "").trim();
  if (!isSubtitleText(clean)) throw new Error("В файле нет временных меток — это не субтитры.");
  const cues = resegmentCues(parseCues(clean));
  if (!cues.length) throw new Error("В субтитрах не найдено ни одной фразы.");
  useCues(cues, { test, label, language, base });
}

/** Текст готов (распознан, загружен или вставлен вручную): всё, что от него зависит, — заново. */
function useCues(cues, { test = false, label = "", language = null, base = "S" } = {}) {
  state.cues = cues;
  state.cuesBase = base === "O" ? "O" : "S";
  state.subtitlesAreTest = test;
  state.speechLanguage = language;
  state.keywords = [];
  resetPictures();
  // Склейки ИИ относятся к старому тексту; куски, вырезанные человеком, и вставки остаются.
  state.edit.aiCuts = [];
  state.edit.auto = false;
  rebuildCuts();
  state.moments.list = [];
  state.hook.data = null;
  state.translation.original = null;
  state.translation.language = null;
  state.translation.second = null;
  drawTranslateControls();
  drawCutList();
  drawMoments();
  drawHook();
  if (label) el.sourceNote.textContent = label;
  hideResult();
  drawEditor();
  drawRibbon();
  refreshTimeline();
  updateUi();
  schedulePreview(0);
  maybeAutoPictures();
}

function clearSubtitles() {
  state.cues = [];
  state.cuesBase = "S";
  state.keywords = [];
  state.subtitlesAreTest = false;
  resetPictures();
  stylePreview.clear();
  state.preview = { timeline: null, kind: null, images: null, moments: null, events: [], ready: false };
  drawEditor();
  drawRibbon();
  clearCanvas();
  updateUi();
}

function isKeyword(text) {
  const key = keywordKey(text);
  return Boolean(key) && state.keywords.some((word) => keywordKey(word) === key);
}

function toggleKeyword(text) {
  const key = keywordKey(text);
  if (!key) return;
  const list = state.keywords.filter((word) => keywordKey(word) !== key);
  if (list.length === state.keywords.length) list.push(text.replace(/[^\p{L}\p{N}-]+/gu, ""));
  state.keywords = list;
  hideResult();
  drawEditor();
  drawRibbon();
  schedulePreview();
}

function drawEditor() {
  const has = state.cues.length > 0;
  el.editorBlock.hidden = !has;
  if (!has) {
    el.cueList.innerHTML = "";
    return;
  }
  const words = state.cues.reduce((sum, cue) => sum + cue.words.length, 0);
  el.editorCounter.textContent = `${phrasesRu(state.cues.length)}, ${wordsRu(words)}`;
  el.keywordSummary.textContent = state.keywords.length
    ? `Выделены цветом: ${state.keywords.join(", ")}. Нажми на слово ещё раз, чтобы снять выделение.`
    : "Исправь текст прямо в строке. Нажми на слово под строкой, чтобы выделить его цветом.";
  renderEditor(el.cueList, state.cues, {
    onChange: (cues) => {
      state.cues = cues.filter((cue) => cue.words.length);
      remapPlan();
      hideResult();
      drawEditor();
      drawRibbon();
      refreshTimeline();
      schedulePreview();
      updateUi();
    },
    isKeyword,
    onToggleKeyword: toggleKeyword,
    onSeek: (time) => seekText(time),
  });
  lastCueRow = -1;
}

function testCues(duration) {
  const phrases = [
    "Это проверочный текст",
    "Он показывает стиль и звук",
    "Но не совпадает с речью",
    "Для своей речи нажми «Распознать»",
  ];
  const usable = Math.max(2, duration - 0.6);
  const slot = usable / phrases.length;
  const toTime = (value) => {
    const ms = Math.round(value * 1000);
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
  };
  return phrases.map((text, index) => {
    const start = 0.3 + index * slot;
    return `${index + 1}\n${toTime(start)} --> ${toTime(start + slot * 0.86)}\n${text}\n`;
  }).join("\n");
}

async function responseMessage(response, fallback = "Reel Lab не смог выполнить действие.") {
  try {
    const payload = await response.clone().json();
    if (typeof payload?.error === "string" && payload.error.trim()) return payload.error;
  } catch (_) { /* не JSON */ }
  return response.status ? `${fallback} Код: ${response.status}.` : fallback;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, { credentials: "same-origin", ...options });
  if (!response.ok) {
    const error = new Error(await responseMessage(response));
    error.status = response.status;
    throw error;
  }
  return response.json();
}

/**
 * Опрос сервера, который переживает короткий обрыв: телефон сменил сеть, Telegram свернули,
 * сервер перезапускается. Сетевые ошибки и 5xx — подождать и спросить снова (около двух минут),
 * ответ сервера «нельзя» (4xx) — сразу ошибка.
 */
async function pollJson(url, { signal, patience = 120000 } = {}) {
  const started = Date.now();
  let failures = 0;
  for (;;) {
    try {
      return await requestJson(url, { signal });
    } catch (error) {
      if (error?.name === "AbortError" || signal?.aborted) throw error;
      if (error?.status && error.status < 500) throw error;
      failures += 1;
      if (Date.now() - started > patience) {
        const lost = new Error("Связь с сервером пропала. Проверь интернет и попробуй ещё раз.");
        lost.network = true;
        throw lost;
      }
      await wait(Math.min(5000, 600 * failures));
    }
  }
}

function requestId(prefix) {
  const unique = typeof crypto?.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${unique}`.slice(0, 96);
}

// Видео уходит в Reel Lab один раз: и для распознавания, и для сборки, и для автосохранения
// проекта. Если загрузка уже идёт (например, в фоне для автосохранения), все ждут её же.
const mainUpload = { file: null, promise: null, controller: null, error: "", failedAt: 0, listeners: new Set() };

/** Открыли другое видео — загрузка прежнего больше не нужна (на телефоне это лишний трафик). */
function dropMainUpload(nextFile) {
  if (mainUpload.file && mainUpload.file !== nextFile) mainUpload.controller?.abort();
  if (mainUpload.file !== nextFile) Object.assign(mainUpload, { file: null, promise: null, controller: null, error: "", failedAt: 0 });
}

function startMainUpload() {
  const file = state.video;
  if (mainUpload.promise && mainUpload.file === file) return mainUpload.promise;
  if (file?.remote) return Promise.reject(new Error("Видео проекта уже удалено с сервера — выбери тот же файл ещё раз."));
  const controller = new AbortController();
  Object.assign(mainUpload, { file, controller, error: "" });
  const progress = (part) => mainUpload.listeners.forEach((listener) => listener(part));
  const promise = (async () => {
    let uploaded;
    if (server.active) {
      guardClose(true);
      try {
        uploaded = await uploadInChunks(file, { name: file.name || "video.mp4", onProgress: progress, signal: controller.signal });
      } finally {
        guardClose(false);
      }
      if (!uploaded?.id) throw new Error("Сервер не сохранил видео.");
    } else {
      const session = await requestJson("/api/upload-session", { signal: controller.signal });
      uploaded = await requestJson(`/api/uploads?name=${encodeURIComponent(file.name || "video.mp4")}`, {
        method: "POST",
        headers: { "X-CSRF-Token": session.csrf, "Content-Type": file.type || "application/octet-stream" },
        body: file,
        signal: controller.signal,
      });
      if (!uploaded?.id) throw new Error("Reel Lab не сохранил видео.");
    }
    // Пока видео грузилось, могли открыть другое — тогда результат уже не наш.
    if (state.video === file) {
      state.uploadId = uploaded.id;
      if (uploaded.media) state.videoHasAudio = uploaded.media.has_audio !== false;
    }
    return uploaded.id;
  })();
  mainUpload.promise = promise;
  promise.then(() => {
    if (mainUpload.promise === promise && state.video !== file) mainUpload.promise = null;
  }, (error) => {
    if (mainUpload.promise !== promise) return;
    mainUpload.promise = null;
    mainUpload.error = error?.name === "AbortError" ? "" : error?.message || String(error);
    mainUpload.failedAt = Date.now();
  });
  return promise;
}

/** Фоновая загрузка для автосохранения: после обрыва связи пробуем снова через минуту, после отказа сервера — нет. */
function mainUploadRetryable() {
  if (!mainUpload.error) return true;
  return /связь|failed to fetch|network|load failed/i.test(mainUpload.error) && Date.now() - mainUpload.failedAt > 60000;
}

/** Дождаться обещания, но выйти сразу, если человек нажал «Остановить». */
function untilAborted(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new DOMException("Остановлено", "AbortError"));
  return new Promise((resolve, reject) => {
    const stop = () => reject(new DOMException("Остановлено", "AbortError"));
    signal.addEventListener("abort", stop, { once: true });
    promise.then((value) => { signal.removeEventListener("abort", stop); resolve(value); },
      (error) => { signal.removeEventListener("abort", stop); reject(error); });
  });
}

async function uploadSourceVideo(signal) {
  let csrf = server.csrf;
  if (!server.active) {
    const session = await requestJson("/api/upload-session", { signal });
    if (!session?.csrf) throw new Error("Не удалось начать локальную сессию.");
    csrf = session.csrf;
  }
  // То же видео уже в Reel Lab — второй раз не грузим.
  if (state.uploadId) return { csrf, uploadId: state.uploadId };
  const listener = server.active ? (part) => setTranscription(`Загружаю видео на сервер… ${Math.round(part * 100)}%`, 2 + part * 9) : null;
  if (listener) mainUpload.listeners.add(listener);
  try {
    const uploadId = await untilAborted(startMainUpload(), signal);
    return { csrf, uploadId };
  } finally {
    if (listener) mainUpload.listeners.delete(listener);
  }
}

// ---------------------------------------------------------------------------
// Язык речи: выбирается до распознавания. Русский распознаёт GigaAM на этом
// компьютере, остальные языки — Whisper в Cloudflare (нужен ключ ИИ).

const SPEECH_LANGUAGES = [
  ["ru", "Русский"],
  ["ar", "Арабский"],
  ["ce", "Чеченский"],
  ["ky", "Кыргызский"],
  ["en", "Английский"],
  ["tr", "Турецкий"],
  ["kk", "Казахский"],
  ["uz", "Узбекский"],
  ["az", "Азербайджанский"],
  ["tg", "Таджикский"],
  ["uk", "Украинский"],
  ["de", "Немецкий"],
  ["fr", "Французский"],
  ["es", "Испанский"],
  ["it", "Итальянский"],
  ["pt", "Португальский"],
  ["pl", "Польский"],
];
const SPEECH_LANG_KEY = "reellab.speechLang";
// Речь на этих языках пока не распознаёт ни одна нейросеть (ни Whisper, ни Яндекс SpeechKit):
// субтитры — свой текст (встанет под голос) или русская речь с переводом на этот язык.
const TEXT_ONLY_SPEECH = { ce: ["чеченскую", "чеченский"], ky: ["кыргызскую", "кыргызский"] };

function textOnlySpeech(code = speechLanguage()) {
  return Object.hasOwn(TEXT_ONLY_SPEECH, code);
}

function textOnlySpeechMessage(code = speechLanguage()) {
  const [speech, target] = TEXT_ONLY_SPEECH[code] || ["эту", "этот язык"];
  return `Распознавать ${speech} речь пока не умеет ни одна нейросеть. Нажми «✍ Свой текст» и вставь слова — они встанут под голос. `
    + `Или выбери язык «Русский», распознай речь и добавь перевод на ${target} (вкладка «Текст» → «Перевод субтитров»).`;
}

/** Язык без распознавания речи: объясняем и (если человек нажал сам) открываем «Свой текст». */
function refuseTextOnlySpeech({ auto = false } = {}) {
  toast(textOnlySpeechMessage(), 9000);
  if (!auto && state.video) openLyrics();
}

function speechLanguage() {
  const value = el.speechLangs[0]?.value || "ru";
  return SPEECH_LANGUAGES.some(([code]) => code === value) ? value : "ru";
}

function speechLanguageName(code) {
  return (SPEECH_LANGUAGES.find(([value]) => value === code) || [code, code])[1];
}

function drawSpeechNote() {
  if (!el.speechNote) return;
  const code = speechLanguage();
  if (textOnlySpeech(code)) {
    el.speechNote.classList.add("is-warn");
    el.speechNote.textContent = textOnlySpeechMessage(code);
    return;
  }
  if (server.active) {
    el.speechNote.classList.remove("is-warn");
    el.speechNote.textContent = `${speechLanguageName(code)}: речь распознаёт сервер Reel Lab — телефон не нагружается. Текст будет на языке речи.`;
    return;
  }
  const cloud = code !== "ru";
  el.speechNote.classList.toggle("is-warn", cloud && !state.ai.configured);
  if (!cloud) el.speechNote.textContent = "Русский распознаётся на этом компьютере — видео никуда не отправляется.";
  else if (!state.ai.configured) el.speechNote.textContent = `${speechLanguageName(code)} распознаёт ИИ Whisper. Сначала подключи ключ ИИ кнопкой вверху — русский работает и без него.`;
  else el.speechNote.textContent = `${speechLanguageName(code)} распознаёт ИИ Whisper в твоём Cloudflare: звук ролика уходит туда на распознавание. Текст будет сразу на языке речи.`;
}

function setupSpeechLanguages() {
  let saved = "ru";
  try { saved = localStorage.getItem(SPEECH_LANG_KEY) || "ru"; } catch (_) { /* браузер не хранит — русский */ }
  if (!SPEECH_LANGUAGES.some(([code]) => code === saved)) saved = "ru";
  for (const select of el.speechLangs) {
    select.replaceChildren(...SPEECH_LANGUAGES.map(([code, name]) => new Option(name, code)));
    select.value = saved;
    select.addEventListener("change", () => {
      for (const other of el.speechLangs) if (other !== select) other.value = select.value;
      try { localStorage.setItem(SPEECH_LANG_KEY, select.value); } catch (_) { /* не запомнится — не страшно */ }
      drawSpeechNote();
      updateUi();
    });
  }
  drawSpeechNote();
}

async function sessionCsrf() {
  if (state.uploadId) return (await requestJson("/api/upload-session")).csrf;
  return (await uploadSourceVideo()).csrf;
}

function setTranscription(label, percent) {
  el.transcription.hidden = false;
  el.transcriptionLabel.textContent = label;
  el.simpleProgressLabel.textContent = label;
  if (typeof percent === "number") {
    const width = `${Math.max(3, Math.min(100, percent))}%`;
    el.transcriptionFill.style.width = width;
    el.simpleProgressFill.style.width = width;
  }
}

const PHASES = {
  QUEUED: "Жду очереди на распознавание…",
  VALIDATING: "Проверяю видео…",
  TRANSCRIBING: "Распознаю речь…",
  CLOUD_TRANSCRIBING: "ИИ Whisper распознаёт речь…",
  SUBTITLES_READY: "Сохраняю текст…",
  CANCELLING: "Останавливаю…",
};

const NO_AUDIO_TEXT = "В этом видео нет звука — распознавать нечего. Вставь свой текст (слова нашида, цитату) или собери ролик без субтитров.";

/** Музыка на ленте, из которой можно распознать слова (самый длинный звук). Время ролика (O). */
function musicForSpeech() {
  const places = audioPlaces(montage()).filter((place) => place.clip.soundId && place.o1 - place.o0 > 1);
  if (!places.length) return null;
  return places.reduce((best, place) => (place.o1 - place.o0 > best.o1 - best.o0 ? place : best));
}

/** Слова нашида с ленты: сервер слушает кусок звука, текст встаёт по времени ролика (через вставки тоже). */
async function transcribeMusic() {
  const place = musicForSpeech();
  if (!place || state.transcription.busy) return;
  if (textOnlySpeech()) { refuseTextOnlySpeech({ auto: true }); return; }
  const run = state.transcription.run + 1;
  const controller = new AbortController();
  state.transcription = { busy: true, csrf: null, jobId: null, controller, run };
  const active = () => state.transcription.busy && state.transcription.run === run;
  const language = speechLanguage();
  if (language !== "ru" && !state.ai.configured && !server.active) {
    state.transcription = { busy: false, csrf: null, jobId: null, controller: null, run };
    setTranscription(`${speechLanguageName(language)} распознаёт ИИ: сначала подключи ключ ИИ кнопкой «Ключ ИИ» вверху.`, 0);
    updateUi();
    return;
  }
  const { clip, o0, o1 } = place;
  // Замедленный трек (slowed) сервер возвращает к обычной скорости: так пение понятнее для распознавания.
  const slowed = /slow/i.test(clip.name || "");
  state.speechError = "";
  setTranscription(`Слушаю «${clip.name}»${slowed ? " (замедленный — ускоряю для распознавания)" : ""}…`, 8);
  updateUi();
  try {
    const csrf = server.active ? server.csrf : await sessionCsrf();
    if (!active()) return;
    const job = await requestJson(`/api/sounds/own/${encodeURIComponent(clip.soundId)}/transcription`, {
      method: "POST",
      headers: { "X-CSRF-Token": csrf, "Content-Type": "application/json" },
      body: JSON.stringify({ request_id: requestId("music"), language, start: clip.in, end: clip.in + (o1 - o0), slowed }),
      signal: controller.signal,
    });
    if (!active()) return;
    state.transcription.csrf = csrf;
    state.transcription.jobId = job.id;
    const speed = Number(job.speed) > 0 ? Number(job.speed) : 1;
    const deadline = Date.now() + 60 * 60 * 1000;
    while (active()) {
      if (Date.now() > deadline) throw new Error("Распознавание заняло слишком много времени.");
      const list = await pollJson("/api/jobs", { signal: controller.signal });
      const current = list?.jobs?.find((item) => item.id === job.id);
      if (!current) throw new Error("Задача распознавания пропала.");
      const percent = Number(current?.progress?.percent);
      setTranscription(current.phase === "QUEUED" ? PHASES.QUEUED : `Слушаю слова в «${clip.name}»…`, Number.isFinite(percent) ? percent : 15);
      if (current.status === "completed") {
        const response = await fetch(`/api/jobs/${encodeURIComponent(job.id)}/subtitles?format=vtt`, { credentials: "same-origin", signal: controller.signal });
        if (!response.ok) throw new Error(await responseMessage(response, "Не удалось получить текст."));
        const parsed = resegmentCues(parseCues(await response.text()));
        const shift = (time) => Math.min(o1, Math.max(o0, o0 + time * speed));
        // Слова без букв (одинокая точка из распознавания) не нужны.
        const cues = parsed.map((cue) => {
          const words = cue.words.filter((word) => /[\p{L}\p{N}]/u.test(word.text))
            .map((word) => ({ ...word, start: shift(word.start), end: shift(word.end) }));
          return words.length ? { ...cue, start: Math.min(shift(cue.start), words[0].start), end: shift(cue.end), words } : null;
        }).filter((cue) => cue && cue.end - cue.start > 0.05);
        if (!cues.length) throw new Error("слова не разобрались");
        useCues(cues, { base: "O", language,
          label: "Слова нашида распознаны. В пении ошибки бывают чаще — поправь слова через «поправить текст»: время останется." });
        setTranscription("Текст готов", 100);
        window.setTimeout(() => { if (!state.transcription.busy) el.transcription.hidden = true; }, 1200);
        return;
      }
      if (current.status === "failed") throw new Error(current.error || "Не удалось распознать.");
      if (current.status === "cancelled") throw new Error("Распознавание остановлено.");
      await wait(1000);
    }
  } catch (error) {
    if (error?.name === "AbortError" || !active()) return;
    const message = String(error?.message || error).replace(/\.$/, "");
    state.speechError = `Не получилось распознать слова в «${clip.name}»: ${message}. Вставь слова сам — «✍ Вставить свой текст», а время подгони под музыку.`;
    setTranscription(state.speechError, 0);
  } finally {
    if (active()) {
      state.transcription.busy = false;
      state.transcription.controller = null;
      state.transcription.jobId = null;
      updateUi();
    }
  }
}

/** В ролике есть вставки со звуком: речь может быть не только в основном видео. */
function montageHasSpeechClips() {
  const model = montage();
  return model.inserts.some((item) => {
    const media = state.montage.media.get(item.mediaKey);
    return media && media.key !== SELF_MEDIA && media.hasAudio !== false && Number(item.volume ?? 1) > 0.001;
  });
}

async function transcribeVideo({ ask = true, auto = false } = {}) {
  if (state.transcription.busy || !state.video || project.restoring) return;
  if (textOnlySpeech()) { refuseTextOnlySpeech({ auto }); return; }
  // Несколько видео со звуком: распознать речь во всех (текст встанет по времени готового ролика).
  if (montageHasSpeechClips() && (!ask || await askConfirm(
    "В ролике несколько видео со звуком. Распознать речь во всех видео? «Отмена» — только в основном."))) return transcribeMontage();
  // В видео нет звука, но на ленте есть нашид — слушаем его.
  if (state.videoHasAudio === false && musicForSpeech()) return transcribeMusic();
  const run = state.transcription.run + 1;
  const controller = new AbortController();
  state.transcription = { busy: true, csrf: null, jobId: null, controller, run };
  const active = () => state.transcription.busy && state.transcription.run === run;
  const language = speechLanguage();
  if (language !== "ru" && !state.ai.configured && !server.active) {
    state.transcription = { busy: false, csrf: null, jobId: null, controller: null, run };
    setTranscription(`${speechLanguageName(language)} распознаёт ИИ: сначала подключи ключ ИИ кнопкой «Ключ ИИ» вверху.`, 0);
    updateUi();
    return;
  }
  clearSubtitles();
  state.speechError = "";
  setTranscription(server.active ? "Загружаю видео на сервер…" : "Копирую видео в Reel Lab…", server.active ? 2 : 6);
  updateUi();
  try {
    const { csrf, uploadId } = await uploadSourceVideo(controller.signal);
    if (!active()) return;
    if (state.videoHasAudio === false) {
      if (musicForSpeech()) {
        state.transcription = { busy: false, csrf: null, jobId: null, controller: null, run: state.transcription.run };
        void transcribeMusic();
        return;
      }
      throw new Error(NO_AUDIO_TEXT);
    }
    state.transcription.csrf = csrf;
    setTranscription("Ставлю распознавание в очередь…", 12);
    const job = await requestJson(`/api/uploads/${encodeURIComponent(uploadId)}/transcription`, {
      method: "POST",
      headers: { "X-CSRF-Token": csrf, "Content-Type": "application/json" },
      body: JSON.stringify({ request_id: requestId("captions"), language }),
      signal: controller.signal,
    });
    if (!active()) return;
    state.transcription.jobId = job.id;
    const deadline = Date.now() + 60 * 60 * 1000;
    while (active()) {
      if (Date.now() > deadline) throw new Error("Распознавание заняло слишком много времени.");
      const list = await pollJson("/api/jobs", { signal: controller.signal });
      const current = list?.jobs?.find((item) => item.id === job.id);
      if (!current) throw new Error("Задача распознавания пропала.");
      const percent = Number(current?.progress?.percent);
      setTranscription(PHASES[current.phase] || "Готовлю текст…", Number.isFinite(percent) ? percent : 15);
      if (current.status === "completed") {
        const words = await fetch(`/api/jobs/${encodeURIComponent(job.id)}/subtitles?format=vtt`, { credentials: "same-origin", signal: controller.signal });
        let text;
        let wordTimed = true;
        if (words.ok) text = await words.text();
        else {
          const phrases = await fetch(`/api/jobs/${encodeURIComponent(job.id)}/subtitles`, { credentials: "same-origin", signal: controller.signal });
          if (!phrases.ok) throw new Error(await responseMessage(phrases, "Не удалось получить текст."));
          text = await phrases.text();
          wordTimed = false;
        }
        setSubtitles(text, {
          language,
          label: wordTimed
            ? "Речь распознана со временем каждого слова. Проверь текст и выбери стиль."
            : "Речь распознана, но время слов внутри фраз примерное.",
        });
        setTranscription("Текст готов", 100);
        if (state.pendingMagic.length) void runPresetMagic([...state.pendingMagic]);
        window.setTimeout(() => { if (!state.transcription.busy) el.transcription.hidden = true; }, 1200);
        return;
      }
      if (current.status === "failed") throw new Error(current.error || "Не удалось распознать речь.");
      if (current.status === "cancelled") throw new Error("Распознавание остановлено.");
      await wait(1000);
    }
  } catch (error) {
    if (error?.name === "AbortError" || !active()) return;
    const message = String(error?.message || error);
    if (/нет звука/i.test(message)) state.videoHasAudio = false;
    state.speechError = state.videoHasAudio === false ? NO_AUDIO_TEXT : `Не получилось распознать: ${message}`;
    setTranscription(state.videoHasAudio === false ? NO_AUDIO_TEXT : `Не получилось: ${message}`, 0);
  } finally {
    if (active()) {
      state.transcription.busy = false;
      state.transcription.controller = null;
      state.transcription.jobId = null;
      updateUi();
    }
  }
}

/**
 * Речь во всех видео ролика: сервер склеивает звук основного видео и вставок по порядку (без вырезанного),
 * распознаёт его, а текст встаёт по времени готового ролика — как слова песни, через все вставки.
 */
async function transcribeMontage() {
  if (state.transcription.busy || !state.video) return;
  if (textOnlySpeech()) { refuseTextOnlySpeech({ auto: true }); return; }
  const run = state.transcription.run + 1;
  const controller = new AbortController();
  state.transcription = { busy: true, csrf: null, jobId: null, controller, run };
  const active = () => state.transcription.busy && state.transcription.run === run;
  const language = speechLanguage();
  if (language !== "ru" && !state.ai.configured && !server.active) {
    state.transcription = { busy: false, csrf: null, jobId: null, controller: null, run };
    setTranscription(`${speechLanguageName(language)} распознаёт ИИ: сначала подключи ключ ИИ кнопкой «Ключ ИИ» вверху.`, 0);
    updateUi();
    return;
  }
  clearSubtitles();
  state.speechError = "";
  setTranscription(server.active ? "Загружаю видео на сервер…" : "Копирую видео в Reel Lab…", 2);
  updateUi();
  try {
    const { csrf, uploadId } = await uploadSourceVideo(controller.signal);
    if (!active()) return;
    const model = montage();
    const keys = new Set(model.inserts.map((item) => item.mediaKey).filter((key) => key !== SELF_MEDIA));
    const clips = [...keys].map((key) => state.montage.media.get(key)).filter(Boolean);
    if (clips.some((media) => !media.uploadId)) setTranscription("Загружаю остальные видео…", 8);
    await Promise.all(clips.map((media) => uploadClip(media)));
    if (!active()) return;
    const current = montage();
    setTranscription("Собираю звук всего ролика…", 10);
    state.transcription.csrf = csrf;
    const job = await requestJson("/api/montage/transcription", {
      method: "POST",
      headers: { "X-CSRF-Token": csrf, "Content-Type": "application/json" },
      body: JSON.stringify({
        request_id: requestId("montage"), language, upload_id: uploadId, montage: montagePlan(current),
        skips: current.skipsM.ranges.map((range) => ({ start: range.start, end: range.end })),
      }),
      signal: controller.signal,
    });
    if (!active()) return;
    state.transcription.jobId = job.id;
    const length = current.totalO;
    const deadline = Date.now() + 60 * 60 * 1000;
    while (active()) {
      if (Date.now() > deadline) throw new Error("Распознавание заняло слишком много времени.");
      const list = await pollJson("/api/jobs", { signal: controller.signal });
      const now = list?.jobs?.find((item) => item.id === job.id);
      if (!now) throw new Error("Задача распознавания пропала.");
      const percent = Number(now?.progress?.percent);
      setTranscription(now.phase === "QUEUED" ? PHASES.QUEUED : "Слушаю речь во всех видео…", Number.isFinite(percent) ? percent : 15);
      if (now.status === "completed") {
        const response = await fetch(`/api/jobs/${encodeURIComponent(job.id)}/subtitles?format=vtt`, { credentials: "same-origin", signal: controller.signal });
        if (!response.ok) throw new Error(await responseMessage(response, "Не удалось получить текст."));
        const clamp = (time) => Math.min(length, Math.max(0, time));
        const cues = resegmentCues(parseCues(await response.text())).map((cue) => {
          const words = cue.words.filter((word) => /[\p{L}\p{N}]/u.test(word.text))
            .map((word) => ({ ...word, start: clamp(word.start), end: clamp(word.end) }));
          return words.length ? { ...cue, start: Math.min(clamp(cue.start), words[0].start), end: clamp(cue.end), words } : null;
        }).filter((cue) => cue && cue.end - cue.start > 0.05);
        if (!cues.length) throw new Error("речь не найдена — проверь, что у видео включён звук");
        useCues(cues, { base: "O", language,
          label: "Речь распознана во всех видео ролика. Текст стоит по времени готового ролика: если переставишь видео — распознай заново." });
        setTranscription("Текст готов", 100);
        if (state.pendingMagic.length) void runPresetMagic([...state.pendingMagic]);
        window.setTimeout(() => { if (!state.transcription.busy) el.transcription.hidden = true; }, 1200);
        return;
      }
      if (now.status === "failed") throw new Error(now.error || "Не удалось распознать речь.");
      if (now.status === "cancelled") throw new Error("Распознавание остановлено.");
      await wait(1000);
    }
  } catch (error) {
    if (error?.name === "AbortError" || !active()) return;
    const message = String(error?.message || error).replace(/\.$/, "");
    state.speechError = `Не получилось распознать речь во всех видео: ${message}.`;
    setTranscription(state.speechError, 0);
  } finally {
    if (active()) {
      state.transcription.busy = false;
      state.transcription.controller = null;
      state.transcription.jobId = null;
      updateUi();
    }
  }
}

async function cancelTranscription({ quiet = false } = {}) {
  const { busy, jobId, csrf, controller } = state.transcription;
  if (!busy && !jobId) return;
  state.transcription = { busy: false, csrf: null, jobId: null, controller: null, run: state.transcription.run + 1 };
  controller?.abort();
  if (jobId && csrf) {
    try {
      await fetch(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, {
        method: "POST", credentials: "same-origin", headers: { "X-CSRF-Token": csrf, "Content-Type": "application/json" }, body: "{}",
      });
    } catch (_) { /* задача могла уже завершиться */ }
  }
  if (quiet) el.transcription.hidden = true;
  else setTranscription("Распознавание остановлено", 0);
  updateUi();
}

// ---------------------------------------------------------------------------
// Живой предпросмотр

let previewTimer = 0;
let previewRun = 0;

function schedulePreview(delay = 110) {
  window.clearTimeout(previewTimer);
  previewTimer = window.setTimeout(() => { void rebuildPreview(); }, delay);
}

function clearCanvas() {
  const ctx = el.twCanvas.getContext("2d");
  ctx.clearRect(0, 0, el.twCanvas.width, el.twCanvas.height);
}

async function rebuildPreview() {
  const run = ++previewRun;
  invalidateFx();
  if (!state.video || !state.videoSize || !state.cues.length) {
    stylePreview.clear();
    clearCanvas();
    state.preview = { timeline: null, kind: null, images: null, moments: null, events: [], ready: false };
    updateUi();
    return;
  }
  el.loadingVeil.hidden = false;
  try {
    const spec = buildSpec();
    let moments;
    if (isTypewriter()) {
      stylePreview.clear();
      el.captionHost.hidden = true;
      el.twCanvas.hidden = false;
      const options = typewriterOptionsFromSpec(spec);
      await ensureTypewriterFont(options, textSample(spec.cues));
      if (run !== previewRun) return;
      const timeline = buildTimeline(spec.cues, state.videoSize.width, state.videoSize.height, options);
      state.preview.timeline = timeline;
      state.preview.kind = "typewriter";
      moments = soundMomentsFromTypewriter(timeline);
    } else if (isPictures()) {
      stylePreview.clear();
      el.captionHost.hidden = true;
      el.twCanvas.hidden = false;
      const options = previewPictureOptions(spec);
      await ensurePictureFont(options, textSample(spec.cues));
      const images = await preparedPictures(options.pictures.filter((picture) => !picture.url.startsWith("pending:")));
      if (run !== previewRun) return;
      const timeline = buildPictureTimeline(spec.cues, state.videoSize.width, state.videoSize.height, options, images);
      state.preview.images = images;
      state.preview.timeline = timeline;
      state.preview.kind = "pictures";
      moments = soundMomentsFromPictures(timeline);
      drawPicturesList();
    } else {
      el.twCanvas.hidden = true;
      el.captionHost.hidden = false;
      state.preview.timeline = null;
      state.preview.kind = "engine";
      const prepared = await stylePreview.load(spec, state.video, state.videoSize);
      if (!prepared || run !== previewRun) return;
      moments = soundMomentsFromDocument(prepared.doc);
    }
    state.preview.moments = withCutMoments(moments);
    state.preview.ready = true;
    await replanSounds();
    if (run !== previewRun) return;
    drawFrame();
  } catch (error) {
    console.error(error);
    showHint(`Предпросмотр не построился: ${error?.message || error}`);
  } finally {
    if (run === previewRun) el.loadingVeil.hidden = true;
    updateUi();
  }
}

async function replanSounds() {
  if (!state.preview.moments) return;
  try {
    state.preview.events = await planSoundEvents(state.preview.moments, soundSettings());
  } catch (error) {
    console.error(error);
    state.preview.events = [];
  }
  player.setSettings(audioSettings());
  if (state.playing) startSounds();
}

/**
 * Моменты для слоя «Склейки и вставки» (время сборки M): начало и конец каждой
 * вставки и видео поверх и склейки, сделанные человеком. Склейки пауз,
 * которые ИИ режет десятками, не звучат — иначе «вжух» шёл бы каждую секунду.
 * Момент внутри вырезанного куска переносится туда, где ролик продолжается.
 */
function cutMoments(model = montage()) {
  const end = model.totalM;
  const landing = (m) => {
    const range = model.skipsM.rangeAt(m);
    return range ? range.end : m;
  };
  const times = [];
  for (const item of model.inserts) times.push(item.m0, item.m1);
  for (const placement of model.overlays) if (placement.visible !== false) times.push(placement.m0, placement.m1);
  const manual = state.edit.manual || [];
  for (const junction of model.junctions()) {
    if (manual.some((cut) => cut.end > junction.s0 + 0.01 && cut.start < junction.s1 - 0.01)) times.push(junction.m1);
  }
  const result = [];
  for (const time of times.map(landing).sort((a, b) => a - b)) {
    if (!(time > model.firstM + 0.05 && time < end - 0.05)) continue;
    if (result.length && time - result[result.length - 1] < 0.05) continue;
    result.push(time);
  }
  return result;
}

/** Моменты звуков стиля плюс склейки и вставки. */
function withCutMoments(moments, model = montage()) {
  return { ...moments, cuts: cutMoments(model).map((time) => ({ time })) };
}

/** Музыка в предпросмотре идёт по времени готового ролика (после склеек и со вставками), как в MP4. */
function musicPreviewPlan() {
  if (!hasMusic(audioSettings())) return null;
  const model = montage();
  const moments = state.preview.moments && !lyricsMode() ? remapMoments(state.preview.moments, model.skipsM) : { words: [] };
  return planMusic(moments, audioSettings(), model.totalO, model.duckRanges());
}

/** soft — после перехода (склейка, вставка): звучащие звуки доигрывают. */
function startSounds(soft = false) {
  if (!soft) player.stop();
  if (!state.soundOn) {
    player.stop();
    return;
  }
  const music = musicPreviewPlan();
  const model = montage();
  const clips = audioClipsPlan(model);
  if (!state.preview.events.length && !music && !clips.length) {
    player.stop();
    return;
  }
  const time = montagePlayer.time;
  const from = model.toO(time);
  const musicAt = music ? { plan: music, from, until: music.end } : null;
  const clipsAt = clips.length ? { list: clips, from, until: model.totalO, speech: clipSpeech(model) } : null;
  void player.play(state.preview.events, time, el.video.playbackRate || 1, musicAt, { soft, clips: clipsAt }).catch((error) => console.error(error));
}

/** Где звучит голос (время ролика) — под ним музыка с ленты тише. */
function clipSpeech(model = montage()) {
  const moments = state.preview.moments && !lyricsMode() ? remapMoments(state.preview.moments, model.skipsM) : { words: [] };
  return speechIntervals(moments, model.duckRanges());
}

let frameRequest = 0;
let lastCueRow = -1;
let drawSoonRequest = 0;

// Замер скорости предпросмотра (поиск тормозов на конкретном компьютере):
// window.__readyCaptions.perfStart(), поиграть видео, perfReport().
const perf = { on: false, sections: new Map(), gaps: [], lastLoop: 0, startedAt: 0, quality: null };

function perfStart() {
  const quality = el.video.getVideoPlaybackQuality?.();
  Object.assign(perf, {
    on: true, sections: new Map(), gaps: [], lastLoop: 0, startedAt: performance.now(),
    quality: quality ? { dropped: quality.droppedVideoFrames, total: quality.totalVideoFrames } : null,
  });
}

function perfAdd(name, ms) {
  let item = perf.sections.get(name);
  if (!item) perf.sections.set(name, item = { n: 0, total: 0, max: 0 });
  item.n += 1;
  item.total += ms;
  item.max = Math.max(item.max, ms);
}

/** Выполняет кусок кадра и (если идёт замер) записывает, сколько он занял. */
function timed(name, work) {
  if (!perf.on) return work();
  const start = performance.now();
  const result = work();
  perfAdd(name, performance.now() - start);
  return result;
}

function perfReport() {
  const seconds = (performance.now() - perf.startedAt) / 1000;
  const gaps = perf.gaps;
  const quality = el.video.getVideoPlaybackQuality?.();
  const sections = {};
  for (const [name, item] of perf.sections) {
    sections[name] = { avg: +(item.total / item.n).toFixed(2), max: +item.max.toFixed(1), n: item.n };
  }
  perf.on = false;
  return {
    seconds: +seconds.toFixed(1),
    frames: gaps.length,
    fps: +(gaps.length / Math.max(0.001, seconds)).toFixed(1),
    slowFrames: { over20ms: gaps.filter((g) => g > 20).length, over34ms: gaps.filter((g) => g > 34).length, over50ms: gaps.filter((g) => g > 50).length },
    worstGap: +Math.max(0, ...gaps).toFixed(1),
    video: quality && perf.quality ? { dropped: quality.droppedVideoFrames - perf.quality.dropped, decoded: quality.totalVideoFrames - perf.quality.total } : null,
    sections,
  };
}

/** Перерисовать кадр в ближайший кадр экрана (после перемотки, пока стоим). */
function drawFrameSoon() {
  if (drawSoonRequest || state.playing) return;
  drawSoonRequest = requestAnimationFrame(() => {
    drawSoonRequest = 0;
    if (!state.playing) drawFrame();
  });
}

function drawFrame() {
  const frameStart = perf.on ? performance.now() : 0;
  if (state.playing) {
    timed("tick", () => montagePlayer.tick());
    if (stopPreviewAt != null && montagePlayer.time >= stopPreviewAt) {
      stopPreviewAt = null;
      montagePlayer.pause();
    }
  }
  const model = montage();
  const t = montagePlayer.time;
  timed("fx", () => drawFxLayers(t));
  // Пока тянут край куска, в кадре — кадр с края; субтитры не мешают.
  const peeking = montagePlayer.peeking;
  el.captionHost.style.visibility = peeking ? "hidden" : "";
  timed("captions", () => {
    if (peeking) {
      el.twCanvas.getContext("2d").clearRect(0, 0, el.twCanvas.width, el.twCanvas.height);
    } else if (isTypewriter() && state.preview.kind === "typewriter" && state.preview.timeline) {
      const ctx = el.twCanvas.getContext("2d");
      ctx.clearRect(0, 0, el.twCanvas.width, el.twCanvas.height);
      drawTypewriter(ctx, state.preview.timeline, t);
    } else if (isPictures() && state.preview.kind === "pictures" && state.preview.timeline) {
      const ctx = el.twCanvas.getContext("2d");
      ctx.clearRect(0, 0, el.twCanvas.width, el.twCanvas.height);
      drawPictureWords(ctx, state.preview.timeline, t);
      markPicturesRow(model.sourceAt(t) ?? -1);
    } else if (!isTypewriter() && !isPictures()) {
      if (!perf.on) void stylePreview.drawAt(t);
      else {
        const start = performance.now();
        void stylePreview.drawAt(t).then(() => perfAdd("captionsEngineAsync", performance.now() - start));
      }
    }
  });
  timed("ribbon", () => updateRibbon(t));
  timed("timelineSet", () => timeline.setTime(model.toO(t)));
  if (!state.playing) {
    composer.refresh();
    updateTimelineToolbar();
  }
  if (perf.on) perfAdd("drawFrame", performance.now() - frameStart);
  el.timeNow.textContent = formatClock(model.toO(t));
  const s = model.sourceAt(t);
  let row = -1;
  if (s != null) {
    for (let i = 0; i < state.cues.length; i += 1) {
      if (s >= state.cues[i].start - 0.05 && s < state.cues[i].end + 0.3) row = i;
    }
  }
  if (row !== lastCueRow) {
    const rows = el.cueList.querySelectorAll(".cue-row");
    rows[lastCueRow]?.classList.remove("is-now");
    rows[row]?.classList.add("is-now");
    lastCueRow = row;
  }
}

function loop() {
  if (perf.on) {
    const now = performance.now();
    if (perf.lastLoop) perf.gaps.push(now - perf.lastLoop);
    perf.lastLoop = now;
  }
  drawFrame();
  if (state.playing) frameRequest = requestAnimationFrame(loop);
}

async function togglePlay() {
  if (!el.video.src) return;
  if (state.playing) {
    montagePlayer.pause();
    return;
  }
  try {
    await player.resume();
  } catch (_) { /* звук включится после следующего нажатия */ }
  montagePlayer.clearPeek();
  el.video.volume = Math.min(1, state.voice);
  await montagePlayer.play();
}

function pausePreview() {
  montagePlayer.pause();
}

/** Перемотка по времени исходника (текст, склейки, моменты). */
function seekTo(time) {
  if (!state.duration) return;
  seekM(montage().toM(Math.max(0, Math.min(state.duration - 0.01, time))));
}

/** Перемотка к слову текста: речь — по времени исходника, свой текст — по времени ролика. */
function seekText(time) {
  if (lyricsMode()) seekO(time);
  else seekTo(time);
}

/** Перемотка по времени сборки (M). */
function seekM(m) {
  montagePlayer.clearPeek({ restore: false });
  montagePlayer.seek(m);
  if (!state.playing) drawFrame();
}

/** Перемотка по времени готового ролика (лента, бегунок). */
function seekO(o) {
  seekM(montage().fromO(o));
}

const onStop = () => {
  state.playing = false;
  el.playButton.classList.remove("is-playing");
  el.playButton.setAttribute("aria-label", "Смотреть");
  player.stop();
  timeline.setPlaying(false);
  cancelAnimationFrame(frameRequest);
  drawFrame();
};

/** События предпросмотра: исходник, вставки и видео поверх играют как один ролик. */
function onPlayerEvent(type, detail) {
  if (type === "play") {
    state.playing = true;
    composer.clear();
    composer.refresh();
    el.playButton.classList.add("is-playing");
    el.playButton.setAttribute("aria-label", "Пауза");
    timeline.setPlaying(true);
    startSounds();
    cancelAnimationFrame(frameRequest);
    loop();
  } else if (type === "pause") {
    onStop();
  } else if (type === "ended") {
    drawFrame();
  } else if (type === "seek") {
    if (state.playing) player.stop();
  } else if (type === "jump") {
    if (state.playing) startSounds(true);
  } else if (type === "waiting") {
    player.stop();
  } else if (type === "playing") {
    if (state.playing) startSounds();
  } else if (type === "frame") {
    if (state.playing) {
      if (detail?.key === montagePlayer.activeKey()) startSounds(true);
    } else drawFrameSoon();
  } else if (type === "error") {
    showHint(`Видео не запустилось: ${detail?.message || detail}`);
  }
}

// --- Лента слов -------------------------------------------------------------

let ribbonWords = [];
let ribbonPhrases = [];
let ribbonIndex = -1;

function drawRibbon() {
  el.ribbonTrack.innerHTML = "";
  ribbonWords = [];
  ribbonPhrases = [];
  ribbonIndex = -1;
  if (!state.duration) return;
  // Лента — время готового ролика: вырезанного нет, на его месте — отметка склейки.
  const model = montage();
  const total = model.totalO;
  if (!(total > 0)) return;
  const pct = (o) => `${(o / total) * 100}%`;
  const fragment = document.createDocumentFragment();
  for (const piece of model.insertPiecesO()) {
    const block = document.createElement("div");
    block.className = "ribbon-insert";
    block.style.left = pct(piece.o0);
    block.style.width = `${Math.max(0.4, ((piece.o1 - piece.o0) / total) * 100)}%`;
    fragment.append(block);
  }
  for (const junction of model.junctions()) {
    if (junction.o <= 0.01 || junction.o >= total - 0.01) continue;
    const mark = document.createElement("div");
    mark.className = "ribbon-junction";
    mark.style.left = pct(junction.o);
    fragment.append(mark);
  }
  for (const cue of state.cues) {
    const words = cue.words.map((word) => {
      if (lyricsMode()) return { word, o0: word.start, o1: word.end };
      const m0 = model.toM(word.start);
      const mid = m0 + (word.end - word.start) / 2;
      if (model.isSkippedM(mid)) return null;
      return { word, o0: model.toO(m0), o1: model.toO(m0 + (word.end - word.start)) };
    }).filter(Boolean);
    if (!words.length) continue;
    const phrase = document.createElement("div");
    phrase.className = "ribbon-phrase";
    const start = words[0].o0;
    const end = words[words.length - 1].o1;
    phrase.style.left = pct(start);
    phrase.style.width = `${Math.max(0.3, ((end - start) / total) * 100)}%`;
    fragment.append(phrase);
    ribbonPhrases.push({ el: phrase, start, end });
    for (const item of words) {
      const bar = document.createElement("div");
      bar.className = `ribbon-word${isKeyword(item.word.text) ? " is-key" : ""}`;
      bar.style.left = pct(item.o0);
      bar.style.width = `${Math.max(0.15, ((item.o1 - item.o0) / total) * 100 * 0.86)}%`;
      bar.title = item.word.text;
      fragment.append(bar);
      ribbonWords.push({ el: bar, start: item.o0, end: item.o1 });
    }
  }
  ribbonWords.sort((a, b) => a.start - b.start);
  el.ribbonTrack.append(fragment);
  updateRibbon(montagePlayer.time, true);
}

/** t — время сборки (M); на ленте — время ролика. */
function updateRibbon(t, force = false) {
  const model = montage();
  const total = model.totalO || 0;
  const o = model.toO(t);
  el.playhead.style.left = total ? `${(o / total) * 100}%` : "0";
  el.ribbon.setAttribute("aria-valuenow", String(Math.round(total ? (o / total) * 100 : 0)));
  let index = -1;
  let lo = 0;
  let hi = ribbonWords.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ribbonWords[mid].start <= o) {
      index = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (index !== ribbonIndex || force) {
    const from = force ? 0 : Math.min(index, ribbonIndex) + 1;
    const to = force ? ribbonWords.length - 1 : Math.max(index, ribbonIndex);
    for (let i = Math.max(0, from - 1); i <= Math.min(ribbonWords.length - 1, to + 1); i += 1) {
      ribbonWords[i].el.classList.toggle("is-past", i <= index);
    }
    ribbonIndex = index;
  }
  ribbonWords.forEach((word, i) => {
    if (Math.abs(i - index) > 1) return;
    word.el.classList.toggle("is-now", o >= word.start && o < word.end);
  });
  for (const phrase of ribbonPhrases) phrase.el.classList.toggle("is-now", o >= phrase.start && o < phrase.end);
}

function ribbonSeek(event) {
  const rect = el.ribbon.getBoundingClientRect();
  const fraction = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  seekO(fraction * (montage().totalO || 0));
}

el.ribbon.addEventListener("pointerdown", (event) => {
  if (!state.duration) return;
  el.ribbon.setPointerCapture(event.pointerId);
  ribbonSeek(event);
});
el.ribbon.addEventListener("pointermove", (event) => {
  if (el.ribbon.hasPointerCapture(event.pointerId)) ribbonSeek(event);
});
el.ribbon.addEventListener("keydown", (event) => {
  const now = montage().toO(montagePlayer.time);
  if (event.key === "ArrowRight") seekO(now + 1);
  if (event.key === "ArrowLeft") seekO(Math.max(0, now - 1));
});

// ---------------------------------------------------------------------------
// Галерея стилей

const thumbObserver = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (entry.isIntersecting) entry.target.play().catch(() => {});
    else entry.target.pause();
  }
}, { threshold: 0.4 });

function typeThumb(values, colors, fontId) {
  const font = fontById(fontId) || fontById("montserrat");
  const v = normaliseBuilder(values);
  const text = v.textCase === "uppercase" ? "ТВОЙ СТИЛЬ" : "Твой стиль";
  const bg = v.background === "box" ? `background:${v.bgColor};padding:.3em .55em;border-radius:${v.radius}em;` : "";
  return `<span class="thumb-type"><span style="font-family:${escapeHtml(font.family)};font-weight:${v.weight};color:${escapeHtml(colors?.primary || "#fff")};${bg}letter-spacing:${v.letterSpacing}em">${text.split(" ")[0]} <b style="color:${escapeHtml(colors?.highlight || "#ffd76a")}">${text.split(" ")[1]}</b></span></span>`;
}

function styleCardHtml(template) {
  const selected = template.id === state.styleId;
  const y = Math.min(100, Math.max(0, Number(template.layout?.verticalOffset ?? 0.75) * 100));
  let thumb;
  if (template.id === PICTURES_ID) {
    thumb = '<span class="thumb-pictures"><span class="tp-heart"></span><span class="tp-a">Загляни<br>в своё <b>сердце</b></span><span class="tp-b">✦ ИИ</span></span>';
  } else if (template.id === KARAOKE_ID) {
    const colors = settings(KARAOKE_ID).colors;
    thumb = `<span class="thumb-karaoke" style="--k-base:${escapeHtml(colors.primary)};--k-fill:${escapeHtml(colors.highlight)}"><span class="tk-line"><span class="tk-word" style="--d:0s">Пой</span> <span class="tk-word" style="--d:.7s">со</span> <span class="tk-word" style="--d:1.2s">мной</span></span></span>`;
  } else if (template.id === CUSTOM_ID) {
    const values = state.builders[CUSTOM_ID];
    thumb = typeThumb(values, settings(CUSTOM_ID).colors, settings(CUSTOM_ID).font);
  } else if (template.saved) {
    thumb = typeThumb(template.saved.values, template.saved.colors, template.saved.font);
  } else {
    thumb = `<video src="${ASSET_ROOT}/previews/${encodeURIComponent(template.id)}.mp4" poster="${ASSET_ROOT}/previews/${encodeURIComponent(template.id)}.png" muted loop playsinline preload="none"></video>`;
  }
  return `
    <button type="button" class="style-card${selected ? " is-selected" : ""}" data-style-id="${escapeHtml(template.id)}" aria-pressed="${selected}">
      <span class="style-thumb" style="--thumb-y:${y}%">${thumb}${selected ? '<span class="style-badge">Выбран</span>' : ""}${template.badge || template.isNew ? `<span class="style-new">${escapeHtml(template.badge || "Новое · ИИ")}</span>` : ""}</span>
      <span class="style-copy">
        <span class="style-name">${escapeHtml(template.label_ru || template.source_name || template.id)}</span>
        <span class="style-note">${escapeHtml(template.note_ru || "")}</span>
      </span>
      ${template.saved ? `<span class="style-delete" role="button" tabindex="0" data-delete="${escapeHtml(template.id)}" aria-label="Удалить стиль">×</span>` : ""}
    </button>`;
}

function drawStyles() {
  const ready = [PICTURES_TEMPLATE, TYPEWRITER_TEMPLATE, KARAOKE_TEMPLATE, ...manifestTemplates()];
  el.styleCounter.textContent = stylesRu(ready.length);
  el.styleGrid.innerHTML = ready.map(styleCardHtml).join("");
  el.customGrid.innerHTML = [CUSTOM_TEMPLATE, ...state.savedStyles.map(savedTemplate)].map(styleCardHtml).join("");
  el.simpleStyleGrid.innerHTML = [...ready, ...state.savedStyles.map(savedTemplate)].map(styleCardHtml).join("");
  for (const grid of [el.styleGrid, el.customGrid, el.simpleStyleGrid]) {
    grid.querySelectorAll("video").forEach((video) => {
      video.addEventListener("error", () => {
        const image = document.createElement("img");
        image.src = video.poster;
        image.alt = "";
        video.replaceWith(image);
      }, { once: true });
      if (thumbObserver) thumbObserver.observe(video);
    });
  }
}

function onStyleGridClick(event) {
  const remove = event.target.closest("[data-delete]");
  if (remove) {
    event.stopPropagation();
    deleteSavedStyle(remove.dataset.delete);
    return;
  }
  const card = event.target.closest(".style-card");
  if (card) selectStyle(card.dataset.styleId);
}

function selectStyle(id) {
  if (!templateById(id)) return;
  state.styleId = id;
  settings(id);
  builderValues(id);
  hideResult();
  drawStyles();
  syncTune();
  drawSoundPanel();
  schedulePreview(0);
  maybeAutoPictures();
}

// ---------------------------------------------------------------------------
// Настройка

function syncTune() {
  const template = currentTemplate();
  const ps = settings();
  el.tuneTitle.textContent = template.label_ru || "Стиль";
  el.fontSelect.innerHTML = fontOptionsHtml(ps.font, isCustom() ? "Montserrat" : "Как в стиле");
  el.accentFontSelect.innerHTML = fontOptionsHtml(ps.accent, "Как в стиле");
  el.accentFontField.hidden = !(template.accent_font || isCustom());
  el.primaryColor.value = ps.colors.primary;
  el.highlightColor.value = ps.colors.highlight;
  el.sizeScale.value = String(Math.round(ps.sizeScale * 100));
  el.sizeScaleValue.textContent = `${Math.round(ps.sizeScale * 100)}%`;
  setSeg(el.positionSeg, "position", ps.position);
  const height = alignmentFor(template, ps).verticalOffset;
  el.heightSlider.value = String(Math.round(height * 100));
  el.heightValue.textContent = `${Math.round(height * 100)}%`;
  setSeg(el.phraseLengthSeg, "length", ps.phraseLength);
  el.phraseLengthField.hidden = isTypewriter() || isPictures();
  el.positionSeg.closest(".field").hidden = isPictures();
  el.heightSlider.closest(".field").hidden = isPictures();
  if (isPictures()) el.accentFontField.hidden = true;
  el.typewriterBlock.hidden = !isTypewriter();
  el.picturesBlock.hidden = !isPictures();
  if (isPictures()) syncPicturesControls();
  el.builderBlock.hidden = !isCustom();
  if (isCustom()) drawBuilder();
  document.querySelectorAll('input[type="range"]').forEach(setRangeFill);
}

function onTuneChange({ rebuild = true } = {}) {
  hideResult();
  if (isCustom()) drawStylesSoon();
  if (rebuild) schedulePreview();
}

let stylesTimer = 0;
function drawStylesSoon() {
  window.clearTimeout(stylesTimer);
  stylesTimer = window.setTimeout(drawStyles, 250);
}

async function loadFontFor(id) {
  const font = fontById(id);
  if (!font || !document.fonts) return;
  try {
    await document.fonts.load(`${font.weight} 48px ${font.family}`, "Абв Abc 123");
  } catch (_) { /* загрузится при сборке */ }
}

function wireTune() {
  el.fontSelect.addEventListener("change", async () => {
    settings().font = el.fontSelect.value;
    await loadFontFor(el.fontSelect.value);
    onTuneChange();
  });
  el.accentFontSelect.addEventListener("change", async () => {
    settings().accent = el.accentFontSelect.value;
    await loadFontFor(el.accentFontSelect.value);
    onTuneChange();
  });
  el.primaryColor.addEventListener("input", () => {
    settings().colors.primary = el.primaryColor.value;
    onTuneChange();
  });
  el.highlightColor.addEventListener("input", () => {
    settings().colors.highlight = el.highlightColor.value;
    onTuneChange();
  });
  el.sizeScale.addEventListener("input", () => {
    settings().sizeScale = Number(el.sizeScale.value) / 100;
    el.sizeScaleValue.textContent = `${el.sizeScale.value}%`;
    setRangeFill(el.sizeScale);
    onTuneChange();
  });
  el.positionSeg.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-position]");
    if (!button) return;
    const ps = settings();
    ps.position = button.dataset.position;
    ps.height = null;
    ps.x = null;
    syncTune();
    onTuneChange();
  });
  el.heightSlider.addEventListener("input", () => {
    settings().height = Number(el.heightSlider.value) / 100;
    el.heightValue.textContent = `${el.heightSlider.value}%`;
    setRangeFill(el.heightSlider);
    onTuneChange();
  });
  el.phraseLengthSeg.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-length]");
    if (!button) return;
    settings().phraseLength = button.dataset.length;
    setSeg(el.phraseLengthSeg, "length", button.dataset.length);
    onTuneChange();
  });
  el.resetTune.addEventListener("click", () => {
    const sound = settings().sound;
    state.perStyle[state.styleId] = { ...defaultsFor(currentTemplate()), sound };
    if (state.styleId === CUSTOM_ID) {
      const preset = BUILDER_PRESETS.find((item) => item.id === state.builderPreset[CUSTOM_ID]) || BUILDER_PRESETS[0];
      applyPreset(preset, { silent: true });
    }
    syncTune();
    onTuneChange();
  });

  // Печатная машинка
  const tw = state.typewriter;
  el.twSpeed.addEventListener("input", () => {
    tw.maxCharsPerSecond = Number(el.twSpeed.value);
    el.twSpeedValue.textContent = el.twSpeed.value;
    setRangeFill(el.twSpeed);
    onTuneChange();
  });
  el.twSoft.addEventListener("input", () => {
    tw.softness = Number(el.twSoft.value) / 100;
    el.twSoftValue.textContent = `${el.twSoft.value}%`;
    setRangeFill(el.twSoft);
    onTuneChange();
  });
  el.twBlink.addEventListener("change", () => {
    tw.cursorBlink = el.twBlink.checked;
    onTuneChange();
  });
  const seg = (container, key) => container.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-value]");
    if (!button) return;
    tw[key] = button.dataset.value;
    setSeg(container, "value", button.dataset.value);
    onTuneChange();
  });
  seg(el.twCursorSeg, "cursor");
  seg(el.twAlignSeg, "align");
  seg(el.twOutroSeg, "outro");
}

// --- Конструктор -------------------------------------------------------------

const BUILDER_GROUPS = [
  {
    title: "Текст",
    controls: [
      { key: "fontSize", label: "Размер", type: "range", min: 2.4, max: 8, step: 0.1, format: (v) => `${v.toFixed(1)}` },
      { key: "weight", label: "Насыщенность", type: "range", min: 300, max: 900, step: 100, format: (v) => String(v) },
      { key: "letterSpacing", label: "Между буквами", type: "range", min: -0.04, max: 0.3, step: 0.01, format: (v) => v.toFixed(2) },
      { key: "textCase", label: "Регистр", type: "seg" },
    ],
  },
  {
    title: "Обводка и тень",
    controls: [
      { key: "outlineWidth", label: "Обводка", type: "range", min: 0, max: 0.14, step: 0.005, format: (v) => (v ? v.toFixed(3) : "нет") },
      { key: "outlineColor", label: "Цвет обводки", type: "color" },
      { key: "shadow", label: "Тень", type: "seg" },
    ],
  },
  {
    title: "Подложка",
    controls: [
      { key: "background", label: "Под текстом", type: "seg" },
      { key: "bgColor", label: "Цвет подложки", type: "color", when: (v) => v.background !== "none" },
      { key: "bgOpacity", label: "Плотность", type: "range", min: 0, max: 1, step: 0.02, format: (v) => `${Math.round(v * 100)}%`, when: (v) => v.background !== "none" },
      { key: "radius", label: "Скругление", type: "range", min: 0, max: 1.4, step: 0.05, format: (v) => v.toFixed(2), when: (v) => v.background !== "none" },
    ],
  },
  {
    title: "Активное слово",
    controls: [
      { key: "active", label: "Чем выделено", type: "seg" },
      { key: "dimFuture", label: "Приглушать слова, которые ещё не прозвучали", type: "toggle" },
      { key: "emphasisScale", label: "Ключевые слова крупнее", type: "range", min: 1, max: 1.6, step: 0.02, format: (v) => `${Math.round(v * 100)}%` },
    ],
  },
  {
    title: "Анимация",
    controls: [
      { key: "wordIn", label: "Как появляется слово", type: "select" },
      { key: "phraseIn", label: "Как появляется фраза", type: "seg" },
      { key: "phraseOut", label: "Как уходит фраза", type: "seg" },
      { key: "speed", label: "Длительность", type: "range", min: 0.12, max: 1.2, step: 0.02, format: (v) => `${v.toFixed(2)} с` },
    ],
  },
];

function drawBuilder() {
  const id = state.styleId;
  const values = builderValues(id);
  el.builderPresets.innerHTML = BUILDER_PRESETS.map((preset) => (
    `<button type="button" class="chip${state.builderPreset[id] === preset.id ? " is-active" : ""}" data-preset="${preset.id}">${escapeHtml(preset.label)}</button>`
  )).join("");
  el.builderControls.innerHTML = BUILDER_GROUPS.map((group) => `
    <div class="builder-group">
      <h3>${escapeHtml(group.title)}</h3>
      ${group.controls.filter((control) => !control.when || control.when(values)).map((control) => builderControlHtml(control, values)).join("")}
    </div>`).join("");
  el.builderControls.querySelectorAll('input[type="range"]').forEach(setRangeFill);
  const saved = state.savedStyles.find((item) => item.id === id);
  el.builderName.value = saved ? saved.name : "";
  el.builderSave.textContent = saved ? "Обновить" : "Сохранить";
}

function builderControlHtml(control, values) {
  const value = values[control.key];
  if (control.type === "range") {
    return `<div class="field"><label>${escapeHtml(control.label)} <output>${escapeHtml(control.format(Number(value)))}</output></label>
      <input type="range" data-bkey="${control.key}" min="${control.min}" max="${control.max}" step="${control.step}" value="${value}"></div>`;
  }
  if (control.type === "color") {
    return `<label class="swatch"><input type="color" data-bkey="${control.key}" value="${escapeHtml(value)}"><span>${escapeHtml(control.label)}</span></label>`;
  }
  if (control.type === "toggle") {
    return `<label class="toggle"><input type="checkbox" data-bkey="${control.key}"${value ? " checked" : ""}><span>${escapeHtml(control.label)}</span></label>`;
  }
  const options = BUILDER_OPTIONS[control.key] || [];
  if (control.type === "select") {
    return `<div class="field"><label>${escapeHtml(control.label)}</label><select data-bkey="${control.key}">${options.map(([id, label]) => `<option value="${id}"${id === value ? " selected" : ""}>${escapeHtml(label)}</option>`).join("")}</select></div>`;
  }
  return `<div class="field"><span class="field-label">${escapeHtml(control.label)}</span><div class="seg" data-bseg="${control.key}">${options.map(([id, label]) => `<button type="button" data-value="${id}" class="${id === value ? "is-active" : ""}">${escapeHtml(label)}</button>`).join("")}</div></div>`;
}

function applyPreset(preset, { silent = false } = {}) {
  const id = state.styleId;
  state.builders[id] = normaliseBuilder({ ...BUILDER_DEFAULTS, ...preset.values, name: state.builders[id]?.name || BUILDER_DEFAULTS.name });
  state.builderPreset[id] = preset.id;
  const ps = settings(id);
  ps.colors = { ...preset.colors };
  ps.font = preset.font || "";
  if (!silent) {
    void loadFontFor(ps.font);
    syncTune();
    onTuneChange();
  }
}

function wireBuilder() {
  el.builderPresets.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-preset]");
    if (!button) return;
    const preset = BUILDER_PRESETS.find((item) => item.id === button.dataset.preset);
    if (preset) applyPreset(preset);
  });
  const update = (key, value, redraw = false) => {
    const values = builderValues();
    values[key] = value;
    Object.assign(values, normaliseBuilder(values));
    state.builderPreset[state.styleId] = null;
    el.builderPresets.querySelectorAll(".chip").forEach((chip) => chip.classList.remove("is-active"));
    if (redraw) drawBuilder();
    onTuneChange();
  };
  el.builderControls.addEventListener("input", (event) => {
    const input = event.target.closest("[data-bkey]");
    if (!input) return;
    const key = input.dataset.bkey;
    if (input.type === "range") {
      const value = Number(input.value);
      const control = BUILDER_GROUPS.flatMap((group) => group.controls).find((item) => item.key === key);
      const output = input.parentElement.querySelector("output");
      if (output && control) output.textContent = control.format(value);
      setRangeFill(input);
      update(key, value);
    } else if (input.type === "color") update(key, input.value);
  });
  el.builderControls.addEventListener("change", (event) => {
    const input = event.target.closest("[data-bkey]");
    if (!input) return;
    if (input.type === "checkbox") update(input.dataset.bkey, input.checked);
    if (input.tagName === "SELECT") update(input.dataset.bkey, input.value);
  });
  el.builderControls.addEventListener("click", (event) => {
    const button = event.target.closest("[data-bseg] button[data-value]");
    if (!button) return;
    const key = button.closest("[data-bseg]").dataset.bseg;
    update(key, button.dataset.value, key === "background");
  });
  el.builderSave.addEventListener("click", saveCurrentStyle);
}

function saveCurrentStyle() {
  const id = state.styleId;
  const values = builderValues(id);
  const name = (el.builderName.value || "").trim() || `Мой стиль ${state.savedStyles.length + 1}`;
  const ps = settings(id);
  const existing = state.savedStyles.find((item) => item.id === id);
  if (existing) {
    Object.assign(existing, { name, values: { ...values, name }, colors: { ...ps.colors }, font: ps.font });
  } else {
    const newId = `my-${Date.now().toString(36)}`;
    const saved = { id: newId, name, values: { ...values, name }, colors: { ...ps.colors }, font: ps.font };
    state.savedStyles.unshift(saved);
    state.builders[newId] = normaliseBuilder(saved.values);
    state.perStyle[newId] = JSON.parse(JSON.stringify(ps));
    state.styleId = newId;
  }
  const stored = saveStyles(state.savedStyles);
  el.builderSaved.hidden = false;
  el.builderSaved.textContent = stored
    ? `Стиль «${name}» сохранён в этом браузере.`
    : `Стиль «${name}» добавлен, но браузер не разрешил сохранить его надолго.`;
  drawStyles();
  syncTune();
}

function deleteSavedStyle(id) {
  state.savedStyles = state.savedStyles.filter((item) => item.id !== id);
  delete state.builders[id];
  delete state.perStyle[id];
  saveStyles(state.savedStyles);
  if (state.styleId === id) selectStyle(CUSTOM_ID);
  else drawStyles();
}

// ---------------------------------------------------------------------------
// Звук

let soundManifest = null;

const SPEAKER_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>';

// Подсказки слоёв там, где стиль понимает их по-своему.
const LAYER_HINTS = {
  [TYPEWRITER_ID]: { typing: "На каждую напечатанную букву" },
  [PICTURES_ID]: { word: "На каждое слово", accent: "Когда появляется картинка" },
};

function currentSoundSet() {
  return soundManifest ? styleSounds(soundManifest, soundStyleKey()) : null;
}

function soundLabel(id) {
  const real = resolveSoundId(soundManifest, id);
  return soundManifest?.sounds.find((sound) => sound.id === real)?.label || id;
}

function soundLayerOrder() {
  return isTypewriter() ? ["typing", "word", "phrase", "accent", "cut"] : ["word", "phrase", "accent", "typing", "cut"];
}

function kitSummary(value) {
  return soundLayerOrder()
    .filter((id) => !SOUND_LAYERS.find((layer) => layer.id === id)?.independent)
    .map((id) => value.layers[id])
    .filter((layer) => layer?.sound && Number(layer.volume) > 0)
    .map((layer) => soundLabel(layer.sound).toLowerCase())
    .join(" · ");
}

function silentSound() {
  const layers = {};
  for (const { id } of SOUND_LAYERS) layers[id] = { sound: "", volume: soundSettings().layers[id]?.volume ?? 0.5 };
  return { layers };
}

/** Готовые наборы стиля одной строкой; выбранный подсвечен. */
function kitsHtml(compact) {
  const current = soundSettings();
  const html = (currentSoundSet()?.kits || []).map((kit) => {
    const value = kitSettings(soundManifest, soundStyleKey(), kit, state.soundRemoved);
    const active = sameSound(current, value);
    const summary = compact ? "" : `<span>${escapeHtml(kitSummary(value))}</span>`;
    return `<button type="button" class="kit${active ? " is-active" : ""}" data-kit="${escapeHtml(kit.id)}" aria-pressed="${active}"><b>${escapeHtml(kit.label)}</b>${summary}</button>`;
  });
  const silent = !hasActiveSound(current);
  html.push(`<button type="button" class="kit kit-off${silent ? " is-active" : ""}" data-kit="none" aria-pressed="${silent}"><b>Без звука</b>${compact ? "" : "<span>только голос</span>"}</button>`);
  return html.join("");
}

/** Звуки слоя: подходящие стилю (без убранных), выбранный — всегда на виду. */
function layerChipsHtml(layerId, config) {
  const suggested = currentSoundSet()?.sounds?.[layerId] || SOUND_LAYERS.find((layer) => layer.id === layerId)?.suggest || [];
  let ids = suggested.filter((id) => !state.soundRemoved.has(id));
  if (config.sound && !ids.includes(config.sound)) ids = [config.sound, ...ids];
  const chips = [`<button type="button" class="schip schip-off${config.sound ? "" : " is-active"}" data-pick="${layerId}" data-sound="" aria-pressed="${!config.sound}">Без звука</button>`];
  for (const id of ids) {
    const active = id === config.sound;
    chips.push(`<button type="button" class="schip${active ? " is-active" : ""}" data-pick="${layerId}" data-sound="${escapeHtml(id)}" aria-pressed="${active}" title="Выбрать и послушать"><i>${SPEAKER_ICON}</i>${escapeHtml(soundLabel(id))}</button>`);
  }
  if (soundManifest) {
    chips.push(`<button type="button" class="schip schip-more" data-more="${layerId}">Все звуки…</button>`);
    chips.push(`<button type="button" class="schip schip-more" data-own="${layerId}" title="Загрузить файл или взять кусок из видео">＋ Свой звук</button>`);
  }
  return chips.join("");
}

function drawSoundPanel() {
  const sound = soundSettings();
  const hasKits = Boolean(currentSoundSet()?.kits?.length);
  el.soundKits.hidden = !hasKits;
  el.soundKits.innerHTML = hasKits ? kitsHtml(false) : "";
  const hints = LAYER_HINTS[state.styleId] || {};
  el.soundLayers.innerHTML = soundLayerOrder().map((layerId) => {
    const layer = SOUND_LAYERS.find((item) => item.id === layerId);
    const config = sound.layers[layerId];
    const volume = Math.round(Number(config.volume) * 100);
    return `
      <div class="sound-layer${config.sound ? "" : " is-off"}" data-layer="${layerId}">
        <div class="sound-head"><b>${escapeHtml(layer.label)}</b><span>${escapeHtml(hints[layerId] || layer.hint)}</span></div>
        <div class="sound-chips" role="group" aria-label="${escapeHtml(layer.label)}">${layerChipsHtml(layerId, config)}</div>
        <div class="sound-volume"${config.sound ? "" : " hidden"}>
          <input type="range" data-volume="${layerId}" min="0" max="100" step="1" value="${volume}" aria-label="Громкость: ${escapeHtml(layer.label)}">
          <output>${volume}%</output>
        </div>
      </div>`;
  }).join("");
  el.soundLayers.querySelectorAll('input[type="range"]').forEach(setRangeFill);
  drawSimpleKits();
}

function drawSimpleKits() {
  const hasKits = Boolean(currentSoundSet()?.kits?.length);
  el.simpleSound.hidden = !hasKits;
  el.simpleKits.innerHTML = hasKits ? kitsHtml(true) : "";
}

let replanTimer = 0;
function replanSoon() {
  window.clearTimeout(replanTimer);
  replanTimer = window.setTimeout(() => { void replanSounds(); }, 120);
}

function applySound(value, { listen = true } = {}) {
  settings().sound = value;
  hideResult();
  drawSoundPanel();
  replanSoon();
  if (listen && hasActiveSound(value)) void player.auditionKit(value);
  else player.stopAudition();
}

function applyKit(kitId) {
  if (kitId === "none") {
    applySound(silentSound(), { listen: false });
    return;
  }
  const kit = (currentSoundSet()?.kits || []).find((item) => item.id === kitId);
  if (!kit) return;
  const value = kitSettings(soundManifest, soundStyleKey(), kit, state.soundRemoved);
  // Слои вне наборов (звук склеек) человек настраивает сам — набор их не трогает.
  for (const layer of SOUND_LAYERS) {
    const current = soundSettings().layers[layer.id];
    if (layer.independent && current) value.layers[layer.id] = { ...current };
  }
  applySound(value);
}

function pickSound(layerId, soundId) {
  const layer = soundSettings().layers[layerId];
  if (!layer) return;
  const changed = layer.sound !== soundId;
  layer.sound = soundId;
  if (soundId && !(layer.volume > 0)) layer.volume = 0.5;
  if (changed) {
    hideResult();
    drawSoundPanel();
    replanSoon();
  }
  if (soundId) void player.audition(soundId, layerId, layer.volume);
  else player.stopAudition();
}

const clipEditor = new SoundClipEditor({ request: (url, options) => apiJson(url, options) });

/** Файл со звуком (аудио или видео) уходит на сервер как источник для выбора куска. */
async function uploadSoundSource(file) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(`/api/sounds/sources?name=${encodeURIComponent(file.name || "sound")}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "X-CSRF-Token": await csrfToken(attempt > 0), "Content-Type": file.type || "application/octet-stream" },
      body: file,
    });
    if (response.ok) {
      const data = await response.json();
      return { source: data.id, name: data.name, duration: Number(data.duration) || 0 };
    }
    let payload = null;
    try { payload = await response.clone().json(); } catch (_) { /* не JSON */ }
    if (payload?.code === "csrf_stale" && attempt === 0) continue;
    throw new Error(await responseMessage(response, "Не удалось загрузить файл."));
  }
  throw new Error("Сессия устарела. Обнови страницу.");
}

function pickSoundFile() {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "audio/*,video/*,.mp3,.m4a,.wav,.ogg,.oga,.opus,.flac,.aac,.mp4,.mov,.webm,.mkv";
    input.addEventListener("cancel", () => resolve(null), { once: true });
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      soundBoard.flash(`Загружаю «${file.name}»…`);
      try {
        const source = await uploadSoundSource(file);
        soundBoard.flash("");
        resolve(source);
      } catch (error) {
        soundBoard.flash(error?.message || String(error));
        resolve(null);
      }
    }, { once: true });
    input.click();
  });
}

/** Звук прямо из видео в студии: видео один раз загружается на этот компьютер-сервер. */
async function studioVideoSource() {
  if (!state.video) return null;
  if (!state.uploadId) {
    soundBoard.flash("Готовлю видео…");
    await sessionCsrf();
    soundBoard.flash("");
  }
  return { upload: state.uploadId, name: state.video.name || "видео" };
}

async function reloadSounds() {
  soundManifest = await reloadOwnSounds();
  drawSoundPanel();
  drawMusic();
  return soundManifest;
}

const soundBoard = new SoundBoard({
  player,
  styleLabel: (key) => (key === CUSTOM_ID ? "Свой стиль" : templateById(key)?.label_ru || key),
  onPick: (layerId, soundId) => {
    if (layerId === "music") pickMusic(soundId);
    else if (layerId === "__deleted") forgetSound(soundId);
    else if (layerId === "__renamed") { drawSoundPanel(); drawMusic(); }
    else pickSound(layerId, soundId);
  },
  onCurationChange: (removed) => {
    state.soundRemoved = removed;
    setSoundCuration([...removed]);
    drawSoundPanel();
    saveCurationSoon();
  },
  own: {
    pickFile: pickSoundFile,
    videoSource: studioVideoSource,
    hasVideo: () => Boolean(state.video),
    clip: clipEditor,
    request: (url, options) => apiJson(url, options),
    reload: reloadSounds,
  },
});

function openSoundBoard(mode, layerId = null, category = null) {
  if (!soundManifest) return;
  soundBoard.open({
    manifest: soundManifest,
    removed: state.soundRemoved,
    mode,
    layer: layerId,
    styleKey: soundStyleKey(),
    current: mode === "music" ? state.music.sound : layerId ? soundSettings().layers[layerId]?.sound || "" : "",
    category,
  });
}

/** Удалённый свой звук больше нигде не звучит. */
function forgetSound(soundId) {
  let changed = false;
  for (const ps of Object.values(state.perStyle)) {
    for (const layer of Object.values(ps.sound?.layers || {})) {
      if (layer.sound === soundId) {
        layer.sound = "";
        changed = true;
      }
    }
  }
  if (state.music.sound === soundId) {
    state.music.sound = "";
    changed = true;
  }
  drawSoundPanel();
  drawMusic();
  if (changed) {
    hideResult();
    replanSoon();
  }
}

// --- Музыка на фон -----------------------------------------------------------

function musicEntry() {
  return state.music.sound ? soundManifest?.sounds.find((sound) => sound.id === state.music.sound) || null : null;
}

function formatShortClock(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function drawMusic() {
  if (!el.musicChoose) return;
  const entry = musicEntry();
  if (state.music.sound && !entry && soundManifest) state.music.sound = ""; // трек удалён
  const on = Boolean(entry);
  el.musicName.textContent = on ? `${entry.label} · ${formatShortClock(entry.seconds)}` : "Выбрать музыку";
  el.musicChoose.classList.toggle("is-set", on);
  el.musicListen.hidden = !on;
  el.musicClear.hidden = !on;
  el.musicControls.hidden = !on;
  const volume = Math.round(state.music.volume * 100);
  el.musicVolume.value = String(volume);
  el.musicVolumeValue.textContent = `${volume}%`;
  const duck = Math.round(state.music.duck * 100);
  el.musicDuck.value = String(duck);
  el.musicDuckValue.textContent = duck ? `${duck}%` : "нет";
  const longest = Math.max(0, Math.floor((Number(entry?.seconds) || 0) - 1));
  el.musicStart.max = String(longest);
  el.musicStart.value = String(Math.min(longest, state.music.trackStart));
  el.musicStart.disabled = longest < 1;
  el.musicStartValue.textContent = formatShortClock(state.music.trackStart);
  [el.musicVolume, el.musicDuck, el.musicStart].forEach(setRangeFill);
  if (el.simpleMusic) {
    el.simpleMusic.textContent = on ? `♪ ${entry.label}` : "＋ Добавить музыку";
    el.simpleMusic.classList.toggle("is-active", on);
  }
}

function pickMusic(soundId) {
  const changed = state.music.sound !== soundId;
  state.music.sound = soundId;
  if (changed) state.music.trackStart = 0;
  if (!(state.music.volume > 0)) state.music.volume = MUSIC_DEFAULTS.volume;
  drawMusic();
  hideResult();
  player.setSettings(audioSettings());
  if (state.playing) startSounds();
  else if (soundId) void player.audition(soundId, "music", state.music.volume);
}

function wireMusic() {
  if (!el.musicChoose) return;
  el.musicChoose.addEventListener("click", () => openSoundBoard("music"));
  el.simpleMusic?.addEventListener("click", () => openSoundBoard("music"));
  el.musicClear.addEventListener("click", () => {
    state.music.sound = "";
    player.stopAudition();
    drawMusic();
    hideResult();
    if (state.playing) startSounds();
  });
  el.musicListen.addEventListener("click", () => {
    if (state.music.sound) void player.audition(state.music.sound, "music", state.music.volume);
  });
  el.musicVolume.addEventListener("input", () => {
    state.music.volume = Number(el.musicVolume.value) / 100;
    el.musicVolumeValue.textContent = `${el.musicVolume.value}%`;
    setRangeFill(el.musicVolume);
    hideResult();
    player.setSettings(audioSettings());
  });
  el.musicDuck.addEventListener("input", () => {
    state.music.duck = Number(el.musicDuck.value) / 100;
    el.musicDuckValue.textContent = Number(el.musicDuck.value) ? `${el.musicDuck.value}%` : "нет";
    setRangeFill(el.musicDuck);
    hideResult();
  });
  el.musicStart.addEventListener("input", () => {
    state.music.trackStart = Number(el.musicStart.value) || 0;
    el.musicStartValue.textContent = formatShortClock(state.music.trackStart);
    setRangeFill(el.musicStart);
    hideResult();
  });
  // Новое место трека и приглушение слышны со следующего запуска — перезапускаем сразу.
  for (const input of [el.musicDuck, el.musicStart]) {
    input.addEventListener("change", () => { if (state.playing) startSounds(); });
  }
}

let curationTimer = 0;
function saveCurationSoon() {
  window.clearTimeout(curationTimer);
  curationTimer = window.setTimeout(async () => {
    try {
      await apiJson("/api/sounds/curation", { body: { removed: [...state.soundRemoved] } });
    } catch (error) {
      console.warn("[reel-lab] sound curation not saved", error);
      showSoundNote("Не получилось сохранить выбор звуков. Он сохранится при следующем изменении.");
    }
  }, 450);
}

function showSoundNote(text) {
  el.soundNote.textContent = text;
  el.soundNote.hidden = !text;
}

function onSoundClick(event) {
  const kit = event.target.closest("[data-kit]");
  if (kit) {
    applyKit(kit.dataset.kit);
    return;
  }
  const chip = event.target.closest("[data-pick]");
  if (chip) {
    pickSound(chip.dataset.pick, chip.dataset.sound || "");
    return;
  }
  const more = event.target.closest("[data-more]");
  if (more) {
    openSoundBoard("pick", more.dataset.more);
    return;
  }
  const own = event.target.closest("[data-own]");
  if (own) openSoundBoard("pick", own.dataset.own, "mine");
}

function wireSound() {
  el.soundPanel.addEventListener("click", onSoundClick);
  el.simpleKits.addEventListener("click", onSoundClick);
  el.openSoundBoard.addEventListener("click", () => openSoundBoard("curate"));
  el.soundLayers.addEventListener("input", (event) => {
    const input = event.target.closest("input[data-volume]");
    if (!input) return;
    const layer = soundSettings().layers[input.dataset.volume];
    const wasZero = !(layer.volume > 0);
    layer.volume = Number(input.value) / 100;
    input.parentElement.querySelector("output").textContent = `${input.value}%`;
    setRangeFill(input);
    hideResult();
    player.setSettings(audioSettings());
    if (wasZero !== !(layer.volume > 0)) replanSoon();
  });
  el.soundLayers.addEventListener("change", (event) => {
    // Отпустили бегунок громкости — обновим подсветку набора.
    if (event.target.closest("input[data-volume]")) {
      el.soundKits.innerHTML = currentSoundSet()?.kits?.length ? kitsHtml(false) : "";
      drawSimpleKits();
    }
  });
  el.resetSound.addEventListener("click", () => applySound(soundPresetFor(state.styleId)));
  el.voiceVolume.addEventListener("input", () => {
    state.voice = Number(el.voiceVolume.value) / 100;
    el.voiceValue.textContent = `${el.voiceVolume.value}%`;
    el.video.volume = Math.min(1, state.voice);
    setRangeFill(el.voiceVolume);
    hideResult();
  });
  el.soundToggle.addEventListener("click", () => {
    state.soundOn = !state.soundOn;
    el.soundToggle.setAttribute("aria-pressed", String(state.soundOn));
    if (state.playing) startSounds();
  });
}

// ---------------------------------------------------------------------------
// Слова с картинками: ИИ-режиссёр, художник, правка картинок

const PICTURE_STOP_CODES = new Set(["ai_auth", "ai_limit", "free_limit"]);

async function csrfToken(force = false) {
  if (!state.csrf || force) state.csrf = (await requestJson("/api/upload-session")).csrf;
  return state.csrf;
}

/** Запрос к API с CSRF; ошибка несёт код сервера (ai_auth, ai_limit…). */
async function apiJson(url, { method = "POST", body, form } = {}) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const headers = { "X-CSRF-Token": await csrfToken(attempt > 0) };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(url, {
      method,
      credentials: "same-origin",
      headers,
      body: form || (body !== undefined ? JSON.stringify(body) : undefined),
    });
    if (response.ok) return response.json();
    let payload = null;
    try { payload = await response.json(); } catch (_) { /* не JSON */ }
    if (payload?.code === "csrf_stale" && attempt === 0) continue;
    const error = new Error(payload?.error || `Reel Lab не смог выполнить действие. Код: ${response.status}.`);
    error.code = payload?.code || "";
    throw error;
  }
  throw new Error("Сессия устарела. Обнови страницу.");
}

function textSignature(cues = state.cues) {
  return flatWords(cues).map((word) => keywordKey(word.text)).join("|");
}

function randomSeed() {
  return Math.floor(Math.random() * 2_000_000_000) + 1;
}

let pictureCounter = 0;
function newPictureItem(w, word, subject) {
  pictureCounter += 1;
  return { id: `p${Date.now().toString(36)}${pictureCounter}`, w, word: word || "", subject: subject || "", seed: randomSeed(), url: null, status: "queued", error: "", dx: 0, dy: 0, scale: 1, editing: false };
}

function resetPictures() {
  state.pictures.run += 1;
  state.pictures.busy = false;
  state.pictures.plan = null;
  state.pictures.label = "";
  state.pictures.note = "";
  updatePicturesProgress();
}

/** После правки текста номера слов сдвигаются — план ИИ ищет свои слова заново. */
function remapPlan() {
  const plan = state.pictures.plan;
  if (!plan) return;
  const signature = textSignature();
  if (plan.signature === signature) return;
  const keys = flatWords(state.cues).map((word) => keywordKey(word.text));
  const relocate = (index, word) => {
    const key = keywordKey(word);
    if (!key) return -1;
    if (keys[index] === key) return index;
    for (let d = 1; d <= 15; d += 1) {
      if (keys[index - d] === key) return index - d;
      if (keys[index + d] === key) return index + d;
    }
    return -1;
  };
  for (const accent of plan.accents) accent.w = relocate(accent.w, accent.word);
  plan.accents = plan.accents.filter((accent) => accent.w >= 0);
  for (const item of plan.items) {
    item.w = relocate(item.w, item.word);
    if (item.w < 0) item.removed = true;
  }
  plan.items = plan.items.filter((item) => !item.removed);
  // Правка раскладки едет за своими словами, как и картинки.
  for (const kind of ["phrases", "lines"]) {
    const moved = {};
    for (const [key, value] of Object.entries(state.pictures.layout[kind] || {})) {
      const w = relocate(Number(key), value.word || "");
      if (w >= 0) moved[w] = value;
    }
    state.pictures.layout[kind] = moved;
  }
  plan.signature = signature;
}

function picturesSpec(ps) {
  remapPlan();
  const plan = state.pictures.plan;
  return {
    fontSize: 5.8 * ps.sizeScale,
    accents: plan ? plan.accents.map(({ w, color }) => ({ w, color })) : [],
    autoAccent: !plan,
    items: plan ? plan.items.filter((item) => item.status === "ready" && item.url).map(({ w, url, dx, dy, scale, layer }) => ({ w, url, dx, dy, scale, layer: layer || 0 })) : [],
    layout: state.pictures.layout,
    blend: state.pictures.blend,
    size: state.pictures.size,
    opacity: state.pictures.opacity,
    stack: state.pictures.stack,
  };
}

/** Для предпросмотра: ещё рисующиеся картинки занимают своё место и мерцают. */
function previewPictureOptions(spec) {
  const options = picturesOptionsFromSpec(spec);
  const pending = (state.pictures.plan?.items || [])
    .filter((item) => item.status === "queued" || item.status === "loading")
    .map((item) => ({ w: item.w, url: `pending:${item.id}`, dx: item.dx, dy: item.dy, scale: item.scale, layer: item.layer || 0 }));
  return { ...options, pictures: [...options.pictures, ...pending], showPending: true };
}

function maybeAutoPictures() {
  if (!isPictures() || !state.cues.length || state.pictures.plan || state.pictures.busy) return;
  const signature = textSignature();
  if (state.pictures.autoStarted === signature) return;
  state.pictures.autoStarted = signature;
  void runPictures();
}

function updatePicturesProgress() {
  const { busy, plan } = state.pictures;
  const items = plan?.items || [];
  const total = items.length;
  const done = items.filter((item) => item.status === "ready" || item.status === "error").length;
  const drawing = items.some((item) => item.status === "queued" || item.status === "loading");
  let label = state.pictures.label;
  if (busy && total && drawing) label = `ИИ рисует картинки: ${done} из ${total}`;
  el.picturesProgress.hidden = !busy;
  el.picturesLabel.textContent = label || "ИИ читает текст…";
  el.picturesFill.style.width = `${busy ? (total ? Math.max(8, (done / total) * 100) : 6) : 0}%`;
  el.aiBadge.hidden = !(busy && isPictures());
  el.aiBadgeText.textContent = label || "ИИ подбирает картинки…";
  const ready = items.filter((item) => item.status === "ready").length;
  el.picturesCount.textContent = total ? `${ready} из ${total}` : "";
  el.picturesNote.textContent = state.pictures.note
    || (plan ? (plan.smart === false && plan.provider === "rules" ? "Слова подобраны по простому правилу — ИИ-режиссёр не ответил." : "Готово. Меняй цвета слов, перерисовывай и двигай картинки.")
      : "ИИ прочитает текст, подсветит главные слова по смыслу и нарисует к ним картинки.");
  updateUi();
}

async function runPictures() {
  if (!state.cues.length) return;
  const run = state.pictures.run + 1;
  state.pictures.run = run;
  state.pictures.busy = true;
  state.pictures.label = "ИИ-режиссёр читает текст…";
  state.pictures.note = "";
  updatePicturesProgress();
  try {
    const phrases = picturePhrases(state.cues).map((phrase) => ({
      words: phrase.words.map((word) => ({ w: word.w, text: word.text, start: Math.round(word.start * 100) / 100 })),
    }));
    const result = await apiJson("/api/pictures/plan", { body: { phrases, density: state.pictures.density } });
    if (run !== state.pictures.run) return;
    const flat = flatWords(state.cues);
    state.pictures.plan = {
      signature: textSignature(),
      provider: result.provider,
      smart: result.smart,
      accents: (result.accents || []).map((item) => ({ w: item.w, color: item.color, word: flat[item.w]?.text || "" })),
      items: (result.pictures || []).map((item) => newPictureItem(item.w, item.word || flat[item.w]?.text, item.subject)),
    };
    if (result.note) state.pictures.note = result.note;
    state.pictures.label = "";
    hideResult();
    drawPicturesList();
    schedulePreview(0);
    await drawPictureQueue(run);
  } catch (error) {
    if (run !== state.pictures.run) return;
    console.error(error);
    state.pictures.note = `Не получилось: ${error?.message || error}`;
  } finally {
    if (run === state.pictures.run) {
      state.pictures.busy = false;
      state.pictures.label = "";
      updatePicturesProgress();
      drawPicturesList();
    }
  }
}

async function drawPictureQueue(run) {
  const concurrency = state.ai.configured ? 3 : 1;
  const next = () => state.pictures.plan?.items.find((item) => item.status === "queued");
  const worker = async () => {
    let item = next();
    while (item && run === state.pictures.run) {
      await generatePicture(item, run);
      item = next();
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
}

/** Перерисовать все картинки (например, после смены «Как нарисовать»). */
async function redrawAllPictures() {
  const items = state.pictures.plan?.items || [];
  if (!items.length || state.pictures.busy) return;
  const run = state.pictures.run + 1;
  state.pictures.run = run;
  state.pictures.busy = true;
  for (const item of items) if (item.subject) item.status = "queued";
  updatePicturesProgress();
  drawPicturesList();
  schedulePreview(0);
  try {
    await drawPictureQueue(run);
  } finally {
    if (run === state.pictures.run) {
      state.pictures.busy = false;
      updatePicturesProgress();
      drawPicturesList();
    }
  }
}

async function generatePicture(item, run = state.pictures.run) {
  item.status = "loading";
  item.error = "";
  updatePicturesProgress();
  drawPicturesList();
  try {
    // fresh — «нарисуй другую»: без него сервер может взять готовую картинку из общего банка.
    const result = await apiJson("/api/pictures/generate", { body: { subject: item.subject || item.word, style: state.pictures.look, seed: item.seed, fresh: Boolean(item.fresh) } });
    item.fresh = false;
    if (item.removed) return;
    item.url = result.url;
    item.subject = result.subject || item.subject;
    await preparePicture(item.url);
    item.status = "ready";
  } catch (error) {
    if (item.removed) return;
    item.status = "error";
    item.error = error?.message || String(error);
    if (PICTURE_STOP_CODES.has(error?.code) && run === state.pictures.run) {
      // Ключ не подошёл или закончился лимит — остальные картинки не мучаем.
      for (const other of state.pictures.plan?.items || []) {
        if (other.status === "queued") {
          other.status = "error";
          other.error = item.error;
        }
      }
      state.pictures.note = item.error;
      if (error.code === "ai_auth") openAiDialog();
    }
  }
  hideResult();
  updatePicturesProgress();
  drawPicturesList();
  schedulePreview(80);
}

function ensurePlan() {
  if (state.pictures.plan) return state.pictures.plan;
  // Своя правка без ИИ: начинаем с тех цветов, что уже видны на экране.
  const accents = [];
  const flat = flatWords(state.cues);
  if (state.preview.kind === "pictures") {
    for (const page of state.preview.timeline?.pages || []) {
      for (const phrase of page.phrases) {
        for (const line of phrase.lines) for (const word of line.words) if (word.accent) accents.push({ w: word.w, color: word.accent, word: flat[word.w]?.text || word.text });
      }
    }
  }
  state.pictures.plan = { signature: textSignature(), provider: "manual", smart: false, accents, items: [] };
  return state.pictures.plan;
}

function accentMap() {
  const map = new Map();
  if (state.preview.kind === "pictures") {
    for (const page of state.preview.timeline?.pages || []) {
      for (const phrase of page.phrases) for (const line of phrase.lines) for (const word of line.words) if (word.accent) map.set(word.w, word.accent);
    }
  } else if (state.pictures.plan) {
    for (const accent of state.pictures.plan.accents) map.set(accent.w, accent.color);
  }
  return map;
}

function cycleAccent(w) {
  const plan = ensurePlan();
  const current = accentMap().get(w) || null;
  const order = [null, ...ACCENT_ORDER];
  const next = order[(order.indexOf(current) + 1) % order.length];
  const word = flatWords(state.cues)[w]?.text || "";
  plan.accents = plan.accents.filter((accent) => accent.w !== w);
  if (next) plan.accents.push({ w, color: next, word });
  // Отмеченное в «Тексте» слово тоже красится — снимаем его, чтобы цвет можно было убрать.
  if (!next && isKeyword(word)) state.keywords = state.keywords.filter((item) => keywordKey(item) !== keywordKey(word));
  hideResult();
  schedulePreview(0);
}

let picturePhraseCache = { signature: "", phrases: [] };
function currentPicturePhrases() {
  const signature = textSignature();
  if (picturePhraseCache.signature !== signature) picturePhraseCache = { signature, phrases: picturePhrases(state.cues) };
  return picturePhraseCache.phrases;
}

async function addPictureToPhrase(index) {
  const phrase = currentPicturePhrases()[index];
  if (!phrase) return;
  const accents = accentMap();
  let word = phrase.words.find((item) => accents.has(item.w));
  if (!word) word = [...phrase.words].sort((a, b) => b.text.length - a.text.length)[0];
  const plan = ensurePlan();
  const item = newPictureItem(word.w, word.text, "");
  item.status = "loading";
  plan.items.push(item);
  if (!accents.has(word.w)) plan.accents.push({ w: word.w, color: "gold", word: word.text });
  drawPicturesList();
  schedulePreview(0);
  try {
    const result = await apiJson("/api/pictures/subject", { body: { word: word.text, phrase: phrase.words.map((w) => w.text).join(" ") } });
    item.subject = result.subject || word.text;
  } catch (error) {
    item.subject = word.text;
    if (PICTURE_STOP_CODES.has(error?.code)) {
      item.status = "error";
      item.error = error.message;
      drawPicturesList();
      return;
    }
  }
  await generatePicture(item);
}

async function describePicture(item, description) {
  const text = String(description || "").trim();
  if (!text) return;
  item.editing = false;
  item.status = "loading";
  drawPicturesList();
  const phrase = currentPicturePhrases().find((p) => p.words.some((w) => w.w === item.w));
  try {
    const result = await apiJson("/api/pictures/subject", { body: { word: item.word, phrase: phrase ? phrase.words.map((w) => w.text).join(" ") : item.word, description: text } });
    item.subject = result.subject || text;
  } catch (error) {
    item.subject = text;
  }
  item.seed = randomSeed();
  await generatePicture(item);
}

async function uploadPicture(item, file) {
  if (!file) return;
  item.status = "loading";
  item.error = "";
  drawPicturesList();
  try {
    const form = new FormData();
    form.append("image", file, file.name || "picture.png");
    const result = await apiJson("/api/pictures/upload", { form });
    item.url = result.url;
    item.subject = "своя картинка";
    await preparePicture(item.url);
    item.status = "ready";
  } catch (error) {
    item.status = "error";
    item.error = error?.message || String(error);
  }
  hideResult();
  updatePicturesProgress();
  drawPicturesList();
  schedulePreview(0);
}

const TOOL_ICONS = {
  again: ["↻", "Нарисовать другую"],
  describe: ["✎", "Описать своими словами"],
  upload: ["⤒", "Поставить свою картинку"],
  smaller: ["−", "Меньше"],
  bigger: ["+", "Больше"],
  remove: ["×", "Убрать картинку"],
};

function drawPicturesList() {
  if (el.picturesBlock.hidden && !isPictures()) return;
  const phrases = currentPicturePhrases();
  if (!phrases.length) {
    el.picturesList.innerHTML = "";
    return;
  }
  const accents = accentMap();
  const items = new Map((state.pictures.plan?.items || []).map((item) => [item.w, item]));
  const focus = document.activeElement?.closest?.(".pic-edit input")?.dataset.item || null;
  el.picturesList.innerHTML = phrases.map((phrase, index) => {
    const item = phrase.words.map((word) => items.get(word.w)).find(Boolean) || null;
    const words = phrase.words.map((word) => {
      const accent = accents.get(word.w);
      const color = accent ? (accent === "gold" ? settings(PICTURES_ID).colors.highlight : ACCENT_PALETTE[accent]) : "";
      return `<button type="button" class="pic-word${item?.w === word.w ? " has-picture" : ""}" data-w="${word.w}"${accent ? ` data-accent="${accent}" style="--accent:${escapeHtml(color)}"` : ""} title="Сменить цвет">${escapeHtml(word.text)}</button>`;
    }).join("");
    let slot;
    if (item) {
      const thumbClass = item.status === "loading" || item.status === "queued" ? " is-loading" : item.status === "error" ? " is-error" : "";
      const thumb = item.status === "error" ? "!" : item.url ? `<img src="${escapeHtml(item.url)}" alt="" loading="lazy">` : "";
      slot = `<div class="pic-slot">
        <div class="pic-thumb${thumbClass}" data-act="seek" data-item="${item.id}" title="${escapeHtml(item.subject || "")}">${thumb}</div>
        <div class="pic-tools">${Object.entries(TOOL_ICONS).map(([act, [icon, title]]) => `<button type="button" class="pic-tool${act === "remove" ? " danger" : ""}" data-act="${act}" data-item="${item.id}" title="${title}" aria-label="${title}">${icon}</button>`).join("")}</div>
      </div>`;
    } else {
      slot = `<div class="pic-slot"><button type="button" class="pic-add" data-act="add" data-phrase="${index}">＋ картинка</button></div>`;
    }
    const edit = item?.editing ? `<div class="pic-edit"><input type="text" data-item="${item.id}" maxlength="200" placeholder="Что нарисовать? Например: золотая корона в огне"><button type="button" class="btn btn-ghost" data-act="describe-go" data-item="${item.id}">Нарисовать</button></div>` : "";
    const error = item?.status === "error" && item.error ? `<p class="pic-error">${escapeHtml(item.error)}</p>` : "";
    return `<div class="pic-row" data-phrase="${index}">${`<div class="pic-words">${words}</div>`}${slot}${edit}${error}</div>`;
  }).join("");
  if (focus) el.picturesList.querySelector(`.pic-edit input[data-item="${focus}"]`)?.focus();
  else el.picturesList.querySelector(".pic-edit input")?.focus();
  lastPictureRow = -1;
}

let lastPictureRow = -1;
function markPicturesRow(t) {
  if (el.picturesBlock.hidden) return;
  const phrases = currentPicturePhrases();
  let row = -1;
  for (let i = 0; i < phrases.length; i += 1) if (t >= phrases[i].start - 0.05 && t < phrases[i].end + 0.4) row = i;
  if (row === lastPictureRow) return;
  const rows = el.picturesList.querySelectorAll(".pic-row");
  rows[lastPictureRow]?.classList.remove("is-now");
  rows[row]?.classList.add("is-now");
  lastPictureRow = row;
}

function findPictureItem(id) {
  return state.pictures.plan?.items.find((item) => item.id === id) || null;
}

function onPicturesListClick(event) {
  const word = event.target.closest(".pic-word");
  if (word) {
    cycleAccent(Number(word.dataset.w));
    return;
  }
  const button = event.target.closest("[data-act]");
  if (!button) return;
  const act = button.dataset.act;
  if (act === "add") {
    void addPictureToPhrase(Number(button.dataset.phrase));
    return;
  }
  const item = findPictureItem(button.dataset.item);
  if (!item) return;
  if (act === "seek") {
    const word = flatWords(state.cues)[item.w];
    if (word) seekText(Math.max(0, word.start + 0.35));
  } else if (act === "again") {
    item.seed = randomSeed();
    item.fresh = true;
    void generatePicture(item);
  } else if (act === "describe") {
    item.editing = !item.editing;
    drawPicturesList();
  } else if (act === "describe-go") {
    const input = el.picturesList.querySelector(`.pic-edit input[data-item="${item.id}"]`);
    void describePicture(item, input?.value);
  } else if (act === "upload") {
    state.pictures.uploadFor = item.id;
    el.pictureInput.click();
  } else if (act === "smaller" || act === "bigger") {
    item.scale = Math.max(0.4, Math.min(2.5, (item.scale || 1) * (act === "bigger" ? 1.15 : 0.87)));
    hideResult();
    schedulePreview(0);
  } else if (act === "remove") {
    item.removed = true;
    state.pictures.plan.items = state.pictures.plan.items.filter((other) => other !== item);
    hideResult();
    updatePicturesProgress();
    drawPicturesList();
    schedulePreview(0);
  }
}

function syncPicturesControls() {
  const pics = state.pictures;
  setSeg(el.picDensitySeg, "value", pics.density);
  setSeg(el.picLookSeg, "value", pics.look);
  setSeg(el.picBlendSeg, "value", pics.blend);
  setSeg(el.picStackSeg, "value", String(pics.stack));
  el.picSize.value = String(Math.round(pics.size * 100));
  el.picSizeValue.textContent = `${Math.round(pics.size * 100)}%`;
  el.picOpacity.value = String(Math.round(pics.opacity * 100));
  el.picOpacityValue.textContent = `${Math.round(pics.opacity * 100)}%`;
  el.aiNotice.hidden = state.ai.configured;
  updatePicturesProgress();
  drawPicturesList();
}

// --- Правка композиции прямо на видео -----------------------------------------
//
// Нажми на строку, фразу или картинку — двигай, меняй размер, клади картинку
// перед текстом или за ним. В «Словах с картинками» правится каждая строка,
// фраза и картинка; в остальных стилях — весь блок субтитров (место и размер).

function quickPictureTimeline() {
  if (state.preview.kind !== "pictures" || !state.preview.images) return;
  const spec = buildSpec();
  const options = previewPictureOptions(spec);
  state.preview.timeline = buildPictureTimeline(spec.cues, state.videoSize.width, state.videoSize.height, options, state.preview.images);
}

function composePictures() {
  return isPictures() && state.preview.kind === "pictures" && Boolean(state.preview.timeline);
}

function composeEnabled() {
  return Boolean(state.video && state.videoSize && state.preview.ready && !state.playing && !state.rendering);
}

/** Рамка блока субтитров в кадре (печатная машинка или стиль движка). */
function captionBlockRect(time) {
  const size = state.videoSize;
  if (!size) return null;
  if (isTypewriter() && state.preview.kind === "typewriter" && state.preview.timeline) {
    const segment = segmentAt(state.preview.timeline, time);
    const lines = segment?.lines?.filter((line) => Number.isFinite(line.left) && Number.isFinite(line.baseline)) || [];
    if (!lines.length) return null;
    const px = state.preview.timeline.px;
    const left = Math.min(...lines.map((line) => line.left));
    const right = Math.max(...lines.map((line) => line.left + line.width));
    const top = Math.min(...lines.map((line) => line.baseline - px * 0.95));
    const bottom = Math.max(...lines.map((line) => line.baseline + px * 0.3));
    return { x: left, y: top, w: Math.max(px, right - left), h: bottom - top };
  }
  if (state.preview.kind !== "engine") return null;
  const screen = el.screen.getBoundingClientRect();
  // Рамка — по самим буквам (обёртка фразы бывает во всю ширину кадра).
  const parts = [];
  const range = document.createRange();
  for (const segment of stylePreview.shadow?.querySelectorAll(".segment") || []) {
    const walker = document.createTreeWalker(segment, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent.trim()) continue;
      range.selectNodeContents(node);
      const r = range.getBoundingClientRect();
      if (r.width > 0.5 && r.height > 0.5) parts.push(r);
    }
  }
  if (!parts.length || !screen.width) return null;
  const left = Math.min(...parts.map((r) => r.left));
  const right = Math.max(...parts.map((r) => r.right));
  const top = Math.min(...parts.map((r) => r.top));
  const bottom = Math.max(...parts.map((r) => r.bottom));
  const kx = size.width / screen.width;
  const ky = size.height / screen.height;
  const pad = size.height * 0.01;
  // Ещё не прозвучавшие слова тоже в блоке; рамка не выходит за кадр, чтобы угол было за что взять.
  const x0 = Math.max(0, (left - screen.left) * kx - pad);
  const y0 = Math.max(0, (top - screen.top) * ky - pad);
  const x1 = Math.min(size.width, (right - screen.left) * kx + pad);
  const y1 = Math.min(size.height, (bottom - screen.top) * ky + pad);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

function composeElements() {
  const time = montagePlayer.time;
  let items;
  if (composePictures()) {
    items = compositionAt(state.preview.timeline, time).map((item) => ({ ...item, id: item.kind === "picture" ? `p:${item.key}` : `l:${item.key}` }));
  } else {
    const rect = captionBlockRect(time);
    items = rect ? [{ id: "block", kind: "block", rect }] : [];
  }
  const size = state.videoSize;
  // Перевод второй строкой — над субтитрами, под подписью.
  const tr = size ? fxSpec().translation : null;
  const trLayout = tr ? translationLayout(tr, time, size.width, size.height) : null;
  if (trLayout) items.push({ id: "tr", kind: "translation", rect: trLayout.rect, layout: trLayout });
  // Подпись — поверх всего, поэтому последней (её берут первой).
  const sig = signatureSpec();
  const layout = sig && size ? signatureLayout(sig, size.width, size.height) : null;
  if (layout) items.push({ id: "sig", kind: "signature", rect: layout.rect, layout });
  return items;
}

const alphaProbe = typeof document !== "undefined" ? document.createElement("canvas") : null;
if (alphaProbe) {
  alphaProbe.width = 1;
  alphaProbe.height = 1;
}

/** Картинку берут за её непрозрачную часть: через пустые края виден текст под ней. */
function composeHit(item, point) {
  if (item.kind !== "picture") return true;
  const image = state.preview.images?.get(item.url);
  const source = state.pictures.blend === "screen" ? image?.screen : image?.cut;
  if (!source || !alphaProbe) return true;
  const u = (point.x - item.rect.x) / item.rect.w;
  const v = (point.y - item.rect.y) / item.rect.h;
  if (u > 0.35 && u < 0.65 && v > 0.35 && v < 0.65) return true;
  try {
    const ctx = alphaProbe.getContext("2d", { willReadFrequently: true });
    ctx.clearRect(0, 0, 1, 1);
    ctx.drawImage(source, Math.floor(u * source.width), Math.floor(v * source.height), 1, 1, 0, 0, 1, 1);
    return ctx.getImageData(0, 0, 1, 1).data[3] > 40;
  } catch (_) {
    return true;
  }
}

function layoutEntry(kind, key) {
  const table = state.pictures.layout[kind];
  if (!table[key]) {
    const word = flatWords(state.cues)[Number(key)]?.text || "";
    table[key] = { dx: 0, dy: 0, scale: 1, word };
  }
  return table[key];
}

function pictureItemFor(key) {
  return state.pictures.plan?.items.find((item) => item.w === Number(key) && item.url) || null;
}

/** Слои картинки по порядку: за текстом → перед первыми строками своей фразы → перед всем. */
function pictureLayers(lines) {
  const steps = [0];
  for (let i = 1; i < lines; i += 1) steps.push(i);
  steps.push(LAYER_FRONT);
  return steps;
}

function layerName(layer, lines) {
  if (!layer) return "За текстом";
  if (layer >= LAYER_FRONT || layer >= lines) return "Перед текстом";
  return lines > 2 ? `Перед ${layer} из ${lines} строк` : "Между строк";
}

let composeStart = null;
let composeKind = null;
let blockLayer = null;

function blockLayerElement() {
  return isTypewriter() ? el.twCanvas : el.captionHost;
}

function composeAdapter() {
  return {
    enabled: composeEnabled,
    frameSize: () => state.videoSize,
    elements: composeElements,
    hit: composeHit,
    begin(target) {
      pausePreview();
      composeKind = target.kind;
      if (target.kind === "signature") {
        const size = state.videoSize;
        composeStart = { x: target.layout.cx / size.width, y: target.layout.cy / size.height, size: state.signature.size };
        return;
      }
      if (target.kind === "translation") {
        const size = state.videoSize;
        composeStart = { x: target.layout.cx / size.width, y: target.layout.cy / size.height, size: state.translation.secondStyle.size };
        return;
      }
      if (target.kind === "line") composeStart = { ...layoutEntry("lines", target.key) };
      else if (target.kind === "phrase") composeStart = { ...layoutEntry("phrases", target.phraseKey) };
      else if (target.kind === "picture") {
        const item = pictureItemFor(target.key);
        composeStart = item ? { dx: item.dx || 0, dy: item.dy || 0, scale: item.scale || 1 } : null;
      } else if (target.kind === "block") {
        const ps = settings();
        const size = state.videoSize;
        const alignment = alignmentFor(currentTemplate(), ps);
        composeStart = {
          height: Number(alignment.verticalOffset ?? 0.8),
          x: ps.x ?? (target.rect.x + target.rect.w / 2) / size.width,
          sizeScale: ps.sizeScale || 1,
          dx: 0, dy: 0, factor: 1,
          rect: target.rect,
        };
        blockLayer = blockLayerElement();
      }
    },
    move(target, dx, dy) {
      if (!composeStart) return;
      if (target.kind === "signature") {
        state.signature.x = Math.min(1, Math.max(0, composeStart.x + dx));
        state.signature.y = Math.min(1, Math.max(0, composeStart.y + dy));
        invalidateFx();
        drawFrame();
        return;
      }
      if (target.kind === "translation") {
        state.translation.secondStyle.x = Math.min(1, Math.max(0, composeStart.x + dx));
        state.translation.secondStyle.y = Math.min(1, Math.max(0, composeStart.y + dy));
        state.translation.secondStyle.placed = true;
        invalidateFx();
        drawFrame();
        return;
      }
      if (target.kind === "line" || target.kind === "phrase") {
        const entry = target.kind === "line" ? layoutEntry("lines", target.key) : layoutEntry("phrases", target.phraseKey);
        entry.dx = composeStart.dx + dx;
        entry.dy = composeStart.dy + dy;
        quickPictureTimeline();
        drawFrame();
      } else if (target.kind === "picture") {
        const item = pictureItemFor(target.key);
        if (!item) return;
        item.dx = composeStart.dx + dx;
        item.dy = composeStart.dy + dy;
        quickPictureTimeline();
        drawFrame();
      } else if (target.kind === "block") {
        composeStart.dx = dx;
        composeStart.dy = dy;
        previewBlockTransform();
      }
    },
    scale(target, factor) {
      if (!composeStart) return;
      if (target.kind === "signature") {
        state.signature.size = Math.round(Math.min(3.5, Math.max(0.4, composeStart.size * factor)) * 100) / 100;
        invalidateFx();
        drawFrame();
        return;
      }
      if (target.kind === "translation") {
        state.translation.secondStyle.size = Math.round(Math.min(3, Math.max(0.4, composeStart.size * factor)) * 100) / 100;
        invalidateFx();
        drawFrame();
        return;
      }
      if (target.kind === "line" || target.kind === "phrase") {
        const entry = target.kind === "line" ? layoutEntry("lines", target.key) : layoutEntry("phrases", target.phraseKey);
        entry.scale = Math.min(4, Math.max(0.3, composeStart.scale * factor));
        quickPictureTimeline();
        drawFrame();
      } else if (target.kind === "picture") {
        const item = pictureItemFor(target.key);
        if (!item) return;
        item.scale = Math.min(2.5, Math.max(0.4, composeStart.scale * factor));
        quickPictureTimeline();
        drawFrame();
      } else if (target.kind === "block") {
        composeStart.factor = Math.min(2.2 / composeStart.sizeScale, Math.max(0.5 / composeStart.sizeScale, factor));
        previewBlockTransform();
      }
    },
    end(changed) {
      if (!changed) return;
      hideResult();
      if (composeKind === "signature") {
        saveSignature();
        drawSignatureControls();
        composeStart = null;
        return;
      }
      if (composeKind === "translation") {
        saveSecondStyle();
        drawTranslateControls();
        composeStart = null;
        return;
      }
      if (blockLayer && composeStart) {
        const ps = settings();
        ps.height = Math.min(0.97, Math.max(0.03, composeStart.height + composeStart.dy));
        ps.x = Math.min(0.95, Math.max(0.05, composeStart.x + composeStart.dx));
        ps.sizeScale = Math.round(composeStart.sizeScale * composeStart.factor * 100) / 100;
        syncTune();
        commitBlockChange();
      }
      composeStart = null;
    },
    actions(target) {
      const reset = { id: "__reset", label: "Сбросить", title: "Вернуть, как было" };
      const size = [{ id: "__smaller", label: "−", title: "Меньше" }, { id: "__bigger", label: "+", title: "Больше" }];
      if (target.kind === "signature") {
        return [...size, { id: "__hide", label: "Убрать", title: "Не показывать подпись (вернуть — во вкладке «Эффекты»)" }, reset];
      }
      if (target.kind === "translation") {
        return [...size, { id: "__hide", label: "Убрать", title: "Убрать перевод второй строкой" }, reset];
      }
      if (target.kind === "picture") {
        const steps = pictureLayers(target.lines);
        const layer = steps.includes(target.layer) ? target.layer : steps.reduce((a, b) => (Math.abs(b - target.layer) < Math.abs(a - target.layer) ? b : a));
        const index = steps.indexOf(layer);
        return [
          { id: "__back", label: "Назад", title: "Картинку — за текст", disabled: index <= 0 },
          { id: "__state", label: layerName(layer, target.lines), static: true },
          { id: "__front", label: "Вперёд", title: "Картинку — перед текстом", disabled: index >= steps.length - 1 },
          ...size, reset,
        ];
      }
      return [...size, reset];
    },
    act(target, id) {
      if (target.kind === "signature") {
        if (id === "__hide") state.signature.show = false;
        if (id === "__reset") Object.assign(state.signature, { x: 0.5, y: 0.94, size: 1 });
        onSignatureChanged();
        return;
      }
      if (target.kind === "translation") {
        if (id === "__hide") {
          removeSecondLine();
          return;
        }
        if (id === "__reset") Object.assign(state.translation.secondStyle, { x: SECOND_DEFAULTS.x, y: SECOND_DEFAULTS.y, size: 1, placed: false });
        onSecondChanged();
        return;
      }
      if (target.kind === "picture") {
        const item = pictureItemFor(target.key);
        if (!item) return;
        if (id === "__reset") {
          item.dx = 0;
          item.dy = 0;
          item.scale = 1;
          item.layer = 0;
        } else if (id === "__front" || id === "__back") {
          const steps = pictureLayers(target.lines);
          const current = steps.reduce((a, b) => (Math.abs(b - (item.layer || 0)) < Math.abs(a - (item.layer || 0)) ? b : a));
          const index = Math.min(steps.length - 1, Math.max(0, steps.indexOf(current) + (id === "__front" ? 1 : -1)));
          item.layer = steps[index];
        }
        quickPictureTimeline();
        drawFrame();
        return;
      }
      if (id !== "__reset") return;
      if (target.kind === "line") delete state.pictures.layout.lines[target.key];
      else if (target.kind === "phrase") delete state.pictures.layout.phrases[target.phraseKey];
      if (target.kind === "line" || target.kind === "phrase") {
        quickPictureTimeline();
        drawFrame();
        return;
      }
      if (target.kind === "block") {
        const ps = settings();
        ps.height = null;
        ps.x = null;
        ps.sizeScale = 1;
        blockLayer = null;
        syncTune();
        onTuneChange();
      }
    },
    snapshot() {
      const ps = settings();
      return JSON.stringify({
        style: state.styleId,
        layout: state.pictures.layout,
        items: (state.pictures.plan?.items || []).map((item) => [item.id, item.dx || 0, item.dy || 0, item.scale || 1, item.layer || 0]),
        block: { height: ps.height ?? null, x: ps.x ?? null, sizeScale: ps.sizeScale || 1 },
        signature: { show: state.signature.show, x: state.signature.x, y: state.signature.y, size: state.signature.size },
      });
    },
    restore(text) {
      const snap = JSON.parse(text);
      if (snap.signature) {
        Object.assign(state.signature, snap.signature);
        saveSignature();
        drawSignatureControls();
        invalidateFx();
      }
      state.pictures.layout = snap.layout || { phrases: {}, lines: {} };
      for (const [id, dx, dy, scale, layer] of snap.items || []) {
        const item = state.pictures.plan?.items.find((candidate) => candidate.id === id);
        if (item) Object.assign(item, { dx, dy, scale, layer });
      }
      hideResult();
      if (snap.style === state.styleId && !composePictures()) {
        const ps = settings();
        const changed = ps.height !== snap.block.height || ps.x !== snap.block.x || ps.sizeScale !== snap.block.sizeScale;
        Object.assign(ps, snap.block);
        if (changed) {
          syncTune();
          onTuneChange();
          return;
        }
      }
      quickPictureTimeline();
      drawFrame();
    },
  };
}

/** Пока тянут блок субтитров — двигаем готовую картинку, пересборка после отпускания. */
function previewBlockTransform() {
  if (!blockLayer || !composeStart) return;
  const width = el.screen.clientWidth;
  const height = el.screen.clientHeight;
  const size = state.videoSize;
  const r = composeStart.rect;
  const cx = ((r.x + r.w / 2) / size.width) * width;
  const cy = ((r.y + r.h / 2) / size.height) * height;
  blockLayer.style.transformOrigin = `${cx}px ${cy}px`;
  blockLayer.style.transform = `translate(${composeStart.dx * width}px, ${composeStart.dy * height}px) scale(${composeStart.factor})`;
}

function commitBlockChange() {
  const layer = blockLayer;
  blockLayer = null;
  const run = rebuildPreview();
  // Сдвиг картинкой убираем, когда новый кадр уже нарисован на новом месте.
  Promise.resolve(run).finally(() => {
    if (layer) {
      layer.style.transform = "";
      layer.style.transformOrigin = "";
    }
    composer.refresh();
  });
}

const composer = new ComposeEditor({ screen: el.screen, adapter: composeAdapter() });

function wirePictures() {
  el.picturesRun.addEventListener("click", () => {
    state.pictures.autoStarted = textSignature();
    void runPictures();
  });
  el.picturesStop.addEventListener("click", () => {
    state.pictures.run += 1;
    state.pictures.busy = false;
    for (const item of state.pictures.plan?.items || []) {
      if (item.status === "queued") {
        item.status = "error";
        item.error = "Остановлено — нажми ↻, чтобы нарисовать.";
      }
    }
    updatePicturesProgress();
    drawPicturesList();
  });
  el.aiNoticeButton.addEventListener("click", openAiDialog);
  el.layoutReset?.addEventListener("click", () => {
    composer.pushHistory();
    state.pictures.layout = { phrases: {}, lines: {} };
    for (const item of state.pictures.plan?.items || []) Object.assign(item, { dx: 0, dy: 0, scale: 1, layer: 0 });
    hideResult();
    quickPictureTimeline();
    drawFrame();
  });
  el.picturesList.addEventListener("click", onPicturesListClick);
  el.picturesList.addEventListener("keydown", (event) => {
    const input = event.target.closest(".pic-edit input");
    if (!input || event.key !== "Enter") return;
    event.preventDefault();
    const item = findPictureItem(input.dataset.item);
    if (item) void describePicture(item, input.value);
  });
  el.pictureInput.addEventListener("change", () => {
    const [file] = el.pictureInput.files || [];
    el.pictureInput.value = "";
    const item = findPictureItem(state.pictures.uploadFor);
    state.pictures.uploadFor = null;
    if (item && file) void uploadPicture(item, file);
  });
  const seg = (container, apply) => container.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-value]");
    if (!button) return;
    setSeg(container, "value", button.dataset.value);
    apply(button.dataset.value);
  });
  seg(el.picDensitySeg, (value) => {
    state.pictures.density = value;
    updateUi();
  });
  seg(el.picLookSeg, (value) => {
    if (state.pictures.look === value) return;
    state.pictures.look = value;
    void redrawAllPictures();
  });
  seg(el.picBlendSeg, (value) => {
    state.pictures.blend = value;
    hideResult();
    schedulePreview(0);
  });
  seg(el.picStackSeg, (value) => {
    state.pictures.stack = Number(value);
    hideResult();
    schedulePreview(0);
  });
  el.picSize.addEventListener("input", () => {
    state.pictures.size = Number(el.picSize.value) / 100;
    el.picSizeValue.textContent = `${el.picSize.value}%`;
    setRangeFill(el.picSize);
    hideResult();
    schedulePreview();
  });
  el.picOpacity.addEventListener("input", () => {
    state.pictures.opacity = Number(el.picOpacity.value) / 100;
    el.picOpacityValue.textContent = `${el.picOpacity.value}%`;
    setRangeFill(el.picOpacity);
    hideResult();
    schedulePreview();
  });
}

// --- Ключ ИИ ------------------------------------------------------------------

async function loadAiSettings() {
  if (server.active) {
    drawAiChip();
    return;
  }
  try {
    state.ai = await requestJson("/api/ai/settings");
  } catch (error) {
    console.warn("[reel-lab] ai settings", error);
  }
  drawAiChip();
}

function drawAiChip() {
  el.aiKeyButton.classList.toggle("is-ready", Boolean(state.ai.configured));
  el.aiKeyText.textContent = state.ai.configured ? "ИИ подключён" : "Ключ ИИ";
  // ИИ подключён — в шапке на его месте «Черновик»; изменить ключ можно в окне помощника.
  el.aiKeyButton.hidden = Boolean(state.ai.configured);
  el.assistantKey.textContent = state.ai.configured ? "Ключ ИИ подключён · изменить" : "Подключить ключ ИИ";
  el.aiKeyButton.title = state.ai.configured ? `Картинки рисует Cloudflare (аккаунт ${state.ai.account_hint || ""})` : "Добавить ключ ИИ для картинок";
  el.aiNotice.hidden = Boolean(state.ai.configured);
  drawSpeechNote();
}

function setAiStatus(text, kind = "") {
  el.aiStatus.textContent = text;
  el.aiStatus.classList.toggle("is-ok", kind === "ok");
  el.aiStatus.classList.toggle("is-error", kind === "error");
}

function openAiDialog() {
  el.aiAccount.value = "";
  el.aiToken.value = "";
  el.aiToken.type = "password";
  el.aiTokenShow.textContent = "Показать";
  el.aiDelete.hidden = !state.ai.configured || state.ai.source === "env";
  if (state.ai.source === "env") setAiStatus("Ключ задан на сервере — менять его здесь не нужно.", "ok");
  else if (state.ai.configured) setAiStatus(`Ключ сохранён (аккаунт ${state.ai.account_hint}). Чтобы заменить — вставь новый.`, "ok");
  else setAiStatus("Ключа пока нет — картинки рисует медленный бесплатный генератор.");
  if (!el.aiDialog.open) el.aiDialog.showModal();
  window.setTimeout(() => el.aiAccount.focus(), 30);
}

async function saveAiKey() {
  const account = el.aiAccount.value.trim();
  const token = el.aiToken.value.trim();
  if (!account || !token) {
    setAiStatus("Вставь и Account ID, и токен.", "error");
    return;
  }
  el.aiSave.disabled = true;
  setAiStatus("Проверяю ключ в Cloudflare…");
  try {
    const result = await apiJson("/api/ai/settings", { body: { account_id: account, api_token: token } });
    state.ai = result;
    el.aiToken.value = "";
    drawAiChip();
    if (result.warning) setAiStatus(`Ключ сохранён, но проверить его не удалось: ${result.warning}`, "error");
    else setAiStatus("Ключ работает ✓ Теперь картинки рисует Cloudflare.", "ok");
    el.aiDelete.hidden = false;
    if (isPictures()) syncPicturesControls();
  } catch (error) {
    setAiStatus(error?.message || String(error), "error");
  } finally {
    el.aiSave.disabled = false;
  }
}

async function deleteAiKey() {
  try {
    state.ai = await apiJson("/api/ai/settings", { method: "DELETE" });
    drawAiChip();
    el.aiDelete.hidden = true;
    setAiStatus("Ключ удалён с этого компьютера.");
    if (isPictures()) syncPicturesControls();
  } catch (error) {
    setAiStatus(error?.message || String(error), "error");
  }
}

function wireAiDialog() {
  el.aiKeyButton.addEventListener("click", openAiDialog);
  el.assistantKey.addEventListener("click", () => {
    document.querySelector("#assistantDialog")?.close?.();
    openAiDialog();
  });
  el.aiClose.addEventListener("click", () => el.aiDialog.close());
  el.aiSave.addEventListener("click", () => { void saveAiKey(); });
  el.aiDelete.addEventListener("click", () => { void deleteAiKey(); });
  el.aiTokenShow.addEventListener("click", () => {
    const show = el.aiToken.type === "password";
    el.aiToken.type = show ? "text" : "password";
    el.aiTokenShow.textContent = show ? "Скрыть" : "Показать";
  });
  el.aiForm?.addEventListener?.("submit", (event) => event.preventDefault());
  [el.aiAccount, el.aiToken].forEach((input) => input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void saveAiKey();
    }
  }));
}

// ---------------------------------------------------------------------------
// Монтаж: обрезка, умный монтаж, лучшие моменты, голос

function currentSkips() {
  return skipRangesFor(state.edit, state.duration || 0);
}

let skipCache = { key: "", map: new TimeMap([]) };
function skipMap() {
  const key = JSON.stringify([state.edit.trimStart, state.edit.trimEnd, state.edit.cuts.map((cut) => [cut.start, cut.end, cut.enabled]), state.duration]);
  if (skipCache.key !== key) skipCache = { key, map: new TimeMap(currentSkips()) };
  return skipCache.map;
}

/** Слова, чья середина попала в вырезанный кусок, не показываются после склейки. */
function markHidden(cues, map = skipMap()) {
  if (map.isEmpty()) return cues;
  return cues.map((cue) => {
    let changed = false;
    const words = cue.words.map((word) => {
      const hidden = map.isSkipped((word.start + word.end) / 2);
      if (hidden) changed = true;
      return hidden ? { ...word, hidden: true } : word;
    });
    return changed ? { ...cue, words } : cue;
  });
}

// ---------------------------------------------------------------------------
// Время ролика и лента монтажа
//
// Исходник (S) → сборка со вставками (M) → готовый ролик (O), см. montage.js.
// Предпросмотр, субтитры, звуки и эффекты живут в M; лента и часы показывают O.

let montageCache = { key: "", model: null, cuesFor: null, cues: null };

function touchMontage() {
  state.montage.version += 1;
}

/** Модель монтажа для текущих склеек и вставок (пересобирается, только когда они меняются). */
function montage() {
  skipMap();
  const key = `${state.montage.version}|${skipCache.key}`;
  if (montageCache.key !== key || !montageCache.model) {
    const withMedia = (item) => ({ ...item, media: mediaOf(item) || { duration: 0 } });
    const model = buildMontage({
      duration: state.duration || 0,
      inserts: state.montage.inserts.map(withMedia),
      overlays: state.montage.overlays.map(withMedia),
      splits: state.montage.splits,
      skips: currentSkips(),
    });
    montageCache = { key, model, cuesFor: null, cues: null };
    montagePlayer.setModel(model);
    invalidateFx();
  }
  return montageCache.model;
}

/** Текст в шкале сборки: со вставками, вырезанные слова помечены (как в готовом ролике). */
function previewCues() {
  const model = montage();
  if (montageCache.cuesFor !== state.cues) {
    montageCache.cuesFor = state.cues;
    montageCache.cues = lyricsMode() ? lyricsToM(state.cues, model) : markHidden(model.cuesToM(state.cues), model.skipsM);
  }
  return montageCache.cues;
}

function lyricsMode() {
  return state.cuesBase === "O";
}

/** Свой текст лежит во времени ролика (O); сборке и предпросмотру нужно время M. */
function lyricsToM(cues, model) {
  const map = (start, end) => {
    const s = model.fromO(start);
    return [s, Math.max(s + 0.02, model.fromOLeft(end))];
  };
  return cues.map((cue) => {
    const [start, end] = map(cue.start, cue.end);
    return { ...cue, start, end, words: cue.words.map((word) => {
      const [ws, we] = map(word.start, word.end);
      return { ...word, start: ws, end: we };
    }) };
  });
}

/** План для сервера: в каком порядке склеить исходник и вставки, где положить видео поверх. */
function montagePlan(model) {
  const uploadFor = (item) => state.montage.media.get(item.mediaKey)?.uploadId || null;
  return {
    frame: { width: state.videoSize?.width || 0, height: state.videoSize?.height || 0 },
    segments: model.exportSegments(uploadFor),
    overlays: model.exportOverlays(uploadFor),
    duck: model.duckRanges(),
  };
}

/** Время исходника там, где бегунок (во вставке — её место). */
function sourceNow() {
  const model = montage();
  const m = montagePlayer.time;
  const s = model.sourceAt(m);
  return s != null ? s : model.segmentAt(m)?.item?.at ?? 0;
}

function resetMontage() {
  beatDialog.selected.clear();
  beatDialog.order = [];
  montagePlayer.reset();
  for (const media of state.montage.media.values()) {
    if (media.url) URL.revokeObjectURL(media.url);
    timeline.dropMedia(media.key);
  }
  state.montage.inserts = [];
  state.montage.overlays = [];
  state.montage.splits = [];
  state.montage.audios = [];
  state.montage.media = new Map();
  state.montage.selection = null;
  mainPeaksFor = "";
  touchMontage();
  timeline.setSelection(null);
}

// --- Отмена действий: «Отменить» и Ctrl+Z для всего --------------------------
//
// Студия помнит состояние проекта по разделам (текст, стиль, монтаж, эффекты, звук…).
// Любое действие человека (нажатие, ввод, перетаскивание) — шаг; «Отменить» возвращает
// только те разделы, что поменял этот шаг. То, что меняется само (распознавание речи,
// картинки ИИ), — не шаг: его «Отменить» не трогает.

const UNDO_SECTIONS = ["montage", "text", "translation", "style", "sound", "pictures", "edit", "fx", "hook", "moments", "transitions"];
const UNDO_NAMES = {
  montage: "монтаж", edit: "монтаж", text: "текст", translation: "перевод", style: "стиль", sound: "звук",
  pictures: "картинки", fx: "эффекты", hook: "хук", moments: "лучшие моменты", transitions: "переходы",
};
const UNDO_LIMIT = 60;
const UNDO_USER_MS = 4000;   // изменение в течение 4 с после действия — часть этого действия
const undo = { current: null, past: [], future: [], touchedAt: 0, expect: false, applying: false, timer: 0 };

function undoSections() {
  const data = projectData();
  const parts = {
    ...data,
    montage: { inserts: data.montage.inserts, overlays: data.montage.overlays, splits: data.montage.splits, audios: data.montage.audios },
    fx: { ...data.fx, faces: undefined, facesFor: undefined },
  };
  return Object.fromEntries(UNDO_SECTIONS.map((key) => [key, JSON.stringify(parts[key] ?? null)]));
}

function undoReset() {
  window.clearTimeout(undo.timer);
  undo.past = [];
  undo.future = [];
  undo.expect = false;
  undo.current = state.video ? undoSections() : null;
  drawUndoButtons();
}

/** Человек что-то сделал: через полсекунды тишины изменения станут одним шагом. */
function undoTouch() {
  undo.touchedAt = performance.now();
  window.clearTimeout(undo.timer);
  undo.timer = window.setTimeout(undoCheck, 450);
}

function undoCheck() {
  if (undo.applying || project.restoring || !state.video) return;
  const now = undoSections();
  if (!undo.current) {
    undo.current = now;
    return;
  }
  const changed = UNDO_SECTIONS.filter((key) => now[key] !== undo.current[key]);
  if (!changed.length) return;
  const top = undo.past[undo.past.length - 1];
  if (top && !undo.expect && top.touch === undo.touchedAt) {
    // То же действие дозавершилось (например, ИИ дописал хук) — дополняем шаг.
    for (const key of changed) if (!(key in top.before)) top.before[key] = undo.current[key];
  } else if (undo.expect || performance.now() - undo.touchedAt < UNDO_USER_MS) {
    undo.past.push({ before: Object.fromEntries(changed.map((key) => [key, undo.current[key]])), touch: undo.touchedAt });
    if (undo.past.length > UNDO_LIMIT) undo.past.shift();
    undo.future = [];
  }
  undo.expect = false;
  undo.current = now;
  drawUndoButtons();
}

/** Перед действием, которое меняет студию: прошлое — отдельным шагом, это действие — новым. */
function pushHistory() {
  undoCheck();
  undo.touchedAt = performance.now();
  undo.expect = true;
  window.clearTimeout(undo.timer);
  undo.timer = window.setTimeout(undoCheck, 30);
}

function undoLabel(step) {
  return [...new Set(Object.keys(step.before).map((key) => UNDO_NAMES[key] || key))].join(", ");
}

function applyUndoSections(values) {
  undo.applying = true;
  try {
    for (const key of UNDO_SECTIONS) {
      if (!(key in values)) continue;
      const data = JSON.parse(values[key]) ?? {};
      if (key === "montage") applyMontageSection(data);
      else if (key === "text") applyTextSection(data);
      else if (key === "translation") applyTranslationSection(data);
      else if (key === "style") applyStyleSection(data);
      else if (key === "sound") applySoundSection(data);
      else if (key === "pictures") applyPicturesSection(data);
      else if (key === "edit") applyEditSection(data);
      else if (key === "fx") applyFxSection({ ...data, faces: state.fx.faces, facesFor: state.fx.facesFor });
      else if (key === "hook") applyHookSection(data);
      else if (key === "moments") applyMomentsSection(data);
      else if (key === "transitions") applyTransitionsSection(data);
    }
    state.montage.selection = null;
    timeline.setSelection(null);
    redrawProject();
    onEditChanged();
  } finally {
    undo.applying = false;
    undo.current = undoSections();
    undo.touchedAt = performance.now();
    undo.expect = false;
    drawUndoButtons();
  }
}

function undoEdit() {
  undoCheck();
  const step = undo.past.pop();
  if (!step) {
    toast("Отменять пока нечего.");
    return;
  }
  step.after = Object.fromEntries(Object.keys(step.before).map((key) => [key, undo.current[key]]));
  applyUndoSections(step.before);
  undo.future.push(step);
  setTimelineNote(`Отменено: ${undoLabel(step)}.`);
  toast(`↶ Отменено: ${undoLabel(step)}`, 2200);
}

function redoEdit() {
  undoCheck();
  const step = undo.future.pop();
  if (!step) {
    toast("Возвращать нечего.");
    return;
  }
  applyUndoSections(step.after);
  undo.past.push(step);
  setTimelineNote(`Возвращено: ${undoLabel(step)}.`);
  toast(`↷ Возвращено: ${undoLabel(step)}`, 2200);
}

function drawUndoButtons() {
  if (!el.undoButton) return;
  const last = undo.past[undo.past.length - 1];
  const next = undo.future[undo.future.length - 1];
  el.undoButton.disabled = !last;
  el.redoButton.disabled = !next;
  el.undoButton.title = last ? `Отменить: ${undoLabel(last)} (Ctrl+Z)` : "Отменить (Ctrl+Z)";
  el.redoButton.title = next ? `Вернуть: ${undoLabel(next)} (Ctrl+Shift+Z)` : "Вернуть (Ctrl+Shift+Z)";
}

function wireUndo() {
  // Любое действие в студии — повод проверить, что изменилось.
  for (const type of ["pointerup", "change", "input", "keyup", "drop"]) {
    document.addEventListener(type, (event) => {
      if (event.target?.closest?.(".history-btns")) return;
      undoTouch();
    }, true);
  }
  // Изменения сами по себе (распознавание, ИИ) — новое «как есть», не шаг.
  window.setInterval(undoCheck, 1000);
  el.undoButton.addEventListener("click", () => undoEdit());
  el.redoButton.addEventListener("click", () => redoEdit());
  document.addEventListener("keydown", (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    // В полях ввода Ctrl+Z правит сам текст поля — как везде.
    if (event.target?.closest?.("input, select, textarea, [contenteditable]")) return;
    if (document.querySelector("dialog[open]")) return;
    if (event.code === "KeyZ") {
      event.preventDefault();
      if (event.shiftKey) redoEdit();
      else undoEdit();
    } else if (event.code === "KeyY") {
      event.preventDefault();
      redoEdit();
    }
  });
}

function montageChanged() {
  touchMontage();
  onEditChanged();
}

// --- Правка вырезанного (время исходника) ------------------------------------

function editSnapshot() {
  return { trimStart: state.edit.trimStart, trimEnd: state.edit.trimEnd, cuts: state.edit.cuts, manual: state.edit.manual };
}

function applyEdit(next, cover = null) {
  state.edit.trimStart = next.trimStart;
  state.edit.trimEnd = next.trimEnd;
  state.edit.cuts = next.cuts;
  state.edit.manual = next.manual;
  rebuildCuts();
  // Только что вырезанное включено, даже если такая склейка раньше была выключена галочкой.
  if (cover) {
    for (const cut of state.edit.cuts) if (cut.kind === "manual" && cut.end > cover[0] + 0.001 && cut.start < cover[1] - 0.001) cut.enabled = true;
  }
  onEditChanged();
}

/** Вернуть в ролик кусок исходника [a, b). */
function revealSource(a, b) {
  if (!(b - a > 0.005)) return;
  pushHistory();
  applyEdit(revealRange(editSnapshot(), a, b, state.duration || 0));
}

/** Вырезать кусок исходника [a, b). */
function coverSource(a, b) {
  if (!(b - a > 0.02)) return;
  pushHistory();
  applyEdit(coverRange(editSnapshot(), a, b, state.duration || 0), [a, b]);
}

// --- Свои видео: вставки и видео поверх --------------------------------------

function readClipMeta(url) {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;
    const done = (value, error) => {
      video.removeAttribute("src");
      video.load();
      if (error) reject(error);
      else resolve(value);
    };
    video.onloadedmetadata = () => done({ duration: video.duration, width: video.videoWidth, height: video.videoHeight });
    video.onerror = () => done(null, new Error("браузер не смог открыть это видео"));
    video.src = url;
  });
}

async function importClip(file) {
  const url = URL.createObjectURL(file);
  let meta;
  try {
    meta = await readClipMeta(url);
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
  if (!(meta.duration > MIN_CLIP) || !meta.width || !Number.isFinite(meta.duration)) {
    URL.revokeObjectURL(url);
    throw new Error("в файле нет видео");
  }
  const key = `m${++state.montage.seq}`;
  const media = { key, name: file.name || "видео", file, url, duration: meta.duration, width: meta.width, height: meta.height, hasAudio: true, uploadId: null, uploading: null };
  state.montage.media.set(key, media);
  timeline.setMedia(key, { url, aspect: meta.width / Math.max(1, meta.height), duration: meta.duration });
  void uploadClip(media).catch(() => {});
  return media;
}

/** Очередь загрузок вставок: пачка из десяти видео не забивает связь и не упирается в лимит сервера. */
const clipQueue = { running: 0, waiting: [] };
const CLIP_UPLOADS_AT_ONCE = 2;

async function inClipQueue(task) {
  if (clipQueue.running >= CLIP_UPLOADS_AT_ONCE) await new Promise((resolve) => clipQueue.waiting.push(resolve));
  clipQueue.running += 1;
  try {
    return await task();
  } finally {
    clipQueue.running -= 1;
    clipQueue.waiting.shift()?.();
  }
}

/** Видео вставки уходит на сервер сразу: к сборке ролика оно уже будет там. */
function uploadClip(media) {
  if (media.uploadId) return Promise.resolve(media.uploadId);
  if (!media.uploading) {
    media.uploading = inClipQueue(async () => {
      let result;
      if (server.active) {
        // Telegram на телефоне: частями, с докачкой после обрыва — как основное видео.
        guardClose(true);
        try {
          result = await uploadInChunks(media.file, { name: media.name });
        } finally {
          guardClose(false);
        }
      } else {
        const session = await requestJson("/api/upload-session");
        result = await requestJson(`/api/uploads?name=${encodeURIComponent(media.name)}`, {
          method: "POST",
          headers: { "X-CSRF-Token": session.csrf, "Content-Type": media.file.type || "application/octet-stream" },
          body: media.file,
        });
      }
      if (!result?.id) throw new Error("Reel Lab не сохранил видео вставки");
      media.uploadId = result.id;
      media.hasAudio = result.media?.has_audio !== false;
      if (media.hasAudio) void loadClipPeaks(media);
      return media.uploadId;
    });
    media.uploading.catch((error) => {
      media.uploading = null;
      media.error = error?.message || String(error);
    });
  }
  return media.uploading;
}

async function loadClipPeaks(media) {
  try {
    const data = await requestJson(`/api/sounds/peaks?upload=${encodeURIComponent(media.uploadId)}&n=2000`);
    timeline.setMedia(media.key, { peaks: { values: data.peaks, duration: data.duration } });
  } catch (_) { /* без очертания звука */ }
}

let mainPeaksFor = "";
/** Очертание звука исходника для ленты (видео уже лежит на сервере после распознавания). */
async function ensureMainPeaks() {
  if (!state.uploadId || mainPeaksFor === state.uploadId) return;
  mainPeaksFor = state.uploadId;
  try {
    const data = await requestJson(`/api/sounds/peaks?upload=${encodeURIComponent(state.uploadId)}&n=4000`);
    timeline.setMedia("main", { peaks: { values: data.peaks, duration: data.duration } });
  } catch (_) { /* в видео нет звука */ }
}

let clipPurpose = "insert";
function pickClip(purpose) {
  if (!state.video) return;
  clipPurpose = purpose;
  el.clipInput.click();
}

/** Как вписать клип в кадр: близкий по форме — заполнить, иначе целиком на размытом фоне. */
function defaultFit(media) {
  const frame = (state.videoSize?.width || 9) / Math.max(1, state.videoSize?.height || 16);
  const clip = media.width / Math.max(1, media.height);
  return Math.abs(clip - frame) / frame < 0.18 ? "cover" : "blur";
}

function junctionEdgesS(model) {
  const edges = [...state.montage.splits];
  for (const junction of model.junctions()) edges.push(junction.s0, junction.s1);
  return edges;
}

async function addClip(file, purpose) {
  pausePreview();
  setTimelineNote("Открываю видео…");
  let media;
  try {
    media = await importClip(file);
  } catch (error) {
    setTimelineNote(`Видео не добавилось: ${error?.message || error}`);
    return;
  }
  const model = montage();
  const m = montagePlayer.time;
  const segment = model.segmentAt(m);
  pushHistory();
  state.montage.seq += 1;
  const id = `${purpose === "overlay" ? "o" : "i"}${state.montage.seq}`;
  if (purpose === "overlay") {
    const at = segment?.kind === "insert" ? segment.item.at : model.sourceAt(m) ?? 0;
    state.montage.overlays.push({ id, mediaKey: media.key, at, in: 0, out: Math.min(media.duration, 6), volume: 0, fit: defaultFit(media), seq: state.montage.seq });
  } else {
    let at;
    let seq = state.montage.seq;
    if (segment?.kind === "insert") {
      // Бегунок во вставке — новая встаёт сразу после неё.
      at = segment.item.at;
      seq = segment.item.seq + 0.5;
    } else {
      at = snapInsertPoint(model.sourceAt(m) ?? 0, flatWords(state.cues), junctionEdgesS(model), 0.3);
    }
    const length = media.duration <= 15 ? media.duration : 8;
    state.montage.inserts.push({ id, mediaKey: media.key, at, in: 0, out: length, volume: 1, fit: defaultFit(media), seq });
  }
  montageChanged();
  const next = montage();
  if (purpose === "overlay") {
    const place = next.overlays.find((entry) => entry.item.id === id);
    if (place) seekM(place.m0 + 0.01);
    selectInTimeline({ kind: "overlay", key: `o:${id}` });
    setTimelineNote("Видео поверх добавлено: голос под ним продолжает звучать. Потяни за края, чтобы обрезать, или перетащи, чтобы сдвинуть.");
  } else {
    const item = next.inserts.find((entry) => entry.id === id);
    if (item) seekM(item.m0 + 0.01);
    selectInTimeline({ kind: "insert", key: `i:${id}` });
    setTimelineNote(media.duration > 15
      ? "Вставка добавлена — взяты первые 8 секунд. Потяни за правый край, чтобы взять больше; перетащи, чтобы поставить в другое место."
      : "Вставка добавлена. Потяни за края, чтобы обрезать её; перетащи, чтобы поставить в другое место.");
  }
}

/** Сколько секунд видео берётся целиком, когда видео добавляют пачкой (монтаж из планов, фильм). */
const BATCH_CLIP_SECONDS = 600;

/**
 * Несколько видео сразу: встают друг за другом там, где бегунок (или в конце ролика —
 * at = длина исходника), целиком. Так из планов собирается фильм или влог.
 */
async function addClips(files, { atEnd = false } = {}) {
  pausePreview();
  const medias = [];
  for (const [index, file] of files.entries()) {
    setTimelineNote(`Открываю видео ${index + 1} из ${files.length}…`);
    try {
      medias.push(await importClip(file));
    } catch (error) {
      toast(`«${file.name}» не добавилось: ${error?.message || error}`, 4500);
    }
  }
  if (!medias.length) {
    setTimelineNote("Видео не добавились.");
    return 0;
  }
  const model = montage();
  const m = montagePlayer.time;
  const segment = atEnd ? null : model.segmentAt(m);
  pushHistory();
  let at;
  let base;
  if (atEnd) {
    at = state.duration;
    base = state.montage.seq;
  } else if (segment?.kind === "insert") {
    at = segment.item.at;
    base = segment.item.seq;
  } else {
    at = snapInsertPoint(model.sourceAt(m) ?? 0, flatWords(state.cues), junctionEdgesS(model), 0.3);
    base = state.montage.seq;
  }
  // Вставки в одной точке идут по seq: дробные номера держат их между текущей и следующей.
  let firstId = "";
  medias.forEach((media, index) => {
    state.montage.seq += 1;
    const id = `i${state.montage.seq}`;
    firstId = firstId || id;
    state.montage.inserts.push({
      id, mediaKey: media.key, at, in: 0, out: Math.min(media.duration, BATCH_CLIP_SECONDS), volume: 1,
      fit: defaultFit(media), seq: base + (index + 1) / (medias.length + 1),
    });
  });
  montageChanged();
  const next = montage();
  const item = next.inserts.find((entry) => entry.id === firstId);
  if (item) seekM(item.m0 + 0.01);
  selectInTimeline({ kind: "insert", key: `i:${firstId}` });
  setTimelineNote(`${countRu(medias.length, ["видео встало", "видео встали", "видео встали"])} друг за другом. Порядок меняется перетаскиванием, переход между видео — ромбик на стыке.`);
  return medias.length;
}

// --- Музыка и звуки на ленте ---------------------------------------------------
//
// Любой звук или музыка (файл со звуком или видео — из него берётся звук)
// кладётся на отдельную дорожку ленты там, где бегунок. Время — готового
// ролика (O): звук стоит там, куда его положили; его можно сдвинуть,
// обрезать за края, разрезать, сделать тише или громче.

const audioPeaks = new Map();

/** Звуки на ленте в пределах ролика: { clip, o0, o1 }. */
function audioPlaces(model = montage()) {
  const total = model.totalO || 0;
  return state.montage.audios.map((clip) => {
    const o0 = clampNumber(Number(clip.o) || 0, 0, total);
    const o1 = Math.min(total, o0 + Math.max(0, clip.out - clip.in));
    return { clip, o0, o1 };
  }).filter((place) => place.o1 - place.o0 > 0.02);
}

/** Звуки с ленты для проигрывателя и сборки (время ролика). */
function audioClipsPlan(model = montage()) {
  return audioPlaces(model).map(({ clip, o0, o1 }) => ({
    url: clip.url, o: o0, in: clip.in, out: clip.in + (o1 - o0),
    volume: Number(clip.volume ?? 1), duck: Boolean(clip.duck), fade: Boolean(clip.fade),
  }));
}

function audioById(id) {
  return state.montage.audios.find((clip) => clip.id === id) || null;
}

function selectedAudio(selection = state.montage.selection) {
  return selection?.kind === "audio" ? audioById(selection.key.slice(2)) : null;
}

/** Звуки на ленте изменились: лента, готовый ролик устарел, звук — заново. */
function audioChanged() {
  hideResult();
  refreshTimeline();
  updateTimelineToolbar();
  drawSimple();
  if (state.playing) startSounds();
}

function pickAudio() {
  if (!state.video) return;
  el.audioInput.click();
}

async function addAudioFile(file) {
  pausePreview();
  const name = String(file.name || "звук").replace(/\.[^.]+$/, "");
  setTimelineNote(`Загружаю «${name}»…`);
  try {
    const source = await uploadSoundSource(file);
    const end = Math.min(source.duration || 0, 1200);
    if (!(end > 0.05)) throw new Error("в файле нет звука");
    setTimelineNote(`Готовлю звук «${name}»…`);
    const entry = await apiJson("/api/sounds/own", { body: { source: source.source, start: 0, end, kind: "music", label: name } });
    const model = montage();
    const o = clampNumber(model.toO(montagePlayer.time), 0, Math.max(0, model.totalO - MIN_CLIP));
    const seconds = Number(entry.seconds) || end;
    const length = Math.min(seconds, Math.max(MIN_CLIP, model.totalO - o));
    // Длинный трек — музыка: тише под голосом, плавно входит и уходит. Короткий — звук как есть.
    const music = seconds >= 12;
    pushHistory();
    state.montage.seq += 1;
    const id = `a${state.montage.seq}`;
    state.montage.audios.push({
      id, url: entry.files[0], soundId: entry.id, name: entry.label || name, duration: seconds,
      o, in: 0, out: length, volume: music ? 0.6 : 1, duck: music, fade: music,
    });
    audioChanged();
    selectInTimeline({ kind: "audio", key: `a:${id}` });
    setTimelineNote(music
      ? "Музыка на ленте: под голосом она тише. Потяни за края — обрезать, перетащи — сдвинуть, громкость — ползунок сверху."
      : "Звук на ленте. Перетащи его на нужное место или обрежь за края.");
    void loadAudioPeaks(entry.files[0]);
    void reloadOwnSounds().catch(() => {});
  } catch (error) {
    setTimelineNote(`Звук не добавился: ${error?.message || error}`);
  }
}

/** Очертание звука на дорожке ленты (по самому файлу, в браузере). */
async function loadAudioPeaks(url) {
  if (!url || audioPeaks.has(url)) return;
  audioPeaks.set(url, null);
  try {
    const buffer = await loadClipBuffer(url, player.ensureContext());
    audioPeaks.set(url, clipPeaks(buffer));
    refreshTimeline();
  } catch (_) {
    audioPeaks.delete(url);
  }
}

// --- Лента монтажа -------------------------------------------------------------

/** Исходник как клип: замедленный (ускоренный) кусок — вставка из самого видео. */
function mainMedia() {
  const size = state.videoSize || {};
  return { key: SELF_MEDIA, name: state.video?.name || "видео", url: state.videoUrl || "", duration: state.duration || 0,
    width: size.width || 0, height: size.height || 0, hasAudio: true, uploadId: state.uploadId || null, self: true };
}

function mediaOf(item) {
  if (item?.mediaKey === SELF_MEDIA) return state.video ? mainMedia() : null;
  return state.montage.media.get(item?.mediaKey) || null;
}

function speedText(speed) {
  return `${String(Math.round(speed * 100) / 100).replace(".", ",")}×`;
}

/** Подпись клипа на ленте: имя видео (или «Замедление») и скорость. */
function clipLabel(item) {
  const speed = clipSpeed(item);
  const changed = Math.abs(speed - 1) > 1e-3;
  const base = item.mediaKey === SELF_MEDIA && changed ? (speed < 1 ? "Замедление" : "Ускорение") : mediaLabel(item);
  return changed ? `${base} · ${speedText(speed)}` : base;
}

function mediaLabel(item) {
  return (mediaOf(item)?.name || "видео").replace(/\.[^.]+$/, "");
}

function clipAspect(item) {
  const media = mediaOf(item);
  return media ? media.width / Math.max(1, media.height) : 16 / 9;
}

function timelineDocument() {
  const model = montage();
  const frameAspect = (state.videoSize?.width || 9) / Math.max(1, state.videoSize?.height || 16);
  const pieces = model.pieces().map((piece) => (piece.kind === "insert"
    ? { ...piece, mediaKey: piece.item.mediaKey, clipStart: piece.item.in, speed: piece.item.speed, label: clipLabel(piece.item), aspect: clipAspect(piece.item) }
    : { ...piece, mediaKey: "main", aspect: frameAspect }));
  const overlays = model.overlays.filter((place) => place.visible).map((place) => ({
    key: `o:${place.item.id}`, item: place.item, o0: place.o0, o1: place.o1, mediaKey: place.item.mediaKey,
    clipStart: place.item.in, speed: place.item.speed, label: clipLabel(place.item), aspect: clipAspect(place.item),
  }));
  // Склейка, на месте которой стоит замедленный кусок, — не отдельная отметка: это он сам.
  const selfCuts = model.inserts.filter((item) => item.mediaKey === SELF_MEDIA);
  const junctions = model.junctions().filter((junction) => !selfCuts.some((item) => Math.abs(junction.s0 - item.in) < 0.03
    && Math.abs(junction.s1 - item.out) < 0.03 && (Math.abs(item.at - item.in) < 0.03 || Math.abs(item.at - item.out) < 0.03)));
  const words = [];
  flatWords(state.cues).forEach((word, w) => {
    const m0 = model.toM(word.start);
    const length = Math.max(0.01, word.end - word.start);
    if (model.isSkippedM(m0 + length / 2)) return;
    words.push({ w, text: word.text, o0: model.toO(m0), o1: model.toO(m0 + length), keyword: isKeyword(word.text) });
  });
  const audios = audioPlaces(model).map(({ clip, o0, o1 }) => ({
    key: `a:${clip.id}`, o0, o1, label: clip.name, clipStart: clip.in, volume: Number(clip.volume ?? 1), duck: Boolean(clip.duck),
    peaks: audioPeaks.get(clip.url) || null,
  }));
  for (const clip of state.montage.audios) if (!audioPeaks.has(clip.url)) void loadAudioPeaks(clip.url);
  // Стыки: между видео, на склейках (кусок вырезан) и на разрезах — кружок перехода на ленте.
  const transitions = junctionsOf(model).filter((junction) => junction.kind === "clip" || junction.key.startsWith("cut:")).map((junction) => {
    const type = transitionFor(state.transitions, junction);
    return { key: junction.key, kind: junction.kind, o: junction.o, row: junction.row, type,
      label: type === "none" ? (junction.kind === "split" ? "Разрез" : "Склейка") : transitionById(type).label, custom: Boolean(state.transitions.custom[junction.key]) };
  });
  return { totalO: model.totalO, pieces, junctions, transitions, overlays, words, audios, beats: videoBeats(model), fx: timelineEffects(model) };
}

/** Работа ИИ над кадром на ленте: зумы, хук, картинки (время ролика). */
function timelineEffects(model) {
  const fx = fxSpec();
  const items = [];
  for (const zoom of fx.zooms) {
    if (!Number.isInteger(zoom.w)) continue;
    items.push({
      key: `z:${zoom.w}`, kind: "zoom", w: zoom.w, manual: zoom.manual,
      o0: model.toO(zoom.start), o1: model.toO(zoom.end), scale: zoom.scale,
      label: `Зум ×${zoom.scale.toFixed(2).replace(/0$/, "")}`,
      short: "Зум",
    });
  }
  if (fx.hook) items.push({ key: "hook", kind: "hook", o0: model.toO(fx.hook.start), o1: model.toO(fx.hook.end), label: `Хук: ${fx.hook.text}`, short: "Хук" });
  if (isPictures() && state.pictures.plan?.items?.length) {
    const words = flatWords(state.cues);
    for (const item of state.pictures.plan.items) {
      const word = words[item.w];
      if (!word) continue;
      const m = model.toM(word.start);
      if (model.isSkippedM(m + 0.01)) continue;
      const prepared = item.url ? state.preview.images?.get(item.url) : null;
      const image = prepared ? (state.pictures.blend === "screen" ? prepared.screen : prepared.cut) : null;
      const o = model.toO(m);
      items.push({ key: `p:${item.id}`, kind: "picture", id: item.id, o0: o, o1: o + 0.05, image, status: item.status, label: item.word || word.text });
    }
  }
  return items.sort((a, b) => a.o0 - b.o0);
}

let timelineDocRequest = 0;
function refreshTimeline() {
  if (!state.montage.open) return;
  if (timelineDocRequest) return;
  timelineDocRequest = requestAnimationFrame(() => {
    timelineDocRequest = 0;
    if (!state.montage.open) return;
    timeline.setDocument(state.video && state.duration ? timelineDocument() : null);
    timeline.setTime(montage().toO(montagePlayer.time));
    updateTimelineToolbar();
  });
}

function itemById(kind, id) {
  return (kind === "overlay" ? state.montage.overlays : state.montage.inserts).find((item) => item.id === id) || null;
}

function selectedItem(selection = state.montage.selection) {
  if (selection?.kind !== "insert" && selection?.kind !== "overlay") return null;
  return itemById(selection.kind, selection.key.slice(2));
}

function selectedPiece(selection = state.montage.selection) {
  if (selection?.kind !== "piece") return null;
  return montage().pieces().find((piece) => piece.kind === "main" && piece.key === selection.key) || null;
}

function selectedOverlayPlace(selection = state.montage.selection) {
  if (selection?.kind !== "overlay") return null;
  return montage().overlays.find((place) => `o:${place.item.id}` === selection.key) || null;
}

function selectedJunction(selection = state.montage.selection) {
  if (selection?.kind !== "junction") return null;
  return montage().junctions().find((junction) => junction.key === selection.key) || null;
}

function formatSeconds(seconds) {
  return seconds < 10 ? `${seconds.toFixed(1).replace(".", ",")} с` : `${Math.round(seconds)} с`;
}

const TIMELINE_HINT = "Тяни ленту — перемотка. Нажми на кусок — выделишь его, края выделенного тянутся. Кружок между кусками — переход. Слово под лентой — выделить и вырезать.";

function setTimelineNote(text) {
  el.tlNote.textContent = text || TIMELINE_HINT;
}

/** Что вырезано в склейке: паузы, «эээ», повторы, вручную. */
function junctionInfo(junction) {
  const kinds = new Set();
  for (const cut of state.edit.cuts) {
    if (cut.enabled && cut.end > junction.s0 + 0.01 && cut.start < junction.s1 - 0.01) kinds.add(CUT_LABELS[cut.kind] || "Вырезано");
  }
  if (state.edit.trimStart > 0.02 && junction.s0 < 0.01) kinds.add("Обрезка начала");
  if (state.edit.trimEnd != null && junction.s1 >= (state.edit.trimEnd || 0) - 0.01 && junction.s1 >= state.duration - 0.05) kinds.add("Обрезка конца");
  const words = flatWords(state.cues).filter((word) => (word.start + word.end) / 2 >= junction.s0 && (word.start + word.end) / 2 <= junction.s1).map((word) => word.text);
  const said = words.length ? ` «${words.slice(0, 6).join(" ")}${words.length > 6 ? "…" : ""}»` : "";
  return `${[...kinds].join(", ") || "Вырезано"}: ${formatSeconds(junction.seconds)}${said}.`;
}

function noteFor(selection) {
  if (!selection) return TIMELINE_HINT;
  if (selection.kind === "piece") return "Кусок выделен. Потяни за края — подрезать или вернуть вырезанное рядом. «Вырезать кусок» — убрать целиком. Замедлить — скорость над лентой (лучше сначала «Разрезать», чтобы замедлить только момент).";
  if (selection.kind === "insert") {
    const item = selectedItem(selection);
    if (item?.mediaKey === SELF_MEDIA) return `Кусок в скорости ${speedText(clipSpeed(item))}. Скорость — в строке над лентой, «1×» — вернуть как было. Края — обрезать.`;
    return "Вставка выделена. Края — обрезать, перетащи — переставить. «Целиком» — показать без обрезки краёв. Скорость — в строке над лентой.";
  }
  if (selection.kind === "overlay") return "Видео поверх выделено: голос под ним звучит. Края — обрезать, перетащи — сдвинуть.";
  if (selection.kind === "audio") {
    const clip = selectedAudio(selection);
    return clip ? `Звук «${clip.name}». Края — обрезать, перетащи — сдвинуть, «Разрезать» — на две части. Громкость — ползунок сверху.` : TIMELINE_HINT;
  }
  if (selection.kind === "junction") {
    const junction = selectedJunction(selection);
    return junction ? `Здесь склейка. ${junctionInfo(junction)} «Вернуть» — кусок снова в ролике. Переход — кружок на склейке.` : TIMELINE_HINT;
  }
  if (selection.kind === "transition") return "Выбери переход в окошке — он сразу проиграется. Поменять — снова нажми на кружок.";
  if (selection.kind === "words") {
    const words = flatWords(state.cues).slice(selection.w0, selection.w1 + 1).map((word) => word.text).join(" ");
    return `Выделено: «${words}». Тяни края выделения, чтобы взять больше слов, и нажми «Вырезать».`;
  }
  if (selection.kind === "fx") {
    const item = selectedEffect(selection);
    if (item?.kind === "zoom") {
      const word = flatWords(state.cues)[item.w]?.text || "";
      return `${item.manual ? "Твой зум" : "Зум ИИ"} на слове «${word}». Перетащи на другое слово, смени силу или убери.`;
    }
    if (item?.kind === "hook") return "Хук — крупная надпись в первые секунды. Текст можно изменить или убрать хук.";
    if (item?.kind === "picture") return `Картинка ИИ к слову «${item.label}». Можно нарисовать другую или убрать.`;
  }
  return TIMELINE_HINT;
}

function selectedEffect(selection = state.montage.selection) {
  if (selection?.kind !== "fx") return null;
  return timeline.doc?.fx?.find((item) => item.key === selection.key) || timelineEffects(montage()).find((item) => item.key === selection.key) || null;
}

const ZOOM_STEPS = [1.08, 1.13, 1.2, 1.3];

/** Слово под бегунком (или ближайшее рядом) — для своего зума. */
function wordAtPlayhead() {
  const model = montage();
  const s = model.sourceAt(montagePlayer.time);
  if (s == null) return null;
  const words = flatWords(state.cues);
  let best = null;
  let bestDistance = Infinity;
  words.forEach((word, w) => {
    if (!HAS_LETTERS.test(word.text) || model.isSkippedM(model.toM(word.start) + 0.01)) return;
    const distance = s >= word.start && s <= word.end ? 0 : Math.min(Math.abs(word.start - s), Math.abs(word.end - s));
    if (distance < bestDistance) {
      bestDistance = distance;
      best = { w, word };
    }
  });
  return best && bestDistance < 1.5 ? best : null;
}

function setZoom(w, scale) {
  const edits = state.fx.zoomEdits;
  edits.on = edits.on.filter((zoom) => zoom.w !== w);
  edits.off = edits.off.filter((value) => value !== w);
  if (scale) edits.on.push({ w, scale });
}

function removeZoom(item) {
  const edits = state.fx.zoomEdits;
  edits.on = edits.on.filter((zoom) => zoom.w !== item.w);
  // Под своим зумом мог быть зум ИИ на том же слове — он тоже убирается.
  if (!edits.off.includes(item.w)) edits.off.push(item.w);
}

const HAS_LETTERS = /[\p{L}\p{N}]/u;

function addZoomAtPlayhead() {
  const found = wordAtPlayhead();
  if (!found) {
    setTimelineNote("Поставь бегунок на слово — зум встанет на него.");
    return;
  }
  pushHistory();
  setZoom(found.w, state.fx.zoom === "dynamic" ? 1.2 : 1.13);
  onFxChanged();
  selectInTimeline({ kind: "fx", key: `z:${found.w}` });
  setTimelineNote(`Зум на слове «${found.word.text}». Перетащи его на другое слово или смени силу.`);
}

function effectAction(action) {
  const item = selectedEffect();
  if (!item) return;
  if (action === "remove") {
    pushHistory();
    if (item.kind === "zoom") {
      removeZoom(item);
      setTimelineNote("Зум убран. «Отменить» вернёт его.");
    } else if (item.kind === "hook") {
      state.hook.show = false;
      drawHook();
      setTimelineNote("Хук убран. Вернуть — «Отменить» или вкладка «Эффекты».");
    } else if (item.kind === "picture") {
      const picture = findPictureItem(item.id);
      if (picture && state.pictures.plan) {
        picture.removed = true;
        state.pictures.plan.items = state.pictures.plan.items.filter((other) => other !== picture);
        updatePicturesProgress();
        drawPicturesList();
        schedulePreview(0);
      }
      setTimelineNote("Картинка убрана.");
    }
    selectInTimeline(null);
    onFxChanged();
  } else if (action === "zoomPower" && item.kind === "zoom") {
    pushHistory();
    const index = ZOOM_STEPS.findIndex((step) => step > item.scale + 0.001);
    const scale = index < 0 ? ZOOM_STEPS[0] : ZOOM_STEPS[index];
    setZoom(item.w, scale);
    onFxChanged();
    selectInTimeline({ kind: "fx", key: `z:${item.w}` });
  } else if (action === "hookEdit" && item.kind === "hook") {
    applyMode("pro");
    openTab("fx");
    el.hookText.scrollIntoView({ behavior: "smooth", block: "center" });
    el.hookText.focus();
  } else if (action === "picAgain" && item.kind === "picture") {
    const picture = findPictureItem(item.id);
    if (picture) {
      picture.seed = randomSeed();
      picture.fresh = true;
      void generatePicture(picture);
      setTimelineNote("Рисую другую картинку…");
    }
  }
}

/** Зум перетащили: встаёт на ближайшее слово. */
function zoomDrop(o) {
  const words = (timeline.doc?.words || []).filter((word) => HAS_LETTERS.test(word.text));
  let best = null;
  for (const word of words) if (!best || Math.abs(word.o0 - o) < Math.abs(best.o0 - o)) best = word;
  return best;
}

function selectInTimeline(selection) {
  state.montage.selection = selection;
  timeline.setSelection(selection);
  updateTimelineToolbar();
  setTimelineNote(noteFor(selection));
}

function updateTimelineToolbar() {
  if (!state.montage.open) return;
  const selection = state.montage.selection;
  const button = (name) => el.tlBar.querySelector(`[data-tl="${name}"]`);
  const label = (name, text) => {
    const node = button(name)?.querySelector("[data-tl-label]");
    if (node && node.textContent !== text) node.textContent = text;
  };
  button("split").disabled = !state.duration;
  button("remove").hidden = !selection || selection.kind === "junction" || selection.kind === "transition";
  if (selection?.kind === "piece") label("remove", "Вырезать кусок");
  else if (selection?.kind === "insert" || selection?.kind === "overlay") label("remove", "Убрать видео");
  else if (selection?.kind === "audio") label("remove", "Убрать звук");
  else if (selection?.kind === "words") label("remove", selection.w1 > selection.w0 ? "Вырезать слова" : "Вырезать слово");
  const junction = selectedJunction(selection);
  button("restore").hidden = !junction;
  if (junction) label("restore", `Вернуть ${formatSeconds(junction.seconds)}`);
  const effect = selection?.kind === "fx" ? selectedEffect(selection) : null;
  if (effect) label("remove", effect.kind === "zoom" ? "Убрать зум" : effect.kind === "hook" ? "Убрать хук" : "Убрать картинку");
  button("zoomAdd").hidden = Boolean(selection && selection.kind !== "piece");
  button("zoomPower").hidden = effect?.kind !== "zoom";
  if (effect?.kind === "zoom") label("zoomPower", `Сила ×${effect.scale.toFixed(2).replace(/0$/, "")}`);
  button("hookEdit").hidden = effect?.kind !== "hook";
  button("picAgain").hidden = effect?.kind !== "picture";
  const item = selectedItem(selection);
  const self = item?.mediaKey === SELF_MEDIA;
  button("fit").hidden = !item || self;
  button("sound").hidden = !item;
  if (self) label("remove", "Убрать кусок");
  if (item) {
    label("fit", item.fit === "blur" ? "Заполнить кадр" : "Показать целиком");
    const on = (Number(item.volume) || 0) > 0.001;
    label("sound", on ? "Звук вкл" : "Звук выкл");
    button("sound").classList.toggle("is-off", !on);
  }
  const audio = selectedAudio(selection);
  el.tlVolume.hidden = !audio;
  button("duck").hidden = !audio;
  if (audio) {
    const percent = Math.round((Number(audio.volume ?? 1)) * 100);
    if (document.activeElement !== el.tlVolumeInput) el.tlVolumeInput.value = String(percent);
    el.tlVolumeValue.textContent = `${percent}%`;
    setRangeFill(el.tlVolumeInput);
    label("duck", audio.duck ? "Тише под голос: да" : "Тише под голос: нет");
    button("duck").classList.toggle("is-off", !audio.duck);
  }
  const model = montage();
  const inserts = model.inserts.length;
  const overlays = model.overlays.length;
  const sounds = state.montage.audios.length;
  button("beatFit").hidden = !(inserts || overlays) || !videoBeats(model).length;
  const extra = [inserts ? countRu(inserts, ["вставка", "вставки", "вставок"]) : "", overlays ? `${overlays} поверх` : "",
    sounds ? countRu(sounds, ["звук", "звука", "звуков"]) : ""].filter(Boolean).join(" · ");
  const text = `Ролик ${formatClock(model.totalO)}${extra ? ` · ${extra}` : ""}`;
  if (el.tlInfo.textContent !== text) el.tlInfo.textContent = text;
  drawTransitionChips();
  drawSpeedChips();
}

// --- Скорость: замедление и ускорение клипа или куска исходника ----------------

const SPEED_HINTS = { 0.25: "Очень медленно", 0.5: "Замедление вдвое", 0.75: "Чуть медленнее", 1: "Как снято", 1.5: "Чуть быстрее", 2: "Вдвое быстрее", 3: "Втрое быстрее" };

function drawSpeedChips() {
  if (!el.tlSpeed) return;
  const selection = state.montage.selection;
  const item = selectedItem(selection);
  const piece = selection?.kind === "piece" ? selectedPiece(selection) : null;
  el.tlSpeed.hidden = !item && !piece;
  if (el.tlSpeed.hidden) return;
  const current = item ? clipSpeed(item) : 1;
  const text = piece || item?.mediaKey === SELF_MEDIA ? "Скорость куска:" : item && selection.kind === "overlay" ? "Скорость видео поверх:" : "Скорость вставки:";
  if (el.tlSpeedLabel.textContent !== text) el.tlSpeedLabel.textContent = text;
  setChips(el.tlSpeedChips, SPEEDS.map((speed) => {
    const on = Math.abs(speed - current) < 1e-3;
    return `<button type="button" class="tl-tr-chip${on ? " is-active" : ""}" data-speed="${speed}" role="radio" aria-checked="${on}" title="${SPEED_HINTS[speed] || ""}">${speedText(speed)}</button>`;
  }).join(""));
  setSelect(el.tlSpeedSelect, SPEEDS.map((speed) => [String(speed), `${speedText(speed)} — ${SPEED_HINTS[speed] || ""}`]),
    String(SPEEDS.find((speed) => Math.abs(speed - current) < 1e-3) ?? 1));
}

/** Компактный выбор на ленте: список вместо ряда кнопок (не съедает высоту, где видео). */
function setSelect(select, options, value) {
  if (!select) return;
  const html = options.map(([id, label]) => `<option value="${escapeHtml(id)}">${escapeHtml(label)}</option>`).join("");
  if (select.dataset.html !== html) {
    select.innerHTML = html;
    select.dataset.html = html;
  }
  if (select.value !== value) select.value = value;
}

/** Проиграть клип после смены скорости: сразу видно, что получилось. */
function previewClipSpeed(m0, m1) {
  const model = montage();
  pausePreview();
  seekM(Math.max(model.firstM, m0 - 0.4));
  stopPreviewAt = Math.min(model.totalM, m1 + 0.4, m0 + 5);
  void togglePlay();
}

function setClipSpeed(speed) {
  if (!(speed > 0)) return;
  const selection = state.montage.selection;
  const piece = selection?.kind === "piece" ? selectedPiece(selection) : null;
  if (piece) {
    if (Math.abs(speed - 1) > 1e-3) speedPiece(piece, speed);
    return;
  }
  const item = selectedItem(selection);
  if (!item || Math.abs(clipSpeed(item) - speed) < 1e-3) return;
  if (item.mediaKey === SELF_MEDIA && Math.abs(speed - 1) < 1e-3) {
    restoreSelfInsert(item);
    return;
  }
  pushHistory();
  item.speed = speed;
  montageChanged();
  const model = montage();
  const placed = selection.kind === "overlay"
    ? model.overlays.find((place) => place.item.id === item.id)
    : model.inserts.find((entry) => entry.id === item.id);
  setTimelineNote(Math.abs(speed - 1) < 1e-3 ? "Обычная скорость." : `Скорость ${speedText(speed)}: ${SPEED_HINTS[speed]?.toLowerCase() || ""}. Длина на ленте изменилась.`);
  if (placed) previewClipSpeed(placed.m0, placed.m1);
}

/** Кусок исходника в другой скорости: он становится вставкой из самого видео на том же месте. */
function speedPiece(piece, speed) {
  pausePreview();
  pushHistory();
  state.montage.seq += 1;
  const id = `i${state.montage.seq}`;
  state.montage.inserts.push({ id, mediaKey: SELF_MEDIA, at: piece.s0, in: piece.s0, out: piece.s1, volume: 1, fit: "cover", seq: state.montage.seq, speed });
  touchMontage();
  applyEdit(coverRange(editSnapshot(), piece.s0, piece.s1, state.duration || 0), [piece.s0, piece.s1]);
  selectInTimeline({ kind: "insert", key: `i:${id}` });
  const spoken = flatWords(state.cues).some((word) => word.start < piece.s1 - 0.05 && word.end > piece.s0 + 0.05);
  setTimelineNote(`Кусок ${speed < 1 ? "замедлен" : "ускорен"}: ${speedText(speed)}.${spoken ? " Субтитров в нём нет — голос растянут." : ""} «1×» — вернуть как было.`);
  const placed = montage().inserts.find((entry) => entry.id === id);
  if (placed) previewClipSpeed(placed.m0, placed.m1);
}

/** «1×» у замедленного куска: кусок снова идёт как снято, с субтитрами. */
function restoreSelfInsert(item) {
  pausePreview();
  pushHistory();
  state.montage.inserts = state.montage.inserts.filter((entry) => entry.id !== item.id);
  touchMontage();
  applyEdit(revealRange(editSnapshot(), item.in, item.out, state.duration || 0));
  const model = montage();
  const piece = model.pieces().find((entry) => entry.kind === "main" && item.in + 0.02 >= entry.s0 && item.in + 0.02 < entry.s1);
  selectInTimeline(piece ? { kind: "piece", key: piece.key } : null);
  seekM(model.toM(item.in + 0.001));
  setTimelineNote("Кусок снова в обычной скорости.");
}

function hiddenBefore(s) {
  const model = montage();
  if (model.inserts.some((item) => Math.abs(item.at - s) < 0.005)) return 0;
  const range = model.skipsS.ranges.find((entry) => Math.abs(entry.end - s) < 0.01);
  return range ? s - range.start : 0;
}

function hiddenAfter(s) {
  const model = montage();
  if (model.inserts.some((item) => Math.abs(item.at - s) < 0.005)) return 0;
  const range = model.skipsS.ranges.find((entry) => Math.abs(entry.start - s) < 0.01);
  return range ? Math.min(state.duration || 0, range.end) - s : 0;
}

function overlayRoom(place) {
  let before = 0;
  let after = montage().totalO;
  for (const piece of montage().insertPiecesO()) {
    if (piece.o1 <= place.o0 + 0.001) before = Math.max(before, piece.o1);
    if (piece.o0 >= place.o1 - 0.001) after = Math.min(after, piece.o0);
  }
  return { before, after };
}

function edgeLimits(selection, edge) {
  if (selection?.kind === "piece") {
    const piece = selectedPiece(selection);
    if (!piece) return { min: 0, max: 0 };
    const length = piece.s1 - piece.s0;
    return edge === "left"
      ? { min: -hiddenBefore(piece.s0), max: Math.max(0, length - 0.1) }
      : { min: -Math.max(0, length - 0.1), max: hiddenAfter(piece.s1) };
  }
  if (selection?.kind === "insert") {
    const item = selectedItem(selection);
    const media = mediaOf(item);
    if (!item || !media) return { min: 0, max: 0 };
    // Края тянутся по времени ролика; у замедленного клипа секунда ленты — меньше секунды клипа.
    const speed = clipSpeed(item);
    const length = item.out - item.in;
    return edge === "left"
      ? { min: -item.in / speed, max: (length - MIN_CLIP) / speed }
      : { min: -(length - MIN_CLIP) / speed, max: Math.max(0, media.duration - item.out) / speed };
  }
  if (selection?.kind === "audio") {
    const clip = selectedAudio(selection);
    if (!clip) return { min: 0, max: 0 };
    const total = montage().totalO;
    const length = clip.out - clip.in;
    return edge === "left"
      ? { min: -Math.min(clip.in, clip.o), max: length - MIN_CLIP }
      : { min: -(length - MIN_CLIP), max: Math.max(0, Math.min(clip.duration - clip.out, total - (clip.o + length))) };
  }
  if (selection?.kind === "overlay") {
    const place = selectedOverlayPlace(selection);
    const media = mediaOf(place?.item);
    if (!place || !media) return { min: 0, max: 0 };
    const speed = clipSpeed(place.item);
    const length = place.o1 - place.o0;
    const room = overlayRoom(place);
    return edge === "left"
      ? { min: -Math.min(place.item.in / speed, place.o0 - room.before), max: length - MIN_CLIP / speed }
      : { min: -(length - MIN_CLIP / speed), max: Math.max(0, Math.min((media.duration - place.item.out) / speed, room.after - place.o1)) };
  }
  return { min: -Infinity, max: Infinity };
}

/** Края куска тянутся к границам слов: слово не режется пополам. Края клипов — к долям музыки. */
function snapEdge(selection, edge, delta, tolerance) {
  if (selection?.kind === "insert" || selection?.kind === "overlay") {
    const beats = videoBeats();
    if (!beats.length) return delta;
    const model = montage();
    let base = null;
    if (selection.kind === "insert") {
      // У вставки в долю встаёт конец (склейка со следующим кадром).
      const placed = model.inserts.find((item) => item.id === selection.key.slice(2));
      if (placed && edge === "right") base = model.toO(placed.m0) + placed.len;
    } else {
      const place = selectedOverlayPlace(selection);
      if (place) base = edge === "left" ? place.o0 : place.o1;
    }
    if (base == null) return delta;
    const beat = nearestBeat(beats, base + delta, tolerance * 1.5);
    return beat ? beat.o - base : delta;
  }
  if (selection?.kind === "piece") {
    const piece = selectedPiece(selection);
    if (!piece) return delta;
    const base = edge === "left" ? piece.s0 : piece.s1;
    const s = base + delta;
    let best = s;
    let distance = tolerance;
    for (const word of flatWords(state.cues)) {
      if (word.end < s - 2) continue;
      if (word.start > s + 2) break;
      for (const point of [word.start - 0.04, word.end + 0.04]) {
        if (Math.abs(point - s) < distance) {
          distance = Math.abs(point - s);
          best = point;
        }
      }
    }
    return best - base;
  }
  if (selection?.kind === "words") {
    const words = timeline.doc?.words || [];
    const current = words.filter((word) => word.w >= selection.w0 && word.w <= selection.w1);
    if (!current.length) return delta;
    const base = edge === "left" ? current[0].o0 : current[current.length - 1].o1;
    const target = base + delta;
    let best = null;
    for (const word of words) {
      const point = edge === "left" ? word.o0 : word.o1;
      if (edge === "left" && word.w > selection.w1) continue;
      if (edge === "right" && word.w < selection.w0) continue;
      if (!best || Math.abs(point - target) < Math.abs(best.point - target)) best = { point, word };
    }
    return best ? best.point - base : delta;
  }
  return delta;
}

function previewEdge(selection, edge, delta) {
  if (selection?.kind === "piece") {
    const piece = selectedPiece(selection);
    if (!piece) return;
    const s = edge === "left" ? piece.s0 + delta : piece.s1 + delta - 0.04;
    montagePlayer.peekAt("main", null, clampNumber(s, 0, Math.max(0, (state.duration || 0) - 0.02)));
  } else if (selection?.kind === "insert" || selection?.kind === "overlay") {
    const item = selectedItem(selection);
    if (!item) return;
    const speed = clipSpeed(item);
    const t = edge === "left" ? item.in + delta * speed : item.out + delta * speed - 0.04;
    montagePlayer.peekAt(selection.kind, { ...item, media: mediaOf(item) }, Math.max(0, t));
  } else return;
  drawFrameSoon();
}

function commitEdge(selection, edge, delta) {
  montagePlayer.clearPeek({ restore: false });
  if (selection?.kind === "piece") {
    const piece = selectedPiece(selection);
    if (!piece) return;
    if (edge === "left") {
      const s = piece.s0 + delta;
      if (delta > 0) coverSource(piece.s0, s);
      else revealSource(s, piece.s0);
      const after = montage().pieces().find((entry) => entry.kind === "main" && s + 0.02 >= entry.s0 && s + 0.02 < entry.s1);
      selectInTimeline(after ? { kind: "piece", key: after.key } : null);
      seekM(montage().toM(s + 0.001));
    } else {
      const s = piece.s1 + delta;
      if (delta < 0) coverSource(s, piece.s1);
      else revealSource(piece.s1, s);
      const after = montage().pieces().find((entry) => entry.kind === "main" && s - 0.02 >= entry.s0 && s - 0.02 < entry.s1);
      selectInTimeline(after ? { kind: "piece", key: after.key } : null);
      seekM(Math.max(0, montage().toMLeft(s) - 0.6));
    }
    return;
  }
  if (selection?.kind === "insert") {
    const item = selectedItem(selection);
    const media = mediaOf(item);
    if (!item || !media) return;
    pushHistory();
    const speed = clipSpeed(item);
    if (edge === "left") item.in = clampNumber(item.in + delta * speed, 0, item.out - MIN_CLIP);
    else item.out = clampNumber(item.out + delta * speed, item.in + MIN_CLIP, media.duration);
    montageChanged();
    const placed = montage().inserts.find((entry) => entry.id === item.id);
    if (placed) seekM(edge === "left" ? placed.m0 + 0.01 : Math.max(placed.m0, placed.m1 - 0.6));
    return;
  }
  if (selection?.kind === "audio") {
    const clip = selectedAudio(selection);
    if (!clip) return;
    pushHistory();
    if (edge === "left") {
      const shift = clampNumber(delta, -Math.min(clip.in, clip.o), clip.out - clip.in - MIN_CLIP);
      clip.in += shift;
      clip.o += shift;
    } else {
      clip.out = clampNumber(clip.out + delta, clip.in + MIN_CLIP, clip.duration);
    }
    audioChanged();
    return;
  }
  if (selection?.kind === "overlay") {
    const place = selectedOverlayPlace(selection);
    const media = mediaOf(place?.item);
    if (!place || !media) return;
    const item = itemById("overlay", place.item.id);
    pushHistory();
    const speed = clipSpeed(item);
    if (edge === "left") {
      const nextIn = clampNumber(item.in + delta * speed, 0, item.out - MIN_CLIP);
      const model = montage();
      const s = model.sourceAt(model.fromO(place.o0 + (nextIn - item.in) / speed));
      if (s != null) item.at = s;
      item.in = nextIn;
    } else {
      item.out = clampNumber(item.out + delta * speed, item.in + MIN_CLIP, media.duration);
    }
    montageChanged();
    return;
  }
  if (selection?.kind === "words") {
    const words = timeline.doc?.words || [];
    const current = words.filter((word) => word.w >= selection.w0 && word.w <= selection.w1);
    if (!current.length) return;
    const target = (edge === "left" ? current[0].o0 : current[current.length - 1].o1) + delta;
    let best = null;
    for (const word of words) {
      const point = edge === "left" ? word.o0 : word.o1;
      if (!best || Math.abs(point - target) < Math.abs(best.point - target)) best = { point, word };
    }
    if (!best) return;
    const w0 = edge === "left" ? Math.min(best.word.w, selection.w1) : selection.w0;
    const w1 = edge === "right" ? Math.max(best.word.w, selection.w0) : selection.w1;
    selectInTimeline({ kind: "words", w0, w1 });
  }
}

/** Куда встанет вставка, если отпустить её в точке o ролика. */
function insertDrop(model, o, selfId) {
  const m = model.fromO(clampNumber(o, 0, model.totalO));
  const segment = model.segmentAt(m);
  if (segment?.kind === "insert") {
    if (segment.item.id === selfId) return null;
    const before = m < (segment.m0 + segment.m1) / 2;
    return { at: segment.item.at, seq: segment.item.seq + (before ? -0.5 : 0.5) };
  }
  const s = model.sourceAt(m) ?? 0;
  return { at: snapInsertPoint(s, flatWords(state.cues), junctionEdgesS(model), 0.3), seq: null };
}

function moveTarget(selection, o) {
  const model = montage();
  if (selection?.kind === "fx") {
    const word = zoomDrop(o);
    return word ? word.o0 : null;
  }
  if (selection?.kind === "insert") {
    const drop = insertDrop(model, o, selection.key.slice(2));
    return drop ? model.toO(model.toMLeft(drop.at)) : null;
  }
  if (selection?.kind === "overlay") {
    const target = clampNumber(o, 0, model.totalO);
    const beat = nearestBeat(videoBeats(model), target, 12 / Math.max(1, timeline.pps || 40));
    return beat ? beat.o : target;
  }
  if (selection?.kind === "audio") return clampNumber(o, 0, Math.max(0, model.totalO - MIN_CLIP));
  return null;
}

function commitMove(selection, o) {
  const model = montage();
  if (selection?.kind === "fx") {
    const item = selectedEffect(selection);
    const word = zoomDrop(o);
    if (!item || item.kind !== "zoom" || !word || word.w === item.w) return;
    pushHistory();
    removeZoom(item);
    setZoom(word.w, item.scale);
    onFxChanged();
    selectInTimeline({ kind: "fx", key: `z:${word.w}` });
    setTimelineNote(`Зум переехал на слово «${word.text}».`);
    return;
  }
  if (selection?.kind === "insert") {
    const id = selection.key.slice(2);
    const drop = insertDrop(model, o, id);
    const item = itemById("insert", id);
    if (!drop || !item) return;
    pushHistory();
    state.montage.seq += 1;
    item.at = drop.at;
    item.seq = drop.seq ?? state.montage.seq;
    montageChanged();
    const placed = montage().inserts.find((entry) => entry.id === id);
    if (placed) seekM(placed.m0 + 0.01);
    setTimelineNote("Вставка переставлена.");
  } else if (selection?.kind === "overlay") {
    const item = itemById("overlay", selection.key.slice(2));
    if (!item) return;
    const m = model.fromO(clampNumber(o, 0, model.totalO));
    const segment = model.segmentAt(m);
    const s = segment?.kind === "insert" ? segment.item.at : model.sourceAt(m);
    if (s == null) return;
    pushHistory();
    item.at = s;
    montageChanged();
    setTimelineNote("Видео поверх сдвинуто.");
  } else if (selection?.kind === "audio") {
    const clip = selectedAudio(selection);
    if (!clip) return;
    pushHistory();
    clip.o = clampNumber(o, 0, Math.max(0, model.totalO - MIN_CLIP));
    audioChanged();
    setTimelineNote("Звук сдвинут.");
  }
}

function timelineRemove() {
  const selection = state.montage.selection;
  if (!selection) return;
  if (selection.kind === "piece") {
    const piece = selectedPiece(selection);
    if (!piece) return;
    coverSource(piece.s0, piece.s1);
    selectInTimeline(null);
    setTimelineNote(`Кусок вырезан (${formatSeconds(piece.s1 - piece.s0)}). Вернуть — нажми на красную отметку склейки или «Отменить».`);
  } else if (selection.kind === "insert" || selection.kind === "overlay") {
    const list = selection.kind === "insert" ? state.montage.inserts : state.montage.overlays;
    const index = list.findIndex((item) => item.id === selection.key.slice(2));
    if (index < 0) return;
    pushHistory();
    list.splice(index, 1);
    selectInTimeline(null);
    montageChanged();
    setTimelineNote("Видео убрано. «Отменить» вернёт его.");
  } else if (selection.kind === "audio") {
    const index = state.montage.audios.findIndex((clip) => clip.id === selection.key.slice(2));
    if (index < 0) return;
    pushHistory();
    state.montage.audios.splice(index, 1);
    selectInTimeline(null);
    audioChanged();
    setTimelineNote("Звук убран. «Отменить» вернёт его.");
  } else if (selection.kind === "junction") {
    timelineRestore();
  } else if (selection.kind === "fx") {
    effectAction("remove");
  } else if (selection.kind === "words") {
    const words = flatWords(state.cues);
    const first = words[selection.w0];
    const last = words[selection.w1];
    if (!first || !last) return;
    const previous = words[selection.w0 - 1];
    const next = words[selection.w1 + 1];
    const a = Math.max(previous ? previous.end : 0, first.start - 0.04);
    const b = Math.min(next ? next.start : state.duration || last.end + 0.04, last.end + 0.04);
    coverSource(a, b);
    selectInTimeline(null);
    setTimelineNote("Вырезано. Вернуть — нажми на красную отметку склейки или «Отменить».");
  }
}

function timelineRestore() {
  const junction = selectedJunction();
  if (!junction) return;
  revealSource(junction.s0, junction.s1);
  const piece = montage().pieces().find((entry) => entry.kind === "main" && junction.s0 + 0.02 >= entry.s0 && junction.s0 + 0.02 < entry.s1);
  selectInTimeline(null);
  if (piece) seekM(montage().toM(junction.s0 + 0.001));
  setTimelineNote(`Кусок вернулся в ролик (${formatSeconds(junction.seconds)}).`);
}

function timelineSplit() {
  const model = montage();
  const m = montagePlayer.time;
  const audio = selectedAudio();
  if (audio) {
    // Выделен звук — режется он: там, где бегунок.
    const o = model.toO(m);
    const local = o - audio.o;
    if (local < MIN_CLIP || audio.out - audio.in - local < MIN_CLIP) {
      setTimelineNote("Поставь бегунок внутрь выделенного звука, не у самого края.");
      return;
    }
    pushHistory();
    state.montage.seq += 1;
    const id = `a${state.montage.seq}`;
    state.montage.audios.push({ ...audio, id, o, in: audio.in + local });
    audio.out = audio.in + local;
    audioChanged();
    selectInTimeline({ kind: "audio", key: `a:${id}` });
    setTimelineNote("Звук разрезан. Ненужную часть можно убрать.");
    return;
  }
  const segment = model.segmentAt(m);
  if (segment?.kind === "insert") {
    const item = itemById("insert", segment.item.id);
    const local = segment.item.in + (m - segment.m0) * clipSpeed(segment.item);
    if (!item || local - item.in < MIN_CLIP || item.out - local < MIN_CLIP) {
      setTimelineNote("Слишком близко к краю вставки — сдвинь бегунок.");
      return;
    }
    pushHistory();
    state.montage.seq += 1;
    state.montage.inserts.push({ ...item, id: `i${state.montage.seq}`, in: local, seq: item.seq + 0.25 });
    item.out = local;
    montageChanged();
    setTimelineNote("Вставка разрезана на две части.");
    return;
  }
  const s = model.sourceAt(m);
  const piece = model.pieces().find((entry) => entry.kind === "main" && m >= entry.m0 && m < entry.m1);
  if (s == null || !piece || s - piece.s0 < 0.1 || piece.s1 - s < 0.1) {
    setTimelineNote("Здесь уже край куска — сдвинь бегунок.");
    return;
  }
  pushHistory();
  state.montage.splits.push(s);
  montageChanged();
  setTimelineNote("Кусок разрезан. Кружок на разрезе — поставить переход. Ненужную часть — нажми на неё и «Вырезать кусок».");
}

function timelineAction(action) {
  const selection = state.montage.selection;
  if (action === "undo") undoEdit();
  else if (action === "redo") redoEdit();
  else if (action === "split") timelineSplit();
  else if (action === "remove") timelineRemove();
  else if (action === "restore") timelineRestore();
  else if (action === "insert") pickClip("insert");
  else if (action === "overlay") pickClip("overlay");
  else if (action === "audio") pickAudio();
  else if (action === "duck") {
    const clip = selectedAudio(selection);
    if (!clip) return;
    pushHistory();
    clip.duck = !clip.duck;
    audioChanged();
  }
  else if (action === "beatMontage") openBeatDialog();
  else if (action === "beatFit") fitToBeats();
  else if (action === "zoomAdd") addZoomAtPlayhead();
  else if (action === "zoomPower" || action === "hookEdit" || action === "picAgain") effectAction(action);
  else if (action === "zoomIn") timeline.zoomBy(1.5);
  else if (action === "zoomOut") timeline.zoomBy(1 / 1.5);
  else if (action === "fit" || action === "sound") {
    const item = selectedItem(selection);
    if (!item) return;
    pushHistory();
    if (action === "fit") item.fit = item.fit === "blur" ? "cover" : "blur";
    else item.volume = (Number(item.volume) || 0) > 0.001 ? 0 : 1;
    montageChanged();
  }
  updateTimelineToolbar();
}

/** Строка под видео ↔ шапка ленты: при открытой ленте всё управление — в одной строке, кадр крупнее. */
const transportParts = { start: [], end: [] };
function dockTransport(intoTimeline) {
  if (!transportParts.start.length) {
    transportParts.start = [el.playButton, el.playButton.parentElement.querySelector(".clock"), el.playButton.parentElement.querySelector(".history-btns")];
    transportParts.end = [el.safeToggle, el.soundToggle, el.montageToggle].filter(Boolean);
  }
  const docked = el.playButton.parentElement === el.tlDockStart;
  if (intoTimeline && !docked) {
    el.tlDockStart.append(...transportParts.start);
    el.tlDockEnd.append(...transportParts.end);
    el.transport.classList.add("is-docked");
  } else if (!intoTimeline && docked) {
    el.transport.prepend(...transportParts.start);
    el.transport.append(...transportParts.end);
    el.transport.classList.remove("is-docked");
  }
}

function setTimelineOpen(open) {
  state.montage.open = Boolean(open) && Boolean(state.video);
  dockTransport(state.montage.open);
  el.timelinePanel.hidden = !state.montage.open;
  el.montageToggle.setAttribute("aria-pressed", String(state.montage.open));
  el.montageToggle.title = state.montage.open ? "Закрыть ленту монтажа" : "Лента монтажа: резать, вставлять видео, править склейки";
  el.montageToggle.classList.toggle("is-active", state.montage.open);
  el.ribbon.hidden = state.montage.open;
  document.body.classList.toggle("is-timeline", state.montage.open);
  if (state.montage.open) {
    timeline.resize();
    refreshTimeline();
    void ensureMainPeaks();
    setTimelineNote(noteFor(state.montage.selection));
  }
  fitScreen();
  // На телефоне лента сразу видна целиком.
  if (state.montage.open && window.matchMedia?.("(max-width: 980px)").matches) {
    window.setTimeout(() => el.timelinePanel.scrollIntoView({ behavior: "smooth", block: "end" }), 60);
  }
}

const timeline = new MontageTimeline({
  host: el.tlHost,
  actions: {
    seek: (o) => seekO(o),
    select: (selection) => {
      state.montage.selection = selection;
      updateTimelineToolbar();
      setTimelineNote(noteFor(selection));
      if (selection?.kind === "transition") openTransitionPicker(selection.key);
      else closeTransitionPicker();
    },
    edgeLimits,
    edgePreview: previewEdge,
    commitEdge,
    snapEdge,
    moveTarget,
    commitMove,
    interacting: (on) => {
      if (on) pausePreview();
      else if (montagePlayer.peeking) {
        montagePlayer.clearPeek();
        drawFrameSoon();
      }
    },
    remove: () => timelineRemove(),
    split: () => timelineSplit(),
  },
});
{
  // Время перерисовки ленты тоже попадает в замер скорости.
  const drawTimelineNow = timeline.draw.bind(timeline);
  timeline.draw = () => timed("timelineDraw", drawTimelineNow);
}

function wireTimeline() {
  el.montageToggle.addEventListener("click", () => setTimelineOpen(!state.montage.open));
  for (const button of [el.openTimeline, el.simpleTimeline]) {
    button.addEventListener("click", () => {
      setTimelineOpen(true);
      el.timelinePanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  }
  el.tlBar.addEventListener("click", (event) => {
    const button = event.target.closest("[data-tl]");
    if (button && !button.disabled) timelineAction(button.dataset.tl);
  });
  el.clipInput.addEventListener("change", () => {
    const files = [...(el.clipInput.files || [])];
    el.clipInput.value = "";
    if (!files.length) return;
    if (files.length === 1 || clipPurpose === "overlay") void addClip(files[0], clipPurpose);
    else void addClips(files);
  });
  el.audioToTimeline.addEventListener("click", () => {
    if (!state.video) return;
    setTimelineOpen(true);
    el.timelinePanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
    pickAudio();
  });
  el.audioInput.addEventListener("change", () => {
    const [file] = el.audioInput.files || [];
    el.audioInput.value = "";
    if (file) void addAudioFile(file);
  });
  // Громкость выделенного звука: меняется сразу, «Отменить» вернёт прежнюю.
  let volumeGesture = false;
  el.tlVolumeInput.addEventListener("input", () => {
    const clip = selectedAudio();
    if (!clip) return;
    if (!volumeGesture) {
      pushHistory();
      volumeGesture = true;
    }
    clip.volume = Number(el.tlVolumeInput.value) / 100;
    el.tlVolumeValue.textContent = `${el.tlVolumeInput.value}%`;
    setRangeFill(el.tlVolumeInput);
    hideResult();
    refreshTimeline();
    if (state.playing) startSounds();
  });
  el.tlVolumeInput.addEventListener("change", () => { volumeGesture = false; });
}

function clockPrecise(seconds) {
  const value = Math.max(0, seconds || 0);
  return `${Math.floor(value / 60)}:${(value % 60).toFixed(1).padStart(4, "0")}`;
}

const PAUSE_RULES = {
  soft: { gap: 0.9, pad: 0.18 },
  normal: { gap: 0.55, pad: 0.12 },
  hard: { gap: 0.35, pad: 0.08 },
};

function pauseCuts(strength) {
  const { gap, pad } = PAUSE_RULES[strength] || PAUSE_RULES.normal;
  const words = flatWords(state.cues);
  if (!words.length) return [];
  const cuts = [];
  const lead = words[0].start - pad * 1.5;
  if (lead > 0.25) cuts.push({ start: 0, end: lead, kind: "pause" });
  for (let i = 1; i < words.length; i += 1) {
    const silence = words[i].start - words[i - 1].end;
    if (silence > gap) cuts.push({ start: words[i - 1].end + pad, end: words[i].start - pad, kind: "pause" });
  }
  const tail = (state.duration || 0) - (words[words.length - 1].end + pad * 2);
  if (tail > 0.35) cuts.push({ start: words[words.length - 1].end + pad * 2, end: state.duration, kind: "pause" });
  return cuts.filter((cut) => cut.end - cut.start > 0.12);
}

function cutKey(cut) {
  return `${cut.kind}:${cut.start.toFixed(2)}`;
}

function rebuildCuts() {
  const previous = new Map(state.edit.cuts.map((cut) => [cutKey(cut), cut.enabled]));
  const all = [
    ...(state.edit.auto ? pauseCuts(state.edit.strength) : []),
    ...state.edit.aiCuts,
    // Куски, вырезанные человеком на ленте монтажа.
    ...state.edit.manual.map((cut) => ({ start: cut.start, end: cut.end, kind: "manual" })),
  ];
  all.sort((a, b) => a.start - b.start);
  state.edit.cuts = all.map((cut, i) => ({ ...cut, id: `c${i}`, enabled: previous.has(cutKey(cut)) ? previous.get(cutKey(cut)) : true }));
}

const CUT_LABELS = { pause: "Пауза", filler: "Паразит", repeat: "Повтор", false_start: "Оговорка", retake: "Дубль", manual: "Вырезано" };

function onEditChanged() {
  invalidateFx();
  hideResult();
  montage();
  drawTransitionPanel();
  drawRibbon();
  drawCutList();
  drawTrimInfo();
  refreshTimeline();
  drawAiReport();
  schedulePreview();
}

function drawTrimInfo() {
  const duration = state.duration || 0;
  const left = montage().totalO;
  el.timeTotal.textContent = formatClock(left);
  const trimmed = state.edit.trimStart > 0.02 || (state.edit.trimEnd != null && state.edit.trimEnd < duration - 0.02);
  el.trimInfo.textContent = duration
    ? (trimmed ? `${clockPrecise(state.edit.trimStart)} – ${clockPrecise(state.edit.trimEnd ?? duration)}` : "всё видео")
    : "";
  const enabled = state.edit.cuts.filter((cut) => cut.enabled);
  el.cutsInfo.textContent = enabled.length
    ? `${countRu(enabled.length, ["склейка", "склейки", "склеек"])} · ролик ${formatClock(left)} вместо ${formatClock(duration)}`
    : "";
}

function drawCutList() {
  const words = flatWords(state.cues);
  if (!state.edit.cuts.length) {
    el.cutList.innerHTML = "";
    return;
  }
  const rows = state.edit.cuts.map((cut) => {
    const inside = words.filter((word) => (word.start + word.end) / 2 >= cut.start && (word.start + word.end) / 2 <= cut.end).map((word) => word.text).join(" ");
    const what = cut.kind === "pause" ? `тишина ${(cut.end - cut.start).toFixed(1)} с` : `«${escapeHtml(inside || "…")}»`;
    return `<div class="cut-row${cut.enabled ? "" : " is-off"}" data-cut="${cut.id}">
      <input type="checkbox" data-cut-toggle="${cut.id}"${cut.enabled ? " checked" : ""} aria-label="Вырезать этот кусок">
      <span class="cut-what"><span class="cut-tag is-${cut.kind}">${CUT_LABELS[cut.kind] || "Кусок"}</span><b>${what}</b></span>
      <button type="button" class="link-btn cut-time" data-cut-seek="${cut.id}">${clockPrecise(cut.start)} ▶</button>
    </div>`;
  });
  el.cutList.innerHTML = `<div class="cut-actions"><button type="button" class="link-btn" data-cut-all="1">Вырезать всё</button><button type="button" class="link-btn" data-cut-all="0">Вернуть всё</button><button type="button" class="link-btn" data-cut-clear="1">Убрать список</button></div>${rows.join("")}`;
}

async function runSmartCut() {
  if (!state.cues.length || state.edit.busy) return;
  state.edit.busy = true;
  el.smartCutRun.disabled = true;
  el.smartCutRun.textContent = "ИИ слушает речь…";
  el.smartCutNote.hidden = true;
  try {
    const words = flatWords(state.cues);
    const payload = words.map((word, w) => ({ w, text: word.text, start: Math.round(word.start * 100) / 100, end: Math.round(word.end * 100) / 100 }));
    let note = "";
    let aiCuts = [];
    try {
      const result = await apiJson("/api/ai/smartcut", { body: { words: payload } });
      note = result.note || "";
      aiCuts = (result.remove || []).map((item) => {
        const first = words[item.from];
        const last = words[item.to];
        if (!first || !last) return null;
        return { start: Math.max(0, first.start - 0.03), end: last.end + 0.03, kind: item.reason || "filler" };
      }).filter(Boolean);
    } catch (error) {
      note = `Паузы найдены, а лишние слова — нет: ${error?.message || error}`;
    }
    pushHistory();
    state.edit.aiCuts = aiCuts;
    state.edit.auto = true;
    rebuildCuts();
    const total = state.edit.cuts.filter((cut) => cut.kind !== "manual").length;
    el.smartCutNote.hidden = false;
    el.smartCutNote.textContent = total
      ? `${note ? `${note} ` : ""}Нашёл ${countRu(total, ["кусок", "куска", "кусков"])}. Нажми ▶, чтобы проверить склейку.`
      : (note || "Речь и так плотная — вырезать нечего.");
    onEditChanged();
  } finally {
    state.edit.busy = false;
    el.smartCutRun.textContent = "Найти паузы и лишние слова заново";
    updateUi();
  }
}

function onCutListClick(event) {
  const seek = event.target.closest("[data-cut-seek]");
  if (seek) {
    const cut = state.edit.cuts.find((item) => item.id === seek.dataset.cutSeek);
    if (cut) {
      seekTo(Math.max(0, cut.start - 1.2));
      void togglePlayFrom();
    }
    return;
  }
  const all = event.target.closest("[data-cut-all]");
  if (all) {
    pushHistory();
    for (const cut of state.edit.cuts) cut.enabled = all.dataset.cutAll === "1";
    onEditChanged();
    return;
  }
  if (event.target.closest("[data-cut-clear]")) {
    // Список ИИ убирается; куски, вырезанные человеком на ленте, остаются.
    pushHistory();
    state.edit.aiCuts = [];
    state.edit.auto = false;
    rebuildCuts();
    el.smartCutNote.hidden = true;
    onEditChanged();
  }
}

async function togglePlayFrom() {
  if (!state.playing) await togglePlay();
}

function sentencesFromCues() {
  const sentences = [];
  let current = null;
  let previousEnd = -Infinity;
  for (const word of flatWords(state.cues)) {
    if (current && word.start - previousEnd > 1.2) {
      sentences.push(current);
      current = null;
    }
    if (!current) current = { start: word.start, end: word.end, text: "" };
    current.text += `${current.text ? " " : ""}${word.text}`;
    current.end = word.end;
    previousEnd = word.end;
    if (/[.!?…؟۔]$/.test(word.text)) {
      sentences.push(current);
      current = null;
    }
  }
  if (current) sentences.push(current);
  return sentences.map((item, n) => ({ n, start: Math.round(item.start * 10) / 10, end: Math.round(item.end * 10) / 10, text: item.text }));
}

async function runMoments() {
  if (!state.cues.length || state.moments.busy) return;
  state.moments.busy = true;
  el.momentsRun.disabled = true;
  el.momentsRun.textContent = "ИИ смотрит видео…";
  el.momentsNote.hidden = true;
  try {
    const [min, max] = state.moments.length.split("-").map(Number);
    const result = await apiJson("/api/ai/moments", { body: { sentences: sentencesFromCues(), min, max } });
    state.moments.list = result.moments || [];
    drawMoments();
  } catch (error) {
    el.momentsNote.hidden = false;
    el.momentsNote.textContent = `Не получилось: ${error?.message || error}`;
  } finally {
    state.moments.busy = false;
    el.momentsRun.textContent = "Найти лучшие моменты заново";
    updateUi();
  }
}

function drawMoments() {
  el.momentList.innerHTML = state.moments.list.map((moment, i) => `
    <div class="moment-card">
      <span class="moment-time">${clockPrecise(moment.start)} – ${clockPrecise(moment.end)} · ${Math.round(moment.end - moment.start)} с</span>
      <b>${escapeHtml(moment.title || `Момент ${i + 1}`)}</b>
      <span>${escapeHtml(moment.why || "")}</span>
      <div class="moment-actions">
        <button type="button" class="btn btn-ghost" data-moment-play="${i}">▶ Посмотреть</button>
        <button type="button" class="btn btn-primary" data-moment-use="${i}">Сделать ролик из этого</button>
      </div>
    </div>`).join("");
}

let stopPreviewAt = null;
function onMomentsClick(event) {
  const play = event.target.closest("[data-moment-play]");
  const use = event.target.closest("[data-moment-use]");
  const moment = state.moments.list[Number((play || use)?.dataset.momentPlay ?? (play || use)?.dataset.momentUse)];
  if (!moment) return;
  if (play) {
    stopPreviewAt = montage().toM(moment.end + 0.2);
    seekTo(moment.start);
    void togglePlayFrom();
  } else {
    pushHistory();
    state.edit.trimStart = Math.max(0, moment.start - 0.15);
    state.edit.trimEnd = Math.min(state.duration, moment.end + 0.35);
    onEditChanged();
    seekTo(state.edit.trimStart);
    el.momentsNote.hidden = false;
    el.momentsNote.textContent = "Готово: в ролике остался только этот кусок. Вернуть всё видео — «Сбросить обрезку».";
  }
}

// ---------------------------------------------------------------------------
// Эффекты: цвет, камера, текст за человеком, хук

const COLOR_CONTROLS = [
  ["brightness", "Яркость", -40, 40],
  ["contrast", "Контраст", -40, 40],
  ["saturation", "Насыщенность", -60, 60],
  ["warmth", "Тепло", -100, 100],
];
const ATMO_CONTROLS = [
  ["grain", "Зерно плёнки", 0, 100],
  ["leaks", "Засветы плёнки", 0, 100],
  ["dust", "Пыль и царапины", 0, 100],
  ["vignette", "Виньетка (тёмные края)", 0, 100],
  ["bars", "Кинополосы", 0, 100],
];
const ADJUST_CONTROLS = [...COLOR_CONTROLS, ...ATMO_CONTROLS];
const COLOR_KEYS = COLOR_CONTROLS.map(([key]) => key);
const ATMO_KEYS = ATMO_CONTROLS.map(([key]) => key);
const ATMO_NAMES = { grain: "зерно", leaks: "засветы плёнки", dust: "пыль и царапины", vignette: "виньетка", bars: "кинополосы" };

/** Готовая атмосфера: цвет + зерно, засветы, пыль, виньетка, полосы — одним нажатием. */
const ATMOSPHERES = [
  { id: "clean", label: "Чисто", look: "none", hint: "Без атмосферы: чистая картинка", atmo: {} },
  { id: "cinema", label: "Кино", look: "teal", hint: "Голливудский цвет и кинополосы", atmo: { bars: 55, grain: 12, vignette: 15 } },
  { id: "film", label: "Плёнка", look: "film", hint: "Матовая плёнка: зерно, засветы, пыль", atmo: { grain: 25, leaks: 35, dust: 30, vignette: 10 } },
  { id: "dream", label: "Мечта", look: "golden", hint: "Тёплые засветы, как на закате", atmo: { leaks: 65, grain: 8, vignette: 10 } },
  { id: "noir", label: "Нуар", look: "bw", hint: "Чёрно-белое кино с полосами", atmo: { bars: 40, grain: 35, dust: 25, vignette: 45 } },
  { id: "retro", label: "Ретро", look: "vintage", hint: "Старая плёнка: пыль, царапины, засветы", atmo: { grain: 30, leaks: 30, dust: 60, vignette: 15 } },
  { id: "moody", label: "Мрачно", look: "moody", hint: "Глухой цвет, тёмные края, полосы", atmo: { bars: 30, grain: 15, vignette: 20 } },
];

function atmoValues(preset) {
  return Object.fromEntries(ATMO_KEYS.map((key) => [key, Number(preset.atmo[key]) || 0]));
}

/** Какая готовая атмосфера сейчас стоит (null — настроено своё). */
function currentAtmosphere() {
  const adjust = state.fx.adjust;
  return ATMOSPHERES.find((preset) => {
    const values = atmoValues(preset);
    const lookMatches = preset.id === "clean" ? true : state.fx.look === preset.look;
    return lookMatches && ATMO_KEYS.every((key) => Math.abs((Number(adjust[key]) || 0) - values[key]) < 0.5);
  }) || null;
}

function atmosphereOn() {
  return ATMO_KEYS.some((key) => (Number(state.fx.adjust[key]) || 0) > 0.5);
}

function applyAtmosphere(id) {
  const preset = ATMOSPHERES.find((item) => item.id === id);
  if (!preset) return;
  state.fx.adjust = { ...state.fx.adjust, ...atmoValues(preset) };
  state.fx.look = preset.look;
  syncFxControls();
  onFxChanged();
}

/** Сбросить цвет (фильтр и свет), атмосферу не трогая. */
function resetColor() {
  state.fx.look = "none";
  for (const key of COLOR_KEYS) state.fx.adjust[key] = 0;
  syncFxControls();
  onFxChanged();
}

function resetAtmosphere() {
  for (const key of ATMO_KEYS) state.fx.adjust[key] = 0;
  syncFxControls();
  onFxChanged();
}

function atmoChipsHtml() {
  const active = currentAtmosphere()?.id || "";
  return ATMOSPHERES.map((item) => {
    const on = active === item.id;
    return `<button type="button" class="tl-tr-chip${on ? " is-active" : ""}" data-atmo="${item.id}" role="radio" aria-checked="${on}" title="${escapeHtml(item.hint)}">${escapeHtml(item.label)}</button>`;
  }).join("");
}

function drawAtmoChips() {
  const html = atmoChipsHtml();
  if (el.atmoPresets) setChips(el.atmoPresets, html);
  if (el.simpleAtmo) {
    el.simpleAtmo.hidden = !state.video;
    if (!el.simpleAtmo.hidden) setChips(el.simpleAtmoChips, html);
  }
}

let fxCache = null;
function invalidateFx() {
  fxCache = null;
}

function emphasisWords() {
  const set = new Set();
  const plan = isPictures() ? state.pictures.plan : null;
  for (const accent of plan?.accents || []) set.add(accent.w);
  for (const item of plan?.items || []) set.add(item.w);
  if (state.keywords.length) {
    flatWords(state.cues).forEach((word, w) => { if (isKeyword(word.text)) set.add(w); });
  }
  return set;
}

function longestWord(words) {
  let best = null;
  for (const word of words) {
    const clean = word.text.replace(/[^\p{L}\p{N}-]+/gu, "");
    if (clean.length < 4) continue;
    if (!best || clean.length > best.text.replace(/[^\p{L}\p{N}-]+/gu, "").length) best = word;
  }
  return best;
}

/** Зум ИИ на ключевом слове фразы плюс правка человеком: убранные и свои зумы (ключ — номер слова). */
function zoomEvents(map, cues) {
  const dynamic = state.fx.zoom === "dynamic";
  const edits = state.fx.zoomEdits || { off: [], on: [] };
  const off = new Set(edits.off);
  const manual = new Map((edits.on || []).map((zoom) => [zoom.w, zoom]));
  const phrases = picturePhrases(markHidden(cues, map));
  const events = [];
  const make = (word, phrase, scale, isManual) => ({
    w: word.w,
    start: word.start - 0.04,
    end: Math.min(phrase.end + 0.15, word.start + 3),
    scale,
    in: dynamic ? 0.1 : 0.22,
    out: dynamic ? 0.24 : 0.42,
    manual: isManual,
  });
  if (manual.size) {
    for (const phrase of phrases) {
      for (const word of phrase.words) {
        const zoom = manual.get(word.w);
        if (zoom && !map.isSkipped(word.start)) events.push(make(word, phrase, Number(zoom.scale) || 1.12, true));
      }
    }
  }
  if (state.fx.zoom !== "off") {
    const accents = emphasisWords();
    let lastStart = -Infinity;
    let n = 0;
    phrases.forEach((phrase, i) => {
      let word = phrase.words.find((item) => accents.has(item.w));
      if (!word && !accents.size && i % 2 === 0) word = longestWord(phrase.words);
      if (!word || map.isSkipped(word.start) || word.start - lastStart < 2.2) return;
      // Убранный зум не сдвигает остальные: расстановка ИИ остаётся той же.
      const scale = dynamic ? (n % 2 ? 1.2 : 1.13) : 1.08;
      lastStart = word.start;
      n += 1;
      if (off.has(word.w) || manual.has(word.w)) return;
      events.push(make(word, phrase, scale, false));
    });
  }
  return events.sort((a, b) => a.start - b.start);
}

function shakeEvents(map, cues) {
  const accents = emphasisWords();
  const words = flatWords(cues);
  const times = accents.size
    ? [...accents].map((w) => words[w]?.start).filter((t) => Number.isFinite(t))
    : picturePhrases(cues).filter((_, i) => i % 3 === 0).map((phrase) => phrase.start);
  times.sort((a, b) => a - b);
  const events = [];
  let last = -Infinity;
  for (const time of times) {
    if (map.isSkipped(time) || time - last < 2.5) continue;
    events.push({ time, duration: 0.32, strength: 0.8 });
    last = time;
  }
  return events;
}

/** Эффекты во времени сборки (M): зум и тряска по словам, вспышки на склейках и вставках. */
function fxSpec() {
  if (fxCache) return fxCache;
  const model = montage();
  const map = model.skipsM;
  const cues = model.cuesToM(state.cues);
  const look = lookById(state.fx.look);
  const first = model.firstM;
  const last = model.totalM;
  const visibleEnd = model.fromOLeft(model.totalO);
  const cutPoints = map.ranges.filter((range) => range.start > first + 0.05 && range.end < visibleEnd - 0.05).map((range) => range.end);
  for (const item of model.inserts) {
    if (item.m0 > first + 0.05) cutPoints.push(item.m0);
    if (item.m1 < visibleEnd - 0.05) cutPoints.push(item.m1);
  }
  cutPoints.sort((a, b) => a - b);
  fxCache = {
    filter: cssFilterFor(look, state.fx.adjust),
    overlays: overlaysFor(look, state.fx.adjust),
    zooms: zoomEvents(map, cues),
    faces: state.fx.followFace ? state.fx.faces.map((point) => ({ ...point, t: model.toM(point.t) })) : [],
    // Лицо не искали в студии (телефон) — сервер найдёт его сам перед сборкой.
    followFace: Boolean(state.fx.followFace),
    shakes: state.fx.shake ? shakeEvents(map, cues) : [],
    flashes: state.fx.flash ? cutPoints.map((time) => ({ time, duration: 0.18, strength: 0.45, color: "#ffffff" })) : [],
    jumpZoom: state.fx.jumpZoom && cutPoints.length ? 1.07 : 1,
    cutPoints,
    // Вставки и видео поверх — без зума и тряски камеры.
    still: model.stillRanges(),
    behind: Boolean(state.fx.behind),
    hook: state.hook.show && state.hook.text.trim() ? { text: state.hook.text.trim(), start: first + 0.05, end: first + 2.9 } : null,
    signature: signatureSpec(),
    translation: secondLineSpec(model),
    watermark: watermarkSpec(model),
    // Переходы на стыках (время M): предпросмотр и сборка рисуют их одним кодом.
    transitions: planTransitions(model, state.transitions),
  };
  void last;
  return fxCache;
}

function onFxChanged() {
  invalidateFx();
  hideResult();
  drawFrame();
  refreshTimeline();
  drawAiReport();
}

let lookThumb = "";
/** Кадр из видео для карточек фильтров: сразу видно, как фильтр ляжет на ролик. */
function captureLookThumb() {
  if (!state.video || !el.video.videoWidth) return "";
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 192;
    canvas.height = 120;
    const ctx = canvas.getContext("2d");
    const vw = el.video.videoWidth;
    const vh = el.video.videoHeight;
    const scale = Math.max(canvas.width / vw, canvas.height / vh);
    ctx.drawImage(el.video, (canvas.width - vw * scale) / 2, (canvas.height - vh * scale) / 2, vw * scale, vh * scale);
    return canvas.toDataURL("image/jpeg", 0.8);
  } catch (_) {
    return "";
  }
}

/** Карточки фильтров рисуются тем же кодом, что и ролик: цвет на карточке — как в готовом видео. */
const lookThumbs = new Map();
let lookThumbsFor = "";
function renderLookThumbs() {
  if (!lookThumb || lookThumbsFor === lookThumb) return;
  lookThumbsFor = lookThumb;
  const source = lookThumb;
  const image = new Image();
  image.onload = () => {
    if (source !== lookThumb) return;
    lookThumbs.clear();
    for (const look of LOOKS) {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const ctx = canvas.getContext("2d");
        ctx.filter = look.filter || "none";
        ctx.drawImage(image, 0, 0);
        ctx.filter = "none";
        const overlays = { ...overlaysFor(look, ADJUST_DEFAULTS), grain: 0 };
        drawUnderlays(ctx, { overlays }, 0, canvas.width, canvas.height);
        lookThumbs.set(look.id, canvas.toDataURL("image/jpeg", 0.82));
      } catch (_) {
        lookThumbs.delete(look.id);
      }
    }
    drawLookGrid();
  };
  image.src = source;
}

function drawLookGrid() {
  renderLookThumbs();
  const frame = lookThumb ? `url(${lookThumb})` : "linear-gradient(135deg,#d98b5f 0%,#5d7fa8 55%,#2e3a2c 100%)";
  el.lookGrid.innerHTML = LOOKS.map((look) => {
    const ready = lookThumbs.get(look.id);
    if (ready && lookThumbsFor === lookThumb) {
      return `<button type="button" class="look-card${state.fx.look === look.id ? " is-active" : ""}" data-look="${look.id}">
      <span class="look-swatch" style="background-image:url(${ready})"></span>${escapeHtml(look.label)}</button>`;
    }
    const alpha = look.tint ? Math.round(look.tint.alpha * 255).toString(16).padStart(2, "0") : "";
    const tint = look.tint ? `linear-gradient(${look.tint.color}${alpha}, ${look.tint.color}${alpha}),` : "";
    return `<button type="button" class="look-card${state.fx.look === look.id ? " is-active" : ""}" data-look="${look.id}">
      <span class="look-swatch" style="background-image:${tint}${frame};filter:${escapeHtml(look.filter || "none")}"></span>${escapeHtml(look.label)}</button>`;
  }).join("");
}

function adjustControlsHtml(list) {
  return list.map(([key, label, min, max]) => {
    const value = Math.round(Number(state.fx.adjust[key]) || 0);
    return `<div class="field"><label>${label} <output>${value > 0 && min < 0 ? "+" : ""}${value}</output></label>
      <input type="range" data-adjust="${key}" min="${min}" max="${max}" step="1" value="${value}"></div>`;
  }).join("");
}

function drawAdjustControls() {
  el.adjustControls.innerHTML = adjustControlsHtml(COLOR_CONTROLS);
  el.atmoControls.innerHTML = adjustControlsHtml(ATMO_CONTROLS);
  for (const box of [el.adjustControls, el.atmoControls]) box.querySelectorAll('input[type="range"]').forEach(setRangeFill);
}

function syncFxControls() {
  drawLookGrid();
  drawAdjustControls();
  drawAtmoChips();
  setSeg(el.zoomSeg, "value", state.fx.zoom);
  el.followFace.checked = state.fx.followFace;
  el.jumpZoom.checked = state.fx.jumpZoom;
  el.fxShake.checked = state.fx.shake;
  el.fxFlash.checked = state.fx.flash;
  el.fxBehind.checked = state.fx.behind;
  el.enhanceStabilize.checked = state.edit.enhance.stabilize;
  el.enhanceDenoise.checked = state.edit.enhance.denoise;
  el.enhanceSharpen.checked = state.edit.enhance.sharpen;
  el.voiceClean.checked = state.edit.voice.clean;
  el.voiceLevel.checked = state.edit.voice.level;
  setSeg(el.cutStrengthSeg, "value", state.edit.strength);
  setSeg(el.momentLenSeg, "value", state.moments.length);
}

/** Автоулучшение: по кадрам видео подбирает яркость, контраст, насыщенность и тепло. */
async function autoEnhance() {
  if (!state.video || !state.duration) return;
  el.autoEnhance.disabled = true;
  el.autoEnhance.textContent = "Смотрю на кадры…";
  try {
    const probe = document.createElement("video");
    probe.muted = true;
    probe.preload = "auto";
    probe.src = el.video.currentSrc || el.video.src;
    await new Promise((resolve, reject) => { probe.onloadeddata = resolve; probe.onerror = reject; });
    const w = 96;
    const h = Math.max(16, Math.round(w * probe.videoHeight / Math.max(1, probe.videoWidth)));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const lum = [];
    let sat = 0;
    let red = 0;
    let blue = 0;
    let count = 0;
    const start = state.edit.trimStart || 0;
    const end = state.edit.trimEnd ?? state.duration;
    for (let i = 0; i < 8; i += 1) {
      const t = start + (end - start) * ((i + 0.5) / 8);
      await new Promise((resolve) => { probe.onseeked = resolve; probe.currentTime = Math.min(state.duration - 0.05, t); });
      ctx.drawImage(probe, 0, 0, w, h);
      const data = ctx.getImageData(0, 0, w, h).data;
      for (let p = 0; p < data.length; p += 16) {
        const r = data[p] / 255;
        const g = data[p + 1] / 255;
        const b = data[p + 2] / 255;
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        lum.push(0.2126 * r + 0.7152 * g + 0.0722 * b);
        sat += max > 0 ? (max - min) / max : 0;
        red += r;
        blue += b;
        count += 1;
      }
    }
    probe.removeAttribute("src");
    lum.sort((a, b) => a - b);
    const mean = lum.reduce((s, v) => s + v, 0) / lum.length;
    const p5 = lum[Math.floor(lum.length * 0.05)];
    const p95 = lum[Math.floor(lum.length * 0.95)];
    const meanSat = sat / count;
    const adjust = { ...state.fx.adjust };
    adjust.brightness = Math.round(clampNumber((0.47 / Math.max(0.05, mean) - 1) * 55, -20, 25));
    adjust.contrast = Math.round(clampNumber((0.8 / Math.max(0.1, p95 - p5) - 1) * 45, -10, 25));
    adjust.saturation = meanSat < 0.2 ? 16 : meanSat < 0.32 ? 8 : meanSat > 0.5 ? -6 : 0;
    const cast = blue / Math.max(0.001, red);
    adjust.warmth = cast > 1.12 ? 18 : cast > 1.04 ? 9 : cast < 0.75 ? -10 : 0;
    state.fx.adjust = adjust;
    syncFxControls();
    onFxChanged();
    el.autoEnhance.textContent = "✦ Свет и цвет подобраны — можно подправить ниже";
  } catch (error) {
    console.error(error);
    el.autoEnhance.textContent = "✦ Автоулучшение не получилось — попробуй ещё раз";
  } finally {
    el.autoEnhance.disabled = false;
  }
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

async function ensureFaces() {
  if (!state.video || !state.duration || state.fx.scanning) return;
  if (state.light) {
    // Телефон: лицо найдёт сервер при сборке, здесь зум по центру.
    el.faceNote.hidden = false;
    el.faceNote.textContent = "Лицо найдёт сервер при сборке — в предпросмотре зум по центру.";
    return;
  }
  const key = `${state.video.name}:${state.video.size}:${state.duration}`;
  if (state.fx.facesFor === key && state.fx.faces.length) return;
  state.fx.scanning = true;
  el.faceNote.hidden = false;
  el.faceNote.textContent = "Загружаю нейросеть для поиска лица…";
  try {
    const faces = await scanFaces(el.video, state.duration, {
      step: state.duration > 120 ? 1 : 0.5,
      onProgress: (k) => { el.faceNote.textContent = `Ищу лицо в кадре… ${Math.round(k * 100)}%`; },
    });
    state.fx.faces = faces;
    state.fx.facesFor = key;
    el.faceNote.textContent = faces.length ? "Лицо найдено — зум будет приближать к нему." : "Лицо в кадре не найдено — зум будет по центру.";
    onFxChanged();
  } catch (error) {
    console.error(error);
    el.faceNote.textContent = `Поиск лица не получился: ${error?.message || error}`;
    state.fx.followFace = false;
    el.followFace.checked = false;
  } finally {
    state.fx.scanning = false;
  }
}

// --- Предпросмотр эффектов ---------------------------------------------------

let previewMasker = null;
let lightBehindNoted = false;
let previewMaskerLoading = false;
let previewMaskerFailedAt = -Infinity;
let previewMaskerAsync = false;

/** Нейросеть для предпросмотра — в отдельном потоке; не вышло — на странице, как при сборке. */
async function loadPreviewMasker() {
  try {
    const masker = new PreviewPersonMasker({ onUpdate: () => { if (!state.playing) drawFrameSoon(); } });
    await masker.init();
    previewMaskerAsync = true;
    return masker;
  } catch (error) {
    console.warn("[reel-lab] поток нейросети не запустился, считаю маску на странице", error);
    previewMaskerAsync = false;
    return sharedPersonMasker();
  }
}
const previewScratch = {};
const personMaskCache = { mask: null, at: 0 };

function sizeLayer(canvas) {
  // Телефон в Telegram: слои эффектов в полтора раза плотнее экрана, а не в два-три — плавнее.
  const ratio = Math.min(state.light ? 1.5 : 2, window.devicePixelRatio || 1);
  const w = Math.max(2, Math.round(el.screen.clientWidth * ratio));
  const h = Math.max(2, Math.round(el.screen.clientHeight * ratio));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return [w, h];
}

function captionsVisibleAt(t) {
  if (state.preview.kind === "pictures" && state.preview.timeline) return Boolean(pageAt(state.preview.timeline, t));
  if (state.preview.kind === "typewriter" && state.preview.timeline) return Boolean(segmentAt(state.preview.timeline, t));
  return previewCues().some((cue) => t >= cue.start - 0.15 && t <= cue.end + 0.8);
}

function cameraMoves(fx) {
  return Boolean(fx.zooms.length || fx.shakes.length || fx.faces.length && fx.zooms.length || (fx.jumpZoom > 1 && fx.cutPoints.length));
}

function drawFxLayers(t) {
  if (!state.video || !state.videoSize) {
    el.fxCanvas.hidden = true;
    el.personCanvas.hidden = true;
    el.postCanvas.hidden = true;
    el.video.style.opacity = "";
    return;
  }
  const fx = fxSpec();
  // Вставки и видео поверх рисуются на холсте — так же, как их соберёт сервер.
  const montageVisual = montagePlayer.hasVisualAt(t);
  const transition = montagePlayer.peeking ? null : transitionAt(fx.transitions, t);
  const needBase = Boolean(fx.filter || overlaysActive(fx.overlays) || cameraMoves(fx) || montageVisual || transition);
  const frame = (ctx, w, h) => drawMontageFrame(ctx, w, h, t);
  el.fxCanvas.hidden = !needBase;
  el.video.style.opacity = needBase ? "0" : "";
  if (needBase) timed("fxBase", () => {
    const [W, H] = sizeLayer(el.fxCanvas);
    const ctx = el.fxCanvas.getContext("2d");
    ctx.clearRect(0, 0, W, H);
    drawPreviewBase(ctx, fx, t, W, H, frame, transition);
    drawUnderlays(ctx, fx, t, W, H);
  });
  // Крайние кадры для ближайших переходов — заранее, чтобы растворение и свайп были сразу.
  const upcoming = transitionsNear(fx.transitions, t, state.playing ? 2.2 : 0.8);
  if (upcoming.length) {
    const [W, H] = sizeLayer(el.fxCanvas);
    for (const tr of upcoming) {
      transitionFrames.want(tr.aFrame, W, H);
      transitionFrames.want(tr.bFrame, W, H);
    }
  }
  // Лёгкий режим (телефон): нейросеть «человек» не грузим — текст уйдёт за человека в готовом ролике.
  const wantPerson = fx.behind && captionsVisibleAt(t) && !state.light;
  el.personCanvas.hidden = !wantPerson;
  if (fx.behind && state.light && !lightBehindNoted) {
    lightBehindNoted = true;
    toast("Текст за человеком появится в готовом ролике — на телефоне предпросмотр без него");
  }
  if (wantPerson) {
    // После неудачной загрузки — новая попытка не раньше чем через 20 секунд,
    // а не на каждом кадре.
    if (!previewMasker && !previewMaskerLoading && performance.now() - previewMaskerFailedAt > 20000) {
      previewMaskerLoading = true;
      showHint("Загружаю нейросеть, которая видит человека…");
      loadPreviewMasker().then((masker) => {
        previewMasker = masker;
        showHint("");
        drawFrame();
      }).catch((error) => {
        console.error(error);
        previewMaskerFailedAt = performance.now();
        showHint(`Нейросеть не загрузилась: ${error?.message || error}`);
      }).finally(() => { previewMaskerLoading = false; });
    }
    if (previewMasker) timed("fxPerson", () => {
      const [W, H] = sizeLayer(el.personCanvas);
      const pctx = el.personCanvas.getContext("2d");
      pctx.clearRect(0, 0, W, H);
      let mask;
      if (previewMaskerAsync) {
        // Нейросеть в отдельном потоке: здесь только последняя готовая маска.
        mask = timed("fxPersonMask", () => previewMasker.maskFor((c, w, h) => frame(c, w, h), W / H, t));
      } else {
        // Запасной путь (поток не запустился): нейросеть на странице не чаще
        // ~20 раз в секунду, между ответами — последняя маска.
        const now = performance.now();
        mask = personMaskCache.mask;
        if (!state.playing || !mask || now - personMaskCache.at > 45) {
          mask = timed("fxPersonMask", () => previewMasker.maskFor((c, w, h) => frame(c, w, h), W / H));
          personMaskCache.mask = mask;
          personMaskCache.at = now;
        }
      }
      if (mask) drawPersonLayer(pctx, (c) => frame(c, W, H), fx, t, W, H, mask, previewScratch);
    });
  }
  const wantPost = Boolean(fx.hook || fx.flashes.length || fx.signature || fx.translation || fx.watermark);
  el.postCanvas.hidden = !wantPost;
  if (wantPost) timed("fxPost", () => {
    const [W, H] = sizeLayer(el.postCanvas);
    const ctx = el.postCanvas.getContext("2d");
    ctx.clearRect(0, 0, W, H);
    drawPost(ctx, fx, t, W, H);
  });
  if (fx.translation) measureSecondPlace(fx, t);
}

// Крайние кадры сторон для переходов в предпросмотре (первый кадр B, последний кадр A).
const transitionFrames = new PreviewFrameGrabber({
  urlFor: (media) => (media === "main" ? state.videoUrl : state.montage.media.get(media)?.url || null),
  draw: (ctx, video, W, H, fit) => drawFitted(ctx, video, W, H, fit),
  onReady: () => { if (!state.playing) drawFrameSoon(); },
});
const previewTransitionScratch = {};

/** Основа кадра: видео с камерой или кадр перехода на стыке. */
function drawPreviewBase(ctx, fx, t, W, H, frame, transition) {
  const live = (c) => drawCameraFrame(c, (cc) => frame(cc, W, H), fx, t, W, H);
  if (!transition) {
    live(ctx);
    return;
  }
  const side = transition.live === "A" ? transition.tr.bFrame : transition.tr.aFrame;
  const frozen = transition.tr.blend && side ? transitionFrames.get(side, W, H) : null;
  drawTransition(ctx, transition, {
    drawLive: live,
    drawOther: frozen ? (c) => drawCameraFrame(c, (cc) => cc.drawImage(frozen, 0, 0, W, H), fx, side.m, W, H) : null,
    W, H, scratch: previewTransitionScratch,
  });
}

/** Кадр предпросмотра: исходник или вставка, поверх — видео поверх. */
function drawMontageFrame(ctx, w, h, t) {
  const { base, overlays } = montagePlayer.frame(t);
  if (base.fit !== "stretch") {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);
  }
  drawFitted(ctx, base.element, w, h, base.fit);
  for (const layer of overlays) drawFitted(ctx, layer.element, w, h, layer.fit);
}

// --- Хук и описание, перевод -----------------------------------------------

async function runHook() {
  if (!state.cues.length || state.hook.busy) return;
  state.hook.busy = true;
  el.hookRun.disabled = true;
  el.hookRun.textContent = "ИИ думает…";
  el.hookNote.hidden = true;
  try {
    const text = flatWords(state.cues).map((word) => word.text).join(" ");
    const result = await apiJson("/api/ai/hook", { body: { text } });
    state.hook.data = result;
    state.hook.text = result.hook || "";
    drawHook();
  } catch (error) {
    el.hookNote.hidden = false;
    el.hookNote.textContent = `Не получилось: ${error?.message || error}`;
  } finally {
    state.hook.busy = false;
    el.hookRun.disabled = false;
    el.hookRun.textContent = "Придумать другой вариант";
  }
}

function drawHook() {
  const data = state.hook.data;
  el.hookResult.hidden = !data;
  if (!data) return;
  el.hookText.value = state.hook.text;
  el.hookShow.checked = state.hook.show;
  el.hookDesc.textContent = [data.title, data.description].filter(Boolean).join("\n\n");
  el.hookTags.textContent = (data.hashtags || []).join(" ");
}

function distributeWords(text, start, end) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const weights = words.map((word) => Array.from(word).length + 1);
  const total = weights.reduce((s, v) => s + v, 0) || 1;
  let cursor = start;
  return words.map((word, i) => {
    const span = (end - start) * (weights[i] / total);
    const item = { text: word, start: cursor, end: cursor + span * 0.88, estimated: true };
    cursor += span;
    return item;
  });
}

/** Фразы субтитров, собранные в предложения (до точки, паузы или четырёх фраз). */
function sentenceGroups(cues) {
  const groups = [];
  let current = null;
  cues.forEach((cue, index) => {
    const text = cue.words.map((word) => word.text).join(" ").trim();
    if (!text) return;
    if (!current) current = { cues: [], text: "" };
    current.cues.push(cue);
    current.text = current.text ? `${current.text} ${text}` : text;
    const next = cues[index + 1];
    const sentenceEnd = /[.!?…؟۔]["»)]*$/.test(text);
    const pause = !next || next.start - cue.end > 1;
    if (sentenceEnd || pause || current.cues.length >= 4 || current.text.length > 220) {
      groups.push(current);
      current = null;
    }
  });
  if (current) groups.push(current);
  return groups;
}

/**
 * Переведённое предложение → столько кусков, сколько было фраз. Граница —
 * между словами, по доле длительности фразы; рядом с запятой — по запятой.
 */
function splitTranslation(text, weights) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  // Название латиницей («Reel Lab») и отдельное тире не разрываются между фразами.
  const glue = gluedToPrevious(words);
  const count = weights.length;
  if (count <= 1) return [words.join(" ")];
  const total = weights.reduce((sum, value) => sum + value, 0) || 1;
  const lengths = words.map((word) => Array.from(word).length + 1);
  const chars = lengths.reduce((sum, value) => sum + value, 0) || 1;
  const parts = [];
  let start = 0;
  let share = 0;
  for (let i = 0; i < count; i += 1) {
    if (i === count - 1) {
      parts.push(words.slice(start).join(" "));
      break;
    }
    share += weights[i] / total;
    const last = words.length - (count - 1 - i);
    if (start >= last) {
      parts.push("");
      continue;
    }
    let best = start + 1;
    let bestScore = Infinity;
    let done = lengths.slice(0, start).reduce((sum, value) => sum + value, 0);
    for (let cut = start + 1; cut <= last; cut += 1) {
      done += lengths[cut - 1];
      const score = Math.abs(done / chars - share) - (/[,;:—–،؛]$/.test(words[cut - 1]) ? 0.06 : 0)
        + (glue[cut] ? 0.25 : 0);
      if (score < bestScore) {
        bestScore = score;
        best = cut;
      }
    }
    parts.push(words.slice(start, best).join(" "));
    start = best;
  }
  return parts;
}

/**
 * Водяной знак бесплатного тарифа: показывается в предпросмотре, чтобы было
 * видно, как выйдет ролик. На сервере знак ставится по тарифу в любом случае —
 * убрать его из задания сборки нельзя.
 */
function watermarkSpec(model = montage()) {
  if (!state.account.watermark) return null;
  // Полоса, где стоят субтитры: знак туда не встаёт.
  const alignment = effectiveAlignment();
  const offset = Number(alignment.verticalOffset ?? 0.78);
  const align = isTypewriter() ? "center" : alignment.verticalAlign || "bottom";
  const band = isPictures() ? [0.3, 0.75]
    : align === "bottom" ? [offset - 0.18, offset] : align === "top" ? [offset, offset + 0.18] : [offset - 0.09, offset + 0.09];
  return {
    // Конец ролика — последний оставленный момент: обрезанный хвост не съест карточку.
    text: "Reel Lab", sub: state.account.handle || "", seed: 7, opacity: 0.62, end: model.fromOLeft(model.totalO),
    avoidFrom: Math.round(band[0] * 1000) / 1000, avoidTo: Math.round(band[1] * 1000) / 1000,
  };
}

/** Строка перевода для кадра: фразы во времени сборки и оформление. */
function secondLineSpec(model = montage()) {
  const second = state.translation.second;
  if (!second?.cues?.length) return null;
  const st = state.translation.secondStyle;
  const rtl = second.language === "ar";
  // «Авто»: арабский перевод — арабским шрифтом, остальные — шрифтом стиля (или Montserrat).
  // Под арабским шрифтом (в нём нет кириллицы) русский перевод — Montserrat.
  const styleFont = isArabicFont(settings().font) ? null : fontById(settings().font);
  const font = fontById(st.font) || (rtl ? fontById("cairo") : styleFont) || fontById("montserrat");
  // Время перевода — как у текста: свой текст лежит во времени ролика (O), распознанный — в исходнике (S).
  const toM = lyricsMode()
    ? (cue) => {
      const start = model.fromO(cue.start);
      return [start, Math.max(start + 0.02, model.fromOLeft(cue.end))];
    }
    : (cue) => [model.toM(cue.start), model.toM(cue.end)];
  const cues = second.cues
    .map((cue) => {
      const [start, end] = toM(cue);
      return { start, end, text: cue.text };
    })
    .filter((cue) => cue.end > cue.start + 0.05);
  if (!cues.length) return null;
  // Пока строку не двигали руками, она стоит под блоком субтитров (или над ним, если блок внизу).
  let y = st.y;
  const auto = state.translation.autoY;
  if (!st.placed && auto && auto.key === secondPlaceKey()) y = auto.y;
  else if (!st.placed) {
    const alignment = effectiveAlignment();
    const offset = Number(alignment.verticalOffset ?? 0.78);
    const align = isTypewriter() ? "center" : alignment.verticalAlign || "bottom";
    // Нижний край блока субтитров: у шаблонов отсчёт от низа, у машинки — от середины.
    const bottom = align === "bottom" ? offset : align === "top" ? offset + 0.12 : offset + 0.06;
    y = bottom + 0.11 <= 0.95 ? bottom + 0.055 : Math.max(0.08, bottom - 0.21);
  }
  return {
    cues, rtl,
    x: st.x, y, size: st.size, color: st.color, look: st.look, opacity: st.opacity,
    font: font.family, weight: Math.min(700, font.weight || 600),
  };
}

/** Место перевода меряется заново после каждой пересборки предпросмотра (новый стиль, шрифт загрузился). */
function secondPlaceKey() {
  return `${secondAutoKey()}|${previewRun}`;
}

/** Настройки стиля, от которых зависит место блока субтитров. */
function secondAutoKey() {
  const ps = settings();
  return [state.styleId, ps.position, ps.height, ps.sizeScale, ps.phraseLength, ps.font, ps.x, state.cues.length,
    state.safe.keep, state.safe.platform, state.translation.secondStyle.size].join("|");
}

/**
 * Где на самом деле стоит блок субтитров (доли кадра): у машинки и «Слов с
 * картинками» — по их раскладке на всё время ролика, у остальных стилей — по
 * буквам на экране в текущий момент. null — пока не видно.
 */
function captionExtent(time) {
  const size = state.videoSize;
  if (!size) return null;
  const H = size.height;
  if (isTypewriter() && state.preview.kind === "typewriter" && state.preview.timeline) {
    const timeline = state.preview.timeline;
    let top = Infinity;
    let bottom = -Infinity;
    for (const segment of timeline.segments || []) {
      for (const line of segment.lines || []) {
        if (!Number.isFinite(line.baseline)) continue;
        top = Math.min(top, line.baseline - timeline.px * 0.95);
        bottom = Math.max(bottom, line.baseline + timeline.px * 0.3);
      }
    }
    return Number.isFinite(top) ? { top: top / H, bottom: bottom / H } : null;
  }
  if (composePictures()) {
    let top = Infinity;
    let bottom = -Infinity;
    const model = montage();
    for (const cue of model.cuesToM(state.cues)) {
      for (const item of compositionAt(state.preview.timeline, (cue.start + cue.end) / 2)) {
        if (item.kind !== "line" || !item.rect) continue;
        top = Math.min(top, item.rect.y);
        bottom = Math.max(bottom, item.rect.y + item.rect.h);
      }
    }
    return Number.isFinite(top) ? { top: top / H, bottom: bottom / H } : null;
  }
  const rect = captionBlockRect(time);
  return rect ? { top: rect.y / H, bottom: (rect.y + rect.h) / H } : null;
}

/** Первый раз, когда видны и субтитры, и перевод, строка перевода встаёт под блок (или над ним). */
function measureSecondPlace(fx, time) {
  const st = state.translation.secondStyle;
  const key = secondPlaceKey();
  // Пока предпросмотр пересобирается (новый стиль или шрифт), блок субтитров ещё старый — не мерить.
  if (!fx.translation || st.placed || !state.preview.ready || state.translation.autoY?.key === key) return;
  const extent = captionExtent(time);
  const size = state.videoSize;
  if (!extent || !size) return;
  // Высота перевода — по самой длинной его фразе.
  let half = 0.03;
  for (const cue of fx.translation.cues) {
    const layout = translationLayout(fx.translation, (cue.start + cue.end) / 2, size.width, size.height);
    if (layout) half = Math.max(half, layout.rect.h / size.height / 2);
  }
  const gap = 0.012;
  const below = extent.bottom + gap + half;
  const limit = state.safe.keep ? 1 - safePlatform(state.safe.platform).bottom - 0.005 : 0.975;
  // Перевод — под текстом. У безопасной зоны есть запас: строке можно чуть зайти в него,
  // лишь бы не наехать на сам текст (у арабских шрифтов высокие строки).
  const slack = state.safe.keep ? 0.03 : 0;
  const y = below + half <= limit ? below
    : below + half <= limit + slack ? Math.max(extent.bottom + gap * 0.5 + half, limit + slack - half)
      : Math.max(half + 0.02, extent.top - gap - half);
  state.translation.autoY = { key, y };
  invalidateFx();
  drawFrameSoon();
  composer.refresh();
}

function translateLanguageName() {
  return el.translateLang.selectedOptions[0]?.textContent || "";
}

function drawTranslateControls() {
  const { mode, second, original, busy } = state.translation;
  el.translateMode.querySelectorAll("button").forEach((button) => button.classList.toggle("is-active", button.dataset.tmode === mode));
  if (busy) el.translateRun.textContent = "Перевожу…";
  else if (mode === "replace") el.translateRun.textContent = original ? "Вернуть исходный текст" : "Перевести";
  else el.translateRun.textContent = second ? "Перевести заново" : "Добавить перевод";
  el.translateRun.disabled = busy;
  el.secondLineOptions.hidden = !second;
  if (!second) return;
  const st = state.translation.secondStyle;
  if (!el.secondFont.options.length) el.secondFont.innerHTML = fontOptionsHtml(st.font, "Авто").replace(/<option value="">[^<]*<\/option>/, '<option value="">Авто (под язык)</option>');
  el.secondFont.value = fontById(st.font) ? st.font : "";
  const size = Math.round((Number(st.size) || 1) * 100);
  el.secondSize.value = String(size);
  el.secondSizeValue.textContent = `${size}%`;
  setRangeFill(el.secondSize);
  el.secondLook.querySelectorAll("button").forEach((button) => button.classList.toggle("is-active", button.dataset.look === st.look));
  const color = String(st.color).toLowerCase();
  const custom = !SIGNATURE_COLORS.includes(color);
  el.secondColors.innerHTML = SIGNATURE_COLORS.map((item) => (
    `<button type="button" class="sig-color${item === color ? " is-active" : ""}" data-color="${item}" style="--c:${item}" aria-label="Цвет ${item}" aria-pressed="${item === color}"></button>`
  )).join("") + `<label class="sig-custom${custom ? " is-active" : ""}" title="Свой цвет" style="${custom ? `background:${escapeHtml(st.color)}` : ""}"><input type="color" value="${escapeHtml(/^#[0-9a-f]{6}$/i.test(st.color) ? st.color : "#ffffff")}" aria-label="Свой цвет"></label>`;
}

/** Строка перевода изменилась: запомнить оформление, перерисовать кадр и рамку. */
function onSecondChanged({ controls = true } = {}) {
  saveSecondStyle();
  if (controls) drawTranslateControls();
  invalidateFx();
  hideResult();
  drawFrameSoon();
  composer.refresh();
  const spec = secondLineSpec();
  if (spec && document.fonts) {
    document.fonts.load(`${spec.weight} 48px ${spec.font}`, spec.cues.map((cue) => cue.text).join(" ").slice(0, 2000))
      .then(() => { invalidateFx(); drawFrameSoon(); composer.refresh(); }).catch(() => {});
  }
}

function removeSecondLine() {
  state.translation.second = null;
  el.translateNote.textContent = "Перевод убран.";
  onSecondChanged();
  refreshTimeline();
}

async function runTranslate() {
  if (state.translation.busy) return;
  if (state.translation.mode === "replace") await runReplaceTranslate();
  else await addSecondLine();
}

/** Перевод второй строкой: исходный текст остаётся, перевод — под ним. */
async function addSecondLine() {
  if (!state.cues.length) return;
  const language = el.translateLang.value;
  state.translation.busy = true;
  drawTranslateControls();
  try {
    const groups = sentenceGroups(state.cues);
    const result = await apiJson("/api/ai/translate", { body: { lines: groups.map((group) => group.text), language } });
    const cues = [];
    groups.forEach((group, i) => {
      const line = String(result.lines[i] || "").trim();
      if (!line) return;
      const first = group.cues[0];
      const last = group.cues[group.cues.length - 1];
      // Короткое предложение — целиком на всё время, пока его говорят; длинное — по фразам.
      if (group.cues.length === 1 || Array.from(line).length <= 90) {
        cues.push({ start: first.start, end: last.end, text: line });
        return;
      }
      const parts = splitTranslation(line, group.cues.map((cue) => Math.max(0.2, cue.end - cue.start)));
      group.cues.forEach((cue, k) => { if (parts[k]) cues.push({ start: cue.start, end: cue.end, text: parts[k] }); });
    });
    if (!cues.length) throw new Error("переводчик вернул пустой текст");
    state.translation.second = { language, cues };
    el.translateNote.textContent = `Перевод (${translateLanguageName().toLowerCase()}) добавлен второй строкой. Её можно перетащить на видео.`;
    onSecondChanged();
    refreshTimeline();
  } catch (error) {
    el.translateNote.textContent = `Не получилось: ${error?.message || error}`;
  } finally {
    state.translation.busy = false;
    drawTranslateControls();
  }
}

async function runReplaceTranslate() {
  if (state.translation.original) {
    // Вернуть исходный текст.
    applyTranslatedCues(state.translation.original.map((cue) => ({ ...cue, words: cue.words.map((word) => ({ ...word })) })));
    state.translation.original = null;
    state.translation.language = null;
    el.translateNote.textContent = "Вернул исходный текст.";
    drawTranslateControls();
    return;
  }
  if (!state.cues.length) return;
  state.translation.busy = true;
  drawTranslateControls();
  try {
    const source = state.cues.map((cue) => ({ ...cue, words: cue.words.map((word) => ({ ...word })) }));
    // Переводятся целые предложения, а не обрывки фраз: у арабского, немецкого,
    // турецкого другой порядок слов, и обрывок по отдельности переводится коряво.
    const groups = sentenceGroups(source);
    const result = await apiJson("/api/ai/translate", { body: { lines: groups.map((group) => group.text), language: el.translateLang.value } });
    const translated = [];
    groups.forEach((group, i) => {
      // Переведённое предложение делится обратно по фразам — пропорционально их длительности.
      const parts = splitTranslation(result.lines[i] || group.text, group.cues.map((cue) => Math.max(0.2, cue.end - cue.start)));
      group.cues.forEach((cue, k) => {
        if (parts[k]) translated.push({ ...cue, words: distributeWords(parts[k], cue.start, cue.end), estimated: true });
      });
    });
    if (!translated.length) throw new Error("переводчик вернул пустой текст");
    state.translation.original = source;
    state.translation.language = el.translateLang.value;
    // Текст сменился — перевод второй строкой к нему больше не относится.
    state.translation.second = null;
    applyTranslatedCues(translated);
    el.translateNote.textContent = `Переведено: ${translateLanguageName()}. Время слов распределено по фразам.`;
  } catch (error) {
    el.translateNote.textContent = `Не получилось: ${error?.message || error}`;
  } finally {
    state.translation.busy = false;
    drawTranslateControls();
  }
}

function wireTranslate() {
  el.translateMode.addEventListener("click", (event) => {
    const mode = event.target.closest("button[data-tmode]")?.dataset.tmode;
    if (!mode || state.translation.busy) return;
    state.translation.mode = mode;
    el.translateNote.textContent = mode === "second"
      ? "Перевод появится второй строкой под субтитрами — например, арабский текст и русский перевод."
      : "Текст субтитров заменится переводом. Время слов сохранится, исходный текст можно вернуть одной кнопкой.";
    drawTranslateControls();
  });
  el.secondRemove.addEventListener("click", removeSecondLine);
  el.secondLook.addEventListener("click", (event) => {
    const look = event.target.closest("button[data-look]")?.dataset.look;
    if (!look) return;
    state.translation.secondStyle.look = look;
    onSecondChanged();
  });
  el.secondColors.addEventListener("click", (event) => {
    const color = event.target.closest("button[data-color]")?.dataset.color;
    if (!color) return;
    state.translation.secondStyle.color = color;
    onSecondChanged();
  });
  el.secondColors.addEventListener("input", (event) => {
    if (event.target.type !== "color") return;
    state.translation.secondStyle.color = event.target.value;
    onSecondChanged({ controls: false });
  });
  el.secondColors.addEventListener("change", (event) => {
    if (event.target.type === "color") onSecondChanged();
  });
  el.secondFont.addEventListener("change", () => {
    state.translation.secondStyle.font = el.secondFont.value || "";
    onSecondChanged();
  });
  el.secondSize.addEventListener("input", () => {
    state.translation.secondStyle.size = Number(el.secondSize.value) / 100;
    el.secondSizeValue.textContent = `${el.secondSize.value}%`;
    setRangeFill(el.secondSize);
    onSecondChanged({ controls: false });
  });
}

function applyTranslatedCues(cues) {
  state.cues = cues;
  state.keywords = [];
  resetPictures();
  state.edit.aiCuts = [];
  rebuildCuts();
  hideResult();
  drawEditor();
  drawRibbon();
  drawCutList();
  invalidateFx();
  schedulePreview(0);
  maybeAutoPictures();
}

function wireEditAndFx() {
  el.trimStartBtn.addEventListener("click", () => {
    const t = sourceNow();
    const end = state.edit.trimEnd ?? state.duration;
    pushHistory();
    state.edit.trimStart = Math.min(t, Math.max(0, end - 0.5));
    onEditChanged();
  });
  el.trimEndBtn.addEventListener("click", () => {
    const t = sourceNow();
    pushHistory();
    state.edit.trimEnd = Math.max(t, (state.edit.trimStart || 0) + 0.5);
    onEditChanged();
  });
  el.trimReset.addEventListener("click", () => {
    pushHistory();
    state.edit.trimStart = 0;
    state.edit.trimEnd = null;
    onEditChanged();
  });
  el.smartCutRun.addEventListener("click", () => { void runSmartCut(); });
  el.cutStrengthSeg.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-value]");
    if (!button) return;
    state.edit.strength = button.dataset.value;
    setSeg(el.cutStrengthSeg, "value", state.edit.strength);
    if (state.edit.auto) {
      pushHistory();
      rebuildCuts();
      onEditChanged();
    }
  });
  el.cutList.addEventListener("click", onCutListClick);
  el.cutList.addEventListener("change", (event) => {
    const box = event.target.closest("[data-cut-toggle]");
    if (!box) return;
    const cut = state.edit.cuts.find((item) => item.id === box.dataset.cutToggle);
    pushHistory();
    if (cut) cut.enabled = box.checked;
    onEditChanged();
  });
  el.momentLenSeg.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-value]");
    if (!button) return;
    state.moments.length = button.dataset.value;
    setSeg(el.momentLenSeg, "value", state.moments.length);
  });
  el.momentsRun.addEventListener("click", () => { void runMoments(); });
  el.momentList.addEventListener("click", onMomentsClick);
  el.voiceClean.addEventListener("change", () => { state.edit.voice.clean = el.voiceClean.checked; hideResult(); drawAiReport(); });
  el.voiceLevel.addEventListener("change", () => { state.edit.voice.level = el.voiceLevel.checked; hideResult(); drawAiReport(); });

  el.lookGrid.addEventListener("click", (event) => {
    const card = event.target.closest("[data-look]");
    if (!card) return;
    state.fx.look = card.dataset.look;
    drawLookGrid();
    drawAtmoChips();
    onFxChanged();
  });
  const onAdjustInput = (event) => {
    const input = event.target.closest("[data-adjust]");
    if (!input) return;
    const value = Number(input.value);
    state.fx.adjust[input.dataset.adjust] = value;
    const control = ADJUST_CONTROLS.find(([key]) => key === input.dataset.adjust);
    input.parentElement.querySelector("output").textContent = `${value > 0 && control[2] < 0 ? "+" : ""}${value}`;
    setRangeFill(input);
    drawAtmoChips();
    onFxChanged();
  };
  el.adjustControls.addEventListener("input", onAdjustInput);
  el.atmoControls.addEventListener("input", onAdjustInput);
  el.fxReset.addEventListener("click", () => resetColor());
  el.atmoReset.addEventListener("click", () => resetAtmosphere());
  const onAtmoChip = (event) => {
    const chip = event.target.closest("[data-atmo]");
    if (chip) applyAtmosphere(chip.dataset.atmo);
  };
  el.atmoPresets.addEventListener("click", onAtmoChip);
  el.simpleAtmoChips.addEventListener("click", onAtmoChip);
  el.autoEnhance.addEventListener("click", () => { void autoEnhance(); });
  el.zoomSeg.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-value]");
    if (!button) return;
    state.fx.zoom = button.dataset.value;
    setSeg(el.zoomSeg, "value", state.fx.zoom);
    onFxChanged();
  });
  el.followFace.addEventListener("change", () => {
    state.fx.followFace = el.followFace.checked;
    onFxChanged();
    if (state.fx.followFace) void ensureFaces();
  });
  el.jumpZoom.addEventListener("change", () => { state.fx.jumpZoom = el.jumpZoom.checked; onFxChanged(); });
  el.fxShake.addEventListener("change", () => { state.fx.shake = el.fxShake.checked; onFxChanged(); });
  el.fxFlash.addEventListener("change", () => { state.fx.flash = el.fxFlash.checked; onFxChanged(); });
  el.fxBehind.addEventListener("change", () => { state.fx.behind = el.fxBehind.checked; onFxChanged(); });
  for (const [input, key] of [[el.enhanceStabilize, "stabilize"], [el.enhanceDenoise, "denoise"], [el.enhanceSharpen, "sharpen"]]) {
    input.addEventListener("change", () => { state.edit.enhance[key] = input.checked; hideResult(); });
  }

  el.hookRun.addEventListener("click", () => { void runHook(); });
  el.hookText.addEventListener("input", () => { state.hook.text = el.hookText.value; onFxChanged(); });
  el.hookShow.addEventListener("change", () => {
    state.hook.show = el.hookShow.checked;
    onFxChanged();
    if (state.hook.show) seekO(0);
  });
  document.querySelectorAll("[data-copy]").forEach((button) => button.addEventListener("click", async () => {
    const source = document.getElementById(button.dataset.copy);
    try {
      await navigator.clipboard.writeText(source?.textContent || "");
      button.textContent = "Скопировано ✓";
      window.setTimeout(() => { button.textContent = "Скопировать"; }, 1600);
    } catch (_) {
      button.textContent = "Не удалось скопировать";
    }
  }));
  el.translateRun.addEventListener("click", () => { void runTranslate(); });
  wireTranslate();
}

// ---------------------------------------------------------------------------
// Режимы студии: «Просто» (шаги) и «Профи» (все вкладки)

const MODE_KEY = "reel-lab.mode.v1";

function loadMode() {
  try {
    const value = localStorage.getItem(MODE_KEY);
    if (value === "pro" || value === "simple") return value;
  } catch (_) { /* хранилище недоступно */ }
  return "simple";
}

function applyMode(mode, { save = true } = {}) {
  state.mode = mode === "pro" ? "pro" : "simple";
  if (save) {
    try { localStorage.setItem(MODE_KEY, state.mode); } catch (_) { /* не сохранится — не страшно */ }
  }
  const simple = state.mode === "simple";
  el.inspector.classList.toggle("is-simple", simple);
  el.simplePanel.hidden = !simple;
  document.querySelectorAll(".mode-switch button").forEach((button) => button.classList.toggle("is-active", button.dataset.mode === state.mode));
  if (simple) drawSimple();
  if (server.active) syncBackButton();
}

const MAGIC = [
  { id: "cut", label: "Убрать паузы и «эээ»" },
  { id: "zoom", label: "Автозум на словах" },
  { id: "color", label: "Свет и цвет" },
  { id: "hook", label: "Хук в начале" },
  { id: "voice", label: "Чистый звук" },
  { id: "behind", label: "Текст за человеком" },
];
const magicBusy = new Set();

function magicOn(id) {
  if (id === "cut") return state.edit.cuts.some((cut) => cut.enabled && cut.kind !== "manual");
  if (id === "zoom") return state.fx.zoom !== "off" || state.fx.zoomEdits.on.length > 0;
  if (id === "color") return COLOR_KEYS.some((key) => Math.abs(Number(state.fx.adjust[key]) || 0) > 0.5) || state.fx.look !== "none";
  if (id === "hook") return state.hook.show && Boolean(state.hook.text);
  if (id === "voice") return state.edit.voice.clean || state.edit.voice.level;
  if (id === "behind") return state.fx.behind;
  return false;
}

function drawMagic() {
  el.magicChips.innerHTML = MAGIC.map((item) => {
    const busy = magicBusy.has(item.id);
    const off = !state.cues.length || (lyricsMode() && (item.id === "cut" || item.id === "voice"));
    return `<button type="button" class="magic-chip${magicOn(item.id) ? " is-on" : ""}${busy ? " is-busy" : ""}" data-magic="${item.id}"${off ? " disabled" : ""}>${escapeHtml(item.label)}</button>`;
  }).join("");
  el.magicRun.disabled = !state.cues.length || magicBusy.size > 0;
}

async function setMagic(id, on) {
  if (magicBusy.has(id)) return;
  magicBusy.add(id);
  drawMagic();
  try {
    if (id === "cut") {
      if (on && !state.edit.cuts.some((cut) => cut.kind !== "manual")) await runSmartCut();
      else {
        pushHistory();
        for (const cut of state.edit.cuts) if (cut.kind !== "manual") cut.enabled = on;
      }
      onEditChanged();
    } else if (id === "zoom") {
      pushHistory();
      state.fx.zoom = on ? "soft" : "off";
      state.fx.followFace = on;
      if (!on) state.fx.zoomEdits = { off: [], on: [] };
      syncFxControls();
      onFxChanged();
      if (on) await ensureFaces().catch(() => {});
    } else if (id === "color") {
      if (on) await autoEnhance();
      else resetColor();
    } else if (id === "hook") {
      if (on && !state.hook.data) await runHook();
      state.hook.show = on && Boolean(state.hook.text);
      drawHook();
      onFxChanged();
      if (state.hook.show) seekO(0);
    } else if (id === "voice") {
      state.edit.voice.clean = on;
      state.edit.voice.level = on;
      syncFxControls();
      hideResult();
    } else if (id === "behind") {
      state.fx.behind = on;
      syncFxControls();
      onFxChanged();
    }
  } catch (error) {
    console.error(error);
    showMagicNote(`Не получилось: ${error?.message || error}`);
  } finally {
    magicBusy.delete(id);
    drawMagic();
  }
}

function showMagicNote(text) {
  el.magicNote.hidden = !text;
  el.magicNote.textContent = text || "";
}

/** «Сделать красиво»: паузы, свет и цвет, автозум, чистый звук, хук — по очереди. */
async function runMagic() {
  if (!state.cues.length || magicBusy.size) return;
  showMagicNote("ИИ монтирует ролик…");
  for (const id of lyricsMode() ? ["color", "zoom", "hook"] : ["cut", "color", "zoom", "voice", "hook"]) {
    if (!magicOn(id)) await setMagic(id, true);
  }
  const parts = MAGIC.filter((item) => magicOn(item.id)).map((item) => item.label.toLowerCase());
  showMagicNote(parts.length ? "Готово. Нажми ▶ и посмотри. Ниже — что именно сделал ИИ: любой пункт можно проверить на ленте, поправить или вернуть." : "");
  drawAiReport();
}

// --- Что сделал ИИ: каждый пункт видно, его можно проверить и вернуть ---------------

const CUT_COUNTS = {
  pause: ["паузу", "паузы", "пауз"],
  filler: ["«эээ»", "«эээ»", "«эээ»"],
  repeat: ["повтор", "повтора", "повторов"],
  false_start: ["оговорку", "оговорки", "оговорок"],
  retake: ["неудачный дубль", "неудачных дубля", "неудачных дублей"],
};

function signed(value) {
  const number = Math.round(Number(value) || 0);
  return `${number > 0 ? "+" : ""}${number}`;
}

function aiReportItems() {
  const items = [];
  const aiCuts = state.edit.cuts.filter((cut) => cut.enabled && cut.kind !== "manual");
  if (aiCuts.length) {
    const counts = new Map();
    for (const cut of aiCuts) counts.set(cut.kind, (counts.get(cut.kind) || 0) + 1);
    const parts = [...counts].map(([kind, n]) => (CUT_COUNTS[kind] ? countRu(n, CUT_COUNTS[kind]) : countRu(n, ["кусок", "куска", "кусков"])));
    const seconds = aiCuts.reduce((sum, cut) => sum + Math.max(0, cut.end - cut.start), 0);
    items.push({ id: "cut", title: "Склейки", text: `Убрал ${parts.join(", ")} — ролик короче на ${formatSeconds(seconds)}. Каждую можно вернуть на ленте.`,
      actions: [["review-cut", "Проверить на ленте"], ["undo-cut", "Вернуть всё", true]] });
  }
  const zooms = fxSpec().zooms;
  const auto = zooms.filter((zoom) => !zoom.manual).length;
  const own = zooms.length - auto;
  if (zooms.length || state.fx.zoom !== "off") {
    const removed = state.fx.zoomEdits.off.length;
    const text = [
      auto ? `Зум на ${countRu(auto, ["слове", "словах", "словах"])}` : "",
      own ? `твоих зумов: ${own}` : "",
      removed ? `убрано тобой: ${removed}` : "",
    ].filter(Boolean).join(", ");
    items.push({ id: "zoom", title: "Зум", text: `${text || "Зумов нет"}. Зум можно перетащить на другое слово, усилить или убрать.`,
      actions: [["review-zoom", "Проверить на ленте"], ["undo-zoom", "Убрать все", true]] });
  }
  const adjust = state.fx.adjust;
  const changed = Object.entries({ brightness: "яркость", contrast: "контраст", saturation: "насыщенность", warmth: "тепло" })
    .filter(([key]) => Math.abs(Number(adjust[key]) || 0) > 0.5).map(([key, name]) => `${name} ${signed(adjust[key])}`);
  if (changed.length || state.fx.look !== "none") {
    const look = state.fx.look !== "none" ? `фильтр «${lookById(state.fx.look).label}»` : "";
    items.push({ id: "color", title: "Свет и цвет", text: `${[look, ...changed].filter(Boolean).join(", ")}.`.replace(/^./, (c) => c.toUpperCase()),
      actions: [["tune-color", "Настроить"], ["undo-color", "Сбросить", true]] });
  }
  if (atmosphereOn()) {
    const preset = currentAtmosphere();
    const parts = ATMO_KEYS.filter((key) => (Number(adjust[key]) || 0) > 0.5).map((key) => ATMO_NAMES[key]);
    const text = `${preset && preset.id !== "clean" ? `«${preset.label}»: ` : ""}${parts.join(", ")}.`;
    items.push({ id: "atmo", title: "Атмосфера", text: text.replace(/^./, (c) => c.toUpperCase()),
      actions: [["tune-atmo", "Настроить"], ["undo-atmo", "Убрать", true]] });
  }
  if (state.edit.voice.clean || state.edit.voice.level) {
    const parts = [state.edit.voice.clean ? "убрал шум" : "", state.edit.voice.level ? "выровнял громкость голоса" : ""].filter(Boolean);
    items.push({ id: "voice", title: "Голос", text: `${parts.join(" и ")} — слышно в готовом ролике.`.replace(/^./, (c) => c.toUpperCase()), actions: [["undo-voice", "Выключить", true]] });
  }
  if (state.hook.show && state.hook.text.trim()) {
    items.push({ id: "hook", title: "Хук", text: `В первые секунды: «${state.hook.text.trim()}».`, actions: [["edit-hook", "Изменить"], ["undo-hook", "Убрать", true]] });
  }
  if (isPictures() && state.pictures.plan) {
    const pictures = (state.pictures.plan.items || []).length;
    const accents = (state.pictures.plan.accents || []).length;
    if (pictures || accents) {
      items.push({ id: "pictures", title: "Картинки", text: `${countRu(pictures, ["картинка", "картинки", "картинок"])} к словам, ${countRu(accents, ["слово", "слова", "слов"])} выделено цветом. Картинку можно заменить, подвинуть на видео или убрать.`,
        actions: [["review-pictures", "Список картинок"]] });
    }
  }
  if (state.fx.behind) items.push({ id: "behind", title: "Текст за человеком", text: "Субтитры уходят за человека в кадре.", actions: [["undo-behind", "Выключить", true]] });
  if (state.translation.original) items.push({ id: "translate", title: "Перевод", text: "Текст переведён — время слов распределено по фразам.", actions: [["undo-translate", "Вернуть оригинал", true]] });
  return items;
}

function drawAiReport() {
  const items = aiReportItems();
  const html = items.length ? `<div class="ai-report-head"><span>✦ Что сделал ИИ</span></div>${items.map((item) => `
    <div class="ai-item" data-ai-item="${item.id}">
      <div class="ai-item-title"><b>${escapeHtml(item.title)}</b></div>
      <div class="ai-item-text">${escapeHtml(item.text)}</div>
      <div class="ai-report-actions">${item.actions.map(([act, label, undo]) => `<button type="button" data-ai="${act}"${undo ? ' class="is-undo"' : ""}>${escapeHtml(label)}</button>`).join("")}</div>
    </div>`).join("")}` : "";
  for (const host of [el.aiReport, el.aiReportPro]) {
    if (!host) continue;
    if (host.dataset.html !== html) {
      host.innerHTML = html;
      host.dataset.html = html;
    }
    host.hidden = !items.length;
  }
}

function reviewOnTimeline(selection, seek) {
  setTimelineOpen(true);
  refreshTimeline();
  window.setTimeout(() => {
    if (selection) selectInTimeline(selection);
    if (seek != null) seekO(Math.max(0, seek));
    el.timelinePanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, 60);
}

function onAiReportClick(event) {
  const button = event.target.closest("[data-ai]");
  if (!button) return;
  const act = button.dataset.ai;
  const model = montage();
  if (act === "review-cut") {
    const junction = model.junctions().find((item) => state.edit.cuts.some((cut) => cut.enabled && cut.kind !== "manual" && cut.end > item.s0 + 0.01 && cut.start < item.s1 - 0.01));
    reviewOnTimeline(junction ? { kind: "junction", key: junction.key } : null, junction ? junction.o - 1.2 : null);
  } else if (act === "undo-cut") {
    pushHistory();
    for (const cut of state.edit.cuts) if (cut.kind !== "manual") cut.enabled = false;
    onEditChanged();
  } else if (act === "review-zoom") {
    const zoom = fxSpec().zooms.find((item) => Number.isInteger(item.w));
    reviewOnTimeline(zoom ? { kind: "fx", key: `z:${zoom.w}` } : null, zoom ? model.toO(zoom.start) - 0.8 : null);
  } else if (act === "undo-zoom") {
    pushHistory();
    state.fx.zoom = "off";
    state.fx.followFace = false;
    state.fx.zoomEdits = { off: [], on: [] };
    syncFxControls();
    onFxChanged();
  } else if (act === "tune-color") {
    applyMode("pro");
    openTab("fx");
  } else if (act === "undo-color") {
    resetColor();
  } else if (act === "tune-atmo") {
    applyMode("pro");
    openTab("fx");
    el.atmoBlock?.scrollIntoView({ block: "start", behavior: "smooth" });
  } else if (act === "undo-atmo") {
    resetAtmosphere();
  } else if (act === "undo-voice") {
    state.edit.voice.clean = false;
    state.edit.voice.level = false;
    syncFxControls();
    hideResult();
  } else if (act === "edit-hook") {
    applyMode("pro");
    openTab("fx");
    el.hookText.scrollIntoView({ behavior: "smooth", block: "center" });
    el.hookText.focus();
  } else if (act === "undo-hook") {
    pushHistory();
    state.hook.show = false;
    drawHook();
    onFxChanged();
  } else if (act === "review-pictures") {
    applyMode("pro");
    openTab("tune");
    el.picturesBlock.scrollIntoView({ behavior: "smooth", block: "start" });
  } else if (act === "undo-behind") {
    state.fx.behind = false;
    syncFxControls();
    onFxChanged();
  } else if (act === "undo-translate") {
    void runTranslate();
  }
  drawMagic();
  drawAiReport();
}

function drawSimple() {
  if (state.mode !== "simple") return;
  const hasVideo = Boolean(state.video);
  const hasText = state.cues.length > 0;
  const busy = state.transcription.busy;
  el.stepSource.classList.toggle("is-done", hasVideo && hasText);
  el.stepStyle.classList.toggle("is-done", hasText);
  el.stepStyle.classList.toggle("is-locked", !hasVideo);
  el.stepPreset.classList.toggle("is-done", Boolean(state.preset));
  el.stepPreset.classList.toggle("is-locked", !hasVideo);
  el.stepMagic.classList.toggle("is-locked", !hasText);
  // Собрать можно и без текста: монтаж, музыка и эффекты — просто без субтитров.
  el.stepExport.classList.toggle("is-locked", !hasVideo);
  el.stepExportNote.textContent = hasVideo && !hasText ? "Субтитров нет — соберётся ролик без текста" : "Собери ролик и скачай его";
  el.simpleSourceActions.hidden = busy;
  el.simplePick.textContent = hasVideo ? "Другое видео" : "Выбрать видео";
  el.simpleDemo.hidden = hasVideo && hasText;
  el.simpleProgress.hidden = !busy;
  el.simpleTextReady.hidden = !hasText || busy;
  el.simpleNoText.hidden = !hasVideo || hasText || busy;
  el.simpleNoTextMore.hidden = !hasVideo || hasText || busy;
  const music = state.videoHasAudio === false ? musicForSpeech() : null;
  el.simpleTranscribe.hidden = (state.videoHasAudio === false && !music) || textOnlySpeech();
  el.simpleTranscribe.textContent = music ? "Распознать слова нашида" : "Распознать речь";
  if (hasText) {
    const words = state.cues.reduce((sum, cue) => sum + cue.words.length, 0);
    el.simpleTextCount.textContent = `Текст готов: ${phrasesRu(state.cues.length)}, ${wordsRu(words)}`;
  }
  el.stepSourceNote.textContent = !hasVideo ? "Загрузи ролик — текст распознается сам"
    : busy ? "Распознаю речь прямо на этом компьютере…"
      : hasText ? (state.video?.name || "Видео")
        : state.speechError && !(state.videoHasAudio === false && musicForSpeech() && state.speechError === NO_AUDIO_TEXT)
          ? state.speechError
          : state.videoHasAudio === false && musicForSpeech()
            ? `В видео нет звука, но на ленте есть «${musicForSpeech().clip.name}»: распознаю слова из него — или вставь текст сам.`
            : "Видео загружено. Распознай речь или загрузи свои субтитры — или сразу собирай ролик без текста.";
  el.simpleExport.disabled = el.exportButton.disabled;
  el.simpleExport.textContent = state.rendering ? "Собираю…" : "Собрать видео";
  drawMagic();
}


// ---------------------------------------------------------------------------
// Свой текст: строки нашида или цитаты — ровно по ролику или нажатиями под музыку

/** Где встанет текст: на самый длинный звук с ленты (нашид) или на весь ролик. Время ролика (O). */
function lyricsSpan() {
  const model = montage();
  const total = model.totalO || state.duration || 0;
  const places = audioPlaces(model);
  if (places.length) {
    const longest = places.reduce((best, place) => (place.o1 - place.o0 > best.o1 - best.o0 ? place : best));
    if (longest.o1 - longest.o0 > 1) return { start: longest.o0, end: longest.o1, label: `на звук «${longest.clip.name}»` };
  }
  return { start: 0, end: total, label: "на весь ролик" };
}

function lyricsLanguage(lines) {
  const text = lines.join(" ");
  const rtl = (text.match(/[֐-ࣿ]/g) || []).length;
  const other = (text.match(/\p{L}/gu) || []).length - rtl;
  if (rtl > other) return "ar";
  const chosen = speechLanguage();
  return chosen !== "ru" ? chosen : null;
}

/** Перевод своего текста, введённый под строками (пустая строка — без перевода). */
function translationLinesFromDialog() {
  return String(el.lyricsTranslation.value || "").replace(/\r\n?/g, "\n").split("\n").map((line) => line.replace(/\s+/g, " ").trim());
}

function drawLyricsTranslationCount() {
  const lines = lyricLines(el.lyricsText.value).length;
  const translated = translationLinesFromDialog().filter(Boolean).length;
  el.lyricsTranslationCount.textContent = translated
    ? `Строк текста: ${lines}, перевода: ${translated}${translated !== lines ? " — проверь, что строки совпадают" : " ✓"}`
    : "";
}

/** Перевод под строками своего текста: время — как у строк. */
function applyLyricTranslation(cues, lines) {
  const raw = translationLinesFromDialog();
  // Пустые строки в начале и конце не считаем; внутри — пропуск перевода для строки.
  while (raw.length && !raw[raw.length - 1]) raw.pop();
  state.translation.lyricLines = raw.length ? raw : null;
  if (!raw.length) return;
  const second = cues.map((cue, index) => (raw[index] ? { start: cue.start, end: cue.end, text: raw[index] } : null)).filter(Boolean);
  if (!second.length) return;
  const text = raw.join(" ");
  const arabic = (text.match(/[\u0590-\u08ff]/g) || []).length;
  const latin = (text.match(/[a-z]/gi) || []).length;
  const cyrillic = (text.match(/[\u0400-\u04ff]/g) || []).length;
  const language = arabic > latin + cyrillic ? "ar" : cyrillic >= latin ? "ru" : "en";
  state.translation.second = { language, cues: second, manual: true };
  void lines;
  onSecondChanged();
}

function openLyrics() {
  if (!state.video) return;
  pausePreview();
  el.lyricsText.value = state.cues.length ? cuesToLyrics(state.cues) : "";
  const manual = state.translation.second?.manual ? state.translation.lyricLines || [] : [];
  el.lyricsTranslation.value = manual.join("\n");
  el.lyricsTranslateBox.open = manual.length > 0;
  drawLyricsTranslationCount();
  const span = lyricsSpan();
  el.lyricsSpan.textContent = `Текст встанет ${span.label}: ${formatClock(span.start)}–${formatClock(span.end)}.`;
  el.lyricsDialog.showModal();
  window.setTimeout(() => el.lyricsText.focus(), 30);
}

function dialogLines() {
  const lines = lyricLines(el.lyricsText.value);
  if (!lines.length) {
    el.lyricsSpan.textContent = "Вставь хотя бы одну строку текста.";
    el.lyricsText.focus();
    return null;
  }
  return lines;
}

/** Звук, под который поют строки: музыка на ленте, музыка фона или звук самого видео. */
function lyricsAudio() {
  const model = montage();
  const span = lyricsSpan();
  const places = audioPlaces(model);
  const place = places.find((item) => item.o0 <= span.start + 0.05 && item.o1 >= span.end - 0.05)
    || (places.length ? places.reduce((best, item) => (item.o1 - item.o0 > best.o1 - best.o0 ? item : best)) : null);
  if (place) return { url: place.clip.url, toAudio: (o) => place.clip.in + (o - place.o0) };
  const entry = musicEntry();
  if (entry?.files?.[0] && state.music.volume > 0) {
    const start = Number(state.music.start) || 0;
    const trackStart = Number(state.music.trackStart) || 0;
    return { url: entry.files[0], toAudio: (o) => trackStart + (o - start) };
  }
  const size = Number(state.video?.size) || 0;
  if (state.videoHasAudio !== false && state.videoUrl && state.duration <= 600 && size < (state.video?.remote ? 60e6 : 150e6)) {
    return { url: state.videoUrl, toAudio: (o) => model.sourceAt(model.fromO(o)) ?? o };
  }
  return null;
}

/** Слова строк — по голосу: подсветка (караоке) идёт вместе с пением, а не ровно по длине слов. */
async function refineLyricsByVoice(cues) {
  const source = lyricsAudio();
  if (!source) return;
  let analysis = null;
  try {
    analysis = await beatsForUrl(source.url);
  } catch (error) {
    console.warn("[reel-lab] звук для слов не разобрался", error);
    return;
  }
  if (state.cues !== cues || !analysis?.vocal) return;
  let changed = 0;
  const refined = cues.map((cue) => {
    const next = alignWordsToVocal(cue, analysis.vocal, source.toAudio);
    if (next !== cue) changed += 1;
    return next;
  });
  if (!changed || state.cues !== cues) return;
  state.cues = refined;
  hideResult();
  drawEditor();
  drawRibbon();
  refreshTimeline();
  schedulePreview(0);
  toastIfQuiet("Слова подогнаны по голосу — подсветка идёт вместе с пением ✅");
}

function applyLyrics(cues, lines, label) {
  useCues(cues, { base: "O", language: lyricsLanguage(lines), label });
  applyLyricTranslation(cues, lines);
  void refineLyricsByVoice(cues);
  if (el.transcription) el.transcription.hidden = true;
  state.speechError = "";
  drawSimple();
}

function spreadFromDialog() {
  const lines = dialogLines();
  if (!lines) return;
  const span = lyricsSpan();
  el.lyricsDialog.close();
  applyLyrics(spreadLyrics(lines, span.start, span.end), lines,
    "Текст расставлен ровно. Чтобы попасть точно в музыку — «свой текст» → «Подогнать под музыку».");
  showHint("");
  toast("Текст на видео ✅ Нажми ▶ и посмотри");
}

const lyricTap = { active: false, lines: [], starts: [], span: null, timer: 0 };

function startLyricsTap() {
  const lines = dialogLines();
  if (!lines) return;
  el.lyricsDialog.close();
  const span = lyricsSpan();
  Object.assign(lyricTap, { active: true, lines, starts: [], span });
  el.lyricsTap.hidden = false;
  drawLyricsTap();
  seekO(Math.max(0, span.start - 0.6));
  if (!state.playing) void togglePlay();
  window.clearInterval(lyricTap.timer);
  // Ролик доиграл до конца — заканчиваем сами: последняя строка идёт до конца звука.
  lyricTap.timer = window.setInterval(() => {
    if (!lyricTap.active) return;
    const model = montage();
    const o = model.toO(montagePlayer.time);
    if (!state.playing && lyricTap.starts.length && o >= Math.min(lyricTap.span.end, model.totalO) - 0.15) finishLyricsTap(lyricTap.span.end);
  }, 250);
}

function drawLyricsTap() {
  const index = lyricTap.starts.length;
  const total = lyricTap.lines.length;
  if (index < total) {
    el.lyricsTapLine.textContent = lyricTap.lines[index];
    el.lyricsTapCount.textContent = `Строка ${index + 1} из ${total}: нажми, когда она зазвучит (можно пробелом)`;
    el.lyricsTapNext.textContent = index === 0 ? "Первая строка началась ▶" : "Эта строка началась ▶";
  } else {
    el.lyricsTapLine.textContent = "Все строки отмечены";
    el.lyricsTapCount.textContent = "Нажми, когда закончится последняя строка";
    el.lyricsTapNext.textContent = "Текст закончился ■";
  }
}

function tapLyric() {
  if (!lyricTap.active) return;
  const o = montage().toO(montagePlayer.time);
  if (lyricTap.starts.length < lyricTap.lines.length) {
    const last = lyricTap.starts[lyricTap.starts.length - 1];
    if (Number.isFinite(last) && o < last + 0.15) return; // двойное нажатие
    lyricTap.starts.push(o);
    drawLyricsTap();
  } else finishLyricsTap(o);
}

function finishLyricsTap(end) {
  if (!lyricTap.active) return;
  const { lines, starts, span } = lyricTap;
  const last = starts[starts.length - 1];
  const finish = Number.isFinite(end) && (!Number.isFinite(last) || end > last + 0.3) ? end : span.end;
  stopLyricsTap();
  const cues = starts.length ? lyricsFromTaps(lines, starts, finish) : spreadLyrics(lines, span.start, span.end);
  applyLyrics(cues, lines, "Текст подогнан под музыку. Поправить слова — «поправить текст», время — ещё раз «свой текст».");
  toast("Текст подогнан под музыку ✅");
}

function stopLyricsTap() {
  lyricTap.active = false;
  window.clearInterval(lyricTap.timer);
  el.lyricsTap.hidden = true;
  pausePreview();
}

function wireLyrics() {
  el.lyricsButton.addEventListener("click", openLyrics);
  el.lyricsClose.addEventListener("click", () => el.lyricsDialog.close());
  el.lyricsSpread.addEventListener("click", spreadFromDialog);
  el.lyricsTranslation.addEventListener("input", drawLyricsTranslationCount);
  el.lyricsText.addEventListener("input", drawLyricsTranslationCount);
  el.lyricsTapStart.addEventListener("click", startLyricsTap);
  el.lyricsTapNext.addEventListener("click", tapLyric);
  el.lyricsTapDone.addEventListener("click", () => finishLyricsTap(montage().toO(montagePlayer.time)));
  el.lyricsTapCancel.addEventListener("click", stopLyricsTap);
  // Пробел во время подгонки — «строка началась», а не пауза.
  document.addEventListener("keydown", (event) => {
    if (!lyricTap.active || event.code !== "Space" || event.target.closest?.("textarea, input")) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    tapLyric();
  }, true);
}

// ---------------------------------------------------------------------------
// Переходы: общий выбор (вкладка «Монтаж», лента) и свой переход для стыка

/** Ключ стыка, выделенного на ленте: стык двух видео или склейка. */
function selectedTransitionKey(selection = state.montage.selection) {
  if (selection?.kind === "transition") return selection.key;
  if (selection?.kind === "junction") {
    const junction = selectedJunction(selection);
    return junction ? `cut:${Math.round(junction.s1 * 1000) / 1000}` : null;
  }
  return null;
}

function clipJunctionCount(model = montage()) {
  return junctionsOf(model).filter((junction) => junction.kind === "clip").length;
}

function transitionCardHtml(item) {
  return `<button type="button" class="tcard" data-transition="${item.id}" role="radio" aria-checked="false" title="${escapeHtml(item.hint)}">
    <span class="tprev" data-t="${item.id}" aria-hidden="true"><span class="tp-a"></span><span class="tp-b"></span><span class="tp-fx"></span></span>
    <span class="tname">${escapeHtml(item.label)}</span></button>`;
}

// --- Окошко «Переход» у стыка на ленте ------------------------------------------

let pickerKey = null;
// Касание кружка открывает окошко, а следом браузер шлёт «click» в ту же точку — он попадал
// в только что открытую карточку и сразу выбирал переход. Такие клики сразу после открытия не считаем.
let pickerOpenedAt = 0;

function transitionPicker() {
  let pop = document.querySelector("#trPicker");
  if (pop) return pop;
  pop = document.createElement("div");
  pop.id = "trPicker";
  pop.className = "tr-picker";
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "Переход на стыке");
  pop.hidden = true;
  document.body.append(pop);
  pop.addEventListener("click", (event) => {
    if (performance.now() - pickerOpenedAt < 450) return;
    const card = event.target.closest("[data-transition]");
    const action = event.target.closest("[data-trp]")?.dataset.trp;
    const key = pickerKey;
    if (card && key) {
      const id = card.dataset.transition;
      closeTransitionPicker();
      setTransition(id, { key });
      const name = id === "default" ? "как у всех" : `«${transitionById(id).label}»`;
      setTimelineNote(id === "none" ? "Перехода нет — обычная склейка. Нажми на кружок, чтобы поставить."
        : `Переход ${name} на этом стыке. Поменять — снова нажми на кружок.`);
    } else if (action === "all" && key) {
      const id = state.transitions.custom[key]?.type || (key.startsWith("cut:") ? state.transitions.cut : state.transitions.clip);
      closeTransitionPicker();
      applyTransitionEverywhere(id === "none" ? "dissolve" : id, key);
    } else if (action === "close") {
      closeTransitionPicker();
    }
  });
  document.addEventListener("pointerdown", (event) => {
    if (!pop.hidden && !pop.contains(event.target) && !event.target.closest?.(".timeline-canvas")) closeTransitionPicker();
  }, true);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !pop.hidden) closeTransitionPicker();
  });
  return pop;
}

function closeTransitionPicker() {
  const pop = document.querySelector("#trPicker");
  const wasOpen = pop && !pop.hidden;
  if (pop) pop.hidden = true;
  pickerKey = null;
  // Окошко закрыто — кружок не «залипает» выделенным: следующее нажатие снова откроет выбор.
  if (wasOpen && state.montage.selection?.kind === "transition") {
    state.montage.selection = null;
    timeline.setSelection(null);
    updateTimelineToolbar();
  }
}

/** Окошко с переходами у кружка на ленте: выбрал — переход встал на этот стык и проигрался. */
function openTransitionPicker(key) {
  const item = timeline.doc?.transitions?.find((entry) => entry.key === key);
  if (!item) return;
  const pop = transitionPicker();
  pickerKey = key;
  const t = state.transitions;
  const isCut = key.startsWith("cut:");
  // Что стоит сейчас — как на ленте (на простом разрезе по умолчанию перехода нет).
  const current = t.custom[key]?.type || item.type || (isCut ? t.cut : t.clip);
  const title = item.kind === "split" ? "Переход на разрезе" : isCut ? "Переход на склейке" : "Переход между видео";
  const cards = TRANSITIONS.map((entry) => transitionCardHtml(entry).replace('class="tcard"', `class="tcard${entry.id === current ? " is-active" : ""}"`)).join("");
  pop.innerHTML = `
    <div class="trp-head">
      <b>${title}</b>
      <button type="button" class="icon-btn trp-close" data-trp="close" aria-label="Закрыть">×</button>
    </div>
    <div class="trp-grid">${cards}</div>
    <div class="trp-foot">
      <button type="button" class="link-btn" data-trp="all">Такой же на все стыки</button>
      <span class="trp-note">Выбрал — сразу проиграется</span>
    </div>`;
  pop.hidden = false;
  pickerOpenedAt = performance.now();
  // Место: над лентой у кружка; на телефоне — снизу во всю ширину.
  const host = el.tlHost.getBoundingClientRect();
  const narrow = window.innerWidth <= 640;
  pop.classList.toggle("is-sheet", narrow);
  if (narrow) {
    pop.style.left = pop.style.top = "";
    return;
  }
  const width = pop.offsetWidth;
  const height = pop.offsetHeight;
  const x = host.left + timeline.x(item.o);
  const left = Math.max(8, Math.min(window.innerWidth - width - 8, x - width / 2));
  const top = Math.max(8, host.top - height - 8 > 8 ? host.top - height - 8 : host.bottom + 8);
  pop.style.left = `${Math.round(left)}px`;
  pop.style.top = `${Math.round(Math.min(top, window.innerHeight - height - 8))}px`;
}

/** «Такой же на все стыки»: и между видео, и на склейках; свои переходы отдельных стыков — тоже он. */
function applyTransitionEverywhere(id) {
  const t = state.transitions;
  t.clip = id;
  t.cut = id;
  t.custom = {};
  saveTransitions();
  onTransitionsChanged();
  previewTransition(null);
  setTimelineNote(`«${transitionById(id).label}» — на всех стыках ролика. Отдельный стык — нажми на его кружок.`);
}

/** Вкладка «Монтаж» → «Переходы». */
function drawTransitionPanel() {
  if (!el.transitionGrid) return;
  const t = state.transitions;
  if (!el.transitionGrid.childElementCount) el.transitionGrid.innerHTML = TRANSITIONS.map(transitionCardHtml).join("");
  el.transitionGrid.querySelectorAll(".tcard").forEach((card) => {
    const on = card.dataset.transition === t.clip;
    card.classList.toggle("is-active", on);
    card.setAttribute("aria-checked", String(on));
  });
  setSeg(el.transitionSpeedSeg, "value", t.speed);
  el.transitionCuts.checked = t.cut !== "none";
  el.transitionEdges.checked = Boolean(t.edges);
  const count = state.video ? clipJunctionCount() : 0;
  // Все стыки с кружком на ленте: между видео и склейки внутри видео.
  const all = state.video ? junctionsOf(montage()).length : 0;
  const custom = Object.keys(t.custom || {}).length;
  el.transitionsInfo.textContent = all ? `${countRu(all, ["стык", "стыка", "стыков"])}${custom ? ` · своих ${custom}` : ""}` : "";
  el.transitionsNote.textContent = all
    ? "Переход на отдельный стык — на ленте: нажми на кружок между кусками и выбери. Карточки здесь — сразу для всех стыков между видео."
    : "Переход ставится между кусками: открой ленту, разрежь видео или вставь второе — между кусками появится кружок «+». Нажми на него и выбери переход.";
  drawSimpleTransitions(count);
}

function chipsHtml(active, extra = "") {
  return extra + TRANSITIONS.map((item) => {
    const on = active === item.id;
    return `<button type="button" class="tl-tr-chip${on ? " is-active" : ""}" data-transition="${item.id}" role="radio" aria-checked="${on}" title="${escapeHtml(item.hint)}">${escapeHtml(item.label)}</button>`;
  }).join("");
}

function setChips(container, html) {
  if (container.dataset.html === html) return;
  container.innerHTML = html;
  container.dataset.html = html;
  // Выбранный переход — на виду, даже если строка прокручивается вбок.
  const active = container.querySelector(".is-active");
  if (active && container.scrollWidth > container.clientWidth) {
    container.scrollLeft = Math.max(0, active.offsetLeft - container.offsetLeft - container.clientWidth / 2 + active.offsetWidth / 2);
  }
}

/** Простой режим: строка переходов в шаге «ИИ-монтаж», когда в ролике есть второе видео. */
function drawSimpleTransitions(count = clipJunctionCount()) {
  if (!el.simpleTransitions) return;
  el.simpleTransitions.hidden = !state.video || !count;
  if (!el.simpleTransitions.hidden) setChips(el.simpleTransitionChips, chipsHtml(state.transitions.clip));
}

/** Лента: строка переходов (общий выбор или стык, выделенный на ленте). */
function drawTransitionChips() {
  if (!el.tlTransitions) return;
  const key = selectedTransitionKey();
  const count = clipJunctionCount();
  drawSimpleTransitions(count);
  el.tlTransitions.hidden = !key && !count;
  if (el.tlTransitions.hidden) return;
  const t = state.transitions;
  const isCut = Boolean(key?.startsWith("cut:"));
  const isSplit = Boolean(key) && timeline.doc?.transitions?.find((entry) => entry.key === key)?.kind === "split";
  const active = key ? (t.custom[key]?.type || (isSplit ? "none" : "default")) : t.clip;
  el.tlTransitionsLabel.textContent = key ? (isSplit ? "Переход на разрезе:" : isCut ? "Переход на склейке:" : "Переход на этом стыке:") : "Переход между видео:";
  // «Как у всех» на простом разрезе — без перехода (общий выбор разрезы не трогает).
  const baseLabel = isSplit ? "Без перехода" : transitionById(isCut ? t.cut : t.clip).label;
  let extra = "";
  if (key && !isSplit) {
    const base = baseLabel;
    extra = `<button type="button" class="tl-tr-chip${active === "default" ? " is-active" : ""}" data-transition="default" role="radio" aria-checked="${active === "default"}">Как у всех · ${escapeHtml(base)}</button>`;
  }
  setChips(el.tlTransitionChips, chipsHtml(active, extra));
  const options = TRANSITIONS.map((item) => [item.id, item.label]);
  if (key && !isSplit) options.unshift(["default", `Как у всех · ${baseLabel}`]);
  setSelect(el.tlTransitionSelect, options, active);
}

function onTransitionsChanged() {
  invalidateFx();
  hideResult();
  drawTransitionPanel();
  drawTransitionChips();
  refreshTimeline();
  drawFrameSoon();
}

/** Проиграть переход: с секунды до стыка до секунды после — сразу видно, как он выглядит. */
function previewTransition(key = null) {
  if (!state.video || !state.duration) return;
  const model = montage();
  const plan = planTransitions(model, state.transitions);
  const now = model.toO(montagePlayer.time);
  const candidates = plan.filter((item) => item.kind === "clip" || item.kind === "cut" || item.kind === "split");
  const tr = key ? plan.find((item) => item.key === key)
    : candidates.filter((item) => item.kind === "clip").sort((a, b) => Math.abs(a.o - now) - Math.abs(b.o - now))[0] || candidates[0];
  if (!tr) return;
  pausePreview();
  seekO(Math.max(0, tr.o - tr.h - 0.7));
  stopPreviewAt = model.fromOLeft(Math.min(model.totalO, tr.o + tr.h + 0.7));
  void togglePlay();
}

/** Выбрать переход: для стыка, выделенного на ленте (key), или общий для всех стыков между видео. */
function setTransition(id, { key = selectedTransitionKey(), preview = true } = {}) {
  const t = state.transitions;
  if (key) {
    if (id === "default") delete t.custom[key];
    else t.custom[key] = { type: id };
  } else {
    t.clip = id;
    if (t.cut !== "none") t.cut = id === "none" ? "dissolve" : id;
    saveTransitions();
  }
  onTransitionsChanged();
  if (preview && id !== "none") previewTransition(key);
}

function wireTransitions() {
  el.transitionGrid.addEventListener("click", (event) => {
    const card = event.target.closest("[data-transition]");
    if (card) setTransition(card.dataset.transition, { key: null });
  });
  el.tlTransitionChips.addEventListener("click", (event) => {
    const chip = event.target.closest("[data-transition]");
    if (chip) setTransition(chip.dataset.transition);
  });
  el.tlSpeedChips.addEventListener("click", (event) => {
    const chip = event.target.closest("[data-speed]");
    if (chip) setClipSpeed(Number(chip.dataset.speed));
  });
  el.tlTransitionSelect.addEventListener("change", () => setTransition(el.tlTransitionSelect.value));
  el.tlSpeedSelect.addEventListener("change", () => setClipSpeed(Number(el.tlSpeedSelect.value)));
  el.simpleTransitionChips.addEventListener("click", (event) => {
    const chip = event.target.closest("[data-transition]");
    if (chip) setTransition(chip.dataset.transition, { key: null });
  });
  el.transitionSpeedSeg.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-value]");
    if (!button || !TRANSITION_SPEEDS[button.dataset.value]) return;
    state.transitions.speed = button.dataset.value;
    saveTransitions();
    onTransitionsChanged();
    previewTransition(null);
  });
  el.transitionCuts.addEventListener("change", () => {
    const clip = state.transitions.clip;
    state.transitions.cut = el.transitionCuts.checked ? (clip === "none" ? "dissolve" : clip) : "none";
    saveTransitions();
    onTransitionsChanged();
  });
  el.transitionEdges.addEventListener("change", () => {
    state.transitions.edges = el.transitionEdges.checked;
    saveTransitions();
    onTransitionsChanged();
    if (state.transitions.edges && state.video) {
      pausePreview();
      seekO(0);
      stopPreviewAt = montage().fromOLeft(1.5);
      void togglePlay();
    }
  });
}

// ---------------------------------------------------------------------------
// Защита работы: новое видео сбрасывает монтаж и текст — сначала спрашиваем

function hasWork() {
  const edit = state.edit;
  return Boolean(state.cues.length || state.montage.inserts.length || state.montage.overlays.length
    || state.montage.audios.length || state.montage.splits.length || edit.cuts.length
    || edit.trimStart > 0.05 || (edit.trimEnd != null && edit.trimEnd < (state.duration || 0) - 0.05)
    || state.translation.second);
}

function askConfirm(text) {
  const webApp = window.Telegram?.WebApp;
  if (server.active && webApp?.showConfirm) return new Promise((resolve) => webApp.showConfirm(text, (ok) => resolve(Boolean(ok))));
  return Promise.resolve(window.confirm(text));
}

async function confirmDiscard() {
  if (!state.video || !hasWork()) return true;
  // Монтаж сохраняется сам — перед заменой видео дожидаемся, что последняя правка тоже на сервере.
  const saved = await flushProject();
  return askConfirm(saved
    ? "Открыть другое видео? Этот монтаж сохранён — вернуться к нему: «Черновик» вверху. Добавить видео в этот монтаж: «Монтаж» → «Видео между»."
    : "Заменить видео? Монтаж, звуки и текст этого ролика сбросятся. Чтобы добавить другое видео в монтаж, нажми «Монтаж» → «Видео между».");
}

// ---------------------------------------------------------------------------
// Проект: автосохранение и «Продолжить монтаж»
//
// Пока в студии есть работа, она каждые пару секунд уходит на сервер (и копией —
// в браузер, на случай если связи нет). Закрыл студию, упал браузер, свернулся
// Telegram — при следующем открытии на пустом экране будет «Продолжить монтаж».
// Видео и вставки лежат в Reel Lab (uploads); проект — это всё остальное.

const AUTOSAVE_MS = 2500;
const project = {
  id: null, savedJson: "", saving: null, restoring: false, demo: false, failures: 0, retryAt: 0,
  list: [], keepHours: 0, pendingPick: null, pendingAt: 0, switching: false, toldSaved: false,
};
let manifestReady = Promise.resolve();

/**
 * Можно ли сейчас сменить видео или перестроить монтаж. Нельзя, пока открывается проект
 * и пока ролик собирается прямо в браузере (сборка читает это видео). На сервере сборка
 * от телефона не зависит — там можно сразу браться за следующее видео.
 */
function busyForChange() {
  if (project.restoring) {
    toast("Открываю проект — секунду…");
    return true;
  }
  if (state.rendering && !server.active) {
    toast("Сначала дождись, пока соберётся ролик.");
    return true;
  }
  return false;
}

function startNewProject() {
  project.id = newProjectId();
  project.savedJson = "";
  project.demo = false;
  project.failures = 0;
  project.retryAt = 0;
}

function projectOwner() {
  return server.active ? `tg:${server.me?.user?.id || ""}` : "local";
}

/** Есть ли что сохранять: хоть что-то сделано, кроме выбора видео. */
function worthSaving() {
  return hasWork() || Boolean(state.preset) || state.styleId !== TYPEWRITER_ID || state.fx.look !== "none"
    || Boolean(state.music.sound) || state.edit.voice.clean || state.edit.voice.level;
}

function canAutosave() {
  return Boolean(state.video && state.duration > 0 && project.id && !project.restoring && !project.demo);
}

function projectName() {
  return String(state.video?.name || "Проект").replace(/\.[^.]+$/, "") || "Проект";
}

/** Что в проекте — для списка «Мои проекты». */
function summaryOf(data) {
  const cues = arrayOr(data?.text?.cues);
  return {
    cues: cues.length,
    words: cues.reduce((sum, cue) => sum + arrayOr(cue?.words).length, 0),
    inserts: arrayOr(data?.montage?.inserts).length,
    overlays: arrayOr(data?.montage?.overlays).length,
    audios: arrayOr(data?.montage?.audios).length,
    lyrics: data?.text?.base === "O",
  };
}

function projectSummary() {
  return summaryOf({ text: { cues: state.cues, base: state.cuesBase }, montage: state.montage });
}

/** Всё, что человек сделал с роликом (кроме места бегунка), — в JSON. */
function projectData() {
  const video = state.video;
  const pictures = state.pictures;
  const edit = state.edit;
  const fx = state.fx;
  return {
    v: 1,
    video: {
      uploadId: state.uploadId || null, name: video?.name || "video.mp4", size: video?.size || 0, type: video?.type || "",
      lastModified: video?.lastModified || 0, duration: state.duration || 0,
      width: state.videoSize?.width || 0, height: state.videoSize?.height || 0, hasAudio: state.videoHasAudio,
    },
    text: { cues: state.cues, base: state.cuesBase, test: state.subtitlesAreTest, keywords: state.keywords, speechLanguage: state.speechLanguage, lang: speechLanguage() },
    translation: { original: state.translation.original, language: state.translation.language, mode: state.translation.mode, second: state.translation.second,
      lyricLines: state.translation.lyricLines || null },
    style: { id: state.styleId, perStyle: state.perStyle, builders: state.builders, builderPreset: state.builderPreset, typewriter: state.typewriter, preset: state.preset },
    sound: { voice: state.voice, music: state.music },
    pictures: { density: pictures.density, look: pictures.look, blend: pictures.blend, size: pictures.size, opacity: pictures.opacity, stack: pictures.stack, plan: pictures.plan, layout: pictures.layout },
    edit: { trimStart: edit.trimStart, trimEnd: edit.trimEnd, cuts: edit.cuts, aiCuts: edit.aiCuts, manual: edit.manual, auto: edit.auto, strength: edit.strength, voice: edit.voice, enhance: edit.enhance },
    montage: {
      inserts: state.montage.inserts, overlays: state.montage.overlays, splits: state.montage.splits, audios: state.montage.audios,
      seq: state.montage.seq, open: state.montage.open,
      media: [...state.montage.media.values()].map((media) => ({
        key: media.key, name: media.name, uploadId: media.uploadId || null, duration: media.duration, width: media.width, height: media.height,
        hasAudio: media.hasAudio !== false, type: media.file?.type || media.type || "",
      })),
    },
    fx: { look: fx.look, adjust: fx.adjust, zoom: fx.zoom, zoomEdits: fx.zoomEdits, followFace: fx.followFace, faces: fx.faces, facesFor: fx.facesFor, jumpZoom: fx.jumpZoom, shake: fx.shake, flash: fx.flash, behind: fx.behind },
    hook: { data: state.hook.data, text: state.hook.text, show: state.hook.show },
    moments: { list: state.moments.list, length: state.moments.length },
    transitions: state.transitions,
  };
}

/** Тело запроса: данные проекта плюс место бегунка (оно не повод сохранять заново). */
function projectBody(json) {
  const time = Math.round((montagePlayer.time || 0) * 100) / 100;
  return `{"name":${JSON.stringify(projectName())},"summary":${JSON.stringify(projectSummary())},"data":${json.slice(0, -1)},"time":${time}}}`;
}

async function putProject(id, body, { keepalive = false } = {}) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const csrf = attempt === 0 && (state.csrf || server.csrf) ? (state.csrf || server.csrf) : await csrfToken(true);
    const response = await fetch(`/api/projects/${encodeURIComponent(id)}`, {
      method: "PUT", credentials: "same-origin", keepalive: keepalive && body.length < 60000,
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf }, body,
    });
    if (response.ok) return true;
    const payload = await response.json().catch(() => ({}));
    if (payload?.code === "csrf_stale" && attempt === 0) continue;
    const error = new Error(payload?.error || `код ${response.status}`);
    error.code = payload?.code || "";
    throw error;
  }
  return false;
}

/** Сохранить проект сейчас. true — на сервере последняя версия. */
async function saveProjectNow({ keepalive = false } = {}) {
  if (project.saving) await project.saving.catch(() => {});
  if (!canAutosave()) return false;
  const json = JSON.stringify(projectData());
  if (json === project.savedJson) return true;
  if (!project.savedJson && !worthSaving()) return false;
  const id = project.id;
  saveLocalCopy(id, projectName(), json, projectOwner());
  const run = putProject(id, projectBody(json), { keepalive });
  project.saving = run;
  try {
    await run;
    if (project.id === id) {
      project.savedJson = json;
      project.failures = 0;
      project.retryAt = 0;
      drawSaveState();
    }
    dropLocalCopy(id);
    if (!project.toldSaved) project.toldSaved = toastIfQuiet("Монтаж сохраняется сам — можно закрыть студию и вернуться ✅");
    return true;
  } catch (error) {
    project.failures += 1;
    project.retryAt = Date.now() + Math.min(60000, 4000 * project.failures);
    console.warn("[reel-lab] проект не сохранился", error);
    drawSaveState(error?.message || String(error));
    if (project.failures === 3) toast("Нет связи с Reel Lab — монтаж сохраню, как только связь появится (копия есть на этом устройстве).", 6000);
    return false;
  } finally {
    if (project.saving === run) project.saving = null;
  }
}

/** Дождаться, пока последняя правка дойдёт до сервера. */
async function flushProject() {
  if (!canAutosave()) return false;
  if (await saveProjectNow()) return true;
  return false;
}

function autosaveTick() {
  if (!canAutosave() || project.saving || Date.now() < project.retryAt) return;
  if (!project.savedJson && !worthSaving()) return;
  // Видео ещё не в Reel Lab — отправляем в фоне: без него проект потом не открыть.
  if (!state.uploadId && !mainUpload.promise && mainUploadRetryable() && !state.video.remote) void startMainUpload().catch(() => {});
  void saveProjectNow();
}

/** Короткое сообщение, только если сейчас не висит другое (не перебивать «Текст готов» и т. п.). */
function toastIfQuiet(text, ms) {
  if (document.querySelector("#toast.is-on")) return false;
  toast(text, ms);
  return true;
}

/** Студию закрывают или сворачивают: копия — в браузер сразу, на сервер — последним запросом. */
function saveOnLeave() {
  if (!canAutosave()) return;
  const json = JSON.stringify(projectData());
  if (json === project.savedJson || (!project.savedJson && !worthSaving())) return;
  saveLocalCopy(project.id, projectName(), json, projectOwner());
  const csrf = state.csrf || server.csrf;
  if (!csrf) return;
  try {
    const body = projectBody(json);
    void fetch(`/api/projects/${encodeURIComponent(project.id)}`, {
      method: "PUT", credentials: "same-origin", keepalive: body.length < 60000,
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf }, body,
    }).then((response) => {
      if (response.ok) {
        project.savedJson = json;
        dropLocalCopy(project.id);
      }
    }).catch(() => {});
  } catch (_) { /* копия в браузере уже есть */ }
}

function drawSaveState(errorText = "") {
  if (!state.video) return;
  const base = `${state.video.name} · ${humanSize(state.video.size)}`;
  const status = project.demo ? "" : errorText ? " · не сохранилось, повторю" : project.savedJson ? " · сохранено" : "";
  el.fileChipText.textContent = base + status;
  el.fileChip.title = errorText ? `Монтаж пока не сохранился: ${errorText}. Студия попробует ещё раз сама.` : "Выбрать другое видео";
}

/** Копия, которая не дошла до сервера (не было связи), — отправить сейчас. */
async function pushLocalCopy() {
  const copy = loadLocalCopy();
  if (!copy || copy.owner !== projectOwner()) return false;
  try {
    const data = JSON.parse(copy.json);
    if (!data?.video) throw new Error("пустая копия");
    const body = `{"name":${JSON.stringify(copy.name || "Проект")},"summary":${JSON.stringify(summaryOf(data))},"data":${copy.json}}`;
    await putProject(copy.id, body);
    dropLocalCopy(copy.id);
    return true;
  } catch (error) {
    console.warn("[reel-lab] копия проекта не отправилась", error);
    return false;
  }
}

async function loadProjectList() {
  await pushLocalCopy();
  try {
    const payload = await requestJson("/api/projects", { cache: "no-store" });
    project.list = Array.isArray(payload.projects) ? payload.projects : [];
    project.keepHours = Number(payload.keep_hours) || 0;
  } catch (error) {
    console.warn("[reel-lab] список проектов не загрузился", error);
    project.list = [];
  }
  drawResume();
}

function otherProjects() {
  return project.list.filter((item) => item.id !== project.id || !state.video);
}

function keepText() {
  const hours = project.keepHours;
  return hours >= 48 ? `${Math.round(hours / 24)} дня после последней правки` : `${hours} ч после последней правки`;
}

function missingText(item) {
  const name = item.video?.name || item.name;
  if (!item.video?.ok && project.keepHours) return `Видео уже удалено с сервера (оно хранится ${keepText()}). Выбери тот же файл «${name}» — монтаж и текст встанут на место.`;
  if (!item.video?.ok) return `Видео этого проекта не нашлось в Reel Lab. Выбери тот же файл «${name}» — монтаж и текст встанут на место.`;
  if (item.missing) return `${countRu(item.missing, ["вставка удалена", "вставки удалены", "вставок удалено"])} с сервера — их нужно будет добавить заново.`;
  return "";
}

const DRAFT_HIDDEN_KEY = "reel-lab:draft-hidden";

/** Окошко «Черновик»: последний незаконченный монтаж — продолжить в одно нажатие. */
function drawResume() {
  const list = otherProjects();
  let hiddenByUser = false;
  try { hiddenByUser = sessionStorage.getItem(DRAFT_HIDDEN_KEY) === (list[0]?.id || ""); } catch (_) { /* не хранится */ }
  const show = !state.video && list.length > 0 && !hiddenByUser;
  el.resumeBox.hidden = !show;
  el.screen.classList.toggle("has-resume", show);
  stageElement.classList.toggle("has-draft", show);
  el.projectsOpen.hidden = !list.length;
  el.projectsOpenPro.hidden = !list.length;
  // «Черновик» в шапке — всегда под рукой, даже если окошко на экране скрыли крестиком.
  el.draftButton.hidden = !list.length;
  el.draftCount.hidden = list.length < 2;
  el.draftCount.textContent = String(list.length);
  el.draftButton.title = list.length ? `Черновики (${list.length}): продолжить монтаж с того же места` : "Черновиков пока нет";
  fitScreen();
  if (!show) return;
  const first = list[0];
  el.resumeName.textContent = first.name;
  el.resumeName.title = first.name;
  el.resumeMeta.textContent = `${whenText(first.updated)} · ${summaryText(first)}`;
  el.resumeGo.textContent = first.video?.ok ? "Продолжить" : "Выбрать файл";
  el.resumeGo.dataset.project = first.id;
  const note = missingText(first);
  el.resumeNote.hidden = !note;
  // В окошке — коротко; полный текст — во всплывающей подсказке и в «Мои проекты».
  el.resumeNote.textContent = !note ? "" : first.video?.ok ? note : "Видео удалено с сервера — выбери тот же файл.";
  el.resumeNote.title = note;
  el.resumeMore.hidden = list.length < 2;
  el.resumeMore.textContent = `Все (${list.length})`;
}

function drawProjectsList() {
  const list = otherProjects();
  el.projectsList.innerHTML = list.length ? list.map((item) => `
    <div class="project-row">
      <div class="project-copy">
        <b>${escapeHtml(item.name)}</b>
        <span>${escapeHtml(`${whenText(item.updated)} · ${summaryText(item)}`)}</span>
        ${missingText(item) ? `<span class="project-warn">${escapeHtml(missingText(item))}</span>` : ""}
      </div>
      <div class="project-actions">
        <button type="button" class="btn btn-primary" data-project-open="${escapeHtml(item.id)}">${item.video?.ok ? "Открыть" : "Выбрать файл"}</button>
        <button type="button" class="icon-btn project-delete" data-project-delete="${escapeHtml(item.id)}" aria-label="Удалить проект" title="Удалить проект">×</button>
      </div>
    </div>`).join("") : '<p class="note">Сохранённых проектов пока нет.</p>';
}

function openProjectsDialog() {
  drawProjectsList();
  if (!el.projectsDialog.open) el.projectsDialog.showModal();
}

/** Нажали «Продолжить»: видео на сервере — открываем; удалено — просим выбрать тот же файл. */
function onResumeClick(id) {
  const item = project.list.find((entry) => entry.id === id);
  if (!item || busyForChange()) return;
  if (item.video?.ok) {
    if (el.projectsDialog.open) el.projectsDialog.close();
    void resumeProject(id);
    return;
  }
  // Выбор файла — прямо из нажатия (иначе браузер не откроет окно выбора).
  project.pendingPick = id;
  project.pendingAt = Date.now();
  pendingAutoTranscribe = false;
  if (el.projectsDialog.open) el.projectsDialog.close();
  el.videoInput.click();
}

async function deleteProject(id) {
  const item = project.list.find((entry) => entry.id === id);
  if (!item || !(await askConfirm(`Удалить проект «${item.name}»? Монтаж этого видео пропадёт.`))) return;
  try {
    await apiJson(`/api/projects/${encodeURIComponent(id)}`, { method: "DELETE" });
    project.list = project.list.filter((entry) => entry.id !== id);
    dropLocalCopy(id);
    if (project.id === id) {
      project.savedJson = "";
      startNewProject();
    }
  } catch (error) {
    toast(`Не удалилось: ${error?.message || error}`);
  }
  drawProjectsList();
  drawResume();
}

/** Видео открылось (или не открылось) — дождаться, чтобы ставить проект на готовое видео. */
function nextVideoLoad(timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const finish = (error) => {
      el.video.removeEventListener("loadedmetadata", onLoad);
      el.video.removeEventListener("error", onError);
      window.clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const onLoad = () => finish();
    const onError = () => finish(new Error("видео не открылось"));
    const timer = window.setTimeout(() => finish(new Error("видео слишком долго открывается")), timeoutMs);
    el.video.addEventListener("loadedmetadata", onLoad);
    el.video.addEventListener("error", onError);
  });
}

async function resumeProject(id, { file = null, confirmed = false } = {}) {
  if (project.restoring) return;
  if (!confirmed && !(await confirmDiscard())) return;
  const item = project.list.find((entry) => entry.id === id);
  if (file && item?.video && !sameVideoFile(file, item.video)
    && !(await askConfirm(`Это другой файл: в проекте было «${item.video.name}». Открыть проект с этим видео? Текст и монтаж могут не совпасть по времени.`))) return;
  project.restoring = true;
  el.resumeGo.disabled = true;
  showHint("Открываю проект…");
  el.loadingVeil.hidden = false;
  try {
    const saved = await requestJson(`/api/projects/${encodeURIComponent(id)}`, { cache: "no-store" });
    const missing = await openProjectData(saved, file);
    project.savedJson = JSON.stringify(projectData());
    drawSaveState();
    toast(missing.length
      ? `Проект открыт. Не нашлись вставки: ${missing.join(", ")} — добавь их заново.`
      : "Проект открыт: монтаж, текст и звуки на месте ✅", missing.length ? 7000 : 3600);
  } catch (error) {
    console.error(error);
    // Видео уже сменилось, а проект не встал: дальше это новый монтаж, иначе автосохранение
    // записало бы полупустую студию поверх сохранённого проекта.
    if (project.switching) startNewProject();
    toast(`Проект не открылся: ${error?.message || error}`, 6000);
  } finally {
    project.switching = false;
    project.restoring = false;
    el.resumeGo.disabled = false;
    el.loadingVeil.hidden = true;
    showHint("");
    drawResume();
    updateUi();
  }
}

/** Поставить сохранённый проект в студию. Возвращает имена вставок, чьих видео уже нет. */
async function openProjectData(saved, file) {
  const data = saved?.data || {};
  const files = saved?.files || {};
  const v = data.video || {};
  const remoteOk = Boolean(v.uploadId && files[v.uploadId]);
  if (!file && !remoteOk) throw new Error("видео проекта уже удалено с сервера — выбери тот же файл");
  await manifestReady;
  pendingAutoTranscribe = false;
  const source = file || new RemoteVideo({ name: v.name, size: v.size, type: v.type, lastModified: v.lastModified, url: uploadFileUrl(v.uploadId) });
  let loaded = nextVideoLoad();
  project.switching = true;   // с этого места студия уже не прежняя
  setVideo(source, { url: file ? null : source.url, keepProject: true });
  project.id = saved.id;
  project.savedJson = "";
  project.demo = false;
  try {
    await loaded;
  } catch (error) {
    if (file) throw error;
    // Потоком не открылось — берём файл целиком.
    const response = await fetch(source.url, { credentials: "same-origin" });
    if (!response.ok) throw new Error(await responseMessage(response, "Видео проекта не открылось."));
    const blob = await response.blob();
    loaded = nextVideoLoad();
    setVideo(new File([blob], source.name, { type: source.type, lastModified: source.lastModified || Date.now() }), { keepProject: true });
    await loaded;
  }
  // Тот же файл, что уже лежит в Reel Lab, второй раз не грузим.
  state.uploadId = remoteOk && (!file || sameVideoFile(file, v)) ? v.uploadId : null;
  if (v.hasAudio === true || v.hasAudio === false) state.videoHasAudio = v.hasAudio;
  const missing = applyProjectState(data, files);
  redrawProject();
  undoReset();   // открытый проект — это начало, а не шаг, который можно «отменить»
  if (data.montage?.open) setTimelineOpen(true);
  if (state.montage.open) void ensureMainPeaks();
  const time = Number(data.time);
  if (Number.isFinite(time) && time > 0) seekM(Math.min(time, Math.max(0, montage().totalM - 0.05)));
  if (state.fx.followFace && !state.fx.faces.length) void ensureFaces().catch(() => {});
  return missing;
}

const arrayOr = (value, fallback = []) => (Array.isArray(value) ? value : fallback);
const objectOr = (value, fallback) => (value && typeof value === "object" && !Array.isArray(value) ? value : fallback);

function applyProjectState(data, files) {
  // Видео вставок и видео поверх — с сервера, потоком.
  const missing = [];
  const montageData = objectOr(data.montage, {});
  for (const saved of arrayOr(montageData.media)) {
    if (!saved?.key) continue;
    if (!saved.uploadId || !files[saved.uploadId]) {
      missing.push(saved.name || "видео");
      continue;
    }
    const media = {
      key: saved.key, name: saved.name || "видео", file: null, type: saved.type || "", url: uploadFileUrl(saved.uploadId),
      duration: Number(saved.duration) || 0, width: Number(saved.width) || 16, height: Number(saved.height) || 9,
      hasAudio: saved.hasAudio !== false, uploadId: saved.uploadId, uploading: null,
    };
    state.montage.media.set(media.key, media);
    timeline.setMedia(media.key, { url: media.url, aspect: media.width / Math.max(1, media.height), duration: media.duration });
    if (media.hasAudio) void loadClipPeaks(media);
  }
  const usedMissing = applyMontageSection(montageData);
  applyTextSection(objectOr(data.text, {}));
  applyTranslationSection(objectOr(data.translation, {}));
  applyStyleSection(objectOr(data.style, {}));
  applySoundSection(objectOr(data.sound, {}));
  applyPicturesSection(objectOr(data.pictures, {}));
  applyEditSection(objectOr(data.edit, {}));
  applyFxSection(objectOr(data.fx, {}));
  applyHookSection(objectOr(data.hook, {}));
  applyMomentsSection(objectOr(data.moments, {}));
  // Переходы: проект без них (сохранён раньше) — общий выбор этого устройства.
  applyTransitionsSection(data.transitions);
  if (usedMissing && !missing.length) missing.push("видео");
  return missing;
}

// Разделы проекта по отдельности: открыть проект — все сразу; «Отменить» — только изменённые.

function applyMontageSection(montageData) {
  const placed = (item) => item && (item.mediaKey === SELF_MEDIA || state.montage.media.has(item.mediaKey));
  const usedMissing = arrayOr(montageData.inserts).concat(arrayOr(montageData.overlays)).some((item) => item && !placed(item));
  state.montage.inserts = arrayOr(montageData.inserts).filter(placed);
  state.montage.overlays = arrayOr(montageData.overlays).filter(placed);
  state.montage.splits = arrayOr(montageData.splits).filter(Number.isFinite);
  state.montage.audios = arrayOr(montageData.audios).filter((clip) => clip && typeof clip.url === "string");
  state.montage.seq = Math.max(Number(montageData.seq) || 0, state.montage.seq);
  return usedMissing;
}

function applyTextSection(text) {
  state.cues = arrayOr(text.cues).filter((cue) => cue && Array.isArray(cue.words));
  state.cuesBase = text.base === "O" ? "O" : "S";
  state.subtitlesAreTest = Boolean(text.test);
  state.keywords = arrayOr(text.keywords).map(String);
  state.speechLanguage = text.speechLanguage || null;
  if (text.lang && SPEECH_LANGUAGES.some(([code]) => code === text.lang)) {
    for (const select of el.speechLangs) select.value = text.lang;
    drawSpeechNote();
  }
}

function applyTranslationSection(translation) {
  Object.assign(state.translation, {
    original: arrayOr(translation.original, null), language: translation.language || null,
    mode: translation.mode === "replace" ? "replace" : "second",
    second: translation.second?.cues?.length ? translation.second : null, autoY: null,
    lyricLines: Array.isArray(translation.lyricLines) ? translation.lyricLines.map((line) => String(line || "")) : null,
  });
}

function applyStyleSection(style) {
  state.perStyle = objectOr(style.perStyle, state.perStyle);
  state.builders = { ...state.builders, ...objectOr(style.builders, {}) };
  state.builderPreset = { ...state.builderPreset, ...objectOr(style.builderPreset, {}) };
  state.typewriter = { ...state.typewriter, ...objectOr(style.typewriter, {}) };
  state.preset = style.preset || null;
  let styleId = String(style.id || TYPEWRITER_ID);
  if (!templateById(styleId)) {
    // Свой стиль удалён на этом устройстве — его настройки есть в проекте.
    if (isCustom(styleId) && state.builders[styleId]) {
      state.builders[CUSTOM_ID] = state.builders[styleId];
      if (state.perStyle[styleId]) state.perStyle[CUSTOM_ID] = state.perStyle[styleId];
      styleId = CUSTOM_ID;
    } else styleId = TYPEWRITER_ID;
  }
  state.styleId = styleId;
}

function applySoundSection(sound) {
  if (Number.isFinite(sound.voice)) state.voice = sound.voice;
  if (sound.music) state.music = { ...MUSIC_DEFAULTS, ...objectOr(sound.music, {}) };
}

function applyPicturesSection(pictures) {
  for (const key of ["density", "look", "blend", "size", "opacity", "stack"]) if (pictures[key] != null) state.pictures[key] = pictures[key];
  const layout = objectOr(pictures.layout, {});
  state.pictures.layout = { phrases: objectOr(layout.phrases, {}), lines: objectOr(layout.lines, {}) };
  state.pictures.plan = objectOr(pictures.plan, null);
  if (state.pictures.plan) {
    state.pictures.plan.accents = arrayOr(state.pictures.plan.accents);
    state.pictures.plan.items = arrayOr(state.pictures.plan.items);
    for (const item of state.pictures.plan.items) {
      item.editing = false;
      // Картинку не успели нарисовать до закрытия — дорисуем.
      if (item.status === "loading") item.status = "queued";
    }
  }
  // Свои картинки ИИ не перерисовывает сам: план из проекта — главный.
  state.pictures.autoStarted = textSignature();
}

function applyEditSection(edit) {
  Object.assign(state.edit, {
    trimStart: Math.max(0, Number(edit.trimStart) || 0),
    trimEnd: Number.isFinite(edit.trimEnd) ? edit.trimEnd : null,
    cuts: arrayOr(edit.cuts), aiCuts: arrayOr(edit.aiCuts), manual: arrayOr(edit.manual),
    auto: Boolean(edit.auto), strength: PAUSE_RULES[edit.strength] ? edit.strength : "normal",
    voice: { clean: false, level: false, ...objectOr(edit.voice, {}) },
    enhance: { stabilize: false, denoise: false, sharpen: false, ...objectOr(edit.enhance, {}) },
  });
  rebuildCuts();
}

function applyFxSection(fx) {
  Object.assign(state.fx, {
    look: fx.look || "none", adjust: { ...ADJUST_DEFAULTS, ...objectOr(fx.adjust, {}) }, zoom: fx.zoom || "off",
    zoomEdits: { off: arrayOr(fx.zoomEdits?.off), on: arrayOr(fx.zoomEdits?.on) }, followFace: Boolean(fx.followFace),
    faces: arrayOr(fx.faces), facesFor: String(fx.facesFor || ""), jumpZoom: fx.jumpZoom !== false,
    shake: Boolean(fx.shake), flash: Boolean(fx.flash), behind: Boolean(fx.behind),
  });
}

function applyHookSection(hook) {
  state.hook.data = objectOr(hook.data, null);
  state.hook.text = String(hook.text || "");
  state.hook.show = Boolean(hook.show) && Boolean(state.hook.text.trim());
}

function applyMomentsSection(moments) {
  state.moments.list = arrayOr(moments.list);
  if (typeof moments.length === "string") state.moments.length = moments.length;
}

function applyTransitionsSection(transitions) {
  state.transitions = transitions ? normaliseTransitions(transitions) : { ...state.transitions, custom: {} };
}

/** Проект поставлен — перерисовать всё, что от него зависит. */
function redrawProject() {
  touchMontage();
  invalidateFx();
  montage();
  drawStyles();
  syncTune();
  drawSoundPanel();
  drawSimpleKits();
  drawMusic();
  drawPresets();
  drawEditor();
  drawCutList();
  drawTrimInfo();
  drawMoments();
  drawHook();
  drawTranslateControls();
  syncFxControls();
  drawTransitionPanel();
  updatePicturesProgress();
  drawPicturesList();
  if (state.translation.second) onSecondChanged();
  player.setSettings(audioSettings());
  drawRibbon();
  refreshTimeline();
  drawAiReport();
  updateUi();
  schedulePreview(0);
  resumePictureQueue();
}

/** Картинки, которые ИИ не успел нарисовать до закрытия студии, — дорисовать. */
function resumePictureQueue() {
  const items = state.pictures.plan?.items || [];
  if (state.pictures.busy || !items.some((item) => item.status === "queued")) return;
  const run = state.pictures.run + 1;
  state.pictures.run = run;
  state.pictures.busy = true;
  updatePicturesProgress();
  void drawPictureQueue(run).finally(() => {
    if (run !== state.pictures.run) return;
    state.pictures.busy = false;
    updatePicturesProgress();
    drawPicturesList();
  });
}

/** Выбрали сразу несколько видео: первое — основное, остальные встают следом друг за другом. */
async function openPickedVideos(files, { auto = false } = {}) {
  const [first, ...rest] = files;
  if (!rest.length || project.pendingPick) {
    await openPickedVideo(first, { auto });
    return;
  }
  // Несколько видео — это новый монтаж: без вопроса «продолжить прошлый?».
  if (busyForChange() || !(await confirmDiscard())) return;
  // Распознавание — после того как все видео встанут на ленту: речь есть не только в первом.
  pendingAutoTranscribe = false;
  const loaded = nextVideoLoad();
  setVideo(first);
  try {
    await loaded;
  } catch (error) {
    toast(`Видео не открылось: ${error?.message || error}`, 5000);
    return;
  }
  setTimelineOpen(true);
  const added = await addClips(rest, { atEnd: true });
  if (added) toast(`Ролик из ${countRu(added + 1, ["видео", "видео", "видео"])}: они стоят на ленте друг за другом.`, 4500);
  if (auto) void transcribeVideo({ ask: false, auto: true });
}

/** Видео выбрано (кнопкой или перетаскиванием): может, это видео уже монтировалось? */
async function openPickedVideo(file, { auto = false } = {}) {
  if (busyForChange()) {
    project.pendingPick = null;
    return;
  }
  // Ждём файл для проекта не дольше 10 минут: окно выбора могли закрыть, ничего не выбрав.
  const pending = project.pendingPick && Date.now() - (project.pendingAt || 0) < 10 * 60 * 1000 ? project.pendingPick : null;
  project.pendingPick = null;
  if (pending) {
    await resumeProject(pending, { file });
    return;
  }
  if (!(await confirmDiscard())) {
    pendingAutoTranscribe = false;
    return;
  }
  const match = project.list.find((item) => item.id !== project.id && sameVideoFile(file, item.video));
  if (match && await askConfirm(`Это видео уже монтировалось (${whenText(match.updated)} · ${summaryText(match)}). Продолжить с того места, где остановился? «Отмена» — начать заново.`)) {
    pendingAutoTranscribe = false;
    await resumeProject(match.id, { file, confirmed: true });
    return;
  }
  if (auto) pendingAutoTranscribe = true;
  setVideo(file);
}

function wireProjects() {
  el.draftButton.addEventListener("click", () => {
    // Окошко «Черновик» на пустом экране снова показывается, а список — сразу.
    try { sessionStorage.removeItem(DRAFT_HIDDEN_KEY); } catch (_) { /* не хранится */ }
    drawResume();
    openProjectsDialog();
  });
  el.resumeClose.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    // Скрыть до следующего открытия студии (или пока не появится другой черновик).
    try { sessionStorage.setItem(DRAFT_HIDDEN_KEY, el.resumeGo.dataset.project || ""); } catch (_) { /* не запомнится */ }
    el.resumeBox.hidden = true;
    el.screen.classList.remove("has-resume");
    stageElement.classList.remove("has-draft");
    fitScreen();
  });
  el.resumeGo.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onResumeClick(el.resumeGo.dataset.project);
  });
  el.resumeMore.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openProjectsDialog();
  });
  el.projectsOpen.addEventListener("click", openProjectsDialog);
  el.projectsOpenPro.addEventListener("click", openProjectsDialog);
  el.projectsClose.addEventListener("click", () => el.projectsDialog.close());
  el.projectsList.addEventListener("click", (event) => {
    const open = event.target.closest("[data-project-open]");
    const remove = event.target.closest("[data-project-delete]");
    if (open) onResumeClick(open.dataset.projectOpen);
    else if (remove) void deleteProject(remove.dataset.projectDelete);
  });
  window.setInterval(autosaveTick, AUTOSAVE_MS);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") saveOnLeave(); });
  window.addEventListener("pagehide", saveOnLeave);
}

let pendingAutoTranscribe = false;

function wireSimple() {
  document.querySelectorAll(".mode-switch button").forEach((button) => button.addEventListener("click", () => applyMode(button.dataset.mode)));
  el.simplePick.addEventListener("click", () => {
    pendingAutoTranscribe = true;
    el.videoInput.click();
  });
  el.simpleDemo.addEventListener("click", () => { void openDemo(); });
  el.simpleEditText.addEventListener("click", () => {
    applyMode("pro");
    openTab("text");
  });
  el.simpleSrt.addEventListener("click", () => el.srtInput.click());
  el.simpleSrtEmpty.addEventListener("click", () => el.srtInput.click());
  el.simpleLyrics.addEventListener("click", openLyrics);
  el.simpleLyricsEdit.addEventListener("click", openLyrics);
  el.simpleTranscribe.addEventListener("click", () => { void transcribeVideo(); });
  el.simpleTranslate.addEventListener("click", () => {
    applyMode("pro");
    openTab("text");
    window.setTimeout(() => el.translateBlock.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
  });
  el.simpleTune.addEventListener("click", () => {
    applyMode("pro");
    openTab("tune");
  });
  el.simplePro.addEventListener("click", () => applyMode("pro"));
  el.simpleExport.addEventListener("click", () => { void exportVideo(); });
  el.magicRun.addEventListener("click", () => { void runMagic(); });
  el.aiReport.addEventListener("click", onAiReportClick);
  el.aiReportPro.addEventListener("click", onAiReportClick);
  el.magicChips.addEventListener("click", (event) => {
    const chip = event.target.closest("[data-magic]");
    if (!chip) return;
    void setMagic(chip.dataset.magic, !magicOn(chip.dataset.magic));
  });
  el.simpleStyleGrid.addEventListener("click", onStyleGridClick);
}

// ---------------------------------------------------------------------------
// Сборка

function setExportProgress(label, percent) {
  el.exportPanel.hidden = false;
  el.exportLabel.textContent = label;
  if (typeof percent === "number") {
    const value = Math.max(2, Math.min(100, percent));
    el.exportFill.style.width = `${value}%`;
    el.exportPercent.textContent = `${Math.round(value)}%`;
  }
}

// Любая правка делает собранный ролик устаревшим — прячем его, чтобы не
// скачать старую версию.
function hideResult() {
  if (state.rendering) return;
  el.exportResult.hidden = true;
  el.exportError.hidden = true;
  el.exportPanel.hidden = true;
}

function resultFileName() {
  const original = state.video?.name?.replace(/\.[^.]+$/, "") || "reel";
  const style = isCustom() ? "svoj-stil" : state.styleId;
  return `${original}-${style}.mp4`;
}

async function finishWithSound(blob, sfx, spec) {
  setExportProgress("Свожу голос и звуки…", 96);
  const csrf = await sessionCsrf();
  const montaged = Boolean(spec?.montage);
  const form = new FormData();
  form.append("video", blob, "rendered.mp4");
  if (sfx) form.append("sfx", sfx, "sfx.wav");
  form.append("upload_id", state.uploadId || "");
  form.append("sfx_gain", "1");
  // Со вставками голос уже собран и очищен сервером при склейке — второй раз не трогаем.
  form.append("speech_gain", montaged ? "1" : String(state.voice));
  form.append("voice_clean", !montaged && state.edit.voice.clean ? "1" : "0");
  form.append("voice_level", !montaged && state.edit.voice.level ? "1" : "0");
  // Если куски вырезаны или есть вставки, голос берётся из собранного ролика — там он уже смонтирован.
  if (montaged || spec?.edit?.skip?.length) form.append("speech_from", "rendered");
  // Если связь со студией оборвалась посреди ответа (ролик готов, но не дошёл
  // до страницы), сводим ещё раз: это пара секунд, а не вся сборка заново.
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch("/api/finish-video", { method: "POST", credentials: "same-origin", headers: { "X-CSRF-Token": csrf }, body: form });
      if (!response.ok) throw new Error(await responseMessage(response, "Не удалось свести звук."));
      return await response.blob();
    } catch (error) {
      if (attempt >= 1 || !(error instanceof TypeError)) throw error;
      console.warn("[reel-lab] сведение звука: связь оборвалась, повторяю", error);
      setExportProgress("Связь прервалась — свожу звук ещё раз…", 96);
    }
  }
}

/** Вставки и видео поверх уходят на сервер до сборки (обычно они уже там). */
async function ensureMontageUploads() {
  const model = montage();
  if (model.isEmpty) return;
  const keys = new Set([...model.inserts.map((item) => item.mediaKey), ...model.overlays.filter((place) => place.visible).map((place) => place.item.mediaKey)]);
  const list = [...keys].map((key) => state.montage.media.get(key)).filter(Boolean);
  if (list.some((media) => !media.uploadId)) setExportProgress("Отправляю вставки в Reel Lab…", 2);
  await Promise.all(list.map((media) => uploadClip(media)));
  if (!state.uploadId) await sessionCsrf();
}

/**
 * Исходник для сборки: улучшение (стабилизация, шумодав, резкость) и вставки
 * других видео сервер делает до наложения субтитров.
 */
/** Сам файл видео для сборки в браузере: видео открытого проекта приходит с сервера (один раз). */
async function videoFile() {
  const remote = state.video;
  if (!remote?.remote) return remote;
  setExportProgress("Беру видео проекта…", 2);
  const response = await fetch(remote.url, { credentials: "same-origin" });
  if (!response.ok) throw new Error(await responseMessage(response, "Видео проекта не открылось."));
  const blob = await response.blob();
  const file = new File([blob], remote.name, { type: remote.type || blob.type || "video/mp4", lastModified: remote.lastModified || Date.now() });
  if (state.video === remote) state.video = file;
  return file;
}

async function preparedSource(spec) {
  const enhance = state.edit.enhance;
  const wantsEnhance = enhance.stabilize || enhance.denoise || enhance.sharpen;
  if (!wantsEnhance && !spec.montage) return videoFile();
  const label = spec.montage ? "Склеиваю вставки" : "Улучшаю видео";
  setExportProgress(`${label}…`, 3);
  await sessionCsrf();
  let job = await apiJson("/api/edit/prepare", {
    body: { upload_id: state.uploadId, enhance, montage: spec.montage || null, voice: { ...state.edit.voice, gain: state.voice } },
  });
  while (job.status === "running") {
    setExportProgress(`${label}… ${Math.round(job.percent || 0)}%`, 3 + (job.percent || 0) * 0.2);
    await wait(900);
    job = await pollJson(`/api/edit/prepare/${encodeURIComponent(job.id)}`);
  }
  if (job.status !== "completed") throw new Error(job.error || "Видео не удалось подготовить.");
  const response = await fetch(`/api/edit/prepared/${encodeURIComponent(job.id)}`, { credentials: "same-origin" });
  if (!response.ok) throw new Error(await responseMessage(response, "Не удалось получить подготовленное видео."));
  const blob = await response.blob();
  return new File([blob], state.video.name || "video.mp4", { type: "video/mp4" });
}

async function renderInBrowser() {
  await ensureMontageUploads();
  const spec = buildSpec();
  const source = await preparedSource(spec);
  const base = source === state.video ? 0 : 23;
  const model = montage();
  const { blob, sfx } = await renderWithStyle(spec, source, {
    videoSize: state.videoSize,
    // Со вставками движок читает сборку (M): она длиннее исходника на длину вставок.
    duration: spec.montage ? model.totalM : state.duration,
    onProgress: (label, percent) => setExportProgress(label, typeof percent === "number" ? base + percent * (0.95 - base / 100) : null),
  });
  const needsMix = sfx || spec.montage || Math.abs(state.voice - 1) > 0.01 || state.edit.voice.clean || state.edit.voice.level;
  return needsMix ? finishWithSound(blob, sfx, spec) : blob;
}

async function renderOnServer() {
  setExportProgress("Отправляю задачу на сервер…", 2);
  await ensureMontageUploads();
  const csrf = await sessionCsrf();
  const job = await requestJson("/api/render-jobs", {
    method: "POST",
    headers: { "X-CSRF-Token": csrf, "Content-Type": "application/json" },
    body: JSON.stringify({ upload_id: state.uploadId, request_id: requestId("render"), spec: buildSpec() }),
  });
  const deadline = Date.now() + 2 * 60 * 60 * 1000;
  while (Date.now() < deadline) {
    const list = await pollJson("/api/jobs");
    const current = list?.jobs?.find((item) => item.id === job.id);
    if (!current) throw new Error("Задача сборки пропала.");
    if (current.status === "completed") break;
    if (current.status === "failed") throw new Error(current.error || "Сервер не смог собрать ролик.");
    if (current.status === "cancelled") throw new Error("Сборка остановлена.");
    const percent = Number(current?.progress?.percent);
    setExportProgress(current.status === "queued" ? "Жду очереди на сервере…" : (current.progress_label || "Сервер собирает ролик…"), Number.isFinite(percent) ? percent : 5);
    await wait(1200);
  }
  const response = await fetch(`/api/jobs/${encodeURIComponent(job.id)}/video`, { credentials: "same-origin" });
  if (!response.ok) throw new Error(await responseMessage(response, "Не удалось получить готовый ролик."));
  return response.blob();
}

/**
 * Сервер (Telegram): ролик собирает сервер и сам присылает его в чат.
 * Телефон только ставит задачу и показывает очередь — файл не скачивает.
 */
async function exportOnServer() {
  setExportProgress("Отправляю задачу на сервер…", 2);
  await ensureMontageUploads();
  if (!state.uploadId) await uploadSourceVideo();
  const csrf = server.csrf;
  const job = await requestJson("/api/render-jobs", {
    method: "POST",
    headers: { "X-CSRF-Token": csrf, "Content-Type": "application/json" },
    body: JSON.stringify({ upload_id: state.uploadId, request_id: requestId("render"), spec: buildSpec() }),
  });
  if (job.me) applyMe(job.me);
  haptic("medium");
  const deadline = Date.now() + 2 * 60 * 60 * 1000;
  let current = job;
  while (Date.now() < deadline) {
    let list;
    try {
      list = await pollJson("/api/jobs");
    } catch (error) {
      // Сборка идёт на сервере и без телефона: ролик всё равно придёт в чат.
      if (error?.network) {
        const going = new Error("Связь пропала, но сервер продолжает собирать — ролик придёт в чат с ботом.");
        going.keepsGoing = true;
        throw going;
      }
      throw error;
    }
    current = list?.jobs?.find((item) => item.id === job.id);
    if (!current) throw new Error("Задача сборки пропала.");
    if (current.status === "completed") break;
    if (current.status === "failed") throw new Error(current.error || "Сервер не смог собрать ролик.");
    if (current.status === "cancelled") throw new Error("Сборка остановлена.");
    const percent = Number(current?.progress?.percent);
    const label = current.status === "queued"
      ? (current.queue_position > 1 ? `В очереди: перед тобой ${current.queue_position - 1}. Можно закрыть студию — ролик придёт в чат` : "Сейчас начну собирать…")
      : `${current.progress_label || "Сервер собирает ролик…"} Можно закрыть студию — ролик придёт в чат`;
    setExportProgress(label, Number.isFinite(percent) ? percent : 5);
    await wait(1500);
  }
  if (current?.status !== "completed") throw new Error("Сборка заняла слишком много времени.");
  const ticket = await requestJson(`/api/jobs/${encodeURIComponent(job.id)}/download`, {
    method: "POST",
    headers: { "X-CSRF-Token": csrf, "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "video" }),
  });
  void refreshMe();
  return { url: ticket.url, fileName: ticket.file_name || resultFileName(), size: current?.result?.size_bytes || 0, duration: current?.result?.duration || 0 };
}

async function exportVideo() {
  if (server.active) return exportVideoServer();
  if (state.rendering || !canExport()) return;
  pausePreview();
  state.rendering = true;
  el.exportResult.hidden = true;
  el.exportError.hidden = true;
  setExportProgress("Готовлю сборку…", 2);
  updateUi();
  try {
    const blob = el.serverRender.checked ? await renderOnServer() : await renderInBrowser();
    if (state.resultUrl) URL.revokeObjectURL(state.resultUrl);
    state.resultBlob = blob;
    state.resultUrl = URL.createObjectURL(blob);
    el.downloadButton.href = state.resultUrl;
    el.downloadButton.download = resultFileName();
    setExportProgress("Видео готово", 100);
    el.resultTitle.textContent = "Видео готово";
    el.resultMeta.textContent = `${resultFileName()}, ${humanSize(blob.size)}`;
    el.exportResult.hidden = false;
  } catch (error) {
    console.error(error);
    el.exportError.hidden = false;
    el.exportError.textContent = `Видео не собралось: ${error?.message || error}`;
  } finally {
    state.rendering = false;
    updateUi();
  }
}

async function exportVideoServer() {
  if (state.rendering || !canExport()) return;
  pausePreview();
  state.rendering = true;
  el.exportResult.hidden = true;
  el.exportError.hidden = true;
  setExportProgress("Готовлю сборку…", 2);
  updateUi();
  const videoAtStart = state.video;
  try {
    const result = await exportOnServer();
    if (state.video !== videoAtStart) {
      // Уже монтируют другое видео: не показываем старый ролик поверх нового — только уведомление.
      haptic("success");
      toast("Прошлый ролик готов и отправлен в чат с ботом ✅", 5000);
      return;
    }
    state.resultBlob = null;
    state.resultUrl = `${result.url}${result.url.includes("?") ? "&" : "?"}inline=1`;
    state.resultDownload = result;
    el.downloadButton.href = result.url;
    el.downloadButton.removeAttribute("download");
    el.downloadButton.textContent = "Скачать";
    setExportProgress("Видео готово", 100);
    el.resultTitle.textContent = "Готово! Ролик уже в чате с ботом";
    el.resultTitle.classList.add("result-sent");
    el.resultMeta.textContent = [formatClock(result.duration || 0), result.size ? humanSize(result.size) : ""].filter(Boolean).join(" · ");
    el.exportResult.hidden = false;
    haptic("success");
    toast("Ролик готов и отправлен в чат с ботом ✅");
  } catch (error) {
    console.error(error);
    if (state.video !== videoAtStart) {
      toast(error?.keepsGoing ? error.message : `Прошлый ролик не собрался: ${error?.message || error}`, 6000);
      return;
    }
    el.exportError.hidden = false;
    el.exportError.textContent = error?.keepsGoing ? error.message : `Видео не собралось: ${error?.message || error}`;
    haptic(error?.keepsGoing ? "warning" : "error");
  } finally {
    state.rendering = false;
    updateUi();
  }
}

function canExport() {
  return Boolean(state.video && state.videoSize && (server.active || hasWebCodecs()) && !state.transcription.busy && !project.restoring);
}

// ---------------------------------------------------------------------------
// Состояние интерфейса

function showHint(text) {
  el.screenHint.hidden = !text;
  el.screenHint.textContent = text || "";
}

function updateUi() {
  if (server.active) syncMainButton();
  const busy = state.transcription.busy;
  el.transcribeButton.disabled = !state.video || busy;
  el.transcribeButton.textContent = busy ? "Распознаю…" : "Распознать речь";
  el.cancelTranscription.hidden = !busy;
  el.testTextButton.disabled = !state.video || busy;
  el.exportButton.disabled = !canExport() || state.rendering;
  // На узком экране в шапке — коротко («Собрать»): слово «видео» прячет CSS, шапка помещается в ширину.
  if (state.rendering) {
    if (el.exportButton.textContent !== "Собираю…") el.exportButton.textContent = "Собираю…";
  } else if (!el.exportButton.querySelector(".export-more")) {
    el.exportButton.innerHTML = 'Собрать<span class="export-more"> видео</span>';
  }
  el.playButton.disabled = !state.video;
  el.montageToggle.disabled = !state.video;
  el.openTimeline.disabled = !state.video;
  el.simpleTimeline.disabled = !state.video;
  el.simpleBeat.disabled = !state.video;
  el.beatOpen.disabled = !state.video;
  if (!state.video && state.montage.open) setTimelineOpen(false);
  el.picturesRun.disabled = !state.cues.length || state.pictures.busy;
  el.smartCutRun.disabled = !state.cues.length || state.edit.busy;
  el.momentsRun.disabled = !state.cues.length || state.moments.busy;
  el.autoEnhance.disabled = !state.video || !state.duration;
  el.hookBlock.hidden = !state.cues.length;
  el.translateBlock.hidden = !state.cues.length && !state.translation.original;
  drawTrimInfo();
  drawSimple();
  drawAtmoChips();
  el.picturesRun.textContent = state.pictures.plan?.items?.length || state.pictures.plan?.provider ? "Подобрать заново" : "Подобрать картинки";
  drawAiReport();
  // Без текста поверх видео ничего не пишем: подсказка закрывала кадр и мешала монтажу.
  if (!state.video) showHint("");
  else if (busy) showHint("Распознаю речь — текст появится здесь");
  else if (state.cues.length && state.subtitlesAreTest) showHint("Проверочный текст — он не совпадает с речью");
  else showHint("");
}


// ---------------------------------------------------------------------------
// Ритм музыки: доли на ленте, склейки в бит, «Собери под музыку»

/** Откуда ритм: трек фона и музыка/звуки на ленте (время ролика). */
function rhythmSources(model = montage()) {
  const sources = [];
  const entry = musicEntry();
  const url = entry?.files?.[0];
  if (url && state.music.volume > 0) {
    sources.push({ url, label: entry.label, start: Number(state.music.start) || 0, trackStart: Number(state.music.trackStart) || 0,
      until: model.totalO, loop: state.music.loop !== false, kind: "music" });
  }
  for (const { clip, o0, o1 } of audioPlaces(model)) {
    sources.push({ url: clip.url, label: clip.name, start: o0, trackStart: clip.in, until: o1, loop: false, kind: "clip" });
  }
  return sources;
}

const beatState = { failed: new Set(), pending: new Set(), key: "", beats: [] };

function requestBeats(url) {
  if (!url || beatState.pending.has(url) || beatState.failed.has(url) || cachedBeats(url)) return;
  beatState.pending.add(url);
  beatsForUrl(url).then(() => {
    beatState.key = "";
    refreshTimeline();
    updateTimelineToolbar();
    if (el.beatDialog.open) drawBeatMusic();
  }).catch((error) => {
    beatState.failed.add(url);
    console.warn("[reel-lab] ритм музыки не посчитался", error);
    if (el.beatDialog.open) drawBeatMusic();
  }).finally(() => beatState.pending.delete(url));
}

/** Доли музыки в шкале ролика: [{ o, strong }]. Пока трек считается — пусто. */
function videoBeats(model = montage()) {
  const sources = rhythmSources(model);
  const key = JSON.stringify([sources.map((source) => [source.url, source.start, source.trackStart, source.until, source.loop, Boolean(cachedBeats(source.url))]), model.totalO]);
  if (beatState.key === key) return beatState.beats;
  const list = [];
  for (const source of sources) {
    const analysis = cachedBeats(source.url);
    if (analysis) list.push(...beatsInVideo(analysis, source));
    else requestBeats(source.url);
  }
  list.sort((a, b) => a.o - b.o);
  const beats = [];
  for (const beat of list) {
    const last = beats[beats.length - 1];
    if (last && beat.o - last.o < 0.06) {
      last.strong = last.strong || beat.strong;
      continue;
    }
    beats.push({ ...beat });
  }
  beatState.key = key;
  beatState.beats = beats;
  return beats;
}

/** «В бит»: конец каждой вставки и края видео поверх — точно в долю (кадр не короче 0.3 с). */
function fitToBeats() {
  if (!videoBeats().length) {
    setTimelineNote("Сначала добавь музыку — фоном («Звук» → «Музыка на фон») или на ленту.");
    return;
  }
  pushHistory();
  let changed = 0;
  for (const id of montage().inserts.map((item) => item.id)) {
    const model = montage();
    const beats = videoBeats(model);
    const placed = model.inserts.find((item) => item.id === id);
    const item = itemById("insert", id);
    const media = mediaOf(item);
    if (!placed || !item || !media) continue;
    const speed = clipSpeed(item);
    const o0 = model.toO(placed.m0);
    const end = o0 + placed.len;
    const latest = o0 + Math.max(0, media.duration - item.in) / speed;
    const candidates = beats.filter((beat) => beat.o >= o0 + 0.3 && beat.o <= latest + 1e-6);
    const beat = nearestBeat(candidates, end);
    if (!beat || Math.abs(beat.o - end) < 0.008) continue;
    item.out = item.in + (beat.o - o0) * speed;
    touchMontage();
    changed += 1;
  }
  for (const id of state.montage.overlays.map((item) => item.id)) {
    let model = montage();
    let place = model.overlays.find((entry) => entry.item.id === id);
    const item = itemById("overlay", id);
    const media = mediaOf(item);
    if (!place?.visible || !item || !media) continue;
    const startBeat = nearestBeat(videoBeats(model), place.o0, 0.6);
    if (startBeat && Math.abs(startBeat.o - place.o0) > 0.008) {
      const s = model.sourceAt(model.fromO(startBeat.o));
      if (s != null) {
        item.at = s;
        touchMontage();
        changed += 1;
        model = montage();
        place = model.overlays.find((entry) => entry.item.id === id);
      }
    }
    if (!place?.visible) continue;
    const speed = clipSpeed(item);
    const latest = place.o0 + Math.max(0, media.duration - item.in) / speed;
    const endBeat = nearestBeat(videoBeats(model).filter((beat) => beat.o >= place.o0 + 0.3 && beat.o <= latest + 1e-6), place.o1);
    if (endBeat && Math.abs(endBeat.o - place.o1) > 0.008) {
      item.out = item.in + (endBeat.o - place.o0) * speed;
      touchMontage();
      changed += 1;
    }
  }
  if (!changed) {
    setTimelineNote("Всё уже стоит в долю.");
    return;
  }
  onEditChanged();
  setTimelineNote(`В долю встало склеек: ${changed}. Доли — отметки над лентой, края клипов к ним прилипают.`);
}

// --- Окно «Собрать под музыку» -------------------------------------------------

const beatDialog = { selected: new Set(), order: [], rhythm: "auto", length: "30", accent: "none", busy: false, note: "" };
const clipThumbs = new Map();

/** Видео, из которых можно собрать ролик: основное и все добавленные. */
function beatClipList() {
  const list = [];
  if (state.video) list.push(mainMedia());
  for (const media of state.montage.media.values()) list.push(media);
  return list.filter((media) => media.duration > 0.3);
}

function clipThumb(media) {
  const key = media.key === SELF_MEDIA ? `main|${state.videoUrl}` : media.key;
  if (clipThumbs.has(key)) return clipThumbs.get(key);
  const promise = new Promise((resolve) => {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    const done = (value) => {
      video.removeAttribute("src");
      video.load();
      resolve(value);
    };
    video.addEventListener("loadeddata", () => { video.currentTime = Math.min(1, (video.duration || 1) / 3); }, { once: true });
    video.addEventListener("seeked", () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 120;
        canvas.height = 160;
        const ctx = canvas.getContext("2d");
        const scale = Math.max(canvas.width / video.videoWidth, canvas.height / video.videoHeight);
        ctx.drawImage(video, (canvas.width - video.videoWidth * scale) / 2, (canvas.height - video.videoHeight * scale) / 2, video.videoWidth * scale, video.videoHeight * scale);
        done(canvas.toDataURL("image/jpeg", 0.75));
      } catch (_) {
        done("");
      }
    }, { once: true });
    video.addEventListener("error", () => done(""), { once: true });
    video.src = media.url;
  });
  clipThumbs.set(key, promise);
  return promise;
}

function drawBeatClips() {
  const list = beatClipList();
  for (const media of list) if (!beatDialog.order.includes(media.key)) beatDialog.order.push(media.key);
  beatDialog.order = beatDialog.order.filter((key) => list.some((media) => media.key === key));
  const ordered = beatDialog.order.map((key) => list.find((media) => media.key === key)).filter(Boolean);
  el.beatClips.innerHTML = ordered.map((media) => {
    const on = beatDialog.selected.has(media.key);
    const name = media.key === SELF_MEDIA ? "Основное видео" : (media.name || "видео").replace(/\.[^.]+$/, "");
    const position = on ? [...beatDialog.selected].indexOf(media.key) + 1 : "";
    return `<button type="button" class="beat-clip${on ? " is-on" : ""}" data-clip="${escapeHtml(media.key)}" aria-pressed="${on}">
      <span class="beat-clip-thumb" data-thumb="${escapeHtml(media.key)}"></span>
      <span class="beat-clip-time">${formatShortClock(media.duration)}</span>
      <span class="beat-clip-check">${on ? `<span class="beat-clip-order">${position}</span>` : ""}</span>
      <span class="beat-clip-name">${escapeHtml(name)}</span></button>`;
  }).join("");
  for (const media of ordered) {
    void clipThumb(media).then((url) => {
      const node = el.beatClips.querySelector(`[data-thumb="${CSS.escape(media.key)}"]`);
      if (node && url) node.style.backgroundImage = `url(${url})`;
    });
  }
  const count = beatDialog.selected.size;
  el.beatClipsCount.textContent = count ? `выбрано ${count} · по порядку нажатий` : "нажми на видео, чтобы выбрать";
}

/** Музыка для сборки: трек фона, иначе первая музыка на ленте. */
function beatMusicSource() {
  const sources = rhythmSources();
  return sources.find((source) => source.kind === "music") || sources[0] || null;
}

function drawBeatMusic() {
  const source = beatMusicSource();
  if (!source) {
    el.beatMusic.innerHTML = `<span class="beat-music-name">Нет музыки</span>
      <button type="button" class="btn btn-ghost" data-beat-music="pick">♪ Выбрать музыку</button>
      <span class="beat-music-meta">Свою музыку можно добавить там же — «Добавить свою».</span>`;
  } else {
    const analysis = cachedBeats(source.url);
    const failed = beatState.failed.has(source.url);
    if (!analysis && !failed) requestBeats(source.url);
    const meta = failed ? "Ритм не нашёлся — склейки встанут через равные промежутки."
      : analysis ? (analysis.tempo ? `Темп ${Math.round(analysis.tempo)} ударов в минуту · ${countRu(analysis.beats.length, ["доля", "доли", "долей"])}` : "В треке нет чёткого ритма — склейки встанут через равные промежутки.")
      : "Слушаю ритм…";
    el.beatMusic.innerHTML = `<span class="beat-music-name">♪ ${escapeHtml(source.label || "Музыка")}</span>
      ${source.kind === "music" ? '<button type="button" class="link-btn" data-beat-music="pick">Сменить</button>' : ""}
      <span class="beat-music-meta">${escapeHtml(meta)}</span>`;
  }
  updateBeatGo();
}

function drawBeatOptions() {
  el.beatRhythm.innerHTML = RHYTHMS.map((item) => `<button type="button" data-value="${item.id}" class="${beatDialog.rhythm === item.id ? "is-active" : ""}">${escapeHtml(item.label)}</button>`).join("");
  el.beatRhythmHint.textContent = RHYTHMS.find((item) => item.id === beatDialog.rhythm)?.hint || "";
  setSeg(el.beatLength, "value", beatDialog.length);
  setSeg(el.beatAccent, "value", beatDialog.accent);
}

function updateBeatGo() {
  const ready = beatDialog.selected.size > 0 && Boolean(beatMusicSource()) && !beatDialog.busy;
  el.beatGo.disabled = !ready;
  if (!beatDialog.busy) {
    const need = !beatDialog.selected.size ? "Выбери хотя бы одно видео (лучше 2–5)." : !beatMusicSource() ? "Выбери музыку — по ней встанут склейки." : "";
    el.beatStatus.textContent = beatDialog.note || need;   // ошибка висит до следующего действия
  }
}

function drawBeatDialog() {
  beatDialog.note = "";
  drawBeatClips();
  drawBeatMusic();
  drawBeatOptions();
  updateBeatGo();
}

function openBeatDialog() {
  if (!state.video) return;
  pausePreview();
  if (!beatDialog.selected.size) for (const media of beatClipList()) beatDialog.selected.add(media.key);
  drawBeatDialog();
  if (!el.beatDialog.open) el.beatDialog.showModal();
}

async function addBeatClips(files) {
  const failed = [];
  beatDialog.note = "";
  for (const file of files) {
    try {
      el.beatStatus.textContent = `Открываю «${file.name}»…`;
      const media = await importClip(file);
      beatDialog.selected.add(media.key);
      drawBeatClips();
    } catch (error) {
      failed.push(`«${file.name}» не открылось: ${error?.message || error}`);
    }
  }
  beatDialog.note = failed.join(" ");
  updateBeatGo();
}

/** Собрать: кадры по долям из выбранных видео, музыка — на всю длину. */
async function runBeatMontage() {
  if (busyForChange()) return;
  const source = beatMusicSource();
  const clips = [...beatDialog.selected].map((key) => beatClipList().find((media) => media.key === key)).filter(Boolean);
  if (!source || !clips.length || beatDialog.busy) return;
  if (hasWork() && (state.montage.inserts.length || state.montage.overlays.length || state.edit.cuts.some((cut) => cut.enabled !== false))) {
    if (!(await askConfirm("Монтаж на ленте заменится роликом под музыку. Вернуть прежний — кнопка «Отменить» на ленте. Собрать?"))) return;
  }
  beatDialog.busy = true;
  beatDialog.note = "";
  el.beatGo.disabled = true;
  el.beatStatus.textContent = "Слушаю ритм…";
  let analysis = null;
  try {
    analysis = await beatsForUrl(source.url);
  } catch (error) {
    console.warn("[reel-lab] ритм не посчитался", error);
  }
  try {
    const trackLength = analysis?.duration || musicEntry()?.seconds || 60;
    const musicLeft = Math.max(2, source.kind === "music" ? trackLength - source.trackStart : source.until - source.start);
    const target = Number(beatDialog.length) || musicLeft;
    const place = { start: 0, trackStart: source.trackStart, until: musicLeft, loop: false };
    const beats = analysis ? beatsInVideo(analysis, place) : [];
    const length = pickLength(beats, Math.min(target, musicLeft), musicLeft);
    const cuts = cutPoints({ beats, length, rhythm: beatDialog.rhythm, energyAt: energyAtFactory(analysis, place) });
    const shots = planShots({ cuts, clips: clips.map((media) => ({ key: media.key, duration: media.duration })) });
    if (!shots.length) throw new Error("видео слишком короткие");
    const strongAt = new Set(beats.filter((beat) => beat.strong).map((beat) => Math.round(beat.o * 1000)));
    pushHistory();
    // Новый ролик: только кадры под музыку. Основное видео целиком уходит в кадры (как вставки).
    const keepSound = el.beatKeepSound.checked;
    const accent = beatDialog.accent;
    state.montage.overlays = [];
    state.montage.splits = [];
    const custom = {};
    state.montage.inserts = shots.map((shot) => {
      state.montage.seq += 1;
      const id = `i${state.montage.seq}`;
      const media = clips.find((entry) => entry.key === shot.key);
      if (accent !== "none" && shot.index > 0 && strongAt.has(Math.round(shot.o0 * 1000))) custom[`in:${id}`] = { type: accent };
      return { id, mediaKey: shot.key, at: 0, in: shot.in, out: shot.out, speed: shot.speed, volume: keepSound ? 0.5 : 0,
        fit: media.key === SELF_MEDIA ? "cover" : defaultFit(media), seq: state.montage.seq };
    });
    state.transitions.clip = "none";
    state.transitions.cut = "none";
    state.transitions.custom = custom;
    if (source.kind === "music") {
      state.music.start = 0;
      state.music.duck = 0;
      state.music.volume = Math.max(Number(state.music.volume) || 0, 0.85);
    } else {
      // Музыка с ленты: с начала ролика.
      const clip = state.montage.audios.find((entry) => entry.url === source.url);
      if (clip) {
        clip.o = 0;
        clip.duck = false;
      }
    }
    touchMontage();
    applyEdit(coverRange(editSnapshot(), 0, state.duration || 0, state.duration || 0), [0, state.duration || 0]);
    drawTransitionPanel();
    drawMusic();
    player.setSettings(audioSettings());
    el.beatDialog.close();
    setTimelineOpen(true);
    selectInTimeline(null);
    seekO(0);
    const rhythm = analysis?.tempo ? `${Math.round(analysis.tempo)} ударов в минуту` : "без чёткого ритма — равными кусками";
    setTimelineNote(`Собрано под музыку: ${countRu(shots.length, ["кадр", "кадра", "кадров"])}, ${formatShortClock(length)} (${rhythm}). Кадр — выдели на ленте, чтобы обрезать, замедлить или заменить.`);
    window.setTimeout(() => { void togglePlay(); }, 350);
  } catch (error) {
    beatDialog.note = `Не получилось собрать: ${error?.message || error}`;
  } finally {
    beatDialog.busy = false;
    updateBeatGo();
  }
}

function wireBeats() {
  el.beatOpen.addEventListener("click", openBeatDialog);
  el.simpleBeat.addEventListener("click", openBeatDialog);
  el.beatClose.addEventListener("click", () => el.beatDialog.close());
  el.beatClips.addEventListener("click", (event) => {
    const card = event.target.closest("[data-clip]");
    if (!card) return;
    const key = card.dataset.clip;
    if (beatDialog.selected.has(key)) beatDialog.selected.delete(key);
    else beatDialog.selected.add(key);
    beatDialog.note = "";
    drawBeatClips();
    updateBeatGo();
  });
  el.beatAddClips.addEventListener("click", () => el.beatClipInput.click());
  el.beatClipInput.addEventListener("change", () => {
    const files = [...(el.beatClipInput.files || [])];
    el.beatClipInput.value = "";
    if (files.length) void addBeatClips(files);
  });
  el.beatMusic.addEventListener("click", (event) => {
    if (event.target.closest("[data-beat-music=pick]")) openSoundBoard("music");
  });
  soundBoard.dialog.addEventListener("close", () => { if (el.beatDialog.open) drawBeatMusic(); });
  el.beatRhythm.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-value]");
    if (!button) return;
    beatDialog.rhythm = button.dataset.value;
    drawBeatOptions();
  });
  el.beatLength.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-value]");
    if (!button) return;
    beatDialog.length = button.dataset.value;
    drawBeatOptions();
  });
  el.beatAccent.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-value]");
    if (!button) return;
    beatDialog.accent = button.dataset.value;
    drawBeatOptions();
  });
  el.beatGo.addEventListener("click", () => { void runBeatMontage(); });
}

// ---------------------------------------------------------------------------
// Запуск

// Пример: сгенерированный ролик Reel Lab и текст со временем каждого слова.
// Нужен, чтобы попробовать стили и звуки без своего видео.
async function openDemo() {
  if (busyForChange() || !(await confirmDiscard())) return;
  try {
    el.demoButton.disabled = true;
    const [video, vtt] = await Promise.all([
      fetch("/ready-captions/demo/demo.mp4").then((response) => {
        if (!response.ok) throw new Error(`пример не найден (${response.status})`);
        return response.blob();
      }),
      fetch("/ready-captions/demo/demo.vtt").then((response) => response.text()),
    ]);
    const loaded = new Promise((resolve) => el.video.addEventListener("loadedmetadata", resolve, { once: true }));
    setVideo(new File([video], "Пример Reel Lab.mp4", { type: "video/mp4" }));
    // Пример не сохраняется в «Мои проекты» и не грузится на сервер.
    project.demo = true;
    await loaded;
    setSubtitles(vtt, { label: "Открыт пример: текст уже со временем каждого слова. Выбери стиль во вкладке «Стиль» и нажми ▶." });
  } catch (error) {
    showHint(`Пример не открылся: ${error?.message || error}`);
  } finally {
    el.demoButton.disabled = false;
  }
}

function wireEvents() {
  el.tabs.forEach((tab) => tab.addEventListener("click", () => openTab(tab.dataset.tab)));
  el.fileChip.addEventListener("click", () => el.videoInput.click());
  // Окно выбора закрыли без файла (браузеры с событием cancel) — проект больше не ждёт файл.
  el.videoInput.addEventListener("cancel", () => { project.pendingPick = null; });
  el.videoInput.addEventListener("change", async () => {
    const files = [...(el.videoInput.files || [])];
    el.videoInput.value = "";
    if (!files.length) {
      project.pendingPick = null;
      return;
    }
    await openPickedVideos(files, { auto: state.mode === "simple" });
  });
  ["dragenter", "dragover"].forEach((type) => el.screen.addEventListener(type, (event) => {
    event.preventDefault();
    el.dropZone.classList.add("is-over");
  }));
  ["dragleave", "drop"].forEach((type) => el.screen.addEventListener(type, () => el.dropZone.classList.remove("is-over")));
  el.screen.addEventListener("drop", (event) => {
    event.preventDefault();
    const files = [...(event.dataTransfer?.files || [])].filter((item) => item.type.startsWith("video/") || /\.(mp4|mov|webm|m4v|mkv)$/i.test(item.name));
    if (files.length) void openPickedVideos(files, { auto: true });
  });
  el.srtButton.addEventListener("click", () => el.srtInput.click());
  el.srtInput.addEventListener("change", async () => {
    const [file] = el.srtInput.files || [];
    el.srtInput.value = "";
    if (!file) return;
    void cancelTranscription({ quiet: true });
    try {
      setSubtitles(await file.text(), { label: `Текст из файла ${file.name}.` });
    } catch (error) {
      el.sourceNote.textContent = error?.message || "Не удалось прочитать субтитры.";
    }
  });
  el.demoButton.addEventListener("click", () => { void openDemo(); });
  el.demoLink.addEventListener("click", () => { void openDemo(); });
  el.testTextButton.addEventListener("click", () => {
    setSubtitles(testCues(state.duration || 8), { test: true, label: "Вставлен проверочный текст: он подходит, чтобы оценить стиль и звук, но не совпадает с речью." });
  });
  el.transcribeButton.addEventListener("click", () => { void transcribeVideo(); });
  el.cancelTranscription.addEventListener("click", () => { void cancelTranscription(); });
  el.playButton.addEventListener("click", () => { void togglePlay(); });
  el.styleGrid.addEventListener("click", onStyleGridClick);
  el.customGrid.addEventListener("click", onStyleGridClick);
  el.exportButton.addEventListener("click", () => { void exportVideo(); });
  el.downloadButton.addEventListener("click", (event) => {
    if (!server.active || !state.resultDownload) return;
    event.preventDefault();
    downloadFile(state.resultDownload.url, state.resultDownload.fileName || resultFileName());
  });
  el.resultWatch.addEventListener("click", () => {
    if (!state.resultUrl) return;
    el.resultVideo.src = state.resultUrl;
    el.resultDialog.showModal();
    el.resultVideo.play().catch(() => {});
  });
  el.resultDialog.addEventListener("close", () => el.resultVideo.pause());
  document.addEventListener("keydown", (event) => {
    if (event.target.closest("input, select, textarea, [contenteditable]")) return;
    if (event.code === "Space" && state.video) {
      event.preventDefault();
      void togglePlay();
    }
  });
  window.addEventListener("resize", fitScreen);
  wireTune();
  wireBuilder();
  wireSound();
  wireMusic();
  wirePictures();
  wireAiDialog();
  wireEditAndFx();
  wireSimple();
  wireLyrics();
  wireTimeline();
  wireProjects();
  wireTransitions();
  wireBeats();
}

async function loadManifest() {
  try {
    const response = await fetch(`${ASSET_ROOT}/manifest.json`, { cache: "no-store" });
    if (!response.ok) throw new Error(String(response.status));
    state.manifest = await response.json();
  } catch (error) {
    console.error(error);
    showHint("Библиотека стилей не открылась. Запусти Reel Lab и открой студию через http://127.0.0.1:8765/bot");
  }
  drawStyles();
  syncTune();
}

async function loadSounds() {
  try {
    const [manifest, curation] = await Promise.all([loadSoundManifest(), loadSoundCuration()]);
    soundManifest = manifest;
    state.soundRemoved = new Set(curation.removed);
  } catch (error) {
    console.error(error);
  }
  drawSoundPanel();
  drawMusic();
}

// --- Безопасные зоны ---------------------------------------------------------------

function drawSafeOverlay() {
  const { show, platform } = state.safe;
  const zone = safePlatform(platform);
  el.safeToggle.setAttribute("aria-pressed", String(show));
  el.safeShow.checked = show;
  el.safeKeep.checked = state.safe.keep;
  el.safePlatformSeg.querySelectorAll("button").forEach((button) => button.classList.toggle("is-active", button.dataset.platform === platform));
  el.safeOverlay.hidden = !show || !state.video;
  if (el.safeOverlay.hidden) return;
  const pct = (value) => `${(value * 100).toFixed(2)}%`;
  const name = platform === "all" ? "TikTok, Reels, Shorts" : zone.label;
  el.safeOverlay.innerHTML = `
    <div class="safe-zone" style="left:0;right:0;top:0;height:${pct(zone.top)}">Шапка ${escapeHtml(name)}</div>
    <div class="safe-zone" style="left:0;right:0;bottom:0;height:${pct(zone.bottom)}">Ник, подпись и музыка</div>
    <div class="safe-zone safe-zone-right" style="right:0;width:${pct(zone.right)};top:${pct(zone.rightFrom)};height:${pct(zone.rightTo - zone.rightFrom)}">Кнопки</div>
    <div class="safe-frame" style="left:2%;right:2%;top:${pct(zone.top)};bottom:${pct(zone.bottom)}"><span class="safe-tag">Безопасная зона</span></div>`;
}

/** Подсказка в панели: попадает ли сейчас что-то под кнопки или подпись. */
function drawSafeNote() {
  const size = state.videoSize;
  const zone = safePlatform(state.safe.platform);
  const warnings = [];
  if (size) {
    const sig = signatureSpec();
    const layout = sig ? signatureLayout(sig, size.width, size.height) : null;
    if (layout && rectUnsafe({ x: layout.rect.x / size.width, y: layout.rect.y / size.height, w: layout.rect.w / size.width, h: layout.rect.h / size.height }, zone)) {
      warnings.push("подпись с ником попадает под интерфейс площадки — перетащи её выше");
    }
  }
  el.safeNote.textContent = warnings.length
    ? `Внимание: ${warnings.join("; ")}.`
    : state.safe.keep
      ? "Субтитры не опустятся под ник и подпись площадки и не залезут под шапку."
      : "Внизу ролика площадки показывают ник и подпись, справа — кнопки. Субтитры там не прочитать.";
}

function onSafeChanged({ rebuild = false } = {}) {
  saveSafe();
  drawSafeOverlay();
  drawSafeNote();
  if (rebuild) {
    invalidateFx();
    onTuneChange();
    drawFrameSoon();
    composer.refresh();
  }
}

function wireSafeZones() {
  el.safeToggle.addEventListener("click", () => {
    state.safe.show = !state.safe.show;
    onSafeChanged();
  });
  el.safeShow.addEventListener("change", () => {
    state.safe.show = el.safeShow.checked;
    onSafeChanged();
  });
  el.safeKeep.addEventListener("change", () => {
    state.safe.keep = el.safeKeep.checked;
    onSafeChanged({ rebuild: true });
  });
  el.safePlatformSeg.addEventListener("click", (event) => {
    const platform = event.target.closest("button[data-platform]")?.dataset.platform;
    if (!platform) return;
    state.safe.platform = platform;
    onSafeChanged({ rebuild: state.safe.keep });
  });
}

// --- Готовые монтажи --------------------------------------------------------------

function presetCardHtml(preset) {
  const selected = state.preset === preset.id;
  return `<button type="button" class="preset-card${selected ? " is-selected" : ""}" data-preset="${preset.id}" role="listitem" aria-pressed="${selected}" title="${escapeHtml(preset.text)}">
    <span class="preset-thumb"><img src="./presets/${preset.id}.jpg" alt="" loading="lazy" decoding="async"><span class="preset-tag">${escapeHtml(preset.tag)}</span></span>
    <span class="preset-copy"><span class="preset-name">${escapeHtml(preset.title)}</span><span class="preset-desc">${escapeHtml(preset.text)}</span></span>
  </button>`;
}

function drawPresets() {
  const html = MONTAGE_PRESETS.map(presetCardHtml).join("");
  el.presetStrip.innerHTML = html;
  el.presetGrid.innerHTML = html;
  el.presetCounter.textContent = String(MONTAGE_PRESETS.length);
}

function showPresetNote(text) {
  for (const node of [el.presetNote, el.presetNotePro]) {
    node.hidden = !text;
    node.textContent = text || "";
  }
}

const MAGIC_NAMES = { cut: "вырежет паузы и «эээ»", voice: "почистит голос" };

/** Применить готовый монтаж: стиль, шрифт, цвета, звук, фильтр, зум и эффекты. */
async function applyMontagePreset(id, { magic = true } = {}) {
  const preset = presetById(id);
  if (!preset || !templateById(preset.style)) return;
  pausePreview();
  selectStyle(preset.style);
  const ps = settings();
  const defaults = defaultsFor(currentTemplate());
  ps.font = preset.font || "";
  ps.accent = preset.accent || "";
  ps.colors = { ...defaults.colors, ...(preset.colors || {}) };
  ps.sizeScale = preset.sizeScale || 1;
  ps.position = preset.position || "template";
  ps.height = preset.height ?? null;
  ps.x = null;
  ps.phraseLength = preset.phraseLength || "normal";
  const kit = (currentSoundSet()?.kits || []).find((item) => item.id === preset.kit);
  if (kit) {
    const value = kitSettings(soundManifest, soundStyleKey(), kit, state.soundRemoved);
    for (const layer of SOUND_LAYERS) {
      const current = soundSettings().layers[layer.id];
      if (layer.independent && current) value.layers[layer.id] = { ...current };
    }
    applySound(value, { listen: false });
  }
  Object.assign(state.fx, {
    look: preset.look || "none",
    adjust: { ...ADJUST_DEFAULTS, ...(preset.atmo || {}) },
    zoom: preset.zoom || "off",
    jumpZoom: Boolean(preset.jumpZoom),
    flash: Boolean(preset.flash),
    shake: Boolean(preset.shake),
    behind: Boolean(preset.behind),
    followFace: Boolean(preset.followFace),
  });
  state.preset = preset.id;
  if (preset.transition) {
    state.transitions.clip = preset.transition;
    if (state.transitions.cut !== "none") state.transitions.cut = preset.transition;
    saveTransitions();
    drawTransitionPanel();
  }
  syncFxControls();
  syncTune();
  drawStyles();
  drawSoundPanel();
  drawPresets();
  onFxChanged();
  if (ps.font) await loadFontFor(ps.font);
  schedulePreview(0);
  updateUi();
  if (state.fx.followFace && state.video) void ensureFaces().catch(() => {});
  const ops = magic ? preset.magic || [] : [];
  const waiting = ops.filter((op) => !magicOn(op));
  let note = `Готовый монтаж «${preset.title}» применён.`;
  if (waiting.length && !state.cues.length) {
    state.pendingMagic = waiting;
    note += ` Когда появится текст, ИИ ${waiting.map((op) => MAGIC_NAMES[op] || op).join(" и ")}.`;
  } else state.pendingMagic = [];
  note += " Всё можно поправить во вкладках «Настройка», «Эффекты» и «Звук».";
  showPresetNote(note);
  if (waiting.length && state.cues.length) await runPresetMagic(waiting);
}

async function runPresetMagic(ops) {
  state.pendingMagic = [];
  for (const op of ops) {
    if (!magicOn(op)) await setMagic(op, true);
  }
  drawAiReport();
}

function wirePresets() {
  const onClick = (event) => {
    const card = event.target.closest("[data-preset]");
    if (!card) return;
    card.classList.add("is-busy");
    void applyMontagePreset(card.dataset.preset).finally(() => card.classList.remove("is-busy"));
  };
  el.presetStrip.addEventListener("click", onClick);
  el.presetGrid.addEventListener("click", onClick);
}

// --- Подпись поверх видео: панель ------------------------------------------------

function drawSignatureControls() {
  const sig = state.signature;
  el.sigShow.checked = Boolean(sig.show);
  if (document.activeElement !== el.sigText) el.sigText.value = sig.text || "";
  if (document.activeElement !== el.simpleSig) el.simpleSig.value = sig.show ? sig.text || "" : "";
  el.sigOptions.hidden = !sig.show;
  if (!el.sigFont.options.length) el.sigFont.innerHTML = fontOptionsHtml(sig.font, "Montserrat").replace(/<option value="">[^<]*<\/option>/, "");
  el.sigFont.value = fontById(sig.font) ? sig.font : "montserrat";
  const size = Math.round((Number(sig.size) || 1) * 100);
  el.sigSize.value = String(size);
  el.sigSizeValue.textContent = `${size}%`;
  const opacity = Math.round((Number(sig.opacity) || 0.9) * 100);
  el.sigOpacity.value = String(opacity);
  el.sigOpacityValue.textContent = `${opacity}%`;
  setRangeFill(el.sigSize);
  setRangeFill(el.sigOpacity);
  el.sigLook.querySelectorAll("button").forEach((button) => button.classList.toggle("is-active", button.dataset.look === sig.look));
  el.sigPlace.querySelectorAll("button").forEach((button) => {
    const place = SIGNATURE_PLACES[button.dataset.place];
    button.classList.toggle("is-active", Math.abs(place.x - sig.x) < 0.02 && Math.abs(place.y - sig.y) < 0.02);
  });
  const custom = !SIGNATURE_COLORS.includes(String(sig.color).toLowerCase());
  el.sigColors.innerHTML = SIGNATURE_COLORS.map((color) => (
    `<button type="button" class="sig-color${color === String(sig.color).toLowerCase() ? " is-active" : ""}" data-color="${color}" style="--c:${color}" aria-label="Цвет ${color}" aria-pressed="${color === String(sig.color).toLowerCase()}"></button>`
  )).join("") + `<label class="sig-custom${custom ? " is-active" : ""}" title="Свой цвет" style="${custom ? `background:${escapeHtml(sig.color)}` : ""}"><input type="color" value="${escapeHtml(/^#[0-9a-f]{6}$/i.test(sig.color) ? sig.color : "#ffffff")}" aria-label="Свой цвет"></label>`;
}

/** Подпись изменилась: запомнить, перерисовать кадр, рамку на видео. */
function onSignatureChanged() {
  saveSignature();
  drawSignatureControls();
  drawSafeNote();
  invalidateFx();
  hideResult();
  drawFrameSoon();
  composer.refresh();
  // Шрифт подписи может ещё грузиться — кадр перерисуется, когда он придёт.
  const spec = signatureSpec();
  if (spec && document.fonts) document.fonts.load(`${spec.weight} 48px ${spec.font}`, spec.text).then(() => { invalidateFx(); drawFrameSoon(); composer.refresh(); }).catch(() => {});
}

function wireSignature() {
  el.sigShow.addEventListener("change", () => {
    state.signature.show = el.sigShow.checked;
    if (state.signature.show && !String(state.signature.text || "").trim()) window.setTimeout(() => el.sigText.focus(), 0);
    onSignatureChanged();
  });
  el.sigText.addEventListener("input", () => {
    state.signature.text = el.sigText.value;
    if (el.sigText.value.trim() && !state.signature.show) state.signature.show = true;
    onSignatureChanged();
  });
  // Простой режим: одно поле — ник есть, значит подпись видна.
  el.simpleSig.addEventListener("input", () => {
    state.signature.text = el.simpleSig.value;
    state.signature.show = Boolean(el.simpleSig.value.trim());
    onSignatureChanged();
  });
  el.sigPlace.addEventListener("click", (event) => {
    const place = SIGNATURE_PLACES[event.target.closest("button[data-place]")?.dataset.place];
    if (!place) return;
    Object.assign(state.signature, place);
    onSignatureChanged();
  });
  el.sigLook.addEventListener("click", (event) => {
    const look = event.target.closest("button[data-look]")?.dataset.look;
    if (!look) return;
    state.signature.look = look;
    onSignatureChanged();
  });
  el.sigColors.addEventListener("click", (event) => {
    const color = event.target.closest("button[data-color]")?.dataset.color;
    if (!color) return;
    state.signature.color = color;
    onSignatureChanged();
  });
  el.sigColors.addEventListener("input", (event) => {
    if (event.target.type !== "color") return;
    state.signature.color = event.target.value;
    saveSignature();
    invalidateFx();
    hideResult();
    drawFrameSoon();
  });
  el.sigColors.addEventListener("change", (event) => {
    if (event.target.type === "color") onSignatureChanged();
  });
  el.sigFont.addEventListener("change", () => {
    state.signature.font = el.sigFont.value || "montserrat";
    onSignatureChanged();
  });
  el.sigSize.addEventListener("input", () => {
    state.signature.size = Number(el.sigSize.value) / 100;
    el.sigSizeValue.textContent = `${el.sigSize.value}%`;
    setRangeFill(el.sigSize);
    saveSignature();
    invalidateFx();
    hideResult();
    drawFrameSoon();
    composer.refresh();
  });
  el.sigOpacity.addEventListener("input", () => {
    state.signature.opacity = Number(el.sigOpacity.value) / 100;
    el.sigOpacityValue.textContent = `${el.sigOpacity.value}%`;
    setRangeFill(el.sigOpacity);
    saveSignature();
    invalidateFx();
    hideResult();
    drawFrameSoon();
  });
}

function onServerMe(me) {
  state.account = { plan: me.plan, watermark: Boolean(me.watermark), handle: me.bot ? `@${me.bot}` : "" };
  drawAccountChip(me);
  if (state.video) drawFrameSoon();
  syncMainButton();
}

/** Родная кнопка Telegram внизу экрана: «Собрать видео». */
function syncMainButton() {
  const button = server.tg?.MainButton;
  if (!button) return;
  try {
    const ready = canExport();
    if (state.rendering) {
      button.setText("Собираю…");
      button.show();
      button.disable();
      button.showProgress?.(true);
      return;
    }
    button.hideProgress?.();
    // Собрать можно и без субтитров: монтаж, музыка, эффекты.
    if (state.video) {
      button.setText(state.account.watermark ? "Собрать видео (со знаком)" : "Собрать видео");
      button.show();
      if (ready) button.enable(); else button.disable();
    } else {
      button.hide();
    }
  } catch (_) { /* старый клиент Telegram */ }
}

function setupServerUi() {
  state.server = true;
  // На телефоне видео не перетаскивают — выбирают из галереи.
  const dropTitle = document.querySelector(".drop-title");
  const dropText = document.querySelector(".drop-text");
  if (server.light && dropTitle) dropTitle.textContent = "Выбери видео";
  if (server.light && dropText) dropText.textContent = "из галереи телефона — субтитры сделаю сам";
  state.light = server.light;
  state.ai = { configured: true, provider: "server", account_hint: "", source: "server" };
  server.onMe = onServerMe;
  server.onPaywall = (payload) => openPaywall(payload.error || "");
  if (server.me) onServerMe(server.me);
  el.serverRender.checked = true;
  const tg = server.tg;
  if (tg?.MainButton) {
    document.documentElement.classList.add("has-main-button");
    try {
      tg.MainButton.setParams?.({ color: "#f3be5e", text_color: "#2a1d05" });
      tg.MainButton.onClick(() => {
        if (paywallOpen()) closePaywall();
        void exportVideo();
      });
    } catch (_) { /* старый клиент */ }
  }
  // «Назад» Telegram: из «Профи» — в «Просто».
  const back = () => {
    if (state.mode === "pro") {
      applyMode("simple");
      return true;
    }
    return false;
  };
  back.canGoBack = () => state.mode === "pro";
  setBackAction(back);
}

// --- ИИ-помощник: разбор чужого ролика и вопросы о монтаже -------------------------
//
// Окно рисует assistant-ui.js. Здесь — то, что меняет студию: рецепт разбора («как в
// образце») применяется теми же настройками, что и готовые монтажи.

/** Ролик-образец уходит на сервер так же, как основное видео (на телефоне — кусками). */
async function uploadReference(file, onProgress, signal) {
  if (server.active) {
    guardClose(true);
    try {
      return await uploadInChunks(file, { name: file.name || "video.mp4", onProgress, signal });
    } finally {
      guardClose(false);
    }
  }
  const session = await requestJson("/api/upload-session", { signal });
  onProgress?.(0.4);
  const uploaded = await requestJson(`/api/uploads?name=${encodeURIComponent(file.name || "video.mp4")}`, {
    method: "POST",
    headers: { "X-CSRF-Token": session.csrf, "Content-Type": file.type || "application/octet-stream" },
    body: file,
    signal,
  });
  onProgress?.(1);
  return uploaded;
}

const lookLabel = (id) => lookById(id)?.label || id;

/** Субтитры как в образце: свой стиль с деталями из кадров или готовый стиль. */
async function applyCaptionRecipe(caps) {
  if (!caps?.on) return "";
  if (caps.style === CUSTOM_ID && caps.builder) {
    selectStyle(CUSTOM_ID);
    state.builders[CUSTOM_ID] = normaliseBuilder({ ...BUILDER_DEFAULTS, ...caps.builder, name: "Как в образце" });
    state.builderPreset[CUSTOM_ID] = null;
  } else if (templateById(caps.style)) {
    selectStyle(caps.style);
  } else return "";
  const ps = settings();
  if (caps.colors) ps.colors = { ...ps.colors, ...caps.colors };
  if (caps.font) ps.font = caps.font;
  ps.position = ["top", "center", "bottom", "template"].includes(caps.position) ? caps.position : "template";
  ps.height = null;
  ps.x = null;
  if (["short", "normal", "long"].includes(caps.phraseLength)) ps.phraseLength = caps.phraseLength;
  if (ps.font) await loadFontFor(ps.font);
  syncTune();
  drawStyles();
  onTuneChange();
  return state.cues.length ? "субтитры как в образце" : "стиль субтитров (текст — кнопкой «Распознать речь»)";
}

function applyLookRecipe(recipe) {
  state.fx.look = LOOKS.some((look) => look.id === recipe.look) ? recipe.look : "none";
  state.fx.adjust = { ...ADJUST_DEFAULTS, ...(recipe.atmo || {}) };
  syncFxControls();
  onFxChanged();
  const parts = [];
  if (state.fx.look !== "none") parts.push(`цвет ${lookLabel(state.fx.look)}`);
  if (recipe.atmo?.bars) parts.push("кинополосы");
  if (recipe.atmo?.grain) parts.push("зерно");
  return parts.join(", ") || "чистый цвет";
}

function applyCameraRecipe(recipe) {
  Object.assign(state.fx, {
    zoom: ["off", "soft", "dynamic"].includes(recipe.zoom) ? recipe.zoom : "off",
    jumpZoom: Boolean(recipe.jumpZoom),
    flash: Boolean(recipe.flash),
    shake: Boolean(recipe.shake),
  });
  if (state.fx.zoom !== "off") state.fx.followFace = true;
  syncFxControls();
  onFxChanged();
  if (state.fx.followFace && state.video) void ensureFaces().catch(() => {});
  const parts = [];
  if (state.fx.zoom !== "off") parts.push(state.fx.zoom === "dynamic" ? "динамичный зум" : "мягкий зум");
  if (state.fx.flash) parts.push("вспышки на склейках");
  return parts.join(", ");
}

function applyTransitionRecipe(id) {
  const known = TRANSITIONS.some((item) => item.id === id) ? id : "none";
  state.transitions.clip = known;
  state.transitions.cut = known === "none" ? "none" : state.transitions.cut === "none" ? "none" : known;
  saveTransitions();
  onTransitionsChanged();
  return known === "none" ? "обычные склейки" : `переход «${transitionById(known).label}»`;
}

function applySfxRecipe(sfx) {
  if (!sfx?.cut) return "";
  const value = { ...soundSettings(), layers: { ...soundSettings().layers, cut: { sound: sfx.cut, volume: 0.45 } } };
  applySound(value, { listen: false });
  return "«вжух» на склейках";
}

async function applyCutRecipe() {
  if (lyricsMode()) return "";
  if (state.cues.length) {
    if (!magicOn("cut")) await setMagic("cut", true);
    return "паузы вырезаны";
  }
  state.pendingMagic = [...new Set([...(state.pendingMagic || []), "cut"])];
  return "паузы вырежутся, когда появится текст";
}

function applyHookRecipe(text) {
  const clean = String(text || "").trim().slice(0, 90);
  if (!clean) return "";
  state.hook.text = clean;
  state.hook.data = state.hook.data || { hook: clean, title: "", description: "", hashtags: [] };
  state.hook.show = true;
  drawHook();
  onFxChanged();
  return "хук на первые 3 секунды";
}

function prepareBeatRecipe(beat) {
  if (!beat) return;
  if (RHYTHMS.some((item) => item.id === beat.rhythm)) beatDialog.rhythm = beat.rhythm;
  if ([15, 30, 60, 0].includes(Number(beat.length))) beatDialog.length = String(beat.length);
  if (["none", "zoom", "whip", "white"].includes(beat.accent)) beatDialog.accent = beat.accent;
}

/** Один шаг разбора по кнопке «Сделать». Возвращает, что сделано (для подсказки). */
async function applyRecipeStep(step, record) {
  const recipe = record?.result?.recipe || {};
  switch (step?.tool) {
    case "captions": return capitalise(await applyCaptionRecipe(recipe.captions)) || "Готово";
    case "look": return capitalise(applyLookRecipe(recipe));
    case "camera": return capitalise(applyCameraRecipe(recipe)) || "Камера настроена";
    case "transition": return capitalise(applyTransitionRecipe(recipe.transition));
    case "sfx": return capitalise(applySfxRecipe(recipe.sfx));
    case "cut": return capitalise(await applyCutRecipe()) || "Готово";
    case "hook": return capitalise(applyHookRecipe(recipe.hook));
    case "music": return takeReferenceMusic(record);
    case "timeline":
      if (!state.video) throw new Error("сначала выбери своё видео");
      setTimelineOpen(true);
      return "Лента монтажа открыта";
    case "beat":
      prepareBeatRecipe(recipe.beat);
      if (!state.video) throw new Error("сначала выбери свои видео — кнопкой «Сделать похожий из своих видео»");
      openBeatDialog();
      return "Окно «Собрать под музыку» уже настроено как в образце — добавь видео и нажми «♪ Собрать»";
    default: return "";
  }
}

function capitalise(text) {
  const value = String(text || "");
  return value ? value[0].toUpperCase() + value.slice(1) : "";
}

/** «Сделать похожий»: всё, что можно применить сразу, и нарезка под музыку — уже настроенной. */
async function applyRecipeAll(record) {
  const recipe = record?.result?.recipe || {};
  if (busyForChange()) return { text: "", tools: [], close: false };
  const done = [];
  const tools = [];
  const add = (tool, text) => {
    tools.push(tool);
    if (text) done.push(text);
  };
  pausePreview();
  if (recipe.captions?.on) add("captions", await applyCaptionRecipe(recipe.captions));
  add("look", applyLookRecipe(recipe));
  add("camera", applyCameraRecipe(recipe));
  add("transition", applyTransitionRecipe(recipe.transition));
  if (recipe.sfx) add("sfx", applySfxRecipe(recipe.sfx));
  if ((recipe.magic || []).includes("cut")) add("cut", await applyCutRecipe());
  if (recipe.hook) add("hook", applyHookRecipe(recipe.hook));
  state.preset = null;
  drawPresets();
  updateUi();
  let close = false;
  if (recipe.beat) {
    prepareBeatRecipe(recipe.beat);
    if (state.video) {
      tools.push("beat");
      close = true;
      window.setTimeout(openBeatDialog, 60);
    }
  }
  let text = `Сделано как в образце: ${done.filter(Boolean).join(", ")}.`;
  if (recipe.beat) text += state.video ? " Окно «Собрать под музыку» уже настроено — добавь видео и нажми «♪ Собрать»." : " Теперь выбери свои видео — нарезка под музыку настроена.";
  return { text, tools, close };
}

/** Звук образца — в «Мою музыку» и сразу на фон. */
async function takeReferenceMusic(record) {
  const result = record?.result || {};
  const seconds = Math.min(1200, Number(result.features?.meta?.duration) || 0);
  if (!record?.upload_id || !(seconds > 1)) throw new Error("в образце нет звука");
  const entry = await apiJson("/api/sounds/own", {
    body: { upload: record.upload_id, start: 0, end: Math.round(seconds * 1000) / 1000, kind: "music", label: "Музыка из образца" },
  });
  await reloadSounds();
  if (entry?.id) {
    pickMusic(entry.id);
    state.music.duck = 0.6;
    drawMusic();
  }
  return "Музыка из образца — в «Моя музыка» и уже на фоне ролика";
}

/** Своих видео ещё нет: выбрать их (для нарезки — сразу несколько) и сделать «как в образце». */
async function pickVideosForRecipe(record, files) {
  const videos = files.filter((file) => file.type.startsWith("video/") || /\.(mp4|mov|m4v|webm|mkv)$/i.test(file.name));
  if (!videos.length) throw new Error("это не видео");
  if (busyForChange()) return null;
  const [first, ...rest] = videos;
  // Новый ролик «как в образце»: без вопроса «продолжить прошлый монтаж?» — человек начинает заново.
  if (!(await confirmDiscard())) return null;
  pendingAutoTranscribe = state.mode === "simple" && !record?.result?.recipe?.beat;
  const loaded = nextVideoLoad();
  setVideo(first);
  await loaded;
  for (const file of rest) {
    try { await importClip(file); } catch (error) { toast(`«${file.name}» не открылось: ${error?.message || error}`, 4000); }
  }
  if (rest.length) beatDialog.selected = new Set(beatClipList().map((media) => media.key));
  return applyRecipeAll(record);
}

const ACTION_LABELS = {
  tab: { text: "Вкладка «Текст»", style: "Вкладка «Стиль»", tune: "Вкладка «Настройка»", edit: "Вкладка «Монтаж»", fx: "Вкладка «Эффекты»", sound: "Вкладка «Звук»" },
  open: {
    beat: "♪ Собрать под музыку", timeline: "✂ Открыть ленту", lyrics: "✍ Свой текст", projects: "Черновики",
    smartcut: "Найти паузы", moments: "Лучшие моменты", hook: "Хук и описание", translate: "Перевод", music: "Музыка на фон",
    assistant: "Разобрать ролик",
  },
};

function assistantActionLabel(action) {
  if (!action) return "";
  if (ACTION_LABELS[action.do]?.[action.id]) return ACTION_LABELS[action.do][action.id];
  if (action.do === "atmosphere") return `Атмосфера «${ATMOSPHERES.find((item) => item.id === action.id)?.label || action.id}»`;
  if (action.do === "look") return `Цвет «${lookLabel(action.id)}»`;
  if (action.do === "transition") return `Переход «${transitionById(action.id).label}»`;
  if (action.do === "style") return `Стиль «${templateById(action.id)?.label_ru || action.id}»`;
  if (action.do === "preset") return `Монтаж «${presetById(action.id)?.title || action.id}»`;
  return "Открыть";
}

/** Показать блок в «Профи»: вкладка, прокрутка и короткая подсветка. */
function revealBlock(tab, node) {
  applyMode("pro");
  openTab(tab);
  if (!node) return;
  window.setTimeout(() => {
    const block = node.closest(".block") || node;
    block.scrollIntoView({ behavior: "smooth", block: "center" });
    block.classList.add("is-flash");
    window.setTimeout(() => block.classList.remove("is-flash"), 1800);
  }, 80);
}

function needVideo() {
  if (state.video) return true;
  toast("Сначала выбери видео — кнопка «Выбрать видео».", 4000);
  return false;
}

async function runAssistantAction(action) {
  const id = action?.id;
  switch (action?.do) {
    case "tab": applyMode("pro"); openTab(id); return;
    case "atmosphere": applyAtmosphere(id); revealBlock("fx", el.atmoPresets); return;
    case "look": state.fx.look = id; syncFxControls(); onFxChanged(); revealBlock("fx", el.atmoPresets); return;
    case "transition": setTransition(id, { key: null, preview: Boolean(state.video) }); revealBlock("edit", el.transitionGrid); return;
    case "style": if (templateById(id)) { selectStyle(id); applyMode("pro"); openTab("style"); } return;
    case "preset": await applyMontagePreset(id); return;
    case "open":
      if (id === "assistant") { assistant.open("analyse"); return; }
      if (id === "beat") { if (needVideo()) openBeatDialog(); return; }
      if (id === "timeline") { if (needVideo()) setTimelineOpen(true); return; }
      if (id === "lyrics") { if (needVideo()) openLyrics(); return; }
      if (id === "projects") { openProjectsDialog(); return; }
      if (id === "smartcut") { revealBlock("edit", el.smartCutRun); return; }
      if (id === "moments") { revealBlock("edit", el.momentsRun); return; }
      if (id === "hook") { revealBlock("text", el.hookRun); return; }
      if (id === "translate") { revealBlock("text", el.translateBlock); return; }
      if (id === "music") { revealBlock("sound", el.musicChoose); return; }
      return;
    default:
  }
}

function assistantContext() {
  return {
    video: Boolean(state.video), seconds: Math.round(state.duration || 0), text: state.cues.length > 0,
    clips: state.montage.media.size, style: currentTemplate()?.label_ru || state.styleId,
    music: Boolean(state.music.sound), mode: state.mode,
  };
}

const assistant = createAssistant({
  api: (url, options = {}) => apiJson(url, options),
  upload: uploadReference,
  toast,
  studio: {
    context: assistantContext,
    applyStep: applyRecipeStep,
    applyAll: applyRecipeAll,
    takeMusic: takeReferenceMusic,
    pickVideos: pickVideosForRecipe,
    runAction: runAssistantAction,
    actionLabel: assistantActionLabel,
    multiPick: (record) => Boolean(record?.result?.recipe?.beat || ["music_edit", "montage", "voiceover"].includes(record?.result?.features?.kind)),
  },
});

function wireAssistant() {
  el.assistantButton?.addEventListener("click", () => assistant.open());
  el.assistantEmpty?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    assistant.open("analyse");
  });
}

/** Видео, присланное боту: открыть его с сервера, без повторной загрузки. */
async function openServerUpload(uploadId) {
  const info = await requestJson(`/api/uploads/${encodeURIComponent(uploadId)}`, { cache: "no-store" });
  if (state.video && !(await confirmDiscard())) return;
  const source = new RemoteVideo({ name: info.name, size: info.size_bytes, type: info.mime, url: info.url });
  pendingAutoTranscribe = state.mode === "simple";
  const loaded = nextVideoLoad();
  setVideo(source, { url: info.url });
  state.uploadId = info.id;
  state.videoHasAudio = info.has_audio !== false;
  await loaded.catch(() => {});
}

/** Ссылки из бота: ?video=… (видео из чата), ?assistant=… (разбор), ?act=open:beat (действие). */
async function handleDeepLinks() {
  let params;
  try { params = new URLSearchParams(window.location.search); } catch (_) { return; }
  const video = params.get("video");
  const analysis = params.get("assistant");
  const act = params.get("act");
  if (!video && !analysis && !act) return;
  try {
    const url = new URL(window.location.href);
    ["video", "assistant", "act"].forEach((key) => url.searchParams.delete(key));
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  } catch (_) { /* адрес не поменять — не страшно */ }
  await manifestReady;
  if (video && /^[0-9a-f]{32}$/.test(video)) {
    try {
      await openServerUpload(video);
    } catch (error) {
      toast(`Видео из чата не открылось: ${error?.message || error}`, 6000);
    }
  }
  if (analysis && /^[0-9a-f]{32}$/.test(analysis)) void assistant.openAnalysis(analysis);
  if (act && /^[a-z]+:[a-z0-9-]+$/.test(act)) {
    const [kind, id] = act.split(":");
    window.setTimeout(() => { void runAssistantAction({ do: kind, id }); }, 300);
  }
}

function initialise() {
  if (!hasWebCodecs() && !server.active) el.browserWarning.hidden = false;
  settings(TYPEWRITER_ID);
  wireEvents();
  wireUndo();
  setupSpeechLanguages();
  wireSafeZones();
  wirePresets();
  drawPresets();
  drawStyles();
  syncTune();
  drawSoundPanel();
  document.querySelectorAll('input[type="range"]').forEach(setRangeFill);
  fitScreen();
  void ensureTypewriterFont().catch(() => {});
  void loadSounds();
  manifestReady = loadManifest();
  void loadAiSettings();
  void loadProjectList();
  drawTransitionPanel();
  syncFxControls();
  wireSignature();
  drawSignatureControls();
  applyMode(loadMode(), { save: false });
  wireAssistant();
  drawSafeOverlay();
  drawSafeNote();
  updateUi();
  void handleDeepLinks();
}

// Крючок для автоматической проверки студии (тот же интерфейс, без отдельного API).
window.__readyCaptions = { state, buildSpec, selectStyle, applyMontagePreset, exportVideo, transcribeVideo, rebuildPreview, seekTo, openTab, player, stylePreview, setVideo, setSubtitles, runPictures, loadAiSettings, composer, composeElements,
  montage, montagePlayer, timeline, setTimelineOpen, addClip, seekM, seekO, timelineAction, selectInTimeline, coverSource, revealSource, commitEdge, commitMove, undoEdit, redoEdit, drawFrame,
  perfStart, perfReport, server, project, projectData, saveProjectNow, resumeProject, loadProjectList, openPickedVideo,
  setTransition, previewTransition, fxSpec, transitionFrames, onEditChanged,
  pickMusic, reloadSounds, videoBeats, openBeatDialog, fitToBeats, setClipSpeed,
  assistant, applyRecipeAll, applyRecipeStep, handleDeepLinks, beatDialog, addClips, openPickedVideos,
  applyLyricTaps: (lines, starts, finish) => applyLyrics(lyricsFromTaps(lines, starts, finish), lines, "") };

// Серверный режим (Telegram): сначала вход, потом студия — иначе первые запросы уйдут без сессии.
async function boot() {
  try {
    await startServerMode();
  } catch (error) {
    if (String(error?.message) === "outside-telegram") return;
    console.error(error);
    const gate = document.querySelector("#tgGate");
    if (gate && server.active) {
      gate.querySelector("h2").textContent = "Не получилось войти";
      gate.querySelector("p").textContent = `${error?.message || error}. Закрой студию и открой её из бота ещё раз.`;
      gate.hidden = false;
      return;
    }
  }
  if (server.active) setupServerUi();
  initialise();
}
void boot();
