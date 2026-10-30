// Свой звук из файла или видео: выбрать кусок на волне, послушать и сохранить
// как короткий звук (на любой слой) или как музыку на фон.
//
// Сверху — весь файл (обзор), под ним — крупно окно вокруг выделения: там
// края куска двигаются с точностью до миллисекунд. Слушается ровно выделенное.

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const SFX_MAX = 20;
const MUSIC_MAX = 20 * 60;

function clock(seconds, precise = false) {
  const s = Math.max(0, Number(seconds) || 0);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  const text = precise ? rest.toFixed(2).padStart(5, "0") : String(Math.floor(rest)).padStart(2, "0");
  return `${m}:${text}`.replace(".", ",");
}

function lengthLabel(seconds) {
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 2 : 1).replace(".", ",")} с`;
  return clock(seconds);
}


/** Щелчок по затемнению вокруг окна, а не по пустому месту внутри (на телефоне окно во весь экран). */
function tappedBackdrop(event, dialog) {
  if (event.target !== dialog) return false;
  const box = dialog.getBoundingClientRect();
  return event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom;
}

export class SoundClipEditor {
  constructor({ request }) {
    this.request = request; // async (url, { method, body }) → JSON, с CSRF
    this.source = null;
    this.kind = "sfx";
    this.duration = 0;
    this.overview = [];
    this.scale = 1;
    this.detail = { start: 0, end: 0, peaks: [] };
    this.selection = { start: 0, end: 0 };
    this.drag = null;
    this.playing = false;
    this.frame = 0;
    this.detailTimer = 0;
    this.detailToken = 0;
    this.resolve = null;
    this.build();
  }

  build() {
    const dialog = document.createElement("dialog");
    dialog.className = "clip";
    dialog.setAttribute("aria-labelledby", "clipTitle");
    dialog.innerHTML = `
      <div class="clip-shell">
        <header class="clip-head">
          <div>
            <h2 class="clip-title" id="clipTitle">Свой звук</h2>
            <p class="clip-sub" data-sub></p>
          </div>
          <button type="button" class="icon-btn clip-close" data-cancel aria-label="Закрыть">×</button>
        </header>
        <div class="seg clip-kind" role="group" aria-label="Что это будет">
          <button type="button" data-kind="sfx" class="is-active">Короткий звук</button>
          <button type="button" data-kind="music">Музыка на фон</button>
        </div>
        <p class="clip-hint" data-hint></p>
        <div class="clip-wave">
          <canvas class="clip-overview" data-overview height="56" aria-label="Весь файл: потяни, чтобы выделить кусок"></canvas>
          <canvas class="clip-detail" data-detail height="120" aria-label="Крупно: потяни края выделения"></canvas>
          <div class="clip-loading" data-loading>Читаю звук…</div>
        </div>
        <div class="clip-row">
          <button type="button" class="btn btn-sm clip-play" data-play>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg><span>Послушать кусок</span>
          </button>
          <div class="clip-times" data-times></div>
          <div class="clip-zoom" role="group" aria-label="Масштаб">
            <button type="button" class="icon-btn" data-zoom="out" aria-label="Мельче">−</button>
            <button type="button" class="icon-btn" data-zoom="in" aria-label="Крупнее">+</button>
          </div>
        </div>
        <label class="field clip-name">
          <span>Название</span>
          <input type="text" maxlength="60" data-name placeholder="Например, «Вау» или «Фоновый трек»">
        </label>
        <p class="clip-error" data-error hidden></p>
        <footer class="clip-foot">
          <button type="button" class="btn btn-ghost" data-cancel>Отмена</button>
          <button type="button" class="btn btn-primary" data-save>Сохранить</button>
        </footer>
      </div>`;
    document.body.appendChild(dialog);
    this.dialog = dialog;
    const $ = (selector) => dialog.querySelector(selector);
    this.el = {
      sub: $("[data-sub]"), hint: $("[data-hint]"), overview: $("[data-overview]"), detail: $("[data-detail]"),
      loading: $("[data-loading]"), play: $("[data-play]"), times: $("[data-times]"), name: $("[data-name]"),
      error: $("[data-error]"), save: $("[data-save]"),
    };
    this.audio = new Audio();
    this.audio.preload = "auto";
    dialog.addEventListener("click", (event) => this.onClick(event));
    dialog.addEventListener("close", () => this.finish(null));
    for (const canvas of [this.el.overview, this.el.detail]) {
      canvas.addEventListener("pointerdown", (event) => this.onPointerDown(event, canvas));
      canvas.addEventListener("pointermove", (event) => this.onPointerMove(event, canvas));
      canvas.addEventListener("pointerup", (event) => this.onPointerUp(event, canvas));
      canvas.addEventListener("pointercancel", () => { this.drag = null; });
    }
    window.addEventListener("resize", () => { if (this.dialog.open) this.draw(); });
  }

  /**
   * source: { upload } — видео из студии, или { source } — загруженный файл; name — подпись.
   * Возвращает сохранённый звук (запись с сервера) или null.
   */
  open({ source, name = "", kind = "sfx" }) {
    this.source = source;
    this.kind = kind === "music" ? "music" : "sfx";
    this.duration = 0;
    this.overview = [];
    this.detail = { start: 0, end: 0, peaks: [] };
    this.selection = { start: 0, end: 0 };
    this.el.name.value = "";
    this.el.error.hidden = true;
    this.el.sub.textContent = name ? `Из файла «${name}»` : "";
    this.el.loading.hidden = false;
    this.el.loading.textContent = "Читаю звук…";
    this.el.save.disabled = true;
    this.drawKind();
    this.stop();
    this.audio.src = `/api/sounds/preview?${this.query()}`;
    if (!this.dialog.open) this.dialog.showModal();
    void this.load();
    return new Promise((resolve) => { this.resolve = resolve; });
  }

  query(extra = {}) {
    const params = new URLSearchParams();
    if (this.source?.upload) params.set("upload", this.source.upload);
    if (this.source?.source) params.set("source", this.source.source);
    for (const [key, value] of Object.entries(extra)) params.set(key, String(value));
    return params.toString();
  }

  async load() {
    try {
      const response = await fetch(`/api/sounds/peaks?${this.query({ n: 1600 })}`, { credentials: "same-origin" });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || "Не удалось прочитать звук.");
      this.duration = Number(data.duration) || 0;
      this.overview = data.peaks || [];
      this.scale = Number(data.scale) || 1;
      if (!this.duration) throw new Error("В файле нет звука.");
      this.resetSelection();
      this.el.loading.hidden = true;
      this.el.save.disabled = false;
    } catch (error) {
      this.el.loading.textContent = error?.message || String(error);
    }
  }

  /** Короткий звук: самое громкое место и секунда вокруг; музыка — весь файл. */
  resetSelection() {
    if (this.kind === "music") {
      this.selection = { start: 0, end: Math.min(this.duration, MUSIC_MAX) };
    } else {
      let best = 0;
      this.overview.forEach((value, index) => { if (value > (this.overview[best] || 0)) best = index; });
      const at = this.overview.length ? (best / this.overview.length) * this.duration : 0;
      const start = clamp(at - 0.15, 0, Math.max(0, this.duration - 0.2));
      this.selection = { start, end: Math.min(this.duration, start + Math.min(1.5, SFX_MAX)) };
    }
    this.fitDetail();
  }

  limit() {
    return this.kind === "music" ? MUSIC_MAX : SFX_MAX;
  }

  /** Окно крупного вида вокруг выделения (с запасом по краям). */
  fitDetail(span = null) {
    const length = this.selection.end - this.selection.start;
    const want = clamp(span ?? Math.max(1, length * 1.6), 0.4, Math.max(0.4, this.duration));
    const center = (this.selection.start + this.selection.end) / 2;
    const start = clamp(center - want / 2, 0, Math.max(0, this.duration - want));
    this.detail = { start, end: Math.min(this.duration, start + want), peaks: [] };
    this.draw();
    window.clearTimeout(this.detailTimer);
    this.detailTimer = window.setTimeout(() => { void this.loadDetail(); }, 120);
  }

  async loadDetail() {
    const token = ++this.detailToken;
    const { start, end } = this.detail;
    if (end - start > this.duration * 0.6) {
      this.detail.peaks = []; // почти весь файл — хватит обзора
      this.draw();
      return;
    }
    try {
      const response = await fetch(`/api/sounds/peaks?${this.query({ n: 900, start: start.toFixed(3), end: end.toFixed(3) })}`, { credentials: "same-origin" });
      const data = await response.json();
      if (!response.ok || token !== this.detailToken) return;
      this.detail.peaks = data.peaks || [];
      this.draw();
    } catch (_) { /* останется обзорная картинка */ }
  }

  drawKind() {
    this.dialog.querySelectorAll("[data-kind]").forEach((button) => {
      const active = button.dataset.kind === this.kind;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    this.el.hint.textContent = this.kind === "music"
      ? "Трек будет играть под всем роликом: плавно войдёт, станет тише, когда звучит голос, и уйдёт в конце."
      : `Короткий звук — до ${SFX_MAX} секунд. Его можно поставить на любой слой: буквы, слова, фразы, ключевые слова.`;
  }

  sizeCanvas(canvas) {
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(200, Math.round(canvas.clientWidth * ratio));
    const height = Math.round((Number(canvas.getAttribute("height")) || 80) * ratio);
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height || canvas.dataset.h !== String(height)) {
      canvas.height = height;
      canvas.dataset.h = String(height);
    }
    return { width, height, ratio };
  }

  draw() {
    this.drawWave(this.el.overview, 0, this.duration, this.overview, 1, true);
    const detail = this.detail.peaks.length ? this.detail.peaks : this.slice(this.detail.start, this.detail.end);
    const scale = this.detail.peaks.length ? 1 / (this.scale || 1) : 1;
    this.drawWave(this.el.detail, this.detail.start, this.detail.end, detail, scale, false);
    this.drawTimes();
  }

  /** Кусок обзорных пиков для окна, пока не пришли точные. */
  slice(start, end) {
    if (!this.overview.length || !this.duration) return [];
    const a = Math.floor((start / this.duration) * this.overview.length);
    const b = Math.max(a + 1, Math.ceil((end / this.duration) * this.overview.length));
    return this.overview.slice(a, b);
  }

  drawWave(canvas, from, to, peaks, gain, overview) {
    const { width, height, ratio } = this.sizeCanvas(canvas);
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, width, height);
    const span = Math.max(1e-6, to - from);
    const x = (t) => ((t - from) / span) * width;
    const selA = x(this.selection.start);
    const selB = x(this.selection.end);
    ctx.fillStyle = "rgba(243, 190, 94, 0.12)";
    ctx.fillRect(selA, 0, selB - selA, height);
    const mid = height / 2;
    const count = peaks.length;
    if (count) {
      const step = width / count;
      for (let i = 0; i < count; i += 1) {
        // Квадратный корень: тихие места тоже видны.
        const value = Math.min(1, Math.sqrt(Math.max(0, peaks[i] * gain)));
        const px = i * step;
        const inside = px + step >= selA && px <= selB;
        ctx.fillStyle = inside ? "#f3be5e" : "#5c5568";
        const h = Math.max(1 * ratio, value * (height / 2 - 2 * ratio));
        ctx.fillRect(px, mid - h, Math.max(1, step - (step > 3 ? 1 : 0)), h * 2);
      }
    }
    // края выделения
    ctx.fillStyle = "#f3be5e";
    for (const edge of [selA, selB]) {
      ctx.fillRect(edge - ratio, 0, 2 * ratio, height);
      if (!overview) {
        ctx.beginPath();
        ctx.arc(edge, height - 9 * ratio, 6 * ratio, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    if (overview && this.detail.end > this.detail.start) {
      ctx.strokeStyle = "rgba(241, 235, 227, 0.55)";
      ctx.lineWidth = ratio;
      ctx.strokeRect(x(this.detail.start) + 0.5, 0.5, Math.max(2, x(this.detail.end) - x(this.detail.start)) - 1, height - 1);
    }
    if (this.playing) {
      const at = this.audio.currentTime;
      if (at >= from && at <= to) {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(x(at) - ratio / 2, 0, ratio, height);
      }
    }
  }

  drawTimes() {
    const { start, end } = this.selection;
    const length = end - start;
    const over = length > this.limit() + 0.005;
    this.el.times.innerHTML = `<span>${escapeHtml(clock(start, true))} — ${escapeHtml(clock(end, true))}</span><b class="${over ? "is-over" : ""}">${escapeHtml(lengthLabel(length))}</b>`;
    this.el.save.disabled = !this.duration || length < 0.05 || over;
  }

  timeAt(event, canvas) {
    const rect = canvas.getBoundingClientRect();
    const ratio = clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
    const overview = canvas === this.el.overview;
    const from = overview ? 0 : this.detail.start;
    const to = overview ? this.duration : this.detail.end;
    return { time: from + ratio * (to - from), pxPerSec: rect.width / Math.max(1e-6, to - from) };
  }

  onPointerDown(event, canvas) {
    if (!this.duration) return;
    canvas.setPointerCapture?.(event.pointerId);
    const { time, pxPerSec } = this.timeAt(event, canvas);
    const near = 12 / pxPerSec; // 12 пикселей вокруг края — хватаем край
    let mode = "new";
    if (Math.abs(time - this.selection.start) <= near) mode = "start";
    else if (Math.abs(time - this.selection.end) <= near) mode = "end";
    else if (time > this.selection.start && time < this.selection.end && canvas === this.el.detail) mode = "move";
    this.drag = { canvas, mode, anchor: time, start: this.selection.start, end: this.selection.end };
    if (mode === "new") this.selection = { start: time, end: time };
    this.draw();
  }

  onPointerMove(event, canvas) {
    if (!this.drag || this.drag.canvas !== canvas) return;
    const { time } = this.timeAt(event, canvas);
    const { mode, anchor, start, end } = this.drag;
    if (mode === "new") this.selection = { start: Math.min(anchor, time), end: Math.max(anchor, time) };
    else if (mode === "start") this.selection = { start: clamp(time, 0, end - 0.02), end };
    else if (mode === "end") this.selection = { start, end: clamp(time, start + 0.02, this.duration) };
    else if (mode === "move") {
      const shift = clamp(time - anchor, -start, this.duration - end);
      this.selection = { start: start + shift, end: end + shift };
    }
    this.draw();
  }

  onPointerUp(event, canvas) {
    if (!this.drag || this.drag.canvas !== canvas) return;
    const wasOverview = canvas === this.el.overview;
    if (this.selection.end - this.selection.start < 0.02) {
      // Просто нажали — кусок в секунду (или трек до конца) от этого места.
      const at = this.selection.start;
      const length = this.kind === "music" ? this.duration - at : 1;
      this.selection = { start: at, end: Math.min(this.duration, at + length) };
    }
    if (this.selection.end - this.selection.start > this.limit()) this.selection.end = this.selection.start + this.limit();
    this.drag = null;
    if (wasOverview) this.fitDetail();
    else this.draw();
  }

  async togglePlay() {
    if (this.playing) {
      this.stop();
      return;
    }
    try {
      this.audio.currentTime = this.selection.start;
      await this.audio.play();
      this.playing = true;
      this.el.play.classList.add("is-playing");
      this.el.play.querySelector("span").textContent = "Стоп";
      const tick = () => {
        if (!this.playing) return;
        if (this.audio.currentTime >= this.selection.end || this.audio.ended) {
          this.stop();
          return;
        }
        this.draw();
        this.frame = requestAnimationFrame(tick);
      };
      this.frame = requestAnimationFrame(tick);
    } catch (error) {
      this.showError(`Не получилось послушать: ${error?.message || error}`);
    }
  }

  stop() {
    this.playing = false;
    cancelAnimationFrame(this.frame);
    try { this.audio.pause(); } catch (_) { /* не играл */ }
    this.el.play.classList.remove("is-playing");
    this.el.play.querySelector("span").textContent = "Послушать кусок";
    if (this.dialog.open) this.draw();
  }

  showError(text) {
    this.el.error.textContent = text;
    this.el.error.hidden = !text;
  }

  async save() {
    this.stop();
    this.showError("");
    this.el.save.disabled = true;
    const label = this.el.save.textContent;
    this.el.save.textContent = "Сохраняю…";
    try {
      const body = {
        ...(this.source?.upload ? { upload: this.source.upload } : { source: this.source?.source }),
        start: Number(this.selection.start.toFixed(3)),
        end: Number(this.selection.end.toFixed(3)),
        label: this.el.name.value.trim(),
        kind: this.kind,
      };
      const entry = await this.request("/api/sounds/own", { method: "POST", body });
      this.finish(entry);
      this.dialog.close();
    } catch (error) {
      this.showError(error?.message || String(error));
    } finally {
      this.el.save.textContent = label;
      this.drawTimes();
    }
  }

  finish(value) {
    this.stop();
    if (this.resolve) {
      const resolve = this.resolve;
      this.resolve = null;
      resolve(value);
    }
  }

  onClick(event) {
    if (tappedBackdrop(event, this.dialog) || event.target.closest("[data-cancel]")) {
      this.dialog.close();
      return;
    }
    const kind = event.target.closest("[data-kind]");
    if (kind) {
      if (kind.dataset.kind !== this.kind) {
        this.kind = kind.dataset.kind;
        this.drawKind();
        if (this.duration) this.resetSelection();
      }
      return;
    }
    if (event.target.closest("[data-play]")) {
      void this.togglePlay();
      return;
    }
    const zoom = event.target.closest("[data-zoom]");
    if (zoom) {
      const span = this.detail.end - this.detail.start;
      this.fitDetail(zoom.dataset.zoom === "in" ? span / 2 : span * 2);
      return;
    }
    if (event.target.closest("[data-save]")) void this.save();
  }
}
