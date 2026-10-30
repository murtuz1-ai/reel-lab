"""Распознавание нерусской речи прямо на сервере: faster-whisper (Whisper large-v3-turbo).

Бесплатно (работает на процессоре сервера), без отправки звука в чужие облака,
и даёт время каждого слова — его ждут стили субтитров с подсветкой слов.

Модель скачивается один раз при установке сервера (scripts/install-server.sh)
в REELLAB_WHISPER_DIR. Настройки (.env):
  REELLAB_WHISPER_MODEL   — large-v3-turbo (по умолчанию), large-v3, medium, small;
  REELLAB_WHISPER_THREADS — потоков процессора на одно распознавание (по умолчанию 4);
  REELLAB_WHISPER_DIR     — папка с моделями.

Результат — те же файлы, что у облачного распознавания: subtitles.srt и
subtitles.words.vtt со временем каждого слова.
"""
from __future__ import annotations

import os
import threading
from pathlib import Path
from typing import Any, Callable

from gigaam_adapter import TimedWord, write_word_vtt
from speech_cloud import (
    LANGUAGES, CloudTranscript, SpeechError, _is_hallucination, _run, _srt_clock, find_ffmpeg, split_phrases,
)

ProgressCallback = Callable[[str, int, str], None]
_model = None
_model_lock = threading.Lock()


def available() -> bool:
    """Установлен ли faster-whisper (на сервере — да, на компьютере обычно нет)."""
    try:
        import faster_whisper  # noqa: F401
    except Exception:  # noqa: BLE001 — нет пакета или его библиотек
        return False
    return True


def _load_model() -> Any:
    global _model
    with _model_lock:
        if _model is None:
            from faster_whisper import WhisperModel
            name = os.environ.get("REELLAB_WHISPER_MODEL", "large-v3-turbo").strip() or "large-v3-turbo"
            threads = max(1, int(os.environ.get("REELLAB_WHISPER_THREADS", "4")))
            root = os.environ.get("REELLAB_WHISPER_DIR", "").strip() or None
            # int8 — в 3–4 раза быстрее и легче на процессоре, точность почти та же.
            _model = WhisperModel(name, device="cpu", compute_type="int8", cpu_threads=threads,
                                  num_workers=max(1, int(os.environ.get("REELLAB_ASR_SLOTS", "2"))),
                                  download_root=root)
        return _model


def _notify(callback: ProgressCallback | None, phase: str, percent: int, message: str) -> None:
    if callback is not None:
        callback(phase, percent, message)


def words_from_segments(segments: Any, total: float, callback: ProgressCallback | None = None) -> list[list[TimedWord]]:
    """Сегменты faster-whisper → группы слов со временем (одна группа — один сегмент)."""
    groups: list[list[TimedWord]] = []
    for segment in segments:
        words: list[TimedWord] = []
        for word in getattr(segment, "words", None) or []:
            text = " ".join(str(getattr(word, "word", "") or "").replace("<", "").replace(">", "").split())
            start = float(getattr(word, "start", 0) or 0)
            end = float(getattr(word, "end", start) or start)
            if not text:
                continue
            if words and all(not char.isalnum() for char in text):
                last = words[-1]
                words[-1] = TimedWord(last.text + text, last.start, max(last.end, end))
                continue
            words.append(TimedWord(text, max(0.0, start), max(start + 0.04, end)))
        if not words:
            # Без времени слов (редко): раскладываем текст сегмента по его длительности.
            text = str(getattr(segment, "text", "") or "").split()
            seg_start = float(getattr(segment, "start", 0) or 0)
            seg_end = float(getattr(segment, "end", seg_start) or seg_start)
            if text and seg_end > seg_start:
                step = (seg_end - seg_start) / len(text)
                words = [TimedWord(item, seg_start + index * step, seg_start + (index + 1) * step)
                         for index, item in enumerate(text)]
        if words and not _is_hallucination(words):
            groups.append(words)
        if callback is not None and total > 0:
            done = min(1.0, float(getattr(segment, "end", 0) or 0) / total)
            _notify(callback, "CLOUD_TRANSCRIBING", 20 + int(68 * done), "Распознаю речь…")
    return groups


def transcribe_local(source: Path | str, workdir: Path | str, language: str,
                     callback: ProgressCallback | None = None, music: bool = False) -> CloudTranscript:
    language = str(language or "").strip().lower()
    if language not in LANGUAGES:
        raise SpeechError("Этот язык пока не распознаётся.")
    job_dir = Path(workdir)
    job_dir.mkdir(parents=True, exist_ok=True)
    ffmpeg = find_ffmpeg()
    wav = job_dir / "speech.wav"
    _notify(callback, "CLOUD_TRANSCRIBING", 12, "Извлекаю звук из видео…")
    _run([ffmpeg, "-hide_banner", "-nostdin", "-y", "-i", str(source), "-map", "0:a:0?", "-vn",
          "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(wav)], 900,
         "Не удалось извлечь звук из видео. Убедитесь, что в ролике есть речь.")
    if not wav.is_file() or wav.stat().st_size < 1000:
        raise SpeechError("В выбранном ролике нет доступной звуковой дорожки.")
    _notify(callback, "CLOUD_TRANSCRIBING", 16, "Загружаю модель распознавания…")
    try:
        model = _load_model()
        segments, info = model.transcribe(
            str(wav), language=language, task="transcribe", beam_size=5, word_timestamps=True,
            # Пение фильтр голоса принимает за музыку — для нашида он выключен.
            vad_filter=not music, vad_parameters={"min_silence_duration_ms": 500},
            # Без «памяти» прошлого текста Whisper реже зацикливается на паузах.
            condition_on_previous_text=False,
        )
        groups = words_from_segments(segments, float(getattr(info, "duration", 0) or 0), callback)
    except SpeechError:
        raise
    except Exception as error:  # noqa: BLE001 — понятное сообщение вместо трассировки
        raise SpeechError(f"Распознавание на сервере не удалось: {error}") from error
    finally:
        wav.unlink(missing_ok=True)
    phrases = split_phrases(groups)
    if not phrases:
        raise SpeechError("Речь не распознана. Проверь язык речи или попробуй ролик с более чистым звуком.")
    warnings: list[str] = []
    detected = str(getattr(info, "language", "") or language)
    _notify(callback, "SUBTITLES_READY", 92, "Сохраняю текст…")
    vtt_path = job_dir / "subtitles.words.vtt"
    word_count = write_word_vtt(phrases, vtt_path)
    srt_path = job_dir / "subtitles.srt"
    blocks = []
    for number, phrase in enumerate(phrases, start=1):
        end = phrase[-1].end + 0.4
        if number < len(phrases):
            end = min(end, max(phrase[-1].end, phrases[number][0].start - 0.04))
        blocks.append(f"{number}\n{_srt_clock(phrase[0].start)} --> {_srt_clock(end)}\n"
                      + " ".join(word.text for word in phrase))
    srt_path.write_text("\n\n".join(blocks) + "\n", encoding="utf-8")
    return CloudTranscript(srt_path=srt_path, vtt_path=vtt_path, cue_count=len(phrases), word_count=word_count,
                           language=detected, warnings=tuple(warnings))


def selftest(path: str, language: str) -> None:
    """python3 speech_local.py <видео> <язык> — проверка после установки сервера."""
    import tempfile
    import time
    started = time.time()
    with tempfile.TemporaryDirectory() as folder:
        result = transcribe_local(path, folder, language, lambda *_: None)
        text = Path(result.srt_path).read_text(encoding="utf-8")
    print(f"OK: {result.cue_count} фраз, {result.word_count} слов за {time.time() - started:.1f} с")
    print(text[:600])


if __name__ == "__main__":
    import sys
    if len(sys.argv) < 3:
        print("Использование: python3 speech_local.py <видео> <язык, например ar>")
        raise SystemExit(2)
    selftest(sys.argv[1], sys.argv[2])


def quick_transcript(source: Path | str, workdir: Path | str, max_seconds: float = 120.0) -> dict[str, Any] | None:
    """Речь в чужом ролике для ИИ-помощника: язык заранее неизвестен — Whisper узнаёт его сам.

    Возвращает {language, text, words:[{start, end, text}]} или None, если речи нет.
    """
    job_dir = Path(workdir)
    job_dir.mkdir(parents=True, exist_ok=True)
    wav = job_dir / "reference-speech.wav"
    _run([find_ffmpeg(), "-hide_banner", "-nostdin", "-y", "-t", f"{max(5.0, float(max_seconds)):.1f}", "-i", str(source),
          "-map", "0:a:0?", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(wav)], 300,
         "Не удалось извлечь звук из видео.")
    try:
        if not wav.is_file() or wav.stat().st_size < 32000:
            return None
        model = _load_model()
        segments, info = model.transcribe(str(wav), language=None, task="transcribe", beam_size=1, word_timestamps=True,
                                          vad_filter=True, vad_parameters={"min_silence_duration_ms": 500},
                                          condition_on_previous_text=False)
        groups = words_from_segments(segments, float(getattr(info, "duration", 0) or 0))
    except SpeechError:
        return None
    except Exception:  # noqa: BLE001 — речь для разбора не обязательна
        return None
    finally:
        wav.unlink(missing_ok=True)
    words = [{"start": round(word.start, 3), "end": round(word.end, 3), "text": word.text} for group in groups for word in group]
    if not words:
        return None
    return {"language": str(getattr(info, "language", "") or ""),
            "language_probability": round(float(getattr(info, "language_probability", 0) or 0), 3),
            "text": " ".join(word["text"] for word in words), "words": words}
