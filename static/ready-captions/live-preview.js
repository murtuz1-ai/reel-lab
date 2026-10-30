// Живой предпросмотр стиля поверх видео.
//
// Кадр строит тот же код движка, что и при сборке MP4 (документ из
// buildStylePipeline, разметка и CSS из SpriteSheetCompositor), только вместо
// растеризации в картинку разметка вставляется прямо в страницу поверх
// <video>. Поэтому то, что человек видит до скачивания, совпадает с роликом.
import { BrowserSubtitleFrameRenderer, GraphemeWordSplitter } from "./engine-api.js";
import { prepareStyleDocument } from "./render-core.js";

// Шрифты страница уже загрузила сама — встраивать их в CSS не нужно.
const NO_EMBED = { embed: async (css) => css };

// Стеклу при экспорте движок подкладывает размытый кадр видео. В предпросмотре
// настоящее видео лежит прямо под субтитрами, поэтому достаточно backdrop-filter.
const GLASS_PREVIEW_CSS = `
  .segment {
    -webkit-backdrop-filter: blur(var(--tscaps-blur-amount, 0.7cqh)) saturate(var(--tscaps-saturation, 1.5));
    backdrop-filter: blur(var(--tscaps-blur-amount, 0.7cqh)) saturate(var(--tscaps-saturation, 1.5));
  }
`;

function stripStyleBlock(block) {
  return String(block)
    .replace(/^<style><!\[CDATA\[/, "")
    .replace(/\]\]><\/style>$/, "")
    .split("]]]]><![CDATA[>").join("]]>");
}

function innerOfForeignObject(html) {
  return String(html).replace(/^<foreignObject[^>]*>/, "").replace(/<\/foreignObject>$/, "");
}

export class StylePreview {
  constructor(host) {
    this.host = host;
    this.shadow = host.attachShadow({ mode: "open" });
    this.styleElement = document.createElement("style");
    this.extraStyle = document.createElement("style");
    this.frame = document.createElement("div");
    this.frame.style.cssText = "position:absolute;left:0;top:0;transform-origin:0 0;pointer-events:none;";
    const base = document.createElement("style");
    base.textContent = ":host{position:absolute;inset:0;overflow:hidden;pointer-events:none;contain:strict;}";
    this.shadow.append(base, this.styleElement, this.extraStyle, this.frame);
    this.renderer = null;
    this.session = null;
    this.size = null;
    this.loadToken = 0;
    this.drawToken = 0;
    this.cssKey = null;
    this.lastTime = null;
    this.lastHtml = "";
    if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => this.fit()).observe(host);
  }

  get ready() {
    return Boolean(this.session);
  }

  fit() {
    if (!this.size) return;
    const scale = this.host.clientWidth / this.size.width;
    this.frame.style.width = `${this.size.width}px`;
    this.frame.style.height = `${this.size.height}px`;
    this.frame.style.transform = `scale(${scale || 0})`;
  }

  clear() {
    this.loadToken += 1;
    this.renderer?.close();
    this.renderer = null;
    this.session = null;
    this.frame.innerHTML = "";
    this.lastHtml = "";
    this.styleElement.textContent = "";
    this.cssKey = null;
  }

  /**
   * Готовит стиль для показа. Возвращает подготовленный документ (для звуков)
   * или null, если пока грузился, пришёл более новый запрос.
   */
  async load(spec, video, videoSize) {
    const token = ++this.loadToken;
    const prepared = await prepareStyleDocument(spec, video, videoSize);
    if (token !== this.loadToken) return null;
    const styles = {};
    let glass = false;
    for (const [kind, style] of Object.entries(prepared.styles)) {
      glass ||= Boolean(style.rendering?.videoFrame?.required);
      styles[kind] = {
        ...style,
        rendering: { ...style.rendering, videoFrame: { ...style.rendering?.videoFrame, required: false } },
      };
    }
    const renderer = BrowserSubtitleFrameRenderer.create(NO_EMBED, new GraphemeWordSplitter());
    await renderer.open(prepared.doc, styles, videoSize.width, videoSize.height, null);
    if (token !== this.loadToken) {
      renderer.close();
      return null;
    }
    this.renderer?.close();
    this.renderer = renderer;
    this.session = renderer.session;
    this.size = { width: videoSize.width, height: videoSize.height };
    this.extraStyle.textContent = glass ? GLASS_PREVIEW_CSS : "";
    this.cssKey = null;
    this.fit();
    if (this.lastTime !== null) await this.drawAt(this.lastTime);
    return prepared;
  }

  /** Рисует состояние субтитров на момент `time` секунд ролика. */
  async drawAt(time) {
    this.lastTime = time;
    const session = this.session;
    if (!session) return;
    const token = ++this.drawToken;
    const items = session.batchPlanner.itemsAt(time);
    if (!items.length) {
      if (this.lastHtml !== "") this.frame.innerHTML = "";
      this.lastHtml = "";
      return;
    }
    const tile = { items };
    const kinds = `k:${[...new Set(items.map((item) => String(item.style.kind)))].join(",")}`;
    if (kinds !== this.cssKey) {
      this.styleElement.textContent = stripStyleBlock(session.spriteSheetCompositor.composeStyleSheet([tile]));
      this.cssKey = kinds;
    }
    let uid = 0;
    const { html, defs } = await session.spriteSheetCompositor.buildTileHtml(tile, 0, true, () => uid++);
    if (token !== this.drawToken || session !== this.session) return;
    const defsHtml = defs ? `<svg width="0" height="0" style="position:absolute"><defs>${defs}</defs></svg>` : "";
    const next = defsHtml + innerOfForeignObject(html);
    // Субтитры между анимациями стоят на месте: та же разметка не
    // перестраивается, браузеру не нужно заново раскладывать и рисовать её.
    if (next === this.lastHtml) return;
    this.lastHtml = next;
    this.frame.innerHTML = next;
  }
}
