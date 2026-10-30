// Звуки к субтитрам: четыре слоя, у каждого свой звук и громкость, и музыка на фон.
//
//   typing  — удар на каждую появившуюся букву (печать, клавиатура, iPhone);
//   word    — короткий звук, когда звучит очередное слово;
//   phrase  — переход, когда на экране появляется новая фраза;
//   accent  — отдельный звук на ключевое слово;
//   music   — фоновая музыка: плавно входит, приглушается под голос, уходит в конце.
//
// Библиотека общая: любой звук можно поставить на любой слой. У звука есть
// «роль» — для чего он сделан; если он стоит на другом слое, громкость
// выравнивается под этот слой. Свои звуки пользователя (загруженные или
// вырезанные из видео) приходят с сервера и лежат в той же библиотеке.
//
// Одни и те же события звучат в предпросмотре и попадают в готовый MP4:
// раскладка детерминирована (одинаковое зерно случайности), а цепочка
// громкость → компрессор одинакова в AudioContext и OfflineAudioContext.

const MANIFEST_URL = "/sounds/sfx/manifest.json";
// Свои звуки пользователя (data/sounds/own на сервере).
const OWN_URL = "/api/sounds/own";
// Какие звуки пользователь убрал на доске прослушивания (файл пишет сервер).
const CURATION_URL = "/sounds/sfx/curation.json";
const SAMPLE_RATE = 48000;
// Готовая дорожка звуков — стерео: пролёты и хвосты зала слышны так же, как в предпросмотре.
const TRACK_CHANNELS = 2;
// Громкость звука в своей роли (как её выровняла сборка библиотеки).
const DEFAULT_TARGETS = { typing: -21, word: -18, phrase: -17, accent: -15, cut: -17 };
// Длинный звук на частом слое не копится: следующий удар плавно гасит предыдущий.
const CHOKE_AFTER = { typing: 0.2, word: 0.35 };

/**
 * Слои звуков. suggest — звуки слоя, если у стиля нет своих; fallback — что
 * звучит на слое по умолчанию; independent — слой не входит в наборы стиля
 * (набор его не меняет и не учитывает при сравнении).
 */
export const SOUND_LAYERS = [
  { id: "typing", label: "Печать букв", hint: "На каждую появившуюся букву", moments: "letters" },
  { id: "word", label: "Слово", hint: "Когда звучит очередное слово", moments: "words" },
  { id: "phrase", label: "Новая фраза", hint: "Когда на экране меняется фраза", moments: "phrases" },
  { id: "accent", label: "Ключевое слово", hint: "На слова, выделенные цветом", moments: "keywords" },
  {
    id: "cut",
    label: "Склейки и вставки",
    hint: "Вжух, когда начинается и заканчивается вставка или видео поверх, и на твоих склейках",
    moments: "cuts",
    suggest: ["fs_whoosh", "fs_quick_whoosh", "fs_swoosh", "fs_double_whoosh", "cloth", "fs_space_swoosh", "riser"],
    fallback: ["fs_whoosh", 0.45],
    independent: true,
  },
];

/** Музыка на фон: громкость, насколько приглушать под голос, с какого места трека. */
export const MUSIC_DEFAULTS = { sound: "", volume: 0.35, duck: 0.6, trackStart: 0, start: 0, fadeIn: 0.8, fadeOut: 1.6, loop: true };
const DUCK_ATTACK = 0.15;
const DUCK_RELEASE = 0.45;
const DUCK_MAX_DB = 14;

const MIN_GAP = { typing: null, word: 0.075, phrase: 0.3, accent: 0.2, cut: 0.5 };

let manifestPromise = null;
const bufferCache = new Map();
let ownUrl = OWN_URL;

/** Откуда брать свои звуки: сборка на сервере берёт их по ключу задания (у неё нет сессии). */
export function setOwnSoundsUrl(url) {
  ownUrl = url || OWN_URL;
  manifestPromise = null;
}

async function fetchOwnSounds() {
  try {
    const response = await fetch(ownUrl, { cache: "no-store", credentials: "same-origin" });
    if (!response.ok) return [];
    const data = await response.json();
    return Array.isArray(data?.sounds) ? data.sounds : [];
  } catch (_) {
    return [];
  }
}

/** Свой звук пользователя в виде записи библиотеки. */
function ownEntry(item) {
  const music = item.kind === "music";
  return {
    id: String(item.id),
    label: String(item.label || "Мой звук"),
    group: music ? "music" : "word",
    category: "mine",
    kind: music ? "music" : "sfx",
    files: Array.isArray(item.files) ? item.files : [],
    seconds: Number(item.seconds) || 0,
    gain_db: Number(item.gain_db) || 0,
    pitch_spread: 0,
    moods: [],
    stereo: Number(item.channels) === 2,
    source: item.origin?.name ? `Мой звук · ${item.origin.name}` : "Мой звук",
    mine: true,
    created: item.created || 0,
  };
}

async function mergeOwnSounds(manifest) {
  const own = await fetchOwnSounds();
  manifest.sounds = manifest.sounds.filter((sound) => !sound.mine).concat(own.map(ownEntry));
  return manifest;
}

export function loadSoundManifest() {
  if (!manifestPromise) {
    manifestPromise = (async () => {
      const response = await fetch(MANIFEST_URL, { cache: "no-store" });
      if (!response.ok) throw new Error(`Не удалось загрузить библиотеку звуков (${response.status}).`);
      return mergeOwnSounds(await response.json());
    })().catch((error) => {
      manifestPromise = null;
      throw error;
    });
  }
  return manifestPromise;
}

/** Перечитать свои звуки (после загрузки, переименования, удаления). */
export async function reloadOwnSounds() {
  const manifest = await loadSoundManifest();
  await mergeOwnSounds(manifest);
  for (const key of [...bufferCache.keys()]) {
    const id = key.split("@")[0];
    if (!manifest.sounds.some((sound) => sound.id === id)) bufferCache.delete(key);
  }
  return manifest;
}

/** Звук, которого больше нет в библиотеке, заменяется ближайшим оставшимся. */
export function resolveSoundId(manifest, id) {
  if (!id) return "";
  if (manifest?.sounds?.some((sound) => sound.id === id)) return id;
  return manifest?.aliases?.[id] || id;
}

export async function soundById(id) {
  const manifest = await loadSoundManifest();
  const real = resolveSoundId(manifest, id);
  return manifest.sounds.find((sound) => sound.id === real) || null;
}

let curation = null;

/** Убранные пользователем звуки: { removed: Set }. Без файла — ничего не убрано. */
export async function loadSoundCuration() {
  if (curation) return curation;
  try {
    const response = await fetch(CURATION_URL, { cache: "no-store" });
    const data = response.ok ? await response.json() : {};
    curation = { removed: new Set(Array.isArray(data.removed) ? data.removed : []) };
  } catch (_) {
    curation = { removed: new Set() };
  }
  return curation;
}

export function setSoundCuration(removed) {
  curation = { removed: new Set(removed) };
  return curation;
}

/** Набор звуков стиля: подходящие звуки по слоям и готовые наборы. */
export function styleSounds(manifest, styleId) {
  const styles = manifest?.styles || {};
  return styles[styleId] || styles.custom || null;
}

/**
 * Готовый набор → настройки слоёв. Если пользователь убрал звук из набора,
 * его место занимает следующий подходящий звук стиля для того же слоя.
 * Музыку набор не трогает — она выбирается отдельно.
 */
export function kitSettings(manifest, styleId, kit, removed = new Set(), music = null) {
  const set = styleSounds(manifest, styleId);
  const layers = {};
  for (const layer of SOUND_LAYERS) {
    const [sound, volume] = kit?.layers?.[layer.id] || layer.fallback || ["", 0.5];
    let chosen = sound;
    if (chosen && removed.has(chosen)) {
      chosen = (set?.sounds?.[layer.id] || []).find((id) => !removed.has(id) && id !== sound) || "";
    }
    layers[layer.id] = { sound: chosen, volume: Number(volume) || 0.5 };
  }
  const result = { layers };
  if (music) result.music = { ...music };
  return result;
}

/** Совпадают ли настройки слоёв с готовым набором (для подсветки выбранного). */
export function sameSound(a, b) {
  return SOUND_LAYERS.filter((layer) => !layer.independent).every(({ id }) => {
    const x = a?.layers?.[id] || {};
    const y = b?.layers?.[id] || {};
    const xs = x.sound && Number(x.volume) > 0 ? x.sound : "";
    const ys = y.sound && Number(y.volume) > 0 ? y.sound : "";
    return xs === ys && (!xs || Math.abs(Number(x.volume) - Number(y.volume)) < 0.005);
  });
}

/** Декодированные варианты звука (кэшируются на частоту дискретизации). */
export async function loadSoundBuffers(id, context) {
  const sound = await soundById(id);
  if (!sound) throw new Error(`Звук «${id}» не найден.`);
  const key = `${sound.id}@${context.sampleRate}`;
  if (!bufferCache.has(key)) {
    bufferCache.set(key, Promise.all(sound.files.map(async (file) => {
      const response = await fetch(file, { credentials: "same-origin" });
      if (!response.ok) throw new Error(`Не удалось загрузить звук ${file}.`);
      return context.decodeAudioData(await response.arrayBuffer());
    })).catch((error) => {
      bufferCache.delete(key);
      throw error;
    }));
  }
  return bufferCache.get(key);
}

/** Включён ли хоть один слой звуков (без музыки). */
export function hasActiveSound(settings) {
  return SOUND_LAYERS.some(({ id }) => {
    const layer = settings?.layers?.[id];
    return Boolean(layer?.sound) && Number(layer.volume) > 0;
  });
}

export function hasMusic(settings) {
  const music = settings?.music;
  return Boolean(music?.sound) && Number(music.volume) > 0;
}

/** Нужна ли ролику дорожка звуков: слои или музыка. */
export function hasAnyAudio(settings) {
  return hasActiveSound(settings) || hasMusic(settings);
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * События звука для всех включённых слоёв. Удары печати никогда не идут чаще,
 * чем естественно звучит выбранная клавиатура, — без «пулемёта».
 */
export async function planSoundEvents(moments, settings, { seed = 547 } = {}) {
  const manifest = await loadSoundManifest();
  const targets = { ...DEFAULT_TARGETS, ...(manifest.targets || {}) };
  const events = [];
  SOUND_LAYERS.forEach((layer, layerIndex) => {
    const config = settings?.layers?.[layer.id];
    if (!config?.sound || !(Number(config.volume) > 0)) return;
    const realId = resolveSoundId(manifest, config.sound);
    const sound = manifest.sounds.find((item) => item.id === realId);
    if (!sound || !sound.files?.length || sound.kind === "music") return;
    const random = mulberry32(seed + layerIndex * 7919);
    // Звук другой роли звучит на этом слое так же громко, как родные звуки слоя.
    const role = targets[sound.group] !== undefined ? sound.group : layer.id;
    const level = 10 ** (((targets[layer.id] ?? 0) - (targets[role] ?? 0) + (Number(sound.gain_db) || 0)) / 20);
    const choke = Number(sound.seconds) > (CHOKE_AFTER[layer.id] ?? Infinity);
    const natural = Number(sound.natural_interval_ms) || 60;
    const gap = MIN_GAP[layer.id] ?? Math.max(0.055, (natural * 0.9) / 1000);
    const spread = Number(sound.pitch_spread ?? 0.03);
    let last = -Infinity;
    let previous = -1;
    for (const moment of moments?.[layer.moments] || []) {
      if (!Number.isFinite(moment.time) || moment.time < 0) continue;
      if (moment.time - last < gap) continue;
      let sample = Math.floor(random() * sound.files.length);
      if (sample === previous && sound.files.length > 1) sample = (sample + 1) % sound.files.length;
      previous = sample;
      const strong = layer.id !== "typing" || moment.wordStart;
      const gain = (strong ? 0.92 + random() * 0.08 : 0.68 + random() * 0.24) * level;
      const rate = 1 - spread + random() * spread * 2;
      events.push({ layer: layer.id, sound: sound.id, time: Math.max(0, moment.time + Number(sound.offset || 0)), sample, gain, rate, choke });
      last = moment.time;
    }
  });
  events.sort((a, b) => a.time - b.time);
  return events;
}

/**
 * План музыки: где звучит голос (по словам), чтобы приглушать музыку под
 * речь. Время — то же, что у моментов (в готовом ролике — после склеек).
 */
export function planMusic(moments, settings, end = 0, duck = []) {
  const music = { ...MUSIC_DEFAULTS, ...(settings?.music || {}) };
  if (!music.sound || !(Number(music.volume) > 0)) return null;
  return { ...music, speech: speechIntervals(moments, duck), end: Number(end) || 0 };
}

/**
 * Где звучит голос (по словам) и вставки со своим звуком — время готового
 * ролика. Под эти места музыка и звуки с ленты становятся тише.
 */
export function speechIntervals(moments, duck = []) {
  const words = (moments?.words || []).map((word) => Number(word.time)).filter(Number.isFinite).sort((a, b) => a - b);
  const intervals = [];
  words.forEach((start, index) => {
    const next = index + 1 < words.length ? words[index + 1] : start + 0.6;
    intervals.push([start, Math.min(next, start + 0.6)]);
  });
  // Вставки со своим звуком (время ролика): под ними музыка тоже уходит вниз.
  for (const range of duck || []) {
    const a = Number(range?.[0]);
    const b = Number(range?.[1]);
    if (Number.isFinite(a) && Number.isFinite(b) && b > a) intervals.push([a, b]);
  }
  intervals.sort((x, y) => x[0] - y[0]);
  const speech = [];
  for (const [start, stop] of intervals) {
    const last = speech[speech.length - 1];
    if (last && start - last[1] < 0.4) last[1] = Math.max(last[1], stop);
    else speech.push([start, stop]);
  }
  return speech;
}

/** Огибающая музыки: вход, уход в конце и приглушение под голос — с шагом 25 мс. */
export function musicCurve(plan, from, to, step = 0.025) {
  const count = Math.max(2, Math.ceil((to - from) / step) + 1);
  const values = new Float32Array(count);
  const duck = Math.max(0, Math.min(1, Number(plan.duck) || 0));
  const duckGain = 10 ** ((-DUCK_MAX_DB * duck) / 20);
  const start = Number(plan.start) || 0;
  const fadeIn = Math.max(0, Number(plan.fadeIn) || 0);
  const fadeOut = Math.max(0, Number(plan.fadeOut) || 0);
  const speech = plan.speech || [];
  let first = 0;
  for (let i = 0; i < count; i += 1) {
    const t = from + ((to - from) * i) / (count - 1);
    let g = 1;
    if (t < start) g = 0;
    else if (fadeIn > 0 && t < start + fadeIn) g = (t - start) / fadeIn;
    if (plan.end > 0 && fadeOut > 0 && t > plan.end - fadeOut) g *= Math.max(0, (plan.end - t) / fadeOut);
    if (duck > 0) {
      while (first < speech.length && speech[first][1] + DUCK_RELEASE < t) first += 1;
      let level = 1;
      for (let j = first; j < speech.length && speech[j][0] - DUCK_ATTACK <= t; j += 1) {
        const [a, b] = speech[j];
        let weight = 1;
        if (t < a) weight = 1 - (a - t) / DUCK_ATTACK;
        else if (t > b) weight = 1 - (t - b) / DUCK_RELEASE;
        weight = Math.max(0, Math.min(1, weight));
        level = Math.min(level, 1 - weight * (1 - duckGain));
      }
      g *= level;
    }
    values[i] = g;
  }
  return values;
}

/** Цепочка: слой → громкость слоя → общий компрессор → выход; музыка — мимо компрессора. */
function buildGraph(context, settings) {
  const compressor = context.createDynamicsCompressor();
  compressor.threshold.value = -10;
  compressor.knee.value = 8;
  compressor.ratio.value = 4;
  compressor.attack.value = 0.002;
  compressor.release.value = 0.12;
  compressor.connect(context.destination);
  const gains = {};
  for (const { id } of SOUND_LAYERS) {
    const gain = context.createGain();
    gain.gain.value = Math.max(0, Number(settings?.layers?.[id]?.volume ?? 0));
    gain.connect(compressor);
    gains[id] = gain;
  }
  const music = context.createGain();
  music.gain.value = Math.max(0, Number(settings?.music?.volume ?? 0));
  music.connect(context.destination);
  // Музыка и звуки с ленты: своя громкость у каждого, мимо компрессора, как музыка.
  const clips = context.createGain();
  clips.gain.value = 1;
  clips.connect(context.destination);
  return { compressor, gains, music, clips };
}

async function loadAllBuffers(events, context) {
  const ids = [...new Set(events.map((event) => event.sound))];
  const entries = await Promise.all(ids.map(async (id) => [id, await loadSoundBuffers(id, context)]));
  return new Map(entries);
}

function scheduleEvent(context, destination, buffers, event, when, offset = 0) {
  const buffer = buffers.get(event.sound)?.[event.sample];
  if (!buffer) return null;
  if (offset >= buffer.duration) return null;
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.playbackRate.value = event.rate;
  const gain = context.createGain();
  gain.gain.value = event.gain;
  source.connect(gain).connect(destination);
  const at = Math.max(context.currentTime, when);
  source.start(at, Math.max(0, offset));
  // Для мягкого перезапуска: какой это звук и когда он начинает звучать.
  source.reelEvent = event;
  source.reelStart = at;
  return { source, gain };
}

/**
 * Все события с момента fromTime; длинные звуки частых слоёв гасят предыдущий
 * удар. late — насколько опоздавший звук (уже должен был начаться) ещё
 * запускается с середины; skip — события, которые уже звучат.
 */
function scheduleEvents(context, gains, buffers, events, { startAt, fromTime = 0, rate = 1, nodes = null, late = 0, skip = null }) {
  const lastByLayer = {};
  for (const event of events) {
    if (event.time < fromTime - 0.004 - late) continue;
    if (skip?.has(event)) continue;
    const when = startAt + (event.time - fromTime) / rate;
    const offset = when < startAt ? (startAt - when) * (event.rate || 1) : 0;
    const voice = scheduleEvent(context, gains[event.layer], buffers, event, Math.max(when, startAt), offset);
    if (!voice) continue;
    const previous = lastByLayer[event.layer];
    if (event.choke && previous) {
      const at = Math.max(context.currentTime, when);
      previous.gain.gain.setTargetAtTime(0, at, 0.012);
      try { previous.source.stop(at + 0.12); } catch (_) { /* уже остановлен */ }
    }
    lastByLayer[event.layer] = voice;
    nodes?.push(voice.source);
  }
}

/**
 * Музыка с позиции `from` (время ролика) до `until`. Трек играет с места
 * trackStart, по кругу, если он короче ролика.
 */
function scheduleMusic(context, destination, buffer, sound, plan, { startAt, from, until, rate = 1 }) {
  const start = Number(plan.start) || 0;
  const begin = Math.max(from, start);
  if (!buffer || begin >= until - 0.05) return null;
  const position = (Number(plan.trackStart) || 0) + (begin - start);
  if (!plan.loop && position >= buffer.duration) return null;
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.playbackRate.value = rate;
  if (plan.loop) {
    source.loop = true;
    source.loopStart = 0;
    source.loopEnd = buffer.duration;
  }
  const envelope = context.createGain();
  const level = context.createGain();
  level.gain.value = 10 ** ((Number(sound?.gain_db) || 0) / 20);
  source.connect(envelope).connect(level).connect(destination);
  const when = Math.max(context.currentTime, startAt + (begin - from) / rate);
  const curve = musicCurve(plan, begin, until);
  envelope.gain.value = curve[0];
  envelope.gain.setValueCurveAtTime(curve, when, Math.max(0.05, (until - begin) / rate));
  source.start(when, position % buffer.duration);
  source.stop(when + (until - begin) / rate + 0.05);
  return source;
}

// ---------------------------------------------------------------------------
// Музыка и звуки, положенные на ленту монтажа (время готового ролика).

const clipCache = new Map();

/** Звук с ленты, декодированный для этого AudioContext (кэш по адресу файла). */
export function loadClipBuffer(url, context) {
  const key = `${url}@${context.sampleRate}`;
  if (!clipCache.has(key)) {
    clipCache.set(key, (async () => {
      const response = await fetch(url, { credentials: "same-origin" });
      if (!response.ok) throw new Error(`Не удалось загрузить звук (${response.status}).`);
      return context.decodeAudioData(await response.arrayBuffer());
    })().catch((error) => {
      clipCache.delete(key);
      throw error;
    }));
  }
  return clipCache.get(key);
}

/** Очертание звука для ленты: n пиков от 0 до 1. */
export function clipPeaks(buffer, n = 1600) {
  const data = buffer.getChannelData(0);
  const step = Math.max(1, data.length / n);
  const values = new Array(n);
  let top = 0;
  for (let i = 0; i < n; i += 1) {
    let peak = 0;
    const a = Math.floor(i * step);
    const b = Math.min(data.length, Math.floor((i + 1) * step));
    for (let j = a; j < b; j += 4) {
      const v = Math.abs(data[j]);
      if (v > peak) peak = v;
    }
    values[i] = peak;
    if (peak > top) top = peak;
  }
  return { values: values.map((value) => (top > 0 ? value / top : 0)), duration: buffer.duration };
}

/**
 * Один звук с ленты: с места from (время ролика). clip — { o, in, out,
 * volume, duck, fade }; speech — где звучит голос (для приглушения).
 */
function scheduleClip(context, destination, buffer, clip, speech, { startAt, from, rate = 1, until = Infinity }) {
  const length = Math.max(0, Number(clip.out) - Number(clip.in));
  const o0 = Number(clip.o) || 0;
  const o1 = Math.min(o0 + length, until);
  const begin = Math.max(from, o0);
  if (!buffer || begin >= o1 - 0.02) return null;
  const position = Number(clip.in) + (begin - o0);
  if (position >= buffer.duration) return null;
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.playbackRate.value = rate;
  const envelope = context.createGain();
  const level = context.createGain();
  level.gain.value = Math.max(0, Number(clip.volume ?? 1));
  source.connect(envelope).connect(level).connect(destination);
  const when = Math.max(context.currentTime, startAt + (begin - from) / rate);
  // Мягкие края (без щелчков), приглушение под голос — та же огибающая, что у музыки.
  const plan = {
    duck: clip.duck ? 0.6 : 0,
    start: o0,
    fadeIn: clip.fade ? 0.6 : 0.015,
    end: o1,
    fadeOut: clip.fade ? 1.2 : 0.03,
    speech: speech || [],
  };
  const curve = musicCurve(plan, begin, o1);
  envelope.gain.value = curve[0];
  envelope.gain.setValueCurveAtTime(curve, when, Math.max(0.05, (o1 - begin) / rate));
  source.start(when, position, Math.max(0.02, o1 - begin));
  return source;
}

/** Все звуки с ленты с места from. */
function scheduleClips(context, destination, buffers, clips, speech, options) {
  const nodes = [];
  for (const clip of clips || []) {
    const node = scheduleClip(context, destination, buffers.get(clip.url), clip, speech, options);
    if (node) nodes.push(node);
  }
  return nodes;
}

async function loadClipBuffers(clips, context) {
  const urls = [...new Set((clips || []).map((clip) => clip.url).filter(Boolean))];
  const entries = await Promise.all(urls.map(async (url) => [url, await loadClipBuffer(url, context).catch(() => null)]));
  return new Map(entries);
}

/**
 * Проигрыватель для предпросмотра: звуки идут вместе с видео, громкость
 * слоёв меняется сразу, без перезапуска.
 */
export class SoundPlayer {
  constructor() {
    this.context = null;
    this.graph = null;
    this.nodes = [];
    this.auditionNodes = [];
    this.auditionGraph = null;
    this.settings = null;
    this.playToken = 0;
  }

  ensureContext() {
    if (!this.context) {
      this.context = new AudioContext({ sampleRate: SAMPLE_RATE });
      this.graph = buildGraph(this.context, this.settings);
    }
    return this.context;
  }

  async resume() {
    const context = this.ensureContext();
    if (context.state !== "running") await context.resume();
    return context;
  }

  setSettings(settings) {
    this.settings = settings;
    if (!this.graph) return;
    for (const { id } of SOUND_LAYERS) {
      const value = Math.max(0, Number(settings?.layers?.[id]?.volume ?? 0));
      this.graph.gains[id].gain.setTargetAtTime(value, this.context.currentTime, 0.015);
    }
    const music = Math.max(0, Number(settings?.music?.volume ?? 0));
    this.graph.music.gain.setTargetAtTime(music, this.context.currentTime, 0.03);
  }

  /**
   * Запускает события с момента `fromTime` секунд ролика. `music` — план
   * музыки и позиция в готовом ролике ({ plan, from, until }).
   */
  /**
   * soft — перезапуск после перехода (склейка, начало вставки): звуки, которые
   * уже звучат, доигрывают, а звук, который должен был начаться только что,
   * запускается с середины. Так «вжух» на границе вставки не обрывается.
   */
  /**
   * clips — звуки с ленты: { list, from, until, speech } во времени ролика.
   * Музыка и звуки с ленты идут по времени готового ролика, которое на
   * склейке не прыгает: при мягком перезапуске они не обрываются, если не
   * разошлись с видео больше чем на 0,15 с.
   */
  async play(events, fromTime = 0, rate = 1, music = null, { soft = false, clips = null } = {}) {
    const playing = soft ? this.release() : (this.stop(), new Set());
    this.stopAudition();
    const token = ++this.playToken;
    const context = await this.resume();
    const fromO = music?.from ?? clips?.from ?? fromTime;
    const signature = JSON.stringify([music?.plan?.sound, music?.plan?.volume, music?.plan?.duck, (clips?.list || []).map((clip) => [clip.url, clip.o, clip.in, clip.out, clip.volume, clip.duck, clip.fade]), rate]);
    const keep = soft && this.continuous && this.continuous.signature === signature
      && Math.abs(context.currentTime - (this.continuous.ctxTime + (fromO - this.continuous.o) / rate)) < 0.15;
    if (!keep) this.stopContinuous();
    const [buffers, musicBuffers, clipBuffers] = await Promise.all([
      loadAllBuffers(events, context),
      !keep && music?.plan?.sound ? loadSoundBuffers(music.plan.sound, context).catch(() => null) : null,
      !keep && clips?.list?.length ? loadClipBuffers(clips.list, context) : null,
    ]);
    if (token !== this.playToken) return; // пока грузилось, видео уже остановили
    const startAt = context.currentTime + 0.04;
    scheduleEvents(context, this.graph.gains, buffers, events, { startAt, fromTime, rate, nodes: this.nodes, late: soft ? 0.12 : 0, skip: playing });
    if (keep) return;
    const nodes = [];
    if (musicBuffers?.[0]) {
      const sound = await soundById(music.plan.sound);
      if (token !== this.playToken) return;
      const node = scheduleMusic(context, this.graph.music, musicBuffers[0], sound, music.plan,
        { startAt, from: music.from ?? fromTime, until: music.until ?? music.plan.end ?? 0, rate });
      if (node) nodes.push(node);
    }
    if (clipBuffers) {
      nodes.push(...scheduleClips(context, this.graph.clips, clipBuffers, clips.list, clips.speech,
        { startAt, from: clips.from ?? fromO, until: clips.until ?? Infinity, rate }));
    }
    this.continuous = { nodes, signature, ctxTime: startAt, o: fromO };
  }

  stopContinuous() {
    for (const node of this.continuous?.nodes || []) {
      try { node.stop(); } catch (_) { /* уже отзвучал */ }
    }
    this.continuous = null;
  }

  /** Гасит будущие звуки и музыку, уже звучащие звуки доигрывают. Возвращает их события. */
  release() {
    this.playToken += 1;
    const now = this.context?.currentTime ?? 0;
    const playing = new Set();
    this.tail = (this.tail || []).filter((node) => node.reelStart + (node.buffer?.duration || 0) > now);
    for (const node of this.nodes) {
      if (node.reelEvent && node.reelStart <= now + 0.005) {
        playing.add(node.reelEvent);
        this.tail.push(node);
        continue;
      }
      try { node.stop(); } catch (_) { /* уже отзвучал */ }
    }
    for (const node of this.tail) playing.add(node.reelEvent);
    this.nodes = [];
    return playing;
  }

  stop() {
    this.playToken += 1;
    for (const node of [...this.nodes, ...(this.tail || [])]) {
      try { node.stop(); } catch (_) { /* уже отзвучал */ }
    }
    this.nodes = [];
    this.tail = [];
    this.stopContinuous();
  }

  /** Короткий образец звука для кнопки «Послушать». */
  async audition(soundId, layerId, volume) {
    if (!soundId) return;
    this.stopAudition();
    const context = await this.resume();
    const sound = await soundById(soundId);
    if (!sound) return;
    const buffers = new Map([[sound.id, await loadSoundBuffers(sound.id, context)]]);
    const gain = context.createGain();
    gain.gain.value = Math.max(0, Number(volume));
    gain.connect(this.graph.compressor);
    const level = 10 ** ((Number(sound.gain_db) || 0) / 20);
    const long = Number(sound.seconds) > 0.6;
    let times = [0];
    if (sound.kind === "music") times = [0];
    else if (layerId === "typing" && !long) times = demoTypingTimes();
    else if (layerId === "word" && !long) times = [0, 0.32, 0.6, 0.95];
    const random = mulberry32(11);
    const count = buffers.get(sound.id).length;
    times.forEach((time, index) => {
      const spread = Number(sound.pitch_spread ?? 0.03);
      const event = { sound: sound.id, sample: index % count, gain: (0.85 + random() * 0.15) * level, rate: 1 - spread + random() * spread * 2 };
      const voice = scheduleEvent(context, gain, buffers, event, context.currentTime + 0.03 + time);
      if (voice) {
        // Музыку слушаем кусочком: 12 секунд с плавным уходом.
        if (sound.kind === "music") {
          const end = context.currentTime + 12;
          voice.gain.gain.setValueAtTime(event.gain, end - 1.5);
          voice.gain.gain.linearRampToValueAtTime(0, end);
          voice.source.stop(end + 0.05);
        }
        this.auditionNodes.push(voice.source);
      }
    });
  }

  /**
   * Как звучит набор целиком: несколько слов, смена фразы и ключевое слово —
   * те же правила раскладки, что и в ролике.
   */
  async auditionKit(settings) {
    this.stopAudition();
    if (!hasActiveSound(settings)) return;
    const context = await this.resume();
    const events = await planSoundEvents(demoMoments(), settings, { seed: 91 });
    if (!events.length) return;
    const buffers = await loadAllBuffers(events, context);
    const graph = buildGraph(context, settings);
    graph.music.disconnect();
    scheduleEvents(context, graph.gains, buffers, events, { startAt: context.currentTime + 0.05, nodes: this.auditionNodes });
    this.auditionGraph = graph;
  }

  stopAudition() {
    for (const node of this.auditionNodes || []) {
      try { node.stop(); } catch (_) { /* уже отзвучал */ }
    }
    this.auditionNodes = [];
    if (this.auditionGraph) {
      const old = this.auditionGraph;
      this.auditionGraph = null;
      window.setTimeout(() => { try { old.compressor.disconnect(); } catch (_) { /* отключён */ } }, 3000);
    }
  }
}

/** Пример фразы для прослушивания набора: «Это пример того, как звучит набор». */
function demoMoments() {
  const words = [];
  const letters = [];
  const keywords = [];
  const phrases = [{ time: 0.25 }, { time: 2.05 }];
  const plan = [["Это", 0.3], ["пример", 0.62], ["того,", 1.05], ["как", 1.4], ["звучит", 2.1], ["набор", 2.5]];
  for (const [word, start] of plan) {
    words.push({ time: start });
    for (let i = 0; i < word.length; i += 1) letters.push({ time: start + i / 16, wordStart: i === 0 });
  }
  keywords.push({ time: 2.5 });
  return { words, letters, phrases, keywords };
}

function demoTypingTimes() {
  const times = [];
  let time = 0;
  for (const word of ["Пример", "печати", "под", "голос"]) {
    for (let i = 0; i < word.length; i += 1) {
      times.push(time);
      time += 1 / 15;
    }
    time += 0.2;
  }
  return times;
}

export function encodeWav(buffer) {
  const channels = buffer.numberOfChannels;
  const length = buffer.length;
  const rate = buffer.sampleRate;
  const bytes = 44 + length * channels * 2;
  const view = new DataView(new ArrayBuffer(bytes));
  const write = (offset, text) => { for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i)); };
  write(0, "RIFF");
  view.setUint32(4, bytes - 8, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, length * channels * 2, true);
  const data = [];
  for (let c = 0; c < channels; c += 1) data.push(buffer.getChannelData(c));
  let offset = 44;
  for (let i = 0; i < length; i += 1) {
    for (let c = 0; c < channels; c += 1) {
      const sample = Math.max(-1, Math.min(1, data[c][i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([view.buffer], { type: "audio/wav" });
}

/** Дорожка звуков для готового MP4 — те же события и та же музыка, что в предпросмотре. */
export async function renderSoundTrack(events, settings, durationSeconds, musicPlan = null, clipPlan = null) {
  const length = Math.max(1, Math.ceil((durationSeconds + 0.6) * SAMPLE_RATE));
  const context = new OfflineAudioContext(TRACK_CHANNELS, length, SAMPLE_RATE);
  const graph = buildGraph(context, settings);
  const [buffers, musicBuffers, clipBuffers] = await Promise.all([
    loadAllBuffers(events, context),
    musicPlan?.sound ? loadSoundBuffers(musicPlan.sound, context) : null,
    clipPlan?.list?.length ? loadClipBuffers(clipPlan.list, context) : null,
  ]);
  scheduleEvents(context, graph.gains, buffers, events, { startAt: 0 });
  if (clipBuffers) scheduleClips(context, graph.clips, clipBuffers, clipPlan.list, clipPlan.speech, { startAt: 0, from: 0, until: durationSeconds });
  if (musicBuffers?.[0]) {
    const sound = await soundById(musicPlan.sound);
    scheduleMusic(context, graph.music, musicBuffers[0], sound, { ...musicPlan, end: musicPlan.end || durationSeconds },
      { startAt: 0, from: 0, until: durationSeconds });
  }
  return encodeWav(await context.startRendering());
}
