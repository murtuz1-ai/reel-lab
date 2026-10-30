// Серверная сборка ролика. Reel Lab открывает эту страницу в Chrome/Edge
// без экрана; страница берёт задание, собирает ролик тем же движком, что и
// окно мастерской, и отдаёт результат обратно серверу.
import { readVideoMeta, renderWithStyle } from "./render-core.js";
import { scanFaces } from "./effects.js";
import { setOwnSoundsUrl } from "./sfx.js";

const params = new URLSearchParams(location.search);
const job = params.get("job") || "";
const token = params.get("token") || "";
const status = document.querySelector("#status");

function api(path) {
  return `/api/render-jobs/${encodeURIComponent(job)}/${path}?token=${encodeURIComponent(token)}`;
}

function say(text) {
  if (status) status.textContent = text;
}

let lastSent = 0;
function reportProgress(label, percent) {
  say(`${label} ${Math.round(percent || 0)}%`);
  const now = Date.now();
  if (now - lastSent < 1000 && percent < 99) return;
  lastSent = now;
  void fetch(api("progress"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label, percent }),
  }).catch(() => {});
}

async function main() {
  // Свои звуки и музыка владельца задания — по ключу задания.
  setOwnSoundsUrl(api("own-sounds"));
  try {
    const specResponse = await fetch(api("spec"), { cache: "no-store" });
    if (!specResponse.ok) throw new Error(`Задание не получено (${specResponse.status}).`);
    const spec = await specResponse.json();
    const sourceResponse = await fetch(api("source"));
    if (!sourceResponse.ok) throw new Error(`Исходное видео не получено (${sourceResponse.status}).`);
    const blob = await sourceResponse.blob();
    const file = new File([blob], spec.file_name || "source.mp4", { type: blob.type || "video/mp4" });
    let meta = null;
    try {
      meta = await readVideoMeta(file);
    } catch (_) {
      meta = { width: spec.width, height: spec.height, duration: spec.duration };
    }
    // Студия на телефоне не искала лицо для зума — ищем здесь, на сервере.
    if (spec.fx?.followFace && !(spec.fx.faces?.length)) {
      const duration = meta.duration || spec.duration || 0;
      const url = URL.createObjectURL(file);
      try {
        reportProgress("Ищу лицо в кадре…", 3);
        spec.fx.faces = await scanFaces({ src: url, currentSrc: url }, duration, {
          step: duration > 120 ? 1 : 0.5,
          onProgress: (k) => reportProgress("Ищу лицо в кадре…", 3 + k * 4),
        });
      } catch (error) {
        console.warn("[reel-lab] лицо не найдено", error);
      } finally {
        URL.revokeObjectURL(url);
      }
    }
    const result = await renderWithStyle(spec, file, {
      videoSize: { width: meta.width, height: meta.height },
      duration: meta.duration || spec.duration,
      onProgress: reportProgress,
    });
    say("Отправляю результат…");
    const form = new FormData();
    form.append("video", result.blob, "rendered.mp4");
    if (result.sfx) form.append("sfx", result.sfx, "keys.wav");
    const response = await fetch(api("result"), { method: "POST", body: form });
    if (!response.ok) throw new Error(`Сервер не принял результат (${response.status}).`);
    say("Готово");
  } catch (error) {
    console.error(error);
    say(`Ошибка: ${error?.message || error}`);
    await fetch(api("failed"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: String(error?.message || error).slice(0, 400) }),
    }).catch(() => {});
  }
}

main();
