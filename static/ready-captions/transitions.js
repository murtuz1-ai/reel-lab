// Переходы на стыках ролика: растворение, через чёрное и белое, наезд, свайп,
// размытие, засвет, глитч; плавное начало и конец.
//
// Переход стоит на стыке двух кусков ролика и длится 2h секунд по времени
// готового ролика (O): первая половина — ещё идёт кусок A, вторая — уже B.
// Длина ролика от перехода не меняется, поэтому субтитры, музыка и звуки
// остаются там же, где были.
//
// Растворению, свайпу, размытию и засвету нужны оба кадра сразу. У стороны,
// которая сейчас не играет, берётся её крайний кадр: первый кадр B, пока идёт
// A, и последний кадр A, пока идёт B (предпросмотр готовит его отдельным
// <video>, сборка — отдельным декодером). Кадр не успел приготовиться —
// переход рисуется через чёрное: ролик не ломается.
//
// Один и тот же код рисует предпросмотр и готовый ролик.

const EPS = 1e-6;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const smooth = (value) => {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
};
const easeInCubic = (value) => clamp(value, 0, 1) ** 3;
const easeInOutCubic = (value) => {
  const t = clamp(value, 0, 1);
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
};
const easeInOutSine = (value) => -(Math.cos(Math.PI * clamp(value, 0, 1)) - 1) / 2;

/** blend — нужен кадр второй стороны (иначе — через чёрное). d — длина по умолчанию, с. */
export const TRANSITIONS = [
  { id: "none", label: "Без перехода", hint: "Обычная склейка", d: 0, blend: false },
  { id: "dissolve", label: "Растворение", hint: "Один кадр мягко перетекает в другой", d: 0.6, blend: true },
  { id: "black", label: "Через чёрное", hint: "Затемнение и выход из темноты — как в кино", d: 0.7, blend: false },
  { id: "white", label: "Через белое", hint: "Вспышка света между кадрами", d: 0.5, blend: false },
  { id: "zoom", label: "Наезд", hint: "Резкий зум в кадр и выход из следующего", d: 0.45, blend: false },
  { id: "whip", label: "Свайп", hint: "Кадр улетает вбок, следующий влетает — с размытием движения", d: 0.4, blend: true },
  { id: "blur", label: "Размытие", hint: "Кадр расплывается и собирается уже другим", d: 0.6, blend: true },
  { id: "glow", label: "Засвет", hint: "Тёплый блик плёнки проходит через стык", d: 0.8, blend: true },
  { id: "glitch", label: "Глитч", hint: "Цифровые помехи и сдвиг цвета", d: 0.32, blend: false },
];

export const TRANSITION_SPEEDS = { fast: 0.6, normal: 1, slow: 1.5 };
const EDGE_FADE = 0.5;

export function transitionById(id) {
  return TRANSITIONS.find((item) => item.id === id) || TRANSITIONS[0];
}

/** clip — между разными видео (вставки), cut — на склейках внутри видео, edges — плавно начать и закончить. */
export function defaultTransitions() {
  return { clip: "dissolve", cut: "none", speed: "normal", edges: false, custom: {} };
}

export function normaliseTransitions(value) {
  const base = defaultTransitions();
  const source = value && typeof value === "object" ? value : {};
  const known = (id, fallback) => (TRANSITIONS.some((item) => item.id === id) ? id : fallback);
  const custom = {};
  for (const [key, entry] of Object.entries(source.custom && typeof source.custom === "object" ? source.custom : {})) {
    if (typeof key === "string" && key.length < 80 && entry && TRANSITIONS.some((item) => item.id === entry.type)) custom[key] = { type: entry.type };
  }
  return {
    clip: known(source.clip, base.clip),
    cut: known(source.cut, base.cut),
    speed: TRANSITION_SPEEDS[source.speed] ? source.speed : base.speed,
    edges: Boolean(source.edges),
    custom,
  };
}

const round3 = (value) => Math.round(value * 1000) / 1000;

/** Видимые части окна [m0, m1) шкалы M (без вырезанного) и где они в ролике: [mStart, mEnd, oStart]. */
function windowSegs(model, m0, m1) {
  const segs = [];
  let cur = m0;
  for (const range of model.skipsM.ranges) {
    if (range.end <= cur + EPS) continue;
    if (range.start >= m1 - EPS) break;
    if (range.start > cur + EPS) segs.push([cur, range.start, model.toO(cur)]);
    cur = Math.max(cur, range.end);
  }
  if (m1 > cur + EPS) segs.push([cur, m1, model.toO(cur)]);
  return segs;
}

function sideFrame(piece, edge) {
  if (piece.kind === "insert") {
    const item = piece.item;
    const t = edge === "end" ? Math.max(item.in, item.out - 0.03) : Math.min(item.out, item.in + 0.01);
    return { media: item.mediaKey, t, fit: item.fit === "blur" ? "blur" : "cover" };
  }
  const t = edge === "end" ? Math.max(piece.s0, piece.s1 - 0.03) : Math.min(piece.s1, piece.s0 + 0.01);
  return { media: "main", t, fit: "stretch" };
}

/**
 * Все стыки ролика (без настроек), по порядку: между видео («clip» — вставки и
 * видео поверх), склейки внутри видео («cut» — кусок вырезан) и разрезы без
 * вырезанного («split» — тот же кадр продолжается: переход ставится только
 * вручную, на кружке). У стыка: o — где он в ролике, bStart — где начинается
 * сторона B (M), aFrame/bFrame — крайние кадры сторон, row — дорожка ленты.
 */
export function junctionsOf(model) {
  const pieces = model.pieces();
  const result = [];
  for (let i = 0; i + 1 < pieces.length; i += 1) {
    const a = pieces[i];
    const b = pieces[i + 1];
    if (Math.abs(b.o0 - a.o1) > 0.03) continue;
    // Замедленный кусок самого исходника — склейка внутри того же видео, а не стык двух видео.
    const other = (piece) => piece.kind === "insert" && piece.item.mediaKey !== "main";
    const clip = other(a) || other(b);
    const insert = a.kind === "insert" || b.kind === "insert";
    // Разрез без вырезанного: кусок продолжается тем же кадром — стык «split» (переход по желанию).
    const split = !insert && b.m0 - a.m1 < 0.005;
    const key = b.kind === "insert" ? `in:${b.item.id}` : a.kind === "insert" ? `out:${a.item.id}` : `cut:${round3(b.s0)}`;
    result.push({
      key, kind: clip ? "clip" : split ? "split" : "cut", row: "main", o: b.o0, bStart: b.m0,
      aFrame: { m: Math.max(a.m0, a.m1 - 0.02), ...sideFrame(a, "end") },
      bFrame: { m: Math.min(b.m1, b.m0 + 0.005), ...sideFrame(b, "start") },
    });
  }
  // Видео поверх: появляется и уходит — тоже стыки двух видео.
  const mainAt = (m) => ({ m, media: "main", t: model.sourceAt(m) ?? 0, fit: "stretch" });
  for (const place of model.overlays || []) {
    if (!place.visible) continue;
    const item = place.item;
    const fit = item.fit === "blur" ? "blur" : "cover";
    if (place.o0 > 0.05) {
      result.push({
        key: `ovin:${item.id}`, kind: "clip", row: "overlay", o: place.o0, bStart: place.m0,
        aFrame: mainAt(Math.max(0, model.fromOLeft(place.o0) - 0.02)),
        bFrame: { m: place.m0 + 0.005, media: item.mediaKey, t: item.in + 0.01, fit },
      });
    }
    if (place.o1 < model.totalO - 0.05) {
      const aM = Math.max(place.m0, place.m1 - 0.02);
      result.push({
        key: `ovout:${item.id}`, kind: "clip", row: "overlay", o: place.o1, bStart: place.m1,
        aFrame: { m: aM, media: item.mediaKey, t: model.overlayClipTime(place, aM), fit },
        bFrame: mainAt(model.fromO(place.o1) + 0.005),
      });
    }
  }
  result.sort((x, y) => x.o - y.o);
  // Совпавшие стыки (видео поверх кончается ровно на вставке) — один стык.
  return result.filter((junction, index) => index === 0 || junction.o - result[index - 1].o > 0.03);
}

/** Какой переход на стыке: свой (выбран на ленте) или общий для такого стыка. */
export function transitionFor(settings, junction) {
  const custom = settings.custom?.[junction.key];
  if (custom) return custom.type;
  // На простом разрезе переход — только свой (кружок на ленте), общий выбор его не трогает.
  return junction.kind === "clip" ? settings.clip : junction.kind === "split" ? "none" : settings.cut;
}

/**
 * Переходы ролика для предпросмотра и сборки.
 * Каждый: { key, kind, type, h, o, m0, m1, bStart, aFrame, bFrame, segs }:
 *   o — стык (O), h — половина длины, m0..m1 — окно в шкале M,
 *   bStart — где начинается кусок B (M), aFrame/bFrame — крайние кадры сторон
 *   (m — для сборки, media/t/fit — для предпросмотра), segs — шкала O внутри окна.
 */
export function planTransitions(model, value) {
  const settings = normaliseTransitions(value);
  const speed = TRANSITION_SPEEDS[settings.speed] || 1;
  const plan = [];
  if (!model || !(model.totalO > 0.3)) return plan;
  const junctions = junctionsOf(model);
  junctions.forEach((junction, index) => {
    const type = transitionFor(settings, junction);
    const spec = transitionById(type);
    if (!spec.d) return;
    const { o } = junction;
    // Окна соседних стыков не налезают друг на друга: каждое берёт не больше 45% куска до соседнего стыка.
    const prev = index > 0 ? junctions[index - 1].o : 0;
    const next = index + 1 < junctions.length ? junctions[index + 1].o : model.totalO;
    const h = Math.min((spec.d * speed) / 2, (o - prev) * 0.45, (next - o) * 0.45);
    if (h < 0.06) return;
    const m0 = model.fromO(o - h);
    const m1 = model.fromOLeft(o + h);
    plan.push({
      key: junction.key, kind: junction.kind, type, blend: spec.blend, h, o, m0, m1, bStart: junction.bStart,
      aFrame: junction.aFrame, bFrame: junction.bFrame, segs: windowSegs(model, m0, m1),
    });
  });
  if (settings.edges && model.totalO > 1.5) {
    const h = Math.min(EDGE_FADE * speed, model.totalO * 0.2);
    const startM1 = model.fromOLeft(h);
    plan.push({ key: "start", kind: "start", type: "black", blend: false, h, o: 0, m0: model.firstM, m1: startM1, bStart: model.firstM,
      segs: windowSegs(model, model.firstM, startM1) });
    const endM0 = model.fromO(model.totalO - h);
    plan.push({ key: "end", kind: "end", type: "black", blend: false, h, o: model.totalO, m0: endM0, m1: model.totalM + 1, bStart: Infinity,
      segs: windowSegs(model, endM0, model.totalM + 1) });
  }
  return plan.sort((x, y) => x.m0 - y.m0);
}

/** Переход в момент m (M): { tr, k (0…1 по окну), live: "A" | "B", o } или null. */
export function transitionAt(plan, m) {
  if (!plan?.length) return null;
  for (const tr of plan) {
    if (m < tr.m0 - EPS || m >= tr.m1) continue;
    const seg = tr.segs.find((entry) => m >= entry[0] - EPS && m < entry[1] + EPS);
    if (!seg) return null;
    const o = seg[2] + (m - seg[0]);
    let k;
    if (tr.kind === "start") k = clamp(o / tr.h, 0, 1);
    else if (tr.kind === "end") k = clamp((o - (tr.o - tr.h)) / tr.h, 0, 1);
    else k = clamp((o - (tr.o - tr.h)) / (2 * tr.h), 0, 1);
    return { tr, k, live: m < tr.bStart - 1e-4 ? "A" : "B", o };
  }
  return null;
}

/** Переходы, которые скоро начнутся (для подготовки крайних кадров заранее). */
export function transitionsNear(plan, m, ahead = 1.5) {
  return (plan || []).filter((tr) => tr.blend && tr.m1 > m - EPS && tr.m0 < m + ahead);
}

// ---------------------------------------------------------------------------
// Рисование

function makeCanvas(width, height) {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function layer(scratch, name, W, H) {
  let canvas = scratch[name];
  if (!canvas || canvas.width !== W || canvas.height !== H) {
    canvas = makeCanvas(W, H);
    scratch[name] = canvas;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.filter = "none";
  ctx.clearRect(0, 0, W, H);
  return { canvas, ctx };
}

/** Детерминированный «случай»: тот же кадр — тот же глитч в предпросмотре и в ролике. */
function noise(seed, index) {
  let x = Math.imul((seed | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(index + 1, 0xc2b2ae35);
  x ^= x >>> 15;
  x = Math.imul(x, 0x2c1b3c6d);
  x ^= x >>> 12;
  return ((x >>> 0) % 10000) / 10000;
}

function fill(ctx, color, alpha, W, H, mode = "source-over") {
  if (alpha <= 0.002) return;
  ctx.save();
  ctx.globalCompositeOperation = mode;
  ctx.globalAlpha = clamp(alpha, 0, 1);
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
}

/** Картинка, увеличенная вокруг центра. */
function drawScaled(ctx, image, scale, W, H) {
  const w = W * scale;
  const h = H * scale;
  ctx.drawImage(image, (W - w) / 2, (H - h) / 2, w, h);
}

/** Размытие большим радиусом — на уменьшенной копии (в разы быстрее), края — без тёмной рамки. */
function drawBlurred(ctx, image, radius, W, H, scratch) {
  if (radius < 0.8) {
    ctx.drawImage(image, 0, 0, W, H);
    return;
  }
  const factor = radius > 10 ? 4 : radius > 4 ? 2 : 1;
  const w = Math.max(2, Math.round(W / factor));
  const h = Math.max(2, Math.round(H / factor));
  const { canvas, ctx: small } = layer(scratch, "blurSmall", w, h);
  small.drawImage(image, 0, 0, w, h);
  small.filter = `blur(${(radius / factor).toFixed(2)}px)`;
  small.drawImage(image, 0, 0, w, h);
  small.filter = "none";
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(canvas, 0, 0, W, H);
  ctx.restore();
}

/**
 * Кадр поверх с прозрачностью alpha. Сначала — целиком на отдельный холст: иначе
 * чёрная подложка вписанного клипа тоже легла бы полупрозрачной и затемнила кадр под ним.
 */
function withAlpha(ctx, alpha, draw, scratch, W, H) {
  if (alpha <= 0.002) return;
  const { canvas, ctx: own } = layer(scratch, "alpha", W, H);
  draw(own);
  ctx.save();
  ctx.globalAlpha = clamp(alpha, 0, 1) * ctx.globalAlpha;
  ctx.drawImage(canvas, 0, 0, W, H);
  ctx.restore();
}

function drawDip(ctx, st, drawLive, W, H, color) {
  const x = st.k < 0.5 ? st.k * 2 : (1 - st.k) * 2;
  drawLive(ctx);
  fill(ctx, color, smooth(x / 0.9), W, H);
}

/**
 * Кадр перехода. st — из transitionAt; drawLive(ctx) рисует идущий кадр (с камерой),
 * drawOther(ctx) — крайний кадр другой стороны или null, если он ещё не готов.
 */
export function drawTransition(ctx, st, { drawLive, drawOther = null, W, H, scratch = {} }) {
  const { tr, k, live } = st;
  if (tr.kind === "start" || tr.kind === "end") {
    drawLive(ctx);
    fill(ctx, "#000", tr.kind === "start" ? 1 - smooth(k) : smooth(k), W, H);
    return;
  }
  const x = k < 0.5 ? k * 2 : (1 - k) * 2; // 0 на краях окна, 1 на стыке
  const type = tr.blend && !drawOther ? "black" : tr.type;
  const drawA = live === "A" ? drawLive : drawOther;
  const drawB = live === "B" ? drawLive : drawOther;
  switch (type) {
    case "dissolve": {
      const e = smooth(k);
      if (e < 0.999) drawA(ctx);
      if (e >= 0.999) drawB(ctx);
      else withAlpha(ctx, e, drawB, scratch, W, H);
      return;
    }
    case "white": {
      const a = smooth(x / 0.92);
      const { canvas } = layer(scratch, "a", W, H);
      drawLive(canvas.getContext("2d"));
      ctx.save();
      ctx.filter = `brightness(${(1 + 1.3 * a).toFixed(3)})`;
      ctx.drawImage(canvas, 0, 0, W, H);
      ctx.restore();
      fill(ctx, "#fffaf0", a ** 1.4 * 0.96, W, H);
      return;
    }
    case "zoom": {
      const e = easeInCubic(x);
      const { canvas } = layer(scratch, "a", W, H);
      drawLive(canvas.getContext("2d"));
      const scale = 1 + 0.85 * e;
      const steps = e > 0.04 ? 6 : 1;
      ctx.save();
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, W, H);
      // Размытие наезда: средняя из копий всё крупнее (каждая следующая — с долей 1/(i+1)).
      for (let i = 0; i < steps; i += 1) {
        ctx.globalAlpha = 1 / (i + 1);
        drawScaled(ctx, canvas, scale * (1 + 0.055 * e * i), W, H);
      }
      ctx.restore();
      fill(ctx, "#ffffff", Math.max(0, e - 0.55) / 0.45 * 0.32, W, H);
      return;
    }
    case "whip": {
      const e = easeInOutCubic(k);
      const speed = (k < 0.5 ? 12 * k * k : 12 * (1 - k) ** 2) / 3;
      const { canvas, ctx: strip } = layer(scratch, "a", W, H);
      strip.fillStyle = "#000";
      strip.fillRect(0, 0, W, H);
      strip.save();
      strip.translate(-e * W, 0);
      drawA(strip);
      strip.restore();
      strip.save();
      strip.translate((1 - e) * W, 0);
      drawB(strip);
      strip.restore();
      const spread = 0.22 * W * speed;
      const steps = spread > 2 ? 8 : 1;
      ctx.save();
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, W, H);
      for (let i = 0; i < steps; i += 1) {
        ctx.globalAlpha = 1 / (i + 1);
        const offset = steps > 1 ? (i / (steps - 1) - 0.5) * spread : 0;
        ctx.drawImage(canvas, offset, 0, W, H);
      }
      ctx.restore();
      return;
    }
    case "blur": {
      const e = smooth((k - 0.3) / 0.4);
      const radius = 0.024 * H * easeInOutSine(x);
      const { canvas, ctx: mix } = layer(scratch, "a", W, H);
      if (e < 0.999) drawA(mix);
      if (e >= 0.999) drawB(mix);
      else withAlpha(mix, e, drawB, scratch, W, H);
      drawBlurred(ctx, canvas, radius, W, H, scratch);
      return;
    }
    case "glow": {
      const e = smooth((k - 0.25) / 0.5);
      if (e < 0.999) drawA(ctx);
      if (e >= 0.999) drawB(ctx);
      else withAlpha(ctx, e, drawB, scratch, W, H);
      const light = Math.sin(Math.PI * k);
      if (light < 0.01) return;
      const size = Math.max(W, H);
      ctx.save();
      ctx.globalCompositeOperation = "screen";
      const leak = (cx, cy, radius, colors) => {
        const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
        colors.forEach(([stop, color]) => gradient.addColorStop(stop, color));
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, W, H);
      };
      leak(W * (-0.2 + 1.4 * k), H * (0.32 + 0.08 * Math.sin(k * 5)), size * 0.75, [
        [0, `rgba(255, 238, 200, ${(0.95 * light).toFixed(3)})`],
        [0.35, `rgba(255, 168, 76, ${(0.7 * light).toFixed(3)})`],
        [0.7, `rgba(255, 86, 34, ${(0.22 * light).toFixed(3)})`],
        [1, "rgba(0, 0, 0, 0)"],
      ]);
      leak(W * (1.15 - 1.3 * k), H * 0.78, size * 0.5, [
        [0, `rgba(255, 150, 170, ${(0.55 * light).toFixed(3)})`],
        [0.5, `rgba(255, 96, 60, ${(0.25 * light).toFixed(3)})`],
        [1, "rgba(0, 0, 0, 0)"],
      ]);
      ctx.restore();
      fill(ctx, "#ffdcb4", 0.2 * light, W, H, "screen");
      return;
    }
    case "glitch": {
      const power = x ** 1.4;
      const { canvas } = layer(scratch, "a", W, H);
      drawLive(canvas.getContext("2d"));
      ctx.drawImage(canvas, 0, 0, W, H);
      if (power < 0.02) return;
      const seed = Math.floor(st.o * 24);
      // Сдвиг цвета: красная копия вправо, бирюзовая — влево.
      const shift = Math.max(2, 0.018 * W * power);
      for (const [name, color, dx] of [["red", "#ff0000", shift], ["cyan", "#00ffff", -shift]]) {
        const { canvas: tint, ctx: tctx } = layer(scratch, name, W, H);
        tctx.drawImage(canvas, 0, 0, W, H);
        tctx.globalCompositeOperation = "multiply";
        tctx.fillStyle = color;
        tctx.fillRect(0, 0, W, H);
        ctx.save();
        ctx.globalCompositeOperation = "screen";
        ctx.globalAlpha = 0.55 * power;
        ctx.drawImage(tint, dx, 0, W, H);
        ctx.restore();
      }
      // Полосы кадра съезжают вбок.
      const bands = 11;
      const band = H / bands;
      for (let i = 0; i < bands; i += 1) {
        if (noise(seed, i) > 0.2 + 0.5 * power) continue;
        const dx = (noise(seed, i + 40) - 0.5) * 0.2 * W * power;
        const y = Math.floor(i * band + (noise(seed, i + 80) - 0.5) * band * 0.6);
        const h = Math.max(2, Math.floor(band * (0.35 + noise(seed, i + 120) * 0.9)));
        ctx.drawImage(canvas, 0, y, W, h, dx, y, W, h);
      }
      if (noise(seed, 200) > 0.78 && power > 0.5) fill(ctx, "#ffffff", 0.18, W, H);
      return;
    }
    case "black":
    default:
      drawDip(ctx, st, drawLive, W, H, "#000");
  }
}

// ---------------------------------------------------------------------------
// Предпросмотр: крайние кадры сторон (первый кадр B, последний кадр A)

/**
 * Готовит крайние кадры для переходов в предпросмотре: отдельный скрытый
 * <video> на каждый файл перематывается на нужный кадр и рисует его в
 * кадр ролика (с вписыванием, как в сборке). onReady — кадр готов.
 */
export class PreviewFrameGrabber {
  constructor({ urlFor, draw, onReady }) {
    this.urlFor = urlFor;
    this.draw = draw;
    this.onReady = onReady;
    this.cache = new Map();
    this.players = new Map();
    this.queue = [];
    this.size = "";
  }

  keyOf(frame) {
    return `${frame.media}@${frame.t.toFixed(3)}@${frame.fit}`;
  }

  /** Кадр, если готов, иначе null (и просьба приготовить). */
  get(frame, W, H) {
    if (!frame) return null;
    this.resize(W, H);
    const key = this.keyOf(frame);
    const found = this.cache.get(key);
    if (found?.canvas) return found.canvas;
    if (!found) this.want(frame, W, H);
    return null;
  }

  want(frame, W, H) {
    if (!frame) return;
    this.resize(W, H);
    const key = this.keyOf(frame);
    if (this.cache.has(key)) return;
    const url = this.urlFor(frame.media);
    if (!url) return;
    this.cache.set(key, { canvas: null });
    this.queue.push({ key, frame, url, W, H });
    this.pump(url);
  }

  resize(W, H) {
    const size = `${W}x${H}`;
    if (size === this.size) return;
    this.size = size;
    this.cache.clear();
    this.queue = [];
  }

  /** Кадры, которые больше не нужны (оставить только перечисленные). */
  keep(frames) {
    const wanted = new Set(frames.filter(Boolean).map((frame) => this.keyOf(frame)));
    for (const key of this.cache.keys()) if (!wanted.has(key) && this.cache.get(key)?.canvas) this.cache.delete(key);
    if (this.cache.size > 40) this.cache.clear();
  }

  player(url) {
    let entry = this.players.get(url);
    if (!entry) {
      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.preload = "auto";
      video.src = url;
      entry = { video, busy: false };
      this.players.set(url, entry);
    }
    return entry;
  }

  pump(url) {
    const entry = this.player(url);
    if (entry.busy) return;
    const index = this.queue.findIndex((job) => job.url === url);
    if (index < 0) return;
    const [job] = this.queue.splice(index, 1);
    entry.busy = true;
    const video = entry.video;
    const finish = () => {
      entry.busy = false;
      this.pump(url);
    };
    const grab = () => {
      try {
        if (this.size === `${job.W}x${job.H}` && this.cache.has(job.key)) {
          const canvas = makeCanvas(job.W, job.H);
          const ctx = canvas.getContext("2d");
          ctx.fillStyle = "#000";
          ctx.fillRect(0, 0, job.W, job.H);
          if (this.draw(ctx, video, job.W, job.H, job.frame.fit)) {
            this.cache.set(job.key, { canvas });
            this.onReady?.();
          } else this.cache.delete(job.key);
        }
      } catch (_) {
        this.cache.delete(job.key);
      }
      finish();
    };
    const seek = () => {
      const target = Math.max(0, job.frame.t);
      if (Math.abs((video.currentTime || 0) - target) < 0.004 && video.readyState >= 2) {
        grab();
        return;
      }
      const done = () => {
        video.removeEventListener("seeked", done);
        video.removeEventListener("error", fail);
        grab();
      };
      const fail = () => {
        video.removeEventListener("seeked", done);
        video.removeEventListener("error", fail);
        this.cache.delete(job.key);
        finish();
      };
      video.addEventListener("seeked", done);
      video.addEventListener("error", fail);
      video.currentTime = target;
    };
    if (video.readyState >= 1) seek();
    else {
      const ready = () => {
        video.removeEventListener("loadedmetadata", ready);
        seek();
      };
      video.addEventListener("loadedmetadata", ready);
    }
  }

  /** Новое видео — старые кадры и плееры не нужны. */
  reset() {
    for (const { video } of this.players.values()) {
      video.removeAttribute("src");
      video.load();
    }
    this.players.clear();
    this.cache.clear();
    this.queue = [];
  }
}
