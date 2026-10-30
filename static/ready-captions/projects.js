// Проекты: автосохранение монтажа и «Продолжить монтаж».
//
// Что входит в проект и как он открывается — в main.js (там всё состояние
// студии). Здесь — мелочи без DOM: номер проекта, запасная копия в браузере,
// подписи для списка проектов.

const LOCAL_KEY = "reellab.project.last";

/** Номер нового проекта: 21 знак [a-z0-9] (сервер принимает 12–40). */
export function newProjectId() {
  const bytes = new Uint8Array(10);
  (globalThis.crypto || window.crypto).getRandomValues(bytes);
  return `p${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Запасная копия последнего проекта в браузере: если сервер не ответил
 * (нет связи), монтаж не пропадёт и уйдёт на сервер при следующем открытии.
 */
export function saveLocalCopy(id, name, json, owner = "") {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify({ id, name, owner, savedAt: Date.now(), json }));
    return true;
  } catch (_) {
    return false; // переполнено или запрещено — сервер всё равно хранит проект
  }
}

export function loadLocalCopy() {
  try {
    const value = JSON.parse(localStorage.getItem(LOCAL_KEY) || "null");
    return value && typeof value.id === "string" && typeof value.json === "string" ? value : null;
  } catch (_) {
    return null;
  }
}

/** Копия больше не нужна (сервер подтвердил то же самое или проект удалён). */
export function dropLocalCopy(id) {
  try {
    const value = loadLocalCopy();
    if (value && (!id || value.id === id)) localStorage.removeItem(LOCAL_KEY);
  } catch (_) { /* не страшно */ }
}

function plural(n, forms) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  const word = a > 10 && a < 20 ? forms[2] : b > 1 && b < 5 ? forms[1] : b === 1 ? forms[0] : forms[2];
  return `${n} ${word}`;
}

const MONTHS = ["янв.", "февр.", "марта", "апр.", "мая", "июня", "июля", "авг.", "сент.", "окт.", "нояб.", "дек."];

/** «сегодня, 21:40», «вчера, 9:05», «28 окт., 14:10». ts — секунды или миллисекунды. */
export function whenText(ts, nowMs = Date.now()) {
  const ms = ts > 1e12 ? ts : ts * 1000;
  const date = new Date(ms);
  const today = new Date(nowMs);
  const clock = `${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")}`;
  const startOf = (value) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((startOf(today) - startOf(date)) / 86400000);
  if (days === 0) return `сегодня, ${clock}`;
  if (days === 1) return `вчера, ${clock}`;
  const day = `${date.getDate()} ${MONTHS[date.getMonth()]}`;
  return date.getFullYear() === today.getFullYear() ? `${day}, ${clock}` : `${day} ${date.getFullYear()}`;
}

function clock(seconds) {
  const value = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}

/** Что в проекте — одной строкой: «0:48 · 12 фраз · 2 вставки · музыка». */
export function summaryText(item) {
  const s = item?.summary || {};
  const parts = [];
  if (item?.duration) parts.push(clock(item.duration));
  if (s.cues) parts.push(s.lyrics ? plural(s.cues, ["строка", "строки", "строк"]) : plural(s.cues, ["фраза", "фразы", "фраз"]));
  const clips = (s.inserts || 0) + (s.overlays || 0);
  if (clips) parts.push(plural(clips, ["вставка", "вставки", "вставок"]));
  if (s.audios) parts.push(s.audios === 1 ? "музыка" : plural(s.audios, ["звук", "звука", "звуков"]));
  if (!s.cues && !clips && !s.audios) parts.push("без текста");
  return parts.join(" · ");
}

/** Тот же ли это файл, что в проекте: имя и размер (и время изменения, если браузер его дал). */
export function sameVideoFile(file, video) {
  if (!file || !video) return false;
  if (String(file.name || "") !== String(video.name || "")) return false;
  if (Number(video.size) > 0 && Number(file.size) !== Number(video.size)) return false;
  const modified = Number(video.modified || video.lastModified || 0);
  if (modified > 0 && Number(file.lastModified) > 0 && Math.abs(Number(file.lastModified) - modified) > 2000) return false;
  return Number(video.size) > 0;
}

/** Видео проекта, которое лежит на сервере: имя, размер и адрес вместо самого файла. */
export class RemoteVideo {
  constructor({ name, size, type, lastModified, url }) {
    this.name = name || "video.mp4";
    this.size = Number(size) || 0;
    this.type = type || "video/mp4";
    this.lastModified = Number(lastModified) || 0;
    this.url = url;
    this.remote = true;
  }
}

export function uploadFileUrl(uploadId) {
  return `/api/uploads/${encodeURIComponent(uploadId)}/file`;
}
