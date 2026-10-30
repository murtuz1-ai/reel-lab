// Лента монтажа: куски видео в порядке ролика, вставки, видео поверх, слова.
//
// Бегунок стоит в центре, лента едет под ним (как в CapCut): потянул ленту —
// перемотал видео. Нажал на кусок — выделил его; края выделенного тянутся.
// Лента ничего не меняет сама: правки уходят в actions, а новое состояние
// приходит обратно через setDocument().

const ROW = {
  ruler: [0, 18],
  fx: [22, 18],
  overlay: [44, 26],
  main: [74, 54],
  words: [132, 28],
  audio: [164, 26],
};
const HEIGHT = 194;
const HANDLE = 12;
const MIN_PPS = 2;
const MAX_PPS = 480;

const COLORS = {
  bg: "#111014",
  lane: "rgba(255, 255, 255, 0.025)",
  laneLine: "rgba(255, 255, 255, 0.06)",
  text: "#d8d0c6",
  mute: "#8d8698",
  dim: "#5e5868",
  amber: "#f3be5e",
  amberSoft: "rgba(243, 190, 94, 0.18)",
  piece: "#26222c",
  pieceLine: "rgba(255, 255, 255, 0.10)",
  insert: "#8fb3ff",
  overlay: "#b9a9ff",
  audio: "#7fe0c1",
  audioWave: "rgba(127, 224, 193, 0.45)",
  cut: "#ff8a7a",
  wave: "rgba(243, 190, 94, 0.30)",
  waveInsert: "rgba(143, 179, 255, 0.34)",
  word: "rgba(255, 255, 255, 0.07)",
  key: "#c8b8ff",
  playhead: "#f1ebe3",
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function clock(seconds, precise = false) {
  const value = Math.max(0, seconds || 0);
  const m = Math.floor(value / 60);
  const s = value - m * 60;
  return precise ? `${m}:${s.toFixed(1).padStart(4, "0")}` : `${m}:${String(Math.floor(s)).padStart(2, "0")}`;
}

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, radius);
  else ctx.rect(x, y, w, h);
}

// ---------------------------------------------------------------------------
// Кадры для ленты: скрытое <video> перематывается по списку «что сейчас видно».

export class FrameGrabber {
  constructor(url, { height = 96, onFrame } = {}) {
    this.url = url;
    this.height = height;
    this.onFrame = onFrame;
    this.video = null;
    this.ready = null;
    this.times = [];
    this.frames = new Map();
    this.wish = [];
    this.busy = false;
    this.paused = false;
    this.dead = false;
  }

  open() {
    if (!this.ready) {
      const video = document.createElement("video");
      video.muted = true;
      video.preload = "auto";
      video.playsInline = true;
      video.src = this.url;
      this.video = video;
      this.ready = new Promise((resolve, reject) => {
        video.addEventListener("loadeddata", () => resolve(video), { once: true });
        video.addEventListener("error", () => reject(new Error("кадры не читаются")), { once: true });
      });
    }
    return this.ready;
  }

  nearest(t, tolerance = Infinity) {
    const times = this.times;
    if (!times.length) return null;
    let lo = 0;
    let hi = times.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] < t) lo = mid + 1;
      else hi = mid;
    }
    let best = lo;
    if (lo > 0 && Math.abs(times[lo - 1] - t) < Math.abs(times[lo] - t)) best = lo - 1;
    const time = times[best];
    return Math.abs(time - t) <= tolerance ? this.frames.get(time) : null;
  }

  /** Список нужных кадров (самые важные — первыми); старые желания забываются. */
  want(times, tolerance) {
    if (this.dead) return;
    this.wish = times.filter((t) => !this.nearest(t, tolerance));
    this.tolerance = tolerance;
    void this.pump();
  }

  setPaused(paused) {
    this.paused = paused;
    if (!paused) void this.pump();
  }

  async pump() {
    if (this.busy || this.paused || this.dead || !this.wish.length) return;
    this.busy = true;
    const t = this.wish.shift();
    try {
      if (!this.nearest(t, (this.tolerance || 0) * 0.5)) {
        const video = await this.open();
        const target = clamp(t, 0, Math.max(0, (video.duration || t) - 0.04));
        await new Promise((resolve) => {
          const timer = window.setTimeout(resolve, 2500);
          video.addEventListener("seeked", () => { window.clearTimeout(timer); resolve(); }, { once: true });
          video.currentTime = target;
        });
        if (!this.dead && video.videoWidth) {
          const width = Math.max(8, Math.round(this.height * video.videoWidth / video.videoHeight));
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = this.height;
          canvas.getContext("2d").drawImage(video, 0, 0, width, this.height);
          this.store(t, canvas);
          this.onFrame?.();
        }
      }
    } catch (_) {
      this.wish = [];
    } finally {
      this.busy = false;
      if (this.wish.length && !this.paused && !this.dead) window.setTimeout(() => { void this.pump(); }, 0);
    }
  }

  store(t, canvas) {
    let lo = 0;
    let hi = this.times.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.times[mid] < t) lo = mid + 1;
      else hi = mid;
    }
    this.times.splice(lo, 0, t);
    this.frames.set(t, canvas);
    if (this.times.length > 700) {
      // Забываем каждый второй кадр: лента останется заполненной, памяти — вдвое меньше.
      const keep = this.times.filter((_, index) => index % 2 === 0);
      for (const time of this.times) if (!keep.includes(time)) this.frames.delete(time);
      this.times = keep;
    }
  }

  destroy() {
    this.dead = true;
    this.wish = [];
    if (this.video) {
      this.video.removeAttribute("src");
      this.video.load();
    }
    this.frames.clear();
    this.times = [];
  }
}

// ---------------------------------------------------------------------------

export class MontageTimeline {
  /**
   * host — контейнер; actions — что делать с правками:
   *   seek(o), select(selection), edgeLimits(sel, edge) → {min, max},
   *   edgePreview(sel, edge, delta), commitEdge(sel, edge, delta), snapEdge(sel, edge, delta, tolerance),
   *   moveTarget(sel, o) → o, commitMove(sel, o), interacting(bool).
   */
  constructor({ host, actions }) {
    this.host = host;
    this.actions = actions || {};
    this.canvas = document.createElement("canvas");
    this.canvas.className = "timeline-canvas";
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute("role", "slider");
    this.canvas.setAttribute("aria-label", "Лента монтажа: тяни, чтобы перемотать; нажми на кусок, чтобы выделить");
    host.append(this.canvas);
    this.ctx = this.canvas.getContext("2d");
    this.doc = null;
    this.time = 0;
    this.viewO = 0;
    this.pps = 40;
    this.userZoom = false;
    this.selection = null;
    this.drag = null;
    this.pointers = new Map();
    this.media = new Map();
    this.width = 300;
    this.frameRequest = 0;
    this.playing = false;

    this.onPointerDown = this.onPointerDown.bind(this);
    this.onPointerMove = this.onPointerMove.bind(this);
    this.onPointerUp = this.onPointerUp.bind(this);
    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    this.canvas.addEventListener("pointermove", this.onPointerMove);
    this.canvas.addEventListener("pointerup", this.onPointerUp);
    this.canvas.addEventListener("pointercancel", this.onPointerUp);
    this.canvas.addEventListener("lostpointercapture", (event) => { if (this.pointers.has(event.pointerId)) this.onPointerUp(event); });
    this.canvas.addEventListener("wheel", (event) => this.onWheel(event), { passive: false });
    this.canvas.addEventListener("keydown", (event) => this.onKey(event));
    this.canvas.addEventListener("contextmenu", (event) => event.preventDefault());
    this.canvas.addEventListener("pointerleave", () => this.updateHover(null));
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(host);
    }
    this.resize();
  }

  destroy() {
    this.resizeObserver?.disconnect();
    for (const entry of this.media.values()) entry.grabber?.destroy();
    this.media.clear();
    this.canvas.remove();
  }

  // --- Данные ----------------------------------------------------------------

  setDocument(doc) {
    const first = !this.doc;
    this.doc = doc;
    if (this.selection && !this.findSelected(this.selection)) {
      this.selection = null;
      this.actions.select?.(null);
    }
    if (first || !this.userZoom) this.fitZoom();
    this.pps = clamp(this.pps, this.minPps(), MAX_PPS);
    if (!this.drag) this.viewO = this.time;
    this.requestDraw();
  }

  setMedia(key, info) {
    const entry = this.media.get(key) || {};
    if (info.url && entry.url !== info.url) {
      entry.grabber?.destroy();
      entry.grabber = null;
    }
    Object.assign(entry, info);
    this.media.set(key, entry);
    this.requestDraw();
  }

  dropMedia(key) {
    this.media.get(key)?.grabber?.destroy();
    this.media.delete(key);
  }

  grabberFor(key) {
    const entry = this.media.get(key);
    if (!entry?.url) return null;
    if (!entry.grabber) {
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      entry.grabber = new FrameGrabber(entry.url, { height: Math.round(ROW.main[1] * ratio), onFrame: () => this.requestDraw() });
      entry.grabber.setPaused(this.playing);
    }
    return entry.grabber;
  }

  setPlaying(playing) {
    this.playing = playing;
    for (const entry of this.media.values()) entry.grabber?.setPaused(playing);
  }

  setTime(o) {
    this.time = o;
    if (!this.drag || this.drag.mode === "pinch") this.viewO = o;
    this.requestDraw();
  }

  setSelection(selection) {
    this.selection = selection;
    this.requestDraw();
  }

  // --- Масштаб ---------------------------------------------------------------

  minPps() {
    const total = this.doc?.totalO || 0;
    return total > 0 ? clamp((this.width * 0.8) / total, MIN_PPS, MAX_PPS) : MIN_PPS;
  }

  fitZoom() {
    // На экране — около 12 секунд ролика, а короткий ролик целиком.
    const total = this.doc?.totalO || 12;
    this.pps = clamp(Math.max(this.width / 12, (this.width * 0.8) / Math.max(1, total)), this.minPps(), MAX_PPS);
  }

  zoomBy(factor) {
    this.userZoom = true;
    this.pps = clamp(this.pps * factor, this.minPps(), MAX_PPS);
    this.requestDraw();
  }

  resize() {
    const rect = this.host.getBoundingClientRect();
    const width = Math.max(120, Math.round(rect.width));
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    if (width === this.width && this.canvas.width === Math.round(width * ratio)) return;
    this.width = width;
    this.canvas.width = Math.round(width * ratio);
    this.canvas.height = Math.round(HEIGHT * ratio);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${HEIGHT}px`;
    this.ratio = ratio;
    if (!this.userZoom) this.fitZoom();
    this.requestDraw();
  }

  // --- Геометрия -------------------------------------------------------------

  x(o) {
    return this.width / 2 + (o - this.viewO) * this.pps;
  }

  o(x) {
    return this.viewO + (x - this.width / 2) / this.pps;
  }

  rowAt(y) {
    for (const [name, [top, height]] of Object.entries(ROW)) {
      if (y >= top - 3 && y <= top + height + 3) return name;
    }
    return null;
  }

  findSelected(selection) {
    const doc = this.doc;
    if (!doc || !selection) return null;
    if (selection.kind === "piece" || selection.kind === "insert") return doc.pieces.find((piece) => piece.key === selection.key) || null;
    if (selection.kind === "overlay") return doc.overlays.find((item) => item.key === selection.key) || null;
    if (selection.kind === "audio") return (doc.audios || []).find((item) => item.key === selection.key) || null;
    if (selection.kind === "junction") return doc.junctions.find((item) => item.key === selection.key) || null;
    if (selection.kind === "transition") return (doc.transitions || []).find((item) => item.key === selection.key) || null;
    if (selection.kind === "fx") return (doc.fx || []).find((item) => item.key === selection.key) || null;
    if (selection.kind === "words") {
      const words = doc.words.filter((word) => word.w >= selection.w0 && word.w <= selection.w1);
      return words.length ? { o0: words[0].o0, o1: words[words.length - 1].o1, words } : null;
    }
    return null;
  }

  /** Отрезок выделенного на ленте (с учётом края, который сейчас тянут). */
  selectedSpan() {
    const found = this.findSelected(this.selection);
    if (!found) return null;
    let { o0, o1 } = found;
    if (found.o !== undefined) {
      o0 = found.o;
      o1 = found.o;
    }
    const drag = this.drag;
    if (drag?.mode === "edge") {
      if (drag.edge === "left") o0 += drag.delta;
      else o1 += drag.delta;
    }
    return { o0, o1, found };
  }

  /** Кружок перехода под точкой (по центру дорожки на стыке) в пределах радиуса. */
  transitionHit(x, y, row, radius) {
    const [top, height] = ROW[row];
    for (const item of this.doc?.transitions || []) {
      if ((item.row || "main") === row && Math.hypot(this.x(item.o) - x, y - (top + height / 2)) <= radius) return { type: "transition", key: item.key };
    }
    return null;
  }

  hitTest(x, y) {
    const doc = this.doc;
    if (!doc) return null;
    const row = this.rowAt(y);
    const o = this.o(x);
    const tolerance = 10 / this.pps;
    // Края выделенного — первыми.
    const span = this.selectedSpan();
    const kind = this.selection?.kind;
    // …но сам кружок перехода на стыке у выделенного куска — важнее его ручки: иначе на разрезе
    // рядом с выделенным куском кружок не нажать. Ручка ловится выше и ниже кружка.
    if (span && kind && kind !== "transition" && (row === "main" || row === "overlay")) {
      const circle = this.transitionHit(x, y, row, 14);
      if (circle) return circle;
    }
    if (span && kind && kind !== "junction" && kind !== "fx" && kind !== "transition") {
      const targetRow = kind === "overlay" ? "overlay" : kind === "words" ? "words" : kind === "audio" ? "audio" : "main";
      if (row === targetRow) {
        const left = this.x(span.o0);
        const right = this.x(span.o1);
        // Узкое выделение (слово) — ручки снаружи, иначе — внутри краёв.
        const narrow = right - left < HANDLE * 3;
        const zoneLeft = narrow ? [left - HANDLE - 8, left + 2] : [left - 6, left + HANDLE + 4];
        const zoneRight = narrow ? [right - 2, right + HANDLE + 8] : [right - HANDLE - 4, right + 6];
        if (x >= zoneLeft[0] && x <= zoneLeft[1]) return { type: "edge", edge: "left" };
        if (x >= zoneRight[0] && x <= zoneRight[1]) return { type: "edge", edge: "right" };
      }
    }
    if (row === "ruler") return { type: "ruler", o };
    if (row === "fx") {
      const pad = 6 / this.pps;
      const item = (doc.fx || []).slice().reverse().find((entry) => o >= entry.o0 - pad && o <= Math.max(entry.o1, entry.o0 + 14 / this.pps) + pad);
      if (item) return { type: "fx", key: item.key, o };
      return { type: "empty", o };
    }
    if (row === "main" || row === "overlay") {
      // Стык двух видео: значок перехода сверху на дорожке.
      const [top] = ROW[row];
      // На телефоне палец толще мыши — ромбик ловится шире.
      if (this.coarse === undefined) this.coarse = Boolean(globalThis.matchMedia?.("(pointer: coarse)").matches);
      const reach = this.coarse ? 16 : 9;
      const circle = this.transitionHit(x, y, row, reach + 4);
      if (circle) return circle;
    }
    if (row === "main") {
      for (const junction of doc.junctions) {
        if (Math.abs(this.x(junction.o) - x) <= 7) return { type: "junction", key: junction.key };
      }
      const piece = doc.pieces.find((item) => o >= item.o0 && o < item.o1);
      if (piece) return { type: piece.kind === "insert" ? "insert" : "piece", key: piece.key, o };
      return { type: "empty", o };
    }
    if (row === "overlay") {
      const item = doc.overlays.find((entry) => o >= entry.o0 && o < entry.o1);
      if (item) return { type: "overlay", key: item.key, o };
      return { type: "empty", o };
    }
    if (row === "audio") {
      const item = (doc.audios || []).slice().reverse().find((entry) => o >= entry.o0 && o < entry.o1);
      if (item) return { type: "audio", key: item.key, o };
      return { type: "empty", o };
    }
    if (row === "words") {
      const word = doc.words.find((entry) => o >= entry.o0 - tolerance * 0.3 && o <= entry.o1 + tolerance * 0.3);
      if (word) return { type: "word", w: word.w, o };
      return { type: "empty", o };
    }
    return { type: "empty", o };
  }

  // --- Жесты -----------------------------------------------------------------

  onPointerDown(event) {
    if (!this.doc) return;
    this.canvas.focus({ preventScroll: true });
    this.canvas.setPointerCapture(event.pointerId);
    const rect = this.canvas.getBoundingClientRect();
    const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    this.pointers.set(event.pointerId, point);
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.drag = { mode: "pinch", distance: Math.max(20, Math.abs(a.x - b.x)), pps: this.pps };
      return;
    }
    if (this.pointers.size > 2) return;
    const hit = this.hitTest(point.x, point.y);
    this.drag = { mode: "press", hit, start: point, viewO: this.viewO, moved: false, pointerId: event.pointerId };
    if (hit?.type === "edge") {
      const limits = this.actions.edgeLimits?.(this.selection, hit.edge) || { min: -Infinity, max: Infinity };
      this.drag = { mode: "edge", edge: hit.edge, start: point, delta: 0, limits, pointerId: event.pointerId };
      this.actions.interacting?.(true);
    }
  }

  /** Мышь над кружком перехода: он подсвечивается и подписывается, курсор — «рука». */
  updateHover(event) {
    let key = null;
    if (event) {
      const rect = this.canvas.getBoundingClientRect();
      const hit = this.hitTest(event.clientX - rect.left, event.clientY - rect.top);
      key = hit?.type === "transition" ? hit.key : null;
    }
    this.canvas.style.cursor = key ? "pointer" : "";
    if (key !== this.hoverKey) {
      this.hoverKey = key;
      this.requestDraw();
    }
  }

  onPointerMove(event) {
    if (!this.pointers.has(event.pointerId)) {
      if (event.pointerType === "mouse") this.updateHover(event);
      return;
    }
    const rect = this.canvas.getBoundingClientRect();
    const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    this.pointers.set(event.pointerId, point);
    const drag = this.drag;
    if (!drag) return;
    if (drag.mode === "pinch") {
      if (this.pointers.size < 2) return;
      const [a, b] = [...this.pointers.values()];
      const distance = Math.max(20, Math.abs(a.x - b.x));
      this.userZoom = true;
      this.pps = clamp(drag.pps * (distance / drag.distance), this.minPps(), MAX_PPS);
      this.requestDraw();
      return;
    }
    if (event.pointerId !== drag.pointerId) return;
    const dx = point.x - drag.start.x;
    if (drag.mode === "press") {
      if (Math.abs(dx) < 6 && Math.abs(point.y - drag.start.y) < 8) return;
      const hit = drag.hit;
      const movable = (hit?.type === "insert" || hit?.type === "overlay" || hit?.type === "audio" || (hit?.type === "fx" && hit.key.startsWith("z:")))
        && this.selection?.key === hit.key;
      if (movable) {
        this.drag = { mode: "move", hit, start: drag.start, target: null, pointerId: drag.pointerId, grab: hit.o - (this.findSelected(this.selection)?.o0 ?? hit.o) };
        this.actions.interacting?.(true);
      } else {
        this.drag = { mode: "scrub", start: drag.start, viewO: drag.viewO, pointerId: drag.pointerId };
        this.actions.interacting?.(true);
      }
      this.onPointerMove(event);
      return;
    }
    if (drag.mode === "scrub") {
      this.viewO = clamp(drag.viewO - dx / this.pps, 0, this.doc.totalO);
      this.time = this.viewO;
      this.actions.seek?.(this.viewO);
      this.requestDraw();
      return;
    }
    if (drag.mode === "edge") {
      let delta = clamp(dx / this.pps, drag.limits.min, drag.limits.max);
      if (this.actions.snapEdge) delta = clamp(this.actions.snapEdge(this.selection, drag.edge, delta, 8 / this.pps), drag.limits.min, drag.limits.max);
      drag.delta = delta;
      this.actions.edgePreview?.(this.selection, drag.edge, delta);
      this.requestDraw();
      return;
    }
    if (drag.mode === "move") {
      const o = this.o(point.x) - drag.grab;
      drag.target = this.actions.moveTarget ? this.actions.moveTarget(this.selection, o) : o;
      drag.pointerO = o;
      this.requestDraw();
    }
  }

  onPointerUp(event) {
    if (!this.pointers.has(event.pointerId)) return;
    this.pointers.delete(event.pointerId);
    const drag = this.drag;
    if (!drag) return;
    if (drag.mode === "pinch") {
      if (this.pointers.size === 0) this.drag = null;
      return;
    }
    if (event.pointerId !== drag.pointerId) return;
    this.drag = null;
    if (drag.mode === "press") this.tap(drag.hit, event);
    else if (drag.mode === "edge") {
      if (Math.abs(drag.delta) > 0.004) this.actions.commitEdge?.(this.selection, drag.edge, drag.delta);
      this.viewO = this.time;
      this.actions.interacting?.(false);
    } else if (drag.mode === "move") {
      if (drag.target != null) this.actions.commitMove?.(this.selection, drag.target);
      this.actions.interacting?.(false);
    } else if (drag.mode === "scrub") {
      this.actions.interacting?.(false);
    }
    this.requestDraw();
  }

  tap(hit, event) {
    if (!hit) return;
    if (hit.type === "ruler" || hit.type === "empty") {
      if (hit.type === "ruler") {
        this.actions.seek?.(clamp(hit.o, 0, this.doc.totalO));
      }
      this.select(null);
      return;
    }
    if (hit.type === "piece" || hit.type === "insert" || hit.type === "overlay" || hit.type === "audio" || hit.type === "junction" || hit.type === "fx" || hit.type === "transition") {
      const kind = hit.type;
      const same = this.selection?.kind === kind && this.selection.key === hit.key;
      this.select(same ? null : { kind, key: hit.key });
      return;
    }
    if (hit.type === "word") {
      const current = this.selection?.kind === "words" ? this.selection : null;
      if (current && event?.shiftKey) {
        this.select({ kind: "words", w0: Math.min(current.w0, hit.w), w1: Math.max(current.w1, hit.w) });
      } else if (current && current.w0 === hit.w && current.w1 === hit.w) {
        this.select(null);
      } else {
        this.select({ kind: "words", w0: hit.w, w1: hit.w });
      }
    }
  }

  select(selection) {
    this.selection = selection;
    this.actions.select?.(selection);
    this.requestDraw();
  }

  onWheel(event) {
    if (!this.doc) return;
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      this.zoomBy(Math.exp(-event.deltaY * 0.01));
      return;
    }
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    const o = clamp(this.viewO + delta / this.pps, 0, this.doc.totalO);
    this.viewO = o;
    this.time = o;
    this.actions.seek?.(o);
    this.requestDraw();
  }

  onKey(event) {
    if (!this.doc) return;
    const step = event.shiftKey ? 1 : 1 / 30;
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      const o = clamp(this.time + (event.key === "ArrowRight" ? step : -step), 0, this.doc.totalO);
      this.actions.seek?.(o);
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      this.actions.remove?.();
    } else if ((event.key === "s" || event.key === "ы") && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      this.actions.split?.();
    } else if (event.key === "Escape") {
      this.select(null);
    } else if (event.key === "+" || event.key === "=") {
      this.zoomBy(1.4);
    } else if (event.key === "-") {
      this.zoomBy(1 / 1.4);
    }
  }

  // --- Рисование -------------------------------------------------------------

  requestDraw() {
    if (this.frameRequest) return;
    this.frameRequest = requestAnimationFrame(() => {
      this.frameRequest = 0;
      this.draw();
    });
  }

  draw() {
    const ctx = this.ctx;
    const ratio = this.ratio || 1;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, this.width, HEIGHT);
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, this.width, HEIGHT);
    const doc = this.doc;
    if (!doc || !(doc.totalO > 0)) {
      ctx.fillStyle = COLORS.mute;
      ctx.font = "500 13px Rubik, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("Загрузи видео — здесь появится лента монтажа", this.width / 2, HEIGHT / 2);
      return;
    }
    const visible = [this.o(-40), this.o(this.width + 40)];
    this.drawLanes(ctx, doc);
    this.drawRuler(ctx, doc, visible);
    this.drawBeatLines(ctx, doc, visible);
    this.drawEffects(ctx, doc, visible);
    this.drawOverlays(ctx, doc, visible);
    this.drawPieces(ctx, doc, visible);
    this.drawWords(ctx, doc, visible);
    this.drawAudios(ctx, doc, visible);
    this.drawJunctions(ctx, doc, visible);
    this.drawTransitions(ctx, doc, visible);
    this.drawBeats(ctx, doc, visible);
    this.drawSelection(ctx, doc);
    this.drawMoveGhost(ctx, doc);
    this.drawPlayhead(ctx);
  }

  drawLanes(ctx, doc) {
    const start = this.x(0);
    const end = this.x(doc.totalO);
    for (const name of ["fx", "overlay", "main", "words", "audio"]) {
      const [top, height] = ROW[name];
      ctx.fillStyle = COLORS.lane;
      ctx.fillRect(0, top, this.width, height);
      // Тёмные поля до начала и после конца ролика.
      ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
      if (start > 0) ctx.fillRect(0, top, start, height);
      if (end < this.width) ctx.fillRect(end, top, this.width - end, height);
    }
    ctx.fillStyle = COLORS.dim;
    ctx.font = "500 11px Rubik, system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    if (!doc.overlays.length) {
      const [top, height] = ROW.overlay;
      ctx.fillText("Поверх видео", Math.max(8, start + 8), top + height / 2);
    }
    if (!(doc.fx || []).length) {
      const [top, height] = ROW.fx;
      ctx.fillText("Зум, хук, картинки ИИ", Math.max(8, start + 8), top + height / 2);
    }
    if (!(doc.audios || []).length) {
      const [top, height] = ROW.audio;
      ctx.fillText("Музыка и звуки — кнопка «Музыка / звук»", Math.max(8, start + 8), top + height / 2);
    }
  }

  drawRuler(ctx, doc, [from, to]) {
    const [top, height] = ROW.ruler;
    const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
    const step = steps.find((value) => value * this.pps >= 70) || 300;
    const minor = step / (step >= 1 && step <= 2 ? 4 : 5);
    ctx.strokeStyle = COLORS.laneLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const first = Math.max(0, Math.floor(from / minor) * minor);
    for (let t = first; t <= Math.min(to, doc.totalO); t += minor) {
      const x = Math.round(this.x(t)) + 0.5;
      const major = Math.abs(t / step - Math.round(t / step)) < 1e-6;
      ctx.moveTo(x, top + height - (major ? 7 : 3));
      ctx.lineTo(x, top + height);
    }
    ctx.stroke();
    ctx.fillStyle = COLORS.mute;
    ctx.font = "500 10.5px Rubik, system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    const precise = step < 1;
    for (let t = Math.max(0, Math.floor(from / step) * step); t <= Math.min(to, doc.totalO); t += step) {
      ctx.fillText(clock(t, precise), Math.round(this.x(t)) + 3, top + 1);
    }
  }

  /** Доли музыки: отметки под линейкой (сильная доля — крупнее). Видно, куда ставить склейку. */
  drawBeats(ctx, doc, [from, to]) {
    const beats = doc.beats;
    if (!beats?.length) return;
    const [top, height] = ROW.ruler;
    const gap = beats.length > 1 ? (beats[beats.length - 1].o - beats[0].o) / (beats.length - 1) : 1;
    const dense = gap * this.pps < 6;
    if (dense && gap * 4 * this.pps < 6) return;
    for (const beat of beats) {
      if (beat.o < from || beat.o > to) continue;
      if (dense && !beat.strong) continue;
      const x = Math.round(this.x(beat.o));
      ctx.fillStyle = beat.strong ? COLORS.amber : "rgba(243, 190, 94, 0.55)";
      const h = beat.strong ? 7 : 4;
      ctx.fillRect(x - (beat.strong ? 1 : 0.5), top + height - h, beat.strong ? 2 : 1, h);
    }
  }

  /** Сильные доли — тонкие линии через дорожки, когда лента крупная. */
  drawBeatLines(ctx, doc, [from, to]) {
    const beats = doc.beats;
    if (!beats?.length) return;
    const gap = beats.length > 1 ? (beats[beats.length - 1].o - beats[0].o) / (beats.length - 1) : 1;
    if (gap * 4 * this.pps < 28) return;
    ctx.save();
    ctx.strokeStyle = "rgba(243, 190, 94, 0.16)";
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    for (const beat of beats) {
      if (!beat.strong || beat.o < from || beat.o > to) continue;
      const x = Math.round(this.x(beat.o)) + 0.5;
      ctx.moveTo(x, ROW.fx[0]);
      ctx.lineTo(x, ROW.main[0] + ROW.main[1]);
    }
    ctx.stroke();
    ctx.restore();
  }

  /** Плитки кадров клипа в прямоугольнике отрезка ленты. */
  drawThumbs(ctx, mediaKey, o0, o1, timeAt, top, height, fallbackAspect) {
    const entry = this.media.get(mediaKey);
    const aspect = entry?.aspect || fallbackAspect || 9 / 16;
    const tileW = Math.max(18, height * aspect);
    const tileDur = tileW / this.pps;
    const x0 = this.x(o0);
    const x1 = this.x(o1);
    const visibleFrom = Math.max(o0, this.o(-tileW));
    const visibleTo = Math.min(o1, this.o(this.width + tileW));
    if (visibleTo <= visibleFrom) return;
    const grabber = this.grabberFor(mediaKey);
    const wanted = [];
    const first = Math.floor(visibleFrom / tileDur) * tileDur;
    for (let t = first; t < visibleTo; t += tileDur) {
      const tileStart = Math.max(o0, t);
      const mediaTime = timeAt(tileStart + Math.min(tileDur, o1 - tileStart) * 0.3);
      const x = this.x(t);
      const frame = grabber?.nearest(mediaTime, Math.max(tileDur * 1.5, 0.5));
      if (frame) {
        ctx.drawImage(frame, Math.round(x), top, Math.ceil(tileW) + 1, height);
      } else {
        ctx.fillStyle = "rgba(255, 255, 255, 0.04)";
        ctx.fillRect(Math.round(x) + 1, top + 1, Math.ceil(tileW) - 2, height - 2);
      }
      if (!grabber?.nearest(mediaTime, tileDur * 0.6)) wanted.push(mediaTime);
    }
    if (grabber && wanted.length) {
      const center = timeAt(clamp(this.time, o0, o1));
      wanted.sort((a, b) => Math.abs(a - center) - Math.abs(b - center));
      grabber.want(wanted.slice(0, 40), tileDur * 0.6);
    }
    void x0;
    void x1;
  }

  drawPieces(ctx, doc, [from, to]) {
    const [top, height] = ROW.main;
    for (const piece of doc.pieces) {
      if (piece.o1 < from || piece.o0 > to) continue;
      let x0 = this.x(piece.o0) + 1;
      let x1 = this.x(piece.o1) - 1;
      if (x1 - x0 < 1) x1 = x0 + 1;
      const insert = piece.kind === "insert";
      ctx.save();
      roundRect(ctx, x0, top, x1 - x0, height, 7);
      ctx.fillStyle = COLORS.piece;
      ctx.fill();
      ctx.clip();
      const timeAt = insert
        ? (o) => piece.clipStart + (o - piece.o0) * (piece.speed || 1)
        : (o) => piece.s0 + (o - piece.o0);
      this.drawThumbs(ctx, piece.mediaKey, piece.o0, piece.o1, timeAt, top, height, piece.aspect);
      // Затемнение снизу — под подпись вставки.
      if (insert && x1 - x0 > 40) {
        const gradient = ctx.createLinearGradient(0, top + height * 0.45, 0, top + height);
        gradient.addColorStop(0, "rgba(10, 12, 20, 0)");
        gradient.addColorStop(1, "rgba(10, 12, 20, 0.85)");
        ctx.fillStyle = gradient;
        ctx.fillRect(x0, top, x1 - x0, height);
        ctx.fillStyle = "#e6edff";
        ctx.font = "600 10.5px Rubik, system-ui, sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "bottom";
        // Подпись прилипает к видимому началу куска, если он уехал за левый край ленты.
        const lx0 = Math.max(x0, 0);
        ctx.fillText(this.fitText(ctx, `▶ ${piece.label || "Вставка"}`, x1 - lx0 - 12), lx0 + 6, top + height - 5);
      }
      ctx.restore();
      roundRect(ctx, x0 + 0.5, top + 0.5, x1 - x0 - 1, height - 1, 7);
      ctx.strokeStyle = insert ? COLORS.insert : COLORS.pieceLine;
      ctx.lineWidth = insert ? 1.5 : 1;
      ctx.stroke();
    }
  }

  /** Работа ИИ над кадром: зумы, хук, картинки — видно, где, и можно поправить. */
  drawEffects(ctx, doc, [from, to]) {
    const [top, height] = ROW.fx;
    const selected = this.selection?.kind === "fx" ? this.selection.key : null;
    for (const item of doc.fx || []) {
      if (item.o1 < from || item.o0 > to) continue;
      const isSelected = item.key === selected;
      const x0 = this.x(item.o0);
      const x1 = Math.max(x0 + 14, this.x(item.o1));
      if (item.kind === "picture") {
        // Картинка ИИ — маленькое превью в момент слова.
        const size = height - 2;
        roundRect(ctx, x0, top + 1, size, size, 4);
        ctx.fillStyle = "#2a2536";
        ctx.fill();
        if (item.image) {
          ctx.save();
          roundRect(ctx, x0, top + 1, size, size, 4);
          ctx.clip();
          const w = item.image.width || 1;
          const h = item.image.height || 1;
          const scale = Math.max(size / w, size / h);
          ctx.drawImage(item.image, x0 + (size - w * scale) / 2, top + 1 + (size - h * scale) / 2, w * scale, h * scale);
          ctx.restore();
        }
        roundRect(ctx, x0 + 0.5, top + 1.5, size - 1, size - 1, 4);
        ctx.strokeStyle = isSelected ? COLORS.amber : item.status === "error" ? COLORS.cut : "rgba(185, 169, 255, 0.8)";
        ctx.lineWidth = isSelected ? 2 : 1;
        ctx.stroke();
        continue;
      }
      roundRect(ctx, x0, top + 2, x1 - x0, height - 4, 6);
      if (item.kind === "hook") ctx.fillStyle = isSelected ? COLORS.amber : "rgba(255, 124, 196, 0.32)";
      else ctx.fillStyle = isSelected ? COLORS.amber : item.manual ? "rgba(243, 190, 94, 0.55)" : "rgba(243, 190, 94, 0.22)";
      ctx.fill();
      ctx.strokeStyle = item.kind === "hook" ? "rgba(255, 124, 196, 0.85)" : "rgba(243, 190, 94, 0.85)";
      ctx.lineWidth = 1;
      ctx.stroke();
      if (x1 - x0 > 22) {
        ctx.fillStyle = isSelected ? "#2a1d05" : "#f4e9d4";
        ctx.font = "600 10px Rubik, system-ui, sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        const lx0 = Math.max(x0, 0);
        const room = x1 - lx0 - 8;
        const text = ctx.measureText(item.label || "").width <= room ? item.label : (item.short || item.label || "");
        if (room > 14) ctx.fillText(this.fitText(ctx, text, room), lx0 + 4, top + height / 2 + 0.5);
      }
    }
  }

  drawOverlays(ctx, doc, [from, to]) {
    const [top, height] = ROW.overlay;
    for (const item of doc.overlays) {
      if (item.o1 < from || item.o0 > to) continue;
      const x0 = this.x(item.o0) + 1;
      const x1 = Math.max(x0 + 2, this.x(item.o1) - 1);
      ctx.save();
      roundRect(ctx, x0, top, x1 - x0, height, 6);
      ctx.fillStyle = "#2a2536";
      ctx.fill();
      ctx.clip();
      this.drawThumbs(ctx, item.mediaKey, item.o0, item.o1, (o) => item.clipStart + (o - item.o0) * (item.speed || 1), top, height, item.aspect);
      if (x1 - x0 > 46) {
        ctx.fillStyle = "rgba(20, 16, 30, 0.72)";
        ctx.fillRect(x0, top + height - 15, x1 - x0, 15);
        ctx.fillStyle = "#eee8ff";
        ctx.font = "600 10px Rubik, system-ui, sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        const lx0 = Math.max(x0, 0);
        ctx.fillText(this.fitText(ctx, `◫ ${item.label || "Поверх"}`, x1 - lx0 - 10), lx0 + 5, top + height - 7.5);
      }
      ctx.restore();
      roundRect(ctx, x0 + 0.5, top + 0.5, x1 - x0 - 1, height - 1, 6);
      ctx.strokeStyle = COLORS.overlay;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  /** Музыка и звуки на ленте: зелёные плашки с очертанием звука. */
  drawAudios(ctx, doc, [from, to]) {
    const [top, height] = ROW.audio;
    for (const item of doc.audios || []) {
      if (item.o1 < from || item.o0 > to) continue;
      const x0 = this.x(item.o0) + 1;
      const x1 = Math.max(x0 + 2, this.x(item.o1) - 1);
      ctx.save();
      roundRect(ctx, x0, top, x1 - x0, height, 6);
      ctx.fillStyle = "rgba(24, 58, 48, 0.85)";
      ctx.fill();
      ctx.clip();
      const peaks = item.peaks;
      if (peaks?.values?.length && peaks.duration > 0) {
        const n = peaks.values.length;
        const mid = top + height / 2;
        const gain = Math.min(1.4, Math.max(0.15, item.volume ?? 1));
        ctx.fillStyle = COLORS.audioWave;
        const xa = Math.max(Math.floor(x0), 0);
        const xb = Math.min(Math.ceil(x1), this.width);
        for (let x = xa; x < xb; x += 2) {
          const t0 = item.clipStart + (this.o(x) - item.o0);
          const t1 = item.clipStart + (this.o(x + 2) - item.o0);
          let i0 = clamp(Math.floor((t0 / peaks.duration) * n), 0, n - 1);
          const i1 = clamp(Math.max(i0 + 1, Math.ceil((t1 / peaks.duration) * n)), 1, n);
          let value = 0;
          for (; i0 < i1; i0 += 1) value = Math.max(value, peaks.values[i0]);
          const h = Math.max(1, Math.sqrt(value) * gain * (height - 6) * 0.8);
          ctx.fillRect(x, mid - h / 2, 1.4, h);
        }
      }
      if (x1 - x0 > 40) {
        ctx.fillStyle = "#dffaf0";
        ctx.font = "600 10px Rubik, system-ui, sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        const volume = Math.round((item.volume ?? 1) * 100);
        const lx0 = Math.max(x0, 0);
        ctx.fillText(this.fitText(ctx, `♪ ${item.label || "Звук"}${volume !== 100 ? ` · ${volume}%` : ""}`, x1 - lx0 - 10), lx0 + 5, top + height / 2 + 0.5);
      }
      ctx.restore();
      roundRect(ctx, x0 + 0.5, top + 0.5, x1 - x0 - 1, height - 1, 6);
      ctx.strokeStyle = COLORS.audio;
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
  }

  drawWords(ctx, doc, [from, to]) {
    const [top, height] = ROW.words;
    // Очертание звука — фоном дорожки слов: видно паузы и громкие места.
    const mid = top + height / 2;
    for (const piece of doc.pieces) {
      if (piece.o1 < from || piece.o0 > to) continue;
      const entry = this.media.get(piece.mediaKey);
      const peaks = entry?.peaks;
      if (!peaks?.values?.length || !(peaks.duration > 0)) continue;
      const timeAt = piece.kind === "insert" ? (o) => piece.clipStart + (o - piece.o0) * (piece.speed || 1) : (o) => piece.s0 + (o - piece.o0);
      const xa = Math.max(0, Math.floor(this.x(piece.o0)) + 1);
      const xb = Math.min(this.width, Math.ceil(this.x(piece.o1)) - 1);
      ctx.fillStyle = piece.kind === "insert" ? COLORS.waveInsert : COLORS.wave;
      const n = peaks.values.length;
      for (let x = xa; x < xb; x += 2) {
        const t0 = timeAt(this.o(x));
        const t1 = timeAt(this.o(x + 2));
        let i0 = Math.floor((t0 / peaks.duration) * n);
        let i1 = Math.max(i0 + 1, Math.ceil((t1 / peaks.duration) * n));
        i0 = clamp(i0, 0, n - 1);
        i1 = clamp(i1, 1, n);
        let value = 0;
        for (let i = i0; i < i1; i += 1) value = Math.max(value, peaks.values[i]);
        const h = Math.max(1, Math.sqrt(value) * (height - 6));
        ctx.fillRect(x, mid - h / 2, 1.4, h);
      }
    }
    // Слова.
    ctx.font = "500 11px Rubik, system-ui, sans-serif";
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    const selection = this.selection?.kind === "words" ? this.selection : null;
    for (const word of doc.words) {
      if (word.o1 < from || word.o0 > to) continue;
      const x0 = this.x(word.o0);
      const x1 = Math.max(x0 + 2, this.x(word.o1));
      const selected = selection && word.w >= selection.w0 && word.w <= selection.w1;
      const width = x1 - x0;
      const textWidth = ctx.measureText(word.text).width;
      if (width >= textWidth + 6) {
        roundRect(ctx, x0, top + 6, width - 1, height - 12, 5);
        ctx.fillStyle = selected ? COLORS.amber : word.keyword ? "rgba(185, 169, 255, 0.22)" : COLORS.word;
        ctx.fill();
        ctx.fillStyle = selected ? "#2a1d05" : word.keyword ? COLORS.key : COLORS.text;
        ctx.fillText(word.text, x0 + 3, mid + 0.5);
      } else {
        ctx.fillStyle = selected ? COLORS.amber : word.keyword ? COLORS.key : "rgba(216, 208, 198, 0.45)";
        ctx.fillRect(x0, mid - 4, Math.max(1.5, width - 1), 8);
      }
    }
  }

  drawJunctions(ctx, doc, [from, to]) {
    const [top, height] = ROW.main;
    let labelEnd = -Infinity;
    for (const junction of doc.junctions) {
      if (junction.o < from || junction.o > to) continue;
      const selected = this.selection?.kind === "junction" && this.selection.key === junction.key;
      const x = Math.round(this.x(junction.o));
      ctx.fillStyle = selected ? COLORS.amber : COLORS.cut;
      ctx.globalAlpha = selected ? 1 : 0.9;
      ctx.fillRect(x - 1, top - 3, 2, height + 6);
      ctx.beginPath();
      ctx.arc(x, top - 1, selected ? 6 : 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      if (selected || this.pps > 60) {
        const label = `−${junction.seconds < 10 ? junction.seconds.toFixed(1).replace(".", ",") : Math.round(junction.seconds)} с`;
        ctx.font = "600 10px Rubik, system-ui, sans-serif";
        const w = ctx.measureText(label).width + 8;
        // Подписи соседних склеек не налезают друг на друга (выделенная — всегда).
        if (!selected && x - w / 2 < labelEnd + 4) continue;
        // Подпись не уходит за край ленты: у самого края она сдвигается внутрь.
        const lx = clamp(x - w / 2, 2, this.width - w - 2);
        labelEnd = lx + w;
        const y = top + height - 17;
        roundRect(ctx, lx, y, w, 14, 7);
        ctx.fillStyle = selected ? COLORS.amber : "rgba(255, 138, 122, 0.92)";
        ctx.fill();
        ctx.strokeStyle = "rgba(17, 16, 20, 0.8)";
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = "#2a0d08";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(label, lx + w / 2, y + 7.5);
      }
    }
  }

  /**
   * Переходы на стыках: кружок на каждом стыке кусков (между видео и на склейке внутри видео).
   * «+» — перехода нет (нажми, чтобы поставить), песочные часы — переход стоит.
   */
  drawTransitions(ctx, doc, [from, to]) {
    for (const item of doc.transitions || []) {
      if (item.o < from - 10 || item.o > to + 10) continue;
      const overlay = item.row === "overlay";
      const [top, height] = ROW[overlay ? "overlay" : "main"];
      const selected = this.selection?.kind === "transition" && this.selection.key === item.key;
      const hover = this.hoverKey === item.key;
      const x = Math.round(this.x(item.o));
      const y = top + height / 2;
      const r = overlay ? (selected ? 9 : 8) : (selected ? 12 : hover ? 11.5 : 10.5);
      const on = item.type && item.type !== "none";
      ctx.save();
      ctx.shadowColor = "rgba(0, 0, 0, 0.55)";
      ctx.shadowBlur = 6;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = selected ? COLORS.amber : on ? "#b9a9ff" : hover ? "#2c2638" : "rgba(22, 20, 30, 0.95)";
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.lineWidth = selected ? 2 : 1.5;
      ctx.strokeStyle = selected ? "#2a1d05" : on ? "#f3efff" : "rgba(239, 234, 255, 0.9)";
      ctx.stroke();
      const ink = selected ? "#2a1d05" : on ? "#1e1440" : "#efeaff";
      ctx.strokeStyle = ink;
      ctx.fillStyle = ink;
      ctx.lineWidth = 1.7;
      ctx.lineCap = "round";
      const k = r * 0.46;
      if (on) {
        // Песочные часы: одно перетекает в другое.
        ctx.beginPath();
        ctx.moveTo(x - k, y - k);
        ctx.lineTo(x + k, y - k);
        ctx.lineTo(x - k, y + k);
        ctx.lineTo(x + k, y + k);
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.moveTo(x - k, y);
        ctx.lineTo(x + k, y);
        ctx.moveTo(x, y - k);
        ctx.lineTo(x, y + k);
        ctx.stroke();
      }
      ctx.restore();
      if ((selected || hover || (on && this.pps > 70)) && item.label) {
        ctx.font = "600 10px Rubik, system-ui, sans-serif";
        const label = on ? item.label : "Переход +";
        const w = ctx.measureText(label).width + 10;
        // На узкой дорожке «поверх» подпись — справа от кружка, на основной — над ним.
        // У края ленты подпись сдвигается внутрь (на «поверх» — переходит на левую сторону кружка).
        const lx = overlay
          ? (x + r + 4 + w <= this.width - 2 ? x + r + 4 : Math.max(2, x - r - 4 - w))
          : clamp(x - w / 2, 2, this.width - w - 2);
        const ly = overlay ? y - 7.5 : top + 2;
        roundRect(ctx, lx, ly, w, 15, 7.5);
        ctx.fillStyle = selected ? COLORS.amber : "rgba(28, 24, 40, 0.92)";
        ctx.fill();
        ctx.fillStyle = selected ? "#2a1d05" : "#efeaff";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(label, lx + w / 2, ly + 8);
      }
    }
  }

  drawSelection(ctx, doc) {
    const selection = this.selection;
    if (!selection || selection.kind === "junction" || selection.kind === "fx" || selection.kind === "transition") return;
    const span = this.selectedSpan();
    if (!span) return;
    const row = selection.kind === "overlay" ? ROW.overlay : selection.kind === "words" ? ROW.words : selection.kind === "audio" ? ROW.audio : ROW.main;
    const [top, height] = row;
    const base = span.found;
    const x0 = this.x(span.o0);
    const x1 = this.x(span.o1);
    const drag = this.drag?.mode === "edge" && selection.kind !== "words" ? this.drag : null;
    // Что будет вырезано или добавлено, пока тянешь край.
    if (drag && Math.abs(drag.delta) > 0.001) {
      const original = drag.edge === "left" ? this.x(base.o0 ?? base.o) : this.x(base.o1 ?? base.o);
      const now = drag.edge === "left" ? x0 : x1;
      const a = Math.min(original, now);
      const b = Math.max(original, now);
      const shrinking = drag.edge === "left" ? drag.delta > 0 : drag.delta < 0;
      ctx.save();
      if (shrinking) {
        ctx.fillStyle = "rgba(10, 8, 12, 0.72)";
        ctx.fillRect(a, top, b - a, height);
        ctx.strokeStyle = "rgba(255, 138, 122, 0.85)";
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(a + 0.5, top + 0.5, b - a - 1, height - 1);
      } else {
        ctx.fillStyle = "rgba(243, 190, 94, 0.16)";
        ctx.fillRect(a, top, b - a, height);
        ctx.strokeStyle = "rgba(243, 190, 94, 0.9)";
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(a + 0.5, top + 0.5, b - a - 1, height - 1);
      }
      ctx.restore();
      const seconds = Math.abs(drag.delta);
      const label = `${shrinking ? "−" : "+"}${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} с`;
      ctx.font = "700 11px Rubik, system-ui, sans-serif";
      const w = ctx.measureText(label).width + 10;
      const lx = clamp((a + b) / 2 - w / 2, 2, this.width - w - 2);
      roundRect(ctx, lx, top - 17, w, 15, 7);
      ctx.fillStyle = shrinking ? COLORS.cut : COLORS.amber;
      ctx.fill();
      ctx.fillStyle = "#1c1206";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, lx + w / 2, top - 9.5);
    }
    roundRect(ctx, x0 + 0.5, top - 1.5, Math.max(2, x1 - x0 - 1), height + 3, 7);
    ctx.strokeStyle = COLORS.amber;
    ctx.lineWidth = 2;
    ctx.stroke();
    const narrow = x1 - x0 < HANDLE * 3;
    for (const [edge, x] of [["left", x0], ["right", x1]]) {
      const hx = edge === "left" ? (narrow ? x - HANDLE : x) : (narrow ? x : x - HANDLE);
      roundRect(ctx, hx, top - 1.5, HANDLE, height + 3, 5);
      ctx.fillStyle = COLORS.amber;
      ctx.fill();
      ctx.strokeStyle = "rgba(42, 29, 5, 0.75)";
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      const cx = hx + HANDLE / 2;
      ctx.moveTo(cx - 1.8, top + height / 2 - 6);
      ctx.lineTo(cx - 1.8, top + height / 2 + 6);
      ctx.moveTo(cx + 1.8, top + height / 2 - 6);
      ctx.lineTo(cx + 1.8, top + height / 2 + 6);
      ctx.stroke();
    }
  }

  drawMoveGhost(ctx, doc) {
    const drag = this.drag;
    if (drag?.mode !== "move" || drag.pointerO == null) return;
    const found = this.findSelected(this.selection);
    if (!found) return;
    const kind = this.selection.kind;
    const row = kind === "overlay" ? ROW.overlay : kind === "fx" ? ROW.fx : kind === "audio" ? ROW.audio : ROW.main;
    const [top, height] = row;
    const length = found.o1 - found.o0;
    const x0 = this.x(drag.pointerO);
    ctx.save();
    ctx.globalAlpha = 0.55;
    roundRect(ctx, x0, top, Math.max(4, length * this.pps), height, 7);
    ctx.fillStyle = kind === "overlay" ? COLORS.overlay : kind === "fx" ? COLORS.amber : kind === "audio" ? COLORS.audio : COLORS.insert;
    ctx.fill();
    ctx.restore();
    if (drag.target != null) {
      const x = this.x(drag.target);
      ctx.fillStyle = COLORS.amber;
      ctx.fillRect(Math.round(x) - 1.5, ROW.fx[0] - 2, 3, ROW.audio[0] + ROW.audio[1] - ROW.fx[0] + 4);
    }
    void doc;
  }

  drawPlayhead(ctx) {
    const x = Math.round(this.x(this.time)) + 0.5;
    if (x < -2 || x > this.width + 2) return;
    ctx.strokeStyle = COLORS.playhead;
    ctx.lineWidth = 2;
    ctx.shadowColor = "rgba(241, 235, 227, 0.6)";
    ctx.shadowBlur = 6;
    ctx.beginPath();
    ctx.moveTo(x, 4);
    ctx.lineTo(x, HEIGHT - 2);
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.fillStyle = COLORS.playhead;
    ctx.beginPath();
    ctx.moveTo(x - 6, 0);
    ctx.lineTo(x + 6, 0);
    ctx.lineTo(x, 8);
    ctx.closePath();
    ctx.fill();
  }

  fitText(ctx, text, width) {
    if (ctx.measureText(text).width <= width) return text;
    let value = text;
    while (value.length > 1 && ctx.measureText(`${value}…`).width > width) value = value.slice(0, -1);
    return value.length > 1 ? `${value}…` : "";
  }
}
