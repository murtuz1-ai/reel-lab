// Ритм музыки: доли (биты), сильные доли (начало такта) и громкость по ходу трека.
// Нужен для склеек в бит и «Собери под музыку».
//
// Как считается (классика: Ellis 2007, как в librosa):
//   1) звук → моно 22 050 Гц;
//   2) спектр кусками по 1024 отсчёта с шагом 256 (≈11.6 мс);
//   3) «вспышки» звука: насколько выросла громкость в полосах частот (spectral flux);
//   4) темп — автокорреляция вспышек (60…200 ударов в минуту, ближе к 120 — вероятнее);
//   5) доли — динамическое программирование: удары там, где вспышки, с шагом около темпа;
//   6) сильная доля — каждая 4-я, фаза такта — где сильнее бас (бочка).
//
// Ядро analyseSamples() без DOM — проверяется в Node. В браузере analyseAudioBuffer()
// сводит звук в моно 22 050 Гц через OfflineAudioContext.

export const BEAT_RATE = 22050;
const FRAME = 1024;
const HOP = 256;
const BANDS = 40;
const MAX_SECONDS = 360;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** Быстрое преобразование Фурье на месте (re, im — длины степени двойки). */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = (-2 * Math.PI) / size;
    const wr = Math.cos(step);
    const wi = Math.sin(step);
    for (let start = 0; start < n; start += size) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k += 1) {
        const a = start + k;
        const b = a + half;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const next = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = next;
      }
    }
  }
}

/** Границы полос частот (логарифмически, 30 Гц … 9 кГц) в номерах бинов спектра. */
function bandEdges(sampleRate) {
  const edges = [];
  const lo = Math.log(30);
  const hi = Math.log(Math.min(9000, sampleRate / 2 - 1));
  for (let b = 0; b <= BANDS; b += 1) {
    const hz = Math.exp(lo + ((hi - lo) * b) / BANDS);
    edges.push(clamp(Math.round((hz * FRAME) / sampleRate), 1, FRAME / 2));
  }
  for (let b = 1; b < edges.length; b += 1) if (edges[b] <= edges[b - 1]) edges[b] = edges[b - 1] + 1;
  return edges;
}

const yieldNow = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Кривые вспышек звука по кадрам HOP: общая, басовая (бочка) и средняя (малый барабан). */
async function onsetCurves(samples, sampleRate, onProgress) {
  const frames = Math.max(0, Math.floor((samples.length - FRAME) / HOP) + 1);
  const all = new Float32Array(frames);
  const bass = new Float32Array(frames);
  const mid = new Float32Array(frames);
  // Спектр по полосам (лог) — для смены аккорда на сильной доле.
  const spectrum = new Float32Array(frames * BANDS);
  const window = new Float32Array(FRAME);
  for (let i = 0; i < FRAME; i += 1) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME);
  const edges = bandEdges(sampleRate);
  const bassBands = edges.findIndex((edge) => (edge * sampleRate) / FRAME > 160);
  const midFrom = edges.findIndex((edge) => (edge * sampleRate) / FRAME > 1000);
  const midTo = edges.findIndex((edge) => (edge * sampleRate) / FRAME > 6000);
  const re = new Float32Array(FRAME);
  const im = new Float32Array(FRAME);
  let prev = new Float32Array(BANDS);
  let cur = new Float32Array(BANDS);
  for (let f = 0; f < frames; f += 1) {
    const offset = f * HOP;
    for (let i = 0; i < FRAME; i += 1) {
      re[i] = samples[offset + i] * window[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let b = 0; b < BANDS; b += 1) {
      let sum = 0;
      for (let k = edges[b]; k < edges[b + 1]; k += 1) sum += Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      cur[b] = Math.log1p((sum / (edges[b + 1] - edges[b])) * 20);
      spectrum[f * BANDS + b] = cur[b];
    }
    if (f > 0) {
      let flux = 0;
      let low = 0;
      let middle = 0;
      for (let b = 0; b < BANDS; b += 1) {
        const rise = cur[b] - prev[b];
        if (rise > 0) {
          flux += rise;
          if (b < bassBands) low += rise;
          else if (b >= midFrom && (midTo < 0 || b < midTo)) middle += rise;
        }
      }
      all[f] = flux;
      bass[f] = low;
      mid[f] = middle;
    }
    const swap = prev;
    prev = cur;
    cur = swap;
    if (onProgress && f % 2000 === 1999) {
      onProgress(f / frames);
      await yieldNow();
    }
  }
  const harmonicFrom = Math.max(0, edges.findIndex((edge) => (edge * sampleRate) / FRAME > 80));
  const harmonicTo = Math.max(harmonicFrom + 1, edges.findIndex((edge) => (edge * sampleRate) / FRAME > 2000));
  return { all, bass, mid, frames, spectrum, harmonic: [harmonicFrom, harmonicTo] };
}

/** Убрать медленный фон (скользящее среднее), оставить рост, нормировать. */
function normaliseOnsets(curve, frameRate) {
  const n = curve.length;
  const half = Math.max(1, Math.round(frameRate * 0.2));
  const out = new Float32Array(n);
  let sum = 0;
  let count = 0;
  let left = 0;
  let right = -1;
  for (let i = 0; i < n; i += 1) {
    while (right < Math.min(n - 1, i + half)) { right += 1; sum += curve[right]; count += 1; }
    while (left < i - half) { sum -= curve[left]; left += 1; count -= 1; }
    out[i] = Math.max(0, curve[i] - sum / Math.max(1, count));
  }
  let mean = 0;
  for (let i = 0; i < n; i += 1) mean += out[i];
  mean /= Math.max(1, n);
  let variance = 0;
  for (let i = 0; i < n; i += 1) variance += (out[i] - mean) ** 2;
  const std = Math.sqrt(variance / Math.max(1, n)) || 1;
  for (let i = 0; i < n; i += 1) out[i] /= std;
  return out;
}

/** Темп: период доли в кадрах (дробный). */
function estimatePeriod(onset, frameRate) {
  const minLag = Math.floor((frameRate * 60) / 200);
  const maxLag = Math.ceil((frameRate * 60) / 60);
  const n = onset.length;
  const scores = new Float64Array(maxLag + 2);
  for (let lag = minLag - 1; lag <= maxLag + 1; lag += 1) {
    let sum = 0;
    for (let t = 0; t + lag < n; t += 1) sum += onset[t] * onset[t + lag];
    scores[lag] = sum / Math.max(1, n - lag);
  }
  let best = minLag;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    const bpm = (60 * frameRate) / lag;
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
    // Сумма с кратными периодами (×2) — меньше ошибок «в два раза».
    const harmonic = scores[lag] + 0.5 * (lag * 2 <= maxLag ? scores[lag * 2] : 0);
    const score = harmonic * prior;
    if (score > bestScore) {
      bestScore = score;
      best = lag;
    }
  }
  // Уточнение по параболе.
  const a = scores[best - 1];
  const b = scores[best];
  const c = scores[best + 1];
  const shift = a - 2 * b + c !== 0 ? clamp((0.5 * (a - c)) / (a - 2 * b + c), -0.5, 0.5) : 0;
  return best + shift;
}

/** Доли: динамическое программирование (Ellis 2007). */
function trackBeats(onset, period) {
  const n = onset.length;
  if (n < period * 2) return [];
  // Сглаживание гауссом шириной period/32 — удар чуть «размазан» во времени.
  const sigma = Math.max(1, period / 32);
  const radius = Math.ceil(sigma * 3);
  const kernel = [];
  for (let i = -radius; i <= radius; i += 1) kernel.push(Math.exp(-0.5 * (i / sigma) ** 2));
  const local = new Float32Array(n);
  for (let t = 0; t < n; t += 1) {
    let sum = 0;
    for (let i = -radius; i <= radius; i += 1) {
      const k = t + i;
      if (k >= 0 && k < n) sum += onset[k] * kernel[i + radius];
    }
    local[t] = sum;
  }
  const tightness = 100;
  const score = new Float32Array(n);
  const back = new Int32Array(n).fill(-1);
  const lo = Math.round(period / 2);
  const hi = Math.round(period * 2);
  for (let t = 0; t < n; t += 1) {
    let best = -Infinity;
    let from = -1;
    for (let tau = t - hi; tau <= t - lo; tau += 1) {
      if (tau < 0) continue;
      const cost = Math.log((t - tau) / period);
      const value = score[tau] - tightness * cost * cost;
      if (value > best) {
        best = value;
        from = tau;
      }
    }
    score[t] = local[t] + (from >= 0 ? Math.max(0, best) : 0);
    back[t] = from >= 0 && best > 0 ? from : -1;
  }
  // Последняя доля — лучший счёт в последнем периоде.
  let end = n - 1;
  let bestEnd = -Infinity;
  for (let t = Math.max(0, n - Math.round(period)); t < n; t += 1) {
    if (score[t] > bestEnd) {
      bestEnd = score[t];
      end = t;
    }
  }
  const beats = [];
  for (let t = end; t >= 0; t = back[t]) {
    beats.push(t);
    if (back[t] < 0) break;
  }
  beats.reverse();
  // Слабые доли по краям (тишина в начале и в конце) — убрать.
  let rms = 0;
  for (const t of beats) rms += local[t] * local[t];
  rms = Math.sqrt(rms / Math.max(1, beats.length));
  let first = 0;
  let last = beats.length - 1;
  while (first < last && local[beats[first]] < 0.5 * rms) first += 1;
  while (last > first && local[beats[last]] < 0.5 * rms) last -= 1;
  return beats.slice(first, last + 1);
}

/**
 * Сильные доли: каждая 4-я. Фаза такта — где бочка без малого барабана (малый
 * обычно на 2-й и 4-й доле), при равенстве — где удар громче (тарелка, смена аккорда).
 */
function strongPhase(beats, curves, frameRate) {
  if (beats.length < 8) return 0;
  const near = Math.max(1, Math.round(frameRate * 0.03));
  const peak = (curve, frame) => {
    let value = 0;
    for (let k = frame - near; k <= frame + near; k += 1) if (k >= 0 && k < curve.length) value = Math.max(value, curve[k]);
    return value;
  };
  // Смена аккорда: насколько звучание доли отличается от предыдущей (средний спектр 80…2000 Гц).
  const [from, to] = curves.harmonic;
  const width = to - from;
  const means = beats.map((frame, index) => {
    const end = index + 1 < beats.length ? beats[index + 1] : Math.min(curves.frames, frame + (frame - (beats[index - 1] ?? frame - 20)));
    const vector = new Float32Array(width);
    let count = 0;
    for (let f = frame; f < end; f += 1) {
      for (let b = 0; b < width; b += 1) vector[b] += curves.spectrum[f * BANDS + from + b];
      count += 1;
    }
    if (count) for (let b = 0; b < width; b += 1) vector[b] /= count;
    return vector;
  });
  const novelty = means.map((vector, index) => {
    if (!index) return 0;
    let sum = 0;
    const prev = means[index - 1];
    for (let b = 0; b < width; b += 1) sum += (vector[b] - prev[b]) ** 2;
    return Math.sqrt(sum);
  });
  const novelMean = novelty.reduce((s, v) => s + v, 0) / Math.max(1, novelty.length) || 1;
  const sums = [0, 0, 0, 0];
  beats.forEach((frame, index) => {
    sums[index % 4] += peak(curves.bass, frame) - peak(curves.mid, frame) + 0.25 * peak(curves.all, frame) + 1.5 * (novelty[index] / novelMean);
  });
  let phase = 0;
  for (let p = 1; p < 4; p += 1) if (sums[p] > sums[phase] + 1e-6) phase = p;
  return phase;
}

/** Громкость по ходу трека (0…1) с шагом step секунд: где тихо, где «качает». */
function energyCurve(samples, sampleRate, step = 0.5) {
  const size = Math.max(1, Math.round(sampleRate * step));
  const count = Math.max(1, Math.ceil(samples.length / size));
  const values = new Float32Array(count);
  for (let c = 0; c < count; c += 1) {
    let sum = 0;
    const from = c * size;
    const to = Math.min(samples.length, from + size);
    for (let i = from; i < to; i += 1) sum += samples[i] * samples[i];
    values[c] = Math.sqrt(sum / Math.max(1, to - from));
  }
  const sorted = Float32Array.from(values).sort();
  const low = sorted[Math.floor(sorted.length * 0.1)] || 0;
  const high = sorted[Math.floor(sorted.length * 0.95)] || 1;
  for (let c = 0; c < count; c += 1) values[c] = clamp((values[c] - low) / Math.max(1e-6, high - low), 0, 1);
  return { step, values: Array.from(values, (value) => Math.round(value * 1000) / 1000) };
}

/**
 * Разбор звука: { duration, tempo, beats: [секунды], strong: [номера сильных долей], energy }.
 * samples — моно Float32Array, sampleRate — его частота (лучше 22 050).
 */
export async function analyseSamples(samples, sampleRate = BEAT_RATE, { onProgress } = {}) {
  const limited = samples.length > sampleRate * MAX_SECONDS ? samples.subarray(0, sampleRate * MAX_SECONDS) : samples;
  const duration = samples.length / sampleRate;
  const frameRate = sampleRate / HOP;
  const { all, bass, mid, frames, spectrum, harmonic } = await onsetCurves(limited, sampleRate, onProgress);
  // Вспышки в полосе голоса (1…6 кГц: согласные, начала слогов) — для слов песни (караоке).
  const vocal = { rate: frameRate, offset: FRAME / 2 / sampleRate, values: normaliseOnsets(mid, frameRate) };
  const empty = { duration, tempo: 0, beats: [], strong: [], energy: energyCurve(limited, sampleRate), vocal };
  if (frames < frameRate * 3) return empty;
  const onset = normaliseOnsets(all, frameRate);
  const period = estimatePeriod(onset, frameRate);
  const frameBeats = trackBeats(onset, period);
  if (frameBeats.length < 4) return empty;
  // Середина кадра анализа → секунды; FRAME/2 — центр окна.
  const toSeconds = (frame) => Math.round(((frame * HOP + FRAME / 2) / sampleRate) * 1000) / 1000;
  const beats = frameBeats.map(toSeconds);
  const phase = strongPhase(frameBeats, { all: onset, bass: normaliseOnsets(bass, frameRate), mid: normaliseOnsets(mid, frameRate), spectrum, harmonic, frames }, frameRate);
  const strong = [];
  for (let i = phase; i < beats.length; i += 4) strong.push(i);
  // Темп — по медиане расстояний между долями.
  const gaps = beats.slice(1).map((value, index) => value - beats[index]).sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)] || (period / frameRate);
  return { duration, tempo: Math.round((60 / median) * 10) / 10, beats, strong, energy: energyCurve(limited, sampleRate), vocal };
}

/** Браузер: AudioBuffer → моно 22 050 Гц → разбор. */
export async function analyseAudioBuffer(buffer, options = {}) {
  const seconds = Math.min(buffer.duration, MAX_SECONDS);
  const length = Math.max(1, Math.ceil(seconds * BEAT_RATE));
  const Offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  let samples;
  if (Offline) {
    const context = new Offline(1, length, BEAT_RATE);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.start(0);
    const rendered = await context.startRendering();
    samples = rendered.getChannelData(0);
  } else {
    samples = buffer.getChannelData(0);
    return analyseSamples(samples, buffer.sampleRate, options);
  }
  const result = await analyseSamples(samples, BEAT_RATE, options);
  result.duration = buffer.duration;
  return result;
}

const cache = new Map();
const ready = new Map();

/** Ритм трека по адресу файла (кэш на сессию). */
export function beatsForUrl(url, options = {}) {
  if (!url) return Promise.resolve(null);
  if (!cache.has(url)) {
    cache.set(url, (async () => {
      const response = await fetch(url, { credentials: "same-origin" });
      if (!response.ok) throw new Error(`музыка не загрузилась (${response.status})`);
      const data = await response.arrayBuffer();
      const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
      const context = new Context();
      try {
        const buffer = await context.decodeAudioData(data);
        const result = await analyseAudioBuffer(buffer, options);
        ready.set(url, result);
        return result;
      } finally {
        void context.close?.();
      }
    })().catch((error) => {
      cache.delete(url);
      throw error;
    }));
  }
  return cache.get(url);
}

/** Уже посчитанный ритм (без ожидания) или null. */
export function cachedBeats(url) {
  return ready.get(url) || null;
}

/**
 * Доли трека в шкале ролика. place: { start (где трек начинается в ролике),
 * trackStart (с какой секунды трека), until (где кончается в ролике), loop }.
 * Возвращает [{ o, strong }] по возрастанию.
 */
export function beatsInVideo(analysis, place) {
  if (!analysis?.beats?.length) return [];
  const start = Number(place.start) || 0;
  const trackStart = Number(place.trackStart) || 0;
  const until = Number(place.until) || 0;
  const strongSet = new Set(analysis.strong || []);
  const length = analysis.duration || 0;
  const result = [];
  for (let lap = 0; lap < 50; lap += 1) {
    const offset = start - trackStart + lap * length;
    if (lap > 0 && (!place.loop || !(length > 1))) break;
    if (offset - 0.001 > until) break;
    analysis.beats.forEach((beat, index) => {
      if (lap === 0 && beat < trackStart - 0.001) return;
      const o = offset + beat;
      if (o >= start - 0.001 && o <= until + 0.001) result.push({ o: Math.round(o * 1000) / 1000, strong: strongSet.has(index) });
    });
  }
  return result.sort((a, b) => a.o - b.o);
}

/** Ближайшая доля к o (в пределах tolerance) или null. */
export function nearestBeat(beats, o, tolerance = Infinity) {
  if (!beats?.length) return null;
  let lo = 0;
  let hi = beats.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (beats[mid].o < o) lo = mid + 1;
    else hi = mid;
  }
  let best = null;
  for (const index of [lo - 1, lo]) {
    const beat = beats[index];
    if (!beat) continue;
    const distance = Math.abs(beat.o - o);
    if (distance <= tolerance && (!best || distance < Math.abs(best.o - o))) best = beat;
  }
  return best;
}
