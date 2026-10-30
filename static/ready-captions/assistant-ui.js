// ИИ-помощник в студии: «как сделан этот ролик» (разбор чужого видео) и вопросы о монтаже.
//
// Окно с двумя вкладками. «Разобрать ролик»: человек выбирает чужое видео, оно уходит
// на сервер, сервер меряет склейки, цвет, ритм и речь (а ИИ смотрит кадры), и студия
// показывает, что в ролике сделано, и шаги с кнопкой «Сделать». «Сделать похожий»
// применяет всё сразу: стиль субтитров, цвет и атмосферу, переходы, камеру, звук на
// склейках — а нарезку под музыку открывает уже настроенной. «Спросить» — чат.
//
// Всё, что меняет саму студию, делает main.js (объект studio): этот модуль только рисует окно.

const POLL_MS = 1200;
const CHIPS = [
  "Как сделать переходы?",
  "Как нарезать видео под музыку?",
  "Как замедлить кусок видео?",
  "Как наложить музыку?",
  "Как убрать паузы и «эээ»?",
  "Как сделать цвет как в кино?",
  "Как смонтировать фильм из нескольких видео?",
];
const LAST_KEY = "reel-lab:assistant-last";

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
const clock = (seconds) => {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/**
 * api(url, { method, body }) — запрос к серверу с CSRF; upload(file, onProgress, signal) → { id };
 * studio — что умеет студия: context(), applyStep(step, record), applyAll(record), takeMusic(record),
 * pickVideos(record, files), runAction(action), actionLabel(action), multiPick(record).
 */

/** Щелчок по затемнению вокруг окна, а не по пустому месту внутри (на телефоне окно во весь экран). */
function tappedBackdrop(event, dialog) {
  if (event.target !== dialog) return false;
  const box = dialog.getBoundingClientRect();
  return event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom;
}

export function createAssistant({ api, upload, studio, toast = () => {} }) {
  const $ = (id) => document.getElementById(id);
  const dialog = $("assistantDialog");
  if (!dialog) return { open() {}, openAnalysis() {} };
  const ui = {
    tabs: $("assistantTabs"), analyse: $("assistantAnalyse"), ask: $("assistantAsk"),
    pick: $("assistantPick"), choose: $("assistantChoose"), file: $("assistantFile"),
    progress: $("assistantProgress"), bar: $("assistantBar"), phase: $("assistantPhase"), stop: $("assistantStop"),
    result: $("assistantResult"), chat: $("assistantChat"), chips: $("assistantChips"),
    form: $("assistantForm"), input: $("assistantInput"), close: $("assistantClose"),
    mine: $("assistantMine"),
  };
  const st = { tab: "analyse", record: null, run: 0, controller: null, chat: [], asking: false, done: new Set(), musicTaken: false };

  function setTab(tab) {
    st.tab = tab === "ask" ? "ask" : "analyse";
    ui.tabs.querySelectorAll("button[data-tab]").forEach((button) => {
      const on = button.dataset.tab === st.tab;
      button.classList.toggle("is-active", on);
      button.setAttribute("aria-selected", String(on));
    });
    ui.analyse.hidden = st.tab !== "analyse";
    ui.ask.hidden = st.tab !== "ask";
    if (st.tab === "ask") {
      drawChat();
      window.setTimeout(() => ui.input.focus({ preventScroll: true }), 50);
    }
  }

  function open(tab = st.tab) {
    if (!st.record && st.run === 0) restoreLast();
    // Студия могла измениться (выбрали видео, взяли музыку) — кнопки разбора рисуем заново.
    else if (st.record && !ui.result.hidden) drawResult();
    if (!dialog.open) dialog.showModal();
    setTab(tab);
  }

  function restoreLast() {
    let id = "";
    try { id = sessionStorage.getItem(LAST_KEY) || ""; } catch (_) { /* браузер не хранит */ }
    if (id) void openAnalysis(id, { quiet: true });
  }

  // --- Разбор ролика ---------------------------------------------------------

  function showPick() {
    st.run += 1;
    st.controller?.abort();
    ui.pick.hidden = false;
    ui.progress.hidden = true;
    ui.result.hidden = true;
  }

  function showProgress(part, text) {
    ui.pick.hidden = true;
    ui.result.hidden = true;
    ui.progress.hidden = false;
    ui.bar.style.width = `${Math.round(Math.max(0.02, Math.min(1, part)) * 100)}%`;
    ui.phase.textContent = text;
  }

  function showError(text) {
    ui.progress.hidden = true;
    ui.result.hidden = false;
    ui.pick.hidden = true;
    ui.result.innerHTML = `<p class="as-error">${esc(text || "Не получилось разобрать ролик.")}</p>
      <button type="button" class="btn btn-ghost btn-wide" data-as="again">Выбрать другой ролик</button>`;
  }

  async function analyseFile(file) {
    const run = ++st.run;
    st.controller?.abort();
    const controller = new AbortController();
    st.controller = controller;
    showProgress(0.02, "Загружаю ролик…");
    try {
      const uploaded = await upload(file, (part) => {
        if (run === st.run) showProgress(0.02 + part * 0.26, `Загружаю ролик… ${Math.round(part * 100)}%`);
      }, controller.signal);
      if (run !== st.run) return;
      const started = await api("/api/assistant/analyses", { body: { upload_id: uploaded.id } });
      await follow(started.id, run);
    } catch (error) {
      if (run !== st.run || error?.name === "AbortError") return;
      showError(error?.message || String(error));
    }
  }

  async function follow(id, run, { quiet = false } = {}) {
    let failures = 0;
    for (;;) {
      if (run !== st.run) return;
      let record;
      try {
        record = await api(`/api/assistant/analyses/${encodeURIComponent(id)}`, { method: "GET" });
        failures = 0;
      } catch (error) {
        failures += 1;
        if (failures > 5 || /не найден/i.test(error?.message || "")) {
          if (quiet) showPick();
          else showError(error?.message || "Разбор не найден.");
          return;
        }
        await sleep(POLL_MS * 2);
        continue;
      }
      if (run !== st.run) return;
      if (record.status === "done" && record.result) {
        showResult(record);
        return;
      }
      if (record.status === "failed") {
        showError(record.error);
        return;
      }
      showProgress(0.28 + 0.72 * (Number(record.progress) || 0) / 100, record.phase_text || "Разбираю ролик…");
      await sleep(POLL_MS);
    }
  }

  async function openAnalysis(id, { quiet = false } = {}) {
    if (!id) return;
    const run = ++st.run;
    if (!quiet) {
      if (!dialog.open) dialog.showModal();
      setTab("analyse");
    }
    showProgress(0.3, "Открываю разбор…");
    await follow(id, run, { quiet });
  }

  function stepHtml(step, index) {
    const done = st.done.has(index);
    const button = step.tool
      ? `<button type="button" class="chip as-do${done ? " is-done" : ""}" data-step="${index}">${done ? "✓ Сделано" : "Сделать"}</button>`
      : "";
    return `<li class="as-step"><div class="as-step-copy"><b>${esc(step.title)}</b><p>${esc(step.text)}</p></div>${button}</li>`;
  }

  function list(title, items, cls = "") {
    if (!items?.length) return "";
    return `<h3>${esc(title)}</h3><ul class="as-list ${cls}">${items.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>`;
  }

  function drawResult() {
    const record = st.record;
    const result = record?.result;
    if (!result) return;
    const features = result.features || {};
    const meta = features.meta || {};
    const ai = result.ai || {};
    const ctx = studio.context();
    const hasMusic = result.recipe?.music === "reference";
    const multi = studio.multiPick(record);
    const main = ctx.video
      ? `<button type="button" class="btn btn-primary btn-wide" data-as="all">✦ Сделать похожий</button>`
      : `<button type="button" class="btn btn-primary btn-wide" data-as="mine">✦ Сделать похожий из ${multi ? "своих видео" : "своего видео"}</button>`;
    ui.result.innerHTML = `
      <div class="as-head">
        <span class="as-kind">${esc(result.title || "Разбор")}</span>
        <span class="as-meta">${esc([clock(meta.duration), meta.aspect].filter(Boolean).join(" · "))}</span>
      </div>
      ${ai.summary ? `<p class="as-summary">${esc(ai.summary)}</p>` : ""}
      <div class="as-actions">
        ${main}
        ${hasMusic ? (st.musicTaken
          ? `<button type="button" class="btn btn-ghost btn-wide" data-as="music" disabled>♪ Музыка из образца — на фоне ✓</button>`
          : `<button type="button" class="btn btn-ghost btn-wide" data-as="music">♪ Взять музыку из образца</button>`) : ""}
      </div>
      <p class="note as-applied" id="assistantApplied" ${st.applied ? "" : "hidden"}>${esc(st.applied || "")}</p>
      ${result.note ? `<p class="note as-note">${esc(result.note)}</p>` : ""}
      ${list("Что в нём сделано", result.observations)}
      ${list("Почему это работает", ai.insights)}
      <h3>Как сделать так же в Reel Lab</h3>
      <ol class="as-steps">${(result.steps || []).map(stepHtml).join("")}</ol>
      ${list("Советы", ai.tips)}
      ${ai.idea ? `<p class="as-idea">💡 ${esc(ai.idea)}</p>` : ""}
      <button type="button" class="link-btn as-again" data-as="again">Разобрать другой ролик</button>`;
  }

  function showResult(record) {
    if (st.record?.id !== record.id) {
      st.done = new Set();
      st.applied = "";
      st.musicTaken = false;
    }
    st.record = record;
    try { sessionStorage.setItem(LAST_KEY, record.id); } catch (_) { /* не запомнится */ }
    ui.pick.hidden = true;
    ui.progress.hidden = true;
    ui.result.hidden = false;
    drawResult();
  }

  async function onResultClick(event) {
    const button = event.target.closest("button");
    if (!button || button.disabled) return;
    const record = st.record;
    const action = button.dataset.as;
    if (action === "again") {
      showPick();
      return;
    }
    if (!record) return;
    const busy = (text) => {
      button.disabled = true;
      button.dataset.label = button.textContent;
      button.textContent = text;
    };
    const free = () => {
      button.disabled = false;
      if (button.dataset.label) button.textContent = button.dataset.label;
    };
    try {
      if (button.dataset.step !== undefined) {
        const index = Number(button.dataset.step);
        const step = record.result.steps[index];
        busy("…");
        const note = await studio.applyStep(step, record);
        st.done.add(index);
        if (note) toast(note, 4200);
        drawResult();
        if (step.tool === "beat" || step.tool === "timeline") dialog.close();
      } else if (action === "all") {
        busy("Настраиваю…");
        const summary = await studio.applyAll(record);
        if (summary.text) st.applied = summary.text;
        (record.result.steps || []).forEach((step, index) => { if (summary.tools.includes(step.tool)) st.done.add(index); });
        drawResult();
        if (summary.text) toast(summary.text, 5200);   // пусто — студия занята и уже сказала об этом
        if (summary.close) dialog.close();
      } else if (action === "mine") {
        ui.mine.multiple = studio.multiPick(record);
        ui.mine.click();
      } else if (action === "music") {
        busy("Беру музыку…");
        const note = await studio.takeMusic(record);
        st.musicTaken = true;   // второй раз ту же музыку не добавляем
        button.textContent = "♪ Музыка из образца — на фоне ✓";
        button.dataset.label = button.textContent;
        toast(note || "Музыка из образца стоит на фоне.", 4200);
        button.disabled = true;
      }
    } catch (error) {
      free();
      toast(`Не получилось: ${error?.message || error}`, 5200);
    }
  }

  async function onMinePicked() {
    const files = [...(ui.mine.files || [])];
    ui.mine.value = "";
    if (!files.length || !st.record) return;
    const record = st.record;
    dialog.close();
    try {
      const summary = await studio.pickVideos(record, files);
      st.applied = summary?.text || "";
      if (summary?.tools) (record.result.steps || []).forEach((step, index) => { if (summary.tools.includes(step.tool)) st.done.add(index); });
      if (summary?.text) toast(summary.text, 5600);
    } catch (error) {
      toast(`Не получилось: ${error?.message || error}`, 5600);
    }
  }

  // --- Вопросы ---------------------------------------------------------------

  function drawChat() {
    const hello = `<div class="as-msg as-bot"><p>Привет! Я знаю всё о студии Reel Lab. Спроси, как сделать что угодно: переходы, нарезку под музыку, замедление, цвет как в кино, субтитры для песни. Или пришли чужой ролик во вкладке «Разобрать ролик» — расскажу, как он сделан.</p></div>`;
    ui.chat.innerHTML = hello + st.chat.map((item, index) => {
      const actions = (item.actions || []).map((action, k) => (
        `<button type="button" class="chip as-act" data-msg="${index}" data-act="${k}">${esc(studio.actionLabel(action))}</button>`
      )).join("");
      const text = esc(item.text).replace(/\n/g, "<br>");
      return `<div class="as-msg ${item.role === "user" ? "as-user" : "as-bot"}${item.pending ? " is-pending" : ""}"><p>${text}</p>${actions ? `<div class="as-acts">${actions}</div>` : ""}</div>`;
    }).join("");
    ui.chips.hidden = st.chat.length > 2;
    ui.chips.innerHTML = CHIPS.map((text) => `<button type="button" class="chip" data-q="${esc(text)}">${esc(text)}</button>`).join("");
    ui.chat.scrollTop = ui.chat.scrollHeight;
  }

  async function ask(question) {
    const text = String(question || "").trim();
    if (!text || st.asking) return;
    st.asking = true;
    const history = st.chat.filter((item) => !item.pending).slice(-6).map((item) => ({ role: item.role, text: item.text }));
    st.chat.push({ role: "user", text });
    const pending = { role: "assistant", text: "Думаю…", pending: true };
    st.chat.push(pending);
    drawChat();
    try {
      const answer = await api("/api/assistant/ask", { body: { question: text, history, context: studio.context() } });
      Object.assign(pending, { text: answer.answer || "Не получилось ответить.", actions: answer.actions || [], pending: false });
    } catch (error) {
      Object.assign(pending, { text: `Не получилось: ${error?.message || error}`, pending: false });
    } finally {
      st.asking = false;
      drawChat();
    }
  }

  // --- Подключение -----------------------------------------------------------

  ui.close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => { if (tappedBackdrop(event, dialog)) dialog.close(); });
  ui.tabs.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-tab]");
    if (button) setTab(button.dataset.tab);
  });
  ui.choose.addEventListener("click", () => ui.file.click());
  ui.file.addEventListener("change", () => {
    const [file] = ui.file.files || [];
    ui.file.value = "";
    if (file) void analyseFile(file);
  });
  ui.stop.addEventListener("click", showPick);
  ui.result.addEventListener("click", (event) => { void onResultClick(event); });
  ui.mine.addEventListener("change", () => { void onMinePicked(); });
  ui.form.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = ui.input.value;
    ui.input.value = "";
    void ask(text);
  });
  ui.chips.addEventListener("click", (event) => {
    const chip = event.target.closest("[data-q]");
    if (chip) void ask(chip.dataset.q);
  });
  ui.chat.addEventListener("click", (event) => {
    const button = event.target.closest("[data-act]");
    if (!button) return;
    const action = st.chat[Number(button.dataset.msg)]?.actions?.[Number(button.dataset.act)];
    if (!action) return;
    const keepOpen = action.do === "open" && action.id === "assistant";
    if (!keepOpen) dialog.close();
    void Promise.resolve(studio.runAction(action)).catch((error) => toast(`Не получилось: ${error?.message || error}`, 5000));
  });

  return { open, openAnalysis, ask, state: st };
}
