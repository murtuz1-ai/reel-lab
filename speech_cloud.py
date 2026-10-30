"""Распознавание речи на любом языке через Whisper в Cloudflare Workers AI.

Русский язык Reel Lab распознаёт на компьютере (GigaAM). Для остальных языков
звук ролика по частям отправляется в Whisper large-v3-turbo на аккаунт
Cloudflare владельца (тот же ключ, что у ИИ-картинок и перевода). Whisper
пишет текст на языке речи и время каждого слова; модуль собирает из него те же
файлы, что и GigaAM: ``subtitles.srt`` и ``subtitles.words.vtt``.
"""

from __future__ import annotations

import base64
import math
import os
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from ai_pictures import AiError, Cloudflare
from gigaam_adapter import TimedWord, write_word_vtt

WHISPER_MODEL = "@cf/openai/whisper-large-v3-turbo"

# Языки, которые распознаёт Whisper (русский идёт через GigaAM на компьютере).
LANGUAGES: dict[str, str] = {
    "ar": "арабский",
    "en": "английский",
    "es": "испанский",
    "de": "немецкий",
    "fr": "французский",
    "it": "итальянский",
    "pt": "португальский",
    "tr": "турецкий",
    "uk": "украинский",
    "kk": "казахский",
    "uz": "узбекский",
    "pl": "польский",
    "az": "азербайджанский",
    "tg": "таджикский",
}

CHUNK_MAX_SECONDS = 90.0   # самый длинный кусок звука в одном запросе
CHUNK_MIN_SECONDS = 30.0   # раньше этого кусок не режется даже на паузе
PHRASE_MAX_CHARS = 46      # длина фразы субтитров, как у русских (около двух строк)
PHRASE_MAX_WORDS = 9
PHRASE_PAUSE_SECONDS = 0.7
SENTENCE_END = re.compile(r"[.!?…؟۔]+[\"»”)]*$")
PHRASE_BREAK = re.compile(r"[,;:،؛—–]$")
_PUNCT_ONLY = re.compile(r"^[\W_]+$", re.UNICODE)
_CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
_DEFAULT_FFMPEG = Path(r"C:\ffmpeg\ffmpeg-8.1-essentials_build\bin\ffmpeg.exe")

ProgressCallback = Callable[[str, int, str], None]


class SpeechError(RuntimeError):
    """Понятная пользователю ошибка распознавания."""


@dataclass(frozen=True)
class CloudTranscript:
    srt_path: Path
    vtt_path: Path
    cue_count: int
    word_count: int
    language: str
    warnings: tuple[str, ...]


def find_ffmpeg() -> str:
    for candidate in (os.environ.get("REELLAB_FFMPEG"), os.environ.get("FFMPEG")):
        if candidate and Path(candidate).expanduser().is_file():
            return str(Path(candidate).expanduser())
    found = shutil.which("ffmpeg") or shutil.which("ffmpeg.exe")
    if found:
        return found
    if _DEFAULT_FFMPEG.is_file():
        return str(_DEFAULT_FFMPEG)
    raise SpeechError("FFmpeg не найден. Без него нельзя извлечь звук из видео.")


def _run(command: list[str], timeout: int, failure: str) -> subprocess.CompletedProcess[str]:
    try:
        result = subprocess.run(command, text=True, encoding="utf-8", errors="replace", timeout=timeout,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
                                creationflags=_CREATE_NO_WINDOW)
    except (OSError, subprocess.SubprocessError) as error:
        raise SpeechError(failure) from error
    if result.returncode:
        raise SpeechError(failure)
    return result


def _notify(callback: ProgressCallback | None, phase: str, percent: int, message: str) -> None:
    if callback is not None:
        callback(phase, int(percent), message)


def audio_duration(ffmpeg: str, wav: Path) -> float:
    """Длительность WAV по заголовку файла (16 кГц, моно, 16 бит)."""
    size = wav.stat().st_size
    return max(0.0, (size - 44) / (16000 * 2))


def find_silences(ffmpeg: str, wav: Path) -> list[tuple[float, float]]:
    """Паузы в речи: по ним звук режется на части, чтобы не разрезать слово."""
    result = subprocess.run(
        [ffmpeg, "-hide_banner", "-nostdin", "-i", str(wav), "-af", "silencedetect=noise=-32dB:d=0.35", "-f", "null", "-"],
        text=True, encoding="utf-8", errors="replace", stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        timeout=300, check=False, creationflags=_CREATE_NO_WINDOW,
    )
    silences: list[tuple[float, float]] = []
    start: float | None = None
    for line in (result.stderr or "").splitlines():
        found = re.search(r"silence_start:\s*(-?[\d.]+)", line)
        if found:
            start = max(0.0, float(found.group(1)))
            continue
        found = re.search(r"silence_end:\s*([\d.]+)", line)
        if found and start is not None:
            silences.append((start, float(found.group(1))))
            start = None
    return silences


def plan_chunks(duration: float, silences: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Части не длиннее CHUNK_MAX_SECONDS; граница — середина паузы, если она есть."""
    chunks: list[tuple[float, float]] = []
    start = 0.0
    while duration - start > CHUNK_MAX_SECONDS:
        limit = start + CHUNK_MAX_SECONDS
        middles = [(a + b) / 2 for a, b in silences if start + CHUNK_MIN_SECONDS <= (a + b) / 2 <= limit]
        cut = max(middles) if middles else limit
        chunks.append((start, cut))
        start = cut
    if duration - start > 0.05 or not chunks:
        chunks.append((start, max(start, duration)))
    return chunks


def _number(value: Any) -> float | None:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def _clean(text: str) -> str:
    return " ".join(str(text or "").replace("<", "").replace(">", "").split())


def words_from_result(result: Any, offset: float, chunk_end: float) -> list[list[TimedWord]]:
    """Слова Whisper со временем, сгруппированные по сегментам (предложениям)."""
    if not isinstance(result, dict):
        return []
    groups: list[list[TimedWord]] = []
    segments = result.get("segments")
    if not isinstance(segments, list) or not segments:
        # Старый формат: общий список слов без сегментов.
        flat = result.get("words")
        segments = [{"words": flat, "text": result.get("text", "")}] if isinstance(flat, list) else []
    for segment in segments:
        if not isinstance(segment, dict):
            continue
        words: list[TimedWord] = []
        raw_words = segment.get("words")
        if isinstance(raw_words, list) and raw_words:
            for raw in raw_words:
                if not isinstance(raw, dict):
                    continue
                text = _clean(raw.get("word") or raw.get("text") or "")
                start, end = _number(raw.get("start")), _number(raw.get("end"))
                if not text or start is None or end is None:
                    continue
                start, end = start + offset, max(start, end) + offset
                if words and _PUNCT_ONLY.match(text):
                    last = words[-1]
                    words[-1] = TimedWord(last.text + text, last.start, max(last.end, end))
                    continue
                words.append(TimedWord(text, start, end))
        else:
            # Сегмент без слов: время делится между словами по их длине.
            text = _clean(segment.get("text") or "")
            start, end = _number(segment.get("start")), _number(segment.get("end"))
            parts = text.split()
            if parts and start is not None and end is not None and end > start:
                total = sum(len(part) + 1 for part in parts)
                cursor = start
                for part in parts:
                    span = (end - start) * (len(part) + 1) / total
                    words.append(TimedWord(part, cursor + offset, cursor + span * 0.92 + offset))
                    cursor += span
        # Слова не выходят за свою часть звука (на стыке частей Whisper иногда ошибается).
        words = [TimedWord(w.text, min(w.start, chunk_end), min(max(w.end, w.start), chunk_end)) for w in words]
        if words:
            groups.append(words)
    return groups


_HALLUCINATIONS = (
    "субтитры сделал", "редактор субтитров", "продолжение следует", "thanks for watching", "thank you for watching",
    "subtitles by", "amara.org", "please subscribe", "ترجمة نانسي", "اشترك في القناة",
)


def _is_hallucination(words: list[TimedWord]) -> bool:
    text = " ".join(word.text for word in words).lower()
    return any(marker in text for marker in _HALLUCINATIONS)


def split_phrases(groups: list[list[TimedWord]]) -> list[list[TimedWord]]:
    """Фразы для субтитров: конец предложения, запятая у длинной фразы, пауза или длина."""
    phrases: list[list[TimedWord]] = []
    for group in groups:
        current: list[TimedWord] = []
        for word in group:
            if current:
                gap = word.start - current[-1].end
                length = sum(len(item.text) + 1 for item in current) + len(word.text)
                if gap >= PHRASE_PAUSE_SECONDS or length > PHRASE_MAX_CHARS or len(current) >= PHRASE_MAX_WORDS:
                    phrases.append(current)
                    current = []
            current.append(word)
            text = word.text
            length = sum(len(item.text) + 1 for item in current)
            if SENTENCE_END.search(text) or (PHRASE_BREAK.search(text) and length >= PHRASE_MAX_CHARS * 0.55):
                phrases.append(current)
                current = []
        if current:
            phrases.append(current)
    # Одиночное короткое слово без знака препинания прилипает к предыдущей фразе.
    merged: list[list[TimedWord]] = []
    for phrase in phrases:
        if (merged and len(phrase) == 1 and len(phrase[0].text) <= 3 and not SENTENCE_END.search(merged[-1][-1].text)
                and phrase[0].start - merged[-1][-1].end < PHRASE_PAUSE_SECONDS):
            merged[-1] = merged[-1] + phrase
        else:
            merged.append(phrase)
    return merged


def _whisper(client: Cloudflare, audio: bytes, language: str, vad: bool = True) -> Any:
    encoded = base64.b64encode(audio).decode("ascii")
    # Пение (нашид) фильтр голоса принимает за музыку и выбрасывает — для музыки он выключен.
    body: dict[str, Any] = {"audio": encoded, "task": "transcribe", "language": language, "vad_filter": vad}
    try:
        return client.run_json(WHISPER_MODEL, body, timeout=300)
    except AiError as error:
        # Другая версия модели принимает звук как объект с типом содержимого.
        if error.code in ("ai_auth", "ai_limit") or "audio" not in str(error.message).lower():
            raise
        body["audio"] = {"body": encoded, "contentType": "audio/mpeg"}
        return client.run_json(WHISPER_MODEL, body, timeout=300)


def _srt_clock(seconds: float) -> str:
    milliseconds = max(0, int(round(seconds * 1000)))
    hours, rest = divmod(milliseconds, 3_600_000)
    minutes, rest = divmod(rest, 60_000)
    secs, millis = divmod(rest, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


def transcribe_cloud(source: Path | str, workdir: Path | str, client: Cloudflare, language: str,
                     callback: ProgressCallback | None = None, music: bool = False) -> CloudTranscript:
    language = str(language or "").strip().lower()
    if language not in LANGUAGES:
        raise SpeechError("Этот язык пока не распознаётся.")
    source_path = Path(source)
    job_dir = Path(workdir)
    job_dir.mkdir(parents=True, exist_ok=True)
    ffmpeg = find_ffmpeg()
    wav = job_dir / "speech.wav"
    _notify(callback, "CLOUD_TRANSCRIBING", 18, "Извлекаю звук из видео…")
    _run([ffmpeg, "-hide_banner", "-nostdin", "-y", "-i", str(source_path), "-map", "0:a:0?", "-vn",
          "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(wav)], 600,
         "Не удалось извлечь звук из видео. Убедитесь, что в ролике есть речь.")
    if not wav.is_file() or wav.stat().st_size < 1000:
        raise SpeechError("В выбранном ролике нет доступной звуковой дорожки.")
    duration = audio_duration(ffmpeg, wav)
    chunks = plan_chunks(duration, find_silences(ffmpeg, wav) if duration > CHUNK_MAX_SECONDS else [])
    groups: list[list[TimedWord]] = []
    detected = language
    warnings: list[str] = []
    for index, (start, end) in enumerate(chunks):
        _notify(callback, "CLOUD_TRANSCRIBING", 22 + int(66 * index / max(1, len(chunks))),
                f"Whisper распознаёт речь: часть {index + 1} из {len(chunks)}…")
        part = job_dir / f"speech-{index:03d}.mp3"
        _run([ffmpeg, "-hide_banner", "-nostdin", "-y", "-ss", f"{start:.3f}", "-t", f"{max(0.1, end - start):.3f}",
              "-i", str(wav), "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "48k", str(part)], 300,
             "Не удалось подготовить звук для распознавания.")
        result = _whisper(client, part.read_bytes(), language, vad=not music)
        part.unlink(missing_ok=True)
        info = result.get("transcription_info") if isinstance(result, dict) else None
        if isinstance(info, dict) and isinstance(info.get("language"), str):
            detected = info["language"]
        groups.extend(group for group in words_from_result(result, start, end) if not _is_hallucination(group))
    wav.unlink(missing_ok=True)
    phrases = split_phrases(groups)
    if not phrases:
        raise SpeechError("Речь не распознана. Проверь язык речи или попробуй ролик с более чистым звуком.")
    if detected and detected != language:
        warnings.append(f"Whisper услышал другой язык ({detected}). Если текст странный, выбери другой язык речи.")
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
                           language=detected or language, warnings=tuple(warnings))
