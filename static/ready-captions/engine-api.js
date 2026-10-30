// Единая точка подключения движка TSCaps (MIT) для страницы готовых субтитров.
// Сборка: node tools/build_ready_captions.mjs
export {
  RenderPipelineBuilder,
  SrtTranscriber,
  VttTranscriber,
  WordlistTagger,
  GapFreeEffect,
  Tagger,
  Tag,
  // Для живого предпросмотра: тот же построитель кадра, что и при сборке MP4.
  BrowserSubtitleFrameRenderer,
  GraphemeWordSplitter,
} from "../../_caption_style_lab/tscaps/packages/engine/dist/index.js";
// Видеоэффекты: сборщик кадра (видео → подложки → субтитры → человек → вспышки).
export { LayeredFrameCompositor } from "../../_caption_style_lab/tscaps/packages/engine/dist/modules/video/mediabunny/frame/LayeredFrameCompositor.js";
export { CaptionStacking } from "../../_caption_style_lab/tscaps/packages/engine/dist/modules/rendering/types/CaptionStacking.js";
// Переходы: перед каждой порцией кадров готовим крайние кадры сторон стыка.
export { CaptionsOverlayFramePainter } from "../../_caption_style_lab/tscaps/packages/engine/dist/modules/video/mediabunny/painter/CaptionsOverlayFramePainter.js";
// Второй декодер того же видео — достать кадр в любом месте (крайние кадры для переходов).
export { Input, BlobSource, ALL_FORMATS, VideoSampleSink } from "mediabunny";
