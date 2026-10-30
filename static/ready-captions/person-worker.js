// Поиск человека на кадре для предпросмотра — в отдельном потоке.
//
// Нейросеть MediaPipe считает маску ~30 мс на кадр. На главном потоке это
// останавливало предпросмотр (кадры пропускались, видео дёргалось), поэтому
// для предпросмотра она работает здесь, параллельно: страница присылает
// маленький кадр, поток возвращает готовую маску-картинку. Сборка ролика по-
// прежнему считает маску на каждом кадре сама (effects.js, PersonMasker).
//
// Сообщения:
//   → { type: "init", root }                    ← { type: "ready", delegate } | { type: "error", message }
//   → { type: "frame", id, bitmap, reset }      ← { type: "mask", id, mask } | { type: "skip", id }

// MediaPipe в потоке подгружает свой загрузчик через importScripts(), а в
// потоке-модуле его нет. Заменяем на синхронную загрузку и выполнение скрипта
// в глобальной области — ровно то, что делает настоящий importScripts.
self.importScripts = (...urls) => {
  for (const url of urls) {
    const request = new XMLHttpRequest();
    request.open("GET", String(url), false);
    request.send();
    if (request.status < 200 || request.status >= 300) throw new Error(`Не удалось загрузить ${url} (${request.status})`);
    (0, eval)(`${request.responseText}\n//# sourceURL=${url}`);
  }
};

let segmenter = null;
let previous = null;
let lastTimestamp = 0;
let image = null;
let pixels = null;
let canvas = null;

async function init(root) {
  const module = await import(`${root}vision_bundle.mjs`);
  const fileset = await module.FilesetResolver.forVisionTasks(`${root}wasm`);
  const options = (delegate) => ({
    baseOptions: { modelAssetPath: `${root}selfie_segmenter.tflite`, delegate },
    runningMode: "VIDEO",
    outputCategoryMask: false,
    outputConfidenceMasks: true,
  });
  try {
    segmenter = await module.ImageSegmenter.createFromOptions(fileset, options("GPU"));
    return "GPU";
  } catch (_) {
    segmenter = await module.ImageSegmenter.createFromOptions(fileset, options("CPU"));
    return "CPU";
  }
}

function maskFrom(values, width, height, reset) {
  if (!image || image.width !== width || image.height !== height) {
    image = new ImageData(width, height);
    pixels = new Uint32Array(image.data.buffer);
    canvas = new OffscreenCanvas(width, height);
    previous = null;
  }
  if (reset || !previous || previous.length !== values.length) previous = null;
  const smooth = previous || new Float32Array(values.length);
  const blend = Boolean(previous);
  // Белый пиксель с прозрачностью маски (RGBA, little-endian).
  const WHITE = 0x00ffffff;
  for (let i = 0; i < values.length; i += 1) {
    // Мягкий порог: уверенность 0.35…0.65 → прозрачность 0…1; во времени — сглаживание, чтобы край не дрожал.
    let v = (values[i] - 0.35) / 0.3;
    v = v < 0 ? 0 : v > 1 ? 1 : v;
    if (blend) v = v * 0.65 + smooth[i] * 0.35;
    smooth[i] = v;
    pixels[i] = WHITE | (Math.round(v * 255) << 24);
  }
  previous = smooth;
  const ctx = canvas.getContext("2d");
  ctx.putImageData(image, 0, 0);
  return canvas.transferToImageBitmap();
}

self.onmessage = async (event) => {
  const data = event.data || {};
  if (data.type === "init") {
    try {
      const delegate = await init(data.root);
      self.postMessage({ type: "ready", delegate });
    } catch (error) {
      self.postMessage({ type: "error", message: String(error?.message || error) });
    }
    return;
  }
  if (data.type !== "frame") return;
  const { id, bitmap, reset } = data;
  if (!segmenter || !bitmap) {
    bitmap?.close?.();
    self.postMessage({ type: "skip", id });
    return;
  }
  try {
    // Метки времени для MediaPipe обязаны расти.
    lastTimestamp = Math.max(lastTimestamp + 1, Math.round(performance.now()));
    const result = segmenter.segmentForVideo(bitmap, lastTimestamp);
    const confidence = result?.confidenceMasks?.[0];
    const values = confidence ? confidence.getAsFloat32Array() : null;
    const width = confidence?.width || bitmap.width;
    const height = confidence?.height || bitmap.height;
    let mask = null;
    if (values && values.length === width * height) mask = maskFrom(values, width, height, reset);
    result?.close?.();
    bitmap.close();
    if (mask) self.postMessage({ type: "mask", id, mask }, [mask]);
    else self.postMessage({ type: "skip", id });
  } catch (error) {
    bitmap.close?.();
    self.postMessage({ type: "skip", id, message: String(error?.message || error) });
  }
};
