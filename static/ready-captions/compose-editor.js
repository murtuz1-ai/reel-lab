// Правка композиции прямо на видео: нажми на строку, фразу или картинку —
// двигай пальцем или мышью, тяни за угол, чтобы изменить размер, клади
// картинку перед текстом или за ним. Работает на паузе.
//
// Что именно двигается и где это хранится, решает адаптер из main.js:
//   enabled()            — можно ли сейчас править (есть кадр, видео на паузе)
//   elements()           — что видно в кадре: [{ id, kind, rect, ... }] сзади вперёд
//   hit(element, point)  — точное попадание (картинка — по непрозрачным пикселям)
//   begin(target)        — начало правки: пауза, запомнить исходные значения
//   move(target, dx, dy) — сдвиг от начала жеста, доли кадра
//   scale(target, f)     — масштаб от начала жеста
//   end(changed)         — жест закончен
//   actions(target)      — кнопки панели для выбранного: [{ id, label, title, disabled }]
//   act(target, id)      — нажата кнопка панели
//   snapshot() / restore(state) — для «Отменить»
// Координаты в адаптере — пиксели кадра видео.

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const HINT_KEY = "reel-lab:compose-hint";

export class ComposeEditor {
  constructor({ screen, adapter }) {
    this.screen = screen;
    this.adapter = adapter;
    this.selected = null;
    this.phraseMode = false;
    this.drag = null;
    this.touches = new Map();
    this.pinch = null;
    this.history = [];
    this.frame = 0;
    this.pending = null;
    this.build();
  }

  build() {
    const overlay = document.createElement("div");
    overlay.className = "compose";
    overlay.innerHTML = `
      <div class="compose-box" hidden>
        <span class="compose-dot is-tl"></span><span class="compose-dot is-tr"></span><span class="compose-dot is-bl"></span>
        <button type="button" class="compose-handle" aria-label="Потяни, чтобы изменить размер"></button>
      </div>
      <div class="compose-bar" role="toolbar" aria-label="Правка" hidden></div>
      <div class="compose-hint" hidden>Нажми на текст или картинку, чтобы подвинуть. Угол — размер.</div>`;
    this.screen.appendChild(overlay);
    this.overlay = overlay;
    this.box = overlay.querySelector(".compose-box");
    this.handle = overlay.querySelector(".compose-handle");
    this.bar = overlay.querySelector(".compose-bar");
    this.hint = overlay.querySelector(".compose-hint");
    this.screen.addEventListener("pointerdown", (event) => this.onDown(event));
    this.screen.addEventListener("pointermove", (event) => this.onMove(event));
    this.screen.addEventListener("pointerup", (event) => this.onUp(event));
    this.screen.addEventListener("pointercancel", (event) => this.onUp(event, true));
    this.screen.addEventListener("wheel", (event) => this.onWheel(event), { passive: false });
    this.bar.addEventListener("click", (event) => this.onBar(event));
    document.addEventListener("keydown", (event) => this.onKey(event));
    // Второй палец щипка может лечь мимо маленького видео — ловим его на всей странице.
    const outside = (event) => event.pointerType === "touch" && !this.screen.contains(event.target);
    document.addEventListener("pointerdown", (event) => {
      if (!outside(event) || !this.selected || this.touches.size !== 1 || !(this.drag || this.pinch)) return;
      this.touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      this.startPinch();
      event.preventDefault();
    }, { capture: true, passive: false });
    document.addEventListener("pointermove", (event) => {
      if (outside(event) && this.touches.has(event.pointerId)) this.onMove(event);
    }, { capture: true });
    for (const type of ["pointerup", "pointercancel"]) {
      document.addEventListener(type, (event) => {
        if (outside(event) && this.touches.has(event.pointerId)) this.onUp(event, type === "pointercancel");
      }, { capture: true });
    }
  }

  startPinch() {
    const [a, b] = [...this.touches.values()];
    const target = this.target();
    if (!target || !a || !b) return;
    this.pinch = { target, distance: Math.hypot(a.x - b.x, a.y - b.y) || 1, started: false };
    this.drag = null;
    this.bar.hidden = true;
  }

  // --- координаты -------------------------------------------------------------

  frameSize() {
    return this.adapter.frameSize?.() || null;
  }

  toFrame(event) {
    const size = this.frameSize();
    const rect = this.screen.getBoundingClientRect();
    if (!size || !rect.width || !rect.height) return null;
    return {
      x: ((event.clientX - rect.left) / rect.width) * size.width,
      y: ((event.clientY - rect.top) / rect.height) * size.height,
      fx: (event.clientX - rect.left) / rect.width,
      fy: (event.clientY - rect.top) / rect.height,
    };
  }

  cssRect(r) {
    const size = this.frameSize();
    const w = this.screen.clientWidth;
    const h = this.screen.clientHeight;
    if (!size || !r) return null;
    return { x: (r.x / size.width) * w, y: (r.y / size.height) * h, w: (r.w / size.width) * w, h: (r.h / size.height) * h };
  }

  // --- выбор -------------------------------------------------------------------

  /** То, что сейчас выделено (строка или вся её фраза), с актуальной рамкой. */
  target() {
    if (!this.selected) return null;
    const elements = this.adapter.elements();
    const found = elements.find((item) => item.id === this.selected.id);
    if (!found) return null;
    if (found.kind === "line" && this.phraseMode) {
      return { ...found, id: `f:${found.phraseKey}`, kind: "phrase", lineId: found.id, rect: found.phraseRect || found.rect };
    }
    return found;
  }

  hitTest(point) {
    const elements = this.adapter.elements();
    for (let i = elements.length - 1; i >= 0; i -= 1) {
      const item = elements[i];
      const r = item.rect;
      const pad = item.kind === "line" ? (this.frameSize()?.height || 0) * 0.008 : 0;
      if (point.x < r.x - pad || point.x > r.x + r.w + pad || point.y < r.y - pad || point.y > r.y + r.h + pad) continue;
      if (this.adapter.hit && !this.adapter.hit(item, point)) continue;
      return item;
    }
    return null;
  }

  select(item) {
    if (!item) {
      this.clear();
      return;
    }
    if (this.selected?.id !== item.id) {
      // Другая строка той же фразы — режим «вся фраза» сохраняется.
      const samePhrase = this.selected && this.selected.phraseKey != null && this.selected.phraseKey === item.phraseKey && item.kind === "line";
      if (!samePhrase) this.phraseMode = false;
    }
    this.selected = { id: item.id, kind: item.kind, phraseKey: item.phraseKey };
    this.markHintSeen();
    this.refresh();
  }

  clear() {
    this.selected = null;
    this.phraseMode = false;
    this.drag = null;
    this.box.hidden = true;
    this.bar.hidden = true;
  }

  /** Рамка и панель — по свежей раскладке (после правки, перемотки, перестройки). */
  refresh() {
    // На паузе видео ловит касания для правки; во время просмотра страница листается как обычно.
    const editable = this.adapter.enabled();
    this.screen.classList.toggle("is-editable", editable);
    const target = this.target();
    if (!target || !editable) {
      if (this.selected && !this.drag) this.clear();
      this.updateHint();
      return;
    }
    const r = this.cssRect(target.rect);
    if (!r) return;
    this.box.hidden = false;
    this.box.classList.toggle("is-picture", target.kind === "picture");
    this.box.classList.toggle("is-phrase", target.kind === "phrase");
    this.box.style.transform = `translate(${r.x}px, ${r.y}px)`;
    this.box.style.width = `${Math.max(8, r.w)}px`;
    this.box.style.height = `${Math.max(8, r.h)}px`;
    this.drawBar(target, r);
    this.hint.hidden = true;
  }

  drawBar(target, r) {
    if (this.drag?.moved) {
      this.bar.hidden = true;
      return;
    }
    const actions = [];
    if (target.kind === "line" || target.kind === "phrase") {
      actions.push({ id: "__mode", label: this.phraseMode ? "Только строка" : "Вся фраза", title: "Двигать одну строку или всю фразу целиком" });
    }
    actions.push(...(this.adapter.actions?.(target) || []));
    actions.push({ id: "__undo", label: "↶", title: "Отменить (Ctrl+Z)", disabled: !this.history.length });
    this.bar.innerHTML = actions.map((action) => (action.static
      ? `<span class="compose-state">${action.label}</span>`
      : `<button type="button" data-act="${action.id}"${action.disabled ? " disabled" : ""}${action.active ? ' class="is-on"' : ""} title="${action.title || action.label}">${action.label}</button>`)).join("");
    this.bar.hidden = false;
    const w = this.screen.clientWidth;
    const h = this.screen.clientHeight;
    const barW = this.bar.offsetWidth;
    const barH = this.bar.offsetHeight;
    let x = clamp(r.x + r.w / 2 - barW / 2, 4, Math.max(4, w - barW - 4));
    let y = r.y - barH - 10;
    if (y < 4) y = Math.min(h - barH - 4, r.y + r.h + 10);
    this.bar.style.transform = `translate(${x}px, ${y}px)`;
  }

  // --- жесты --------------------------------------------------------------------

  onDown(event) {
    if (event.button !== undefined && event.button !== 0 && event.pointerType === "mouse") return;
    if (event.target.closest(".compose-bar, .drop, .demo-btn, button:not(.compose-handle), a, input, label")) return;
    if (!this.adapter.enabled()) return;
    const point = this.toFrame(event);
    if (!point) return;
    this.touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (this.touches.size === 2 && this.selected) {
      // Второй палец — щипок: меняем размер выделенного.
      this.startPinch();
      event.preventDefault();
      return;
    }
    const target = this.target();
    if (target && event.target.closest(".compose-handle")) {
      event.preventDefault();
      this.startDrag(event, target, "scale", point);
      return;
    }
    let hit = this.hitTest(point);
    if (!hit) {
      if (this.selected) {
        this.clear();
        event.preventDefault();
      }
      return;
    }
    event.preventDefault();
    if (target?.kind === "phrase" && hit.kind === "line" && hit.phraseKey === target.phraseKey) hit = this.adapter.elements().find((item) => item.id === target.lineId) || hit;
    this.select(hit);
    this.startDrag(event, this.target(), "move", point);
  }

  startDrag(event, target, mode, point) {
    if (!target) return;
    const r = target.rect;
    this.drag = {
      pointerId: event.pointerId, mode, target, moved: false,
      startX: event.clientX, startY: event.clientY, point,
      center: { x: r.x + r.w / 2, y: r.y + r.h / 2 },
    };
    try { this.screen.setPointerCapture(event.pointerId); } catch (_) { /* не важно */ }
    this.screen.classList.add("is-composing");
    // Пока палец на рамке, панель убрана: второй палец (щипок) не попадёт в её кнопки.
    this.bar.hidden = true;
  }

  onMove(event) {
    if (this.touches.has(event.pointerId)) this.touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (this.pinch && this.touches.size >= 2) {
      const [a, b] = [...this.touches.values()];
      const factor = clamp(Math.hypot(a.x - b.x, a.y - b.y) / this.pinch.distance, 0.2, 5);
      if (!this.pinch.started) {
        this.pushHistory();
        this.adapter.begin(this.pinch.target);
        this.pinch.started = true;
      }
      this.schedule(() => this.adapter.scale(this.pinch.target, factor));
      return;
    }
    if (!this.drag) {
      this.updateCursor(event);
      return;
    }
    if (event.pointerId !== this.drag.pointerId) return;
    const rect = this.screen.getBoundingClientRect();
    const dxCss = event.clientX - this.drag.startX;
    const dyCss = event.clientY - this.drag.startY;
    if (!this.drag.moved) {
      if (Math.hypot(dxCss, dyCss) < 3) return;
      this.drag.moved = true;
      this.pushHistory();
      this.adapter.begin(this.drag.target);
      this.bar.hidden = true;
    }
    if (this.drag.mode === "move") {
      const dx = dxCss / rect.width;
      const dy = dyCss / rect.height;
      this.schedule(() => this.adapter.move(this.drag.target, dx, dy));
    } else {
      const point = this.toFrame(event);
      const { center } = this.drag;
      const start = Math.hypot(this.drag.point.x - center.x, this.drag.point.y - center.y) || 1;
      const now = Math.hypot(point.x - center.x, point.y - center.y);
      const factor = clamp(now / start, 0.2, 6);
      this.schedule(() => this.adapter.scale(this.drag.target, factor));
    }
  }

  /** Правка — не чаще кадра экрана: раскладка пересчитывается один раз на кадр. */
  schedule(apply) {
    this.pending = apply;
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      const run = this.pending;
      this.pending = null;
      run?.();
      this.refresh();
    });
  }

  flush() {
    if (this.frame) {
      cancelAnimationFrame(this.frame);
      this.frame = 0;
    }
    const run = this.pending;
    this.pending = null;
    run?.();
  }

  onUp(event, cancelled = false) {
    this.touches.delete(event.pointerId);
    if (this.pinch) {
      if (this.touches.size < 2) {
        const started = this.pinch.started;
        this.pinch = null;
        this.flush();
        if (started) this.adapter.end(true);
        this.refresh();
      }
      return;
    }
    if (!this.drag || event.pointerId !== this.drag.pointerId) return;
    try { this.screen.releasePointerCapture(event.pointerId); } catch (_) { /* уже отпущен */ }
    this.screen.classList.remove("is-composing");
    const moved = this.drag.moved && !cancelled;
    this.flush();
    this.drag = null;
    if (moved) this.adapter.end(true);
    this.refresh();
  }

  onWheel(event) {
    if (!this.selected || !this.adapter.enabled()) return;
    const target = this.target();
    if (!target) return;
    const point = this.toFrame(event);
    const r = target.rect;
    if (!point || point.x < r.x || point.x > r.x + r.w || point.y < r.y || point.y > r.y + r.h) return;
    event.preventDefault();
    this.step(target, () => this.adapter.scale(target, event.deltaY < 0 ? 1.06 : 1 / 1.06));
  }

  /** Одно действие целиком (кнопка, колёсико, стрелка): отменяется одним «Отменить». */
  step(target, apply) {
    this.pushHistory();
    this.adapter.begin(target);
    apply();
    this.adapter.end(true);
    this.refresh();
  }

  onKey(event) {
    // Клавиши на ленте монтажа — её собственные (там своя отмена шагов).
    if (event.target.closest?.("input, select, textarea, [contenteditable], .timeline")) return;
    const undo = (event.ctrlKey || event.metaKey) && event.code === "KeyZ" && !event.shiftKey;
    if (undo && this.history.length && this.adapter.enabled()) {
      event.preventDefault();
      this.undo();
      return;
    }
    if (!this.selected) return;
    const target = this.target();
    if (!target) return;
    const size = this.frameSize();
    const step = event.shiftKey ? 0.02 : 0.005;
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[event.key] && size) {
      event.preventDefault();
      const [dx, dy] = moves[event.key];
      this.step(target, () => this.adapter.move(target, dx, dy));
    } else if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      this.step(target, () => this.adapter.scale(target, 1.05));
    } else if (event.key === "-" || event.key === "_") {
      event.preventDefault();
      this.step(target, () => this.adapter.scale(target, 1 / 1.05));
    } else if (event.key === "Escape") {
      this.clear();
    }
  }

  onBar(event) {
    const button = event.target.closest("[data-act]");
    if (!button || button.disabled) return;
    const target = this.target();
    const id = button.dataset.act;
    if (id === "__undo") {
      this.undo();
      return;
    }
    if (!target) return;
    if (id === "__mode") {
      this.phraseMode = !this.phraseMode;
      this.refresh();
      return;
    }
    if (id === "__bigger" || id === "__smaller") {
      this.step(target, () => this.adapter.scale(target, id === "__bigger" ? 1.1 : 1 / 1.1));
      return;
    }
    this.step(target, () => this.adapter.act(target, id));
  }

  // --- отмена ---------------------------------------------------------------------

  pushHistory() {
    const state = this.adapter.snapshot?.();
    if (state === undefined) return;
    this.history.push(state);
    if (this.history.length > 80) this.history.shift();
  }

  undo() {
    const state = this.history.pop();
    if (state === undefined) return;
    this.adapter.restore(state);
    this.refresh();
  }

  resetHistory() {
    this.history = [];
  }

  // --- подсказки ----------------------------------------------------------------

  updateCursor(event) {
    if (!this.adapter.enabled()) {
      this.screen.classList.remove("can-compose");
      return;
    }
    const point = this.toFrame(event);
    this.screen.classList.toggle("can-compose", Boolean(point && this.hitTest(point)));
  }

  updateHint() {
    let seen = 0;
    try { seen = Number(localStorage.getItem(HINT_KEY)) || 0; } catch (_) { /* без хранилища */ }
    let show = !this.selected && seen < 2 && this.adapter.enabled() && this.adapter.elements().length > 0;
    // Подсказка висит не дольше 6 секунд за сеанс — потом не мешает смотреть видео.
    if (show) {
      const now = Date.now();
      if (!this.hintSince) {
        this.hintSince = now;
        window.setTimeout(() => this.updateHint(), 6100);
      }
      if (now - this.hintSince > 6000) show = false;
    }
    this.hint.hidden = !show;
  }

  markHintSeen() {
    try {
      const seen = Number(localStorage.getItem(HINT_KEY)) || 0;
      localStorage.setItem(HINT_KEY, String(seen + 1));
    } catch (_) { /* без хранилища */ }
    this.hint.hidden = true;
  }
}
