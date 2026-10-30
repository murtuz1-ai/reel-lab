// Предпросмотр монтажа: исходное видео, вставки между кусками и видео поверх
// играют как один ролик. Часы предпросмотра — время сборки (M, см. montage.js):
// по нему строятся субтитры, звуки и эффекты, так же как при сборке MP4.
//
// Служебные <video> вставок и наложений не показываются сами — их кадры
// рисуются на холсте эффектов (с вписыванием в кадр), как в готовом ролике.

const PREROLL = 1.2;
const EPS = 1e-4;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * Перемотка без очереди: пока элемент ещё ищет прошлый кадр, новая цель
 * запоминается и ставится после — при протягивании ленты кадр не «залипает».
 */
function setTime(element, t) {
  element._reelTarget = t;
  if (!element.seeking) {
    if (Math.abs((element.currentTime || 0) - t) > 0.004) element.currentTime = t;
    return;
  }
  if (element._reelWaiting) return;
  element._reelWaiting = true;
  element.addEventListener("seeked", () => {
    element._reelWaiting = false;
    const target = element._reelTarget;
    if (Number.isFinite(target) && Math.abs((element.currentTime || 0) - target) > 0.004) setTime(element, target);
  }, { once: true });
}

function applyVolume(element, volume) {
  const value = Math.max(0, Number(volume) || 0);
  element.muted = value <= 0.001;
  element.volume = Math.min(1, value);
}

/** Скорость клипа (замедление, ускорение); голос без «бурундука», как при сборке. */
function applyRate(element, speed) {
  const rate = Number(speed) > 0 ? Number(speed) : 1;
  if (Math.abs((element.playbackRate || 1) - rate) > 1e-3) element.playbackRate = rate;
  if ("preservesPitch" in element && !element.preservesPitch) element.preservesPitch = true;
}

const speedOf = (item) => (Number(item?.speed) > 0 ? Number(item.speed) : 1);

export class MontagePlayer {
  /**
   * main — <video> исходника; host — куда положить служебные <video>;
   * onEvent(type, detail) — play, pause, ended, seek, jump, waiting, playing, frame, error.
   */
  constructor({ main, host, onEvent }) {
    this.main = main;
    this.host = host;
    this.onEvent = onEvent || (() => {});
    this.model = null;
    this.elements = new Map();
    this.playing = false;
    this.segIndex = 0;
    this.prepared = new Set();
    for (const type of ["waiting", "playing"]) {
      main.addEventListener(type, () => { if (this.playing && this.segment()?.kind === "main") this.onEvent(type); });
    }
    main.addEventListener("seeked", () => this.onEvent("frame", { key: "main" }));
    main.addEventListener("loadeddata", () => this.onEvent("frame", { key: "main" }));
  }

  /**
   * Служебный <video> вставки: по два на каждое видео (чередуются). Ролик под музыку —
   * это десятки кадров из 2–5 видео; свой элемент на каждый кадр съел бы память телефона.
   * Следующий кадр того же видео всегда на другом элементе — его можно заранее перемотать.
   */
  insertKey(item) {
    return `insert:${this.slots?.get(item.id) ?? item.id}`;
  }

  /** Новая модель монтажа; позиция в ролике сохраняется по исходнику или по вставке. */
  setModel(model) {
    const where = this.model ? this.locator() : null;
    this.model = model;
    this.slots = new Map();
    const counts = new Map();
    for (const item of model?.inserts || []) {
      const media = item.mediaKey || item.id;
      const n = counts.get(media) || 0;
      counts.set(media, n + 1);
      this.slots.set(item.id, `${media}#${n % 2}`);
    }
    const keep = new Set();
    for (const item of model?.inserts || []) keep.add(this.insertKey(item));
    for (const place of model?.overlays || []) keep.add(`overlay:${place.item.id}`);
    for (const [key, element] of this.elements) {
      if (keep.has(key)) continue;
      element.pause();
      element.removeAttribute("src");
      element.load();
      element.remove();
      this.elements.delete(key);
    }
    this.prepared.clear();
    if (!model) return;
    if (where) this.restore(where);
    else this.segIndex = model.segmentIndexAt(this.main.currentTime || 0);
  }

  /** Убрать всё (новое видео). */
  reset() {
    this.pause();
    this.setModel(null);
    this.segIndex = 0;
  }

  segment() {
    return this.model?.segments[this.segIndex] || null;
  }

  elementFor(item, kind) {
    const key = kind === "insert" ? this.insertKey(item) : `${kind}:${item.id}`;
    let element = this.elements.get(key);
    if (!element) {
      element = document.createElement("video");
      element.className = "montage-media";
      element.playsInline = true;
      element.preload = "auto";
      element.muted = true;
      element.setAttribute("aria-hidden", "true");
      element.addEventListener("seeked", () => this.onEvent("frame", { key }));
      element.addEventListener("loadeddata", () => this.onEvent("frame", { key }));
      element.addEventListener("waiting", () => { if (this.playing && this.activeElement() === element) this.onEvent("waiting"); });
      element.addEventListener("playing", () => { if (this.playing && this.activeElement() === element) this.onEvent("playing"); });
      this.host.append(element);
      this.elements.set(key, element);
    }
    const url = item.media?.url || "";
    if (url && element.dataset.url !== url) {
      element.dataset.url = url;
      element.src = url;
    }
    return element;
  }

  activeElement() {
    const segment = this.segment();
    if (!segment) return this.main;
    return segment.kind === "insert" ? this.elements.get(this.insertKey(segment.item)) || null : this.main;
  }

  /** Время сборки (M) в эту секунду. */
  get time() {
    const segment = this.segment();
    if (!segment) return this.main.currentTime || 0;
    if (segment.kind === "insert") {
      const element = this.elements.get(this.insertKey(segment.item));
      const local = element && Number.isFinite(element.currentTime) ? (element.currentTime - segment.item.in) / speedOf(segment.item) : 0;
      return segment.m0 + clamp(local, 0, segment.item.len);
    }
    const s = this.main.currentTime || 0;
    return segment.m0 + clamp(s - segment.s0, 0, Math.max(0, segment.s1 - segment.s0) + 0.25);
  }

  locator() {
    const segment = this.segment();
    if (segment?.kind === "insert") {
      const element = this.elements.get(this.insertKey(segment.item));
      return { kind: "insert", id: segment.item.id, at: segment.item.at, local: ((element?.currentTime || segment.item.in) - segment.item.in) / speedOf(segment.item) };
    }
    const s = this.main.currentTime || 0;
    const edge = segment && Math.abs(s - segment.s0) < 0.02 ? "start" : segment && Math.abs(s - segment.s1) < 0.02 ? "end" : null;
    return { kind: "main", s, edge };
  }

  restore(where) {
    const model = this.model;
    if (where.kind === "insert") {
      const item = model.inserts.find((entry) => entry.id === where.id);
      if (item) {
        this.seek(item.m0 + clamp(where.local, 0, item.len - 0.01), { quiet: true });
        return;
      }
      this.seek(model.toMLeft(where.at), { quiet: true });
      return;
    }
    const m = where.edge === "start" ? model.toM(where.s) : model.toMLeft(where.s);
    this.segIndex = model.segmentIndexAt(m);
    const segment = this.segment();
    if (segment?.kind === "insert") {
      // Вставку поставили прямо в точку, где стоит бегунок: остаёмся на исходнике перед ней.
      const index = model.segments.findIndex((entry) => entry.kind === "main" && where.s >= entry.s0 - EPS && where.s <= entry.s1 + EPS);
      if (index >= 0) this.segIndex = index;
    }
    this.syncOverlays(this.time, true);
  }

  async play() {
    if (!this.model || this.playing) return;
    const model = this.model;
    let m = this.time;
    if (m >= model.totalM - 0.05 || model.toO(m) >= model.totalO - 0.03) {
      this.seek(model.firstM, { quiet: true });
      m = this.time;
    }
    const skip = model.skipsM.rangeAt(m + 0.02);
    if (skip) this.seek(skip.end >= model.totalM - 0.05 ? model.firstM : skip.end + 0.005, { quiet: true });
    this.playing = true;
    this.onEvent("play");
    await this.startActive();
  }

  async startActive() {
    const segment = this.segment();
    if (!segment) return;
    try {
      if (segment.kind === "insert") {
        if (!this.main.paused) this.main.pause();
        const element = this.elementFor(segment.item, "insert");
        applyVolume(element, segment.item.volume ?? 1);
        applyRate(element, speedOf(segment.item));
        await element.play();
      } else {
        this.pauseKind("insert");
        await this.main.play();
      }
    } catch (error) {
      if (error?.name === "AbortError") return;
      this.onEvent("error", error);
    }
  }

  pause() {
    const was = this.playing;
    this.playing = false;
    if (!this.main.paused) this.main.pause();
    for (const element of this.elements.values()) if (!element.paused) element.pause();
    if (was) this.onEvent("pause");
  }

  pauseKind(kind) {
    for (const [key, element] of this.elements) if (key.startsWith(`${kind}:`) && !element.paused) element.pause();
  }

  /** Перемотка на m (время сборки). */
  seek(m, { quiet = false } = {}) {
    const model = this.model;
    if (!model) {
      setTime(this.main, Math.max(0, m));
      return;
    }
    const target = clamp(m, 0, model.totalM);
    this.segIndex = model.segmentIndexAt(target);
    const segment = this.segment();
    if (segment.kind === "insert") {
      const element = this.elementFor(segment.item, "insert");
      const local = segment.item.in + clamp(target - segment.m0, 0, Math.max(0, segment.item.len - 0.02)) * speedOf(segment.item);
      if (this.playing) {
        if (Math.abs((element.currentTime || 0) - local) > 0.008) element.currentTime = local;
      } else setTime(element, local);
      if (!this.main.paused) this.main.pause();
      for (const [key, other] of this.elements) if (key.startsWith("insert:") && other !== element && !other.paused) other.pause();
      if (this.playing) {
        applyVolume(element, segment.item.volume ?? 1);
        applyRate(element, speedOf(segment.item));
        if (element.paused) element.play().catch((error) => { if (error?.name !== "AbortError") this.onEvent("error", error); });
      }
    } else {
      const s = clamp(segment.s0 + (target - segment.m0), 0, model.duration);
      this.pauseKind("insert");
      if (this.playing) {
        if (Math.abs((this.main.currentTime || 0) - s) > 0.004) this.main.currentTime = s;
      } else setTime(this.main, s);
      if (this.playing && this.main.paused) this.main.play().catch((error) => { if (error?.name !== "AbortError") this.onEvent("error", error); });
    }
    this.syncOverlays(target, true);
    if (!quiet) this.onEvent("seek", { m: target });
  }

  prepareInsert(item) {
    if (this.prepared.has(item.id)) return;
    this.prepared.add(item.id);
    const element = this.elementFor(item, "insert");
    if (Math.abs((element.currentTime || 0) - item.in) > 0.05) element.currentTime = item.in;
  }

  /** Каждый кадр, пока идёт просмотр: переходы между кусками, пропуск вырезанного, наложения. */
  tick() {
    const model = this.model;
    if (!model || !this.playing) return;
    const segment = this.segment();
    if (!segment) return;
    const m = this.time;
    const skip = model.skipsM.rangeAt(m + 0.02);
    if (skip) {
      if (skip.end >= model.totalM - 0.05) this.finish();
      else {
        this.seek(skip.end + 0.005, { quiet: true });
        this.onEvent("jump");
      }
      return;
    }
    const next = model.segments[this.segIndex + 1];
    if (segment.kind === "main") {
      const s = this.main.currentTime || 0;
      if (s >= segment.s1 - 0.012 || this.main.ended) {
        this.advance();
        return;
      }
      if (next?.kind === "insert" && segment.s1 - s < PREROLL) this.prepareInsert(next.item);
    } else {
      const element = this.elements.get(this.insertKey(segment.item));
      if (!element || element.ended || (element.currentTime || 0) >= segment.item.out - 0.02) {
        this.advance();
        return;
      }
      if (next?.kind === "insert" && (segment.item.out - element.currentTime) / speedOf(segment.item) < PREROLL) this.prepareInsert(next.item);
    }
    this.syncOverlays(m, false);
  }

  advance() {
    const model = this.model;
    const index = this.segIndex + 1;
    if (index >= model.segments.length) {
      this.finish();
      return;
    }
    const previous = this.segment();
    this.segIndex = index;
    const segment = this.segment();
    const skip = model.skipsM.rangeAt(segment.m0 + 0.02);
    if (skip) {
      if (skip.end >= model.totalM - 0.05) this.finish();
      else this.seek(skip.end + 0.005, { quiet: true });
      this.onEvent("jump");
      return;
    }
    if (segment.kind === "insert") {
      if (!this.main.paused) this.main.pause();
      if (previous?.kind === "insert") this.elements.get(this.insertKey(previous.item))?.pause();
      const element = this.elementFor(segment.item, "insert");
      if (Math.abs((element.currentTime || 0) - segment.item.in) > 0.05) element.currentTime = segment.item.in;
      applyVolume(element, segment.item.volume ?? 1);
      applyRate(element, speedOf(segment.item));
      element.play().catch((error) => { if (error?.name !== "AbortError") this.onEvent("error", error); });
    } else {
      this.pauseKind("insert");
      if (Math.abs((this.main.currentTime || 0) - segment.s0) > 0.25) this.main.currentTime = segment.s0;
      this.main.play().catch((error) => { if (error?.name !== "AbortError") this.onEvent("error", error); });
    }
    this.prepared.clear();
    this.onEvent("jump");
  }

  finish() {
    this.pause();
    if (this.model) this.seek(this.model.firstM, { quiet: true });
    this.onEvent("ended");
  }

  syncOverlays(m, seeking) {
    const model = this.model;
    if (!model) return;
    const active = new Set();
    const onMain = this.segment()?.kind === "main" && !model.isSkippedM(m);
    for (const place of model.overlays) {
      if (!place.visible) continue;
      const inside = onMain && m >= place.m0 - 0.001 && m < place.m1;
      const soon = this.playing && onMain && place.m0 > m && place.m0 - m < PREROLL;
      if (!inside && !soon && !this.elements.has(`overlay:${place.item.id}`)) continue;
      const element = this.elementFor(place.item, "overlay");
      if (inside) {
        active.add(element);
        const expected = model.overlayClipTime(place, m);
        applyVolume(element, place.item.volume ?? 0);
        applyRate(element, speedOf(place.item));
        if (this.playing) {
          if (element.paused) {
            if (Math.abs((element.currentTime || 0) - expected) > 0.05) element.currentTime = expected;
            element.play().catch(() => {});
          } else if (Math.abs((element.currentTime || 0) - expected) > 0.25 * Math.max(1, speedOf(place.item))) element.currentTime = expected;
        } else {
          if (!element.paused) element.pause();
          if (seeking || Math.abs((element.currentTime || 0) - expected) > 0.04) setTime(element, expected);
        }
      } else if (soon && element.paused && Math.abs((element.currentTime || 0) - place.item.in) > 0.05) {
        element.currentTime = place.item.in;
      }
    }
    for (const [key, element] of this.elements) {
      if (key.startsWith("overlay:") && !active.has(element) && !element.paused) element.pause();
    }
  }

  activeKey() {
    const segment = this.segment();
    return segment?.kind === "insert" ? this.insertKey(segment.item) : "main";
  }

  get peeking() {
    return Boolean(this.peek);
  }

  /** Показать кадр исходника или клипа в момент t, пока тянут край куска (без перемотки ролика). */
  peekAt(kind, item, t) {
    const element = kind === "main" ? this.main : this.elementFor(item, kind);
    if (!this.peek) this.peekRestore = this.time;
    if (this.playing) this.pause();
    this.peek = { element, fit: kind === "main" ? "stretch" : item?.fit === "blur" ? "blur" : "cover" };
    if (kind !== "main" && !this.main.paused) this.main.pause();
    setTime(element, Math.max(0, t));
  }

  clearPeek({ restore = true } = {}) {
    if (!this.peek) return;
    const back = this.peekRestore;
    this.peek = null;
    this.peekRestore = null;
    if (restore && back != null) this.seek(back, { quiet: true });
  }

  /** Есть ли в момент m кадры не из исходника (вставка или видео поверх). */
  hasVisualAt(m = this.time) {
    if (this.peek) return this.peek.element !== this.main;
    if (!this.model) return false;
    if (this.segment()?.kind === "insert") return true;
    return this.model.overlayAt(m).length > 0;
  }

  /** Что рисовать в кадре: основа (исходник или вставка) и видео поверх. */
  frame(m = this.time) {
    if (this.peek) return { base: this.peek, overlays: [] };
    const segment = this.segment();
    const base = segment?.kind === "insert"
      ? { element: this.elementFor(segment.item, "insert"), fit: segment.item.fit === "blur" ? "blur" : "cover" }
      : { element: this.main, fit: "stretch" };
    const overlays = segment?.kind === "insert" || !this.model ? [] : this.model.overlayAt(m).map((place) => ({
      element: this.elementFor(place.item, "overlay"),
      fit: place.item.fit === "blur" ? "blur" : "cover",
    }));
    return { base, overlays };
  }
}

// ---------------------------------------------------------------------------
// Рисование кадра клипа в кадр ролика: «Заполнить» (с обрезкой краёв) или
// «Целиком» (на размытом фоне из того же кадра) — так же собирает сервер.

let blurCanvas = null;

export function drawFitted(ctx, element, W, H, fit) {
  const vw = element?.videoWidth || 0;
  const vh = element?.videoHeight || 0;
  if (!vw || !vh || (element.readyState ?? 0) < 2) return false;
  if (fit === "stretch") {
    ctx.drawImage(element, 0, 0, W, H);
    return true;
  }
  if (fit === "blur") {
    // Фон: кадр, уменьшенный до крошечного и растянутый обратно, — дешёвое размытие.
    if (!blurCanvas) blurCanvas = document.createElement("canvas");
    const bw = 24;
    const bh = Math.max(8, Math.round(bw * H / W));
    if (blurCanvas.width !== bw || blurCanvas.height !== bh) {
      blurCanvas.width = bw;
      blurCanvas.height = bh;
    }
    const bctx = blurCanvas.getContext("2d");
    const cover = Math.max(bw / vw, bh / vh);
    bctx.drawImage(element, (bw - vw * cover) / 2, (bh - vh * cover) / 2, vw * cover, vh * cover);
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(blurCanvas, 0, 0, W, H);
    ctx.fillStyle = "rgba(0, 0, 0, 0.18)";
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
    const scale = Math.min(W / vw, H / vh);
    const w = vw * scale;
    const h = vh * scale;
    ctx.drawImage(element, (W - w) / 2, (H - h) / 2, w, h);
    return true;
  }
  const scale = Math.max(W / vw, H / vh);
  const w = vw * scale;
  const h = vh * scale;
  ctx.drawImage(element, (W - w) / 2, (H - h) / 2, w, h);
  return true;
}
