// Библиотека звуков: прослушать всё, выбрать звук для слоя или музыку, убрать лишнее
// и добавить свои звуки — из файла или куском из видео.
//
// Режимы одного окна:
//   pick    — открыта из слоя («Все звуки…»): любой звук библиотеки на этот слой;
//   music   — выбор музыки на фон (свои треки);
//   curate  — доска прослушивания: «В студии» / «Убран» у каждого звука.
// Убранные звуки не показываются в студии; решение хранится на сервере
// рядом с библиотекой (static/sounds/sfx/curation.json).

import { SOUND_LAYERS } from "./sfx.js";

const PLAY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>';
const WAVE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 10v4M9 7v10M13 4v16M17 8v8M21 11v2"/></svg>';
const FALLBACK_CATEGORIES = { keys: "Клавиатура", click: "Клики", pop: "Пузыри и капли", whoosh: "Взмахи", riser: "Нарастание", hit: "Удары", bell: "Звонки", magic: "Волшебство", notes: "Ноты", digital: "Цифровые", cartoon: "Мультяшные", foley: "Предметы", mine: "Мои звуки" };
// Разделы, которые ближе всего слою, идут первыми.
const LAYER_ORDER = {
  typing: ["keys", "click", "pop", "digital", "notes"],
  word: ["click", "pop", "bell", "notes", "digital", "foley", "cartoon"],
  phrase: ["whoosh", "riser", "magic", "foley", "digital", "bell"],
  accent: ["hit", "bell", "magic", "cartoon", "digital", "riser", "foley", "pop"],
  cut: ["whoosh", "riser", "hit", "magic", "foley", "digital"],
};

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

function sourceLine(sound) {
  if (sound.mine) return sound.source || "Мой звук";
  if (sound.own) return "Ваша запись";
  const source = String(sound.source || "");
  if (source.startsWith("Freesound")) return source.length > 44 ? `${source.slice(0, 42)}…` : source;
  if (source.startsWith("Kenney")) return "Kenney · CC0";
  return "Синтез студии";
}

function secondsLabel(sound) {
  const s = Number(sound.seconds);
  if (!Number.isFinite(s) || s <= 0) return "";
  if (s >= 60) return `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
  return s < 1 ? `${Math.round(s * 100) / 100} с`.replace(".", ",") : `${(Math.round(s * 10) / 10).toString().replace(".", ",")} с`;
}


/** Щелчок по затемнению вокруг окна, а не по пустому месту внутри (на телефоне окно во весь экран). */
function tappedBackdrop(event, dialog) {
  if (event.target !== dialog) return false;
  const box = dialog.getBoundingClientRect();
  return event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom;
}

export class SoundBoard {
  /**
   * own: { pickFile(): Promise<{source,name}|null>, videoSource(): Promise<{upload,name}|null>,
   *        hasVideo(): boolean, clip: SoundClipEditor, request(url, opts), reload(): Promise<manifest> }
   */
  constructor({ player, styleLabel, onPick, onCurationChange, own = null }) {
    this.player = player;
    this.styleLabel = styleLabel || ((id) => id);
    this.onPick = onPick;
    this.onCurationChange = onCurationChange;
    this.own = own;
    this.manifest = null;
    this.removed = new Set();
    this.mode = "curate";
    this.layer = null;
    this.styleKey = "custom";
    this.current = "";
    this.filter = { category: "all", moods: new Set(), search: "", styleOnly: false, showRemoved: true };
    this.playTimer = 0;
    this.confirmTimer = 0;
    this.busy = false;
    this.build();
  }

  build() {
    const dialog = document.createElement("dialog");
    dialog.className = "board";
    dialog.setAttribute("aria-labelledby", "boardTitle");
    dialog.innerHTML = `
      <div class="board-shell">
        <header class="board-head">
          <div class="board-heading">
            <h2 class="board-title" id="boardTitle">Библиотека звуков</h2>
            <p class="board-sub" data-sub></p>
          </div>
          <button type="button" class="icon-btn board-close" data-close aria-label="Закрыть">×</button>
        </header>
        <div class="board-tools">
          <div class="seg board-groups" data-groups></div>
          <div class="board-row">
            <input class="board-search" type="search" placeholder="Найти звук" aria-label="Найти звук" data-search>
            <label class="toggle" data-style-wrap><input type="checkbox" data-style-only><span data-style-label>Для стиля</span></label>
            <label class="toggle" data-removed-wrap><input type="checkbox" data-show-removed checked><span>Показывать убранные</span></label>
          </div>
          <div class="chips board-moods" data-moods></div>
        </div>
        <div class="board-list" data-list></div>
        <footer class="board-foot">
          <span class="board-count" data-count></span>
          <button type="button" class="btn btn-primary" data-close>Готово</button>
        </footer>
      </div>`;
    document.body.appendChild(dialog);
    this.dialog = dialog;
    this.el = {
      sub: dialog.querySelector("[data-sub]"),
      groups: dialog.querySelector("[data-groups]"),
      search: dialog.querySelector("[data-search]"),
      styleOnly: dialog.querySelector("[data-style-only]"),
      styleWrap: dialog.querySelector("[data-style-wrap]"),
      styleLabel: dialog.querySelector("[data-style-label]"),
      showRemoved: dialog.querySelector("[data-show-removed]"),
      removedWrap: dialog.querySelector("[data-removed-wrap]"),
      moods: dialog.querySelector("[data-moods]"),
      list: dialog.querySelector("[data-list]"),
      count: dialog.querySelector("[data-count]"),
    };
    dialog.addEventListener("click", (event) => this.onClick(event));
    dialog.addEventListener("close", () => {
      window.clearTimeout(this.playTimer);
      this.player?.stopAudition?.();
    });
    this.el.search.addEventListener("input", () => {
      this.filter.search = this.el.search.value.trim().toLowerCase();
      this.drawList();
    });
    this.el.styleOnly.addEventListener("change", () => {
      this.filter.styleOnly = this.el.styleOnly.checked;
      this.drawList();
    });
    this.el.showRemoved.addEventListener("change", () => {
      this.filter.showRemoved = this.el.showRemoved.checked;
      this.drawList();
    });
    dialog.addEventListener("keydown", (event) => {
      const rename = event.target.closest?.("[data-rename-input]");
      if (rename) {
        if (event.key === "Enter") { event.preventDefault(); rename.blur(); }
        if (event.key === "Escape") { event.preventDefault(); rename.dataset.cancel = "1"; rename.blur(); }
        return;
      }
      const card = event.target.closest?.(".scard");
      if (!card || event.target !== card) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        this.play(card.dataset.id);
      }
    });
    dialog.addEventListener("focusout", (event) => {
      const input = event.target.closest?.("[data-rename-input]");
      if (input) void this.finishRename(input);
    });
  }

  open({ manifest, removed, mode = "curate", layer = null, styleKey = "custom", current = "", category = null }) {
    this.manifest = manifest;
    this.removed = new Set(removed || []);
    this.mode = mode;
    this.layer = mode === "music" ? null : layer;
    this.styleKey = styleKey;
    this.current = current || "";
    const start = category || (mode === "music" ? "mine" : "all");
    this.filter = { category: start, moods: new Set(), search: "", styleOnly: false, showRemoved: mode === "curate" };
    this.el.search.value = "";
    this.el.styleOnly.checked = false;
    this.el.showRemoved.checked = this.filter.showRemoved;
    this.el.removedWrap.hidden = mode !== "curate";
    this.el.styleWrap.hidden = mode === "music";
    this.el.styleLabel.textContent = `Подходит стилю «${this.styleLabel(styleKey)}»`;
    this.dialog.classList.toggle("is-pick", mode !== "curate");
    this.dialog.querySelector("#boardTitle").textContent = mode === "music" ? "Музыка на фон" : "Библиотека звуков";
    this.drawMoods();
    this.drawGroups();
    this.drawList();
    if (!this.dialog.open) this.dialog.showModal();
    this.el.list.scrollTop = 0;
  }

  close() {
    if (this.dialog.open) this.dialog.close();
  }

  categories() {
    return this.manifest?.categories || FALLBACK_CATEGORIES;
  }

  /** Порядок разделов: для слоя — ближние к нему первыми; свои звуки — в начале, если есть. */
  categoryOrder() {
    const all = Object.keys(this.categories());
    const preferred = LAYER_ORDER[this.layer] || [];
    const ordered = [...preferred.filter((id) => all.includes(id)), ...all.filter((id) => !preferred.includes(id))];
    const withoutMine = ordered.filter((id) => id !== "mine");
    const hasMine = this.sounds().some((sound) => sound.category === "mine");
    return hasMine ? ["mine", ...withoutMine] : [...withoutMine, "mine"];
  }

  /** Звуки этого режима: для слоя — всё, кроме музыки; для музыки — свои треки. */
  sounds() {
    const list = this.manifest?.sounds || [];
    if (this.mode === "music") return list.filter((sound) => sound.kind === "music");
    if (this.mode === "pick") return list.filter((sound) => sound.kind !== "music");
    return list;
  }

  styleIds() {
    const set = this.manifest?.styles?.[this.styleKey] || this.manifest?.styles?.custom;
    const layers = this.layer ? [this.layer] : SOUND_LAYERS.map((layer) => layer.id);
    // У слоя вне наборов (склейки) свои подходящие звуки — одни на все стили.
    return new Set(layers.flatMap((id) => set?.sounds?.[id] || SOUND_LAYERS.find((layer) => layer.id === id)?.suggest || []));
  }

  stylesUsing(id) {
    return Object.entries(this.manifest?.styles || {})
      .filter(([, set]) => SOUND_LAYERS.some(({ id: layer }) => (set.sounds?.[layer] || []).includes(id)))
      .map(([key]) => this.styleLabel(key));
  }

  drawGroups() {
    const counts = {};
    for (const sound of this.sounds()) counts[sound.category] = (counts[sound.category] || 0) + 1;
    const names = this.categories();
    const buttons = this.mode === "music"
      ? [["mine", "Мои треки"]]
      : [["all", "Все"], ...this.categoryOrder().filter((id) => counts[id] || id === "mine").map((id) => [id, names[id] || id])];
    this.el.groups.innerHTML = buttons
      .map(([id, label]) => `<button type="button" data-group="${escapeHtml(id)}" class="${id === this.filter.category ? "is-active" : ""}">${escapeHtml(label)}</button>`)
      .join("");
    this.el.groups.hidden = this.mode === "music";
  }

  drawMoods() {
    const moods = this.manifest?.moods || {};
    this.el.moods.hidden = this.mode === "music";
    this.el.moods.innerHTML = Object.entries(moods)
      .map(([id, label]) => `<button type="button" class="chip${this.filter.moods.has(id) ? " is-active" : ""}" data-mood="${escapeHtml(id)}">${escapeHtml(label)}</button>`)
      .join("");
  }

  visible() {
    const styleIds = this.filter.styleOnly ? this.styleIds() : null;
    const search = this.filter.search;
    return this.sounds().filter((sound) => {
      if (this.filter.category !== "all" && sound.category !== this.filter.category) return false;
      if (!this.filter.showRemoved && this.removed.has(sound.id) && sound.id !== this.current) return false;
      if (styleIds && !styleIds.has(sound.id) && sound.id !== this.current) return false;
      if (this.filter.moods.size && !sound.mine && !(sound.moods || []).some((m) => this.filter.moods.has(m))) return false;
      if (search) {
        const text = `${sound.label} ${sound.note || ""} ${sound.id} ${sourceLine(sound)} ${this.categories()[sound.category] || ""}`.toLowerCase();
        if (!text.includes(search)) return false;
      }
      return true;
    });
  }

  ownActionsHtml() {
    if (!this.own) return "";
    const video = this.own.hasVideo?.();
    const music = this.mode === "music";
    return `
      <div class="own-actions">
        <button type="button" class="btn btn-sm" data-own-file>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4M7 9l5-5 5 5M5 20h14"/></svg>
          <span>${music ? "Загрузить трек" : "Загрузить файл"}</span>
        </button>
        <button type="button" class="btn btn-sm" data-own-video${video ? "" : " disabled"}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h11v12H4zM15 10l5-3v10l-5-3"/></svg>
          <span>${music ? "Звук из этого видео" : "Кусок из этого видео"}</span>
        </button>
        <span class="own-note">${music
          ? "MP3, M4A, WAV или любое видео — выбери кусок трека."
          : "Аудио или видео: выдели нужный кусок, и он станет звуком, который можно поставить на любой слой."}</span>
      </div>`;
  }

  cardHtml(sound) {
    const removed = this.removed.has(sound.id);
    const current = sound.id === this.current;
    const styles = sound.mine ? [] : this.stylesUsing(sound.id);
    const stylesText = styles.length ? `Подходит: ${styles.slice(0, 2).join(", ")}${styles.length > 2 ? ` и ещё ${styles.length - 2}` : ""}` : "";
    let badge = "";
    if (sound.own) badge = `<span class="scard-badge is-warn" title="Лицензия неизвестна: запись взята из интернета. Для публикации надёжнее звуки Freesound или Kenney (CC0).">лицензия?</span>`;
    else if (sound.kind === "music") badge = '<span class="scard-badge">музыка</span>';
    else if (sound.stereo) badge = '<span class="scard-badge">стерео</span>';
    const meta = [sourceLine(sound), secondsLabel(sound)].filter(Boolean).join(" · ");
    let action;
    if (this.mode !== "curate") {
      action = `<button type="button" class="btn btn-sm${current ? " is-current" : ""}" data-choose>${current ? "Выбран" : "Выбрать"}</button>`;
    } else if (sound.mine) {
      action = "";
    } else {
      action = `<button type="button" class="keep${removed ? "" : " is-kept"}" data-keep aria-pressed="${removed ? "false" : "true"}">${removed ? "Убран" : "✓ В студии"}</button>`;
    }
    const tools = sound.mine
      ? `<span class="scard-tools"><button type="button" class="link-btn" data-rename>Переименовать</button><button type="button" class="link-btn is-danger" data-delete>Удалить</button></span>`
      : "";
    return `
      <article class="scard${removed && !sound.mine ? " is-removed" : ""}${current ? " is-current" : ""}" data-id="${escapeHtml(sound.id)}" tabindex="0">
        <button type="button" class="scard-play" data-play aria-label="Послушать: ${escapeHtml(sound.label)}">${PLAY_ICON}${WAVE_ICON}</button>
        <div class="scard-body">
          <div class="scard-name"><span data-name>${escapeHtml(sound.label)}</span> ${badge}</div>
          <div class="scard-meta">${escapeHtml(meta)}</div>
          ${sound.note ? `<div class="scard-note">${escapeHtml(sound.note)}</div>` : ""}
          ${stylesText ? `<div class="scard-styles" title="${escapeHtml(`Подходит: ${styles.join(", ")}`)}">${escapeHtml(stylesText)}</div>` : ""}
          ${tools}
        </div>
        <div class="scard-action">${action}</div>
      </article>`;
  }

  drawList() {
    const items = this.visible();
    const html = [];
    const names = this.categories();
    const groups = this.filter.category === "all" ? this.categoryOrder() : [this.filter.category];
    for (const group of groups) {
      let list = items.filter((sound) => sound.category === group);
      if (group === "mine") list = list.sort((a, b) => (b.created || 0) - (a.created || 0));
      if (!list.length && group !== "mine") continue;
      if (group === "mine" && (this.filter.search || this.filter.styleOnly || this.filter.moods.size) && !list.length) continue;
      if (groups.length > 1) html.push(`<h3 class="board-group-title">${escapeHtml(names[group] || group)} <span>${list.length || ""}</span></h3>`);
      if (group === "mine") html.push(this.ownActionsHtml());
      if (list.length) html.push(`<div class="board-grid">${list.map((sound) => this.cardHtml(sound)).join("")}</div>`);
      else if (group === "mine") html.push(`<p class="board-empty board-empty-own">${this.mode === "music" ? "Пока нет своих треков." : "Своих звуков пока нет."}</p>`);
    }
    if (!html.length) html.push('<p class="board-empty">Ничего не нашлось. Сними фильтры или поищи другим словом.</p>');
    this.el.list.innerHTML = html.join("");
    this.drawCounts();
  }

  drawCounts() {
    const all = this.sounds();
    const library = all.filter((sound) => !sound.mine);
    const kept = library.filter((sound) => !this.removed.has(sound.id)).length;
    const own = all.length - library.length;
    if (this.mode === "music") {
      this.el.sub.textContent = "Свой трек или звук из видео. Он плавно войдёт, станет тише под голос и уйдёт в конце ролика.";
      this.el.count.textContent = own ? `Своих треков: ${own}` : "";
    } else if (this.mode === "pick") {
      const layerTitle = SOUND_LAYERS.find((layer) => layer.id === this.layer)?.label || "";
      this.el.sub.textContent = `Звук для слоя «${layerTitle}» — подойдёт любой звук библиотеки. Нажми ▶, чтобы послушать, и «Выбрать».`;
      this.el.count.textContent = `В студии ${kept} из ${library.length} звуков${own ? ` · своих ${own}` : ""}`;
    } else {
      this.el.sub.textContent = "Послушай каждый звук. Убранные не показываются в студии — вернуть можно в любой момент.";
      this.el.count.textContent = `В студии ${kept} из ${library.length} · убрано ${library.length - kept}${own ? ` · своих ${own}` : ""}`;
    }
  }

  play(id) {
    const sound = this.sounds().find((item) => item.id === id);
    if (!sound) return;
    const layer = this.layer || (sound.kind === "music" ? "music" : (["typing", "word", "phrase", "accent"].includes(sound.group) ? sound.group : "word"));
    void this.player?.audition?.(id, layer, 0.85);
    this.dialog.querySelectorAll(".scard.is-playing").forEach((card) => card.classList.remove("is-playing"));
    const card = this.dialog.querySelector(`.scard[data-id="${CSS.escape(id)}"]`);
    if (!card) return;
    card.classList.add("is-playing");
    window.clearTimeout(this.playTimer);
    const long = Number(sound.seconds) > 0.6;
    const length = sound.kind === "music" ? 12 : layer === "word" && !long ? 1.3 : layer === "typing" && !long ? 1.9 : Math.min(3.2, Number(sound.seconds) || 1);
    this.playTimer = window.setTimeout(() => card.classList.remove("is-playing"), length * 1000 + 150);
  }

  /** Новый свой звук: из файла или из видео студии → выбор куска → сохранение. */
  async addOwn(from) {
    if (!this.own || this.busy) return;
    this.busy = true;
    this.player?.stopAudition?.();
    const wantMusic = this.mode === "music";
    try {
      const source = from === "video" ? await this.own.videoSource() : await this.own.pickFile();
      if (!source) return;
      const entry = await this.own.clip.open({
        source: source.upload ? { upload: source.upload } : { source: source.source },
        name: source.name,
        kind: wantMusic ? "music" : "sfx",
      });
      if (!entry) return;
      this.manifest = await this.own.reload();
      const fits = wantMusic ? entry.kind === "music" : entry.kind !== "music";
      if (fits && this.mode !== "curate") {
        this.current = entry.id;
        this.onPick?.(this.layer || "music", entry.id);
        this.close();
        return;
      }
      this.filter.category = "mine";
      this.drawGroups();
      this.drawList();
    } catch (error) {
      this.flash(error?.message || String(error));
    } finally {
      this.busy = false;
    }
  }

  flash(text) {
    let note = this.dialog.querySelector(".board-flash");
    if (!note) {
      note = document.createElement("p");
      note.className = "board-flash";
      this.dialog.querySelector(".board-tools").appendChild(note);
    }
    note.textContent = text;
    note.hidden = !text;
    window.clearTimeout(this.flashTimer);
    this.flashTimer = window.setTimeout(() => { note.hidden = true; }, 6000);
  }

  startRename(card) {
    const name = card.querySelector("[data-name]");
    if (!name || name.querySelector("input")) return;
    const sound = this.sounds().find((item) => item.id === card.dataset.id);
    name.innerHTML = `<input class="scard-rename" type="text" maxlength="60" data-rename-input value="${escapeHtml(sound?.label || "")}" aria-label="Новое название">`;
    const input = name.querySelector("input");
    input.focus();
    input.select();
  }

  async finishRename(input) {
    const card = input.closest(".scard");
    const id = card?.dataset.id;
    const sound = this.sounds().find((item) => item.id === id);
    const label = input.value.trim();
    if (input.dataset.cancel || !sound || !label || label === sound.label) {
      if (card) card.querySelector("[data-name]").textContent = sound?.label || "";
      return;
    }
    try {
      await this.own.request(`/api/sounds/own/${encodeURIComponent(id)}`, { method: "POST", body: { label } });
      this.manifest = await this.own.reload();
      this.drawList();
      this.onPick?.("__renamed", id);
    } catch (error) {
      this.flash(error?.message || String(error));
      if (card) card.querySelector("[data-name]").textContent = sound.label;
    }
  }

  async deleteOwn(card, button) {
    const id = card.dataset.id;
    if (button.dataset.armed !== "1") {
      button.dataset.armed = "1";
      button.textContent = "Точно удалить?";
      window.clearTimeout(this.confirmTimer);
      this.confirmTimer = window.setTimeout(() => {
        button.dataset.armed = "";
        button.textContent = "Удалить";
      }, 3000);
      return;
    }
    try {
      await this.own.request(`/api/sounds/own/${encodeURIComponent(id)}`, { method: "DELETE" });
      this.manifest = await this.own.reload();
      if (this.current === id) this.current = "";
      this.drawGroups();
      this.drawList();
      this.onPick?.("__deleted", id);
    } catch (error) {
      this.flash(error?.message || String(error));
    }
  }

  onClick(event) {
    if (tappedBackdrop(event, this.dialog)) {
      this.close(); // щелчок по затемнению
      return;
    }
    if (event.target.closest("[data-close]")) {
      this.close();
      return;
    }
    if (event.target.closest("[data-own-file]")) {
      void this.addOwn("file");
      return;
    }
    if (event.target.closest("[data-own-video]")) {
      void this.addOwn("video");
      return;
    }
    const group = event.target.closest("[data-group]");
    if (group) {
      this.filter.category = group.dataset.group;
      this.drawGroups();
      this.drawList();
      this.el.list.scrollTop = 0;
      return;
    }
    const mood = event.target.closest("[data-mood]");
    if (mood) {
      const id = mood.dataset.mood;
      if (this.filter.moods.has(id)) this.filter.moods.delete(id);
      else this.filter.moods.add(id);
      mood.classList.toggle("is-active", this.filter.moods.has(id));
      this.drawList();
      return;
    }
    const card = event.target.closest(".scard");
    if (!card) return;
    if (event.target.closest("[data-rename-input]")) return;
    const id = card.dataset.id;
    if (event.target.closest("[data-rename]")) {
      this.startRename(card);
      return;
    }
    const remove = event.target.closest("[data-delete]");
    if (remove) {
      void this.deleteOwn(card, remove);
      return;
    }
    if (event.target.closest("[data-choose]")) {
      this.current = id;
      this.onPick?.(this.layer || "music", id);
      this.close();
      return;
    }
    if (event.target.closest("[data-keep]")) {
      if (this.removed.has(id)) this.removed.delete(id);
      else this.removed.add(id);
      const removed = this.removed.has(id);
      card.classList.toggle("is-removed", removed);
      const keep = card.querySelector("[data-keep]");
      keep.classList.toggle("is-kept", !removed);
      keep.setAttribute("aria-pressed", removed ? "false" : "true");
      keep.textContent = removed ? "Убран" : "✓ В студии";
      this.drawCounts();
      this.onCurationChange?.(new Set(this.removed));
      return;
    }
    this.play(id);
  }
}
