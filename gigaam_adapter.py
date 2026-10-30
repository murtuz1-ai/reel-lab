"""Local GigaAM transcription adapter for Reel Lab.

This module deliberately does not start Subtitle Edit's graphical interface and
never downloads models.  It invokes the CPU CrispASR runtime that the owner
already installed, extracts a small mono WAV with FFmpeg, and writes standard
SRT/JSON caption files suitable for the Reel Lab worker.

The public entry point is :func:`transcribe_video`.
"""
from __future__ import annotations

import json
import math
import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Callable


ProgressCallback = Callable[[str, int, str], None]


class GigaAMError(RuntimeError):
    """A short, user-facing failure raised by the local subtitle engine."""


@dataclass(frozen=True)
class GigaAMRuntime:
    """Resolved, already-existing local executable and model paths."""

    ffmpeg: Path
    ffprobe: Path | None
    crispasr: Path
    model: Path


@dataclass(frozen=True)
class TranscriptResult:
    """Files and basic facts produced by one transcription run."""

    srt_path: Path
    json_path: Path
    cue_count: int
    duration_seconds: float | None
    warnings: tuple[str, ...]
    # WebVTT whose cues carry a time mark before and after every word.  It is
    # ``None`` when the engine build did not report per-word timings; callers
    # then fall back to the phrase-level SRT.
    vtt_path: Path | None = None
    word_count: int = 0


@dataclass(frozen=True)
class TimedWord:
    text: str
    start: float
    end: float


# --- Per-word timings -------------------------------------------------------
#
# CrispASR's ``--output-json-full`` adds ``words[]`` to every transcription
# entry.  The documented unit for ``offsets.from/to`` is milliseconds; the
# legacy ``t0/t1`` fields are centiseconds.  The reader below accepts both and
# a plain ``start/end`` in seconds so a future engine build does not silently
# fall back to guessed timings.

_PUNCT_ONLY = set(".,!?…:;—–-»«\"'()")
_WORD_HOLD_SECONDS = 0.55
_MIN_WORD_SECONDS = 0.08


def _span_seconds(entry: dict) -> tuple[float, float] | None:
    offsets = entry.get("offsets")
    if isinstance(offsets, dict) and "from" in offsets and "to" in offsets:
        try:
            return float(offsets["from"]) / 1000.0, float(offsets["to"]) / 1000.0
        except (TypeError, ValueError):
            pass
    if "t0" in entry and "t1" in entry:
        try:
            return float(entry["t0"]) / 100.0, float(entry["t1"]) / 100.0
        except (TypeError, ValueError):
            pass
    if "start" in entry and "end" in entry:
        try:
            return float(entry["start"]), float(entry["end"])
        except (TypeError, ValueError):
            pass
    return None


def _clean_word(text: str) -> str:
    # ``<`` and ``>`` would be read as cue markup in WebVTT.
    return " ".join(str(text or "").replace("<", "").replace(">", "").split())


def read_crisp_words(json_path: Path) -> list[list[TimedWord]]:
    """Return one list of timed words per transcription entry (phrase).

    Punctuation that the engine reports as a separate "word" is attached to the
    preceding word so it is not typed or highlighted on its own.
    """

    try:
        payload = json.loads(json_path.read_text(encoding="utf-8-sig", errors="replace"))
    except (OSError, ValueError):
        return []
    entries = payload.get("transcription") if isinstance(payload, dict) else None
    if not isinstance(entries, list):
        entries = payload.get("segments") if isinstance(payload, dict) else None
    if not isinstance(entries, list):
        return []

    phrases: list[list[TimedWord]] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        raw_words = entry.get("words")
        if not isinstance(raw_words, list) or not raw_words:
            continue
        words: list[TimedWord] = []
        for raw in raw_words:
            if not isinstance(raw, dict):
                continue
            text = _clean_word(raw.get("text") or raw.get("word") or "")
            span = _span_seconds(raw)
            if not text or span is None:
                continue
            start, end = span
            if not (math.isfinite(start) and math.isfinite(end)):
                continue
            if words and all(character in _PUNCT_ONLY for character in text):
                last = words[-1]
                words[-1] = TimedWord(last.text + text, last.start, max(last.end, end))
                continue
            words.append(TimedWord(text, max(0.0, start), max(start, end)))
        if words:
            phrases.append(words)
    return phrases


def _vtt_time(seconds: float) -> str:
    milliseconds = max(0, int(round(seconds * 1000)))
    hours, rest = divmod(milliseconds, 3_600_000)
    minutes, rest = divmod(rest, 60_000)
    secs, millis = divmod(rest, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}.{millis:03d}"


def _normalise_phrase_timings(phrases: list[list[TimedWord]]) -> list[list[TimedWord]]:
    """Make marks strictly ordered and give every word a visible duration."""

    flat = [(p, i) for p, phrase in enumerate(phrases) for i in range(len(phrase))]
    result = [list(phrase) for phrase in phrases]
    previous_end = 0.0
    for position, (p, i) in enumerate(flat):
        word = result[p][i]
        start = max(word.start, previous_end)
        next_start = None
        if position + 1 < len(flat):
            np_, ni = flat[position + 1]
            next_start = max(start, phrases[np_][ni].start)
        end = max(word.end, start + _MIN_WORD_SECONDS)
        if next_start is not None:
            end = min(end, max(start + 0.02, next_start))
        result[p][i] = TimedWord(word.text, start, end)
        previous_end = end
    return result


def write_word_vtt(phrases: list[list[TimedWord]], path: Path) -> int:
    """Write WebVTT with a mark before and after every word.

    A mark before a word says when it starts; the mark after it says when it
    ends, so the pause until the next word is left empty instead of being
    shared out between neighbouring words.  Returns the number of words.
    """

    phrases = _normalise_phrase_timings([phrase for phrase in phrases if phrase])
    blocks = ["WEBVTT", ""]
    total = 0
    for index, phrase in enumerate(phrases, start=1):
        first, last = phrase[0], phrase[-1]
        cue_end = last.end + _WORD_HOLD_SECONDS
        if index < len(phrases):
            cue_end = min(cue_end, max(last.end, phrases[index][0].start - 0.04))
        parts = []
        for number, word in enumerate(phrase):
            separator = " " if number else ""
            parts.append(f"{separator}<{_vtt_time(word.start)}>{word.text}<{_vtt_time(word.end)}>")
            total += 1
        blocks.extend([str(index), f"{_vtt_time(first.start)} --> {_vtt_time(cue_end)}", "".join(parts), ""])
    path.write_text("\n".join(blocks), encoding="utf-8")
    return total


_DEFAULT_CRISP_ROOT = Path(r"D:\ReelLab_AI\Subtitle Edit\CrispASR")
_DEFAULT_FFMPEG = Path(r"C:\ffmpeg\ffmpeg-8.1-essentials_build\bin\ffmpeg.exe")
_DEFAULT_FFPROBE = Path(r"C:\ffmpeg\ffmpeg-8.1-essentials_build\bin\ffprobe.exe")
_CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def _env_path(*names: str) -> Path | None:
    for name in names:
        value = os.environ.get(name, "").strip()
        if value:
            return Path(value).expanduser()
    return None


def _executable_from_path(name: str) -> Path | None:
    found = shutil.which(name)
    return Path(found) if found else None


def _first_existing(*candidates: Path | None) -> Path | None:
    for candidate in candidates:
        if candidate is not None and candidate.is_file():
            return candidate.resolve()
    return None


def _require_file(path: Path | None, message: str) -> Path:
    if path is None or not path.is_file():
        raise GigaAMError(message)
    return path.resolve()


def resolve_runtime() -> GigaAMRuntime:
    """Find the local tools without fetching or installing anything.

    Environment overrides make the same bot deployable on the future server:
    ``REELLAB_CRISPASR_BIN``, ``REELLAB_GIGAAM_MODEL``, ``REELLAB_FFMPEG`` and
    ``REELLAB_FFPROBE``.  The current PC paths remain useful defaults.
    """

    crispasr = _require_file(
        _first_existing(
            _env_path("REELLAB_CRISPASR_BIN"),
            _DEFAULT_CRISP_ROOT / "crispasr.exe",
        ),
        "Локальный движок субтитров не найден. Откройте Subtitle Edit и проверьте Crisp ASR.",
    )
    model = _require_file(
        _first_existing(
            _env_path("REELLAB_GIGAAM_MODEL"),
            _DEFAULT_CRISP_ROOT / "models" / "gigaam-v3-e2e-ctc-q8_0.gguf",
        ),
        "Русская модель GigaAM не найдена. Сначала установите её в Subtitle Edit.",
    )
    ffmpeg = _require_file(
        _first_existing(
            _env_path("REELLAB_FFMPEG", "FFMPEG"),
            _executable_from_path("ffmpeg.exe"),
            _executable_from_path("ffmpeg"),
            _DEFAULT_FFMPEG,
        ),
        "FFmpeg не найден. Без него нельзя извлечь звук из видео.",
    )
    ffprobe = _first_existing(
        _env_path("REELLAB_FFPROBE", "FFPROBE"),
        _executable_from_path("ffprobe.exe"),
        _executable_from_path("ffprobe"),
        _DEFAULT_FFPROBE,
    )
    return GigaAMRuntime(ffmpeg=ffmpeg, ffprobe=ffprobe, crispasr=crispasr, model=model)


def _notify(callback: ProgressCallback | None, phase: str, progress: int, message: str) -> None:
    if callback is None:
        return
    try:
        callback(phase, max(0, min(100, int(progress))), message)
    except Exception:
        # A progress display must not make a successfully running render fail.
        pass


def _tail(value: str, limit: int = 700) -> str:
    compact = " ".join((value or "").split())
    return compact[-limit:]


def _short_path(path: Path) -> str | None:
    """Короткое имя Windows 8.3 (только латиница), если оно включено на диске."""
    if os.name != "nt":
        return None
    try:
        import ctypes

        buffer = ctypes.create_unicode_buffer(32768)
        length = ctypes.windll.kernel32.GetShortPathNameW(str(path), buffer, len(buffer))
        return buffer.value if 0 < length < len(buffer) else None
    except Exception:  # noqa: BLE001 — не критично, есть другие варианты
        return None


def _engine_path(path: Path, cwd: Path) -> str:
    """Путь, который поймёт CrispASR.

    Движок не открывает файлы, если в пути есть кириллица (например, папка
    «Загрузки» или русское имя пользователя). Поэтому он запускается из папки
    задания, а файлы передаются относительными путями; если так не выходит —
    абсолютным латинским путём или коротким именем Windows.
    """
    try:
        relative = os.path.relpath(path, cwd)
        if relative.isascii():
            return relative
    except ValueError:  # другой диск
        pass
    absolute = str(path)
    if absolute.isascii():
        return absolute
    short = _short_path(path)
    if short and short.isascii():
        return short
    return absolute


def _run(command: list[str], *, cwd: Path | None, timeout: int, failure: str,
         log_path: Path | None = None) -> subprocess.CompletedProcess[str]:
    try:
        completed = subprocess.run(
            command,
            cwd=str(cwd) if cwd else None,
            text=True,
            encoding="utf-8",
            errors="replace",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            check=False,
            creationflags=_CREATE_NO_WINDOW,
        )
    except FileNotFoundError as exc:
        raise GigaAMError(failure) from exc
    except subprocess.TimeoutExpired as exc:
        raise GigaAMError("Распознавание заняло слишком много времени. Попробуйте более короткий ролик.") from exc
    if completed.returncode != 0:
        if log_path is not None:
            # Полный вывод движка — для разбора ошибки (пути здесь локальные).
            try:
                log_path.write_text(
                    f"exit code: {completed.returncode}\ncwd: {cwd}\ncommand: {command!r}\n\n"
                    f"--- stderr ---\n{completed.stderr}\n\n--- stdout ---\n{completed.stdout}\n",
                    encoding="utf-8",
                )
            except OSError:
                pass
        details = _tail(completed.stderr)
        # The details make support possible without leaking source paths.
        suffix = f" ({details})" if details else ""
        raise GigaAMError(f"{failure}{suffix}")
    return completed


def probe_duration(path: Path, runtime: GigaAMRuntime) -> float | None:
    """Return media duration when ffprobe can read it; failure is non-fatal."""

    if runtime.ffprobe is None:
        return None
    try:
        result = subprocess.run(
            [str(runtime.ffprobe), "-v", "error", "-show_entries", "format=duration", "-of", "json", str(path)],
            text=True,
            encoding="utf-8",
            errors="replace",
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=30,
            check=False,
            creationflags=_CREATE_NO_WINDOW,
        )
        if result.returncode:
            return None
        value = float(json.loads(result.stdout or "{}").get("format", {}).get("duration") or 0)
        return value if math.isfinite(value) and value > 0 else None
    except (OSError, ValueError, TypeError, json.JSONDecodeError, subprocess.SubprocessError):
        return None


def _count_srt_cues(path: Path) -> int:
    try:
        blocks = [block for block in path.read_text(encoding="utf-8-sig", errors="replace").strip().split("\n\n") if "-->" in block]
    except OSError:
        return 0
    return len(blocks)


def transcribe_video(
    source: Path | str,
    workdir: Path | str,
    *,
    callback: ProgressCallback | None = None,
    language: str = "ru",
    max_line_length: int = 50,
    keep_audio: bool = False,
    timeout_seconds: int | None = None,
) -> TranscriptResult:
    """Create ``subtitles.srt`` and ``subtitles.json`` for one local video.

    The model and executable are only *read* from disk.  No online provider,
    auto-download option, or user media upload is used.  ``workdir`` receives
    the result files and may safely be deleted by the job cleanup logic.
    """

    source_path = Path(source).expanduser().resolve()
    if not source_path.is_file() or source_path.stat().st_size <= 0:
        raise GigaAMError("Видео не найдено или оно пустое.")
    if language.strip().lower() not in {"ru", "auto"}:
        raise GigaAMError("Для этой версии бота доступны русский язык или автоопределение.")
    if not 10 <= int(max_line_length) <= 90:
        raise GigaAMError("Длина строки субтитров задана неверно.")

    runtime = resolve_runtime()
    job_dir = Path(workdir).expanduser().resolve()
    job_dir.mkdir(parents=True, exist_ok=True)
    wav_path = job_dir / "speech.wav"
    output_base = job_dir / "subtitles"
    srt_path = output_base.with_suffix(".srt")
    json_path = output_base.with_suffix(".json")
    for candidate in (wav_path, srt_path, json_path):
        candidate.unlink(missing_ok=True)

    duration = probe_duration(source_path, runtime)
    estimated_timeout = max(300, int((duration or 60) * 12 + 300))
    timeout = max(60, int(timeout_seconds or estimated_timeout))

    _notify(callback, "TRANSCRIBING", 28, "Извлекаем речь из видео…")
    _run(
        [
            str(runtime.ffmpeg), "-hide_banner", "-nostdin", "-y", "-i", str(source_path),
            "-map", "0:a:0?", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(wav_path),
        ],
        cwd=job_dir,
        timeout=min(timeout, 600),
        failure="Не удалось извлечь звук из видео. Убедитесь, что в ролике есть речь.",
    )
    if not wav_path.is_file() or wav_path.stat().st_size < 44:
        raise GigaAMError("В выбранном ролике нет доступной звуковой дорожки.")

    _notify(callback, "TRANSCRIBING", 43, "GigaAM распознаёт русскую речь…")
    # Движок работает из папки задания: так речь и результаты передаются
    # короткими латинскими именами, даже если путь к папке содержит кириллицу.
    base_command = [
        str(runtime.crispasr), "--backend", "gigaam", "-m", _engine_path(runtime.model, job_dir),
        "-l", language.strip().lower(), "--output-srt",
    ]
    tail_command = [
        "--output-file", output_base.name, "--split-on-punct", "--max-len", str(int(max_line_length)),
        "--threads", str(max(1, int(os.environ.get("REELLAB_ASR_THREADS", "4")))), "--no-prints", wav_path.name,
    ]
    warnings: list[str] = []
    try:
        # Full JSON adds words[] with per-word offsets.  Without it every word
        # inside a phrase would have to be guessed from the phrase length.
        _run(
            base_command + ["--output-json-full"] + tail_command,
            cwd=job_dir,
            timeout=timeout,
            failure="Не удалось распознать речь в ролике.",
            log_path=job_dir / "engine-error-1.log",
        )
    except GigaAMError as first_error:
        # An older engine build may not know the flag.  Keep the previous,
        # proven command as a fallback and say that word timing is guessed.
        if "слишком много времени" in str(first_error):
            raise
        _run(
            base_command + ["--output-json"] + tail_command,
            cwd=job_dir,
            timeout=timeout,
            failure="Не удалось распознать речь в ролике.",
            log_path=job_dir / "engine-error-2.log",
        )
        warnings.append("Движок не сообщил время каждого слова: слова внутри фразы распределены примерно.")
    if not srt_path.is_file():
        raise GigaAMError("Движок не создал файл субтитров. Попробуйте ролик с более чистой речью.")
    # CrispASR normally writes JSON with --output-json.  A small fallback keeps
    # the bot's download contract stable if a future engine build skips it.
    if not json_path.is_file():
        json_path.write_text(json.dumps({"format": "reellab-gigaam-v1", "segments": []}, ensure_ascii=False), encoding="utf-8")

    vtt_path: Path | None = job_dir / "subtitles.words.vtt"
    vtt_path.unlink(missing_ok=True)
    phrases = read_crisp_words(json_path)
    word_count = write_word_vtt(phrases, vtt_path) if phrases else 0
    if not word_count:
        vtt_path.unlink(missing_ok=True)
        vtt_path = None
        if not warnings:
            warnings.append("Время каждого слова недоступно: используется время фраз.")

    cue_count = _count_srt_cues(srt_path)
    if cue_count == 0:
        warnings.append("Речь не распознана: файл субтитров пустой.")
    if not keep_audio:
        wav_path.unlink(missing_ok=True)
    _notify(callback, "SUBTITLES_READY", 63, "Субтитры готовы. Оформляем ролик…")
    return TranscriptResult(
        srt_path=srt_path,
        json_path=json_path,
        cue_count=cue_count,
        duration_seconds=duration,
        warnings=tuple(warnings),
        vtt_path=vtt_path,
        word_count=word_count,
    )


__all__ = [
    "GigaAMError",
    "GigaAMRuntime",
    "ProgressCallback",
    "TimedWord",
    "TranscriptResult",
    "probe_duration",
    "read_crisp_words",
    "resolve_runtime",
    "transcribe_video",
    "write_word_vtt",
]
