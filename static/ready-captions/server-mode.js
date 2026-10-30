// Серверный режим: студия как мини-приложение Telegram.
//
// Вход — по подписанным данным Telegram (initData): сервер проверяет подпись
// токеном бота и выдаёт сессию. Сессия уходит заголовком X-Reel-Session в
// каждом запросе к API (обёртка над fetch ниже), тегам <video>/<audio> её
// приносит cookie. Здесь же — плашка тарифа, окно тарифов с оплатой звёздами
// или картой и лёгкий режим для телефона.
//
// В локальной студии на компьютере этот модуль ничего не делает.

const PAYWALL_CODES = new Set([
  "free_cap", "too_long_free", "paid_feature", "free_ai_cap", "ai_budget", "unlimited_cap", "no_credits",
  "source_too_long_free",
]);

const nativeFetch = window.fetch.bind(window);

export const server = {
  active: false,
  token: "",
  csrf: "",
  me: null,
  tg: null,
  bot: "",
  light: false,
  onMe: null,
  onPaywall: null,
};

function initDataFromHash() {
  try {
    const hash = location.hash.startsWith("#") ? location.hash.slice(1) : location.hash;
    return new URLSearchParams(hash).get("tgWebAppData") || "";
  } catch (_) {
    return "";
  }
}

function loadTelegramSdk() {
  if (window.Telegram?.WebApp) return Promise.resolve(window.Telegram.WebApp);
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(window.Telegram?.WebApp || null);
    };
    const script = document.createElement("script");
    script.src = "https://telegram.org/js/telegram-web-app.js";
    script.onload = finish;
    script.onerror = finish;
    document.head.append(script);
    window.setTimeout(finish, 5000);
  });
}

function versionAtLeast(tg, version) {
  try {
    return Boolean(tg?.isVersionAtLeast?.(version));
  } catch (_) {
    return false;
  }
}

function prepareTelegram(tg) {
  if (!tg) return;
  try { tg.ready(); } catch (_) { /* старый клиент */ }
  try { tg.expand(); } catch (_) { /* старый клиент */ }
  // Иначе свайп вниз по ленте студии сворачивает мини-приложение.
  if (versionAtLeast(tg, "7.7")) try { tg.disableVerticalSwipes(); } catch (_) { /* нет — не страшно */ }
  if (versionAtLeast(tg, "6.1")) {
    try { tg.setHeaderColor("#141218"); } catch (_) { /* цвет шапки по умолчанию */ }
    try { tg.setBackgroundColor("#141218"); } catch (_) { /* фон по умолчанию */ }
  }
  if (versionAtLeast(tg, "7.10")) try { tg.setBottomBarColor("#141218"); } catch (_) { /* нет нижней панели */ }
}

function detectLight(tg) {
  const platform = String(tg?.platform || "");
  if (["ios", "android", "android_x"].includes(platform)) return true;
  try {
    return window.matchMedia("(pointer: coarse) and (max-width: 900px)").matches;
  } catch (_) {
    return false;
  }
}

async function authenticate(initData) {
  const startParam = server.tg?.initDataUnsafe?.start_param || "";
  const response = await nativeFetch("/api/session", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ init_data: initData, start_param: startParam }),
  });
  let payload = {};
  try { payload = await response.json(); } catch (_) { /* не JSON */ }
  if (!response.ok || !payload.token) {
    throw new Error(payload.error || `Вход через Telegram не удался (${response.status}).`);
  }
  server.token = payload.token;
  server.csrf = payload.csrf;
  setMe(payload.me);
}

function setMe(me) {
  if (!me) return;
  server.me = me;
  if (me.bot) server.bot = me.bot;
  server.onMe?.(me);
}

function sameOriginApi(url) {
  if (!url) return false;
  if (url.startsWith("/api/")) return true;
  return url.startsWith(`${location.origin}/api/`);
}

function installFetch() {
  window.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url || "";
    if (!server.token || !sameOriginApi(url)) return nativeFetch(input, init);
    const send = () => {
      const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
      headers.set("X-Reel-Session", server.token);
      // После повторного входа у сессии новый ключ CSRF: старый из заголовка сервер бы отверг.
      if (headers.has("X-CSRF-Token") && server.csrf) headers.set("X-CSRF-Token", server.csrf);
      return nativeFetch(input, { credentials: "same-origin", ...init, headers });
    };
    let response = await send();
    if (response.status === 401) {
      // Сессия могла истечь (студия открыта очень давно) — входим заново и повторяем один раз.
      const initData = server.tg?.initData || initDataFromHash();
      if (initData) {
        try {
          await authenticate(initData);
          response = await send();
        } catch (_) { /* покажем ошибку как есть */ }
      }
    }
    if (response.status === 402 || response.status === 413 || response.status === 429) {
      response.clone().json().then((payload) => {
        if (payload && PAYWALL_CODES.has(payload.code)) server.onPaywall?.(payload);
      }).catch(() => {});
    }
    return response;
  };
}

/** Серверный режим включается, только если сервер так сказал. Возвращает server. */
export async function startServerMode() {
  let config = null;
  try {
    const response = await nativeFetch("/api/public/config", { cache: "no-store", credentials: "same-origin" });
    if (response.ok) config = await response.json();
  } catch (_) {
    config = null;
  }
  if (!config || config.mode !== "server") return server;
  server.active = true;
  server.bot = config.bot || "";
  document.documentElement.classList.add("is-server");
  const tg = await loadTelegramSdk();
  server.tg = tg;
  const initData = tg?.initData || initDataFromHash();
  if (!initData) {
    showGate(server.bot);
    throw new Error("outside-telegram");
  }
  prepareTelegram(tg);
  await authenticate(initData);
  installFetch();
  // Готовый ролик бот присылает в чат — для этого нужно разрешение писать (если студию открыли по ссылке).
  if (tg?.initDataUnsafe?.user && tg.initDataUnsafe.user.allows_write_to_pm === false && versionAtLeast(tg, "6.9")) {
    try { tg.requestWriteAccess(() => {}); } catch (_) { /* не страшно: ролик можно скачать из студии */ }
  }
  server.light = detectLight(tg);
  if (server.light) document.documentElement.classList.add("is-light");
  wireSheet();
  wireBackButton();
  return server;
}

export async function refreshMe() {
  if (!server.active) return null;
  const response = await fetch("/api/me", { cache: "no-store" });
  if (!response.ok) return server.me;
  const me = await response.json();
  setMe(me);
  return me;
}

export function applyMe(me) {
  setMe(me);
}

// --- Мелочи Telegram --------------------------------------------------------

export function haptic(kind = "light") {
  const feedback = server.tg?.HapticFeedback;
  if (!feedback) return;
  try {
    if (kind === "success" || kind === "error" || kind === "warning") feedback.notificationOccurred(kind);
    else feedback.impactOccurred(kind);
  } catch (_) { /* старый клиент */ }
}

let closeGuards = 0;

/** «Точно закрыть?» при закрытии студии, пока идёт хоть одна загрузка (их может быть несколько разом). */
export function guardClose(on) {
  closeGuards = Math.max(0, closeGuards + (on ? 1 : -1));
  const tg = server.tg;
  if (!tg || !versionAtLeast(tg, "6.2")) return;
  try {
    if (closeGuards > 0) tg.enableClosingConfirmation();
    else tg.disableClosingConfirmation();
  } catch (_) { /* старый клиент */ }
}

export function openExternal(url) {
  const tg = server.tg;
  if (tg?.openLink) {
    try { tg.openLink(url); return; } catch (_) { /* ниже — обычное окно */ }
  }
  window.open(url, "_blank", "noopener");
}

/** Скачать файл: в новых клиентах Telegram — родным окном сохранения. */
export function downloadFile(url, fileName) {
  const tg = server.tg;
  if (tg && versionAtLeast(tg, "8.0") && typeof tg.downloadFile === "function") {
    try {
      tg.downloadFile({ url, file_name: fileName });
      return true;
    } catch (_) { /* ниже — по ссылке */ }
  }
  openExternal(url);
  return false;
}

export function closeToChat() {
  try { server.tg?.close(); } catch (_) { /* старый клиент */ }
}

// --- Подсказка вне Telegram ---------------------------------------------------

function showGate(bot) {
  const gate = document.querySelector("#tgGate");
  if (!gate) return;
  const link = gate.querySelector("#tgGateLink");
  if (link && bot) {
    link.href = `https://t.me/${bot}`;
    link.textContent = `Открыть @${bot}`;
  }
  gate.hidden = false;
}

// --- Плашка тарифа и окно тарифов ---------------------------------------------

function videosRu(count) {
  const n = Math.abs(Number(count) || 0);
  const word = n % 10 === 1 && n % 100 !== 11 ? "ролик"
    : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? "ролика" : "роликов";
  return `${n} ${word}`;
}

function untilText(ts) {
  try {
    return new Date(ts * 1000).toLocaleDateString("ru-RU", { day: "numeric", month: "long", timeZone: "Europe/Moscow" });
  } catch (_) {
    return "";
  }
}

export function planLabel(me) {
  if (!me) return "";
  if (me.plan === "admin") return "Владелец";
  if (me.plan === "unlimited") return `Безлимит · сегодня ещё ${me.unlimited_left_today}`;
  if (me.plan === "pack") return videosRu(me.credits);
  return `Бесплатно · ${me.free_left_today} из ${me.free_per_day}`;
}

function statusText(me) {
  if (!me) return "";
  if (me.plan === "admin") return "Ты владелец бота: всё без ограничений.";
  const parts = [];
  if (me.plan === "unlimited") parts.push(`Безлимит до ${untilText(me.unlimited_until)}: сегодня можно ещё ${videosRu(me.unlimited_left_today)}.`);
  if (me.credits) parts.push(`Оплачено: ${videosRu(me.credits)}.`);
  if (me.plan === "free") {
    parts.push(`Бесплатно сегодня осталось ${videosRu(me.free_left_today)} из ${me.free_per_day} — до 1 минуты, с водяным знаком.`);
  }
  return parts.join(" ");
}

const sheet = {};

function $(selector) {
  return document.querySelector(selector);
}

function wireSheet() {
  sheet.root = $("#paywall");
  if (!sheet.root) return;
  sheet.reason = $("#paywallReason");
  sheet.status = $("#paywallStatus");
  sheet.products = $("#paywallProducts");
  sheet.support = $("#supportBox");
  sheet.supportText = $("#supportText");
  sheet.supportSend = $("#supportSend");
  sheet.supportNote = $("#supportNote");
  sheet.root.addEventListener("click", (event) => {
    if (event.target.closest("[data-close]")) closePaywall();
    const buy = event.target.closest("[data-buy]");
    // Скобки нужны: «void a === b» — это «(void a) === b», и кнопка карты платила бы звёздами.
    if (buy) void (buy.dataset.method === "card" ? buyCard(buy.dataset.buy, buy) : buyStars(buy.dataset.buy, buy));
  });
  $("#supportOpen")?.addEventListener("click", () => {
    sheet.support.hidden = !sheet.support.hidden;
    if (!sheet.support.hidden) sheet.supportText.focus();
  });
  sheet.supportSend?.addEventListener("click", () => { void sendSupport(); });
  const offer = $("#offerLink");
  offer?.addEventListener("click", (event) => {
    event.preventDefault();
    openExternal(`${location.origin}/legal/offer`);
  });
  const chip = $("#accountChip");
  chip?.addEventListener("click", () => openPaywall());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && sheet.waitingCard) void watchPayment(sheet.waitingCard);
  });
}

function planShort(me) {
  if (!me) return "";
  if (me.plan === "admin") return "★";
  if (me.plan === "unlimited") return "∞";
  if (me.plan === "pack") return String(me.credits);
  return `${me.free_left_today}/${me.free_per_day}`;
}

export function drawAccountChip(me = server.me) {
  const chip = $("#accountChip");
  if (!chip || !server.active) return;
  chip.hidden = false;
  chip.dataset.plan = me?.plan || "free";
  const long = chip.querySelector(".account-long");
  const short = chip.querySelector(".account-short");
  if (long) long.textContent = planLabel(me);
  if (short) short.textContent = planShort(me);
}

function productCard(product, payments) {
  const card = document.createElement("article");
  card.className = "product";
  card.dataset.product = product.id;
  const title = document.createElement("h3");
  title.textContent = product.title;
  const text = document.createElement("p");
  text.textContent = product.text;
  const row = document.createElement("div");
  row.className = "product-buy";
  if (payments.stars) {
    const stars = document.createElement("button");
    stars.type = "button";
    stars.className = "btn btn-primary";
    stars.dataset.buy = product.id;
    stars.dataset.method = "stars";
    stars.textContent = `⭐ ${product.stars}`;
    row.append(stars);
  }
  if (payments.card) {
    const card2 = document.createElement("button");
    card2.type = "button";
    card2.className = "btn btn-ghost";
    card2.dataset.buy = product.id;
    card2.dataset.method = "card";
    card2.textContent = `Картой ${product.rub} ₽`;
    row.append(card2);
  }
  card.append(title, text, row);
  return card;
}

export function openPaywall(reason = "") {
  if (!sheet.root || !server.me) return;
  // Окна студии (<dialog>) лежат поверх всего — тарифы под ними не видно. Закрываем их.
  document.querySelectorAll("dialog[open]").forEach((dialog) => dialog.close());
  const me = server.me;
  sheet.reason.hidden = !reason;
  sheet.reason.textContent = reason;
  sheet.status.textContent = statusText(me);
  sheet.products.replaceChildren(...(me.products || []).map((item) => productCard(item, me.payments || {})));
  sheet.support.hidden = true;
  if (sheet.supportNote) sheet.supportNote.textContent = "";
  sheet.root.hidden = false;
  document.documentElement.classList.add("has-sheet");
  syncBackButton();
  haptic("light");
}

export function closePaywall() {
  if (!sheet.root) return;
  sheet.root.hidden = true;
  document.documentElement.classList.remove("has-sheet");
  syncBackButton();
}

export function paywallOpen() {
  return Boolean(sheet.root && !sheet.root.hidden);
}

function setBusy(button, busy) {
  if (!button) return;
  button.disabled = busy;
  button.classList.toggle("is-busy", busy);
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": server.csrf },
    body: JSON.stringify(body),
  });
  let payload = {};
  try { payload = await response.json(); } catch (_) { /* не JSON */ }
  if (!response.ok) throw new Error(payload.error || `Ошибка ${response.status}`);
  return payload;
}

async function buyStars(product, button) {
  const tg = server.tg;
  setBusy(button, true);
  try {
    const { link } = await postJson("/api/billing/stars", { product });
    if (!tg?.openInvoice) {
      openExternal(link);
      return;
    }
    tg.openInvoice(link, (status) => {
      if (status === "paid") {
        haptic("success");
        toast("Оплата прошла — начисляю…");
        void watchPayment({ before: planPrint(server.me), until: Date.now() + 60000 });
      } else if (status === "failed") {
        haptic("error");
        toast("Оплата не прошла. Попробуй ещё раз.");
      }
    });
  } catch (error) {
    toast(error?.message || String(error));
  } finally {
    setBusy(button, false);
  }
}

async function buyCard(product, button) {
  setBusy(button, true);
  try {
    const { url } = await postJson("/api/billing/card", { product });
    sheet.waitingCard = { before: planPrint(server.me), until: Date.now() + 15 * 60000 };
    openExternal(url);
  } catch (error) {
    toast(error?.message || String(error));
  } finally {
    setBusy(button, false);
  }
}

/** Ждём, пока сервер начислит оплату (уведомление приходит за секунды). */
/** Что меняет оплата: тариф, оплаченные ролики, срок безлимита. Счётчики «до полуночи» сюда не входят — они меняются сами. */
function planPrint(me) {
  return JSON.stringify([me?.plan || "", Number(me?.credits) || 0, Number(me?.unlimited_until) || 0]);
}

async function watchPayment(wait) {
  if (!wait || sheet.watching) return;
  sheet.watching = true;
  try {
    while (Date.now() < wait.until) {
      const me = await refreshMe().catch(() => null);
      if (me && planPrint(me) !== wait.before && (me.plan !== "free" || me.credits)) {
        sheet.waitingCard = null;
        haptic("success");
        toast("Тариф начислен ✅ Можно собирать ролики без водяного знака");
        if (paywallOpen()) openPaywall();
        return;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 2500));
    }
  } finally {
    sheet.watching = false;
  }
}

async function sendSupport() {
  const text = sheet.supportText.value.trim();
  if (text.length < 3) {
    sheet.supportNote.textContent = "Напиши хотя бы пару слов.";
    return;
  }
  setBusy(sheet.supportSend, true);
  try {
    await postJson("/api/support", { text });
    sheet.supportText.value = "";
    sheet.supportNote.textContent = "Отправлено. Ответ придёт в чат с ботом.";
    haptic("success");
  } catch (error) {
    sheet.supportNote.textContent = error?.message || String(error);
  } finally {
    setBusy(sheet.supportSend, false);
  }
}

// --- Кнопка «Назад» Telegram ----------------------------------------------------

let backHandler = null;
let backExtra = () => false;
const openDialogs = [];   // в порядке открытия: «Назад» закрывает верхнее окно

let watchingDialogs = false;

/** Окно открылось или закрылось (любое <dialog> студии) — кнопка «Назад» Telegram следит за этим сама. */
function watchDialogs() {
  if (watchingDialogs || !document.body) return;
  watchingDialogs = true;
  const seen = (dialog) => {
    const index = openDialogs.indexOf(dialog);
    if (dialog.open && index < 0) openDialogs.push(dialog);
    if (!dialog.open && index >= 0) openDialogs.splice(index, 1);
  };
  document.querySelectorAll("dialog[open]").forEach(seen);
  new MutationObserver((records) => {
    for (const record of records) if (record.target?.tagName === "DIALOG") seen(record.target);
    // Уведомление было внутри закрывшегося окна — переносим туда, где его видно.
    const note = document.querySelector("#toast");
    const holder = note?.closest("dialog");
    if (holder && !holder.open) (topDialog() || document.body).append(note);
    syncBackButton();
  }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["open"] });
}

export function topDialog() {
  for (let index = openDialogs.length - 1; index >= 0; index -= 1) {
    if (openDialogs[index].open && openDialogs[index].isConnected) return openDialogs[index];
  }
  const all = document.querySelectorAll("dialog[open]");
  return all.length ? all[all.length - 1] : null;
}

function wireBackButton() {
  watchDialogs();
  const back = server.tg?.BackButton;
  if (!back) return;
  backHandler = () => {
    if (paywallOpen()) {
      closePaywall();
      return;
    }
    const dialog = topDialog();
    if (dialog) {
      // Как Esc: окно может отказаться закрываться (идёт сохранение и т. п.).
      if (dialog.dispatchEvent(new Event("cancel", { cancelable: true }))) dialog.close();
      syncBackButton();
      return;
    }
    if (backExtra()) syncBackButton();
  };
  try { back.onClick(backHandler); } catch (_) { /* старый клиент */ }
}

/** Студия сообщает, есть ли куда возвращаться (например, из «Профи» в «Просто»). */
export function setBackAction(handler) {
  backExtra = handler;
  syncBackButton();
}

export function syncBackButton(canGoBack = null) {
  const back = server.tg?.BackButton;
  if (!back) return;
  const need = paywallOpen() || Boolean(document.querySelector("dialog[open]")) || Boolean(canGoBack ?? backExtra.canGoBack?.());
  try {
    if (need) back.show();
    else back.hide();
  } catch (_) { /* старый клиент */ }
}

// --- Короткое уведомление внизу экрана ---------------------------------------

let toastTimer = 0;

export function toast(text, ms = 3600) {
  watchDialogs();
  let node = document.querySelector("#toast");
  if (!node) {
    node = document.createElement("div");
    node.id = "toast";
    node.className = "toast";
    node.setAttribute("role", "status");
  }
  // Открытое окно (<dialog>) лежит поверх всей страницы: уведомление кладём внутрь верхнего окна,
  // иначе его не видно. Без окон — обычное место в конце страницы.
  const host = topDialog() || document.body;
  if (node.parentNode !== host) host.append(node);
  node.textContent = text;
  node.classList.add("is-on");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => node.classList.remove("is-on"), ms);
}

// --- Загрузка частями ---------------------------------------------------------

/**
 * Видео с телефона уходит на сервер кусками по 8 МБ: если связь оборвалась,
 * докачиваем с места обрыва. onProgress(доля 0…1).
 */
export async function uploadInChunks(file, { name, signal, onProgress } = {}) {
  const fileName = name || file.name || "video.mp4";
  const start = await postJson("/api/uploads/chunked", { name: fileName, size: file.size });
  const key = start.key;
  const chunk = start.chunk_bytes || 8 * 1024 * 1024;
  let offset = 0;
  let failures = 0;
  onProgress?.(0);
  while (offset < file.size) {
    if (signal?.aborted) throw new DOMException("Загрузка остановлена", "AbortError");
    const end = Math.min(file.size, offset + chunk);
    try {
      const response = await fetch(`/api/uploads/chunked/${encodeURIComponent(key)}?offset=${offset}`, {
        method: "PUT",
        headers: { "X-CSRF-Token": server.csrf, "Content-Type": "application/octet-stream" },
        body: file.slice(offset, end),
        signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (response.status === 409 && Number.isFinite(payload.received)) {
        offset = payload.received;
        continue;
      }
      if (!response.ok) {
        const failure = new Error(payload.error || `Ошибка загрузки (${response.status})`);
        // «Нельзя» от сервера (нет доступа, загрузка удалена, файл велик) повтором не лечится.
        failure.fatal = response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429;
        throw failure;
      }
      offset = payload.received;
      failures = 0;
      onProgress?.(offset / file.size);
    } catch (error) {
      if (error?.name === "AbortError" || error?.fatal) throw error;
      failures += 1;
      if (failures > 6) throw new Error("Связь с сервером обрывается. Проверь интернет и попробуй ещё раз.");
      await new Promise((resolve) => window.setTimeout(resolve, Math.min(15000, 1000 * 2 ** failures)));
      // Спросим у сервера, сколько дошло, и продолжим с этого места.
      try {
        const status = await (await fetch(`/api/uploads/chunked/${encodeURIComponent(key)}`, { signal })).json();
        if (Number.isFinite(status.received)) offset = status.received;
      } catch (_) { /* повторим с прежнего места */ }
    }
  }
  const response = await fetch(`/api/uploads/chunked/${encodeURIComponent(key)}/finish`, {
    method: "POST",
    headers: { "X-CSRF-Token": server.csrf, "Content-Type": "application/json" },
    body: "{}",
    signal,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Сервер не принял видео (${response.status}).`);
  onProgress?.(1);
  return payload;
}
