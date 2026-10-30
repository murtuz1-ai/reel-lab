// Видеоэффекты и монтаж в кадре.
//
// Кадр собирается слоями:
//   видео (цвет-фильтр, зум, тряска) → тонировка, виньетка, зерно →
//   субтитры → человек поверх субтитров (текст «за человеком») →
//   вспышки и хук.
// Один и тот же код рисует готовый ролик (через сборщик кадра движка) и
// задаёт предпросмотр, поэтому в студии видно ровно то, что получится.
// Все времена — время исходного видео: вырезанные куски движок пропускает
// сам, эффекты и субтитры при этом не сдвигаются.

import { ALL_FORMATS, BlobSource, CaptionStacking, CaptionsOverlayFramePainter, Input, LayeredFrameCompositor, VideoSampleSink } from "./engine-api.js";
import { drawTransition, transitionAt } from "./transitions.js";

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function easeOutCubic(x) {
  const t = clamp(x, 0, 1);
  return 1 - (1 - t) ** 3;
}

function easeInOutSine(x) {
  const t = clamp(x, 0, 1);
  return -(Math.cos(Math.PI * t) - 1) / 2;
}

// ---------------------------------------------------------------------------
// Вырезанные куски (как RenderTimeMap движка)

export class TimeMap {
  constructor(ranges = []) {
    this.ranges = normaliseRanges(ranges);
  }

  isEmpty() {
    return this.ranges.length === 0;
  }

  rangeAt(time) {
    for (const range of this.ranges) {
      if (time < range.start) return null;
      if (time < range.end) return range;
    }
    return null;
  }

  isSkipped(time) {
    return Boolean(this.rangeAt(time));
  }

  toOutput(time) {
    let skipped = 0;
    for (const range of this.ranges) {
      if (time < range.start) break;
      skipped += Math.min(time, range.end) - range.start;
    }
    return time - skipped;
  }

  totalSkipped() {
    return this.ranges.reduce((sum, range) => sum + (range.end - range.start), 0);
  }

  /** Для движка: { startSec, endSec }. */
  toEngine() {
    return this.ranges.map((range) => ({ startSec: range.start, endSec: range.end }));
  }
}

export function normaliseRanges(ranges) {
  const sorted = (ranges || [])
    .map((range) => ({ start: Number(range.start ?? range[0]), end: Number(range.end ?? range[1]) }))
    .filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end) && range.end - range.start > 0.02)
    .sort((a, b) => a.start - b.start);
  const merged = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end + 0.01) last.end = Math.max(last.end, range.end);
    else merged.push({ start: Math.max(0, range.start), end: range.end });
  }
  return merged;
}

/** Все пропуски ролика: обрезка начала и конца плюс вырезанные куски. */
export function skipRangesFor(edit, duration) {
  const ranges = [];
  const trimStart = clamp(Number(edit?.trimStart) || 0, 0, duration || 0);
  const trimEnd = edit?.trimEnd == null ? duration : clamp(Number(edit.trimEnd), trimStart, duration || Infinity);
  if (trimStart > 0.02) ranges.push({ start: 0, end: trimStart });
  for (const cut of edit?.cuts || []) {
    if (cut.enabled === false) continue;
    ranges.push({ start: Math.max(trimStart, cut.start), end: Math.min(trimEnd, cut.end) });
  }
  if (Number.isFinite(trimEnd) && duration && trimEnd < duration - 0.02) ranges.push({ start: trimEnd, end: duration + 0.05 });
  return normaliseRanges(ranges);
}

// ---------------------------------------------------------------------------
// Цвет

export const LOOKS = [
  { id: "none", label: "Без фильтра", filter: "", tint: null, vignette: 0, grain: 0 },
  { id: "cinema", label: "Кино", filter: "contrast(1.12) saturate(0.86) brightness(0.98)", tint: { color: "#ff9a3c", alpha: 0.1, mode: "soft-light" }, vignette: 0.35, grain: 0.12 },
  { id: "warm", label: "Тёплый", filter: "saturate(1.08) brightness(1.03)", tint: { color: "#ffb15c", alpha: 0.16, mode: "soft-light" }, vignette: 0.15, grain: 0 },
  { id: "cold", label: "Холодный", filter: "saturate(0.95) contrast(1.05)", tint: { color: "#4aa8ff", alpha: 0.15, mode: "soft-light" }, vignette: 0.1, grain: 0 },
  { id: "vivid", label: "Сочный", filter: "saturate(1.35) contrast(1.08)", tint: null, vignette: 0.1, grain: 0 },
  { id: "soft", label: "Мягкий", filter: "contrast(0.92) brightness(1.06) saturate(0.94)", tint: { color: "#ffd9c2", alpha: 0.08, mode: "screen" }, vignette: 0, grain: 0 },
  { id: "bw", label: "Ч/Б", filter: "grayscale(1) contrast(1.15)", tint: null, vignette: 0.25, grain: 0.15 },
  { id: "vintage", label: "Винтаж", filter: "sepia(0.35) contrast(0.95) saturate(0.9)", tint: { color: "#ffcf8a", alpha: 0.12, mode: "soft-light" }, vignette: 0.4, grain: 0.3 },
  { id: "night", label: "Неон-ночь", filter: "saturate(1.25) contrast(1.1) hue-rotate(-8deg)", tint: { color: "#7b4dff", alpha: 0.14, mode: "soft-light" }, vignette: 0.3, grain: 0.05 },
  // Голливуд (teal & orange): кожа и светлое — тёплые, тени — бирюзовые.
  { id: "teal", label: "Голливуд", filter: "saturate(1.12) contrast(1.14)", tint: { color: "#ffa040", alpha: 0.42, mode: "soft-light" },
    tints: [{ color: "#00323e", alpha: 0.45, mode: "screen" }, { color: "#ffe4c8", alpha: 0.22, mode: "multiply" }], vignette: 0.2, grain: 0.04 },
  // Золотой час: тёплый свет и тёплые приподнятые тени.
  { id: "golden", label: "Золотой час", filter: "saturate(1.15) contrast(1.04) brightness(1.05) sepia(0.15)", tint: { color: "#ffa53a", alpha: 0.34, mode: "soft-light" },
    tints: [{ color: "#3d1c00", alpha: 0.3, mode: "screen" }], vignette: 0.18, grain: 0.03 },
  // Плёнка: матовый чёрный, мягкий контраст, тёплый оттенок.
  { id: "film", label: "Плёнка", filter: "contrast(0.92) saturate(0.84) brightness(1.02)", tint: { color: "#f0d9a8", alpha: 0.16, mode: "soft-light" }, lift: 0.075, vignette: 0.2, grain: 0.12 },
  { id: "moody", label: "Мрачный", filter: "saturate(0.7) contrast(1.16) brightness(0.92)", tint: { color: "#2f4a5c", alpha: 0.2, mode: "soft-light" }, vignette: 0.45, grain: 0.08 },
];

export function lookById(id) {
  return LOOKS.find((look) => look.id === id) || LOOKS[0];
}

// Цвет (яркость…тепло) и атмосфера (виньетка, зерно, засветы плёнки, пыль, кинополосы), 0…100 у атмосферы.
export const ADJUST_DEFAULTS = Object.freeze({ brightness: 0, contrast: 0, saturation: 0, warmth: 0, vignette: 0, grain: 0, leaks: 0, dust: 0, bars: 0 });

/** CSS-фильтр кадра: фильтр образа + ручная коррекция. Тот же для <video> и canvas. */
export function cssFilterFor(look, adjust = ADJUST_DEFAULTS) {
  const parts = [];
  if (look?.filter) parts.push(look.filter);
  const b = 1 + (Number(adjust.brightness) || 0) / 100;
  const c = 1 + (Number(adjust.contrast) || 0) / 100;
  const s = 1 + (Number(adjust.saturation) || 0) / 100;
  if (Math.abs(b - 1) > 0.004) parts.push(`brightness(${b.toFixed(3)})`);
  if (Math.abs(c - 1) > 0.004) parts.push(`contrast(${c.toFixed(3)})`);
  if (Math.abs(s - 1) > 0.004) parts.push(`saturate(${s.toFixed(3)})`);
  return parts.join(" ");
}

/** Слои поверх видео (под субтитрами): тонировка, виньетка, зерно. */
export function overlaysFor(look, adjust = ADJUST_DEFAULTS) {
  const tints = [];
  if (look?.tint) tints.push(look.tint);
  for (const tint of look?.tints || []) tints.push(tint);
  const warmth = Number(adjust.warmth) || 0;
  if (Math.abs(warmth) > 2) {
    tints.push({ color: warmth > 0 ? "#ff9d3b" : "#3b9dff", alpha: Math.min(0.3, Math.abs(warmth) / 100 * 0.3), mode: "soft-light" });
  }
  return {
    tints,
    lift: clamp(look?.lift || 0, 0, 0.3),
    vignette: clamp((look?.vignette || 0) + (Number(adjust.vignette) || 0) / 100, 0, 1),
    grain: clamp((look?.grain || 0) + (Number(adjust.grain) || 0) / 100, 0, 1),
    leaks: clamp((Number(adjust.leaks) || 0) / 100, 0, 1),
    dust: clamp((Number(adjust.dust) || 0) / 100, 0, 1),
    // Кинополосы: высота каждой полосы — до 18% кадра.
    bars: clamp((Number(adjust.bars) || 0) / 100, 0, 1) * 0.18,
  };
}

/** Видна ли атмосфера (что-то поверх кадра): тонировка, тени, зерно, засветы, пыль, полосы. */
export function overlaysActive(layers) {
  return Boolean(layers && (layers.tints?.length || layers.lift > 0.005 || layers.vignette > 0.01 || layers.grain > 0.01
    || layers.leaks > 0.01 || layers.dust > 0.01 || layers.bars > 0.002));
}

// ---------------------------------------------------------------------------
// Движение: зум, тряска, вспышки

/**
 * Масштаб и центр кадра в момент `time`. Зум «наезжает» быстро, держится,
 * мягко отпускает; центр — лицо, если оно найдено.
 */
export function cameraAt(fx, time) {
  let scale = 1;
  let cx = 0.5;
  let cy = 0.45;
  // Вставки и видео поверх: камера стоит (их не зумят и не трясут).
  for (const range of fx?.still || []) {
    if (time >= range[0] && time < range[1]) return { scale, cx, cy, dx: 0, dy: 0 };
  }
  // Скачок масштаба на склейках (jump cut): каждый второй кусок чуть крупнее.
  if (fx?.jumpZoom > 1 && fx.cutPoints?.length) {
    let index = 0;
    for (const point of fx.cutPoints) if (time >= point) index += 1;
    if (index % 2 === 1) scale = fx.jumpZoom;
  }
  for (const zoom of fx?.zooms || []) {
    if (time < zoom.start || time > zoom.end + (zoom.out ?? 0.3)) continue;
    const inDur = zoom.in ?? 0.14;
    const outDur = zoom.out ?? 0.3;
    let k;
    if (time < zoom.start + inDur) k = easeOutCubic((time - zoom.start) / inDur);
    else if (time <= zoom.end) k = 1;
    else k = 1 - easeInOutSine((time - zoom.end) / outDur);
    const target = 1 + (zoom.scale - 1) * k;
    if (target > scale) {
      scale = target;
      cx = zoom.cx ?? cx;
      cy = zoom.cy ?? cy;
    }
  }
  const face = faceAt(fx?.faces, time);
  if (face) {
    cx = face.x;
    cy = face.y;
  }
  let dx = 0;
  let dy = 0;
  for (const shake of fx?.shakes || []) {
    const local = time - shake.time;
    if (local < 0 || local > shake.duration) continue;
    const decay = 1 - local / shake.duration;
    const amp = shake.strength * decay;
    dx += Math.sin(local * 71 + shake.time * 13) * amp * 0.012;
    dy += Math.cos(local * 57 + shake.time * 7) * amp * 0.012;
    scale = Math.max(scale, 1 + amp * 0.03);
  }
  return { scale, cx, cy, dx, dy };
}

function faceAt(track, time) {
  if (!track?.length) return null;
  let previous = track[0];
  for (const point of track) {
    if (point.t >= time) {
      if (point === previous) return point;
      const k = (time - previous.t) / Math.max(0.001, point.t - previous.t);
      return { x: previous.x + (point.x - previous.x) * k, y: previous.y + (point.y - previous.y) * k };
    }
    previous = point;
  }
  return previous;
}

export function flashAt(fx, time) {
  let alpha = 0;
  let color = "#ffffff";
  for (const flash of fx?.flashes || []) {
    const local = time - flash.time;
    if (local < -0.03 || local > flash.duration) continue;
    const k = local < 0 ? 1 + local / 0.03 : 1 - easeOutCubic(local / flash.duration);
    const value = clamp(k, 0, 1) * (flash.strength ?? 0.6);
    if (value > alpha) {
      alpha = value;
      color = flash.color || color;
    }
  }
  return { alpha, color };
}

// ---------------------------------------------------------------------------
// Рисование слоёв

function makeCanvas(width, height) {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

let grainTile = null;
function grainPattern(ctx) {
  if (!grainTile) {
    const size = 192;
    grainTile = makeCanvas(size, size);
    const gctx = grainTile.getContext("2d");
    const image = gctx.createImageData(size, size);
    let seed = 1234567;
    for (let i = 0; i < size * size; i += 1) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      const v = 128 + (((seed >>> 16) & 255) - 128) * 0.9;
      image.data[i * 4] = v;
      image.data[i * 4 + 1] = v;
      image.data[i * 4 + 2] = v;
      image.data[i * 4 + 3] = 255;
    }
    gctx.putImageData(image, 0, 0);
  }
  return ctx.createPattern(grainTile, "repeat");
}

/** Рисует кадр видео с фильтром и движением камеры. */
export function drawCameraFrame(ctx, drawFrame, fx, time, W, H) {
  const camera = cameraAt(fx, time);
  ctx.save();
  if (fx?.filter) ctx.filter = fx.filter;
  if (camera.scale !== 1 || camera.dx || camera.dy) {
    const px = camera.cx * W;
    const py = camera.cy * H;
    ctx.translate(px + camera.dx * W, py + camera.dy * H);
    ctx.scale(camera.scale, camera.scale);
    ctx.translate(-px, -py);
  }
  drawFrame(ctx);
  ctx.restore();
  return camera;
}

/** Засветы плёнки: тёплые пятна света медленно плывут по кадру и иногда вспыхивают ярче. */
function drawLeaks(ctx, amount, time, W, H) {
  const size = Math.max(W, H);
  const blobs = [
    { phase: 0.0, speed: 0.13, y: 0.28, r: 0.8, colors: ["255, 214, 150", "255, 140, 60", "255, 70, 30"] },
    { phase: 2.1, speed: 0.09, y: 0.72, r: 0.65, colors: ["255, 170, 120", "255, 96, 70", "200, 40, 60"] },
    { phase: 4.4, speed: 0.17, y: 0.5, r: 0.5, colors: ["255, 236, 200", "255, 190, 110", "255, 120, 40"] },
  ];
  ctx.save();
  ctx.globalCompositeOperation = "screen";
  for (const blob of blobs) {
    const t = time * blob.speed + blob.phase;
    const cx = W * (0.5 + 0.75 * Math.sin(t));
    const cy = H * (blob.y + 0.12 * Math.sin(t * 1.7 + blob.phase));
    // Обычно засвет едва заметен, временами — вспышка (как у плёнки).
    const pulse = 0.35 + 0.65 * Math.pow(0.5 + 0.5 * Math.sin(time * 0.31 + blob.phase * 1.9), 3);
    const alpha = clamp(amount * pulse, 0, 1);
    if (alpha < 0.01) continue;
    const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, size * blob.r);
    gradient.addColorStop(0, `rgba(${blob.colors[0]}, ${(0.85 * alpha).toFixed(3)})`);
    gradient.addColorStop(0.35, `rgba(${blob.colors[1]}, ${(0.5 * alpha).toFixed(3)})`);
    gradient.addColorStop(0.7, `rgba(${blob.colors[2]}, ${(0.16 * alpha).toFixed(3)})`);
    gradient.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, W, H);
  }
  ctx.restore();
}

function noise01(seed, index) {
  let x = Math.imul((seed | 0) ^ 0x2545f491, 0x9e3779b1) ^ Math.imul(index + 7, 0x85ebca77);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae3d);
  x ^= x >>> 16;
  return ((x >>> 0) % 100000) / 100000;
}

/** Пыль и царапины плёнки: свои на каждом кадре (24 в секунду), одинаковые в предпросмотре и в ролике. */
function drawDust(ctx, amount, time, W, H) {
  const frame = Math.floor(time * 24);
  const unit = Math.max(1, Math.min(W, H) / 540);
  const count = Math.round(2 + amount * 14);
  ctx.save();
  for (let i = 0; i < count; i += 1) {
    if (noise01(frame, i * 3) > 0.35 + amount * 0.5) continue;
    const x = noise01(frame, i * 3 + 1) * W;
    const y = noise01(frame, i * 3 + 2) * H;
    const r = unit * (0.6 + noise01(frame, i + 500) * 2.2);
    ctx.globalAlpha = 0.25 + 0.5 * amount * noise01(frame, i + 900);
    ctx.fillStyle = noise01(frame, i + 1300) > 0.4 ? "#f4eee2" : "#140f0a";
    ctx.beginPath();
    ctx.ellipse(x, y, r, r * (0.5 + noise01(frame, i + 1700)), noise01(frame, i + 2100) * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  // Царапина: тонкая вертикальная линия, держится несколько кадров.
  const scratchSeed = Math.floor(time * 3);
  if (noise01(scratchSeed, 77) < 0.25 + amount * 0.35) {
    const x = noise01(scratchSeed, 78) * W + Math.sin(time * 40) * unit * 2;
    ctx.globalAlpha = 0.18 + 0.3 * amount;
    ctx.fillStyle = "#f4eee2";
    ctx.fillRect(x, 0, Math.max(1, unit * 0.9), H);
  }
  ctx.restore();
}

/** Высота кинополосы в пикселях (сверху и снизу), 0 — полос нет. */
export function barHeight(fx, H) {
  return Math.round((fx?.overlays?.bars || 0) * H);
}

export function drawUnderlays(ctx, fx, time, W, H) {
  const layers = fx?.overlays;
  if (!layers) return;
  for (const tint of layers.tints || []) {
    ctx.save();
    ctx.globalCompositeOperation = tint.mode || "soft-light";
    ctx.globalAlpha = clamp(tint.alpha, 0, 1);
    ctx.fillStyle = tint.color;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }
  if (layers.lift > 0.005) {
    // Матовый чёрный: самые тёмные места не темнее этого серого.
    const level = Math.round(layers.lift * 255);
    ctx.save();
    ctx.globalCompositeOperation = "lighten";
    ctx.fillStyle = `rgb(${level}, ${Math.round(level * 0.95)}, ${Math.round(level * 0.88)})`;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }
  if (layers.leaks > 0.01) drawLeaks(ctx, layers.leaks, time, W, H);
  if (layers.vignette > 0.01) {
    ctx.save();
    const radius = Math.hypot(W, H) / 2;
    const gradient = ctx.createRadialGradient(W / 2, H / 2, radius * 0.45, W / 2, H / 2, radius);
    gradient.addColorStop(0, "rgba(0,0,0,0)");
    gradient.addColorStop(1, `rgba(0,0,0,${(0.75 * layers.vignette).toFixed(3)})`);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }
  if (layers.grain > 0.01) {
    ctx.save();
    ctx.globalCompositeOperation = "overlay";
    ctx.globalAlpha = 0.45 * layers.grain;
    const pattern = grainPattern(ctx);
    const frame = Math.floor(time * 24);
    const ox = (frame * 73) % 192;
    const oy = (frame * 41) % 192;
    // Зерно — по размеру кадра: в ролике 1080 и в маленьком предпросмотре оно одинаково крупное.
    const cell = Math.max(1, Math.min(W, H) / 540);
    ctx.scale(cell, cell);
    ctx.translate(-ox, -oy);
    ctx.fillStyle = pattern;
    ctx.fillRect(0, 0, W / cell + 192, H / cell + 192);
    ctx.restore();
  }
  if (layers.dust > 0.01) drawDust(ctx, layers.dust, time, W, H);
  const bar = barHeight(fx, H);
  if (bar > 0) {
    ctx.save();
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, bar);
    ctx.fillRect(0, H - bar, W, bar);
    ctx.restore();
  }
}

function drawHook(ctx, hook, time, W, H) {
  if (!hook?.text || time < (hook.start ?? 0) || time > (hook.end ?? 2.8)) return;
  const start = hook.start ?? 0;
  const end = hook.end ?? 2.8;
  const appear = easeOutCubic((time - start) / 0.35);
  const leave = time > end - 0.35 ? 1 - easeOutCubic((time - (end - 0.35)) / 0.35) : 1;
  const alpha = appear * leave;
  if (alpha <= 0.01) return;
  const size = Math.round(Math.sqrt(W * H) * 0.058);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = `800 ${size}px "Rubik", "Montserrat", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const maxWidth = W * 0.82;
  const words = String(hook.text).split(/\s+/);
  const lines = [];
  let line = "";
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else line = test;
  }
  if (line) lines.push(line);
  const lineHeight = size * 1.18;
  const blockH = lines.length * lineHeight;
  const top = H * (hook.position === "center" ? 0.5 : 0.2) - blockH / 2 + (1 - appear) * size * 0.4;
  const padX = size * 0.55;
  const widest = Math.max(...lines.map((item) => ctx.measureText(item).width));
  ctx.fillStyle = hook.background || "rgba(12, 10, 16, 0.78)";
  const r = size * 0.35;
  const bx = W / 2 - widest / 2 - padX;
  const by = top - size * 0.35;
  const bw = widest + padX * 2;
  const bh = blockH + size * 0.7;
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(bx, by, bw, bh, r) : ctx.rect(bx, by, bw, bh);
  ctx.fill();
  ctx.fillStyle = hook.color || "#ffffff";
  lines.forEach((text, i) => ctx.fillText(text, W / 2, top + lineHeight * (i + 0.5)));
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Подпись поверх видео: ник или название канала весь ролик в одном месте.

let signatureMeasure = null;

function isLightColor(color) {
  const hex = String(color || "").replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(hex)) return true;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.55;
}

/**
 * Место подписи в кадре W×H: кегль, рамка и центр. Подпись не выходит за
 * край кадра. Тем же расчётом пользуется редактор композиции (рамка для
 * перетаскивания), поэтому рамка всегда совпадает с тем, что нарисовано.
 */
export function signatureLayout(sig, W, H, ctx = null) {
  const text = String(sig?.text || "");
  if (!text || !(W > 0) || !(H > 0)) return null;
  const px = Math.max(6, Math.sqrt(W * H) * 0.026 * clamp(Number(sig.size) || 1, 0.3, 4));
  const font = `${sig.weight || 700} ${px.toFixed(2)}px ${sig.font || '"Montserrat"'}, "Rubik", sans-serif`;
  let mctx = ctx;
  if (!mctx) {
    signatureMeasure = signatureMeasure || makeCanvas(8, 8).getContext("2d");
    mctx = signatureMeasure;
  }
  mctx.save();
  mctx.font = font;
  const width = mctx.measureText(text).width;
  mctx.restore();
  const box = sig.look === "box";
  const w = width + px * (box ? 1 : 0.3);
  const h = px * (box ? 1.75 : 1.35);
  const margin = Math.min(W, H) * 0.02;
  const cx = clamp(clamp(Number(sig.x ?? 0.5), 0, 1) * W, margin + w / 2, Math.max(margin + w / 2, W - margin - w / 2));
  const cy = clamp(clamp(Number(sig.y ?? 0.93), 0, 1) * H, margin + h / 2, Math.max(margin + h / 2, H - margin - h / 2));
  return { px, font, cx, cy, rect: { x: cx - w / 2, y: cy - h / 2, w, h } };
}

function drawSignature(ctx, sig, W, H) {
  const layout = signatureLayout(sig, W, H, ctx);
  if (!layout) return;
  const { px, font, cx, cy, rect } = layout;
  ctx.save();
  ctx.globalAlpha = clamp(Number(sig.opacity ?? 0.9), 0.05, 1);
  ctx.font = font;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  if (sig.look === "box") {
    ctx.fillStyle = isLightColor(sig.color) ? "rgba(10, 10, 14, 0.6)" : "rgba(255, 255, 255, 0.82)";
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(rect.x, rect.y, rect.w, rect.h, rect.h * 0.32);
    else ctx.rect(rect.x, rect.y, rect.w, rect.h);
    ctx.fill();
  } else if (sig.look === "outline") {
    ctx.lineJoin = "round";
    ctx.lineWidth = px * 0.18;
    ctx.strokeStyle = isLightColor(sig.color) ? "rgba(0, 0, 0, 0.85)" : "rgba(255, 255, 255, 0.9)";
    ctx.strokeText(sig.text, cx, cy);
  } else {
    ctx.shadowColor = "rgba(0, 0, 0, 0.6)";
    ctx.shadowBlur = px * 0.35;
    ctx.shadowOffsetY = px * 0.06;
  }
  ctx.fillStyle = sig.color || "#ffffff";
  ctx.fillText(sig.text, cx, cy);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Перевод второй строкой: под (или над) субтитрами, фраза перевода на время
// своей фразы. Рисуется поверх любого стиля — и в окне, и при сборке ролика.

let translationMeasure = null;
const TRANSLATION_FADE = 0.14;

function translationCueAt(tr, time) {
  const cues = tr?.cues;
  if (!Array.isArray(cues) || !cues.length) return null;
  for (const cue of cues) {
    if (time >= cue.start - 0.02 && time < cue.end + 0.12) return cue;
  }
  return null;
}

/** Строки, кегль и рамка перевода в кадре W×H (той же рамкой пользуется перетаскивание). */
export function translationLayout(tr, time, W, H, ctx = null) {
  const cue = translationCueAt(tr, time);
  if (!cue || !String(cue.text || "").trim() || !(W > 0) || !(H > 0)) return null;
  const px = Math.max(6, Math.sqrt(W * H) * 0.03 * clamp(Number(tr.size) || 1, 0.4, 3));
  const font = `${tr.weight || 600} ${px.toFixed(2)}px ${tr.font || '"Montserrat"'}, "Cairo", "Rubik", sans-serif`;
  let mctx = ctx;
  if (!mctx) {
    translationMeasure = translationMeasure || makeCanvas(8, 8).getContext("2d");
    mctx = translationMeasure;
  }
  mctx.save();
  mctx.font = font;
  mctx.direction = tr.rtl ? "rtl" : "ltr";
  const maxWidth = W * 0.84;
  const lines = [];
  let line = "";
  for (const word of String(cue.text).trim().split(/\s+/)) {
    const test = line ? `${line} ${word}` : word;
    if (line && mctx.measureText(test).width > maxWidth) {
      lines.push(line);
      line = word;
    } else line = test;
  }
  if (line) lines.push(line);
  const widest = Math.max(...lines.map((item) => mctx.measureText(item).width));
  mctx.restore();
  const box = tr.look === "box";
  const lineHeight = px * 1.28;
  const w = widest + px * (box ? 1.2 : 0.4);
  const h = lines.length * lineHeight + px * (box ? 0.7 : 0.3);
  const margin = Math.min(W, H) * 0.02;
  const cx = clamp(clamp(Number(tr.x ?? 0.5), 0, 1) * W, margin + w / 2, Math.max(margin + w / 2, W - margin - w / 2));
  const cy = clamp(clamp(Number(tr.y ?? 0.86), 0, 1) * H, margin + h / 2, Math.max(margin + h / 2, H - margin - h / 2));
  return { cue, lines, px, font, lineHeight, cx, cy, rect: { x: cx - w / 2, y: cy - h / 2, w, h } };
}

function drawTranslation(ctx, tr, time, W, H) {
  const layout = translationLayout(tr, time, W, H, ctx);
  if (!layout) return;
  const { cue, lines, px, font, lineHeight, cx, cy, rect } = layout;
  const appear = clamp((time - (cue.start - 0.02)) / TRANSLATION_FADE, 0, 1);
  const leave = clamp((cue.end + 0.12 - time) / TRANSLATION_FADE, 0, 1);
  const alpha = clamp(Number(tr.opacity ?? 1), 0.05, 1) * Math.min(appear, leave);
  if (alpha <= 0.01) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = font;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.direction = tr.rtl ? "rtl" : "ltr";
  const light = isLightColor(tr.color);
  if (tr.look === "box") {
    ctx.fillStyle = light ? "rgba(10, 10, 14, 0.62)" : "rgba(255, 255, 255, 0.85)";
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(rect.x, rect.y, rect.w, rect.h, Math.min(rect.h / 2, px * 0.5));
    else ctx.rect(rect.x, rect.y, rect.w, rect.h);
    ctx.fill();
  }
  const top = cy - (lines.length * lineHeight) / 2 + lineHeight / 2;
  lines.forEach((text, index) => {
    const y = top + index * lineHeight;
    if (tr.look === "outline") {
      ctx.lineJoin = "round";
      ctx.lineWidth = px * 0.18;
      ctx.strokeStyle = light ? "rgba(0, 0, 0, 0.85)" : "rgba(255, 255, 255, 0.9)";
      ctx.strokeText(text, cx, y);
    } else if (tr.look !== "box") {
      ctx.shadowColor = "rgba(0, 0, 0, 0.7)";
      ctx.shadowBlur = px * 0.35;
      ctx.shadowOffsetY = px * 0.06;
    }
    ctx.fillStyle = tr.color || "#ffffff";
    ctx.fillText(text, cx, y);
    ctx.shadowColor = "transparent";
  });
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Водяной знак бесплатного тарифа. Знак кочует по кадру: каждые несколько
// секунд встаёт в другое место (не у края и не на субтитрах) и чуть плывёт,
// поэтому его не убрать обрезкой кадра или одним размытием. В конце ролика —
// короткая карточка «Сделано в Reel Lab».

const WATERMARK_SPOTS = [
  [0.27, 0.2], [0.73, 0.27], [0.3, 0.44], [0.7, 0.5], [0.26, 0.63], [0.66, 0.16], [0.5, 0.36], [0.72, 0.64],
];
const WATERMARK_STEP = 3.2;
const WATERMARK_FADE = 0.3;

function watermarkHash(n) {
  let x = (n * 2654435761) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 2246822519) >>> 0;
  x ^= x >>> 13;
  return x >>> 0;
}

function drawWatermarkMark(ctx, wm, cx, cy, unit, alpha) {
  ctx.save();
  ctx.globalAlpha = alpha;
  const logo = unit * 1.15;
  ctx.font = `800 ${unit.toFixed(1)}px "Montserrat", "Rubik", sans-serif`;
  const title = wm.text || "Reel Lab";
  const titleW = ctx.measureText(title).width;
  const sub = wm.sub ? String(wm.sub) : "";
  ctx.font = `600 ${(unit * 0.5).toFixed(1)}px "Montserrat", "Rubik", sans-serif`;
  const subW = sub ? ctx.measureText(sub).width : 0;
  const gap = unit * 0.35;
  const width = logo + gap + Math.max(titleW, subW);
  const x0 = cx - width / 2;
  // Полупрозрачная тёмная подложка: знак читается и на белой стене, и на небе.
  const padX = unit * 0.32;
  const boxH = Math.max(logo, sub ? unit * 1.75 : unit * 1.2) + unit * 0.36;
  ctx.fillStyle = "rgba(12, 11, 16, 0.34)";
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x0 - padX, cy - boxH / 2, width + padX * 2, boxH, boxH * 0.3);
  else ctx.rect(x0 - padX, cy - boxH / 2, width + padX * 2, boxH);
  ctx.fill();
  ctx.shadowColor = "rgba(0, 0, 0, 0.55)";
  ctx.shadowBlur = unit * 0.35;
  ctx.shadowOffsetY = unit * 0.05;
  // Значок: скруглённый квадрат с «плеем».
  const ly = cy - logo / 2;
  const grad = ctx.createLinearGradient(x0, ly, x0 + logo, ly + logo);
  grad.addColorStop(0, "#ffd56b");
  grad.addColorStop(1, "#f39a3d");
  ctx.fillStyle = grad;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x0, ly, logo, logo, logo * 0.28);
  else ctx.rect(x0, ly, logo, logo);
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.fillStyle = "#1a1206";
  ctx.beginPath();
  ctx.moveTo(x0 + logo * 0.38, ly + logo * 0.28);
  ctx.lineTo(x0 + logo * 0.74, ly + logo * 0.5);
  ctx.lineTo(x0 + logo * 0.38, ly + logo * 0.72);
  ctx.closePath();
  ctx.fill();
  ctx.shadowColor = "rgba(0, 0, 0, 0.6)";
  ctx.shadowBlur = unit * 0.3;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#ffffff";
  ctx.font = `800 ${unit.toFixed(1)}px "Montserrat", "Rubik", sans-serif`;
  const tx = x0 + logo + gap;
  ctx.fillText(title, tx, sub ? cy - unit * 0.28 : cy);
  if (sub) {
    ctx.font = `600 ${(unit * 0.5).toFixed(1)}px "Montserrat", "Rubik", sans-serif`;
    ctx.fillStyle = "rgba(255, 255, 255, 0.92)";
    ctx.fillText(sub, tx, cy + unit * 0.48);
  }
  ctx.restore();
}

function drawWatermark(ctx, wm, time, W, H) {
  if (!wm) return;
  const unit = Math.sqrt(W * H) * 0.034;
  const end = Number(wm.end) || 0;
  const cardFrom = end > 2.5 ? end - 1.1 : Infinity;
  if (time >= cardFrom) {
    // Карточка в конце: затемнение и знак крупно по центру.
    const k = clamp((time - cardFrom) / 0.25, 0, 1);
    ctx.save();
    ctx.globalAlpha = 0.62 * k;
    ctx.fillStyle = "#0b0a0e";
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
    drawWatermarkMark(ctx, { ...wm, sub: wm.sub || "" }, W / 2, H * 0.47, unit * 1.6, k);
    ctx.save();
    ctx.globalAlpha = k;
    ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `600 ${(unit * 0.62).toFixed(1)}px "Montserrat", "Rubik", sans-serif`;
    ctx.fillText(wm.cardText || "Сделано в Reel Lab", W / 2, H * 0.47 + unit * 1.9);
    ctx.restore();
    return;
  }
  const step = Math.floor(Math.max(0, time) / WATERMARK_STEP);
  const local = Math.max(0, time) - step * WATERMARK_STEP;
  // Места, где нет субтитров (полоса блока субтитров приходит из настроек стиля).
  const from = Number(wm.avoidFrom);
  const to = Number(wm.avoidTo);
  let spots = WATERMARK_SPOTS;
  if (Number.isFinite(from) && Number.isFinite(to)) {
    const free = WATERMARK_SPOTS.filter(([, y]) => y < from - 0.05 || y > to + 0.05);
    if (free.length >= 3) spots = free;
  }
  // Обход мест по кругу с шагом, взаимно простым с их числом: соседние шаги
  // всегда в разных местах, за несколько шагов знак побывает везде.
  const stride = spots.length % 3 === 0 ? 5 : 3;
  const spot = spots[(step * stride + watermarkHash(Number(wm.seed) || 0)) % spots.length];
  const fadeIn = clamp(local / WATERMARK_FADE, 0, 1);
  const fadeOut = clamp((WATERMARK_STEP - local) / WATERMARK_FADE, 0, 1);
  const alpha = clamp(Number(wm.opacity ?? 0.62), 0.2, 1) * Math.min(fadeIn, fadeOut);
  if (alpha <= 0.01) return;
  // Медленный дрейф внутри шага: знак не стоит на месте ни одного кадра.
  const drift = local / WATERMARK_STEP - 0.5;
  const cx = spot[0] * W + drift * W * 0.05;
  const cy = spot[1] * H + drift * H * 0.018;
  drawWatermarkMark(ctx, wm, cx, cy, unit, alpha);
}

export function drawPost(ctx, fx, time, W, H) {
  drawTranslation(ctx, fx?.translation, time, W, H);
  drawSignature(ctx, fx?.signature, W, H);
  drawHook(ctx, fx?.hook, time, W, H);
  const flash = flashAt(fx, time);
  if (flash.alpha > 0.005) {
    ctx.save();
    ctx.globalAlpha = flash.alpha;
    ctx.fillStyle = flash.color;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }
  // Водяной знак — поверх всего, его нельзя спрятать под эффектами.
  drawWatermark(ctx, fx?.watermark, time, W, H);
}

// ---------------------------------------------------------------------------
// Человек поверх текста (MediaPipe, работает в браузере)

const VISION_ROOT = "/vendor/mediapipe/";
let visionPromise = null;

async function loadVision() {
  if (!visionPromise) {
    visionPromise = (async () => {
      const module = await import(/* @vite-ignore */ `${VISION_ROOT}vision_bundle.mjs`);
      const fileset = await module.FilesetResolver.forVisionTasks(`${VISION_ROOT}wasm`);
      return { module, fileset };
    })();
    visionPromise.catch(() => { visionPromise = null; });
  }
  return visionPromise;
}

function preferredDelegate() {
  // Без видеокарты (сервер, headless) — процессор; иначе видеокарта.
  return /HeadlessChrome/.test(navigator.userAgent) ? "CPU" : "GPU";
}

/**
 * Находит человека на кадре и отдаёт мягкую маску (белое — человек).
 * Маски сглаживаются во времени, чтобы край не дрожал.
 */
export class PersonMasker {
  constructor() {
    this.segmenter = null;
    this.work = null;
    this.mask = null;
    this.previous = null;
    this.lastTimestamp = 0;
    this.size = 256;
  }

  async init() {
    const { module, fileset } = await loadVision();
    const options = (delegate) => ({
      baseOptions: { modelAssetPath: `${VISION_ROOT}selfie_segmenter.tflite`, delegate },
      runningMode: "VIDEO",
      outputCategoryMask: false,
      outputConfidenceMasks: true,
    });
    try {
      this.segmenter = await module.ImageSegmenter.createFromOptions(fileset, options(preferredDelegate()));
    } catch (_) {
      this.segmenter = await module.ImageSegmenter.createFromOptions(fileset, options("CPU"));
    }
    return this;
  }

  reset() {
    this.previous = null;
  }

  /** drawFrame(ctx, w, h) рисует текущий кадр. Возвращает canvas маски или null. */
  maskFor(drawFrame, aspect) {
    if (!this.segmenter) return null;
    const w = this.size;
    const h = Math.max(32, Math.round(this.size / Math.max(0.3, aspect)));
    if (!this.work || this.work.width !== w || this.work.height !== h) {
      this.work = makeCanvas(w, h);
      this.mask = makeCanvas(w, h);
      this.previous = null;
    }
    const wctx = this.work.getContext("2d", { willReadFrequently: true });
    drawFrame(wctx, w, h);
    // Метки времени для MediaPipe обязаны расти.
    this.lastTimestamp = Math.max(this.lastTimestamp + 1, Math.round(performance.now()));
    let values = null;
    try {
      const result = this.segmenter.segmentForVideo(this.work, this.lastTimestamp);
      const confidence = result?.confidenceMasks?.[0];
      if (confidence) values = confidence.getAsFloat32Array();
      result?.close?.();
    } catch (error) {
      console.warn("[reel-lab] segmentation", error);
      return null;
    }
    if (!values || values.length !== w * h) return null;
    // Буферы живут между кадрами: без новых массивов на каждый кадр нет
    // пауз на уборку памяти посреди просмотра.
    const mctx = this.mask.getContext("2d");
    if (!this.image || this.image.width !== w || this.image.height !== h) {
      this.image = mctx.createImageData(w, h);
      this.pixels = new Uint32Array(this.image.data.buffer);
      this.smooth = new Float32Array(w * h);
      this.previous = null;
    }
    const smooth = this.smooth;
    const pixels = this.pixels;
    const blend = Boolean(this.previous);
    // Белый пиксель с прозрачностью маски (порядок байт RGBA, little-endian).
    const WHITE = 0x00ffffff;
    for (let i = 0; i < values.length; i += 1) {
      // Мягкий порог: уверенность 0.35…0.65 → прозрачность 0…1.
      let v = (values[i] - 0.35) / 0.3;
      v = v < 0 ? 0 : v > 1 ? 1 : v;
      if (blend) v = v * 0.65 + smooth[i] * 0.35;
      smooth[i] = v;
      pixels[i] = WHITE | (Math.round(v * 255) << 24) >>> 0;
    }
    this.previous = smooth;
    mctx.putImageData(this.image, 0, 0);
    return this.mask;
  }
}

/**
 * Маска человека для предпросмотра: нейросеть работает в отдельном потоке
 * (person-worker.js), поэтому видео на странице не дёргается. maskFor()
 * сразу отдаёт последнюю готовую маску (она отстаёт на 1–2 кадра) и, если
 * поток свободен, отправляет ему новый кадр. onUpdate — пришла новая маска
 * (на паузе кадр нужно перерисовать).
 */
export class PreviewPersonMasker {
  constructor({ onUpdate } = {}) {
    this.onUpdate = onUpdate;
    this.worker = null;
    this.ready = null;
    this.busy = false;
    this.latest = null;
    this.sentKey = null;
    this.lastKeyTime = null;
    this.work = null;
    this.size = 256;
    this.id = 0;
    this.resetNext = true;
  }

  init() {
    if (!this.ready) {
      this.ready = new Promise((resolve, reject) => {
        let worker;
        try {
          worker = new Worker("/ready-captions/person-worker.js", { type: "module" });
        } catch (error) {
          reject(error);
          return;
        }
        this.worker = worker;
        const timer = setTimeout(() => reject(new Error("нейросеть не ответила")), 60000);
        worker.onmessage = (event) => {
          const data = event.data || {};
          if (data.type === "ready") {
            clearTimeout(timer);
            this.delegate = data.delegate;
            resolve(this);
          } else if (data.type === "error") {
            clearTimeout(timer);
            reject(new Error(data.message || "нейросеть не загрузилась"));
          } else if (data.type === "mask") {
            this.busy = false;
            this.latest?.close?.();
            this.latest = data.mask;
            this.onUpdate?.();
          } else if (data.type === "skip") {
            this.busy = false;
          }
        };
        worker.onerror = (event) => {
          clearTimeout(timer);
          this.busy = false;
          reject(new Error(event?.message || "поток нейросети упал"));
        };
        worker.postMessage({ type: "init", root: new URL(VISION_ROOT, location.href).href });
      });
      this.ready.catch(() => this.destroy());
    }
    return this.ready;
  }

  reset() {
    this.resetNext = true;
    this.sentKey = null;
    this.latest?.close?.();
    this.latest = null;
  }

  /**
   * drawFrame(ctx, w, h) рисует текущий кадр; key — время кадра (на паузе
   * тот же кадр второй раз не отправляется). Возвращает последнюю маску или null.
   */
  maskFor(drawFrame, aspect, key = null) {
    if (!this.worker || this.busy) return this.latest;
    if (key != null && key === this.sentKey) return this.latest;
    const w = this.size;
    const h = Math.max(32, Math.round(this.size / Math.max(0.3, aspect)));
    if (!this.work || this.work.width !== w || this.work.height !== h) {
      this.work = makeCanvas(w, h);
      this.resetNext = true;
    }
    const ctx = this.work.getContext("2d");
    ctx.clearRect(0, 0, w, h);
    drawFrame(ctx, w, h);
    // Скачок по времени (перемотка) — сглаживание с прошлой маской не нужно.
    if (key != null && this.lastKeyTime != null && (key < this.lastKeyTime || key - this.lastKeyTime > 0.5)) this.resetNext = true;
    this.lastKeyTime = key;
    this.sentKey = key;
    this.busy = true;
    const id = ++this.id;
    const reset = this.resetNext;
    this.resetNext = false;
    const send = (bitmap) => {
      if (!this.worker) {
        bitmap.close?.();
        return;
      }
      this.worker.postMessage({ type: "frame", id, bitmap, reset }, [bitmap]);
    };
    try {
      if (typeof this.work.transferToImageBitmap === "function") send(this.work.transferToImageBitmap());
      else createImageBitmap(this.work).then(send, () => { this.busy = false; });
    } catch (_) {
      this.busy = false;
    }
    return this.latest;
  }

  destroy() {
    this.worker?.terminate();
    this.worker = null;
    this.busy = false;
    this.latest?.close?.();
    this.latest = null;
  }
}

let sharedMasker = null;

/**
 * Одна нейросеть на страницу. Два экземпляра на видеокарте мешают друг другу:
 * второй (сборка ролика при открытом предпросмотре) отдаёт пустые маски.
 * Предпросмотр на время сборки стоит, так что один экземпляр безопасен.
 */
export function sharedPersonMasker() {
  if (!sharedMasker) {
    sharedMasker = new PersonMasker().init().catch((error) => {
      sharedMasker = null;
      throw error;
    });
  }
  return sharedMasker;
}

/** Человек с тем же цветом и движением камеры, что и видео, — поверх субтитров. */
export function drawPersonLayer(ctx, drawFrame, fx, time, W, H, mask, scratch) {
  const layer = scratch.person && scratch.person.width === W && scratch.person.height === H ? scratch.person : (scratch.person = makeCanvas(W, H));
  const lctx = layer.getContext("2d");
  lctx.clearRect(0, 0, W, H);
  drawCameraFrame(lctx, drawFrame, fx, time, W, H);
  lctx.save();
  lctx.globalCompositeOperation = "destination-in";
  lctx.imageSmoothingEnabled = true;
  lctx.imageSmoothingQuality = "high";
  // Маска посчитана по исходному кадру — двигаем её так же, как камеру.
  drawCameraFrame(lctx, (c) => {
    c.filter = "blur(1.5px)";
    c.drawImage(mask, 0, 0, W, H);
  }, { ...fx, filter: "" }, time, W, H);
  lctx.restore();
  ctx.drawImage(layer, 0, 0);
}

// ---------------------------------------------------------------------------
// Лица — центр для автозума

let facePromise = null;
export async function faceDetector() {
  if (!facePromise) {
    facePromise = (async () => {
      const { module, fileset } = await loadVision();
      const options = (delegate) => ({
        baseOptions: { modelAssetPath: `${VISION_ROOT}blaze_face_short_range.tflite`, delegate },
        runningMode: "IMAGE",
        minDetectionConfidence: 0.5,
      });
      try {
        return await module.FaceDetector.createFromOptions(fileset, options(preferredDelegate()));
      } catch (_) {
        return module.FaceDetector.createFromOptions(fileset, options("CPU"));
      }
    })();
    facePromise.catch(() => { facePromise = null; });
  }
  return facePromise;
}

/**
 * Проходит видео с шагом `step` секунд и запоминает центр самого крупного
 * лица (доли кадра). Пропуски заполняются соседними точками.
 */
export async function scanFaces(video, duration, { step = 0.5, onProgress } = {}) {
  const detector = await faceDetector();
  const probe = document.createElement("video");
  probe.muted = true;
  probe.playsInline = true;
  probe.preload = "auto";
  probe.src = video.currentSrc || video.src;
  await new Promise((resolve, reject) => {
    probe.onloadeddata = resolve;
    probe.onerror = () => reject(new Error("Видео не открылось для поиска лица."));
  });
  const w = 320;
  const h = Math.round(w * (probe.videoHeight / Math.max(1, probe.videoWidth)));
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const track = [];
  const total = Math.max(1, Math.floor(duration / step));
  for (let i = 0; i <= total; i += 1) {
    const t = Math.min(duration - 0.05, i * step);
    await new Promise((resolve) => {
      const done = () => { probe.removeEventListener("seeked", done); resolve(); };
      probe.addEventListener("seeked", done);
      probe.currentTime = Math.max(0, t);
    });
    ctx.drawImage(probe, 0, 0, w, h);
    try {
      const result = detector.detect(canvas);
      const faces = (result?.detections || []).map((d) => d.boundingBox).filter(Boolean);
      faces.sort((a, b) => b.width * b.height - a.width * a.height);
      if (faces[0]) {
        const box = faces[0];
        track.push({ t, x: clamp((box.originX + box.width / 2) / w, 0.1, 0.9), y: clamp((box.originY + box.height * 0.45) / h, 0.1, 0.9) });
      }
    } catch (error) {
      console.warn("[reel-lab] face", error);
    }
    onProgress?.(i / total);
  }
  probe.removeAttribute("src");
  probe.load();
  // Сглаживание: камера не дёргается за каждым движением головы.
  return track.map((point, i) => {
    const near = track.slice(Math.max(0, i - 2), i + 3);
    return { t: point.t, x: near.reduce((s, p) => s + p.x, 0) / near.length, y: near.reduce((s, p) => s + p.y, 0) / near.length };
  });
}

// ---------------------------------------------------------------------------
// Подмена сборщика кадра движка на время сборки ролика

let active = null;
const scratch = {};
const originalCompose = LayeredFrameCompositor.prototype.compose;

// Счётчики для диагностики «текста за человеком» в готовом ролике
// (смотреть в консоли: __reelLabFxDebug).
export const fxDebug = { frames: 0, masks: 0, empty: 0, coverage: 0, samples: 0, stacking: {} };
if (typeof globalThis !== "undefined") globalThis.__reelLabFxDebug = fxDebug;

function maskCoverage(mask) {
  try {
    const ctx = mask.getContext("2d", { willReadFrequently: true });
    const data = ctx.getImageData(0, 0, mask.width, mask.height).data;
    let sum = 0;
    for (let i = 3; i < data.length; i += 16) sum += data[i];
    return sum / (data.length / 16) / 255;
  } catch (_) {
    return -1;
  }
}

/**
 * Крайние кадры для переходов при сборке ролика: второй декодер того же видео
 * достаёт кадр в любом месте (основной идёт по порядку и вперёд не заглядывает).
 * Кадры готовятся порциями прямо перед окном перехода и выбрасываются после него.
 */
class ExportFrameGrabber {
  constructor(source, plan) {
    this.source = source;
    this.plan = (plan || []).filter((tr) => tr.blend && tr.aFrame && tr.bFrame);
    this.frames = new Map();
    this.ready = null;
    this.failed = false;
  }

  open() {
    if (!this.ready) {
      this.ready = (async () => {
        this.input = new Input({ source: new BlobSource(this.source), formats: ALL_FORMATS });
        const track = await this.input.getPrimaryVideoTrack();
        if (!track) throw new Error("в файле нет видео");
        this.sink = new VideoSampleSink(track);
      })();
    }
    return this.ready;
  }

  async prepare(times) {
    if (this.failed || !this.plan.length || !times.length) return;
    let lo = Infinity;
    let hi = -Infinity;
    for (const time of times) {
      if (time < lo) lo = time;
      if (time > hi) hi = time;
    }
    const needed = [];
    for (const tr of this.plan) {
      if (tr.m1 < lo - 0.05 || tr.m0 > hi + 0.4) continue;
      needed.push(tr.aFrame.m, tr.bFrame.m);
    }
    for (const key of [...this.frames.keys()]) if (!needed.includes(key) && key < lo - 1) this.frames.delete(key);
    for (const m of needed) {
      if (this.frames.has(m)) continue;
      try {
        await this.open();
        const sample = await this.sink.getSample(Math.max(0, m));
        if (!sample) {
          this.frames.set(m, null);
          continue;
        }
        try {
          const canvas = makeCanvas(sample.displayWidth, sample.displayHeight);
          sample.draw(canvas.getContext("2d"), 0, 0, canvas.width, canvas.height);
          this.frames.set(m, canvas);
        } finally {
          sample.close();
        }
      } catch (error) {
        // Кадр не достался — переход нарисуется через чёрное, ролик соберётся.
        console.warn("[reel-lab] кадр для перехода не получен", error);
        this.failed = true;
        return;
      }
    }
  }

  frameAt(m) {
    return this.frames.get(m) || null;
  }

  close() {
    this.frames.clear();
    try { this.input?.dispose?.(); } catch (_) { /* уже закрыт */ }
  }
}

/** fx — настройки эффектов; masker — PersonMasker (для текста за человеком); source — файл видео (кадры для переходов). */
export function setRenderEffects(fx, masker = null, { source = null } = {}) {
  active?.frames?.close();
  const frames = fx?.transitions?.some((tr) => tr.blend) && source ? new ExportFrameGrabber(source, fx.transitions) : null;
  active = fx ? { fx, masker, frames } : null;
  masker?.reset();
}

export function effectsActive(fx) {
  if (!fx) return false;
  return Boolean(fx.filter || overlaysActive(fx.overlays)
    || fx.zooms?.length || fx.shakes?.length || fx.flashes?.length || fx.behind || fx.hook?.text || fx.signature?.text || fx.translation?.cues?.length || fx.watermark || fx.faces?.length
    || (fx.jumpZoom > 1 && fx.cutPoints?.length) || fx.transitions?.length);
}

// Перед каждой порцией кадров — крайние кадры для переходов, которые сейчас начнутся.
const originalPaint = CaptionsOverlayFramePainter.prototype.paint;
CaptionsOverlayFramePainter.prototype.paint = async function paint(requests) {
  if (active?.frames) await active.frames.prepare(requests.map((request) => Number(request.frame?.timestamp) || 0));
  return originalPaint.call(this, requests);
};

/** Кадр видео с камерой — или кадр перехода на стыке. */
function drawBase(target, drawFrame, fx, time, W, H) {
  const state = transitionAt(fx?.transitions, time);
  if (!state) {
    drawCameraFrame(target, drawFrame, fx, time, W, H);
    return;
  }
  const side = state.live === "A" ? state.tr.bFrame : state.tr.aFrame;
  const frozen = side && active?.frames ? active.frames.frameAt(side.m) : null;
  drawTransition(target, state, {
    drawLive: (ctx) => drawCameraFrame(ctx, drawFrame, fx, time, W, H),
    drawOther: frozen ? (ctx) => drawCameraFrame(ctx, (c) => c.drawImage(frozen, 0, 0, W, H), fx, side.m, W, H) : null,
    W, H, scratch: transitionScratch,
  });
}
const transitionScratch = {};

LayeredFrameCompositor.prototype.compose = function compose(target, request) {
  if (!active) return originalCompose.call(this, target, request);
  const { fx, masker } = active;
  const W = request.width;
  const H = request.height;
  const time = Number(request.frame?.timestamp) || 0;
  const drawFrame = (ctx, w = W, h = H) => request.frame.draw(ctx, 0, 0, w, h);
  drawBase(target, drawFrame, fx, time, W, H);
  if (request.overlay) request.overlay.draw(target, 0, 0, W, H);
  drawUnderlays(target, fx, time, W, H);
  const behind = Boolean(fx.behind && masker && request.captions?.length);
  this.drawCaptions(target, request, CaptionStacking.UNDER_TOP_LAYER);
  if (behind) {
    // Текст за человеком: все слои субтитров — под ним, человек поверх.
    this.drawCaptions(target, request, CaptionStacking.OVER_TOP_LAYER);
    fxDebug.frames += 1;
    for (const caption of request.captions) {
      const key = String(caption.layer?.stacking ?? "?");
      fxDebug.stacking[key] = (fxDebug.stacking[key] || 0) + 1;
    }
    const mask = masker.maskFor(drawFrame, W / H);
    if (mask) {
      fxDebug.masks += 1;
      if (fxDebug.masks % 12 === 1) {
        const value = maskCoverage(mask);
        fxDebug.coverage += Math.max(0, value);
        fxDebug.samples += 1;
        if (value <= 0.002) fxDebug.empty += 1;
      }
      // Человек поверх текста — но не поверх кинополос.
      const bar = barHeight(fx, H);
      target.save();
      if (bar > 0) {
        target.beginPath();
        target.rect(0, bar, W, H - 2 * bar);
        target.clip();
      }
      drawPersonLayer(target, drawFrame, fx, time, W, H, mask, scratch);
      target.restore();
    }
  }
  if (request.topLayer) request.topLayer.draw(target, 0, 0, W, H);
  if (!behind) this.drawCaptions(target, request, CaptionStacking.OVER_TOP_LAYER);
  drawPost(target, fx, time, W, H);
};
