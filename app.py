"""Local Reel Lab API, subtitle engine and FFmpeg worker."""
from __future__ import annotations

import hashlib
import heapq
import itertools
import json
import math
import mimetypes
import os
import re
import secrets
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import wave
from array import array
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from flask import Flask, Response, g, has_request_context, jsonify, redirect, request, send_file, send_from_directory
from werkzeug.exceptions import RequestEntityTooLarge

from accounts import Accounts, AccountsError
from telegram_auth import TelegramInitDataError, validate_telegram_webapp_init_data
from ai_pictures import AiError, EditorTools, PicturesService, usage_scope
from gigaam_adapter import GigaAMError, transcribe_video
import speech_local
import assistant as assistant_core
from speech_cloud import LANGUAGES as CLOUD_SPEECH_LANGUAGES, SpeechError, transcribe_cloud

try:
    from dotenv import load_dotenv
except ImportError:  # Local mode needs only Flask and FFmpeg.
    load_dotenv = None

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
SOUND_LIBRARY = STATIC / "sounds" / "sfx"
mimetypes.add_type("audio/flac", ".flac")
if load_dotenv is not None:
    load_dotenv(ROOT / ".env")
DATA = Path(os.environ.get("REELLAB_DATA_DIR", ROOT / "data")).expanduser().resolve()
UPLOADS = DATA / "uploads"
CAPTIONS = DATA / "captions"
JOBS = DATA / "jobs"
DB = DATA / "reellab.sqlite3"
MAX_BYTES = int(os.environ.get("REELLAB_MAX_UPLOAD_BYTES", 2 * 1024 * 1024 * 1024))
MAX_CAPTION_BYTES = min(8 * 1024 * 1024, MAX_BYTES)
MAX_SECONDS = int(os.environ.get("REELLAB_MAX_DURATION_SECONDS", 3600))
WORKERS = max(1, int(os.environ.get("REELLAB_WORKERS", "1")))
FFMPEG_TIMEOUT_SECONDS = max(60, int(os.environ.get("REELLAB_FFMPEG_TIMEOUT_SECONDS", max(600, MAX_SECONDS * 4))))
DOWNLOAD_TICKET_SECONDS = max(30, int(os.environ.get("REELLAB_DOWNLOAD_TICKET_SECONDS", "300")))
UPLOAD_CHUNK_BYTES = 1024 * 1024
VIDEO_SUFFIXES = {".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi"}
CAPTION_SUFFIXES = {".srt", ".vtt", ".ass"}
# A tenth of a second is long enough for a playable, useful clip while still
# allowing precise edits.  Settings are expressed in seconds with millisecond
# precision.
MIN_TRIM_SECONDS = 0.1
TRIM_EPSILON_SECONDS = 0.001

for folder in (DATA, UPLOADS, CAPTIONS, JOBS):
    folder.mkdir(parents=True, exist_ok=True)

# Серверный режим: бот в Telegram для многих людей. Без этой переменной
# Reel Lab остаётся локальной студией на одном компьютере, как раньше.
SERVER_MODE = os.environ.get("REELLAB_MODE", "").strip().lower() == "server"
PUBLIC_URL = os.environ.get("REELLAB_PUBLIC_URL", "").strip().rstrip("/")
BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
BOT_USERNAME = os.environ.get("TELEGRAM_BOT_USERNAME", "").strip().lstrip("@")
OWNER_IDS = {int(item) for item in re.split(r"[,\s;]+", os.environ.get("REELLAB_OWNER_IDS", "")) if item.isdigit()}
SESSION_HEADER = "X-Reel-Session"
SESSION_COOKIE = "rl_session"
RENDER_SLOTS = max(1, int(os.environ.get("REELLAB_RENDER_SLOTS", "2")))
ASR_SLOTS = max(1, int(os.environ.get("REELLAB_ASR_SLOTS", "2")))
UPLOAD_KEEP_SECONDS = max(3600, int(os.environ.get("REELLAB_UPLOAD_KEEP_HOURS", "48")) * 3600)
RESULT_KEEP_SECONDS = max(3600, int(os.environ.get("REELLAB_RESULT_KEEP_HOURS", "72")) * 3600)
if SERVER_MODE and not BOT_TOKEN:
    raise SystemExit("REELLAB_MODE=server: укажите TELEGRAM_BOT_TOKEN в .env")
accounts: Accounts | None = Accounts(DB, OWNER_IDS) if SERVER_MODE else None
LOCAL_USER_ID = 0

def server_build() -> str:
    """Отпечаток файлов сервера: запускалка видит, что файлы обновились, и перезапускает сервер."""
    digest = hashlib.sha1()
    for name in ("app.py", "ai_pictures.py", "gigaam_adapter.py", "speech_cloud.py", "speech_local.py", "accounts.py",
                 "billing.py", "tgbot.py", "assistant.py"):
        try:
            digest.update((ROOT / name).read_bytes())
        except OSError:
            pass
    return digest.hexdigest()[:16]


SERVER_BUILD = server_build()
app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_BYTES
app.config["JSON_AS_ASCII"] = False
csrf = secrets.token_urlsafe(32)
lock = threading.RLock()
process_lock = threading.RLock()
processes: dict[str, subprocess.Popen[str]] = {}
executor = ThreadPoolExecutor(max_workers=WORKERS, thread_name_prefix="reellab")


class JobScheduler:
    """Очередь сервера: у распознавания и у сборки свои потоки, платные — раньше бесплатных.

    Локальная студия этим не пользуется: там одна очередь на всё, как раньше.
    """

    GROUPS = {"transcription": "asr", "style_render": "render", "render": "render"}

    def __init__(self, slots: dict[str, int], target: Any):
        self._cond = threading.Condition()
        self._heaps: dict[str, list[tuple[int, int, str]]] = {group: [] for group in slots}
        self._seq = itertools.count()
        self._target = target
        for group, count in slots.items():
            for index in range(count):
                threading.Thread(target=self._loop, args=(group,), daemon=True,
                                 name=f"reellab-{group}-{index}").start()

    def submit(self, job_id: str, kind: str, priority: int) -> None:
        group = self.GROUPS.get(kind, "render")
        with self._cond:
            heapq.heappush(self._heaps[group], (int(priority), next(self._seq), job_id))
            self._cond.notify_all()

    def position(self, job_id: str) -> int | None:
        with self._cond:
            for heap in self._heaps.values():
                for index, item in enumerate(sorted(heap)):
                    if item[2] == job_id:
                        return index + 1
        return None

    def waiting(self) -> dict[str, int]:
        with self._cond:
            return {group: len(heap) for group, heap in self._heaps.items()}

    def _loop(self, group: str) -> None:
        while True:
            with self._cond:
                while not self._heaps[group]:
                    self._cond.wait()
                _, _, job_id = heapq.heappop(self._heaps[group])
            try:
                self._target(job_id)
            except Exception:  # noqa: BLE001 — сам worker пишет ошибку в задание
                pass


scheduler: JobScheduler | None = (
    JobScheduler({"asr": ASR_SLOTS, "render": RENDER_SLOTS}, lambda job_id: worker(job_id)) if SERVER_MODE else None
)

DEFAULT_SETTINGS: dict[str, Any] = {
    "style": "Glass", "color": "violet", "font": "Modernist",
    "typography": "cinema", "size": "medium", "position": "auto",
    "animation": "dynamic", "model": "turbo", "director": "rules",
    "language": "ru", "vocabulary": "", "duration_mode": "original",
    # ``trim_end`` is intentionally null for an untrimmed source.  It lets us
    # keep the normal FFmpeg command untouched unless the editor selects a
    # real range, and it remains compatible with drafts saved before trimming.
    "trim_start": 0.0, "trim_end": None,
    "smart_cut": False, "cut_pauses": False, "panels": False, "motion": False,
    "opening_zoom": False, "sound_effects": False, "background_music": False,
    "emoji": False, "media_cards": False, "hook": False,
    "designed_cover": False, "finishing_version": 1,
    # Controls supplied by local-enhancements.js and used by the FFmpeg worker.
    "audio_preset": "clear_speech", "noise_reduction": "medium",
    "normalize_audio": True, "video_enhancement": "balanced",
    "color_grade": "natural", "output_resolution": "vertical_1080",
    "video_quality": "high", "export_audio": True,
    "montage_preset": "talking_head",
    "caption_enabled": True,
    "caption_style": "luxe",
    "caption_position": "bottom_center",
    # ``None`` preserves the art direction built into each subtitle style.
    # The bot sends a #RRGGBB value only when the creator selects a colour.
    "caption_color": None,
    # These controls only affect the "Печатная машинка" subtitle style.
    # Old saved jobs stay silent; a missing tempo safely falls back to «Мягко».
    "quick_type_speed": "soft",
    "typing_sound_enabled": False,
    "typing_sound_preset": "iphone_keyboard",
    "typing_sound_volume": 35,
}

CAPABILITIES: dict[str, Any] = {
    "processing_enabled": True, "upload_enabled": True, "resumable_upload": False,
    "processing_mode": "local-no-llm", "pipeline": "server",
    "default_model": "turbo", "model_labels": {"turbo": "Локальный монтаж"},
    "colors": [
        {"key": "violet", "hex": "#8259ff", "ru": "Фиолетовый"},
        {"key": "coral", "hex": "#ff7064", "ru": "Коралловый"},
        {"key": "lime", "hex": "#b9ef48", "ru": "Лаймовый"},
        {"key": "sky", "hex": "#66bfff", "ru": "Голубой"},
    ],
    "legacy_colors": [
        {"key": "violet", "hex": "#8259ff", "ru": "Фиолетовый"},
        {"key": "coral", "hex": "#ff7064", "ru": "Коралловый"},
        {"key": "lime", "hex": "#b9ef48", "ru": "Лаймовый"},
        {"key": "sky", "hex": "#66bfff", "ru": "Голубой"},
    ],
    "context_color": "#F6EFD8",
    "fonts": [
        {"name": "Modernist", "description": "Современный"},
        {"name": "Widescreen", "description": "Акцентный"},
        {"name": "Notebook", "description": "Рукописный"},
    ],
    "styles": [{"id": "Glass", "enabled": True}],
    "features": {
        "caption_modes": True, "emoji": False, "sound_effects": False,
        "media_cards": False, "generated_media": False, "panels": False,
        "motion": False, "opening_zoom": False, "hook_title": False,
        "hook_rewrite": False, "short60": False, "semantic_cuts": False,
        "semantic_cut_suggestions": False, "transcript_editor": False,
        "timeline_trim": True,
        "imported_captions": True,
        "telegram_delivery": False,
    },
    "limits": {
        "max_bytes": MAX_BYTES, "max_seconds": MAX_SECONDS,
        "max_caption_bytes": MAX_CAPTION_BYTES,
        "queue_size": WORKERS, "user_active": WORKERS,
    },
    "qwen": False,
    "settings_notice": (
        "Локальная версия распознаёт русскую речь через установленный GigaAM, "
        "создаёт файл субтитров и вшивает выбранное оформление в MP4. "
        "Доставка результата в Telegram включится после добавления токена бота и HTTPS-адреса."
    ),
}


class ReelLabError(Exception):
    def __init__(self, message: str, status: int = 400, code: str | None = None):
        super().__init__(message)
        self.message, self.status, self.code = message, status, code


class JobCancelled(Exception):
    pass


def ffmpeg_error(message: str, stderr_text: str | None, status: int = 500, code: str | None = None) -> ReelLabError:
    """Ошибка FFmpeg: подробности — в журнал; человеку на сервере — только понятная фраза.

    В локальной студии хвост вывода остаётся в сообщении: его видит сам владелец, и так проще помочь.
    """
    tail = " ".join((stderr_text or "").split())[-400:]
    if tail:
        app.logger.warning("%s FFmpeg: %s", message, tail)
    if SERVER_MODE or not tail:
        return ReelLabError(message, status, code)
    return ReelLabError(f"{message} {tail}", status, code)


def now() -> int:
    return int(time.time())


def dump(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def load(value: str | None, fallback: Any) -> Any:
    try:
        return json.loads(value) if value else fallback
    except (TypeError, json.JSONDecodeError):
        return fallback


def identifier() -> str:
    return secrets.token_hex(16)


def valid_identifier(value: str) -> bool:
    return len(value) == 32 and all(char in "0123456789abcdef" for char in value)


CAPTION_HEX_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")


def caption_color_to_ass(value: Any) -> str | None:
    """Turn a CSS #RRGGBB colour into a safe ASS &HAABBGGRR& colour.

    Captions are rendered by FFmpeg/libass.  Never place the raw browser
    value in an ASS override tag: malformed input could otherwise change the
    subtitle script.  A non-matching value simply uses the style's normal
    palette instead.
    """
    if not isinstance(value, str) or not CAPTION_HEX_COLOR.fullmatch(value):
        return None
    red, green, blue = value[1:3], value[3:5], value[5:7]
    return f"&H00{blue.upper()}{green.upper()}{red.upper()}&"


def connection() -> sqlite3.Connection:
    conn = sqlite3.connect(DB, timeout=30)
    conn.row_factory = sqlite3.Row
    return conn


@contextmanager
def database():
    """Commit and close every SQLite connection, including on worker errors."""
    conn = connection()
    try:
        yield conn
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_database() -> None:
    with lock, database() as conn:
        conn.executescript(
            """
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS settings (
                id INTEGER PRIMARY KEY CHECK (id=1), value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS uploads (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL,
                mime TEXT, size_bytes INTEGER NOT NULL, duration REAL NOT NULL,
                width INTEGER, height INTEGER, has_audio INTEGER NOT NULL DEFAULT 0,
                created INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS captions (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL,
                source_format TEXT NOT NULL, size_bytes INTEGER NOT NULL,
                cue_count INTEGER NOT NULL, created INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY, request_id TEXT UNIQUE, upload_id TEXT NOT NULL,
                parent_id TEXT, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'render',
                status TEXT NOT NULL, phase TEXT NOT NULL,
                progress_percent INTEGER NOT NULL DEFAULT 0,
                settings TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL,
                error TEXT, warnings TEXT NOT NULL DEFAULT '[]', output_path TEXT,
                subtitle_path TEXT, cover_path TEXT, audio_path TEXT, duration REAL,
                removed_seconds REAL NOT NULL DEFAULT 0,
                cancel_requested INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS tickets (
                id TEXT PRIMARY KEY, created INTEGER NOT NULL, text TEXT NOT NULL,
                reply TEXT
            );
            CREATE TABLE IF NOT EXISTS download_tickets (
                token TEXT PRIMARY KEY, job_id TEXT NOT NULL, kind TEXT NOT NULL,
                path TEXT NOT NULL, file_name TEXT NOT NULL, expires INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY, user_id INTEGER NOT NULL DEFAULT 0, name TEXT NOT NULL,
                upload_id TEXT, duration REAL NOT NULL DEFAULT 0, summary TEXT NOT NULL DEFAULT '{}',
                data TEXT NOT NULL, size_bytes INTEGER NOT NULL DEFAULT 0,
                created INTEGER NOT NULL, updated INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS projects_user ON projects(user_id, updated);
            CREATE TABLE IF NOT EXISTS assistant_runs (
                id TEXT PRIMARY KEY, user_id INTEGER NOT NULL DEFAULT 0, upload_id TEXT,
                status TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'studio', created INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS assistant_runs_user ON assistant_runs(user_id, created);
            """
        )
        if conn.execute("SELECT 1 FROM settings WHERE id=1").fetchone() is None:
            conn.execute("INSERT INTO settings(id,value) VALUES(1,?)", (dump(DEFAULT_SETTINGS),))
        # Existing local databases predate the lightweight transcription-only
        # task type.  Add the column once without touching any saved jobs.
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(jobs)")}
        if "kind" not in columns:
            conn.execute("ALTER TABLE jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'render'")
        # Владелец файла и задания: в серверном режиме у каждого человека своё.
        # Локальная студия пишет 0 — один владелец, как и раньше.
        for table in ("uploads", "captions", "jobs", "tickets"):
            table_columns = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
            if "user_id" not in table_columns:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0")
        upload_columns = {row["name"] for row in conn.execute("PRAGMA table_info(uploads)")}
        if "render_path" not in upload_columns:
            conn.execute("ALTER TABLE uploads ADD COLUMN render_path TEXT")
        if "last_used" not in upload_columns:
            conn.execute("ALTER TABLE uploads ADD COLUMN last_used INTEGER NOT NULL DEFAULT 0")
        conn.execute("CREATE INDEX IF NOT EXISTS jobs_user ON jobs(user_id, created)")
        conn.execute("CREATE INDEX IF NOT EXISTS uploads_user ON uploads(user_id, created)")
        # A process restart cannot safely resume a half-finished FFmpeg job.
        # Mark it explicitly instead of leaving a permanent "in progress" row.
        conn.execute(
            """UPDATE jobs SET status='cancelled', phase='CANCELLED', progress_percent=0,
               error=NULL, updated=?
               WHERE status IN ('queued','running','cancelling')""",
            (now(),),
        )
        conn.execute("DELETE FROM download_tickets WHERE expires<?", (now(),))


def error(message: str, status: int = 400, code: str | None = None):
    result: dict[str, Any] = {"error": message}
    if code:
        result["code"] = code
    return jsonify(result), status


def require_json() -> dict[str, Any]:
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        raise ReelLabError("Ожидались данные в формате JSON.")
    return body


def require_csrf() -> None:
    expected = getattr(g, "csrf", None) if SERVER_MODE else csrf
    supplied = request.headers.get("X-CSRF-Token") or ""
    if not expected or not secrets.compare_digest(str(expected), supplied):
        raise ReelLabError("Сессия устарела. Повторите запрос.", 403, "csrf_stale")


def current_user_id() -> int:
    """Владелец запроса: человек из Telegram в серверном режиме, 0 — в локальной студии."""
    if not SERVER_MODE:
        return LOCAL_USER_ID
    value = getattr(g, "user_id", None) if has_request_context() else None
    if value is None:
        raise ReelLabError("Нужно войти через Telegram. Открой студию из бота.", 401, "auth_required")
    return int(value)


def _check_owner(row: sqlite3.Row, message: str) -> None:
    """В серверном режиме чужие файлы и задания выглядят как несуществующие."""
    if not SERVER_MODE or not has_request_context():
        return
    owner = getattr(g, "user_id", None)
    if owner is None:
        return  # служебные маршруты сборщика проверяют свой одноразовый ключ
    if int(row["user_id"] or 0) != int(owner) and not getattr(g, "is_admin", False):
        raise ReelLabError(message, 404)


def get_draft() -> dict[str, Any]:
    with database() as conn:
        row = conn.execute("SELECT value FROM settings WHERE id=1").fetchone()
    value = dict(DEFAULT_SETTINGS)
    saved = load(row["value"] if row else None, {})
    if isinstance(saved, dict):
        value.update(saved)
    return value


def save_draft(value: dict[str, Any]) -> dict[str, Any]:
    merged = dict(DEFAULT_SETTINGS)
    merged.update(value)
    with lock, database() as conn:
        conn.execute("UPDATE settings SET value=? WHERE id=1", (dump(merged),))
    return merged


def run(command: list[str], timeout: int = 120, cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            command, text=True, encoding="utf-8", errors="replace", timeout=timeout,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False, cwd=str(cwd) if cwd else None,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except FileNotFoundError as exc:
        raise ReelLabError("FFmpeg не найден. Установите FFmpeg и добавьте его в PATH.", 500) from exc
    except subprocess.TimeoutExpired as exc:
        raise ReelLabError("Проверка видео заняла слишком много времени.") from exc


def probe(path: Path) -> dict[str, Any]:
    result = run([
        "ffprobe", "-v", "error", "-show_entries",
        "format=duration:stream=codec_type,width,height", "-of", "json", str(path),
    ], 90)
    if result.returncode:
        raise ReelLabError("Не удалось прочитать видео. Выберите другой файл.")
    try:
        data = json.loads(result.stdout)
        duration = float(data.get("format", {}).get("duration", 0))
    except (ValueError, TypeError, json.JSONDecodeError):
        raise ReelLabError("Не удалось прочитать параметры видео. Выберите другой файл.")
    if not math.isfinite(duration):
        raise ReelLabError("Не удалось прочитать длительность видео. Выберите другой файл.")
    video = next((item for item in data.get("streams", []) if item.get("codec_type") == "video"), None)
    if not video or duration <= 0:
        raise ReelLabError("В выбранном файле нет корректной видеодорожки.")
    return {
        "duration": duration, "width": int(video.get("width") or 0),
        "height": int(video.get("height") or 0),
        "has_audio": any(item.get("codec_type") == "audio" for item in data.get("streams", [])),
    }


def fetch_upload(upload_id: str) -> sqlite3.Row:
    if not valid_identifier(upload_id):
        raise ReelLabError("Исходное видео не найдено.", 404)
    with database() as conn:
        row = conn.execute("SELECT * FROM uploads WHERE id=?", (upload_id,)).fetchone()
    if row is None:
        raise ReelLabError("Исходное видео не найдено.", 404)
    _check_owner(row, "Исходное видео не найдено.")
    return row


def fetch_caption(caption_id: str) -> sqlite3.Row:
    if not valid_identifier(caption_id):
        raise ReelLabError("Файл субтитров не найден.", 404)
    with database() as conn:
        row = conn.execute("SELECT * FROM captions WHERE id=?", (caption_id,)).fetchone()
    if row is None:
        raise ReelLabError("Файл субтитров не найден.", 404)
    _check_owner(row, "Файл субтитров не найден.")
    return row


def fetch_job(job_id: str) -> sqlite3.Row:
    if not valid_identifier(job_id):
        raise ReelLabError("Ролик не найден.", 404)
    with database() as conn:
        row = conn.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
    if row is None:
        raise ReelLabError("Ролик не найден.", 404)
    _check_owner(row, "Ролик не найден.")
    return row


def update_job(job_id: str, **values: Any) -> None:
    values["updated"] = now()
    columns = ", ".join(f"{key}=?" for key in values)
    with lock, database() as conn:
        conn.execute(f"UPDATE jobs SET {columns} WHERE id=?", (*values.values(), job_id))


def complete_job(job_id: str, **values: Any) -> bool:
    """Publish a completed job only when it was not cancelled concurrently."""
    values["updated"] = now()
    columns = ", ".join(f"{key}=?" for key in values)
    with lock, database() as conn:
        cursor = conn.execute(
            f"UPDATE jobs SET {columns} WHERE id=? AND status='running' AND cancel_requested=0",
            (*values.values(), job_id),
        )
    return cursor.rowcount == 1


def queue() -> dict[str, int]:
    with database() as conn:
        running = conn.execute("SELECT COUNT(*) n FROM jobs WHERE status IN ('running','cancelling')").fetchone()["n"]
        queued = conn.execute("SELECT COUNT(*) n FROM jobs WHERE status='queued'").fetchone()["n"]
    return {"running": int(running), "queued": int(queued), "concurrency": WORKERS}


def result_features(settings: dict[str, Any]) -> dict[str, dict[str, Any]]:
    unavailable = "Функция включится после подключения серверных ИИ-модулей."
    return {
        name: {
            "enabled": bool(settings.get(name)), "applied": False,
            "count": 0, "evaluated": False, "reason": unavailable,
        }
        for name in ("smart_cut", "cut_pauses", "emoji", "sound_effects", "media_cards",
                     "panels", "motion", "opening_zoom", "hook")
    }


def serialize_job(row: sqlite3.Row) -> dict[str, Any]:
    settings = load(row["settings"], dict(DEFAULT_SETTINGS))
    if isinstance(settings, dict):
        settings = {key: value for key, value in settings.items() if key not in ("style_spec", "render_origin")}
    item: dict[str, Any] = {
        "id": row["id"], "name": row["name"], "created": int(row["created"]),
        "updated": int(row["updated"]), "status": row["status"], "phase": row["phase"],
        "kind": row["kind"], "settings": settings,
    }
    if row["error"]:
        item["error"] = row["error"]
    if row["status"] in ("queued", "running", "cancelling"):
        item["progress"] = {
            "basis": "pipeline-stages", "phase": row["phase"],
            "percent": int(row["progress_percent"]),
        }
        label = render_labels.get(row["id"])
        if label:
            item["progress_label"] = label
        if row["status"] == "queued" and scheduler is not None:
            position = scheduler.position(row["id"])
            if position:
                item["queue_position"] = position
    if row["status"] == "completed":
        path = Path(row["output_path"]) if row["output_path"] else None
        audio_path = Path(row["audio_path"]) if row["audio_path"] else None
        warnings = load(row["warnings"], [])
        item["result"] = {
            "duration": float(row["duration"] or 0), "removed_seconds": float(row["removed_seconds"] or 0),
            "size_bytes": path.stat().st_size if path and path.exists() else 0,
            "audio_available": bool(audio_path and audio_path.exists()),
            "warnings": warnings if isinstance(warnings, list) else [],
            "feature_results": result_features(settings),
        }
    return item


def cancellation_requested(job_id: str) -> bool:
    with database() as conn:
        row = conn.execute("SELECT cancel_requested FROM jobs WHERE id=?", (job_id,)).fetchone()
    return bool(row and row["cancel_requested"])


def stop_process(job_id: str) -> None:
    with process_lock:
        process = processes.get(job_id)
    if process and process.poll() is None:
        try:
            process.terminate()
        except OSError:
            pass


def terminate_and_wait(process: subprocess.Popen[Any]) -> None:
    """Stop a child process and always reap its process handle."""
    if process.poll() is not None:
        process.wait()
        return
    try:
        process.terminate()
    except OSError:
        return
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        try:
            process.kill()
        except OSError:
            pass
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass


def run_job_command(job_id: str, command: list[str], *, cwd: Path | None = None) -> None:
    if command and Path(command[0]).name.lower().startswith("ffmpeg") and "-nostdin" not in command:
        command = [command[0], "-nostdin", *command[1:]]
    log_path = JOBS / job_id / "ffmpeg.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log = log_path.open("ab")
    try:
        process = subprocess.Popen(
            # A file avoids the deadlock that a never-drained PIPE causes on
            # long FFmpeg renders and preserves diagnostics for local support.
            command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=log,
            cwd=str(cwd) if cwd else None,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except FileNotFoundError as exc:
        log.close()
        raise ReelLabError("FFmpeg не найден. Установите FFmpeg и добавьте его в PATH.", 500) from exc
    except Exception:
        log.close()
        raise
    with process_lock:
        processes[job_id] = process
    deadline = time.monotonic() + FFMPEG_TIMEOUT_SECONDS
    try:
        while process.poll() is None:
            if cancellation_requested(job_id):
                terminate_and_wait(process)
                raise JobCancelled()
            if time.monotonic() >= deadline:
                terminate_and_wait(process)
                raise ReelLabError("FFmpeg не завершил операцию вовремя. Попробуйте более короткое видео.", 500, "ffmpeg_timeout")
            time.sleep(0.2)
        if process.returncode:
            if cancellation_requested(job_id):
                raise JobCancelled()
            raise ReelLabError("FFmpeg не смог собрать ролик.", 500, "ffmpeg_failed")
    finally:
        if process.poll() is None:
            terminate_and_wait(process)
        else:
            process.wait()
        with process_lock:
            processes.pop(job_id, None)
        log.close()


def target_dimensions(value: Any) -> tuple[int, int] | None:
    return {
        "vertical_1080": (1080, 1920), "vertical_720": (720, 1280),
        "horizontal_1080": (1920, 1080), "source": None,
    }.get(str(value), (1080, 1920))


def video_filters(settings: dict[str, Any]) -> list[str]:
    filters: list[str] = []
    quality = settings.get("video_enhancement", "balanced")
    if quality == "balanced":
        # Denoise before enlarging a frame, then apply a modest sharpener.
        filters.append("hqdn3d=1.2:1.2:3:3")
        sharpen = "unsharp=5:5:0.45:5:5:0"
    elif quality == "strong":
        filters.append("hqdn3d=2:2:4:4")
        sharpen = "unsharp=5:5:0.8:5:5:0.1"
    else:
        sharpen = None
    target = target_dimensions(settings.get("output_resolution"))
    if target:
        width, height = target
        filters += [
            f"scale={width}:{height}:force_original_aspect_ratio=increase:flags=lanczos",
            f"crop={width}:{height}",
            "setsar=1",
        ]
    else:
        # H.264 with yuv420p requires even dimensions. Preserve a source-size
        # export by trimming at most one pixel from each odd edge.
        filters += ["scale=trunc(iw/2)*2:trunc(ih/2)*2:flags=lanczos", "setsar=1"]
    if sharpen:
        filters.append(sharpen)
    grade = settings.get("color_grade", "natural")
    if grade == "natural":
        filters.append("eq=contrast=1.03:saturation=1.04")
    elif grade == "warm":
        filters.append("eq=contrast=1.06:saturation=1.10:brightness=0.015")
    elif grade == "vivid":
        filters.append("eq=contrast=1.10:saturation=1.18:brightness=0.01")
    return filters


def audio_filters(settings: dict[str, Any]) -> list[str]:
    preset = settings.get("audio_preset", "clear_speech")
    filters: list[str] = []
    if preset != "original":
        filters = ["aresample=48000", "highpass=f=75", "lowpass=f=15500"]
    reduction = settings.get("noise_reduction", "medium")
    if reduction == "light":
        if not filters:
            filters.append("aresample=48000")
        filters.append("afftdn=nr=8:nf=-40")
    elif reduction == "medium":
        if not filters:
            filters.append("aresample=48000")
        filters.append("afftdn=nr=16:nf=-42")
    elif reduction == "strong":
        if not filters:
            filters.append("aresample=48000")
        filters.append("afftdn=nr=24:nf=-45")
    if preset in ("clear_speech", "podcast"):
        filters += [
            "acompressor=threshold=-20dB:ratio=3:attack=20:release=250",
            "dynaudnorm=f=150:g=9:p=0.9",
        ]
    if settings.get("normalize_audio", True):
        if not filters:
            filters.append("aresample=48000")
        filters.append("loudnorm=I=-16:TP=-1.5:LRA=11")
    return filters


def trim_number(value: Any, fallback: float) -> float:
    """Read a user supplied timestamp without ever passing NaN/Infinity to FFmpeg."""
    # bool is a number subclass, but accepting True as one second makes a
    # malformed JSON request surprisingly change the edit.
    if isinstance(value, bool):
        return fallback
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    return number if math.isfinite(number) else fallback


def trim_range(settings: dict[str, Any], source_duration: float) -> tuple[float, float]:
    """Return a safe inclusive-exclusion range [start, end] for an upload.

    The UI can send ordinary numbers or numeric strings.  Values outside the
    uploaded video's duration are clamped, while a collapsed range is rejected
    before a worker creates a broken/empty MP4.
    """
    duration = trim_number(source_duration, 0.0)
    if duration <= 0:
        raise ReelLabError("Не удалось определить длительность видео для обрезки.")

    start = trim_number(settings.get("trim_start"), 0.0)
    raw_end = settings.get("trim_end")
    end = duration if raw_end in (None, "") else trim_number(raw_end, duration)
    start = min(max(start, 0.0), duration)
    end = min(max(end, 0.0), duration)
    whole_source = start <= TRIM_EPSILON_SECONDS and duration - end <= TRIM_EPSILON_SECONDS
    if end - start < MIN_TRIM_SECONDS and not whole_source:
        raise ReelLabError("Конец фрагмента должен быть позже начала хотя бы на 0,1 секунды.")
    return start, end


def normalize_trim_settings(settings: dict[str, Any], source_duration: float) -> dict[str, Any]:
    """Clamp a job's trim settings and preserve no-trim FFmpeg behavior."""
    start, end = trim_range(settings, source_duration)
    normalized = dict(settings)
    duration = float(source_duration)
    if start <= TRIM_EPSILON_SECONDS and duration - end <= TRIM_EPSILON_SECONDS:
        normalized["trim_start"] = 0.0
        normalized["trim_end"] = None
    else:
        # Millisecond precision is more than enough for local browser controls
        # and avoids exposing binary floating point artefacts back to the UI.
        normalized["trim_start"] = round(start, 3)
        normalized["trim_end"] = round(end, 3)
    return normalized


def ffmpeg_seconds(value: float) -> str:
    """Format a finite timestamp without scientific notation for FFmpeg."""
    return f"{value:.3f}".rstrip("0").rstrip(".") or "0"


def write_placeholder_srt(path: Path) -> None:
    path.write_text(
        "1\n00:00:00,000 --> 00:00:02,500\n"
        "Субтитры будут доступны после подключения модуля распознавания речи.\n",
        encoding="utf-8",
    )


def srt_seconds(value: str) -> float:
    """Read one SRT clock safely enough for the local caption worker."""
    try:
        hours, minutes, seconds = value.strip().replace(",", ".").split(":")
        return int(hours) * 3600 + int(minutes) * 60 + float(seconds)
    except (TypeError, ValueError):
        return 0.0


def srt_clock(seconds: float) -> str:
    milliseconds = max(0, int(round(float(seconds) * 1000)))
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    whole_seconds, milliseconds = divmod(remainder, 1_000)
    return f"{hours:02d}:{minutes:02d}:{whole_seconds:02d},{milliseconds:03d}"


def read_srt_cues(path: Path) -> list[tuple[float, float, str]]:
    """Parse plain SRT produced by GigaAM without accepting markup as code."""
    try:
        blocks = path.read_text(encoding="utf-8-sig", errors="replace").replace("\r\n", "\n").split("\n\n")
    except OSError as exc:
        raise ReelLabError("Не удалось открыть созданные субтитры.", 500) from exc
    cues: list[tuple[float, float, str]] = []
    for block in blocks:
        lines = [line.strip() for line in block.split("\n")]
        if len(lines) < 3 or "-->" not in lines[1]:
            continue
        start_raw, end_raw = (part.strip() for part in lines[1].split("-->", 1))
        start, end = srt_seconds(start_raw), srt_seconds(end_raw)
        text = " ".join(line for line in lines[2:] if line).strip()
        if end > start and text:
            cues.append((start, end, text))
    return cues


def write_srt_cues(path: Path, cues: list[tuple[float, float, str]]) -> None:
    blocks = [
        f"{index}\n{srt_clock(start)} --> {srt_clock(end)}\n{text}"
        for index, (start, end, text) in enumerate(cues, start=1)
    ]
    path.write_text("\n\n".join(blocks) + ("\n" if blocks else ""), encoding="utf-8")


def caption_text_from_bytes(value: bytes) -> str:
    """Decode a downloaded text subtitle without treating binary data as text."""
    for encoding in ("utf-8-sig", "utf-16", "cp1251"):
        try:
            text = value.decode(encoding)
        except UnicodeDecodeError:
            continue
        if "\x00" not in text:
            # A Windows CRLF string written back through text mode can become
            # CRCRLF.  Keep one canonical newline form before any parser or
            # temporary SRT file sees it.
            return text.replace("\r\n", "\n").replace("\r", "\n")
    raise ReelLabError("Не удалось прочитать файл субтитров. Сохрани его как SRT, VTT или ASS в UTF-8.")


def clean_imported_caption_text(value: str) -> str:
    """Drop lightweight markup while retaining only visible caption text."""
    source = value.replace("\\N", "\n").replace("\\n", "\n").replace("\\h", " ")
    result: list[str] = []
    in_tag = False
    for character in source:
        if character == "<":
            in_tag = True
        elif character == ">" and in_tag:
            in_tag = False
        elif not in_tag:
            result.append(character)
    return " ".join("".join(result).split())


def parse_vtt_seconds(value: str) -> float:
    pieces = value.strip().replace(",", ".").split(":")
    try:
        if len(pieces) == 2:
            minutes, seconds = pieces
            return int(minutes) * 60 + float(seconds)
        if len(pieces) == 3:
            hours, minutes, seconds = pieces
            return int(hours) * 3600 + int(minutes) * 60 + float(seconds)
    except ValueError:
        pass
    return 0.0


def parse_vtt_cues(text: str) -> list[tuple[float, float, str]]:
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    cues: list[tuple[float, float, str]] = []
    index = 0
    while index < len(lines):
        if "-->" not in lines[index]:
            index += 1
            continue
        start_raw, end_raw = (part.strip() for part in lines[index].split("-->", 1))
        start = parse_vtt_seconds(start_raw)
        end = parse_vtt_seconds(end_raw.split(maxsplit=1)[0] if end_raw else "")
        index += 1
        words: list[str] = []
        while index < len(lines) and lines[index].strip():
            words.append(lines[index])
            index += 1
        caption = clean_imported_caption_text(" ".join(words))
        if end > start and caption:
            cues.append((start, end, caption))
    return cues


def parse_ass_seconds(value: str) -> float:
    pieces = value.strip().replace(",", ".").split(":")
    try:
        if len(pieces) == 3:
            hours, minutes, seconds = pieces
            return int(hours) * 3600 + int(minutes) * 60 + float(seconds)
    except ValueError:
        pass
    return 0.0


def clean_ass_dialogue_text(value: str) -> str:
    result: list[str] = []
    in_override = False
    for character in value:
        if character == "{":
            in_override = True
        elif character == "}" and in_override:
            in_override = False
        elif not in_override:
            result.append(character)
    return clean_imported_caption_text("".join(result))


def parse_ass_cues(text: str) -> list[tuple[float, float, str]]:
    cues: list[tuple[float, float, str]] = []
    for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        if not line.lstrip().lower().startswith("dialogue:"):
            continue
        columns = line.split(":", 1)[1].lstrip().split(",", 9)
        if len(columns) != 10:
            continue
        start, end = parse_ass_seconds(columns[1]), parse_ass_seconds(columns[2])
        caption = clean_ass_dialogue_text(columns[9])
        if end > start and caption:
            cues.append((start, end, caption))
    return cues


def parse_imported_caption(raw: bytes, suffix: str) -> list[tuple[float, float, str]]:
    """Normalize SRT, VTT and ASS into safe, plain SRT cues for the renderer."""
    text = caption_text_from_bytes(raw)
    temporary = CAPTIONS / f".parse-{identifier()}.srt"
    try:
        if suffix == ".srt":
            # Write bytes directly: Windows text mode would expand every \n
            # to CRLF, including newlines that arrived as CRLF originally.
            temporary.write_bytes(text.encode("utf-8"))
            cues = read_srt_cues(temporary)
        elif suffix == ".vtt":
            cues = parse_vtt_cues(text)
        elif suffix == ".ass":
            cues = parse_ass_cues(text)
        else:
            cues = []
    finally:
        temporary.unlink(missing_ok=True)
    if not cues:
        raise ReelLabError("В файле не нашлись субтитры с таймингами. Нужен SRT, VTT или ASS.")
    if len(cues) > 10_000:
        raise ReelLabError("В файле слишком много строк субтитров.")
    return cues


def trim_caption_cues(path: Path, trim_start: float, trim_end: float) -> list[tuple[float, float, str]]:
    """Move source timings into the rendered clip and remove out-of-range cues."""
    trimmed: list[tuple[float, float, str]] = []
    for start, end, text in read_srt_cues(path):
        if end <= trim_start or start >= trim_end:
            continue
        start = max(start, trim_start) - trim_start
        end = min(end, trim_end) - trim_start
        if end - start >= 0.04:
            trimmed.append((start, end, text))
    write_srt_cues(path, trimmed)
    return trimmed


def ass_clock(seconds: float) -> str:
    centiseconds = max(0, int(round(float(seconds) * 100)))
    hours, remainder = divmod(centiseconds, 360_000)
    minutes, remainder = divmod(remainder, 6_000)
    whole_seconds, centiseconds = divmod(remainder, 100)
    return f"{hours}:{minutes:02d}:{whole_seconds:02d}.{centiseconds:02d}"


def ass_escape(value: str) -> str:
    """Escape a caption so speech text can never become an ASS command."""
    return " ".join(str(value).split()).replace("\\", "\\\\").replace("{", "\\{").replace("}", "\\}")


def ass_text(value: str, line_limit: int) -> str:
    """Make an ASS-safe, comfortably readable caption of at most two lines."""
    words = ass_escape(value).split()
    lines: list[str] = []
    line = ""
    for word in words:
        proposed = f"{line} {word}".strip()
        if line and len(proposed) > line_limit and len(lines) == 0:
            lines.append(line)
            line = word
        else:
            line = proposed
    if line:
        lines.append(line)
    return "\\N".join(lines[:2])


QUICK_TYPE_SPEEDS: dict[str, dict[str, float | int]] = {
    # Type from the cue's first moment almost through to its last one.  The
    # speed choice controls the density of real key presses rather than making
    # a phrase finish early and sit unchanged while its speech continues.
    # ``minimum_step`` also keeps rapid, short cues from packing clicks on top
    # of each other, so a supplied keyboard sound has room to be heard.
    "soft": {"tail": 0.09, "minimum_step": 0.115, "steps": 14},
    "normal": {"tail": 0.07, "minimum_step": 0.095, "steps": 18},
    "fast": {"tail": 0.05, "minimum_step": 0.080, "steps": 22},
}


# Each choice is an audio file supplied by the creator.  The bot never
# substitutes a synthetic effect: a small real click is taken from the chosen
# WAV and repeated at the subtitle timing.  The MP3 twins are used only by the
# web preview; WAV keeps the render path fast and offline.
TYPING_SOUND_DIRECTORY = STATIC / "sounds"
TYPING_SOUND_PRESETS: dict[str, dict[str, Any]] = {
    # Durations were measured from the creator's source clips: they retain
    # the full strike and its natural tail, without adding a long silence.
    "game_buttons": {"asset": "game_buttons.wav", "clip_ms": 60},
    "iphone_keyboard": {"asset": "iphone_keyboard.wav", "clip_ms": 55},
    "typewriter": {"asset": "typewriter.wav", "clip_ms": 115},
    "sound_four": {"asset": "sound_four.wav", "clip_ms": 75},
    "sound_five": {"asset": "sound_five.wav", "clip_ms": 85},
}
# Previously saved jobs used the old generated-sound identifiers.  Point them
# at supplied clips so a retry never brings the artificial effects back.
TYPING_SOUND_ALIASES = {
    "soft_keyboard": "iphone_keyboard",
    "mechanical_keyboard": "game_buttons",
    "quiet_keys": "sound_four",
}


def quick_type_speed(value: Any) -> str:
    """Return one of the three friendly typewriter pacing choices."""
    return str(value) if str(value) in QUICK_TYPE_SPEEDS else "soft"


def typing_sound_preset(value: Any) -> str:
    """Return a recognised creator-supplied typing sound, never arbitrary input."""
    candidate = TYPING_SOUND_ALIASES.get(str(value).strip().lower(), str(value).strip().lower())
    return candidate if candidate in TYPING_SOUND_PRESETS else "iphone_keyboard"


def quick_type_title_lines(value: str, line_limit: int = 21) -> list[str]:
    """Pre-compute the typewriter's stable one- or two-line layout."""
    title = " ".join(str(value).split())
    if not title:
        return []
    lines: list[str] = []
    line = ""
    for word in title.split():
        proposed = f"{line} {word}".strip()
        if line and len(proposed) > line_limit and not lines:
            lines.append(line)
            line = word
        else:
            line = proposed
    if line:
        lines.append(line)
    return lines[:2] or [title]


def quick_type_plan(start: float, end: float, character_count: int, speed: Any) -> list[tuple[float, float, int]]:
    """Build one continuous, fixed-position typewriter schedule for a cue.

    The final text is intentionally reached just before the subtitle cue
    ends.  Captions from the speech recogniser only carry phrase timings, so
    this is the closest reliable way to keep both the letters and the keyboard
    clicks moving with the spoken phrase instead of completing in its first
    second.
    """
    duration = max(0.0, float(end) - float(start))
    if character_count < 2 or duration < 0.08:
        return []
    config = QUICK_TYPE_SPEEDS[quick_type_speed(speed)]
    # Leave only a short, unobtrusive settling tail (never more than 0.1 s).
    # On very short cues the proportional cap avoids consuming most of the
    # frame, and the safe fallback below emits one stable caption instead.
    # Five centiseconds exceeds the minimum duration accepted by ``add_event``
    # below.  Keeping that small static tail prevents the fully typed phrase
    # from disappearing for a frame on short, otherwise animated cues.
    tail = max(0.05, min(float(config["tail"]), duration * 0.12, 0.1))
    typing_duration = duration - tail
    available_steps = max(1, int(typing_duration / float(config["minimum_step"])))
    step_count = min(int(config["steps"]), int(character_count), available_steps)
    if step_count < 2:
        return []

    # A slightly longer beat every few presses avoids a robotic metronome,
    # while neighbouring events still meet exactly with no flash or gap.
    # Text becomes visible at the *start* of an ASS event.  Make the final
    # event begin exactly at ``typing_end`` and hold it through the cue end:
    # the last letters and their matching key click therefore land in the
    # short tail, rather than a whole rhythm interval early.
    weights = [1.0 + (0.14 if (index + 1) % 4 == 0 else 0.0) for index in range(step_count)]
    typing_end = float(end) - tail
    paced_weights = weights[:-1]
    total_weight = sum(paced_weights)
    cursor = float(start)
    plan: list[tuple[float, float, int]] = []
    for index, weight in enumerate(weights, start=1):
        next_cursor = (
            float(end)
            if index == step_count
            else cursor + typing_duration * weight / total_weight
        )
        visible_count = max(1, math.ceil(character_count * index / step_count))
        plan.append((cursor, next_cursor, visible_count))
        cursor = next_cursor
    return plan


def typing_sound_volume(value: Any) -> int:
    """Read a UI slider safely; malformed values never reach FFmpeg."""
    if isinstance(value, bool):
        return 35 if value else 0
    try:
        volume = int(round(float(value)))
    except (TypeError, ValueError):
        return 35
    return max(0, min(100, volume))


def typing_sound_enabled(value: Any) -> bool:
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return bool(value)


def typing_sound_asset_path(preset: Any) -> Path:
    """Find a bundled, user-supplied WAV for a sound choice."""
    key = typing_sound_preset(preset)
    path = TYPING_SOUND_DIRECTORY / str(TYPING_SOUND_PRESETS[key]["asset"])
    if not path.is_file():
        raise OSError(f"Не найден звук набора: {path.name}")
    return path


def load_typing_click(preset: Any) -> tuple[int, array]:
    """Read one short, audible key strike from the selected creator audio."""
    key = typing_sound_preset(preset)
    profile = TYPING_SOUND_PRESETS[key]
    asset = typing_sound_asset_path(key)
    try:
        with wave.open(str(asset), "rb") as source:
            channels = source.getnchannels()
            sample_width = source.getsampwidth()
            sample_rate = source.getframerate()
            raw = source.readframes(source.getnframes())
    except (OSError, wave.Error) as exc:
        raise OSError(f"Не удалось прочитать звук набора «{asset.name}».") from exc
    if channels != 1 or sample_width != 2 or sample_rate != 48_000:
        raise OSError(f"Звук «{asset.name}» должен быть WAV 48 кГц, mono, 16-bit.")
    samples = array("h")
    samples.frombytes(raw)
    if not samples:
        raise OSError(f"Звук «{asset.name}» пустой.")
    peak_index, peak = max(enumerate(samples), key=lambda pair: abs(pair[1]))
    if abs(peak) < 64:
        raise OSError(f"Звук «{asset.name}» не содержит слышимого клика.")

    # Keep a tiny lead-in before the strongest transient and fade the tail so
    # a short supplied clip can repeat without a hard digital cut.
    clip_frames = max(1, int(sample_rate * int(profile["clip_ms"]) / 1000))
    lead_frames = min(int(sample_rate * 0.006), clip_frames // 4)
    start = max(0, peak_index - lead_frames)
    end = min(len(samples), start + clip_frames)
    click = array("h", samples[start:end])
    if len(click) < clip_frames:
        click.extend([0] * (clip_frames - len(click)))
    fade_frames = min(len(click) // 3, int(sample_rate * 0.009))
    if fade_frames:
        for offset in range(fade_frames):
            index = len(click) - fade_frames + offset
            click[index] = int(click[index] * (fade_frames - offset) / fade_frames)
    return sample_rate, click


def write_typing_sound_track(
    path: Path,
    cues: list[tuple[float, float, str]],
    speed: Any,
    volume: Any,
    preset: Any = "iphone_keyboard",
) -> int:
    """Build a local WAV from the creator-selected key sound and cue timing."""
    level = typing_sound_volume(volume)
    if level <= 0:
        return 0
    sample_rate, click = load_typing_click(preset)

    presses: list[float] = []
    for start, end, text in cues:
        title = "\n".join(quick_type_title_lines(text))
        for press_start, _press_end, _visible_count in quick_type_plan(start, end, len(title), speed):
            presses.append(max(0.0, press_start + 0.006))
    if not presses:
        return 0

    # The supplied sounds stay recognisable at 100%, while the 35% default
    # leaves the original speaker clearly in front.
    base_gain = 0.05 + 0.82 * (level / 100.0)
    silence_chunk = b"\x00\x00" * min(sample_rate, 16_384)
    cursor = 0
    # ``pending`` contains only the short tail after the last written point.
    # It lets rapid presets overlap at their real timestamps instead of
    # delaying clicks one behind another when the user selects «Быстро».
    pending = array("h")
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        for index, press in enumerate(presses):
            target = max(cursor, int(round(press * sample_rate)))
            lead = target - cursor
            if lead:
                if len(pending) >= lead:
                    output.writeframesraw(pending[:lead].tobytes())
                    pending = array("h", pending[lead:])
                else:
                    output.writeframesraw(pending.tobytes())
                    remaining = lead - len(pending)
                    while remaining:
                        chunk_samples = min(remaining, len(silence_chunk) // 2)
                        output.writeframesraw(silence_chunk[:chunk_samples * 2])
                        remaining -= chunk_samples
                    pending = array("h")
                cursor = target

            gain = base_gain * (0.94 + (index % 3) * 0.03)
            if len(pending) < len(click):
                pending.extend([0] * (len(click) - len(pending)))
            for sample_index, sample in enumerate(click):
                mixed = pending[sample_index] + int(sample * gain)
                pending[sample_index] = max(-32_767, min(32_767, mixed))
        if pending:
            output.writeframesraw(pending.tobytes())
    return len(presses)

def caption_words(value: str) -> list[str]:
    """Return visible words before ASS escaping, for automatic emphasis."""
    return [word for word in " ".join(str(value).split()).split(" ") if word]


def caption_accent_index(words: list[str]) -> int:
    """Choose a meaningful word/number for a non-word-timed visual accent."""
    if not words:
        return 0

    def score(index: int) -> tuple[int, int, int]:
        clean = words[index].strip(".,!?;:…—–-()[]{}\"'«»")
        return (20 if any(character.isdigit() for character in clean) else 0, len(clean), index)

    return max(range(len(words)), key=score)


def ass_inline_words(
    words: list[str],
    accent_index: int,
    *,
    accent_color: str,
    reset_color: str,
    line_limit: int,
    accent_scale: int = 100,
    accent_font: str | None = None,
    uppercase: bool = False,
) -> str:
    """Build up to two lines with one safely highlighted word."""
    parts: list[str] = []
    line_length = 0
    line_count = 0
    for index, raw_word in enumerate(words):
        word = ass_escape(raw_word)
        visible = word.upper() if uppercase and index == accent_index else word
        proposed = line_length + (1 if line_length else 0) + len(word)
        if line_length and proposed > line_limit and line_count == 0:
            parts.append("\\N")
            line_length = 0
            line_count = 1
        elif line_length:
            parts.append(" ")
        if index == accent_index:
            font_tag = f"\\fn{accent_font}" if accent_font else ""
            parts.append(
                f"{{\\c{accent_color}\\fscx{accent_scale}\\fscy{accent_scale}{font_tag}}}"
                f"{visible}"
                f"{{\\c{reset_color}\\fscx100\\fscy100}}"
            )
        else:
            parts.append(visible)
        line_length += len(word) + (1 if line_length else 0)
    return "".join(parts)


def _write_caption_ass_legacy(srt_path: Path, ass_path: Path, style: Any, width: int, height: int) -> int:
    """Create one of the eight creative, visible caption layers for FFmpeg."""
    safe_width = max(2, int(width or 1080))
    safe_height = max(2, int(height or 1920))
    scale = max(0.42, min(1.6, safe_width / 1080))

    def pixels(value: float, minimum: int = 1) -> int:
        return max(minimum, int(round(value * scale)))

    # Keep old jobs renderable after the visual styles were expanded.
    aliases = {"bold": "punch", "clean": "glass", "gold": "cinema", "catalog": "luxe"}
    selected_style = aliases.get(str(style), str(style))
    if selected_style not in {"luxe", "punch", "accent", "sticker", "neon", "magazine", "glass", "cinema"}:
        selected_style = "luxe"

    cues = read_srt_cues(srt_path)
    header = [
        "[Script Info]", "ScriptType: v4.00+", f"PlayResX: {safe_width}", f"PlayResY: {safe_height}",
        "ScaledBorderAndShadow: yes", "", "[V4+ Styles]",
        "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
        # The named styles use only fonts available on a standard Windows PC.
        f"Style: LuxeWhite,Segoe UI,{pixels(58, 20)},&H00FFFFFF,&H000000FF,&H00161616,&H60000000,0,0,0,0,100,100,0,0,1,{pixels(2)},{pixels(2)},2,70,70,{pixels(92)},1",
        f"Style: LuxeFocus,Bahnschrift,{pixels(120, 28)},&H003DD3FF,&H000000FF,&H00131313,&H60000000,0,0,0,0,100,100,0,0,1,{pixels(2)},{pixels(2)},2,70,70,{pixels(92)},1",
        f"Style: Punch,Arial,{pixels(88, 24)},&H00FFFFFF,&H000000FF,&H000A0A0A,&H70000000,-1,0,0,0,100,100,0,0,1,{pixels(7)},{pixels(3)},2,70,70,{pixels(100)},1",
        f"Style: Accent,Segoe UI,{pixels(68, 22)},&H00FFFFFF,&H000000FF,&H00161616,&H66000000,-1,0,0,0,100,100,0,0,1,{pixels(2)},{pixels(2)},2,70,70,{pixels(100)},1",
        f"Style: Sticker,Impact,{pixels(90, 26)},&H003DD3FF,&H000000FF,&H00000000,&H70000000,0,0,0,0,100,100,0,0,1,{pixels(8)},{pixels(3)},2,70,70,{pixels(105)},1",
        f"Style: Neon,Bahnschrift,{pixels(78, 23)},&H00F2EAD4,&H000000FF,&H0063342D,&H600C061A,0,0,0,0,100,100,0,0,1,{pixels(4)},{pixels(7)},2,70,70,{pixels(98)},1",
        f"Style: Magazine,Arial,{pixels(58, 20)},&H00FFFFFF,&H000000FF,&H00000000,&H4420163B,-1,0,0,0,100,100,{pixels(1)},0,3,{pixels(10)},{pixels(1)},2,70,70,{pixels(104)},1",
        f"Style: Glass,Segoe UI,{pixels(62, 21)},&H00FFFFFF,&H000000FF,&H00161A22,&H66151B27,-1,0,0,0,100,100,0,0,3,{pixels(8)},{pixels(1)},2,70,70,{pixels(106)},1",
        f"Style: Cinema,Georgia,{pixels(74, 23)},&H009AC4DC,&H000000FF,&H00160D08,&H70000000,-1,0,0,0,100,100,{pixels(1)},0,1,{pixels(3)},{pixels(2)},2,70,70,{pixels(102)},1",
        "", "[Events]", "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text",
    ]
    rows = list(header)

    def add_event(start: float, end: float, style_name: str, text: str, y: int, tags: str = "") -> None:
        if not text:
            return
        rows.append(
            f"Dialogue: 0,{ass_clock(start)},{ass_clock(end)},{style_name},,0,0,0,,"
            f"{{\\an2\\pos({safe_width // 2},{y}){tags}}}{text}"
        )

    anchor = int(safe_height * 0.78)
    # With bottom-centred ASS alignment, the white helper line must end above
    # the tall accent word rather than sharing its vertical space.
    luxe_before_gap = pixels(120, 48)
    luxe_after_gap = pixels(66, 30)
    for start, end, text in cues:
        words = caption_words(text)
        if not words:
            continue
        accent_index = caption_accent_index(words)
        if selected_style == "luxe":
            before = ass_text(" ".join(words[:accent_index]), 31)
            focus = ass_text(words[accent_index], 20).upper()
            after = ass_text(" ".join(words[accent_index + 1:]), 31)
            if before:
                add_event(start, end, "LuxeWhite", before, anchor - luxe_before_gap, "\\fad(90,130)")
            add_event(start, end, "LuxeFocus", focus, anchor, "\\fad(80,130)\\fscx72\\fscy96\\t(0,150,\\fscx82\\fscy100)")
            if after:
                add_event(start, end, "LuxeWhite", after, anchor + luxe_after_gap, "\\fad(100,120)")
        elif selected_style == "punch":
            formatted = ass_inline_words(
                words, accent_index, accent_color="&H003DD3FF&", reset_color="&H00FFFFFF&",
                line_limit=21, accent_scale=108, uppercase=True,
            )
            add_event(start, end, "Punch", formatted, anchor, "\\fad(70,110)\\fscx91\\fscy91\\t(0,135,\\fscx100\\fscy100)")
        elif selected_style == "accent":
            formatted = ass_inline_words(
                words, accent_index, accent_color="&H004DD6A5&", reset_color="&H00FFFFFF&",
                line_limit=27, accent_scale=106,
            )
            add_event(start, end, "Accent", formatted, anchor, "\\fad(110,130)\\t(0,130,\\fscx103\\fscy103)")
        elif selected_style == "sticker":
            add_event(start, end, "Sticker", ass_text(" ".join(words), 17).upper(), anchor, "\\fad(50,100)\\fscx86\\fscy86\\t(0,120,\\fscx100\\fscy100)")
        elif selected_style == "neon":
            add_event(start, end, "Neon", ass_text(" ".join(words), 23), anchor, "\\fad(120,170)\\blur1.2\\t(0,170,\\blur0.35)")
        elif selected_style == "magazine":
            add_event(start, end, "Magazine", ass_text(" ".join(words), 23).upper(), anchor, "\\fad(100,120)")
        elif selected_style == "glass":
            add_event(start, end, "Glass", ass_text(" ".join(words), 30), anchor, "\\fad(110,150)")
        elif selected_style == "cinema":
            add_event(start, end, "Cinema", ass_text(" ".join(words), 24), anchor, "\\fad(180,180)\\fsp1.2")
    ass_path.write_text("\n".join(rows) + "\n", encoding="utf-8")
    return len(cues)


def write_caption_ass(
    srt_path: Path,
    ass_path: Path,
    style: Any,
    width: int,
    height: int,
    position: Any = "bottom_center",
    color: Any = None,
    quick_type_speed_value: Any = "soft",
) -> int:
    """Build subtitle compositions with an optional safe creator-selected colour.

    GigaAM returns phrase timings rather than word timings. Punch animates
    estimated phrase groups, never pretending it knows exact word timing.
    """
    safe_width = max(2, int(width or 1080))
    safe_height = max(2, int(height or 1920))
    scale = max(0.42, min(1.6, safe_width / 1080))

    def pixels(value: float, minimum: int = 1) -> int:
        return max(minimum, int(round(value * scale)))

    aliases = {"bold": "punch", "clean": "glass", "gold": "cinema", "catalog": "luxe"}
    selected_style = aliases.get(str(style), str(style))
    valid_styles = {
        "luxe", "punch", "accent", "sticker", "neon", "magazine", "glass", "cinema", "kinetic_lime", "quick_type",
    }
    if selected_style not in valid_styles:
        selected_style = "luxe"

    valid_positions = {"bottom_center", "center", "top_center", "bottom_left", "bottom_right"}
    selected_position = str(position)
    if selected_position not in valid_positions:
        selected_position = "bottom_center"

    # ``caption_color_to_ass`` also validates the browser value before it can
    # reach the generated ASS file.  Existing jobs with no colour retain each
    # style's established palette.
    selected_color = caption_color_to_ass(color)

    def text_color(default: str) -> str:
        return selected_color or default

    cues = read_srt_cues(srt_path)
    header = [
        "[Script Info]", "ScriptType: v4.00+", f"PlayResX: {safe_width}", f"PlayResY: {safe_height}",
        "ScaledBorderAndShadow: yes", "", "[V4+ Styles]",
        "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
        f"Style: LuxeWhite,Segoe UI,{pixels(58, 20)},{text_color('&H00FFFFFF&')},&H000000FF,&H00171616,&H60000000,0,0,0,0,100,100,0,0,1,{pixels(2)},{pixels(2)},2,70,70,{pixels(92)},1",
        f"Style: LuxeFocus,Bahnschrift,{pixels(120, 28)},{text_color('&H003DD3FF&')},&H000000FF,&H00131313,&H60000000,0,0,0,0,100,100,0,0,1,{pixels(2)},{pixels(2)},2,70,70,{pixels(92)},1",
        f"Style: Rhythm,Bahnschrift,{pixels(86, 24)},{text_color('&H00F8F4E9&')},&H000000FF,&H00140E0A,&H60000000,-1,0,0,0,100,100,{pixels(1)},0,1,{pixels(5)},{pixels(3)},2,60,60,{pixels(96)},1",
        f"Style: Editorial,Segoe UI,{pixels(60, 20)},{text_color('&H00F9F5EE&')},&H000000FF,&H00110D0A,&H55000000,-1,0,0,0,100,100,0,0,1,{pixels(2)},{pixels(2)},7,45,45,{pixels(96)},1",
        f"Style: Sticker,Bahnschrift,{pixels(62, 21)},{text_color('&H001A1511&')},&H000000FF,&H001A1511,&H00000000,-1,0,0,0,100,100,{pixels(1)},0,1,{pixels(2)},{pixels(1)},2,40,40,{pixels(96)},1",
        f"Style: NeonGlow,Bahnschrift,{pixels(75, 23)},{text_color('&H00F3F4D7&')},&H000000FF,&H009D5D29,&H00000000,0,0,0,0,100,100,{pixels(1)},0,1,{pixels(6)},{pixels(2)},2,50,50,{pixels(96)},1",
        f"Style: Neon,Bahnschrift,{pixels(75, 23)},{text_color('&H00F9FCED&')},&H000000FF,&H004B3021,&H00000000,0,0,0,0,100,100,{pixels(1)},0,1,{pixels(2)},{pixels(2)},2,50,50,{pixels(96)},1",
        f"Style: Magazine,Bahnschrift,{pixels(64, 21)},{text_color('&H00F7F2E8&')},&H000000FF,&H00201712,&H50000000,-1,0,0,0,100,100,{pixels(1)},0,1,{pixels(2)},{pixels(2)},7,45,45,{pixels(96)},1",
        f"Style: Card,Segoe UI,{pixels(56, 20)},{text_color('&H00FFFFFF&')},&H000000FF,&H0016222E,&H40000000,-1,0,0,0,100,100,0,0,1,{pixels(2)},{pixels(2)},2,45,45,{pixels(96)},1",
        f"Style: Cinema,Georgia,{pixels(66, 22)},{text_color('&H00D7E9F8&')},&H000000FF,&H001A100A,&H60000000,-1,0,0,0,100,100,{pixels(1)},0,1,{pixels(2)},{pixels(2)},2,55,55,{pixels(96)},1",
        # #EAF5FF is a cold white; #DFFB00 is the supplied lime-yellow accent.
        f"Style: KineticGhost,Bahnschrift,{pixels(31, 17)},{text_color('&H00FFF5EA&')},&H000000FF,&H001B1710,&H44120F0A,-1,0,0,0,100,100,{pixels(2)},0,1,{pixels(2)},{pixels(1)},2,50,50,{pixels(96)},1",
        f"Style: KineticLime,Bahnschrift,{pixels(104, 29)},{text_color('&H0000FBDF&')},&H000000FF,&H001B1710,&H44120F0A,-1,0,0,0,100,100,{pixels(1)},0,1,{pixels(3)},{pixels(1)},2,42,42,{pixels(96)},1",
        f"Style: QuickType,Bahnschrift,{pixels(74, 24)},{text_color('&H00F8F4E9&')},&H000000FF,&H00171616,&H00000000,-1,0,0,0,100,100,{pixels(1)},0,1,{pixels(3)},{pixels(2)},2,46,46,{pixels(96)},1",
        f"Style: Marker,Segoe UI,{pixels(20, 12)},{text_color('&H0054C7F0&')},&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,{pixels(2)},0,1,0,0,7,35,35,{pixels(96)},1",
        f"Style: Shape,Arial,{pixels(12, 8)},&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1",
        "", "[Events]", "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text",
    ]
    rows = list(header)
    # Every composition below is authored around its own natural focal point.
    # These offsets move that whole composition as one unit when the caller
    # selects a subtitle position.  They are calculated after the local style
    # geometry is known, before any event is written.
    layout_dx = 0
    layout_dy = 0

    def add_event(
        start: float, end: float, style_name: str, text: str, *, x: int, y: int,
        alignment: int = 2, tags: str = "", layer: int = 1,
        move_from: tuple[int, int] | None = None,
    ) -> None:
        if not text or end - start < 0.04:
            return
        destination_x = x + layout_dx
        destination_y = y + layout_dy
        motion = ""
        if move_from is not None:
            move_ms = max(90, min(260, int((end - start) * 420)))
            motion = (
                f"\\move({move_from[0] + layout_dx},{move_from[1] + layout_dy},"
                f"{destination_x},{destination_y},0,{move_ms})"
            )
        else:
            motion = f"\\pos({destination_x},{destination_y})"
        rows.append(
            f"Dialogue: {layer},{ass_clock(start)},{ass_clock(end)},{style_name},,0,0,0,,"
            f"{{\\an{alignment}{motion}{tags}}}{text}"
        )

    def rounded_rect_path(box_width: int, box_height: int, radius: int) -> str:
        radius = max(1, min(radius, box_width // 2, box_height // 2))
        control = max(1, int(round(radius * 0.5523)))
        return (
            f"m {radius} 0 l {box_width - radius} 0 "
            f"b {box_width - radius + control} 0 {box_width} {radius - control} {box_width} {radius} "
            f"l {box_width} {box_height - radius} "
            f"b {box_width} {box_height - radius + control} {box_width - radius + control} {box_height} {box_width - radius} {box_height} "
            f"l {radius} {box_height} "
            f"b {radius - control} {box_height} 0 {box_height - radius + control} 0 {box_height - radius} "
            f"l 0 {radius} b 0 {radius - control} {radius - control} 0 {radius} 0"
        )

    def add_panel(
        start: float, end: float, *, x: int, y: int, box_width: int, box_height: int,
        color: str, alpha: int, radius: int, fade_in: int = 100, fade_out: int = 140,
        layer: int = 0, translate: bool = True,
    ) -> None:
        if end - start < 0.04:
            return
        if translate:
            x += layout_dx
            y += layout_dy
        drawing = rounded_rect_path(box_width, box_height, radius)
        rows.append(
            f"Dialogue: {layer},{ass_clock(start)},{ass_clock(end)},Shape,,0,0,0,,"
            f"{{\\an7\\pos({x},{y})\\p1\\1c{color}\\1a&H{max(0, min(255, alpha)):02X}&"
            f"\\bord0\\shad0\\fad({fade_in},{fade_out})}}{drawing}{{\\p0}}"
        )

    def add_rule(start: float, end: float, *, x: int, y: int, box_width: int, color: str, layer: int = 1) -> None:
        add_panel(
            start, end, x=x, y=y, box_width=box_width, box_height=pixels(5, 3),
            color=color, alpha=12, radius=pixels(3, 2), fade_in=90, fade_out=120, layer=layer,
        )

    def estimated_groups(words: list[str], start: float, end: float) -> list[tuple[float, float, list[str]]]:
        """Create phrase beats, not fictitious word-by-word timestamps."""
        duration = max(0.05, end - start)
        if duration < 0.9 or len(words) < 3:
            return [(start, end, words)]
        groups: list[list[str]] = []
        current: list[str] = []
        current_length = 0
        for word in words:
            prospective = current_length + (1 if current else 0) + len(word)
            if current and (len(current) >= 3 or prospective > 17):
                groups.append(current)
                current, current_length = [], 0
            current.append(word)
            current_length += len(word) + (1 if current_length else 0)
            if word[-1:] in ".,;:!?…" and len(current) >= 2:
                groups.append(current)
                current, current_length = [], 0
        if current:
            groups.append(current)
        max_groups = max(1, min(4, int(duration / 0.44)))
        while len(groups) > max_groups:
            groups[-2].extend(groups[-1])
            groups.pop()
        if len(groups) <= 1:
            return [(start, end, groups[0] if groups else words)]
        overlap = min(0.13, duration * 0.12)
        available = duration + overlap * (len(groups) - 1)
        weights = [sum(max(2, len(item.strip(".,;:!?…"))) for item in group) + 2 for group in groups]
        total_weight = max(1, sum(weights))
        result: list[tuple[float, float, list[str]]] = []
        cursor = start
        for index, group in enumerate(groups):
            group_duration = available * weights[index] / total_weight
            group_end = end if index == len(groups) - 1 else min(end, cursor + group_duration)
            result.append((cursor, max(cursor + 0.04, group_end), group))
            cursor = group_end - overlap
        return result

    centre_x = safe_width // 2
    lower_anchor = int(safe_height * 0.78)
    left_x = int(safe_width * 0.09)
    # A selected colour controls all readable copy and the accompanying small
    # accent rule.  With no selection the original palette remains intact.
    gold = text_color("&H0044B6F6&")
    dark = "&H0017130F&"
    teal = "&H00C9E0A6&"
    plum = "&H003B1D45&"
    glass = "&H00332618&"

    # Each visual treatment has a different natural focal point.  Moving by
    # the delta between that point and the requested point preserves the
    # treatment's internal spacing (text, rule and panel travel together).
    # The horizontal limits keep wide cards inside the video frame.
    target_points = {
        "bottom_center": (0.50, 0.78),
        "center": (0.50, 0.50),
        "top_center": (0.50, 0.20),
        "bottom_left": (0.25, 0.78),
        "bottom_right": (0.75, 0.78),
    }
    focal_points: dict[str, tuple[float, float, float, float, float, float]] = {
        # base x/y, then safe min/max x and y movement as screen fractions
        "luxe": (0.50, 0.78, -0.25, 0.25, -0.60, 0.10),
        "punch": (0.50, 0.56, -0.09, 0.09, -0.44, 0.32),
        "accent": (0.32, 0.54, -0.06, 0.38, -0.34, 0.28),
        "sticker": (0.50, 0.55, -0.08, 0.08, -0.44, 0.31),
        "neon": (0.50, 0.34, -0.25, 0.25, -0.15, 0.48),
        "magazine": (0.40, 0.30, -0.04, 0.20, -0.14, 0.56),
        "glass": (0.50, 0.79, -0.10, 0.10, -0.60, 0.08),
        "cinema": (0.50, 0.88, -0.25, 0.25, -0.69, 0.04),
        "kinetic_lime": (0.50, 0.78, -0.25, 0.25, -0.60, 0.10),
        "quick_type": (0.50, 0.78, -0.25, 0.25, -0.60, 0.10),
    }
    base_x, base_y, min_dx, max_dx, min_dy, max_dy = focal_points[selected_style]
    requested_x, requested_y = target_points[selected_position]
    layout_dx = max(int(min_dx * safe_width), min(int((requested_x - base_x) * safe_width), int(max_dx * safe_width)))
    layout_dy = max(int(min_dy * safe_height), min(int((requested_y - base_y) * safe_height), int(max_dy * safe_height)))

    for start, end, text in cues:
        words = caption_words(text)
        if not words:
            continue
        accent_index = caption_accent_index(words)

        # 01 — supplied reference: small context / large gold focus / quiet tail.
        if selected_style == "luxe":
            before = ass_text(" ".join(words[:accent_index]), 31)
            focus = ass_text(words[accent_index], 20).upper()
            after = ass_text(" ".join(words[accent_index + 1:]), 31)
            if before:
                add_event(start, end, "LuxeWhite", before, x=centre_x, y=lower_anchor - pixels(120, 48), tags="\\fad(90,130)", move_from=(centre_x, lower_anchor - pixels(106, 42)))
            add_event(start, end, "LuxeFocus", focus, x=centre_x, y=lower_anchor, tags="\\fad(80,130)\\fscx72\\fscy96\\t(0,150,\\fscx82\\fscy100)", move_from=(centre_x, lower_anchor + pixels(16, 8)), layer=2)
            if after:
                add_event(start, end, "LuxeWhite", after, x=centre_x, y=lower_anchor + pixels(66, 30), tags="\\fad(100,120)", move_from=(centre_x, lower_anchor + pixels(78, 34)))

        # 02 — phrase beats in a central rhythm card. Groups use only SRT cue timing.
        elif selected_style == "punch":
            block_top = int(safe_height * 0.43)
            add_panel(start, end, x=int(safe_width * 0.10), y=block_top, box_width=int(safe_width * 0.80), box_height=pixels(245, 100), color=dark, alpha=72, radius=pixels(36, 16), fade_in=110, fade_out=150)
            add_rule(start, end, x=int(safe_width * 0.17), y=block_top + pixels(34, 14), box_width=int(safe_width * 0.21), color=gold)
            for group_start, group_end, group in estimated_groups(words, start, end):
                formatted = ass_inline_words(group, caption_accent_index(group), accent_color=gold, reset_color=text_color("&H00F8F4E9&"), line_limit=15, accent_scale=111, accent_font="Bahnschrift", uppercase=True)
                add_event(group_start, group_end, "Rhythm", formatted, x=centre_x, y=int(safe_height * 0.56), tags="\\fad(100,120)\\fscx94\\fscy94\\t(0,180,\\fscx100\\fscy100)", move_from=(centre_x, int(safe_height * 0.56) + pixels(26, 12)), layer=2)

        # 03 — an editorial block in the left half of the frame.
        elif selected_style == "accent":
            block_y = int(safe_height * 0.50)
            add_rule(start, end, x=left_x, y=block_y, box_width=pixels(5, 3), color=gold)
            add_event(start, end, "Marker", "●", x=left_x + pixels(20, 8), y=block_y + pixels(7, 4), alignment=7, tags="\\fad(100,140)", move_from=(left_x + pixels(10, 4), block_y + pixels(23, 8)))
            formatted = ass_inline_words(words, accent_index, accent_color=gold, reset_color=text_color("&H00F9F5EE&"), line_limit=22, accent_scale=108, accent_font="Bahnschrift")
            add_event(start, end, "Editorial", formatted, x=left_x + pixels(38, 16), y=block_y + pixels(35, 15), alignment=7, tags="\\fad(120,150)\\fsp0.5", move_from=(left_x + pixels(38, 16), block_y + pixels(57, 22)), layer=2)

        # 04 — a warm poster sticker, intentionally playful but still soft.
        elif selected_style == "sticker":
            card_width = int(safe_width * 0.82)
            card_height = pixels(245, 104)
            card_x, card_y = (safe_width - card_width) // 2, int(safe_height * 0.42)
            add_panel(start, end, x=card_x, y=card_y, box_width=card_width, box_height=card_height, color=gold, alpha=10, radius=pixels(44, 18), fade_in=55, fade_out=105)
            add_event(start, end, "Sticker", ass_text(" ".join(words), 19).upper(), x=centre_x, y=card_y + card_height // 2 + pixels(4, 2), tags="\\fad(55,100)\\frz-1.2\\fscx78\\fscy78\\t(0,130,\\fscx104\\fscy104)\\t(130,230,\\fscx100\\fscy100)", move_from=(centre_x, card_y + card_height // 2 + pixels(18, 8)), layer=2)

        # 05 — glowing night text lives above centre and drifts in from right.
        elif selected_style == "neon":
            neon_y = int(safe_height * 0.34)
            neon_text = ass_text(" ".join(words), 20).upper()
            start_x = centre_x + pixels(86, 36)
            add_event(start, end, "NeonGlow", neon_text, x=centre_x, y=neon_y, tags="\\fad(140,180)\\blur3\\bord5\\1a&H72&\\t(0,180,\\blur1.4)", move_from=(start_x, neon_y + pixels(16, 7)), layer=1)
            add_event(start, end, "Neon", neon_text, x=centre_x, y=neon_y, tags="\\fad(140,180)\\blur0.25\\fscx94\\fscy94\\t(0,180,\\fscx100\\fscy100)", move_from=(start_x, neon_y + pixels(16, 7)), layer=2)
            add_rule(start, end, x=int(safe_width * 0.32), y=neon_y + pixels(76, 30), box_width=int(safe_width * 0.36), color=teal, layer=2)

        # 06 — upper-left magazine cover field, avoiding another lower third.
        elif selected_style == "magazine":
            box_x, box_y = int(safe_width * 0.055), int(safe_height * 0.22)
            box_width, box_height = int(safe_width * 0.73), pixels(315, 136)
            add_panel(start, end, x=box_x, y=box_y, box_width=box_width, box_height=box_height, color=plum, alpha=20, radius=pixels(30, 14), fade_in=130, fade_out=160)
            add_rule(start, end, x=box_x + pixels(34, 14), y=box_y + pixels(38, 16), box_width=pixels(100, 44), color=gold)
            formatted = ass_inline_words(words, accent_index, accent_color=gold, reset_color=text_color("&H00F7F2E8&"), line_limit=20, accent_scale=107, accent_font="Bahnschrift", uppercase=True)
            add_event(start, end, "Magazine", formatted, x=box_x + pixels(36, 15), y=box_y + pixels(75, 33), alignment=7, tags="\\fad(130,160)\\fsp0.8", move_from=(box_x + pixels(36, 15), box_y + pixels(95, 41)), layer=2)

        # 07 — calm translucent card, rising by only a few pixels.
        elif selected_style == "glass":
            card_width = int(safe_width * 0.78)
            card_height = pixels(245, 104)
            card_x, card_y = (safe_width - card_width) // 2, int(safe_height * 0.67)
            add_panel(start, end, x=card_x, y=card_y, box_width=card_width, box_height=card_height, color=glass, alpha=86, radius=pixels(42, 18), fade_in=120, fade_out=150)
            add_rule(start, end, x=card_x + pixels(34, 14), y=card_y + pixels(35, 14), box_width=pixels(85, 36), color=teal, layer=1)
            add_event(start, end, "Card", ass_text(" ".join(words), 28), x=centre_x, y=card_y + card_height // 2 + pixels(8, 3), tags="\\fad(120,150)\\fscx96\\fscy96\\t(0,180,\\fscx100\\fscy100)", move_from=(centre_x, card_y + card_height // 2 + pixels(27, 11)), layer=2)

        # 08 — a full-width cinematic band with the quietest serif treatment.
        elif selected_style == "cinema":
            band_y = int(safe_height * 0.77)
            # The band remains flush to the frame, while its rule and text
            # follow the selected position inside it.
            add_panel(start, end, x=0, y=band_y + layout_dy, box_width=safe_width, box_height=safe_height - band_y, color=dark, alpha=48, radius=0, fade_in=180, fade_out=180, translate=False)
            add_rule(start, end, x=int(safe_width * 0.40), y=band_y + pixels(38, 16), box_width=int(safe_width * 0.20), color=gold)
            add_event(start, end, "Cinema", ass_text(" ".join(words), 25), x=centre_x, y=int(safe_height * 0.88), tags="\\fad(180,180)\\fsp1.2\\fscx96\\fscy96\\t(0,220,\\fscx100\\fscy100)", move_from=(centre_x, int(safe_height * 0.895)), layer=2)

        # 09 — a clean vertical stack: cold-white context around one large
        # lime-yellow focus word.  It deliberately has no card or plaque.
        elif selected_style == "kinetic_lime":
            stack_x = centre_x
            stack_alignment = 2
            if selected_position == "bottom_left":
                # Keep side stacks compact and aligned to their nearby frame
                # edge.  ``add_event`` applies layout_dx afterwards.
                stack_x = int(safe_width * 0.07) - layout_dx
                stack_alignment = 7
            elif selected_position == "bottom_right":
                stack_x = int(safe_width * 0.93) - layout_dx
                stack_alignment = 9
            stack_y = lower_anchor
            for group_start, group_end, group in estimated_groups(words, start, end):
                group_accent = caption_accent_index(group)
                before = ass_text(" ".join(group[:group_accent]), 19).upper()
                focus = ass_text(group[group_accent], 16).upper()
                after = ass_text(" ".join(group[group_accent + 1:]), 19).upper()
                if not focus:
                    continue
                if before:
                    add_event(
                        group_start, group_end, "KineticGhost", before,
                        x=stack_x, y=stack_y - pixels(90, 36), alignment=stack_alignment,
                        tags="\\fad(120,150)\\blur0.18\\fscx96\\fscy96\\t(0,160,\\fscx100\\fscy100)",
                        move_from=(stack_x, stack_y - pixels(76, 30)), layer=2,
                    )
                add_event(
                    group_start, group_end, "KineticLime", focus,
                    x=stack_x, y=stack_y, alignment=stack_alignment,
                    tags="\\fad(90,130)\\blur0.15\\fscx78\\fscy78\\t(0,170,\\fscx100\\fscy100)",
                    move_from=(stack_x, stack_y + pixels(18, 7)), layer=3,
                )
                if after:
                    add_event(
                        group_start, group_end, "KineticGhost", after,
                        x=stack_x, y=stack_y + pixels(88, 35), alignment=stack_alignment,
                        tags="\\fad(130,150)\\blur0.18\\fscx96\\fscy96\\t(0,160,\\fscx100\\fscy100)",
                        move_from=(stack_x, stack_y + pixels(104, 41)), layer=2,
                    )

        # 10 — Mixkit Quick Type reference.  The text block never moves;
        # only the newly typed characters receive a tiny key-press lift.
        elif selected_style == "quick_type":
            type_x = centre_x
            type_alignment = 2
            if selected_position == "bottom_left":
                type_x = int(safe_width * 0.07) - layout_dx
                type_alignment = 7
            elif selected_position == "bottom_right":
                type_x = int(safe_width * 0.93) - layout_dx
                type_alignment = 9
            # Keep the recognised wording and casing exactly as spoken.  The
            # caret is drawn directly at the current typing front rather than
            # as a trailing underscore; it never blinks by replacing the
            # whole line, which was the source of the flicker.
            spoken_title = " ".join(words).strip()
            if not spoken_title:
                continue

            # Calculate every line from the complete phrase before the first
            # letter appears.  Using a top-aligned reserved block means the
            # first line never jumps up when a second line starts typing.
            title_lines = quick_type_title_lines(spoken_title)
            raw_title = "\n".join(title_lines)

            def quick_type_text(value: str) -> str:
                # ``ass_escape`` intentionally normalises whitespace for a
                # normal caption, but a typewriter slices a phrase at an
                # arbitrary character.  Calling it on a fresh chunk beginning
                # with a space turns ``" word"`` into ``"word"``.  Worse,
                # libass ignores a normal space immediately after an override
                # block.  Preserve every timed space as ASS's hard-space so a
                # word boundary is never swallowed when the following batch
                # is introduced after the press tag.
                return (
                    str(value)
                    .replace("\\", "\\\\")
                    .replace("{", "\\{")
                    .replace("}", "\\}")
                    .replace("\r", "")
                    .replace("\n", "\\N")
                    .replace("\t", "\\h")
                    .replace(" ", "\\h")
                )

            full_title = quick_type_text(raw_title)
            type_y = lower_anchor - pixels(84, 32) * len(title_lines)
            if type_alignment == 2:
                type_alignment = 8

            # Very short SRT cues cannot fit reliable character frames.  They
            # get a clean, stable line instead of skipped ASS events.
            plan = quick_type_plan(start, end, len(raw_title), quick_type_speed_value)
            if not plan:
                # Keep the template cursor on static fallback cues too.  This
                # makes very short captions look like the animated treatment
                # instead of unexpectedly losing their final typing marker.
                static_cursor = "{\\rQuickType\\bord0\\shad0\\alpha&H00&}_{\\rQuickType}"
                add_event(
                    start, end, "QuickType", full_title + static_cursor,
                    x=type_x, y=type_y, alignment=type_alignment, layer=3,
                )
                continue

            previous_count = 0
            for step_index, (step_start, step_end, visible_count) in enumerate(plan):
                # Never emit a dedicated frame for just the hidden line break.
                while visible_count < len(raw_title) and raw_title[visible_count - 1] == "\n":
                    visible_count += 1
                # A trailing space has no visible glyph, so putting the cursor
                # after it makes the template underscore look detached from
                # the last word (``word _``).  Defer it to the following
                # batch, where it becomes the hard-space before the next
                # letters (``word\hnext_``).  The sound schedule remains
                # deliberately unchanged and tied to speech timing.
                if (
                    previous_count < visible_count < len(raw_title)
                    and raw_title[visible_count - 1] == " "
                ):
                    visible_count -= 1
                existing = quick_type_text(raw_title[:previous_count].rstrip("\n"))
                fresh = quick_type_text(raw_title[previous_count:visible_count])
                # The Quick Type reference is centred, but its text layer
                # reserves the width of the whole sentence.  Without this
                # transparent suffix every new ASS event is re-centred around
                # a *shorter* string: the already typed words slide left and
                # the cursor looks as if it has fallen behind.  Keeping the
                # remaining characters invisible locks one stable left edge
                # while the cursor naturally travels ahead of the letters.
                remaining = quick_type_text(raw_title[visible_count:])
                press_ms = max(45, min(100, int((step_end - step_start) * 850)))
                # Match the supplied Mixkit composition: its expression is
                # ``substr(0, src) + \"_\"``.  The underscore is part of the
                # same text run as the letters, so it always sits exactly at
                # the live typing edge.  It is never a separately positioned
                # object that can lag one update behind the text.
                cursor = "{\\rQuickType\\bord0\\shad0\\alpha&H00&}_{\\rQuickType}"
                hidden = "{\\rQuickType\\alpha&HFF&\\bord0\\shad0}"
                if fresh:
                    # Only the new letters have a short, gentle press.  Keep
                    # their horizontal scale fixed: changing it temporarily
                    # leaves a visual gap before the cursor.
                    press = (
                        f"{{\\alpha&H44&\\fscy93\\t(0,{press_ms},"
                        "\\alpha&H00&\\fscy100)}"
                    )
                    visible = existing + press + fresh
                else:
                    visible = existing
                # Keep the cursor visible even for the final short hold, as
                # the original template does.  The transparent remainder is
                # still drawn after it to reserve the final text geometry.
                visible += cursor + hidden + remaining + "{\\rQuickType}"
                add_event(
                    step_start, step_end, "QuickType", visible,
                    x=type_x, y=type_y, alignment=type_alignment, layer=3,
                )
                previous_count = visible_count

    ass_path.write_text("\n".join(rows) + "\n", encoding="utf-8")
    return len(cues)

def remove_artifacts(workdir: Path) -> None:
    """Remove incomplete media while preserving ffmpeg.log for diagnostics."""
    for name in (
        "result.partial.mp4", "result.mp4", "subtitles.srt", "subtitles.json", "captions.ass", "speech.wav",
        "typing.wav", "result.typing.partial.mp4", "cover.partial.jpg", "cover.jpg", "audio.partial.mp3", "audio.mp3",
        "subtitles.words.vtt", "rendered.mp4", "keys.wav",
    ):
        try:
            (workdir / name).unlink(missing_ok=True)
        except OSError:
            pass


def render_command(
    source: Path,
    destination: Path,
    video_filter: list[str],
    audio_filter: list[str],
    crf: str,
    include_audio: bool,
    trim_start: float = 0.0,
    trim_end: float | None = None,
    caption_ass: Path | None = None,
) -> list[str]:
    command = ["ffmpeg", "-hide_banner", "-nostdin", "-y"]
    if trim_start > TRIM_EPSILON_SECONDS:
        # Input seeking keeps a long source responsive.  Because we re-encode
        # below, FFmpeg decodes from the keyframe and emits an accurate cut.
        command += ["-ss", ffmpeg_seconds(trim_start)]
    command += ["-i", str(source)]
    if trim_end is not None:
        trim_duration = trim_end - trim_start
        if trim_duration < MIN_TRIM_SECONDS:
            raise ReelLabError("Конец фрагмента должен быть позже начала хотя бы на 0,1 секунды.")
        # This is an output option, so both video and the selected audio track
        # end together.  No trim options are emitted for the default full clip.
        command += ["-t", ffmpeg_seconds(trim_duration)]
    command += ["-map", "0:v:0"]
    if include_audio:
        # Keep the primary track only. MP3 and Telegram exports expect one
        # audio stream, while source files commonly include commentary tracks.
        command += ["-map", "0:a:0?"]
    else:
        command.append("-an")
    filters = list(video_filter)
    if caption_ass is not None:
        # The ASS file is generated by this worker in ``cwd`` under a fixed
        # name.  It is never derived from a filename supplied by the user.
        filters.append("ass=filename='captions.ass'")
    if filters:
        command += ["-vf", ",".join(filters)]
    if include_audio and audio_filter:
        command += ["-af", ",".join(audio_filter)]
    command += [
        "-c:v", "libx264", "-preset", "medium", "-crf", crf, "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(destination),
    ]
    return command


def mix_typing_sound_track(job_id: str, video: Path, track: Path, destination: Path) -> None:
    """Mix a generated keyboard track into an already rendered local video."""
    rendered = probe(video)
    command = ["ffmpeg", "-hide_banner", "-nostdin", "-y", "-i", str(video), "-i", str(track)]
    if rendered["has_audio"]:
        filter_complex = (
            "[0:a:0]aresample=48000,aformat=channel_layouts=stereo[voice];"
            "[1:a:0]aresample=48000,aformat=channel_layouts=stereo[keys];"
            "[voice][keys]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,"
            "alimiter=limit=0.95[mixed]"
        )
        command += [
            "-filter_complex", filter_complex,
            "-map", "0:v:0", "-map", "[mixed]",
        ]
    else:
        # Imported subtitles can be used with silent source footage.  Keep the
        # keyboard layer alive until the video ends so the export still plays.
        filter_complex = (
            "[1:a:0]aresample=48000,aformat=channel_layouts=stereo,apad,"
            "alimiter=limit=0.95[keys]"
        )
        command += [
            "-filter_complex", filter_complex,
            "-map", "0:v:0", "-map", "[keys]", "-shortest",
        ]
    command += [
        "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart", str(destination),
    ]
    run_job_command(job_id, command, cwd=video.parent)


def render_job(job_id: str) -> None:
    row = fetch_job(job_id)
    upload = fetch_upload(row["upload_id"])
    source = Path(upload["path"])
    settings = load(row["settings"], dict(DEFAULT_SETTINGS))
    workdir = JOBS / job_id
    workdir.mkdir(parents=True, exist_ok=True)
    output, partial_output = workdir / "result.mp4", workdir / "result.partial.mp4"
    subtitle, cover, partial_cover = workdir / "subtitles.srt", workdir / "cover.jpg", workdir / "cover.partial.jpg"
    audio, partial_audio = workdir / "audio.mp3", workdir / "audio.partial.mp3"
    warnings: list[str] = []
    if not source.exists():
        raise ReelLabError("Исходное видео больше не найдено на диске.", 500)
    if cancellation_requested(job_id):
        raise JobCancelled()

    remove_artifacts(workdir)
    update_job(job_id, status="running", phase="VALIDATING", progress_percent=8, error=None)
    source_info = probe(source)
    if source_info["duration"] > MAX_SECONDS:
        raise ReelLabError("Видео длиннее установленного лимита.")
    source_duration = float(source_info["duration"])
    trim_start, trim_end = trim_range(settings, source_duration)
    trim_applied = (
        trim_start > TRIM_EPSILON_SECONDS
        or source_duration - trim_end > TRIM_EPSILON_SECONDS
    )
    # Passing None keeps full-source jobs byte-for-byte on the established
    # FFmpeg command path; only an actual user range adds -ss/-t.
    ffmpeg_trim_end = trim_end if trim_applied else None
    caption_ass: Path | None = None
    typing_sound_track: Path | None = None
    captions_requested = bool(settings.get("caption_enabled", True))
    if captions_requested:
        imported_caption_id = settings.get("caption_id")
        if imported_caption_id:
            if not isinstance(imported_caption_id, str):
                raise ReelLabError("Некорректный файл субтитров.")
            imported = fetch_caption(imported_caption_id)
            imported_path = Path(imported["path"])
            if not imported_path.exists():
                raise ReelLabError("Загруженный файл субтитров больше не найден.", 500)
            imported_cues = read_srt_cues(imported_path)
            if not imported_cues:
                raise ReelLabError("В загруженном файле нет подходящих субтитров.", 400)
            write_srt_cues(subtitle, imported_cues)
            warnings.append(f"Использован готовый файл субтитров: {imported['name']}.")
            update_job(job_id, phase="SUBTITLES_READY", progress_percent=63, error=None)
        else:
            if not source_info["has_audio"]:
                raise ReelLabError("В выбранном ролике нет звука, поэтому субтитры создать нельзя.")

            def subtitle_progress(phase: str, percent: int, _message: str) -> None:
                # The local recognizer reports its own tiny steps.  Map them to
                # the simple progress scale shown by the bot.
                if phase == "TRANSCRIBING":
                    mapped = 38
                elif phase == "SUBTITLES_READY":
                    mapped = 63
                else:
                    mapped = max(20, min(63, int(percent)))
                update_job(job_id, phase=phase, progress_percent=mapped, error=None)

            update_job(job_id, phase="TRANSCRIBING", progress_percent=20, error=None)
            try:
                transcription = transcribe_video(source, workdir, callback=subtitle_progress, language="ru")
            except GigaAMError as exc:
                raise ReelLabError(str(exc), 500, "subtitle_failed") from exc
            if cancellation_requested(job_id):
                raise JobCancelled()
            warnings.extend(transcription.warnings)
        if trim_applied:
            trim_caption_cues(subtitle, trim_start, trim_end)
        target_size = target_dimensions(settings.get("output_resolution"))
        caption_width, caption_height = target_size or (int(source_info["width"]), int(source_info["height"]))
        if write_caption_ass(
            subtitle,
            workdir / "captions.ass",
            settings.get("caption_style", "luxe"),
            caption_width,
            caption_height,
            settings.get("caption_position", "bottom_center"),
            settings.get("caption_color"),
            settings.get("quick_type_speed", "soft"),
        ):
            caption_ass = workdir / "captions.ass"
            if (
                str(settings.get("caption_style", "")) == "quick_type"
                and typing_sound_enabled(settings.get("typing_sound_enabled", False))
            ):
                try:
                    press_count = write_typing_sound_track(
                        workdir / "typing.wav",
                        read_srt_cues(subtitle),
                        settings.get("quick_type_speed", "soft"),
                        settings.get("typing_sound_volume", 35),
                        settings.get("typing_sound_preset", "iphone_keyboard"),
                    )
                    if press_count:
                        typing_sound_track = workdir / "typing.wav"
                except OSError:
                    warnings.append("Не удалось подготовить звук клавиатуры: ролик будет без него.")
        else:
            warnings.append("Речь не распознана: видео сохранено без вшитых субтитров.")
    else:
        subtitle.write_text("", encoding="utf-8")
        warnings.append("Субтитры выключены для этой версии ролика.")

    update_job(job_id, phase="PREPROCESSING", progress_percent=66)

    vf = video_filters(settings)
    af = audio_filters(settings) if source_info["has_audio"] else []
    if not source_info["has_audio"]:
        warnings.append("В исходнике нет звуковой дорожки: очистка голоса и MP3 пропущены.")

    update_job(job_id, phase="BURNING_CAPTIONS" if caption_ass else "RENDERING", progress_percent=74)
    crf = {"compact": "25", "balanced": "21", "high": "18"}.get(str(settings.get("video_quality")), "18")
    try:
        run_job_command(
            job_id,
            render_command(
                source, partial_output, vf, af, crf, bool(source_info["has_audio"]),
                trim_start=trim_start, trim_end=ffmpeg_trim_end, caption_ass=caption_ass,
            ),
            cwd=workdir,
        )
    except JobCancelled:
        raise
    except ReelLabError as exc:
        # A bad or undecodable audio stream should not discard a usable video.
        # Retry once without audio only for an ordinary FFmpeg encode failure.
        if not source_info["has_audio"] or exc.code != "ffmpeg_failed":
            raise
        partial_output.unlink(missing_ok=True)
        warnings.append("Аудиодорожку не удалось обработать: готовим версию видео без звука.")
        run_job_command(
            job_id,
            render_command(
                source, partial_output, vf, [], crf, False,
                trim_start=trim_start, trim_end=ffmpeg_trim_end, caption_ass=caption_ass,
            ),
            cwd=workdir,
        )
    if typing_sound_track is not None and typing_sound_track.exists():
        typing_output = workdir / "result.typing.partial.mp4"
        try:
            mix_typing_sound_track(job_id, partial_output, typing_sound_track, typing_output)
            if typing_output.exists():
                os.replace(typing_output, partial_output)
        except JobCancelled:
            raise
        except ReelLabError:
            typing_output.unlink(missing_ok=True)
            warnings.append("Не удалось добавить звук клавиатуры: ролик сохранён без него.")
    if cancellation_requested(job_id):
        raise JobCancelled()

    update_job(job_id, phase="VERIFYING", progress_percent=87)
    result_info = probe(partial_output)
    os.replace(partial_output, output)
    try:
        run_job_command(job_id, [
            "ffmpeg", "-hide_banner", "-nostdin", "-y", "-ss", "0.5", "-i", str(output),
            "-frames:v", "1", "-q:v", "2", str(partial_cover),
        ])
        if partial_cover.exists():
            os.replace(partial_cover, cover)
    except JobCancelled:
        raise
    except ReelLabError:
        partial_cover.unlink(missing_ok=True)
        warnings.append("Не удалось создать отдельную обложку.")

    if result_info["has_audio"] and settings.get("export_audio", True):
        update_job(job_id, phase="EXPORTING", progress_percent=94)
        try:
            run_job_command(job_id, [
                "ffmpeg", "-hide_banner", "-nostdin", "-y", "-i", str(output),
                "-map", "0:a:0?", "-vn", "-c:a", "libmp3lame", "-q:a", "2", str(partial_audio),
            ])
            if partial_audio.exists():
                os.replace(partial_audio, audio)
        except JobCancelled:
            raise
        except ReelLabError:
            partial_audio.unlink(missing_ok=True)
            warnings.append("MP3 не удалось создать, но видео готово.")
    elif not result_info["has_audio"] and source_info["has_audio"]:
        warnings.append("В итоговой версии нет обрабатываемой аудиодорожки: MP3 пропущен.")

    if not complete_job(
        job_id, status="completed", phase="COMPLETED", progress_percent=100,
        output_path=str(output), subtitle_path=str(subtitle),
        cover_path=str(cover) if cover.exists() else None,
        audio_path=str(audio) if audio.exists() else None,
        duration=float(result_info["duration"]),
        removed_seconds=max(0, float(source_info["duration"]) - float(result_info["duration"])),
        warnings=dump(warnings), error=None,
    ):
        raise JobCancelled()


def transcribe_job(job_id: str) -> None:
    """Create only an SRT for the browser template renderer.

    This deliberately stops before ASS/FFmpeg rendering.  The ready-made CSS
    templates are rendered by the browser/WebCodecs engine, while this worker
    supplies it with the same local GigaAM transcript used by ordinary jobs.
    """
    row = fetch_job(job_id)
    upload = fetch_upload(row["upload_id"])
    source = Path(upload["path"])
    workdir = JOBS / job_id
    workdir.mkdir(parents=True, exist_ok=True)
    subtitle = workdir / "subtitles.srt"
    if not source.exists():
        raise ReelLabError("Исходное видео больше не найдено на диске.", 500)
    if cancellation_requested(job_id):
        raise JobCancelled()

    remove_artifacts(workdir)
    update_job(job_id, status="running", phase="VALIDATING", progress_percent=8, error=None)
    source_info = probe(source)
    if not source_info["has_audio"]:
        raise ReelLabError("В выбранном ролике нет звука, поэтому субтитры создать нельзя.")

    def subtitle_progress(phase: str, percent: int, _message: str) -> None:
        if cancellation_requested(job_id):
            raise JobCancelled()
        if phase == "TRANSCRIBING":
            mapped = 45
        elif phase == "SUBTITLES_READY":
            mapped = 92
        else:
            mapped = max(15, min(92, int(percent)))
        update_job(job_id, phase=phase, progress_percent=mapped, error=None)

    settings = load(row["settings"], {})
    language = str(settings.get("language") or "ru").strip().lower()
    music = bool(settings.get("music"))  # слова из музыки (нашид): без фильтра голоса
    if language not in ("ru", "auto") and SERVER_MODE and speech_local.available():
        # Сервер: Whisper прямо на процессоре сервера — бесплатно и без облаков.
        update_job(job_id, phase="CLOUD_TRANSCRIBING", progress_percent=12, error=None)
        try:
            transcription = speech_local.transcribe_local(source, workdir, language, callback=subtitle_progress, music=music)
        except SpeechError as exc:
            raise ReelLabError(str(exc), 422, "subtitle_failed") from exc
    elif language not in ("ru", "auto"):
        # Не русская речь: Whisper в Cloudflare пишет текст сразу на языке речи.
        client = pictures_service.cloudflare()
        if client is None and SERVER_MODE:
            raise ReelLabError("Распознавание этого языка на сервере ещё не настроено. Напиши в поддержку.",
                               503, "asr_unavailable")
        if client is None:
            raise ReelLabError("Для распознавания этого языка нужен ИИ: подключи ключ Cloudflare "
                               "(кнопка «ИИ» вверху студии). Русский язык распознаётся и без него.",
                               422, "ai_key_required")
        update_job(job_id, phase="CLOUD_TRANSCRIBING", progress_percent=15, error=None)
        try:
            transcription = transcribe_cloud(source, workdir, client, language, callback=subtitle_progress, music=music)
        except SpeechError as exc:
            raise ReelLabError(str(exc), 422, "subtitle_failed") from exc
        except AiError as exc:
            raise ReelLabError(exc.message, exc.status, exc.code) from exc
    else:
        update_job(job_id, phase="TRANSCRIBING", progress_percent=15, error=None)
        try:
            transcription = transcribe_video(source, workdir, callback=subtitle_progress, language="ru")
        except GigaAMError as exc:
            raise ReelLabError(str(exc), 500, "subtitle_failed") from exc
    if cancellation_requested(job_id):
        raise JobCancelled()
    cues = read_srt_cues(transcription.srt_path)
    if not cues:
        raise ReelLabError("Речь не распознана. Попробуйте ролик с более чистым звуком.", 422, "empty_transcript")
    # Canonicalise the engine's SRT just as imported caption files are
    # canonicalised; the browser renderer receives plain, safe cue text.
    write_srt_cues(subtitle, cues)
    if not complete_job(
        job_id, status="completed", phase="COMPLETED", progress_percent=100,
        output_path=None, subtitle_path=str(subtitle), cover_path=None, audio_path=None,
        duration=float(source_info["duration"]), removed_seconds=0.0,
        warnings=dump(list(transcription.warnings)), error=None,
    ):
        raise JobCancelled()


# --- Серверная сборка роликов со стилем -------------------------------------
#
# Reel Lab открывает static/ready-captions/render.html в Chrome или Edge без
# экрана. Страница собирает ролик тем же движком, что и окно мастерской,
# и возвращает результат сюда; FFmpeg добавляет голос и звук клавиш.

render_tokens: dict[str, str] = {}
render_sources: dict[str, Path] = {}
render_results: dict[str, Path] = {}
render_failures: dict[str, str] = {}
render_labels: dict[str, str] = {}

_BROWSER_CANDIDATES = (
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
)


def find_render_browser() -> str | None:
    configured = os.environ.get("REELLAB_BROWSER", "").strip()
    if configured and Path(configured).is_file():
        return configured
    for candidate in _BROWSER_CANDIDATES:
        if Path(candidate).is_file():
            return candidate
    for name in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"):
        found = shutil.which(name)
        if found:
            return found
    return None


def style_render_job(job_id: str) -> None:
    row = fetch_job(job_id)
    upload = fetch_upload(row["upload_id"])
    source = Path(upload["path"])
    settings = load(row["settings"], {})
    if not source.exists():
        raise ReelLabError("Исходное видео больше не найдено на диске.", 500)
    workdir = JOBS / job_id
    workdir.mkdir(parents=True, exist_ok=True)
    remove_artifacts(workdir)
    if SERVER_MODE:
        update_job(job_id, status="running", phase="PREPARING", progress_percent=1, error=None)
        render_labels[job_id] = "Готовлю видео…"
        source = ensure_render_source(upload)
        if source != Path(upload["path"]):
            render_sources[job_id] = source
    browser = find_render_browser()
    if not browser:
        raise ReelLabError("Для сборки на сервере нужен Chrome или Edge. Укажите путь в REELLAB_BROWSER.", 500)
    style_spec = settings.get("style_spec") if isinstance(settings.get("style_spec"), dict) else {}
    spec_edit = style_spec.get("edit") if isinstance(style_spec.get("edit"), dict) else {}
    enhance = normalise_enhance(spec_edit.get("enhance"))
    montage = normalise_montage(style_spec.get("montage"), float(upload["duration"] or 0))
    if any(enhance.values()) or montage:
        update_job(job_id, status="running", phase="ENHANCING", progress_percent=2, error=None)
        render_labels[job_id] = "Склеиваю вставки…" if montage else "Улучшаю видео…"
        voice_settings = dict(spec_edit.get("voice")) if isinstance(spec_edit.get("voice"), dict) else {}
        voice_settings["gain"] = clamp_gain(style_spec.get("voiceGain"), 1.0)
        render_sources[job_id] = prepare_source(source, bool(upload["has_audio"]), enhance, montage, voice_settings)
    origin = str(settings.get("render_origin") or "http://127.0.0.1:8765").rstrip("/")
    token = secrets.token_urlsafe(24)
    render_tokens[job_id] = token
    render_results.pop(job_id, None)
    render_failures.pop(job_id, None)
    update_job(job_id, status="running", phase="RENDERING", progress_percent=3, error=None)
    profile = workdir / "browser-profile"
    url = f"{origin}/ready-captions/render.html?job={job_id}&token={token}"
    command = [
        browser, "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-extensions",
        "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
        # Без фоновых служб Chrome: обновления, перевод, синхронизация — сборщику не нужны.
        "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-default-apps",
        "--disable-domain-reliability", "--metrics-recording-only", "--no-pings",
        "--disable-features=Translate,OptimizationHints,MediaRouter,AutofillServerCommunication",
        "--autoplay-policy=no-user-gesture-required", "--mute-audio", f"--user-data-dir={profile}", url,
    ]
    if os.name != "nt" and hasattr(os, "geteuid") and os.geteuid() == 0:
        command.insert(1, "--no-sandbox")
    elif SERVER_MODE and os.name != "nt":
        # Сервер: страница сборки — своя, доверенная; песочница Chrome на Ubuntu 24.04 мешает
        # (ограничение user namespaces в AppArmor), поэтому без неё.
        command.insert(1, "--no-sandbox")
    if SERVER_MODE:
        command[1:1] = ["--disable-dev-shm-usage", "--enable-unsafe-swiftshader"]
    log_path = workdir / "browser.log"
    duration = float(upload["duration"] or 60)
    deadline = time.time() + max(900.0, duration * 8 + 600)
    with log_path.open("w", encoding="utf-8", errors="replace") as log:
        process = subprocess.Popen(command, stdout=log, stderr=log,
                                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        with process_lock:
            processes[job_id] = process
        try:
            while True:
                if job_id in render_results:
                    break
                if job_id in render_failures:
                    raise ReelLabError(f"Сборка не удалась: {render_failures[job_id]}", 500, "render_failed")
                if cancellation_requested(job_id):
                    raise JobCancelled()
                if process.poll() is not None:
                    raise ReelLabError("Браузер-сборщик неожиданно закрылся. Подробности в browser.log.", 500)
                if time.time() > deadline:
                    raise ReelLabError("Сборка заняла слишком много времени.", 500)
                time.sleep(0.5)
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
            with process_lock:
                processes.pop(job_id, None)
            render_tokens.pop(job_id, None)
            render_labels.pop(job_id, None)
            render_sources.pop(job_id, None)
            shutil.rmtree(profile, ignore_errors=True)

    rendered = render_results.pop(job_id)
    sfx_path = workdir / "keys.wav"
    update_job(job_id, phase="MIXING", progress_percent=95)
    result_path = workdir / "result.mp4"
    spec = settings.get("style_spec") or {}
    edit = spec.get("edit") if isinstance(spec, dict) and isinstance(spec.get("edit"), dict) else {}
    has_cuts = bool(edit.get("skip"))
    # Со вставками голос уже собран и очищен при склейке: берётся из готового ролика как есть.
    speech = source if bool(upload["has_audio"]) and not has_cuts and not montage else rendered
    speech_gain = 1.0 if montage else clamp_gain(spec.get("voiceGain") if isinstance(spec, dict) else None, 1.0)
    voice = edit.get("voice") if isinstance(edit.get("voice"), dict) and not montage else {}
    mix_keys_into_video(rendered, sfx_path if sfx_path.is_file() else None, speech, 1.0, result_path, speech_gain, voice)
    rendered.unlink(missing_ok=True)
    if not complete_job(
        job_id, status="completed", phase="COMPLETED", progress_percent=100,
        output_path=str(result_path), duration=duration, error=None,
    ):
        raise JobCancelled()


def _render_job_for_token(job_id: str) -> sqlite3.Row:
    expected = render_tokens.get(job_id)
    if not expected or not secrets.compare_digest(expected, request.args.get("token", "")):
        raise ReelLabError("Задание сборки недоступно.", 403)
    return fetch_job(job_id)


def worker(job_id: str) -> None:
    workdir = JOBS / job_id
    try:
        _run_worker(job_id, workdir)
    finally:
        if SERVER_MODE:
            after_job(job_id)


def _run_worker(job_id: str, workdir: Path) -> None:
    try:
        job = fetch_job(job_id)
        if job["cancel_requested"] or job["status"] in ("cancelled", "cancelling"):
            raise JobCancelled()
        if job["kind"] == "transcription":
            transcribe_job(job_id)
        elif job["kind"] == "style_render":
            style_render_job(job_id)
        else:
            render_job(job_id)
    except JobCancelled:
        remove_artifacts(workdir)
        update_job(job_id, status="cancelled", phase="CANCELLED", progress_percent=0, error=None)
    except ReelLabError as exc:
        remove_artifacts(workdir)
        update_job(job_id, status="failed", phase="FAILED", progress_percent=0, error=exc.message)
    except Exception:
        remove_artifacts(workdir)
        update_job(job_id, status="failed", phase="FAILED", progress_percent=0,
                   error="Непредвиденная ошибка обработки. Проверьте FFmpeg и повторите запуск.")


def list_user_jobs(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    if SERVER_MODE:
        return conn.execute("SELECT * FROM jobs WHERE user_id=? ORDER BY created DESC LIMIT 30",
                            (current_user_id(),)).fetchall()
    return conn.execute("SELECT * FROM jobs ORDER BY created DESC LIMIT 300").fetchall()


def job_priority(user_id: int) -> int:
    """0 — владелец, 1 — платный тариф, 2 — бесплатный."""
    if not SERVER_MODE or accounts is None:
        return 1
    if accounts.is_admin(user_id):
        return 0
    try:
        return 2 if accounts.status(user_id)["plan"] == "free" else 1
    except AccountsError:
        return 2


def submit_job(job_id: str, kind: str, owner: int) -> None:
    if scheduler is not None:
        scheduler.submit(job_id, kind, job_priority(owner))
    else:
        executor.submit(worker, job_id)


def create_job(
    upload_id: str,
    settings: dict[str, Any],
    request_id: str | None,
    parent_id: str | None = None,
    *,
    kind: str = "render",
    reserve: Any = None,
    finalize: Any = None,
) -> sqlite3.Row:
    if kind not in {"render", "transcription", "style_render"}:
        raise ReelLabError("Неизвестный тип задачи.")
    upload = fetch_upload(upload_id)
    owner = current_user_id()
    if request_id and SERVER_MODE:
        request_id = f"{owner}:{request_id}"[:120]
    if request_id:
        with database() as conn:
            found = conn.execute("SELECT * FROM jobs WHERE request_id=?", (request_id,)).fetchone()
        if found:
            return found
    combined = dict(DEFAULT_SETTINGS)
    combined.update(settings)
    caption_id = combined.get("caption_id")
    if caption_id not in (None, ""):
        if not isinstance(caption_id, str):
            raise ReelLabError("Некорректный файл субтитров.")
        fetch_caption(caption_id)
    elif caption_id == "":
        combined.pop("caption_id", None)
    # Store a canonical range with the job.  The original upload is never
    # touched; each job can select a different segment non-destructively.
    combined = normalize_trim_settings(combined, float(upload["duration"]))
    job_id, stamp = identifier(), now()
    reservation = reserve(job_id) if reserve is not None else None
    if reservation is not None and finalize is not None:
        combined = finalize(combined, reservation)
    try:
        with lock, database() as conn:
            conn.execute(
                """INSERT INTO jobs(id,request_id,upload_id,parent_id,name,kind,status,phase,
                   progress_percent,settings,created,updated,user_id)
                   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (job_id, request_id, upload["id"], parent_id, upload["name"], kind, "queued", "QUEUED",
                 0, dump(combined), stamp, stamp, owner),
            )
            row = conn.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
    except BaseException:
        if reservation is not None and accounts is not None:
            accounts.finish_render(job_id, False)
        raise
    with lock, database() as conn:
        conn.execute("UPDATE uploads SET last_used=? WHERE id=?", (stamp, upload["id"]))
    submit_job(job_id, kind, owner)
    return row


def usage_data() -> dict[str, Any]:
    with database() as conn:
        jobs_24h = conn.execute("SELECT COUNT(*) n FROM jobs WHERE created>=?", (now() - 86400,)).fetchone()["n"]
        active = conn.execute("SELECT COUNT(*) n FROM jobs WHERE status IN ('queued','running','cancelling')").fetchone()["n"]
        bytes_used = conn.execute("SELECT COALESCE(SUM(size_bytes),0) n FROM uploads").fetchone()["n"]
    return {
        "jobs_24h": int(jobs_24h), "daily_limit": None, "active": int(active),
        "storage_bytes": int(bytes_used), "storage_limit": MAX_BYTES * 5,
    }


# --- Вход ------------------------------------------------------------------
# На сервере каждый запрос к API несёт сессию: заголовок X-Reel-Session (его
# ставит студия) или cookie (нужна тегам <video>/<audio>, которые заголовки
# не умеют). Служебные маршруты сборщика и оплаты проверяют свои ключи сами.

_OPEN_PATHS = {"/api/health", "/api/session", "/api/public/config"}
_OPEN_PREFIXES = ("/api/render-jobs/", "/api/downloads/", "/api/pictures/file/", "/api/billing/robokassa/",
                  "/tg/")
_SERVER_BLOCKED_PREFIXES = ("/test-media/",)
# Только для локальной студии: сборка в браузере, старый интерфейс, правка библиотеки звуков.
_LOCAL_ONLY_ROUTES = {
    ("POST", "/api/finish-video"), ("POST", "/api/edit/prepare"), ("POST", "/api/jobs"), ("POST", "/api/draft"),
    ("POST", "/api/sounds/curation"), ("POST", "/api/ai/settings"), ("DELETE", "/api/ai/settings"),
}


# В серверном режиме открыт только тот API, которым пользуется студия в Telegram (и сборка в Chrome
# на сервере). Маршруты старого интерфейса — повтор и пересборка заданий без оплаты, общая статистика,
# старый предпросмотр — закрыты: они обходили бы тарифы и водяной знак.
_SERVER_API = [(frozenset(methods.split("|")), re.compile(pattern + r"\Z")) for methods, pattern in (
    ("POST", r"/api/session"), ("GET", r"/api/me"), ("GET", r"/api/public/config"), ("GET", r"/api/health"),
    ("GET", r"/api/upload-session"),
    ("POST", r"/api/uploads"), ("POST", r"/api/uploads/chunked"), ("GET|PUT", r"/api/uploads/chunked/[A-Za-z0-9_-]+"),
    ("POST", r"/api/uploads/chunked/[A-Za-z0-9_-]+/finish"), ("POST", r"/api/uploads/[A-Za-z0-9_-]+/transcription"),
    ("POST", r"/api/montage/transcription"),
    ("GET", r"/api/uploads/[A-Za-z0-9_-]+/file"), ("GET", r"/api/uploads/[A-Za-z0-9_-]+"),
    ("POST", r"/api/assistant/analyses"), ("GET", r"/api/assistant/analyses/[A-Za-z0-9_-]+"),
    ("POST", r"/api/assistant/ask"),
    ("GET", r"/api/projects"), ("GET|PUT|DELETE", r"/api/projects/[a-z0-9]{12,40}"),
    ("POST", r"/api/sounds/own/[A-Za-z0-9_-]+/transcription"),
    ("GET", r"/api/jobs"), ("POST", r"/api/jobs/[A-Za-z0-9_-]+/(?:cancel|download)"),
    ("GET", r"/api/jobs/[A-Za-z0-9_-]+/(?:video|subtitles)"),
    ("POST", r"/api/render-jobs"), ("GET", r"/api/render-jobs/[A-Za-z0-9_-]+/(?:source|spec|own-sounds)"),
    ("GET", r"/api/render-jobs/[A-Za-z0-9_-]+/own/[A-Za-z0-9_-]+/[A-Za-z0-9_.-]+"),
    ("POST", r"/api/render-jobs/[A-Za-z0-9_-]+/(?:progress|result|failed)"),
    ("GET", r"/api/downloads/[A-Za-z0-9_-]+"),
    ("GET", r"/api/ai/settings"), ("POST", r"/api/ai/(?:hook|moments|smartcut|translate)"),
    ("POST", r"/api/pictures/(?:generate|plan|subject|upload)"), ("GET", r"/api/pictures/file/[A-Za-z0-9_.-]+"),
    ("GET|POST", r"/api/sounds/own"), ("POST|DELETE", r"/api/sounds/own/[A-Za-z0-9_-]+"),
    ("GET", r"/api/sounds/(?:peaks|preview)"), ("POST", r"/api/sounds/sources"),
    ("GET|POST", r"/api/support"),
    ("POST", r"/api/billing/(?:stars|card)"), ("GET|POST", r"/api/billing/robokassa/result"),
)]


def server_api_allowed(method: str, path: str) -> bool:
    method = "GET" if method == "HEAD" else method
    return any(method in methods and pattern.match(path) for methods, pattern in _SERVER_API)


def _session_token() -> str:
    return (request.headers.get(SESSION_HEADER) or request.cookies.get(SESSION_COOKIE) or "").strip()


@app.before_request
def authenticate():
    if not SERVER_MODE:
        g.user_id = LOCAL_USER_ID
        return None
    path = request.path
    if path.startswith(_SERVER_BLOCKED_PREFIXES):
        return Response("Не найдено", 404)
    if (request.method, path) in _LOCAL_ONLY_ROUTES or path.startswith("/api/edit/"):
        return error("Эта функция есть только в локальной студии.", 403, "local_only")
    if path.startswith("/api/") and not server_api_allowed(request.method, path):
        app.logger.warning("Закрытый в серверном режиме маршрут: %s %s", request.method, path[:200])
        return error("Не найдено.", 404, "not_found")
    if not path.startswith("/api/") or path in _OPEN_PATHS or path.startswith(_OPEN_PREFIXES):
        if path.startswith("/sounds/own/"):
            return _authenticate_session()
        return None
    return _authenticate_session()


def _authenticate_session():
    found = accounts.resolve_session(_session_token())
    if found is None:
        return error("Нужно войти через Telegram. Закрой студию и открой её из бота.", 401, "auth_required")
    user, session_csrf = found
    if user.get("blocked"):
        return error("Доступ к студии закрыт. Напиши в поддержку бота.", 403, "blocked")
    g.user = user
    g.user_id = int(user["id"])
    g.csrf = session_csrf
    g.is_admin = accounts.is_admin(int(user["id"]))
    accounts.mark_seen(int(user["id"]))
    return None


@app.errorhandler(AccountsError)
def handle_accounts(error_value: AccountsError):
    body: dict[str, Any] = {"error": error_value.message, "code": error_value.code}
    body.update(error_value.extra)
    return jsonify(body), error_value.status


@app.errorhandler(ReelLabError)
def handle_reellab(error_value: ReelLabError):
    return error(error_value.message, error_value.status, error_value.code)


@app.errorhandler(AiError)
def handle_ai(error_value: AiError):
    return error(error_value.message, error_value.status, error_value.code)


@app.errorhandler(RequestEntityTooLarge)
def handle_large(error_value: RequestEntityTooLarge):
    return error("Файл превышает лимит загрузки.", 413)


@app.errorhandler(404)
def handle_missing(error_value):
    return error("Маршрут API не найден.", 404) if request.path.startswith("/api/") else Response("Не найдено", 404)


# ---------------------------------------------------------------------------
# Улучшение видео до наложения субтитров: стабилизация, шумодав, резкость.
# Таймлайн не меняется, поэтому субтитры, монтаж и эффекты остаются на местах.

PREPARED = DATA / "prepared"
prepare_jobs: dict[str, dict[str, Any]] = {}
_prepare_lock = threading.Lock()
_filter_cache: dict[str, bool] = {}


def ffmpeg_has_filter(name: str) -> bool:
    if name not in _filter_cache:
        result = run(["ffmpeg", "-hide_banner", "-filters"], 60)
        _filter_cache[name] = result.returncode == 0 and f" {name} " in (result.stdout or "")
    return _filter_cache[name]


def normalise_enhance(value: Any) -> dict[str, bool]:
    value = value if isinstance(value, dict) else {}
    return {key: bool(value.get(key)) for key in ("stabilize", "denoise", "sharpen")}


def prepare_enhanced(source: Path, enhance: dict[str, bool], progress=None) -> Path:
    """Готовит улучшенную копию видео (кешируется по исходнику и настройкам)."""
    source = Path(source).resolve()
    stat = source.stat()
    key = hashlib.sha1(f"{source}|{stat.st_size}|{int(stat.st_mtime)}|{json.dumps(enhance, sort_keys=True)}".encode("utf-8")).hexdigest()[:24]
    workdir = (PREPARED / key).resolve()
    result = workdir / "prepared.mp4"
    if result.is_file() and result.stat().st_size > 0:
        return result
    workdir.mkdir(parents=True, exist_ok=True)
    info = probe(source)
    duration = float(info.get("duration") or 0) or 1.0
    filters: list[str] = []
    if enhance.get("stabilize"):
        if ffmpeg_has_filter("vidstabdetect") and ffmpeg_has_filter("vidstabtransform"):
            detect = run(["ffmpeg", "-hide_banner", "-nostdin", "-y", "-i", str(source), "-vf",
                          "vidstabdetect=shakiness=6:accuracy=12:result=transforms.trf", "-f", "null", "-"],
                         FFMPEG_TIMEOUT_SECONDS, cwd=workdir)
            if detect.returncode == 0 and (workdir / "transforms.trf").is_file():
                filters.append("vidstabtransform=input=transforms.trf:smoothing=18:zoom=1.5:interpol=bicubic")
            else:
                filters.append("deshake=rx=32:ry=32:edge=mirror")
        else:
            filters.append("deshake=rx=32:ry=32:edge=mirror")
    if enhance.get("denoise"):
        filters.append("hqdn3d=2.2:1.8:4:3")
    if enhance.get("sharpen"):
        filters.append("cas=strength=0.55" if ffmpeg_has_filter("cas") else "unsharp=5:5:0.7:5:5:0.0")
    if not filters:
        return source
    filters.append("format=yuv420p")
    temp = workdir / "prepared.part.mp4"
    command = ["ffmpeg", "-hide_banner", "-nostdin", "-y", "-i", str(source), "-map", "0:v:0", "-map", "0:a?",
               "-vf", ",".join(filters), "-c:v", "libx264", "-preset", "veryfast", "-crf", "17",
               "-c:a", "copy", "-movflags", "+faststart", "-progress", "pipe:1", "-nostats", str(temp)]
    process = subprocess.Popen(command, cwd=str(workdir), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                               encoding="utf-8", errors="replace", creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    stderr_tail: list[str] = []

    def drain_stderr() -> None:
        for line in process.stderr:
            stderr_tail.append(line)
            del stderr_tail[:-40]

    threading.Thread(target=drain_stderr, daemon=True).start()
    for line in process.stdout:
        if line.startswith("out_time_ms=") and progress:
            try:
                progress(min(99.0, int(line.split("=", 1)[1]) / 1e6 / duration * 100))
            except ValueError:
                pass
    code = process.wait(timeout=FFMPEG_TIMEOUT_SECONDS)
    if code != 0 or not temp.is_file():
        raise ffmpeg_error("Не получилось улучшить видео. Попробуй ещё раз или выключи улучшение.", "".join(stderr_tail),
                           500, "enhance_failed")
    temp.replace(result)
    return result


# ---------------------------------------------------------------------------
# Монтаж: другие видео между кусками и видео поверх.
#
# Сервер склеивает «сборку» (время M): исходник со вставками и наложениями.
# Вырезанные куски остаются на месте — их пропускает движок при сборке ролика,
# как и без вставок, поэтому субтитры, звуки и эффекты стоят там же, где в
# предпросмотре. Голос (шумодав, выравнивание) обрабатывается здесь же — только
# дорожка исходника, звук вставок не трогается.

MONTAGE_FITS = {"cover", "blur"}
STANDARD_RATES = [(24000, 1001), (24, 1), (25, 1), (30000, 1001), (30, 1), (50, 1), (60000, 1001), (60, 1)]


def video_rate(path: Path) -> tuple[int, int]:
    """Частота кадров видео как дробь; дрожащая частота телефона — к ближайшей стандартной."""
    result = run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                  "stream=avg_frame_rate,r_frame_rate", "-of", "json", str(path)], 60)
    value = 0.0
    try:
        stream = (json.loads(result.stdout or "{}").get("streams") or [{}])[0]
        for key in ("avg_frame_rate", "r_frame_rate"):
            num, _, den = str(stream.get(key) or "0/0").partition("/")
            rate = float(num) / float(den or 1) if float(den or 1) else 0.0
            if 5 <= rate <= 241:
                value = rate
                break
    except (ValueError, TypeError, json.JSONDecodeError, ZeroDivisionError):
        value = 0.0
    if not value:
        return 30, 1
    best = min(STANDARD_RATES, key=lambda item: abs(item[0] / item[1] - value))
    if abs(best[0] / best[1] - value) / value < 0.03:
        return best
    return max(15, min(60, round(value))), 1


def _montage_number(value: Any, low: float, high: float, name: str) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ReelLabError(f"Монтаж: неверное значение «{name}».")
    if not math.isfinite(number) or number < low - 1e-6 or number > high + 1e-6:
        raise ReelLabError(f"Монтаж: значение «{name}» вне допустимых границ.")
    return max(low, min(high, number))


def normalise_montage(value: Any, main_duration: float) -> dict[str, Any] | None:
    """Проверяет план монтажа из студии и находит файлы вставок. None — монтажа нет."""
    if not isinstance(value, dict):
        return None
    segments_raw = value.get("segments")
    overlays_raw = value.get("overlays") or []
    if not isinstance(segments_raw, list) or not isinstance(overlays_raw, list):
        raise ReelLabError("Монтаж: неверный план.")
    if len(segments_raw) > 600 or len(overlays_raw) > 120:
        raise ReelLabError("Монтаж: слишком много вставок.")
    frame = value.get("frame") if isinstance(value.get("frame"), dict) else {}
    width = int(_montage_number(frame.get("width"), 16, 4096, "ширина кадра")) // 2 * 2
    height = int(_montage_number(frame.get("height"), 16, 4096, "высота кадра")) // 2 * 2
    clips: dict[str, dict[str, Any]] = {}

    def clip(upload_id: Any) -> dict[str, Any]:
        key = str(upload_id or "")
        if key not in clips:
            row = fetch_upload(key)
            path = Path(row["path"])
            if not path.is_file():
                raise ReelLabError("Видео для вставки не найдено. Добавь его ещё раз.", 404)
            if SERVER_MODE:
                path = ensure_render_source(row)
            clips[key] = {"path": str(path), "duration": float(row["duration"] or 0), "has_audio": bool(row["has_audio"])}
        return clips[key]

    segments: list[dict[str, Any]] = []
    has_insert = False
    for item in segments_raw:
        if not isinstance(item, dict):
            raise ReelLabError("Монтаж: неверный кусок.")
        if item.get("kind") == "insert":
            # main — кусок самого исходника в другой скорости (замедление, ускорение).
            own = bool(item.get("main"))
            limit = main_duration if own else clip(item.get("upload_id"))["duration"]
            start = _montage_number(item.get("in"), 0, limit, "начало вставки")
            end = _montage_number(item.get("out"), start + 0.05, limit + 0.05, "конец вставки")
            segments.append({"kind": "insert", "main": own, "upload_id": None if own else str(item.get("upload_id")),
                             "in": start, "out": min(end, limit),
                             "speed": _montage_number(item.get("speed", 1), MONTAGE_MIN_SPEED, MONTAGE_MAX_SPEED, "скорость вставки"),
                             "volume": _montage_number(item.get("volume", 1), 0, 4, "громкость вставки"),
                             "fit": item.get("fit") if item.get("fit") in MONTAGE_FITS else "cover"})
            has_insert = True
        else:
            start = _montage_number(item.get("start"), 0, main_duration + 1, "начало куска")
            end = None if item.get("end") is None else _montage_number(item.get("end"), start, main_duration + 1, "конец куска")
            segments.append({"kind": "main", "start": start, "end": end})
    overlays: list[dict[str, Any]] = []
    for item in overlays_raw:
        if not isinstance(item, dict):
            raise ReelLabError("Монтаж: неверное видео поверх.")
        info = clip(item.get("upload_id"))
        start = _montage_number(item.get("in"), 0, info["duration"], "начало видео поверх")
        length = _montage_number(item.get("len"), 0.05, max(0.05, (info["duration"] - start) / MONTAGE_MIN_SPEED + 0.05), "длина видео поверх")
        warp_raw = item.get("warp") or []
        if not isinstance(warp_raw, list) or len(warp_raw) > 800:
            raise ReelLabError("Монтаж: неверные склейки под видео поверх.")
        warp = []
        for step in warp_raw:
            if not isinstance(step, (list, tuple)) or len(step) != 2:
                raise ReelLabError("Монтаж: неверные склейки под видео поверх.")
            warp.append((_montage_number(step[0], 0, length, "склейка"), _montage_number(step[1], 0, 7200, "склейка")))
        speed = _montage_number(item.get("speed", 1), MONTAGE_MIN_SPEED, MONTAGE_MAX_SPEED, "скорость видео поверх")
        overlays.append({"upload_id": str(item.get("upload_id")), "in": start, "len": min(length, (info["duration"] - start) / speed),
                         "speed": speed,
                         "m0": _montage_number(item.get("m0"), 0, 4 * 3600, "место видео поверх"), "warp": warp,
                         "volume": _montage_number(item.get("volume", 0), 0, 4, "громкость видео поверх"),
                         "fit": item.get("fit") if item.get("fit") in MONTAGE_FITS else "cover"})
    if not has_insert and not overlays:
        return None
    if not any(item["kind"] == "main" for item in segments):
        raise ReelLabError("Монтаж: в плане нет исходного видео.")
    return {"frame": [width, height], "segments": segments, "overlays": overlays, "clips": clips}


MONTAGE_MIN_SPEED = 0.25
MONTAGE_MAX_SPEED = 4.0


def montage_speech_audio(main: Path, main_has_audio: bool, plan: dict[str, Any], skips: list[tuple[float, float]],
                         target: Path) -> float:
    """Звук всего ролика для распознавания речи: основное видео и вставки по порядку, без вырезанного.

    Время — как у готового ролика (O): границы кусков по кадрам (как в assemble_montage), вырезанные
    куски убраны. Видео поверх не звучат (обычно это перебивки без речи). Возвращает длину звука.
    Файл — MP4 с чёрным кадром 16×16: распознавание принимает его как обычное видео.
    """
    main = Path(main).resolve()
    num, den = video_rate(main)
    fps = num / den
    main_duration = float(probe(main)["duration"] or 0)
    command = ["ffmpeg", "-hide_banner", "-nostdin", "-y"]
    filters: list[str] = []
    labels: list[str] = []
    inputs = 0

    def add_input(path: str, start: float, length: float) -> int:
        nonlocal inputs
        command.extend(["-ss", f"{start:.4f}", "-t", f"{length + 0.6:.4f}", "-i", str(Path(path).resolve())])
        inputs += 1
        return inputs - 1

    def silence(length: float, label: str) -> None:
        filters.append(f"anullsrc=r=48000:cl=stereo,atrim=duration={length:.6f}{label}")

    position = boundary = 0.0
    for index, segment in enumerate(plan["segments"]):
        if segment["kind"] == "main":
            end = main_duration if segment["end"] is None else min(segment["end"], main_duration)
            length = max(0.0, end - segment["start"])
        else:
            length = (segment["out"] - segment["in"]) / segment.get("speed", 1.0)
        position += length
        next_boundary = round(position * fps) / fps
        duration = next_boundary - boundary
        boundary = next_boundary
        if duration < 0.5 / fps:
            continue
        label = f"[a{index}]"
        if segment["kind"] == "main":
            if main_has_audio:
                source = add_input(str(main), segment["start"], duration)
                filters.append(f"[{source}:a]asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,"
                               f"apad,atrim=duration={duration:.6f}{label}")
            else:
                silence(duration, label)
        else:
            own = bool(segment.get("main"))
            info = {"path": str(main), "has_audio": main_has_audio} if own else plan["clips"][segment["upload_id"]]
            speed = float(segment.get("speed", 1.0))
            if info["has_audio"] and segment["volume"] > 0.001:
                source = add_input(info["path"], segment["in"], duration * speed)
                filters.append(f"[{source}:a]asetpts=PTS-STARTPTS{_speed_audio(speed)},aresample=48000,"
                               f"aformat=channel_layouts=stereo,apad,atrim=duration={duration:.6f}{label}")
            else:
                silence(duration, label)
        labels.append(label)
    total = boundary
    if not labels or total <= 0:
        raise ReelLabError("Монтаж: в ролике не осталось кадров.")
    filters.append(f"{''.join(labels)}concat=n={len(labels)}:v=0:a=1[cat]")
    kept = []
    cursor = 0.0
    for start, end in _merge_ranges(list(skips), 0.0, total) + [[total, total]]:
        if start - cursor > 0.02:
            kept.append((cursor, start))
        cursor = max(cursor, end)
    if not kept:
        raise ReelLabError("Весь ролик вырезан — распознавать нечего.")
    if len(kept) == 1 and kept[0][0] < 0.01 and kept[0][1] > total - 0.01:
        filters.append("[cat]anull[speech]")
    else:
        filters.append(f"[cat]asplit={len(kept)}" + "".join(f"[k{i}]" for i in range(len(kept))))
        for i, (start, end) in enumerate(kept):
            filters.append(f"[k{i}]atrim=start={start:.6f}:end={end:.6f},asetpts=PTS-STARTPTS[kt{i}]")
        filters.append("".join(f"[kt{i}]" for i in range(len(kept))) + f"concat=n={len(kept)}:v=0:a=1[speech]")
    seconds = sum(end - start for start, end in kept)
    command += ["-f", "lavfi", "-i", "color=c=black:s=16x16:r=2"]
    black = inputs
    command += ["-filter_complex", ";".join(filters), "-map", f"{black}:v", "-map", "[speech]",
                "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k",
                "-t", f"{seconds:.6f}", "-movflags", "+faststart", str(target)]
    result = run(command, FFMPEG_TIMEOUT_SECONDS)
    if result.returncode or not target.is_file():
        target.unlink(missing_ok=True)
        raise ffmpeg_error("Не получилось собрать звук ролика для распознавания.", result.stderr)
    return seconds


def _speed_video(speed: float, rate: str) -> str:
    """Кадры клипа в нужной скорости и с частотой ролика."""
    if abs(speed - 1) < 1e-3:
        return f"setpts=PTS-STARTPTS,fps={rate}"
    if speed < 1:
        # Замедление: соседние кадры смешиваются — движение плавнее, чем от повтора кадров.
        # fps после minterpolate — ровная сетка кадров до конца клипа (иначе в конце «дыра» в 2–3 кадра
        # и всё, что дальше, уезжает от звука).
        return f"setpts=(PTS-STARTPTS)/{speed:.6f},minterpolate=fps={rate}:mi_mode=blend,fps={rate}"
    return f"setpts=(PTS-STARTPTS)/{speed:.6f},fps={rate}"


def _speed_audio(speed: float) -> str:
    """atempo держит высоту голоса; шаги по 0.5…2 работают в любой сборке FFmpeg."""
    if abs(speed - 1) < 1e-3:
        return ""
    parts = []
    rest = speed
    while rest < 0.5 - 1e-9:
        parts.append("atempo=0.5")
        rest /= 0.5
    while rest > 2.0 + 1e-9:
        parts.append("atempo=2.0")
        rest /= 2.0
    parts.append(f"atempo={rest:.6f}")
    return "," + ",".join(parts)


def _fit_filter(fit: str, width: int, height: int, label_in: str, label_out: str, tag: str) -> list[str]:
    """Вписать кадр клипа в кадр ролика: «Заполнить» (обрезка краёв) или «Целиком» на размытом фоне."""
    if fit == "blur":
        return [
            f"{label_in}split=2[{tag}b][{tag}f]",
            f"[{tag}b]scale={width}:{height}:force_original_aspect_ratio=increase,crop={width}:{height},"
            f"boxblur=luma_radius=min(h\\,w)/18:luma_power=2,eq=brightness=-0.06[{tag}bb]",
            f"[{tag}f]scale='trunc(iw*min({width}/iw\\,{height}/ih)/2)*2':'trunc(ih*min({width}/iw\\,{height}/ih)/2)*2'[{tag}ff]",
            f"[{tag}bb][{tag}ff]overlay=(W-w)/2:(H-h)/2{label_out}",
        ]
    return [f"{label_in}scale={width}:{height}:force_original_aspect_ratio=increase,crop={width}:{height}{label_out}"]


def assemble_montage(main: Path, main_has_audio: bool, plan: dict[str, Any], voice: dict[str, Any] | None,
                     workdir: Path, progress=None) -> Path:
    """Склеивает исходник со вставками и накладывает видео поверх (время M)."""
    workdir.mkdir(parents=True, exist_ok=True)
    result = workdir / "montage.mp4"
    if result.is_file() and result.stat().st_size > 0:
        return result
    main = Path(main).resolve()
    width, height = plan["frame"]
    num, den = video_rate(main)
    fps = num / den
    rate = f"{num}/{den}"
    main_duration = float(probe(main)["duration"] or 0)
    command = ["ffmpeg", "-hide_banner", "-nostdin", "-y"]
    filters: list[str] = []
    video_labels: list[str] = []
    voice_labels: list[str] = []
    insert_labels: list[str] = []
    inputs = 0

    def add_input(path: str, start: float, length: float) -> int:
        nonlocal inputs
        command.extend(["-ss", f"{start:.4f}", "-t", f"{length + 0.6:.4f}", "-i", str(Path(path).resolve())])
        inputs += 1
        return inputs - 1

    def silence(length: float, label: str) -> None:
        filters.append(f"anullsrc=r=48000:cl=stereo,atrim=duration={length:.6f}{label}")

    position = 0.0
    boundary = 0.0
    kinds = [segment["kind"] for segment in plan["segments"]]

    def edge_fades(index: int, duration: float) -> str:
        """Короткие затухания звука на стыках исходника и вставок: без щелчков на склейке."""
        fade = min(0.04, duration / 4)
        parts = []
        if index > 0 and (kinds[index] != "main" or kinds[index - 1] != "main"):
            parts.append(f"afade=t=in:st=0:d={fade:.4f}")
        if index + 1 < len(kinds) and (kinds[index] != "main" or kinds[index + 1] != "main"):
            parts.append(f"afade=t=out:st={max(0.0, duration - fade):.6f}:d={fade:.4f}")
        return "".join(f",{part}" for part in parts)

    for index, segment in enumerate(plan["segments"]):
        if segment["kind"] == "main":
            end = main_duration if segment["end"] is None else min(segment["end"], main_duration)
            length = max(0.0, end - segment["start"])
        else:
            length = (segment["out"] - segment["in"]) / segment.get("speed", 1.0)
        position += length
        # Границы кусков — точно по кадрам: время сборки не расходится с предпросмотром.
        next_boundary = round(position * fps) / fps
        duration = next_boundary - boundary
        boundary = next_boundary
        if duration < 0.5 / fps:
            continue
        v = f"[v{index}]"
        if segment["kind"] == "main":
            source = add_input(str(main), segment["start"], duration)
            filters.append(f"[{source}:v]setpts=PTS-STARTPTS,fps={rate},scale={width}:{height},setsar=1,format=yuv420p,"
                           f"tpad=stop_mode=clone:stop_duration=2,trim=duration={duration:.6f},setpts=PTS-STARTPTS{v}")
            if main_has_audio:
                filters.append(f"[{source}:a]asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,"
                               f"apad,atrim=duration={duration:.6f}{edge_fades(index, duration)}[a{index}]")
            else:
                silence(duration, f"[a{index}]")
            silence(duration, f"[i{index}]")
        else:
            own = bool(segment.get("main"))
            info = {"path": str(main), "has_audio": main_has_audio} if own else plan["clips"][segment["upload_id"]]
            speed = float(segment.get("speed", 1.0))
            # Клипа нужно в speed раз больше (или меньше), чем места в ролике.
            source = add_input(info["path"], segment["in"], duration * speed)
            fitted = f"[f{index}]"
            filters.append(f"[{source}:v]{_speed_video(speed, rate)}[r{index}]")
            filters.extend(_fit_filter(segment["fit"], width, height, f"[r{index}]", fitted, f"x{index}"))
            filters.append(f"{fitted}setsar=1,format=yuv420p,tpad=stop_mode=clone:stop_duration=2,"
                           f"trim=duration={duration:.6f},setpts=PTS-STARTPTS{v}")
            # Кусок исходника звучит в дорожке голоса (та же очистка и громкость), другое видео — отдельно.
            voice_out, other_out = (f"[a{index}]", f"[i{index}]") if own else (f"[i{index}]", f"[a{index}]")
            silence(duration, other_out)
            if info["has_audio"] and segment["volume"] > 0.001:
                filters.append(f"[{source}:a]asetpts=PTS-STARTPTS{_speed_audio(speed)},aresample=48000,aformat=channel_layouts=stereo,"
                               f"volume={segment['volume']:.3f},apad,atrim=duration={duration:.6f}{edge_fades(index, duration)}{voice_out}")
            else:
                silence(duration, voice_out)
        video_labels.append(v)
        voice_labels.append(f"[a{index}]")
        insert_labels.append(f"[i{index}]")
    total = boundary
    if not video_labels or total <= 0:
        raise ReelLabError("Монтаж: в ролике не осталось кадров.")
    count = len(video_labels)
    filters.append(f"{''.join(video_labels)}concat=n={count}:v=1:a=0[vcat]")
    filters.append(f"{''.join(voice_labels)}concat=n={count}:v=0:a=1[voicecat]")
    filters.append(f"{''.join(insert_labels)}concat=n={count}:v=0:a=1[inscat]")
    cleanup = voice_filters(bool((voice or {}).get("clean")), bool((voice or {}).get("level")))
    gain = clamp_gain((voice or {}).get("gain"), 1.0)
    if abs(gain - 1.0) > 1e-3:
        cleanup.append(f"volume={gain:.3f}")
    filters.append(f"[voicecat]{','.join(cleanup) if cleanup else 'anull'}[voicef]")

    base = "[vcat]"
    mix = ["[voicef]", "[inscat]"]
    for index, item in enumerate(plan["overlays"]):
        info = plan["clips"][item["upload_id"]]
        speed = float(item.get("speed", 1.0))
        source = add_input(info["path"], item["in"], item["len"] * speed)
        warp = "".join(f"+{step:.6f}*gte(T\\,{offset:.6f})" for offset, step in item["warp"])
        m1 = item["m0"] + item["len"] + sum(step for _, step in item["warp"])
        filters.append(f"[{source}:v]{_speed_video(speed, rate)}[or{index}]")
        filters.extend(_fit_filter(item["fit"], width, height, f"[or{index}]", f"[of{index}]", f"y{index}"))
        filters.append(f"[of{index}]setsar=1,format=yuv420p,trim=duration={item['len']:.6f},"
                       f"setpts='({item['m0']:.6f}+T{warp})/TB'[ov{index}]")
        out = f"[vo{index}]"
        filters.append(f"{base}[ov{index}]overlay=0:0:eof_action=pass:enable='between(t\\,{item['m0']:.6f}\\,{m1:.6f})'{out}")
        base = out
        if info["has_audio"] and item["volume"] > 0.001:
            # Звук видео поверх: кусками между склейками, каждый — на своё место сборки.
            cuts = [0.0] + [offset for offset, _ in item["warp"]] + [item["len"]]
            shift = 0.0
            pieces = []
            for k in range(len(cuts) - 1):
                if cuts[k + 1] - cuts[k] > 0.01:
                    pieces.append((cuts[k], cuts[k + 1], item["m0"] + cuts[k] + shift))
                if k < len(item["warp"]):
                    shift += item["warp"][k][1]
            if pieces:
                filters.append(f"[{source}:a]asetpts=PTS-STARTPTS{_speed_audio(speed)},aresample=48000,aformat=channel_layouts=stereo,"
                               f"volume={item['volume']:.3f},asplit={len(pieces)}" + "".join(f"[os{index}_{k}]" for k in range(len(pieces))))
                for k, (a, b, at) in enumerate(pieces):
                    delay = max(0, int(round(at * 1000)))
                    filters.append(f"[os{index}_{k}]atrim=start={a:.6f}:end={b:.6f},asetpts=PTS-STARTPTS,adelay={delay}|{delay}[od{index}_{k}]")
                    mix.append(f"[od{index}_{k}]")
    # duration=longest + apad: loudnorm отдаёт хвост с задержкой, а amix с duration=first его обрезает.
    filters.append(f"{''.join(mix)}amix=inputs={len(mix)}:duration=longest:dropout_transition=0:normalize=0,"
                   f"alimiter=limit=0.97,apad,atrim=duration={total:.6f}[aout]")
    temp = workdir / "montage.part.mp4"
    command += ["-filter_complex", ";".join(filters), "-map", base, "-map", "[aout]",
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-r", rate,
                "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", "-t", f"{total:.6f}",
                "-movflags", "+faststart", "-progress", "pipe:1", "-nostats", str(temp)]
    (workdir / "montage.filter.txt").write_text(";\n".join(filters), encoding="utf-8")
    process = subprocess.Popen(command, cwd=str(RNNOISE_DIR if RNNOISE_DIR.is_dir() else workdir), stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace",
                               creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    stderr_tail: list[str] = []

    def drain_stderr() -> None:
        for line in process.stderr:
            stderr_tail.append(line)
            del stderr_tail[:-60]

    threading.Thread(target=drain_stderr, daemon=True).start()
    for line in process.stdout:
        if line.startswith("out_time_ms=") and progress:
            try:
                progress(min(99.0, int(line.split("=", 1)[1]) / 1e6 / max(0.1, total) * 100))
            except ValueError:
                pass
    code = process.wait(timeout=FFMPEG_TIMEOUT_SECONDS)
    if code != 0 or not temp.is_file():
        (workdir / "montage.log").write_text("".join(stderr_tail), encoding="utf-8", errors="replace")
        temp.unlink(missing_ok=True)
        raise ffmpeg_error("Не получилось склеить вставки. Проверь видео на ленте и попробуй ещё раз.", "".join(stderr_tail),
                           500, "montage_failed")
    temp.replace(result)
    return result


# ---------------------------------------------------------------------------
# Копия для сборки на сервере. Chrome на Linux не умеет HEVC (так снимает
# iPhone), 10-битное видео и HDR; 4K к тому же сильно тормозит сборку. Такие
# исходники один раз перекодируются в H.264 SDR (не больше 1920 по длинной
# стороне, постоянная частота кадров). Делается сразу после загрузки, пока
# человек выбирает стиль; локальная студия этим не пользуется.

RENDER_MAX_SIDE = max(720, int(os.environ.get("REELLAB_RENDER_MAX_SIDE", "1920")))
CHROME_VIDEO_CODECS = {"h264", "vp8", "vp9", "av1"}
CHROME_PIXEL_FORMATS = {"yuv420p", "yuvj420p"}
HDR_TRANSFERS = {"smpte2084", "arib-std-b67"}
_render_copy_slots = threading.Semaphore(max(1, int(os.environ.get("REELLAB_TRANSCODE_SLOTS", "2"))))
_render_copy_locks: dict[str, threading.Lock] = {}
_render_copy_guard = threading.Lock()


def video_details(path: Path) -> dict[str, Any]:
    result = run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                  "stream=codec_name,pix_fmt,width,height,color_transfer,color_primaries,color_space,bit_rate"
                  ":stream_side_data=rotation:stream_tags=rotate",
                  "-of", "json", str(path)], 90)
    try:
        stream = (json.loads(result.stdout or "{}").get("streams") or [{}])[0]
    except json.JSONDecodeError:
        stream = {}
    return {
        "codec": str(stream.get("codec_name") or ""), "pix_fmt": str(stream.get("pix_fmt") or ""),
        "width": int(stream.get("width") or 0), "height": int(stream.get("height") or 0),
        "transfer": str(stream.get("color_transfer") or ""), "primaries": str(stream.get("color_primaries") or ""),
        "space": str(stream.get("color_space") or ""),
    }


def render_copy_reasons(details: dict[str, Any]) -> list[str]:
    reasons = []
    if details["codec"] not in CHROME_VIDEO_CODECS:
        reasons.append(f"кодек {details['codec'] or '?'}")
    if details["pix_fmt"] and details["pix_fmt"] not in CHROME_PIXEL_FORMATS:
        reasons.append(f"формат {details['pix_fmt']}")
    if details["transfer"] in HDR_TRANSFERS:
        reasons.append("HDR")
    if max(details["width"], details["height"]) > RENDER_MAX_SIDE:
        reasons.append(f"{details['width']}×{details['height']}")
    return reasons


def render_copy_command(source: Path, destination: Path, details: dict[str, Any]) -> list[str]:
    filters = []
    if details["transfer"] == "arib-std-b67":
        # HLG (так снимает iPhone) задуман совместимым с обычным видео: прямой перевод в BT.709
        # ближе всего к оригиналу (проверено: PSNR ~38 дБ против ~18 у «hable»).
        filters.append("zscale=tin=arib-std-b67:pin=bt2020:min=bt2020nc:t=bt709:p=bt709:m=bt709:r=tv:npl=100")
    elif details["transfer"] == "smpte2084":
        # PQ (HDR10 у части Android) без сжатия яркости выходит пересвеченным — нужен тонмаппинг.
        filters.append("zscale=tin=smpte2084:pin=bt2020:min=bt2020nc:t=linear:npl=100,format=gbrpf32le,"
                       "zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv")
    side = RENDER_MAX_SIDE
    filters.append(f"scale='if(gte(iw,ih),min({side},iw),-2)':'if(gte(iw,ih),-2,min({side},ih))':flags=lanczos")
    filters.append("format=yuv420p")
    num, den = video_rate(source)
    if num / den > 60:
        num, den = 60, 1
    return [
        "ffmpeg", "-hide_banner", "-nostdin", "-y", "-i", str(source),
        "-map", "0:v:0", "-map", "0:a:0?", "-vf", ",".join(filters),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-profile:v", "high", "-pix_fmt", "yuv420p",
        "-r", f"{num}/{den}", "-fps_mode", "cfr",
        "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
        "-c:a", "aac", "-b:a", "192k", "-ac", "2", "-ar", "48000",
        "-movflags", "+faststart", str(destination),
    ]


def ensure_render_source(upload: sqlite3.Row) -> Path:
    """Путь к исходнику, который поймёт Chrome на сервере (при необходимости — перекодированный)."""
    source = Path(upload["path"])
    if not SERVER_MODE:
        return source
    if upload["render_path"] and Path(upload["render_path"]).is_file():
        return Path(upload["render_path"])
    with _render_copy_guard:
        guard = _render_copy_locks.setdefault(upload["id"], threading.Lock())
    with guard:
        with database() as conn:
            row = conn.execute("SELECT render_path FROM uploads WHERE id=?", (upload["id"],)).fetchone()
        if row and row["render_path"] and Path(row["render_path"]).is_file():
            return Path(row["render_path"])
        details = video_details(source)
        reasons = render_copy_reasons(details)
        if not reasons:
            target = source
        else:
            target = source.with_name(f"{upload['id']}.render.mp4")
            partial = source.with_name(f".{upload['id']}.render.part.mp4")
            with _render_copy_slots:
                result = run(render_copy_command(source, partial, details),
                             timeout=max(600, int(float(upload["duration"] or 60) * 6)))
            if result.returncode or not partial.is_file() or partial.stat().st_size < 1000:
                partial.unlink(missing_ok=True)
                raise ffmpeg_error(f"Не удалось подготовить видео для сборки ({', '.join(reasons)}).", result.stderr)
            os.replace(partial, target)
        with lock, database() as conn:
            conn.execute("UPDATE uploads SET render_path=? WHERE id=?", (str(target), upload["id"]))
        return target


def prepare_render_copy_later(upload_id: str) -> None:
    """Сразу после загрузки: перекодировать в фоне, пока человек выбирает стиль."""
    def job() -> None:
        try:
            with database() as conn:
                row = conn.execute("SELECT * FROM uploads WHERE id=?", (upload_id,)).fetchone()
            if row is not None:
                ensure_render_source(row)
        except Exception:  # noqa: BLE001 — при сборке попробуем ещё раз и покажем ошибку
            pass
    threading.Thread(target=job, daemon=True, name=f"render-copy-{upload_id[:6]}").start()


def prepare_source(source: Path, has_audio: bool, enhance: dict[str, bool], montage: dict[str, Any] | None,
                   voice: dict[str, Any] | None, progress=None) -> Path:
    """Исходник для сборки: улучшенный (если включено) и со вставками (если есть)."""
    wants_enhance = any(enhance.values())
    if not montage:
        return prepare_enhanced(source, enhance, progress) if wants_enhance else source

    def part(low: float, high: float):
        return (lambda percent: progress(low + (high - low) * percent / 100)) if progress else None

    main = prepare_enhanced(source, enhance, part(0, 45)) if wants_enhance else source
    stat = Path(main).stat()
    plan_key = json.dumps({key: montage[key] for key in ("frame", "segments", "overlays")}, sort_keys=True)
    voice_key = json.dumps({"clean": bool((voice or {}).get("clean")), "level": bool((voice or {}).get("level")),
                            "gain": round(clamp_gain((voice or {}).get("gain"), 1.0), 3)}, sort_keys=True)
    key = hashlib.sha1(f"{Path(main).resolve()}|{stat.st_size}|{int(stat.st_mtime)}|{plan_key}|{voice_key}".encode("utf-8")).hexdigest()[:24]
    return assemble_montage(main, has_audio, montage, voice, (PREPARED / f"m{key}").resolve(), part(45 if wants_enhance else 0, 100))


def _run_prepare_job(job_key: str, source: Path, has_audio: bool, enhance: dict[str, bool],
                     montage: dict[str, Any] | None, voice: dict[str, Any] | None) -> None:
    job = prepare_jobs[job_key]
    try:
        def progress(percent: float) -> None:
            job["percent"] = round(percent, 1)
        job["path"] = str(prepare_source(source, has_audio, enhance, montage, voice, progress))
        job.update(status="completed", percent=100)
    except Exception as error:  # noqa: BLE001 — ошибка показывается в студии
        job.update(status="failed", error=getattr(error, "message", str(error)))


@app.post("/api/edit/prepare")
def edit_prepare():
    require_csrf()
    body = require_json()
    upload_row = fetch_upload(str(body.get("upload_id") or ""))
    source = Path(upload_row["path"])
    if not source.exists():
        raise ReelLabError("Исходное видео не найдено. Загрузите его ещё раз.", 404)
    enhance = normalise_enhance(body.get("enhance"))
    montage = normalise_montage(body.get("montage"), float(upload_row["duration"] or 0))
    voice = body.get("voice") if isinstance(body.get("voice"), dict) else {}
    # Со вставками голос собирается здесь: громкость и очистка — только для дорожки исходника.
    voice = {"clean": bool(voice.get("clean")), "level": bool(voice.get("level")),
             "gain": round(clamp_gain(voice.get("gain"), 1.0), 3)} if montage else {}
    if not montage and not any(enhance.values()):
        raise ReelLabError("Нечего готовить: ни улучшения, ни вставок.")
    plan_key = json.dumps({key: montage[key] for key in ("frame", "segments", "overlays")}, sort_keys=True) if montage else ""
    job_key = hashlib.sha1(f"{upload_row['id']}|{json.dumps(enhance, sort_keys=True)}|{plan_key}|{json.dumps(voice, sort_keys=True)}".encode("utf-8")).hexdigest()[:20]
    with _prepare_lock:
        job = prepare_jobs.get(job_key)
        if job is None or job["status"] == "failed" or (job.get("path") and not Path(job["path"]).is_file()):
            job = {"id": job_key, "status": "running", "percent": 0, "error": None, "path": None}
            prepare_jobs[job_key] = job
            threading.Thread(target=_run_prepare_job, args=(job_key, source, bool(upload_row["has_audio"]), enhance, montage, voice),
                             daemon=True).start()
    return jsonify({key: job[key] for key in ("id", "status", "percent", "error")})


@app.get("/api/edit/prepare/<job_key>")
def edit_prepare_status(job_key: str):
    job = prepare_jobs.get(job_key)
    if job is None:
        raise ReelLabError("Задача улучшения не найдена.", 404)
    return jsonify({key: job[key] for key in ("id", "status", "percent", "error")})


@app.get("/api/edit/prepared/<job_key>")
def edit_prepared_file(job_key: str):
    job = prepare_jobs.get(job_key)
    if job is None or job["status"] != "completed" or not job.get("path"):
        raise ReelLabError("Улучшенное видео ещё не готово.", 404)
    return send_file(job["path"], mimetype="video/mp4", conditional=True)


# ---------------------------------------------------------------------------
# Нейросети MediaPipe (поиск человека и лица в браузере). Файлы скачиваются
# один раз при первом обращении и дальше лежат в static/vendor/mediapipe —
# студия работает без интернета, а переносная версия берёт их с собой.

MEDIAPIPE_VERSION = "0.10.21"
MEDIAPIPE_DIR = STATIC / "vendor" / "mediapipe"
_MP_CDN = f"https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@{MEDIAPIPE_VERSION}"
_MP_MODELS = "https://storage.googleapis.com/mediapipe-models"
MEDIAPIPE_FILES = {
    "vision_bundle.mjs": f"{_MP_CDN}/vision_bundle.mjs",
    "wasm/vision_wasm_internal.js": f"{_MP_CDN}/wasm/vision_wasm_internal.js",
    "wasm/vision_wasm_internal.wasm": f"{_MP_CDN}/wasm/vision_wasm_internal.wasm",
    "wasm/vision_wasm_nosimd_internal.js": f"{_MP_CDN}/wasm/vision_wasm_nosimd_internal.js",
    "wasm/vision_wasm_nosimd_internal.wasm": f"{_MP_CDN}/wasm/vision_wasm_nosimd_internal.wasm",
    "selfie_segmenter.tflite": f"{_MP_MODELS}/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite",
    "blaze_face_short_range.tflite": f"{_MP_MODELS}/face_detector/blaze_face_short_range/float16/latest/blaze_face_short_range.tflite",
}
_MP_TYPES = {".mjs": "text/javascript", ".js": "text/javascript", ".wasm": "application/wasm", ".tflite": "application/octet-stream"}
_mp_locks: dict[str, threading.Lock] = {}
_mp_guard = threading.Lock()


def _fetch_vendor_file(name: str) -> Path:
    target = MEDIAPIPE_DIR / name
    if target.is_file() and target.stat().st_size > 0:
        return target
    with _mp_guard:
        lock = _mp_locks.setdefault(name, threading.Lock())
    with lock:
        if target.is_file() and target.stat().st_size > 0:
            return target
        import urllib.request  # noqa: PLC0415 — нужен только при первой загрузке

        target.parent.mkdir(parents=True, exist_ok=True)
        temp = target.with_suffix(target.suffix + ".part")
        request_obj = urllib.request.Request(MEDIAPIPE_FILES[name], headers={"User-Agent": "ReelLab/1.0"})
        try:
            with urllib.request.urlopen(request_obj, timeout=180) as response, temp.open("wb") as output:
                shutil.copyfileobj(response, output, 1024 * 256)
        except OSError as error:
            temp.unlink(missing_ok=True)
            raise ReelLabError(f"Не удалось скачать компонент нейросети ({name}): {error}. Нужен интернет при первом запуске.", 502) from error
        temp.replace(target)
        return target


@app.get("/vendor/mediapipe/<path:name>")
def mediapipe_file(name: str):
    if name not in MEDIAPIPE_FILES:
        raise ReelLabError("Компонент не найден.", 404)
    path = _fetch_vendor_file(name)
    response = send_file(path, mimetype=_MP_TYPES.get(path.suffix, "application/octet-stream"), conditional=True, max_age=31536000)
    response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    return response


# ---------------------------------------------------------------------------
# Картинки к словам (стиль «Слова с картинками»)

pictures_service = PicturesService(DATA)
editor_tools = EditorTools(pictures_service)


class ai_meter:  # noqa: N801 — «with ai_meter("text"):»
    """Сервер: проверить ИИ-бюджет человека до запроса и списать фактическую стоимость после.

    kind: «text» (монтаж, хук, перевод, подбор картинок) или «image» (ИИ-картинка).
    Локальная студия ничего не считает.
    """

    def __init__(self, kind: str, estimate_kop: float = 30):
        self.kind = kind
        self.estimate = estimate_kop
        self.allowance: dict[str, Any] | None = None
        self.scope = None
        self.user_id = 0

    def __enter__(self):
        if not SERVER_MODE:
            return None
        from accounts import AI_PRICES_KOP
        self.user_id = current_user_id()
        self.allowance = accounts.ai_allowance(self.user_id, self.kind, self.estimate)
        self.scope = usage_scope(self.allowance["tier"])
        usage = self.scope.__enter__()
        usage.cap_kop = self.allowance.get("left_kop")
        usage.prices = AI_PRICES_KOP
        return usage

    def __exit__(self, *exc: Any) -> None:
        if self.scope is None:
            return
        from accounts import AI_PRICES_KOP
        usage = self.scope.scope
        self.scope.__exit__(*exc)
        cost = usage.cost_kop(AI_PRICES_KOP)
        if cost > 0 or usage.text or usage.images:
            accounts.charge_ai(self.user_id, self.allowance["pool"], self.kind, cost, usage.units(), usage.describe())


@app.post("/api/ai/smartcut")
def ai_smartcut():
    require_csrf()
    words = require_json().get("words")
    # Оценка до запроса растёт с длиной текста: длинный ролик — несколько вызовов ИИ.
    size = len(words) if isinstance(words, list) else 0
    with ai_meter("text", max(30, size / 20)):
        return jsonify(editor_tools.smartcut(words))


@app.post("/api/ai/hook")
def ai_hook():
    require_csrf()
    with ai_meter("text"):
        return jsonify(editor_tools.hook(str(require_json().get("text") or "")))


@app.post("/api/ai/moments")
def ai_moments():
    require_csrf()
    body = require_json()
    try:
        low, high = float(body.get("min") or 20), float(body.get("max") or 60)
    except (TypeError, ValueError):
        low, high = 20.0, 60.0
    with ai_meter("text", 60):
        return jsonify(editor_tools.moments(body.get("sentences"), max(5.0, low), min(180.0, max(low + 5, high))))


@app.post("/api/ai/translate")
def ai_translate():
    require_csrf()
    body = require_json()
    lines = body.get("lines")
    size = len(lines) if isinstance(lines, list) else 0
    with ai_meter("text", max(30, min(size, 1500) * 1.0)):
        return jsonify(editor_tools.translate(lines, str(body.get("language") or "")))


# ---------------------------------------------------------------------------
# ИИ-помощник: «как сделан этот ролик» (разбор чужого видео) и вопросы о монтаже.
# Замеры (склейки, цвет, ритм, речь) считаются на сервере без ИИ; ИИ смотрит
# кадры и пишет разбор живым языком — это списывается из ИИ-бюджета человека.

ASSISTANT_DIR = DATA / "assistant"
ASSISTANT_KEEP_SECONDS = 14 * 86400
ASSISTANT_SLOTS = max(1, int(os.environ.get("REELLAB_ASSISTANT_SLOTS", "2")))
ASSISTANT_PHASES = {
    "queued": "В очереди…", "probe": "Открываю видео…", "frames": "Смотрю кадры…", "cuts": "Ищу склейки и переходы…",
    "colour": "Смотрю цвет…", "audio": "Слушаю музыку и ритм…", "speech": "Слушаю речь…",
    "vision": "ИИ смотрит кадры…", "explain": "ИИ пишет разбор…", "done": "Готово",
}
ASSISTANT_DAILY = {"admin": 1000, "free": 6, "paid": 40, "local": 1000}
ASSISTANT_PER_USER = {"admin": 4, "free": 1, "paid": 2, "local": 4}   # сколько разборов одного человека идут разом
_assistant_pool = ThreadPoolExecutor(max_workers=ASSISTANT_SLOTS, thread_name_prefix="assistant")
_assistant_live: dict[str, dict[str, Any]] = {}
_assistant_live_lock = threading.Lock()
assistant_ai = assistant_core.Assistant(
    pictures_service._ask_json,
    see=lambda system, text, images: pictures_service.yandex.vision(system, text, images) if pictures_service.yandex else None,
)


def transcribe_reference(path: Path, workdir: Path) -> dict[str, Any] | None:
    """Речь в чужом ролике: язык заранее неизвестен, поэтому только Whisper (он узнаёт язык сам)."""
    if speech_local.available():
        return speech_local.quick_transcript(path, workdir, max_seconds=120)
    return None


def _assistant_file(analysis_id: str) -> Path:
    return ASSISTANT_DIR / f"{analysis_id}.json"


def assistant_record(analysis_id: str) -> dict[str, Any] | None:
    if not valid_identifier(str(analysis_id or "")):
        return None
    try:
        return json.loads(_assistant_file(analysis_id).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _assistant_store(record: dict[str, Any]) -> None:
    ASSISTANT_DIR.mkdir(parents=True, exist_ok=True)
    target = _assistant_file(record["id"])
    temp = target.with_suffix(".tmp")
    temp.write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")
    temp.replace(target)
    with lock, database() as conn:
        conn.execute("UPDATE assistant_runs SET status=? WHERE id=?", (record["status"], record["id"]))


def _assistant_plan(user_id: int) -> str:
    if not SERVER_MODE:
        return "local"
    status = accounts.status(user_id)
    return "admin" if status["admin"] else "free" if status["plan"] == "free" else "paid"


def start_assistant(user_id: int, upload_id: str, *, source: str = "studio",
                    on_done: Any = None) -> dict[str, Any]:
    """Поставить разбор ролика в очередь. Видео — загрузка этого же человека."""
    if not valid_identifier(str(upload_id or "")):
        raise ReelLabError("Видео для разбора не найдено.", 404)
    with database() as conn:
        row = conn.execute("SELECT * FROM uploads WHERE id=?", (upload_id,)).fetchone()
    if row is None or (SERVER_MODE and int(row["user_id"] or 0) != int(user_id)):
        raise ReelLabError("Видео для разбора не найдено.", 404)
    path = Path(row["path"])
    if not path.is_file():
        raise ReelLabError("Видео уже удалено с сервера. Пришли его ещё раз.", 404)
    plan = _assistant_plan(user_id)
    # ИИ-часть (зрение и живой разбор) — из ИИ-бюджета. Нет бюджета — разбор по замерам, без ИИ.
    allowance: dict[str, Any] | None = None
    ai_note = ""
    if SERVER_MODE:
        try:
            allowance = accounts.ai_allowance(int(user_id), "text", 40)
        except AccountsError as error:
            if error.code == "blocked":
                raise
            ai_note = error.message
    analysis_id = identifier()
    record = {"id": analysis_id, "user_id": int(user_id), "upload_id": upload_id, "name": row["name"], "source": source,
              "created": now(), "status": "queued", "error": None, "result": None}
    # Счёт и запись — под одним замком: два запроса разом не проскочат мимо дневного лимита.
    with lock, database() as conn:
        used = conn.execute("SELECT COUNT(*) n FROM assistant_runs WHERE user_id=? AND created>=?",
                            (int(user_id), now() - 86400)).fetchone()["n"]
        if int(used) >= ASSISTANT_DAILY[plan]:
            raise AccountsError(
                "Разборов на сегодня больше нельзя. Завтра — снова" + (" (или выбери тариф: там до 40 разборов в день)." if plan == "free" else "."),
                429, "assistant_cap")
        busy = conn.execute("SELECT COUNT(*) n FROM assistant_runs WHERE user_id=? AND status IN ('queued','running')",
                            (int(user_id),)).fetchone()["n"]
        if int(busy) >= ASSISTANT_PER_USER.get(plan, 2):
            raise AccountsError("Я ещё разбираю твои прошлые ролики. Дождись ответа — и присылай следующий.", 429, "assistant_busy")
        conn.execute("INSERT INTO assistant_runs(id,user_id,upload_id,status,source,created) VALUES(?,?,?,?,?,?)",
                     (analysis_id, int(user_id), upload_id, "queued", source, record["created"]))
    _assistant_store(record)
    with _assistant_live_lock:
        _assistant_live[analysis_id] = {"progress": 1, "phase": "queued"}
    _assistant_pool.submit(_assistant_work, record, path, allowance, ai_note, on_done)
    return record


def _assistant_work(record: dict[str, Any], path: Path, allowance: dict[str, Any] | None, ai_note: str,
                    on_done: Any) -> None:
    analysis_id = record["id"]
    workdir = JOBS / f"assistant-{analysis_id}"

    def progress(phase: str, percent: int) -> None:
        with _assistant_live_lock:
            _assistant_live[analysis_id] = {"progress": int(percent), "phase": phase}

    record["status"] = "running"
    try:
        features = assistant_core.analyse_media(path, workdir, progress=progress, transcribe=transcribe_reference)
        vision = ai = None
        # Локальная студия: ИИ — только с ключом (без ключа бесплатный сервис может отвечать минутами).
        use_ai = (allowance is not None) if SERVER_MODE else pictures_service.configured()
        if use_ai:
            tier = (allowance or {}).get("tier", "best")
            with usage_scope(tier) as usage:
                if SERVER_MODE and allowance is not None:
                    from accounts import AI_PRICES_KOP
                    usage.cap_kop, usage.prices = allowance.get("left_kop"), AI_PRICES_KOP
                try:
                    if pictures_service.yandex is not None:
                        progress("vision", 84)
                        try:
                            meta = features["meta"]
                            sheet = assistant_core.contact_sheet(
                                path, assistant_core.sheet_times(meta["analysed"], features["junctions"]["list"]),
                                meta["width"], meta["height"], workdir)
                            vision = assistant_ai.vision(sheet, ((features.get("speech") or {}).get("text") or ""))
                        except Exception as error:  # noqa: BLE001 — без зрения разбор всё равно есть
                            vision = None
                            app.logger.info("Помощник: кадры не разобраны ИИ: %s", getattr(error, "message", error))
                    base = assistant_core.finish(features, vision=vision)
                    progress("explain", 92)
                    try:
                        ai = assistant_ai.explain(features, base["recipe"], base["observations"], base["steps"], vision)
                    except Exception as error:  # noqa: BLE001 — разбор по замерам вместо живого текста
                        ai = None
                        ai_note = ("ИИ-лимит закончился — разбор сделан по замерам." if getattr(error, "code", "") == "ai_budget"
                                   else "ИИ сейчас не ответил — разбор сделан по замерам.")
                        app.logger.info("Помощник: разбор без ИИ: %s", getattr(error, "message", error))
                finally:
                    # Списываем то, что ИИ успел сделать, даже если дальше что-то сломалось.
                    if SERVER_MODE and allowance is not None:
                        from accounts import AI_PRICES_KOP
                        cost = usage.cost_kop(AI_PRICES_KOP)
                        if cost > 0 or usage.text or usage.images:
                            try:
                                accounts.charge_ai(record["user_id"], allowance["pool"], "text", cost, usage.units(),
                                                   ("assistant " + usage.describe())[:300])
                            except Exception:  # noqa: BLE001
                                app.logger.exception("Помощник: ИИ не списан")
        result = assistant_core.finish(features, vision=vision, ai=ai)
        if ai_note:
            result["note"] = ai_note if ai_note.startswith("ИИ сейчас") else f"Разбор сделан по замерам, без ИИ. {ai_note}"
        result["telegram"] = assistant_core.guide_text(result)
        record.update(status="done", result=result, finished=now())
    except assistant_core.AnalysisError as error:
        record.update(status="failed", error=str(error), finished=now())
    except Exception as error:  # noqa: BLE001 — человеку — понятная фраза, в журнал — подробности
        app.logger.exception("Разбор ролика не удался")
        record.update(status="failed", error="Не получилось разобрать этот ролик. Попробуй другое видео.", finished=now())
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
        try:
            _assistant_store(record)
        except Exception:  # noqa: BLE001 — ответ в чат всё равно отправим
            app.logger.exception("Помощник: разбор не сохранён")
        finally:
            with _assistant_live_lock:
                _assistant_live.pop(analysis_id, None)
        if on_done is not None:
            try:
                on_done(record)
            except Exception:  # noqa: BLE001
                app.logger.exception("Помощник: ответ в чат не отправлен")


def recover_assistant_runs() -> None:
    """После перезапуска сервера: разборы, которые не успели закончиться, — честная ошибка вместо вечной очереди."""
    try:
        with database() as conn:
            stale = [row["id"] for row in conn.execute("SELECT id FROM assistant_runs WHERE status IN ('queued','running')")]
    except sqlite3.Error:
        return
    for analysis_id in stale:
        record = assistant_record(analysis_id)
        if record is None:
            with lock, database() as conn:
                conn.execute("UPDATE assistant_runs SET status='failed' WHERE id=?", (analysis_id,))
            continue
        record.update(status="failed", error="Сервер перезапускался во время разбора. Пришли ролик ещё раз.", finished=now())
        _assistant_store(record)


def assistant_public(record: dict[str, Any]) -> dict[str, Any]:
    live = _assistant_live.get(record["id"]) or {}
    status = record.get("status") or "queued"
    phase = live.get("phase") or ("done" if status == "done" else "queued")
    return {"id": record["id"], "status": status, "upload_id": record.get("upload_id"), "name": record.get("name"),
            "progress": 100 if status in ("done", "failed") else int(live.get("progress") or 1),
            "phase": phase, "phase_text": ASSISTANT_PHASES.get(phase, ""), "error": record.get("error"),
            "result": record.get("result") if status == "done" else None}


def assistant_answer(user_id: int, question: str, history: Any = None, context: Any = None) -> dict[str, Any]:
    """Ответ помощника: частые вопросы — из готовой базы (бесплатно), остальное — ИИ из бюджета человека."""
    history = history if isinstance(history, list) else []
    context = context if isinstance(context, dict) else None
    direct = assistant_core.faq_direct(question)
    if direct is not None:
        return direct
    known = assistant_core.faq_answer(question)
    if SERVER_MODE:
        try:
            allowance = accounts.ai_allowance(int(user_id), "text", 12)
        except AccountsError as error:
            if known is not None:
                return known
            return {"answer": f"{error.message}\n\nА пока — частые вопросы: переходы, музыка, «под музыку», субтитры, цвет. Спроси про них — отвечу сразу.",
                    "actions": [], "source": "limit"}
        with usage_scope(allowance["tier"]) as usage:
            from accounts import AI_PRICES_KOP
            usage.cap_kop, usage.prices = allowance.get("left_kop"), AI_PRICES_KOP
            try:
                result = assistant_ai.answer(question, history, context)
            finally:
                from accounts import AI_PRICES_KOP
                cost = usage.cost_kop(AI_PRICES_KOP)
                if cost > 0 or usage.text:
                    accounts.charge_ai(int(user_id), allowance["pool"], "text", cost, usage.units(),
                                       ("assistant-ask " + usage.describe())[:300])
        return result
    return assistant_ai.answer(question, history, context, use_ai=pictures_service.configured())


@app.post("/api/assistant/analyses")
def assistant_start_route():
    require_csrf()
    body = require_json()
    record = start_assistant(current_user_id(), str(body.get("upload_id") or ""), source="studio")
    return jsonify(assistant_public(record)), 202


@app.get("/api/assistant/analyses/<analysis_id>")
def assistant_status_route(analysis_id: str):
    record = assistant_record(analysis_id)
    if record is None or (SERVER_MODE and int(record.get("user_id") or 0) != current_user_id()
                          and not getattr(g, "is_admin", False)):
        raise ReelLabError("Разбор не найден. Пришли ролик ещё раз.", 404)
    response = jsonify(assistant_public(record))
    response.headers["Cache-Control"] = "no-store"
    return response


@app.post("/api/assistant/ask")
def assistant_ask_route():
    require_csrf()
    body = require_json()
    question = str(body.get("question") or "").strip()
    if not question:
        raise ReelLabError("Напиши вопрос.")
    try:
        return jsonify(assistant_answer(current_user_id(), question[:1200], body.get("history"), body.get("context")))
    except AiError as error:
        return jsonify({"answer": f"ИИ сейчас не отвечает: {error.message}", "actions": [], "source": "error"})


class AssistantBridge:
    """Что бот умеет делать с помощником: принять видео из чата, разобрать его, ответить на вопрос."""

    def save_video(self, user_id: int, source: Path, name: str) -> dict[str, Any]:
        file_name, suffix = upload_name_and_suffix(name or "video.mp4")
        upload_id = identifier()
        path = UPLOADS / f"{upload_id}{suffix}"
        shutil.move(str(source), path)
        return store_upload(upload_id, path, file_name, path.stat().st_size, int(user_id))

    def analyse(self, user_id: int, upload_id: str, on_done: Any) -> dict[str, Any]:
        return start_assistant(int(user_id), upload_id, source="bot", on_done=on_done)

    def ask(self, user_id: int, question: str, history: list[dict[str, Any]] | None = None) -> dict[str, Any]:
        return assistant_answer(int(user_id), question, history)

    def record(self, analysis_id: str) -> dict[str, Any] | None:
        return assistant_record(analysis_id)


@app.get("/sounds/sfx/curation.json")
def sounds_curation_get():
    target = SOUND_LIBRARY / "curation.json"
    if target.is_file():
        response = send_file(target, mimetype="application/json", conditional=False, max_age=0)
    else:
        response = jsonify({"removed": []})
    response.headers["Cache-Control"] = "no-store"
    return response


@app.post("/api/sounds/curation")
def sounds_curation_save():
    """Remember which library sounds the owner removed on the listening board.

    The file sits next to the manifest, so the studio reads it like any other
    sound file and a portable build carries the same selection.
    """
    require_csrf()
    body = require_json()
    removed = body.get("removed")
    if not isinstance(removed, list) or len(removed) > 1000:
        raise ReelLabError("Ожидался список убранных звуков.")
    manifest = json.loads((SOUND_LIBRARY / "manifest.json").read_text(encoding="utf-8"))
    known = {str(sound.get("id")) for sound in manifest.get("sounds", [])}
    clean = sorted({str(item) for item in removed if str(item) in known})
    payload = {"removed": clean, "updated": int(time.time())}
    target = SOUND_LIBRARY / "curation.json"
    temporary = target.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    temporary.replace(target)
    return jsonify(payload)


# ---------------------------------------------------------------------------
# Свои звуки: загруженный файл или кусок из видео — короткий звук или музыка на фон.
#
# Источник (аудио или видео) сохраняется на время работы в data/sounds/sources,
# готовые звуки — в data/sounds/own/<id>/ (в переносную версию не попадают).
# Громкость не переписывается в файл: сервер измеряет её и отдаёт поправку
# gain_db, а студия применяет её одинаково в предпросмотре и в готовом ролике.

SOUNDS_DATA = DATA / "sounds"
OWN_SOUNDS = SOUNDS_DATA / "own"
SOUND_SOURCES = SOUNDS_DATA / "sources"
for _folder in (OWN_SOUNDS, SOUND_SOURCES):
    _folder.mkdir(parents=True, exist_ok=True)
AUDIO_SUFFIXES = {".mp3", ".wav", ".m4a", ".aac", ".ogg", ".oga", ".opus", ".flac", ".wma", ".aif", ".aiff", ".caf", ".amr", ".3gp", ".mka"}
MAX_SOUND_SOURCE_BYTES = int(os.environ.get("REELLAB_MAX_SOUND_BYTES", 1024 * 1024 * 1024))
OWN_SFX_MAX_SECONDS = 20.0
OWN_MUSIC_MAX_SECONDS = 20 * 60.0
OWN_SFX_TARGET = -20.0    # самые громкие 400 мс, как у звуков слоя «Слово»
OWN_MUSIC_TARGET = -16.0  # средняя громкость трека (LUFS); дальше — бегунок громкости музыки
OWN_FILES = {"sfx": "v01.flac", "music": "music.m4a"}
OWN_SOUNDS_PER_USER = 80
SOURCE_KEEP_SECONDS = 3 * 24 * 3600
own_lock = threading.Lock()


def own_sounds_index() -> list[dict[str, Any]]:
    try:
        data = json.loads((OWN_SOUNDS / "index.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    items = data.get("sounds") if isinstance(data, dict) else None
    return [item for item in (items or []) if isinstance(item, dict) and valid_identifier(str(item.get("id", "")))]


def own_sound_visible(item: dict[str, Any], user_id: int | None = None) -> bool:
    """На сервере у каждого свои звуки: чужие не видны, их нельзя слушать, менять и удалять."""
    if not SERVER_MODE:
        return True
    owner = item.get("owner")
    wanted = current_user_id() if user_id is None else user_id
    return owner is not None and int(owner) == int(wanted)


def own_sounds_for(user_id: int | None = None) -> list[dict[str, Any]]:
    return [item for item in own_sounds_index() if own_sound_visible(item, user_id)]


def own_sound_entry(sound_id: str, user_id: int | None = None) -> dict[str, Any]:
    if not valid_identifier(sound_id):
        raise ReelLabError("Звук не найден.", 404)
    entry = next((item for item in own_sounds_index() if item.get("id") == sound_id), None)
    if entry is None or not own_sound_visible(entry, user_id):
        raise ReelLabError("Звук не найден.", 404)
    return entry


def save_own_sounds_index(items: list[dict[str, Any]]) -> None:
    target = OWN_SOUNDS / "index.json"
    temporary = target.with_suffix(".json.tmp")
    temporary.write_text(json.dumps({"sounds": items}, ensure_ascii=False, indent=1), encoding="utf-8")
    temporary.replace(target)


def clean_sound_label(value: Any, default: str) -> str:
    label = " ".join(str(value or "").replace("\x00", " ").split())[:60]
    return label or default


def probe_audio(path: Path) -> dict[str, Any]:
    result = run(["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_type,channels",
                  "-of", "json", str(path)], 90)
    if result.returncode:
        raise ReelLabError("Не удалось прочитать файл. Выберите другой.")
    try:
        data = json.loads(result.stdout or "{}")
        duration = float(data.get("format", {}).get("duration") or 0)
    except (ValueError, TypeError, json.JSONDecodeError):
        raise ReelLabError("Не удалось прочитать файл. Выберите другой.")
    audio = [item for item in data.get("streams", []) if item.get("codec_type") == "audio"]
    if not audio:
        raise ReelLabError("В файле нет звука.")
    if not math.isfinite(duration) or duration <= 0:
        raise ReelLabError("Не удалось прочитать длительность файла.")
    return {"duration": duration, "channels": int(audio[0].get("channels") or 2)}


def sound_source(args: Any) -> tuple[Path, str, str]:
    """Файл-источник: ?source=<id> (загруженный файл) или ?upload=<id> (видео из студии)."""
    upload_id = str(args.get("upload") or "").strip()
    source_id = str(args.get("source") or "").strip()
    if upload_id:
        row = fetch_upload(upload_id)
        path = Path(row["path"])
        if not path.is_file():
            raise ReelLabError("Исходное видео не найдено.", 404)
        if not bool(row["has_audio"]):
            raise ReelLabError("В этом видео нет звука.")
        return path, f"u{upload_id}", str(row["name"] or "видео")
    if not valid_identifier(source_id):
        raise ReelLabError("Файл со звуком не найден.", 404)
    try:
        meta = json.loads((SOUND_SOURCES / f"{source_id}.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        raise ReelLabError("Файл со звуком не найден. Загрузите его ещё раз.", 404)
    if SERVER_MODE and (meta.get("owner") is None or int(meta["owner"]) != current_user_id()):
        raise ReelLabError("Файл со звуком не найден.", 404)
    suffix = str(meta.get("suffix") or "")
    if suffix not in AUDIO_SUFFIXES | VIDEO_SUFFIXES:
        raise ReelLabError("Файл со звуком не найден.", 404)
    path = SOUND_SOURCES / f"{source_id}{suffix}"
    if not path.is_file():
        raise ReelLabError("Файл со звуком не найден. Загрузите его ещё раз.", 404)
    return path, source_id, str(meta.get("name") or "файл")


def cleanup_sound_sources() -> None:
    """Источники нужны, пока выбирается кусок; через три дня они удаляются."""
    limit = time.time() - SOURCE_KEEP_SECONDS
    for item in SOUND_SOURCES.iterdir():
        try:
            if item.is_file() and item.stat().st_mtime < limit:
                item.unlink()
        except OSError:
            pass


def measure_sound_gain(path: Path, kind: str) -> float:
    """Поправка громкости до общей нормы студии (EBU R128: momentary или integrated)."""
    result = run(["ffmpeg", "-nostdin", "-hide_banner", "-i", str(path), "-af", "ebur128=framelog=verbose",
                  "-f", "null", "-"], FFMPEG_TIMEOUT_SECONDS)
    text = result.stderr or ""
    if kind == "music":
        found = re.findall(r"\bI:\s*(-?\d+(?:\.\d+)?) LUFS", text)
        value = float(found[-1]) if found else None
        target = OWN_MUSIC_TARGET
    else:
        values = [float(item) for item in re.findall(r"\bM:\s*(-?\d+(?:\.\d+)?)", text)]
        value = max(values) if values else None
        target = OWN_SFX_TARGET
    peak = run(["ffmpeg", "-nostdin", "-hide_banner", "-i", str(path), "-af", "volumedetect", "-f", "null", "-"], FFMPEG_TIMEOUT_SECONDS)
    found = re.findall(r"max_volume:\s*(-?\d+(?:\.\d+)?) dB", peak.stderr or "")
    max_volume = float(found[-1]) if found else 0.0
    if not found or max_volume < -80:
        raise ReelLabError("В выделенном куске тишина. Выберите место, где есть звук.")
    # Очень короткий кусок — громкость по пику; в любом случае пик не поднимается выше 0 дБ.
    gain = -6.0 - max_volume if value is None or value < -69 else target - value
    gain = min(gain, -0.5 - max_volume)
    return round(max(-30.0, min(24.0, gain)), 2)


@app.get("/api/sounds/own")
def own_sounds_list():
    response = jsonify({"sounds": own_sounds_for()})
    response.headers["Cache-Control"] = "no-store"
    return response


@app.post("/api/sounds/sources")
def sound_source_upload():
    """Аудио- или видеофайл, из которого пользователь выберет кусок."""
    require_csrf()
    raw = Path(str(request.args.get("name") or "sound").replace("\x00", "").replace("\\", "/")).name.strip() or "sound"
    suffix = Path(raw).suffix.lower()
    if suffix not in AUDIO_SUFFIXES | VIDEO_SUFFIXES:
        raise ReelLabError("Подойдёт аудио (MP3, WAV, M4A, OGG, FLAC) или видео (MP4, MOV, WebM).")
    source_id = identifier()
    path = SOUND_SOURCES / f"{source_id}{suffix}"
    partial = SOUND_SOURCES / f".{source_id}.uploading"
    size = 0
    try:
        with partial.open("xb") as destination:
            while chunk := request.stream.read(UPLOAD_CHUNK_BYTES):
                size += len(chunk)
                if size > MAX_SOUND_SOURCE_BYTES:
                    raise ReelLabError("Файл слишком большой.", 413)
                destination.write(chunk)
        if not size:
            raise ReelLabError("Получен пустой файл.")
        os.replace(partial, path)
        info = probe_audio(path)
    except Exception:
        partial.unlink(missing_ok=True)
        path.unlink(missing_ok=True)
        raise
    name = raw[:120]
    (SOUND_SOURCES / f"{source_id}.json").write_text(
        json.dumps({"name": name, "suffix": suffix, "duration": info["duration"], "created": now(), "owner": current_user_id()},
                   ensure_ascii=False),
        encoding="utf-8")
    cleanup_sound_sources()
    return jsonify({"id": source_id, "name": name, "duration": info["duration"]}), 201


@app.get("/api/sounds/peaks")
def sound_peaks():
    """Очертание звука для выбора куска: n пиков от 0 до 1 и длительность."""
    path, key, name = sound_source(request.args)
    try:
        count = max(200, min(4000, int(request.args.get("n") or 1600)))
    except ValueError:
        count = 1600
    # Окно файла (для точного выбора куска) или весь файл (обзор, кэшируется).
    window: list[str] = []
    try:
        win_start = float(request.args.get("start")) if request.args.get("start") else None
        win_end = float(request.args.get("end")) if request.args.get("end") else None
    except ValueError:
        win_start = win_end = None
    if win_start is not None and win_end is not None and math.isfinite(win_start) and math.isfinite(win_end) and win_end > win_start >= 0:
        window = ["-ss", f"{win_start:.3f}", "-t", f"{min(win_end - win_start, 1800):.3f}"]
    cache = SOUND_SOURCES / f"{key}.peaks{count}.json"
    if not window and cache.is_file() and cache.stat().st_mtime >= path.stat().st_mtime:
        return send_file(cache, mimetype="application/json", max_age=0)
    rate = 8000 if window and (win_end - win_start) <= 60 else 2000
    try:
        completed = subprocess.run(
            ["ffmpeg", "-v", "error", "-nostdin", *window, "-i", str(path), "-vn", "-ac", "1", "-ar", str(rate), "-f", "s16le", "-"],
            capture_output=True, timeout=FFMPEG_TIMEOUT_SECONDS, check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except subprocess.TimeoutExpired:
        raise ReelLabError("Файл читается слишком долго.", 500)
    if completed.returncode:
        raise ReelLabError("Не удалось прочитать звук файла.")
    samples = array("h")
    data = completed.stdout
    samples.frombytes(data[: len(data) // 2 * 2])
    if sys.byteorder == "big":
        samples.byteswap()
    total = len(samples)
    peaks: list[int] = []
    if total:
        step = total / count
        for index in range(count):
            a = int(index * step)
            b = max(a + 1, int((index + 1) * step))
            chunk = samples[a:b]
            peaks.append(max(max(chunk), -min(chunk)) if len(chunk) else 0)
    if window:
        # Окно рисуется в том же масштабе громкости, что и обзор: делим на 32767, а не на свой максимум.
        payload = {"start": win_start, "duration": round(total / rate, 3), "peaks": [round(value / 32767, 3) for value in peaks]}
        return jsonify(payload)
    top = max(peaks) if peaks and max(peaks) > 0 else 1
    payload = {"duration": round(total / rate, 3), "peaks": [round(value / top, 3) for value in peaks], "name": name,
               "scale": round(top / 32767, 4)}
    cache.write_text(json.dumps(payload), encoding="utf-8")
    return jsonify(payload)


@app.get("/api/sounds/preview")
def sound_preview():
    """Звук источника для прослушивания в браузере (AAC), с перемоткой."""
    path, key, _name = sound_source(request.args)
    target = SOUND_SOURCES / f"{key}.preview.m4a"
    if not target.is_file() or target.stat().st_mtime < path.stat().st_mtime:
        temporary = SOUND_SOURCES / f".{key}.preview.tmp"
        result = run(["ffmpeg", "-v", "error", "-nostdin", "-y", "-i", str(path), "-vn", "-ac", "2", "-ar", "48000",
                      "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "-f", "mp4", str(temporary)],
                     FFMPEG_TIMEOUT_SECONDS)
        if result.returncode or not temporary.is_file():
            temporary.unlink(missing_ok=True)
            raise ReelLabError("Не удалось подготовить звук для прослушивания.", 500)
        temporary.replace(target)
    return send_file(target, mimetype="audio/mp4", conditional=True, max_age=0)


@app.post("/api/sounds/own")
def own_sound_create():
    """Вырезать кусок источника и сохранить как свой звук (sfx) или музыку (music)."""
    require_csrf()
    body = require_json()
    path, _key, source_name = sound_source(body)
    kind = "music" if body.get("kind") == "music" else "sfx"
    try:
        start = float(body.get("start") or 0)
        end = float(body.get("end") or 0)
    except (TypeError, ValueError):
        raise ReelLabError("Неверные границы куска.")
    if not (math.isfinite(start) and math.isfinite(end)) or start < 0 or end - start < 0.05:
        raise ReelLabError("Выделите кусок подлиннее.")
    if kind == "sfx" and end - start > OWN_SFX_MAX_SECONDS + 0.01:
        raise ReelLabError(f"Короткий звук — до {int(OWN_SFX_MAX_SECONDS)} секунд. Для длинного куска выберите «Музыка на фон».")
    if kind == "music" and end - start > OWN_MUSIC_MAX_SECONDS + 0.01:
        raise ReelLabError("Музыка — до 20 минут.")
    info = probe_audio(path)
    channels = 2 if info["channels"] >= 2 else 1
    owner = current_user_id()
    with own_lock:
        mine = own_sounds_for(owner)
        count = sum(1 for item in mine if item.get("kind", "sfx") == kind)
    if SERVER_MODE and len(mine) >= OWN_SOUNDS_PER_USER:
        raise ReelLabError(f"Своих звуков и музыки уже {OWN_SOUNDS_PER_USER}. Удали ненужные в «Мои звуки» — и добавляй новые.",
                           409, "own_sounds_full")
    default = f"Моя музыка {count + 1}" if kind == "music" else f"Мой звук {count + 1}"
    label = clean_sound_label(body.get("label"), default)
    sound_id = identifier()
    folder = OWN_SOUNDS / sound_id
    folder.mkdir(parents=True, exist_ok=False)
    output = folder / OWN_FILES[kind]
    try:
        clip = ["ffmpeg", "-v", "error", "-nostdin", "-y", "-ss", f"{start:.3f}", "-t", f"{end - start:.3f}", "-i", str(path), "-vn"]
        if kind == "sfx":
            # Тишина в начале убирается — звук попадает точно в момент; края плавные, без щелчков.
            filters = ("aresample=48000,silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.004,"
                       "afade=t=in:d=0.003,areverse,afade=t=in:d=0.015,areverse")
            command = clip + ["-af", filters, "-ac", str(channels), "-c:a", "flac", str(output)]
        else:
            command = clip + ["-af", "aresample=48000", "-ac", "2", "-c:a", "aac", "-b:a", "192k",
                              "-movflags", "+faststart", str(output)]
        result = run(command, FFMPEG_TIMEOUT_SECONDS)
        if result.returncode or not output.is_file() or output.stat().st_size < 64:
            raise ffmpeg_error("Не удалось вырезать звук. Попробуй другой кусок или другой файл.", result.stderr)
        seconds = probe_audio(output)["duration"]
        gain_db = measure_sound_gain(output, kind)
    except Exception:
        shutil.rmtree(folder, ignore_errors=True)
        raise
    entry = {
        "id": sound_id, "label": label, "kind": kind,
        "files": [f"/sounds/own/{sound_id}/{OWN_FILES[kind]}"],
        "seconds": round(seconds, 3), "gain_db": gain_db, "channels": channels if kind == "sfx" else 2,
        "created": now(), "owner": owner,
        "origin": {"name": source_name[:120], "start": round(start, 3), "end": round(end, 3)},
    }
    with own_lock:
        items = own_sounds_index()
        items.append(entry)
        save_own_sounds_index(items)
    return jsonify(entry), 201


@app.post("/api/sounds/own/<sound_id>")
def own_sound_rename(sound_id: str):
    require_csrf()
    if not valid_identifier(sound_id):
        raise ReelLabError("Звук не найден.", 404)
    body = require_json()
    with own_lock:
        items = own_sounds_index()
        entry = next((item for item in items if item.get("id") == sound_id), None)
        if entry is None or not own_sound_visible(entry):
            raise ReelLabError("Звук не найден.", 404)
        entry["label"] = clean_sound_label(body.get("label"), entry.get("label") or "Мой звук")
        save_own_sounds_index(items)
    return jsonify(entry)


@app.delete("/api/sounds/own/<sound_id>")
def own_sound_delete(sound_id: str):
    require_csrf()
    if not valid_identifier(sound_id):
        raise ReelLabError("Звук не найден.", 404)
    with own_lock:
        items = own_sounds_index()
        target = next((item for item in items if item.get("id") == sound_id), None)
        if target is None or not own_sound_visible(target):
            raise ReelLabError("Звук не найден.", 404)
        remaining = [item for item in items if item.get("id") != sound_id]
        save_own_sounds_index(remaining)
    shutil.rmtree(OWN_SOUNDS / sound_id, ignore_errors=True)
    return jsonify({"ok": True})


@app.get("/sounds/own/<sound_id>/<name>")
def own_sound_file(sound_id: str, name: str):
    if not valid_identifier(sound_id) or name not in OWN_FILES.values():
        return Response("Не найдено", 404)
    if SERVER_MODE:
        try:
            own_sound_entry(sound_id)
        except ReelLabError:
            return Response("Не найдено", 404)
    folder = OWN_SOUNDS / sound_id
    if not (folder / name).is_file():
        return Response("Не найдено", 404)
    mimetype = "audio/flac" if name.endswith(".flac") else "audio/mp4"
    return send_from_directory(folder, name, mimetype=mimetype, max_age=3600)


@app.get("/api/ai/settings")
def ai_settings_get():
    if SERVER_MODE:
        return jsonify({"configured": pictures_service.configured(), "provider": pictures_service.provider(),
                        "source": "server", "managed": True, "account_hint": ""})
    return jsonify(pictures_service.settings.public())


@app.post("/api/ai/settings")
def ai_settings_save():
    require_csrf()
    body = require_json()
    return jsonify(pictures_service.save_key(body.get("account_id"), body.get("api_token")))


@app.delete("/api/ai/settings")
def ai_settings_clear():
    require_csrf()
    pictures_service.settings.clear()
    return jsonify(pictures_service.settings.public())


@app.post("/api/pictures/plan")
def pictures_plan():
    require_csrf()
    body = require_json()
    with ai_meter("text", 40):
        return jsonify(pictures_service.plan(body.get("phrases"), str(body.get("density") or "medium")))


@app.post("/api/pictures/subject")
def pictures_subject():
    require_csrf()
    body = require_json()
    with ai_meter("text", 10):
        return jsonify(pictures_service.subject(body.get("word"), body.get("phrase"), body.get("description") or ""))


@app.post("/api/pictures/generate")
def pictures_generate():
    require_csrf()
    body = require_json()
    seed = body.get("seed")
    try:
        seed = int(seed) if seed is not None else None
    except (TypeError, ValueError):
        seed = None
    from accounts import AI_PRICES_KOP
    with ai_meter("image", AI_PRICES_KOP["image"]):
        return jsonify(pictures_service.generate(
            str(body.get("subject") or ""), str(body.get("style") or "cinema"), seed, int(body.get("size") or 512),
            fresh=bool(body.get("fresh", not SERVER_MODE)),
        ))


PICTURE_UPLOADS_PER_DAY = 120
_picture_uploads: dict[int, deque] = {}
_picture_uploads_lock = threading.Lock()


def _normalise_picture(data: bytes) -> bytes:
    """Своя картинка пересохраняется: не больше 1600 точек по стороне, PNG и WebP — в PNG (прозрачность), JPEG — в JPEG.

    Так по ссылке на картинку не раздать произвольный файл, и диск не забивается снимками по 12 МБ.
    """
    webp = data[:4] == b"RIFF" and data[8:12] == b"WEBP"
    png = data[:8] == b"\x89PNG\r\n\x1a\n" or webp   # у PNG и WebP может быть прозрачность — сохраняем в PNG
    if not (png or data[:3] == b"\xff\xd8\xff"):
        raise ReelLabError("Это не картинка. Подойдут JPG, PNG или WebP.")
    with tempfile.TemporaryDirectory(dir=str(PREPARED)) as folder:
        source = Path(folder) / "in.bin"
        target = Path(folder) / ("out.png" if png else "out.jpg")
        source.write_bytes(data)
        command = ["ffmpeg", "-v", "error", "-nostdin", "-y", "-i", str(source), "-frames:v", "1",
                   "-vf", "scale='min(1600,iw)':'min(1600,ih)':force_original_aspect_ratio=decrease"]
        command += ["-compression_level", "6", str(target)] if png else ["-q:v", "3", str(target)]
        result = run(command, 60)
        if result.returncode or not target.is_file() or target.stat().st_size < 64:
            raise ffmpeg_error("Картинка не открылась. Попробуй другой файл.", result.stderr, 400)
        return target.read_bytes()


@app.post("/api/pictures/upload")
def pictures_upload():
    require_csrf()
    file = request.files.get("image")
    if file is None:
        raise ReelLabError("Выбери картинку.")
    data = file.read(12 * 1024 * 1024 + 1)
    if len(data) > 12 * 1024 * 1024:
        raise ReelLabError("Картинка больше 12 МБ — выбери файл поменьше.", 413)
    if SERVER_MODE:
        user_id = current_user_id()
        stamp = time.time()
        with _picture_uploads_lock:
            recent = _picture_uploads.setdefault(user_id, deque())
            while recent and stamp - recent[0] > 86400:
                recent.popleft()
            if len(recent) >= PICTURE_UPLOADS_PER_DAY and not getattr(g, "is_admin", False):
                raise ReelLabError("Своих картинок на сегодня хватит. Завтра можно будет добавить ещё.", 429, "pictures_cap")
            recent.append(stamp)
        PREPARED.mkdir(parents=True, exist_ok=True)
        data = _normalise_picture(data)
    return jsonify(pictures_service.store_upload(data))


@app.get("/api/pictures/file/<name>")
def pictures_file(name: str):
    path = pictures_service.file_path(name)
    if path is None:
        raise ReelLabError("Картинка не найдена.", 404)
    response = send_file(path, conditional=True, max_age=31536000)
    response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    return response


@app.get("/api/bootstrap")
def bootstrap():
    with database() as conn:
        rows = list_user_jobs(conn)
    if SERVER_MODE:
        return jsonify({
            "principal": f"tg:{current_user_id()}", "csrf": g.csrf, "mode": "server",
            "jobs": [serialize_job(row) for row in rows], "queue": queue(), "me": me_payload(),
        })
    return jsonify({
        "principal": "local-owner", "csrf": csrf, "capabilities": CAPABILITIES,
        "draft": get_draft(), "jobs": [serialize_job(row) for row in rows],
        "queue": queue(), "telegram": None, "admin": False,
        "usage": usage_data(), "upload_selection": [], "mode": "local",
    })


def me_payload(user_id: int | None = None) -> dict[str, Any]:
    """Тариф, остатки и способы оплаты — для плашки и окна тарифов в студии."""
    from accounts import PRODUCTS
    status = accounts.status(current_user_id() if user_id is None else int(user_id))
    status["products"] = [
        {"id": key, "title": item["title"], "text": item["text"], "rub": item["rub"], "stars": item["stars"]}
        for key, item in PRODUCTS.items()
    ]
    status["payments"] = billing.methods() if billing is not None else {"stars": False, "card": False}
    status["bot"] = BOT_USERNAME
    return status


@app.get("/api/me")
def me():
    if not SERVER_MODE:
        return jsonify({"plan": "local", "watermark": False, "mode": "local"})
    return jsonify(me_payload())


@app.get("/api/public/config")
def public_config():
    """Что нужно странице до входа: режим, имя бота."""
    return jsonify({"mode": "server" if SERVER_MODE else "local", "bot": BOT_USERNAME})


@app.get("/api/health")
def health():
    """Small unauthenticated check used by the local Windows launcher."""
    return jsonify({"ok": True, "service": "Reel Lab" if SERVER_MODE else "Reel Lab Local", "ready_captions": 3,
                    "build": SERVER_BUILD, "mode": "server" if SERVER_MODE else "local"})


@app.post("/api/session")
def session():
    """Локально — общий ключ студии. На сервере — вход по подписанным данным Telegram."""
    if not SERVER_MODE:
        return jsonify({"principal": "local-owner", "csrf": csrf, "mode": "local"})
    body = request.get_json(silent=True) or {}
    init_data = str(body.get("init_data") or "")
    if not init_data:
        raise ReelLabError("Открой студию кнопкой в боте Telegram.", 401, "auth_required")
    try:
        trusted = validate_telegram_webapp_init_data(init_data, BOT_TOKEN, max_age_seconds=24 * 3600)
    except TelegramInitDataError:
        raise ReelLabError("Вход через Telegram не подтвердился. Закрой студию и открой её из бота ещё раз.",
                           401, "auth_invalid")
    start_param = str(trusted.parameters.get("start_param") or body.get("start_param") or "")[:64]
    user = accounts.touch_user(trusted.user, ref=start_param)
    token, session_csrf = accounts.create_session(int(user["id"]))
    response = jsonify({
        "principal": f"tg:{user['id']}", "csrf": session_csrf, "token": token, "mode": "server",
        "me": me_payload(int(user["id"])),
    })
    response.set_cookie(SESSION_COOKIE, token, max_age=30 * 24 * 3600, httponly=True, secure=True,
                        samesite="None", path="/")
    return response


@app.post("/api/draft")
def draft():
    require_csrf()
    return jsonify({"ok": True, "draft": save_draft(require_json())})


@app.get("/api/upload-session")
def upload_session():
    if SERVER_MODE:
        status = accounts.status(current_user_id())
        return jsonify({"principal": f"tg:{current_user_id()}", "csrf": g.csrf, "mode": "server",
                        "limits": {"max_bytes": MAX_BYTES, "max_seconds": status["max_source_seconds"]}})
    return jsonify({"principal": "local-owner", "csrf": csrf, "limits": CAPABILITIES["limits"]})


def upload_name_and_suffix(raw_name: Any) -> tuple[str, str]:
    # The file itself is stored under a generated id, so retain a safe display
    # name (including Cyrillic) instead of turning "видео.mp4" into "mp4".
    file_name = Path(str(raw_name or "video.mp4").replace("\x00", "").replace("\\", "/")).name.strip()
    if not file_name or file_name in {".", ".."}:
        file_name = "video.mp4"
    suffix = Path(file_name).suffix.lower()
    if suffix not in VIDEO_SUFFIXES:
        raise ReelLabError("Поддерживаются MP4, MOV, M4V, WebM, MKV и AVI.")
    if len(file_name) > 240:
        file_name = f"{Path(file_name).stem[:max(1, 240 - len(suffix))]}{suffix}"
    return file_name, suffix


def caption_name_and_suffix(raw_name: Any) -> tuple[str, str]:
    """Retain a readable name but accept only local text subtitle formats."""
    file_name = Path(str(raw_name or "subtitles.srt").replace("\x00", "").replace("\\", "/")).name.strip()
    if not file_name or file_name in {".", ".."}:
        file_name = "subtitles.srt"
    suffix = Path(file_name).suffix.lower()
    if suffix not in CAPTION_SUFFIXES:
        raise ReelLabError("Поддерживаются файлы субтитров SRT, VTT и ASS.")
    if len(file_name) > 240:
        file_name = f"{Path(file_name).stem[:max(1, 240 - len(suffix))]}{suffix}"
    return file_name, suffix


def check_server_upload(info: dict[str, Any], user_id: int | None = None) -> None:
    """Сервер: длина видео по тарифу и разумное число загрузок в сутки."""
    user_id = current_user_id() if user_id is None else int(user_id)
    status = accounts.status(user_id)
    limit = int(status["max_source_seconds"])
    if not status["admin"] and info["duration"] > limit + 1:
        if status["plan"] == "free":
            raise AccountsError(
                f"Бесплатно можно загрузить видео до {limit // 60} минут (готовый ролик — до 1 минуты). "
                "Обрежь видео в галерее телефона или выбери тариф.", 413, "source_too_long_free")
        raise AccountsError(f"Видео длиннее {limit // 60} минут. Обрежь его перед загрузкой.", 413, "source_too_long")
    with database() as conn:
        count = conn.execute("SELECT COUNT(*) n FROM uploads WHERE user_id=? AND created>=?",
                             (user_id, now() - 86400)).fetchone()["n"]
    cap = 300 if status["admin"] else 40 if status["plan"] == "free" else 200
    if int(count) >= cap:
        raise AccountsError("Слишком много загрузок за сутки. Попробуй позже или напиши в поддержку.", 429, "upload_cap")


def store_upload(upload_id: str, path: Path, file_name: str, size_bytes: int, user_id: int) -> dict[str, Any]:
    """Проверить файл на диске и записать его как загрузку человека (студия, бот)."""
    try:
        info = probe(path)
        if info["duration"] > MAX_SECONDS:
            raise ReelLabError(f"Видео длиннее лимита: {MAX_SECONDS // 60} мин.")
        if SERVER_MODE:
            check_server_upload(info, user_id)
    except Exception:
        path.unlink(missing_ok=True)
        raise
    with lock, database() as conn:
        conn.execute(
            """INSERT INTO uploads(id,name,path,mime,size_bytes,duration,width,height,has_audio,created,user_id,last_used)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",
            (upload_id, file_name, str(path), mimetypes.guess_type(file_name)[0], size_bytes,
             info["duration"], info["width"], info["height"], int(info["has_audio"]), now(), int(user_id), now()),
        )
    if SERVER_MODE:
        prepare_render_copy_later(upload_id)
    return {
        "id": upload_id, "name": file_name,
        "media": {"duration_seconds": info["duration"], "size_bytes": size_bytes,
                  "width": info["width"], "height": info["height"], "has_audio": bool(info["has_audio"])},
    }


def register_upload(upload_id: str, path: Path, file_name: str, size_bytes: int):
    """Проверить загруженный файл и записать его: общий конец обычной и частичной загрузки."""
    return jsonify(store_upload(upload_id, path, file_name, size_bytes, current_user_id())), 201


@app.get("/api/uploads/<upload_id>")
def upload_info(upload_id: str):
    """Сведения о своём видео на сервере: студия открывает видео, присланное боту, без повторной загрузки."""
    row = fetch_upload(upload_id)
    if not Path(row["path"]).is_file():
        raise ReelLabError("Видео уже удалено с сервера. Пришли его ещё раз.", 404)
    return jsonify({"id": row["id"], "name": row["name"], "mime": row["mime"] or "video/mp4",
                    "size_bytes": int(row["size_bytes"] or 0), "duration_seconds": float(row["duration"] or 0),
                    "width": int(row["width"] or 0), "height": int(row["height"] or 0),
                    "has_audio": bool(row["has_audio"]), "url": f"/api/uploads/{row['id']}/file"})


@app.post("/api/uploads")
def upload():
    require_csrf()
    file_name, suffix = upload_name_and_suffix(request.args.get("name"))
    upload_id = identifier()
    path = UPLOADS / f"{upload_id}{suffix}"
    partial_path = UPLOADS / f".{upload_id}.uploading"
    size_bytes = 0
    try:
        with partial_path.open("xb") as destination:
            while chunk := request.stream.read(UPLOAD_CHUNK_BYTES):
                size_bytes += len(chunk)
                if size_bytes > MAX_BYTES:
                    raise RequestEntityTooLarge()
                destination.write(chunk)
        if not size_bytes:
            raise ReelLabError("Получен пустой файл.")
        os.replace(partial_path, path)
    except Exception:
        partial_path.unlink(missing_ok=True)
        path.unlink(missing_ok=True)
        raise
    return register_upload(upload_id, path, file_name, size_bytes)


# --- Загрузка частями: с телефона по мобильной сети. Оборвалась связь —
# студия спрашивает, сколько дошло, и докачивает с этого места.

CHUNKED = UPLOADS / ".chunked"
CHUNK_BYTES = 8 * 1024 * 1024
_chunk_lock = threading.Lock()


def _chunk_meta(key: str) -> tuple[Path, dict[str, Any]]:
    if not re.fullmatch(r"[A-Za-z0-9_-]{16,64}", key or ""):
        raise ReelLabError("Загрузка не найдена.", 404)
    meta_path = CHUNKED / f"{key}.json"
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise ReelLabError("Загрузка не найдена или устарела. Выбери видео ещё раз.", 404)
    if int(meta.get("user_id", -1)) != current_user_id():
        raise ReelLabError("Загрузка не найдена.", 404)
    return meta_path, meta


CHUNK_SESSIONS_PER_USER = 4      # одновременных загрузок частями у одного человека
CHUNK_IDLE_SECONDS = 10 * 60     # загрузка без новых частей дольше — брошена


def _trim_chunk_sessions(user_id: int) -> None:
    """Перед новой загрузкой частями: брошенные загрузки этого человека — в корзину, лишние — отказ.

    Иначе можно начать сотню загрузок по 2 ГБ и занять весь диск.
    """
    stamp = time.time()
    active = []
    with _chunk_lock:
        for meta_path in CHUNKED.glob("*.json"):
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if int(meta.get("user_id") or -1) != int(user_id):
                continue
            part = meta_path.with_suffix(".part")
            try:
                touched = max(meta_path.stat().st_mtime, part.stat().st_mtime if part.exists() else 0)
            except OSError:
                continue
            if stamp - touched > CHUNK_IDLE_SECONDS:
                part.unlink(missing_ok=True)
                meta_path.unlink(missing_ok=True)
            else:
                active.append(meta_path)
    if len(active) >= CHUNK_SESSIONS_PER_USER:
        raise ReelLabError("Уже идут несколько загрузок. Дождись, пока они закончатся, — и выбирай следующее видео.",
                           429, "uploads_busy")


@app.post("/api/uploads/chunked")
def chunked_start():
    require_csrf()
    body = require_json()
    file_name, suffix = upload_name_and_suffix(body.get("name"))
    try:
        size = int(body.get("size") or 0)
    except (TypeError, ValueError):
        size = 0
    if size <= 0:
        raise ReelLabError("Получен пустой файл.")
    if size > MAX_BYTES:
        raise ReelLabError(f"Файл больше {MAX_BYTES // 1024 // 1024} МБ. Выбери видео покороче.", 413)
    CHUNKED.mkdir(parents=True, exist_ok=True)
    if SERVER_MODE:
        _trim_chunk_sessions(current_user_id())
    key = secrets.token_urlsafe(18)
    meta = {"user_id": current_user_id(), "name": file_name, "suffix": suffix, "size": size, "received": 0,
            "created": now()}
    (CHUNKED / f"{key}.part").write_bytes(b"")
    (CHUNKED / f"{key}.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
    return jsonify({"key": key, "chunk_bytes": CHUNK_BYTES, "received": 0, "size": size})


@app.get("/api/uploads/chunked/<key>")
def chunked_status(key: str):
    _, meta = _chunk_meta(key)
    return jsonify({"received": int(meta["received"]), "size": int(meta["size"])})


@app.put("/api/uploads/chunked/<key>")
def chunked_part(key: str):
    require_csrf()
    with _chunk_lock:
        meta_path, meta = _chunk_meta(key)
        try:
            offset = int(request.args.get("offset", "-1"))
        except ValueError:
            offset = -1
        if offset != int(meta["received"]):
            return jsonify({"error": "Часть пришла не по порядку.", "code": "offset", "received": int(meta["received"])}), 409
        part = CHUNKED / f"{key}.part"
        written = 0
        with part.open("r+b") as handle:
            handle.truncate(offset)
            handle.seek(offset)
            while chunk := request.stream.read(UPLOAD_CHUNK_BYTES):
                written += len(chunk)
                if written > CHUNK_BYTES + 1024 or offset + written > int(meta["size"]):
                    handle.truncate(offset)
                    raise ReelLabError("Часть файла больше ожидаемой.", 413)
                handle.write(chunk)
        meta["received"] = offset + written
        meta_path.write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
    return jsonify({"received": int(meta["received"]), "size": int(meta["size"])})


@app.post("/api/uploads/chunked/<key>/finish")
def chunked_finish(key: str):
    require_csrf()
    with _chunk_lock:
        meta_path, meta = _chunk_meta(key)
        if int(meta["received"]) != int(meta["size"]):
            return jsonify({"error": "Файл загружен не полностью.", "code": "incomplete",
                            "received": int(meta["received"])}), 409
        upload_id = identifier()
        path = UPLOADS / f"{upload_id}{meta['suffix']}"
        os.replace(CHUNKED / f"{key}.part", path)
        meta_path.unlink(missing_ok=True)
    return register_upload(upload_id, path, meta["name"], int(meta["size"]))


@app.get("/api/uploads/<upload_id>/file")
def upload_file(upload_id: str):
    """Загруженное видео целиком (с перемоткой): студия открывает им сохранённый проект."""
    row = fetch_upload(upload_id)
    path = Path(row["path"])
    if not path.is_file():
        raise ReelLabError("Видео этого проекта уже удалено с сервера. Выбери тот же файл ещё раз.", 410, "upload_gone")
    _touch_uploads([row["id"]])
    mime = row["mime"] or mimetypes.guess_type(row["name"])[0] or "video/mp4"
    response = send_file(path, mimetype=mime, conditional=True, max_age=0)
    response.headers["Cache-Control"] = "private, max-age=3600"
    return response


# --- Проекты: автосохранение монтажа ---------------------------------------
# Студия сама сохраняет проект каждые несколько секунд: текст, стиль, монтаж,
# звуки, эффекты. Сами видео лежат в uploads; здесь — только описание (JSON).
# Пока проект правят, его видео не удаляются уборкой (last_used обновляется).

PROJECT_ID = re.compile(r"[a-z0-9]{12,40}")
MAX_PROJECT_BYTES = 8 * 1024 * 1024
PROJECTS_PER_USER = 20
PROJECT_KEEP_SECONDS = 30 * 24 * 3600
_upload_touched: dict[str, int] = {}


def _touch_uploads(ids: list[str]) -> None:
    """Видео, с которыми работают, — «свежие»: уборка их не тронет. Не чаще раза в 10 минут."""
    stamp = now()
    fresh = [item for item in dict.fromkeys(ids) if valid_identifier(item) and stamp - _upload_touched.get(item, 0) > 600]
    if not fresh:
        return
    for item in fresh:
        _upload_touched[item] = stamp
    with lock, database() as conn:
        conn.executemany("UPDATE uploads SET last_used=? WHERE id=? AND user_id=?",
                         [(stamp, item, current_user_id()) for item in fresh])


def _project_upload_ids(data: dict[str, Any]) -> list[str]:
    video = data.get("video") if isinstance(data.get("video"), dict) else {}
    ids = [str(video.get("uploadId") or "")]
    montage_data = data.get("montage") if isinstance(data.get("montage"), dict) else {}
    for media in montage_data.get("media") or []:
        if isinstance(media, dict):
            ids.append(str(media.get("uploadId") or ""))
    return [item for item in dict.fromkeys(ids) if valid_identifier(item)][:80]


def _uploads_present(ids: list[str]) -> dict[str, bool]:
    """Какие из видео проекта ещё лежат на сервере (свои, файл на месте)."""
    if not ids:
        return {}
    marks = ",".join("?" for _ in ids)
    with database() as conn:
        rows = conn.execute(f"SELECT id, path FROM uploads WHERE user_id=? AND id IN ({marks})",
                            (current_user_id(), *ids)).fetchall()
    found = {row["id"]: Path(row["path"]).is_file() for row in rows}
    return {item: bool(found.get(item)) for item in ids}


def _fetch_project(project_id: str) -> sqlite3.Row:
    if not PROJECT_ID.fullmatch(project_id or ""):
        raise ReelLabError("Проект не найден.", 404, "project_missing")
    with database() as conn:
        row = conn.execute("SELECT * FROM projects WHERE id=? AND user_id=?", (project_id, current_user_id())).fetchone()
    if row is None:
        raise ReelLabError("Проект не найден.", 404, "project_missing")
    return row


def _project_name(value: Any) -> str:
    name = re.sub(r"\s+", " ", str(value or "").replace("\x00", "")).strip()
    return name[:120] or "Проект"


@app.get("/api/projects")
def projects_list():
    with database() as conn:
        rows = conn.execute(
            "SELECT id, name, upload_id, duration, summary, created, updated FROM projects "
            "WHERE user_id=? ORDER BY updated DESC LIMIT ?", (current_user_id(), PROJECTS_PER_USER)).fetchall()
    summaries = [load(row["summary"], {}) for row in rows]
    wanted: list[str] = []
    for row, summary in zip(rows, summaries):
        wanted.append(row["upload_id"] or "")
        wanted.extend(str(item) for item in summary.get("media") or [])
    present = _uploads_present([item for item in dict.fromkeys(wanted) if valid_identifier(item)])
    items = []
    for row, summary in zip(rows, summaries):
        media = [str(item) for item in summary.get("media") or [] if valid_identifier(str(item))]
        items.append({
            "id": row["id"], "name": row["name"], "duration": row["duration"], "created": row["created"],
            "updated": row["updated"], "summary": {key: summary.get(key) for key in ("cues", "words", "inserts", "overlays", "audios", "lyrics")},
            "video": {"name": summary.get("video_name") or row["name"], "size": summary.get("video_size") or 0,
                      "modified": summary.get("video_modified") or 0, "ok": bool(present.get(row["upload_id"] or ""))},
            "missing": sum(1 for item in media if not present.get(item)),
        })
    return jsonify({"projects": items, "keep_hours": UPLOAD_KEEP_SECONDS // 3600 if SERVER_MODE else 0})


@app.get("/api/projects/<project_id>")
def project_get(project_id: str):
    row = _fetch_project(project_id)
    data = load(row["data"], {})
    ids = _project_upload_ids(data)
    present = _uploads_present(ids)
    _touch_uploads([item for item in ids if present.get(item)])
    # Данные отдаём ровно как сохранены (jsonify переставил бы ключи по алфавиту).
    head = dump({"id": row["id"], "name": row["name"], "updated": row["updated"], "files": present})
    return Response(f'{head[:-1]},"data":{row["data"]}}}', mimetype="application/json")


@app.put("/api/projects/<project_id>")
def project_save(project_id: str):
    require_csrf()
    if not PROJECT_ID.fullmatch(project_id or ""):
        raise ReelLabError("Проект не найден.", 404, "project_missing")
    if (request.content_length or 0) > MAX_PROJECT_BYTES:
        raise ReelLabError("Проект слишком большой для автосохранения.", 413, "project_too_big")
    body = require_json()
    data = body.get("data")
    if not isinstance(data, dict):
        raise ReelLabError("Нет данных проекта.")
    text = dump(data)
    if len(text.encode("utf-8")) > MAX_PROJECT_BYTES:
        raise ReelLabError("Проект слишком большой для автосохранения.", 413, "project_too_big")
    video = data.get("video") if isinstance(data.get("video"), dict) else {}
    upload_id = str(video.get("uploadId") or "")
    upload_id = upload_id if valid_identifier(upload_id) else None
    ids = _project_upload_ids(data)
    raw_summary = body.get("summary") if isinstance(body.get("summary"), dict) else {}
    summary = {key: int(raw_summary.get(key) or 0) for key in ("cues", "words", "inserts", "overlays", "audios")
               if isinstance(raw_summary.get(key), (int, float))}
    summary["lyrics"] = bool(raw_summary.get("lyrics"))
    summary["media"] = [item for item in ids if item != upload_id]
    summary["video_name"] = _project_name(video.get("name"))
    try:
        summary["video_size"] = max(0, int(video.get("size") or 0))
        summary["video_modified"] = max(0, int(video.get("lastModified") or 0))
    except (TypeError, ValueError):
        summary["video_size"] = summary["video_modified"] = 0
    try:
        duration = max(0.0, min(float(video.get("duration") or 0), 24 * 3600.0))
    except (TypeError, ValueError):
        duration = 0.0
    stamp = now()
    user_id = current_user_id()
    with lock, database() as conn:
        owner = conn.execute("SELECT user_id FROM projects WHERE id=?", (project_id,)).fetchone()
        if owner is not None and int(owner["user_id"]) != user_id:
            raise ReelLabError("Проект не найден.", 404, "project_missing")
        conn.execute(
            """INSERT INTO projects(id,user_id,name,upload_id,duration,summary,data,size_bytes,created,updated)
               VALUES(?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(id) DO UPDATE SET name=excluded.name, upload_id=excluded.upload_id,
               duration=excluded.duration, summary=excluded.summary, data=excluded.data,
               size_bytes=excluded.size_bytes, updated=excluded.updated""",
            (project_id, user_id, _project_name(body.get("name") or video.get("name")), upload_id, duration,
             dump(summary), text, len(text), stamp, stamp))
        conn.execute(
            "DELETE FROM projects WHERE user_id=? AND id NOT IN "
            "(SELECT id FROM projects WHERE user_id=? ORDER BY updated DESC LIMIT ?)",
            (user_id, user_id, PROJECTS_PER_USER))
    _touch_uploads(ids)
    return jsonify({"ok": True, "id": project_id, "updated": stamp})


@app.delete("/api/projects/<project_id>")
def project_delete(project_id: str):
    require_csrf()
    row = _fetch_project(project_id)
    with lock, database() as conn:
        conn.execute("DELETE FROM projects WHERE id=? AND user_id=?", (row["id"], current_user_id()))
    return jsonify({"ok": True})


@app.post("/api/captions")
def upload_captions():
    """Store a user-supplied subtitle file as canonical SRT for a later job."""
    require_csrf()
    file_name, suffix = caption_name_and_suffix(request.args.get("name"))
    caption_id = identifier()
    partial_path = CAPTIONS / f".{caption_id}.uploading"
    path = CAPTIONS / f"{caption_id}.srt"
    size_bytes = 0
    try:
        with partial_path.open("xb") as destination:
            while chunk := request.stream.read(UPLOAD_CHUNK_BYTES):
                size_bytes += len(chunk)
                if size_bytes > MAX_CAPTION_BYTES:
                    raise ReelLabError("Файл субтитров больше 8 МБ.", 413)
                destination.write(chunk)
        if not size_bytes:
            raise ReelLabError("Получен пустой файл субтитров.")
        cues = parse_imported_caption(partial_path.read_bytes(), suffix)
        write_srt_cues(path, cues)
    except Exception:
        path.unlink(missing_ok=True)
        raise
    finally:
        partial_path.unlink(missing_ok=True)
    with lock, database() as conn:
        conn.execute(
            """INSERT INTO captions(id,name,path,source_format,size_bytes,cue_count,created,user_id)
               VALUES(?,?,?,?,?,?,?,?)""",
            (caption_id, file_name, str(path), suffix.lstrip("."), size_bytes, len(cues), now(), current_user_id()),
        )
    return jsonify({
        "id": caption_id, "name": file_name,
        "subtitle": {"format": suffix.lstrip("."), "size_bytes": size_bytes, "cue_count": len(cues)},
    }), 201


@app.get("/api/jobs")
def list_jobs():
    with database() as conn:
        rows = list_user_jobs(conn)
    return jsonify({"jobs": [serialize_job(row) for row in rows], "queue": queue()})


@app.post("/api/jobs")
def create_job_route():
    require_csrf()
    body = require_json()
    if not isinstance(body.get("upload_id"), str) or not isinstance(body.get("settings"), dict):
        raise ReelLabError("Не переданы настройки или исходное видео.")
    request_id = body.get("request_id")
    if request_id is not None and (not isinstance(request_id, str) or len(request_id) > 100):
        raise ReelLabError("Некорректный ключ запуска.")
    settings = dict(body["settings"])
    if "caption_id" in body:
        settings["caption_id"] = body["caption_id"]
    return jsonify(serialize_job(create_job(body["upload_id"], settings, request_id)))


@app.post("/api/uploads/<upload_id>/transcription")
def create_transcription_route(upload_id: str):
    """Queue captions: Russian with local GigaAM, other languages with Whisper (Cloudflare)."""
    require_csrf()
    body = require_json()
    request_id = body.get("request_id")
    if not isinstance(request_id, str) or not 1 <= len(request_id) <= 100:
        raise ReelLabError("Для распознавания нужен ключ запроса.")
    language = str(body.get("language") or "ru").strip().lower()
    if language != "ru" and language not in CLOUD_SPEECH_LANGUAGES:
        raise ReelLabError("Этот язык речи пока не поддерживается.")
    upload = fetch_upload(upload_id)
    if not bool(upload["has_audio"]):
        raise ReelLabError("В выбранном ролике нет звука, поэтому субтитры создать нельзя.")
    if SERVER_MODE:
        accounts.check_transcription(current_user_id(), f"{current_user_id()}:{request_id}"[:120],
                                     float(upload["duration"] or 0))
    job = create_job(upload_id, {"caption_enabled": True, "language": language}, request_id, kind="transcription")
    return jsonify(serialize_job(job)), 202


@app.post("/api/montage/transcription")
def montage_transcription():
    """Речь во всех видео ролика: основное и вставки по порядку — текст встаёт по времени готового ролика."""
    require_csrf()
    body = require_json()
    request_id = body.get("request_id")
    if not isinstance(request_id, str) or not 1 <= len(request_id) <= 100:
        raise ReelLabError("Для распознавания нужен ключ запроса.")
    language = str(body.get("language") or "ru").strip().lower()
    if language != "ru" and language not in CLOUD_SPEECH_LANGUAGES:
        raise ReelLabError("Этот язык речи пока не поддерживается.")
    upload = fetch_upload(str(body.get("upload_id") or ""))
    main = Path(upload["path"])
    if not main.is_file():
        raise ReelLabError("Видео уже удалено с сервера. Выбери его ещё раз.", 404)
    plan = normalise_montage(body.get("montage"), float(upload["duration"] or 0))
    if plan is None:
        raise ReelLabError("В ролике одно видео — распознаю его как обычно.", 400, "no_montage")
    raw_skips = body.get("skips") if isinstance(body.get("skips"), list) else []
    try:
        skips = [(float(item.get("start", 0)), float(item.get("end", 0))) for item in raw_skips[:2000] if isinstance(item, dict)]
    except (TypeError, ValueError):
        raise ReelLabError("Неверные вырезанные куски.")
    upload_id = identifier()
    path = UPLOADS / f"{upload_id}.mp4"
    try:
        seconds = montage_speech_audio(main, bool(upload["has_audio"]), plan, skips, path)
        if seconds < 0.5:
            raise ReelLabError("Ролик слишком короткий для распознавания.")
        info = probe(path)
        if SERVER_MODE:
            accounts.check_transcription(current_user_id(), f"{current_user_id()}:{request_id}"[:120], float(info["duration"]))
        with lock, database() as conn:
            conn.execute(
                """INSERT INTO uploads(id,name,path,mime,size_bytes,duration,width,height,has_audio,created,user_id,last_used)
                   VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",
                (upload_id, "весь ролик.mp4", str(path), "video/mp4", path.stat().st_size, info["duration"],
                 info["width"], info["height"], int(info["has_audio"]), now(), current_user_id(), now()),
            )
    except BaseException:
        path.unlink(missing_ok=True)   # без записи в базе файл никто бы не убрал
        raise
    job = create_job(upload_id, {"caption_enabled": True, "language": language}, request_id, kind="transcription")
    payload = serialize_job(job)
    payload["seconds"] = round(seconds, 3)
    return jsonify(payload), 202


@app.post("/api/sounds/own/<sound_id>/transcription")
def own_sound_transcription(sound_id: str):
    """Слова из музыки на ленте (нашид): кусок звука распознаётся так же, как видео.

    Звук готовится для распознавания: полоса голоса, ровная громкость, а замедленный трек
    (slowed) возвращается к обычной скорости. Ответ несёт speed: время слов умножается на него.
    """
    require_csrf()
    body = require_json()
    request_id = body.get("request_id")
    if not isinstance(request_id, str) or not 1 <= len(request_id) <= 100:
        raise ReelLabError("Для распознавания нужен ключ запроса.")
    language = str(body.get("language") or "ru").strip().lower()
    if language != "ru" and language not in CLOUD_SPEECH_LANGUAGES:
        raise ReelLabError("Этот язык речи пока не поддерживается.")
    own_sound_entry(sound_id)
    folder = OWN_SOUNDS / sound_id
    source = next((folder / name for name in OWN_FILES.values() if (folder / name).is_file()), None)
    if source is None:
        raise ReelLabError("Звук не найден. Добавь его на ленту ещё раз.", 404)
    duration = float(probe_audio(source)["duration"] or 0)
    try:
        start = max(0.0, float(body.get("start") or 0))
        end = min(duration, float(body.get("end") or duration))
    except (TypeError, ValueError):
        raise ReelLabError("Неверные границы звука.")
    if end - start < 0.5:
        raise ReelLabError("Кусок звука слишком короткий для распознавания.")
    speed = 1.25 if body.get("slowed") else 1.0
    filters = "aresample=48000,"
    if speed != 1.0:
        filters += f"asetrate={int(48000 * speed)},aresample=48000,"
    filters += "highpass=f=110,lowpass=f=6500,dynaudnorm=f=200:g=11"
    upload_id = identifier()
    path = UPLOADS / f"{upload_id}.mp4"
    command = ["ffmpeg", "-v", "error", "-nostdin", "-y", "-ss", f"{start:.3f}", "-t", f"{end - start:.3f}", "-i", str(source),
               "-f", "lavfi", "-i", "color=c=black:s=16x16:r=2", "-map", "1:v", "-map", "0:a", "-af", filters, "-shortest",
               "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", str(path)]
    result = run(command, FFMPEG_TIMEOUT_SECONDS)
    if result.returncode or not path.is_file():
        path.unlink(missing_ok=True)
        raise ffmpeg_error("Не удалось подготовить звук для распознавания.", result.stderr)
    try:
        info = probe(path)
        if SERVER_MODE:
            accounts.check_transcription(current_user_id(), f"{current_user_id()}:{request_id}"[:120], float(info["duration"]))
        with lock, database() as conn:
            conn.execute(
                """INSERT INTO uploads(id,name,path,mime,size_bytes,duration,width,height,has_audio,created,user_id,last_used)
                   VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",
                (upload_id, f"звук {sound_id}.mp4", str(path), "video/mp4", path.stat().st_size, info["duration"],
                 info["width"], info["height"], int(info["has_audio"]), now(), current_user_id(), now()),
            )
    except BaseException:
        path.unlink(missing_ok=True)   # без записи в базе файл никто бы не убрал
        raise
    job = create_job(upload_id, {"caption_enabled": True, "language": language, "music": True}, request_id, kind="transcription")
    payload = serialize_job(job)
    payload["speed"] = speed
    return jsonify(payload), 202


_STYLE_ID = re.compile(r"^[a-z0-9-]{1,40}$")


@app.post("/api/render-jobs")
def create_render_job_route():
    """Queue a server-side render of the chosen subtitle style."""
    require_csrf()
    body = require_json()
    request_id = body.get("request_id")
    upload_id = body.get("upload_id")
    spec = body.get("spec")
    if not isinstance(request_id, str) or not 1 <= len(request_id) <= 100:
        raise ReelLabError("Для сборки нужен ключ запроса.")
    if not isinstance(upload_id, str) or not isinstance(spec, dict):
        raise ReelLabError("Не хватает данных для сборки ролика.")
    if not isinstance(spec.get("styleId"), str) or not _STYLE_ID.match(spec["styleId"]):
        raise ReelLabError("Неизвестный стиль субтитров.")
    cues = spec.get("cues")
    # Пустой список — можно: ролик без субтитров (монтаж, музыка, эффекты).
    if not isinstance(cues, list):
        raise ReelLabError("В задании нет текста субтитров.")
    if len(json.dumps(spec, ensure_ascii=False)) > 4 * 1024 * 1024:
        raise ReelLabError("Задание сборки слишком большое.")
    port = os.environ.get("REELLAB_PORT", "8765") if SERVER_MODE else (request.environ.get("SERVER_PORT") or os.environ.get("REELLAB_PORT", "8765"))
    origin = f"http://127.0.0.1:{port}"
    if not SERVER_MODE:
        job = create_job(upload_id, {"style_spec": spec, "render_origin": origin}, request_id, kind="style_render")
        return jsonify(serialize_job(job)), 202
    upload = fetch_upload(upload_id)
    spec = sanitize_render_spec(spec)
    seconds, span_start, span_end, total = render_span(spec, upload)
    owner = current_user_id()

    footage = footage_print(spec)
    # Какие куски оставлены: из 10 минут можно оставить разные минуты при тех же границах —
    # это уже другой ролик, а не пересборка того же.
    footage.append(["k", kept_ranges(spec, total)])

    def reserve(job_id: str) -> dict[str, Any]:
        return accounts.reserve_render(owner, job_id, upload_id, seconds, (span_start, span_end), footage)

    def finalize(settings: dict[str, Any], reservation: dict[str, Any]) -> dict[str, Any]:
        # Знак ставит сервер по тарифу: что прислала студия, не важно.
        style_spec = dict(settings.get("style_spec") or {})
        fx = dict(style_spec.get("fx") or {}) if isinstance(style_spec.get("fx"), dict) else {}
        fx["watermark"] = server_watermark(style_spec, span_end) if reservation.get("watermark") else None
        style_spec["fx"] = fx
        settings["style_spec"] = style_spec
        settings["plan"] = reservation.get("plan")
        settings["watermark"] = bool(reservation.get("watermark"))
        settings["charged"] = bool(reservation.get("charged"))
        settings["output_seconds"] = round(seconds, 2)
        return settings

    job = create_job(upload_id, {"style_spec": spec, "render_origin": origin}, request_id, kind="style_render",
                     reserve=reserve, finalize=finalize)
    payload = serialize_job(job)
    payload["me"] = me_payload(owner)
    return jsonify(payload), 202


def _merge_ranges(ranges: list[tuple[float, float]], low: float, high: float) -> list[list[float]]:
    clean = sorted((max(low, a), min(high, b)) for a, b in ranges if math.isfinite(a) and math.isfinite(b))
    merged: list[list[float]] = []
    for start, end in clean:
        if end - start <= 0.001:
            continue
        if merged and start <= merged[-1][1] + 0.002:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    return merged


def render_span(spec: dict[str, Any], upload: sqlite3.Row) -> tuple[float, float, float, float]:
    """Длина готового ролика и его границы во времени сборки (с вставками, без вырезанного).

    Возвращает (секунды ролика, первый оставленный момент, последний, вся длина сборки).
    Считает сервер — студия могла прислать что угодно.
    """
    duration = float(upload["duration"] or 0)
    total = duration
    try:
        montage_raw = spec.get("montage")
        if isinstance(montage_raw, dict) and isinstance(montage_raw.get("segments"), list):
            total = 0.0
            for item in montage_raw["segments"][:600]:
                if not isinstance(item, dict):
                    continue
                if item.get("kind") == "insert":
                    # Замедленная вставка длиннее своего куска: 10 с при 0,5× — это 20 с ролика.
                    speed = float(item.get("speed") or 1)
                    speed = min(MONTAGE_MAX_SPEED, max(MONTAGE_MIN_SPEED, speed)) if math.isfinite(speed) else 1.0
                    piece = max(0.0, min(3600.0, float(item.get("out") or 0) - float(item.get("in") or 0)))
                    total += piece / speed
                else:
                    start = max(0.0, float(item.get("start") or 0))
                    end = duration if item.get("end") is None else min(duration, float(item.get("end")))
                    total += max(0.0, end - start)
            if total <= 0:
                total = duration
        edit = spec.get("edit") if isinstance(spec.get("edit"), dict) else {}
        raw_skips = edit.get("skip") if isinstance(edit.get("skip"), list) else []
        skips = _merge_ranges([(float(item.get("start", 0)), float(item.get("end", 0)))
                               for item in raw_skips[:2000] if isinstance(item, dict)], 0.0, total)
    except (TypeError, ValueError):
        raise ReelLabError("Неверный план монтажа.")
    seconds = max(0.0, total - sum(end - start for start, end in skips))
    span_start = skips[0][1] if skips and skips[0][0] <= 0.05 else 0.0
    span_end = skips[-1][0] if skips and skips[-1][1] >= total - 0.05 else total
    return seconds, span_start, max(span_start, span_end), total


_LIBRARY_SOUND_URL = re.compile(r"/sounds/(?!own/)[A-Za-z0-9_-]+(?:/[A-Za-z0-9_.-]+){0,4}\.(?:wav|mp3|m4a|ogg|opus|flac|aac)")
_OWN_SOUND_URL = re.compile(r"/sounds/own/([A-Za-z0-9_-]+)/([A-Za-z0-9_.-]+)")
_PICTURE_URL = re.compile(r"/api/pictures/file/[0-9a-fu]{40}\.(?:jpg|png|webp)")


def sanitize_render_spec(spec: dict[str, Any]) -> dict[str, Any]:
    """Задание сборки на сервере: только свои файлы и только наши адреса.

    Сборщик — Chrome на сервере. Адрес звука или картинки из задания он откроет как есть,
    поэтому чужие и внешние адреса отбрасываются здесь, пока задание не встало в очередь.
    Вставки и видео поверх — только из своих загрузок.
    """
    spec = dict(spec)
    owner = current_user_id()
    clips = spec.get("audioClips")
    if clips is not None:
        clean: list[dict[str, Any]] = []
        for clip in clips if isinstance(clips, list) else []:
            if not isinstance(clip, dict) or len(clean) >= 200:
                continue
            url = str(clip.get("url") or "")
            if ".." in url or "//" in url:
                continue
            own = _OWN_SOUND_URL.fullmatch(url)
            if own:
                if own.group(2) not in OWN_FILES.values():
                    continue
                try:
                    own_sound_entry(own.group(1), owner)
                except ReelLabError:
                    continue
            elif not _LIBRARY_SOUND_URL.fullmatch(url):
                continue
            clean.append(dict(clip))
        spec["audioClips"] = clean
    pictures = spec.get("pictures")
    if isinstance(pictures, dict) and isinstance(pictures.get("items"), list):
        pictures = dict(pictures)
        pictures["items"] = [dict(item) for item in pictures["items"][:400]
                             if isinstance(item, dict) and _PICTURE_URL.fullmatch(str(item.get("url") or ""))]
        spec["pictures"] = pictures
    montage = spec.get("montage")
    if isinstance(montage, dict):
        for key in ("segments", "overlays"):
            items = montage.get(key)
            for item in (items if isinstance(items, list) else [])[:700]:
                if isinstance(item, dict) and item.get("upload_id") and not item.get("main"):
                    fetch_upload(str(item.get("upload_id")))   # чужая или несуществующая загрузка → 404
    return spec


def render_spec_urls(spec: dict[str, Any], job_id: str, token: str) -> dict[str, Any]:
    """Свои звуки на ленте — по ключу задания: у сборщика нет сессии, /sounds/own/ ему закрыт."""
    clips = spec.get("audioClips")
    if not isinstance(clips, list):
        return spec
    quoted = urllib.parse.quote(token, safe="")
    mapped = []
    for clip in clips:
        if isinstance(clip, dict):
            own = _OWN_SOUND_URL.fullmatch(str(clip.get("url") or ""))
            if own:
                clip = dict(clip, url=f"/api/render-jobs/{job_id}/own/{own.group(1)}/{own.group(2)}?token={quoted}")
        mapped.append(clip)
    return dict(spec, audioClips=mapped)


def kept_ranges(spec: dict[str, Any], total: float) -> list[list[float]]:
    """Оставленные куски ролика (всё, кроме вырезанного), по времени сборки, с точностью до 0,1 с."""
    edit = spec.get("edit") if isinstance(spec.get("edit"), dict) else {}
    raw_skips = edit.get("skip") if isinstance(edit.get("skip"), list) else []
    try:
        skips = _merge_ranges([(float(item.get("start", 0)), float(item.get("end", 0)))
                               for item in raw_skips[:2000] if isinstance(item, dict)], 0.0, total)
    except (TypeError, ValueError):
        skips = []
    kept: list[list[float]] = []
    cursor = 0.0
    for start, end in skips + [[total, total]]:
        if start - cursor > 0.05:
            kept.append([round(cursor, 1), round(start, 1)])
        cursor = max(cursor, end)
    return kept[:400]


def footage_print(spec: dict[str, Any]) -> list[list[Any]]:
    """Из каких кусков каких видео собран ролик — для правила «пересборка того же ролика бесплатно».

    Стиль, текст и эффекты сюда не входят: их можно менять сколько угодно. А вот другие куски
    исходника или другие вставки — это уже другой ролик, даже если длина та же.
    """
    montage = spec.get("montage") if isinstance(spec.get("montage"), dict) else None
    if not montage:
        return []

    def num(value: Any) -> float:
        try:
            number = float(value or 0)
        except (TypeError, ValueError):
            return 0.0
        return round(number, 2) if math.isfinite(number) else 0.0

    printed: list[list[Any]] = []
    segments = montage.get("segments") if isinstance(montage.get("segments"), list) else []
    for item in segments[:600]:
        if not isinstance(item, dict):
            continue
        if item.get("kind") == "insert":
            printed.append(["i", str(item.get("upload_id") or ("main" if item.get("main") else "")), num(item.get("in")),
                            num(item.get("out")), num(item.get("speed") or 1)])
        else:
            printed.append(["m", num(item.get("start")), None if item.get("end") is None else num(item.get("end"))])
    overlays = montage.get("overlays") if isinstance(montage.get("overlays"), list) else []
    for item in overlays[:120]:
        if isinstance(item, dict):
            printed.append(["o", str(item.get("upload_id") or ""), num(item.get("in")), num(item.get("len")), num(item.get("m0")),
                            num(item.get("speed") or 1)])
    return printed


def server_watermark(spec: dict[str, Any], end: float) -> dict[str, Any]:
    """Водяной знак бесплатного тарифа: как в студии, но решает сервер."""
    alignment = spec.get("alignment") if isinstance(spec.get("alignment"), dict) else {}
    try:
        offset = float(alignment.get("verticalOffset", 0.78))
    except (TypeError, ValueError):
        offset = 0.78
    offset = min(1.0, max(0.0, offset)) if math.isfinite(offset) else 0.78
    style = str(spec.get("styleId") or "")
    align = "center" if style.startswith("typewriter") else str(alignment.get("verticalAlign") or "bottom")
    if style == "pictures":
        band = (0.3, 0.75)
    elif align == "bottom":
        band = (offset - 0.18, offset)
    elif align == "top":
        band = (offset, offset + 0.18)
    else:
        band = (offset - 0.09, offset + 0.09)
    return {
        "text": "Reel Lab", "sub": f"@{BOT_USERNAME}" if BOT_USERNAME else "", "seed": 7, "opacity": 0.62,
        "end": round(float(end), 3), "avoidFrom": round(band[0], 3), "avoidTo": round(band[1], 3),
    }


@app.get("/api/render-jobs/<job_id>/spec")
def render_job_spec(job_id: str):
    row = _render_job_for_token(job_id)
    upload = fetch_upload(row["upload_id"])
    spec = dict(load(row["settings"], {}).get("style_spec") or {})
    spec = render_spec_urls(spec, job_id, request.args.get("token", ""))
    spec.update({"file_name": upload["name"], "width": upload["width"], "height": upload["height"],
                 "duration": upload["duration"]})
    source = render_sources.get(job_id)
    if source is not None and source != Path(upload["path"]) and source.is_file():
        try:
            probed = probe(source)
            spec.update({"width": probed["width"], "height": probed["height"], "duration": probed["duration"]})
        except ReelLabError:
            pass
    return jsonify(spec)


@app.get("/api/render-jobs/<job_id>/own-sounds")
def render_job_own_sounds(job_id: str):
    """Свои звуки владельца задания — для сборки в Chrome на сервере (у неё нет сессии, есть ключ задания)."""
    row = _render_job_for_token(job_id)
    owner = int(row["user_id"] or 0)
    token = urllib.parse.quote(request.args.get("token", ""), safe="")
    items = []
    for item in own_sounds_for(owner):
        entry = dict(item)
        entry["files"] = [f"/api/render-jobs/{job_id}/own/{item['id']}/{Path(str(name)).name}?token={token}"
                          for name in item.get("files") or []]
        items.append(entry)
    response = jsonify({"sounds": items})
    response.headers["Cache-Control"] = "no-store"
    return response


@app.get("/api/render-jobs/<job_id>/own/<sound_id>/<name>")
def render_job_own_file(job_id: str, sound_id: str, name: str):
    row = _render_job_for_token(job_id)
    if name not in OWN_FILES.values():
        raise ReelLabError("Звук не найден.", 404)
    own_sound_entry(sound_id, int(row["user_id"] or 0))
    folder = OWN_SOUNDS / sound_id
    if not (folder / name).is_file():
        raise ReelLabError("Звук не найден.", 404)
    return send_from_directory(folder, name, mimetype="audio/flac" if name.endswith(".flac") else "audio/mp4", max_age=0)


@app.get("/api/render-jobs/<job_id>/source")
def render_job_source(job_id: str):
    row = _render_job_for_token(job_id)
    path = render_sources.get(job_id) or Path(fetch_upload(row["upload_id"])["path"])
    if not path.exists():
        raise ReelLabError("Исходник не найден.", 404)
    return send_file(path, conditional=True)


@app.post("/api/render-jobs/<job_id>/progress")
def render_job_progress(job_id: str):
    _render_job_for_token(job_id)
    body = request.get_json(silent=True) or {}
    try:
        percent = int(max(3, min(94, float(body.get("percent") or 0))))
    except (TypeError, ValueError):
        percent = 3
    label = str(body.get("label") or "")[:120]
    if label:
        render_labels[job_id] = label
    update_job(job_id, progress_percent=percent)
    return jsonify({"ok": True})


@app.post("/api/render-jobs/<job_id>/result")
def render_job_result(job_id: str):
    _render_job_for_token(job_id)
    video_file = request.files.get("video")
    if video_file is None:
        raise ReelLabError("Сборщик не прислал видео.")
    workdir = JOBS / job_id
    rendered = workdir / "rendered.mp4"
    video_file.save(rendered)
    sfx = request.files.get("sfx")
    if sfx is not None:
        sfx.save(workdir / "keys.wav")
    render_results[job_id] = rendered
    return jsonify({"ok": True})


@app.post("/api/render-jobs/<job_id>/failed")
def render_job_failed(job_id: str):
    _render_job_for_token(job_id)
    body = request.get_json(silent=True) or {}
    render_failures[job_id] = str(body.get("error") or "неизвестная ошибка")[:400]
    return jsonify({"ok": True})


@app.post("/api/jobs/<job_id>/cancel")
def cancel(job_id: str):
    require_csrf()
    job = fetch_job(job_id)
    if job["status"] in ("queued", "running", "cancelling"):
        update_job(job_id, status="cancelling", phase="CANCELLING", cancel_requested=1)
        stop_process(job_id)
    return jsonify(serialize_job(fetch_job(job_id)))


@app.post("/api/jobs/<job_id>/retry")
def retry(job_id: str):
    require_csrf()
    job = fetch_job(job_id)
    body = require_json()
    request_id = body.get("request_id")
    if not isinstance(request_id, str):
        raise ReelLabError("Для повтора нужен ключ запроса.")
    return jsonify(serialize_job(create_job(
        job["upload_id"], load(job["settings"], {}), request_id, job_id,
        kind=job["kind"],
    )))


def completed_artifact(job_id: str, column: str, message: str) -> tuple[sqlite3.Row, Path]:
    job = fetch_job(job_id)
    path = Path(job[column]) if job[column] else None
    if job["status"] != "completed" or not path or not path.exists():
        raise ReelLabError(message, 404)
    return job, path


DOWNLOAD_ARTIFACTS = {
    "video": ("output_path", "video/mp4", "mp4", "Готовое видео пока недоступно."),
    "cover": ("cover_path", "image/jpeg", "jpg", "Обложка пока недоступна."),
    "subtitles": ("subtitle_path", "text/plain; charset=utf-8", "srt", "Файл субтитров пока недоступен."),
}


def native_download_url(token: str) -> str:
    configured = os.environ.get("REELLAB_PUBLIC_URL", "").strip().rstrip("/")
    if configured:
        if not configured.startswith("https://"):
            raise ReelLabError("Для скачивания из Telegram задайте публичный HTTPS-адрес REELLAB_PUBLIC_URL.", 409)
        return f"{configured}/api/downloads/{token}"
    if request.is_secure:
        return f"{request.host_url.rstrip('/')}/api/downloads/{token}"
    raise ReelLabError("Для скачивания из Telegram задайте публичный HTTPS-адрес REELLAB_PUBLIC_URL.", 409)


@app.post("/api/jobs/<job_id>/download")
def download_ticket(job_id: str):
    require_csrf()
    kind = require_json().get("kind")
    if not isinstance(kind, str) or kind not in DOWNLOAD_ARTIFACTS:
        raise ReelLabError("Неизвестный тип файла для скачивания.")
    column, _, extension, unavailable = DOWNLOAD_ARTIFACTS[kind]
    _, path = completed_artifact(job_id, column, unavailable)
    token, expires = secrets.token_urlsafe(24), now() + (max(DOWNLOAD_TICKET_SECONDS, 7200) if SERVER_MODE else DOWNLOAD_TICKET_SECONDS)
    file_name = f"reellab-{job_id[:8]}.{extension}"
    url = native_download_url(token)
    with lock, database() as conn:
        conn.execute("DELETE FROM download_tickets WHERE expires<?", (now(),))
        conn.execute(
            """INSERT INTO download_tickets(token,job_id,kind,path,file_name,expires)
               VALUES(?,?,?,?,?,?)""",
            (token, job_id, kind, str(path), file_name, expires),
        )
    return jsonify({"url": url, "file_name": file_name, "expires_at": expires})


@app.get("/api/downloads/<token>")
def ticket_download(token: str):
    with lock, database() as conn:
        row = conn.execute("SELECT * FROM download_tickets WHERE token=?", (token,)).fetchone()
        if row and int(row["expires"]) < now():
            conn.execute("DELETE FROM download_tickets WHERE token=?", (token,))
            row = None
    if row is None:
        raise ReelLabError("Ссылка на скачивание недействительна или устарела.", 404)
    path = Path(row["path"])
    if not path.is_file():
        raise ReelLabError("Файл для скачивания больше недоступен.", 404)
    mime = DOWNLOAD_ARTIFACTS.get(row["kind"], (None, "application/octet-stream", None, None))[1]
    inline = request.args.get("inline") == "1"
    return send_file(path, mimetype=mime, conditional=True, as_attachment=not inline, download_name=row["file_name"])


@app.get("/api/jobs/<job_id>/video")
def video(job_id: str):
    _, path = completed_artifact(job_id, "output_path", "Готовое видео пока недоступно.")
    return send_file(path, mimetype="video/mp4", conditional=True,
                     as_attachment=request.args.get("download") == "1",
                     download_name=f"reellab-{job_id[:8]}.mp4")


@app.get("/api/jobs/<job_id>/cover")
def cover(job_id: str):
    job = fetch_job(job_id)
    path = Path(job["cover_path"]) if job["cover_path"] else None
    if path and path.exists():
        return send_file(path, mimetype="image/jpeg", conditional=True,
                         as_attachment=request.args.get("download") == "1",
                         download_name=f"reellab-{job_id[:8]}.jpg")
    return send_from_directory(STATIC / "assets", "studio-demo-poster-v1.jpg")


@app.get("/api/jobs/<job_id>/subtitles")
def subtitles(job_id: str):
    _, path = completed_artifact(job_id, "subtitle_path", "Файл субтитров пока недоступен.")
    if request.args.get("format") == "vtt":
        # Word-timed WebVTT written next to the SRT by the GigaAM adapter.
        # Absent when the engine reported phrase timings only; the page then
        # falls back to the SRT below.
        words = path.with_name("subtitles.words.vtt")
        if not words.is_file():
            raise ReelLabError("Время каждого слова для этой задачи недоступно.", 404, "no_word_timing")
        return send_file(words, mimetype="text/vtt; charset=utf-8", conditional=True,
                         as_attachment=True, download_name=f"reellab-{job_id[:8]}.vtt")
    return send_file(path, mimetype="text/plain; charset=utf-8", conditional=True,
                     as_attachment=True, download_name=f"reellab-{job_id[:8]}.srt")


FINISH = DATA / "finish"


def _has_audio_stream(path: Path) -> bool:
    result = run(["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=index",
                  "-of", "csv=p=0", str(path)], 60)
    return result.returncode == 0 and bool(result.stdout.strip())


def _audio_channels(path: Path) -> int:
    result = run(["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=channels",
                  "-of", "csv=p=0", str(path)], 60)
    try:
        return int((result.stdout or "").strip().splitlines()[0])
    except (ValueError, IndexError):
        return 2


def to_stereo_filter(channels: int) -> str:
    """Mono is copied to both sides at full level (as players do); more channels fold down."""
    return "pan=stereo|c0=c0|c1=c0" if channels == 1 else "aformat=channel_layouts=stereo"


def clamp_gain(value: Any, default: float = 1.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    if not math.isfinite(number):
        return default
    return max(0.0, min(4.0, number))


RNNOISE_DIR = ROOT / "models" / "rnnoise"
RNNOISE_MODEL = "sh.rnnn"


def voice_filters(clean: bool, level: bool) -> list[str]:
    """Очистка голоса: срез гула, нейросетевое шумоподавление RNNoise, ровная громкость."""
    filters: list[str] = []
    if clean:
        filters.append("highpass=f=70")
        if (RNNOISE_DIR / RNNOISE_MODEL).is_file():
            # Модель передаётся относительным путём: FFmpeg запускается из её папки,
            # и в пути фильтра нет ни двоеточий Windows, ни кириллицы.
            filters.append(f"arnndn=m={RNNOISE_MODEL}:mix=0.92")
        else:
            filters.append("afftdn=nr=12:nf=-35")
    if level:
        filters.append("loudnorm=I=-15:TP=-1.5:LRA=11")
    return filters


def mix_keys_into_video(rendered: Path, sfx_path: Path | None, speech_source: Path, sfx_gain: float,
                        result_path: Path, speech_gain: float = 1.0, voice: dict[str, Any] | None = None) -> None:
    """Copy the rendered video stream and build the final sound with FFmpeg."""

    # FFmpeg запускается из папки модели шумоподавления — все пути абсолютные.
    rendered, speech_source, result_path = Path(rendered).resolve(), Path(speech_source).resolve(), Path(result_path).resolve()
    sfx_path = Path(sfx_path).resolve() if sfx_path is not None else None
    has_speech = _has_audio_stream(speech_source)
    cleanup = voice_filters(bool((voice or {}).get("clean")), bool((voice or {}).get("level")))
    speech_filter = ",".join(["aresample=48000", *cleanup, f"volume={speech_gain:.3f}"])
    # Звуки студии — стерео (пролёты слева направо, хвосты зала): голос и звуки
    # сводятся в стерео, моно-голос звучит в обоих каналах без потери громкости.
    if has_speech and sfx_path is not None:
        speech_filter += "," + to_stereo_filter(_audio_channels(speech_source))
    keys_layout = to_stereo_filter(_audio_channels(sfx_path)) if sfx_path is not None else ""
    command = ["ffmpeg", "-hide_banner", "-nostdin", "-y", "-i", str(rendered)]
    filters: list[str] = []
    if has_speech:
        command += ["-i", str(speech_source)]
    if sfx_path is not None:
        command += ["-i", str(sfx_path)]
    speech_index = 1 if has_speech else None
    sfx_index = (2 if has_speech else 1) if sfx_path is not None else None
    if speech_index is not None and sfx_index is not None:
        filters.append(f"[{speech_index}:a]{speech_filter}[speech]")
        filters.append(f"[{sfx_index}:a]aresample=48000,{keys_layout},volume={sfx_gain:.3f}[keys]")
        # duration=longest + apad: loudnorm отдаёт хвост голоса с задержкой, и amix с duration=first
        # обрезал последние ~3 секунды ролика. Длину задаёт видео (-shortest).
        filters.append("[speech][keys]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,"
                       "alimiter=limit=0.97,apad[mix]")
        audio_map = "[mix]"
    elif sfx_index is not None:
        filters.append(f"[{sfx_index}:a]aresample=48000,{keys_layout},volume={sfx_gain:.3f},apad[mix]")
        audio_map = "[mix]"
    elif speech_index is not None and (abs(speech_gain - 1.0) > 1e-3 or cleanup):
        filters.append(f"[{speech_index}:a]{speech_filter},apad[mix]")
        audio_map = "[mix]"
    elif speech_index is not None:
        audio_map = f"{speech_index}:a:0"
    else:
        audio_map = None
    if filters:
        command += ["-filter_complex", ";".join(filters)]
    command += ["-map", "0:v:0"]
    if audio_map:
        command += ["-map", audio_map, "-c:a", "aac", "-b:a", "192k", "-ar", "48000"]
    command += server_video_args(rendered) if SERVER_MODE else ["-c:v", "copy"]
    command += ["-shortest", "-movflags", "+faststart", str(result_path)]
    completed = run(command, FFMPEG_TIMEOUT_SECONDS, cwd=RNNOISE_DIR if RNNOISE_DIR.is_dir() else None)
    if completed.returncode or not result_path.is_file():
        raise ffmpeg_error("Не получилось свести звук ролика. Попробуй собрать ещё раз.", completed.stderr, 500, "finish_failed")


TELEGRAM_FIT_BYTES = 48 * 1024 * 1024


def server_video_args(rendered: Path) -> list[str]:
    """Сервер: ролик для соцсетей и чата Telegram.

    Браузерный кодировщик пишет ~12 Мбит/с и полный диапазон яркости — минута
    весит ~90 МБ, а бот может отправить в чат только до 50 МБ. Перекодируем в
    H.264 с ограничением битрейта: короткие ролики — до 8 Мбит/с (больше
    Instagram и TikTok всё равно не оставят), длинные — так, чтобы влезть в 48 МБ.
    """
    try:
        duration = max(1.0, probe(rendered)["duration"])
    except ReelLabError:
        duration = 60.0
    fit = int(TELEGRAM_FIT_BYTES * 8 / duration) - 220_000
    rate = max(2_500_000, min(8_000_000, fit))
    return [
        "-vf", "scale=out_range=tv,format=yuv420p",
        "-c:v", "libx264", "-preset", "veryfast", "-profile:v", "high", "-crf", "20",
        "-maxrate", str(rate), "-bufsize", str(rate * 2), "-pix_fmt", "yuv420p", "-color_range", "tv",
        "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
    ]


@app.post("/api/finish-video")
def finish_video():
    """Mix the key-sound track into a video rendered by the browser.

    The browser renders the captions; FFmpeg then copies its video stream
    untouched and builds the sound: the speech from the original upload (or
    from the rendered file when no upload is named) plus the typing sounds
    that the page rendered with exactly the same samples the user previewed.
    """

    require_csrf()
    video = request.files.get("video")
    if video is None:
        raise ReelLabError("Не получено готовое видео для сведения звука.")
    sfx = request.files.get("sfx")
    upload_id = (request.form.get("upload_id") or "").strip()
    try:
        sfx_gain = float(request.form.get("sfx_gain") or 1.0)
    except ValueError:
        sfx_gain = 1.0
    sfx_gain = max(0.0, min(4.0, sfx_gain if math.isfinite(sfx_gain) else 1.0))
    speech_gain = clamp_gain(request.form.get("speech_gain"), 1.0)
    voice = {"clean": request.form.get("voice_clean") == "1", "level": request.form.get("voice_level") == "1"}
    # Если в ролике вырезаны куски, голос берётся из собранного ролика — там он уже смонтирован.
    use_rendered_speech = request.form.get("speech_from") == "rendered"

    # Готовые файлы прошлых сведений больше не нужны: браузер их уже скачал.
    if FINISH.is_dir():
        for old in FINISH.iterdir():
            try:
                if old.is_dir() and time.time() - old.stat().st_mtime > 2 * 3600:
                    shutil.rmtree(old, ignore_errors=True)
            except OSError:
                pass
    workdir = FINISH / identifier()
    workdir.mkdir(parents=True, exist_ok=True)
    rendered = workdir / "rendered.mp4"
    video.save(rendered)
    speech_source = rendered
    if upload_id and not use_rendered_speech:
        upload_row = fetch_upload(upload_id)
        candidate = Path(upload_row["path"])
        if candidate.exists() and bool(upload_row["has_audio"]):
            speech_source = candidate

    sfx_path = None
    if sfx is not None:
        sfx_path = workdir / "keys.wav"
        sfx.save(sfx_path)
    result_path = workdir / "result.mp4"
    mix_keys_into_video(rendered, sfx_path, speech_source, sfx_gain, result_path, speech_gain, voice)
    return send_file(result_path, mimetype="video/mp4", as_attachment=True,
                     download_name="reellab-result.mp4")


@app.get("/api/jobs/<job_id>/audio")
def audio(job_id: str):
    _, path = completed_artifact(job_id, "audio_path", "Аудиодорожка недоступна: в исходнике может не быть звука.")
    return send_file(path, mimetype="audio/mpeg", conditional=True,
                     as_attachment=request.args.get("download") == "1",
                     download_name=f"reellab-{job_id[:8]}.mp3")


@app.get("/api/jobs/<job_id>/source")
def source(job_id: str):
    job = fetch_job(job_id)
    upload = fetch_upload(job["upload_id"])
    path = Path(upload["path"])
    if not path.exists():
        raise ReelLabError("Исходник не найден.", 404)
    return send_file(path, conditional=True)


@app.get("/api/jobs/<job_id>/editor")
def editor(job_id: str):
    job = fetch_job(job_id)
    upload = fetch_upload(job["upload_id"])
    return jsonify({
        "settings": load(job["settings"], {}), "words": [], "omit": [],
        "suggestions": [], "source_duration": float(upload["duration"]),
        "semantic_review": {"status": "not_started", "warnings": [], "suggestions": []},
    })


@app.post("/api/jobs/<job_id>/revise")
def revise(job_id: str):
    require_csrf()
    job = fetch_job(job_id)
    body = require_json()
    if not isinstance(body.get("settings"), dict) or not isinstance(body.get("request_id"), str):
        raise ReelLabError("Не удалось сохранить настройки новой версии.")
    return jsonify(serialize_job(create_job(job["upload_id"], body["settings"], body["request_id"], job_id)))


@app.route("/api/jobs/<job_id>/analysis", methods=["GET", "POST"])
def analysis(job_id: str):
    fetch_job(job_id)
    return jsonify({"status": "not_started", "warnings": ["ИИ-анализ станет доступен после подключения серверной модели."], "suggestions": []})


@app.post("/api/jobs/<job_id>/analysis/cancel")
def cancel_analysis(job_id: str):
    require_csrf()
    fetch_job(job_id)
    return jsonify({"status": "cancelled", "warnings": [], "suggestions": []})


@app.post("/api/jobs/<job_id>/assistant")
def assistant_plan(job_id: str):
    require_csrf()
    job = fetch_job(job_id)
    upload = fetch_upload(job["upload_id"])
    settings = load(job["settings"], {})
    recommendations: list[dict[str, Any]] = []
    if float(upload["duration"]) > 60:
        recommendations.append({
            "title": "Сделать короткую версию",
            "text": "Исходник длиннее минуты. На сервере можно включить смысловую нарезку до 60 секунд.",
            "settings": {"smart_cut": True, "duration_mode": "short60"},
        })
    if not upload["has_audio"]:
        recommendations.append({
            "title": "Добавить музыку",
            "text": "В ролике нет речи или звука. После подключения сервера можно добавить фоновую дорожку.",
            "settings": {"background_music": True},
        })
    else:
        recommendations.append({
            "title": "Очистить голос",
            "text": "Профиль «Чистая речь» применит шумоподавление, компрессию и выравнивание громкости.",
            "settings": {"audio_preset": "clear_speech", "noise_reduction": "medium", "normalize_audio": True},
        })
    if int(upload["width"] or 0) < 1080 or int(upload["height"] or 0) < 1280:
        recommendations.append({
            "title": "Поднять детализацию",
            "text": "Локальный режим добавит мягкую резкость; серверный нейроапскейл сможет улучшить исходник сильнее.",
            "settings": {"video_enhancement": "strong"},
        })
    return jsonify({
        "summary": "План подготовлен на основе длительности, звука и разрешения исходника.",
        "recommendations": recommendations, "current_settings": settings,
    })


@app.post("/api/jobs/<job_id>/deliver")
def deliver(job_id: str):
    require_csrf()
    fetch_job(job_id)
    raise ReelLabError("Telegram-бот пока не подключён. Нужны токен и публичный HTTPS-адрес сервера.", 409)


@app.get("/api/usage")
def usage():
    with database() as conn:
        jobs_24h = conn.execute("SELECT COUNT(*) n FROM jobs WHERE created>=?", (now() - 86400,)).fetchone()["n"]
        active = conn.execute("SELECT COUNT(*) n FROM jobs WHERE status IN ('queued','running','cancelling')").fetchone()["n"]
        storage = conn.execute("SELECT COALESCE(SUM(size_bytes),0) n FROM uploads").fetchone()["n"]
    return jsonify({
        "jobs_24h": int(jobs_24h), "daily_limit": None, "active": int(active),
        "storage_bytes": int(storage), "storage_limit": MAX_BYTES * 5,
    })


@app.route("/api/support", methods=["GET", "POST"])
def support():
    if request.method == "POST":
        require_csrf()
        text = str(require_json().get("text", "")).strip()
        if not 3 <= len(text) <= 2000:
            raise ReelLabError("Текст обращения должен содержать от 3 до 2000 символов.")
        with lock, database() as conn:
            conn.execute("INSERT INTO tickets(id,created,text,reply,user_id) VALUES(?,?,?,NULL,?)",
                         (identifier(), now(), text, current_user_id()))
        if SERVER_MODE:
            notify_support(current_user_id(), text)
        return jsonify({"ok": True})
    with database() as conn:
        rows = conn.execute("SELECT created,text,reply FROM tickets WHERE user_id=? ORDER BY created DESC LIMIT 50",
                            (current_user_id(),)).fetchall()
    return jsonify({"tickets": [{"created": int(row["created"]), "text": row["text"], "reply": row["reply"]} for row in rows]})


@app.get("/api/preview")
def preview():
    return send_from_directory(STATIC / "assets", "presenter-v1.jpg")


SITE = STATIC / "site"


def site_page(name: str) -> Response:
    """Сайт бота: главная, оферта, политика. Данные владельца — из .env (REELLAB_OWNER_*)."""
    import html as html_lib
    from accounts import MSK, PRODUCTS
    from datetime import datetime
    esc = html_lib.escape
    bot = BOT_USERNAME or "ReelLabBot"
    owner = os.environ.get("REELLAB_OWNER_NAME", "").strip()
    npd = os.environ.get("REELLAB_OWNER_NPD", "").strip().lower() in ("1", "true", "yes", "да")
    inn = os.environ.get("REELLAB_OWNER_INN", "").strip() or "сообщается по запросу"
    email = os.environ.get("REELLAB_CONTACT_EMAIL", "").strip() or "через поддержку в боте"
    support = os.environ.get("REELLAB_SUPPORT", "").strip() or f"@{bot}, команда /support"
    if owner:
        owner_full = f"{owner}, плательщик налога на профессиональный доход (самозанятый)" if npd else owner
    else:
        owner_full = "владелец сервиса Reel Lab"
    date = os.environ.get("REELLAB_LEGAL_DATE", "").strip() or datetime.now(MSK).strftime("%d.%m.%Y")
    cards = "\n".join(
        f'<div class="card"><b>{esc(item["title"])}</b><span class="price">{item["rub"]} ₽</span>'
        f'<p>{esc(item["text"])}</p><p class="muted">или {item["stars"]} ⭐ в Telegram</p></div>'
        for item in PRODUCTS.values())
    tariffs = "\n".join(
        f'<li>«{esc(item["title"])}» — {item["rub"]} ₽ (или {item["stars"]} звёзд Telegram): {esc(item["text"])}</li>'
        for item in PRODUCTS.values())
    values = {
        "BOT": esc(bot), "OWNER_FULL": esc(owner_full), "INN": esc(inn), "EMAIL": esc(email), "SUPPORT": esc(support),
        "DATE": esc(date), "TARIFF_CARDS": cards, "TARIFF_LIST": tariffs,
        "OWNER_LINE": esc(owner_full + (f", ИНН {inn}" if os.environ.get("REELLAB_OWNER_INN") else "")),
        "TAX_LINE": ("<p>1.3. Исполнитель применяет специальный налоговый режим «Налог на профессиональный доход»; "
                     "услуги НДС не облагаются.</p>") if npd else "",
        "TAX_NOTE": "Цены в рублях, НДС не облагается (налог на профессиональный доход)." if npd else "Цены в рублях.",
    }
    text = (SITE / name).read_text(encoding="utf-8")
    for key, value in values.items():
        text = text.replace("{{" + key + "}}", value)
    return Response(text, 200, mimetype="text/html")


@app.get("/legal/offer")
def legal_offer():
    return site_page("offer.html")


@app.get("/legal/privacy")
def legal_privacy():
    return site_page("privacy.html")


@app.get("/")
@app.get("/index.html")
def index():
    if SERVER_MODE:
        return site_page("index.html")
    return send_from_directory(STATIC, "index.html")


@app.get("/bot")
def bot_preview():
    """Default local Mini App: ready-made subtitle templates."""
    return redirect("/ready-captions/index.html")


@app.get("/<path:filename>")
def static_file(filename: str):
    if (STATIC / filename).is_file():
        return send_from_directory(STATIC, filename)
    return Response("Не найдено", 404)



# ---------------------------------------------------------------------------
# Серверный режим: бот, оплата, доставка роликов, уборка старых файлов.

billing = None
bot = None


def make_download_link(job_id: str, hours: int = 48) -> str:
    """Долгая ссылка на готовый ролик — для бота, когда файл больше 50 МБ."""
    job = fetch_job(job_id)
    path = Path(job["output_path"]) if job["output_path"] else None
    if job["status"] != "completed" or not path or not path.is_file():
        return ""
    token = secrets.token_urlsafe(24)
    with lock, database() as conn:
        conn.execute("""INSERT INTO download_tickets(token,job_id,kind,path,file_name,expires)
                        VALUES(?,?,?,?,?,?)""",
                     (token, job_id, "video", str(path), f"reellab-{job_id[:8]}.mp4", now() + hours * 3600))
    return f"{PUBLIC_URL}/api/downloads/{token}"


def job_file_info(job_id: str) -> tuple[Path | None, dict[str, Any]]:
    job = fetch_job(job_id)
    path = Path(job["output_path"]) if job["output_path"] else None
    info: dict[str, Any] = {"duration": float(job["duration"] or 0), "file_name": f"reellab-{job_id[:8]}.mp4"}
    if path and path.is_file():
        try:
            probed = probe(path)
            info.update(duration=probed["duration"], width=probed["width"], height=probed["height"])
        except ReelLabError:
            pass
    return path, info


def after_job(job_id: str) -> None:
    """Сборка закончилась: окончательно списать ролик или вернуть его, и написать человеку в чат."""
    try:
        row = fetch_job(job_id)
    except ReelLabError:
        return
    if row["kind"] != "style_render":
        return
    ok = row["status"] == "completed"
    if accounts is not None:
        accounts.finish_render(job_id, ok)
    if bot is not None:
        job = dict(row)
        threading.Thread(target=bot.job_finished, args=(job,), daemon=True).start()


def notify_support(user_id: int, text: str) -> None:
    if bot is None:
        return
    user = accounts.get_user(user_id) or {"id": user_id}
    threading.Thread(target=bot.forward_support, args=(user, text, "вопрос из студии"), daemon=True).start()


def queue_info() -> dict[str, Any]:
    info: dict[str, Any] = dict(queue())
    if scheduler is not None:
        info["waiting"] = scheduler.waiting()
    return info


def _secret(name: str) -> str:
    configured = os.environ.get("REELLAB_SECRET", "").strip()
    base = configured or BOT_TOKEN
    return hashlib.sha256(f"reellab:{name}:{base}".encode("utf-8")).hexdigest()


WEBHOOK_PATH = _secret("webhook-path")[:24]
WEBHOOK_SECRET = _secret("webhook-secret")[:48]
WEBAPP_URL = f"{PUBLIC_URL}/ready-captions/index.html"

if SERVER_MODE:
    from billing import Billing, Robokassa, result_page
    from tgbot import ReelBot, TelegramApi

    telegram_api = TelegramApi(BOT_TOKEN)
    billing = Billing(
        accounts, db_path=DB, public_url=PUBLIC_URL, secret=_secret("pay"), api=telegram_api,
        robokassa=Robokassa.from_env(),
        card_enabled=os.environ.get("REELLAB_CARD_PAYMENTS", "1").strip().lower() not in ("0", "false", "no", "off"),
        on_paid=lambda user_id, payment, status: bot.paid_notice(user_id, payment, status) if bot else None,
    )
    bot = ReelBot(telegram_api, accounts, billing, webapp_url=WEBAPP_URL, public_url=PUBLIC_URL, owners=OWNER_IDS,
                  username=BOT_USERNAME, job_file=job_file_info, make_link=make_download_link, queue_info=queue_info,
                  assistant=AssistantBridge(), work_dir=UPLOADS)

    @app.post(f"/tg/{WEBHOOK_PATH}")
    def telegram_webhook():
        if not secrets.compare_digest(request.headers.get("X-Telegram-Bot-Api-Secret-Token", ""), WEBHOOK_SECRET):
            return Response("forbidden", 403)
        update = request.get_json(silent=True)
        if isinstance(update, dict):
            bot.submit(update)
        return Response("ok", 200)

    @app.post("/api/billing/stars")
    def billing_stars():
        require_csrf()
        product = str(require_json().get("product") or "")
        return jsonify({"link": billing.stars_link(current_user_id(), product)})

    @app.post("/api/billing/card")
    def billing_card():
        require_csrf()
        product = str(require_json().get("product") or "")
        return jsonify({"url": billing.card_link(current_user_id(), product)})

    @app.route("/api/billing/robokassa/result", methods=["GET", "POST"])
    def robokassa_result():
        form = request.form.to_dict() if request.method == "POST" else request.args.to_dict()
        try:
            return Response(billing.robokassa_result(form), 200, mimetype="text/plain")
        except AccountsError as error:
            app.logger.warning("Robokassa: %s %s", error.code, error.message)
            return Response(error.message, error.status, mimetype="text/plain")

    @app.get("/pay/<payment_id>")
    def pay_page(payment_id: str):
        try:
            return Response(billing.card_form(payment_id, request.args.get("s", "")), 200, mimetype="text/html")
        except AccountsError as error:
            from billing import _page
            return Response(_page("Оплата", error.message), error.status, mimetype="text/html")

    @app.route("/pay/success", methods=["GET", "POST"])
    def pay_success():
        return Response(result_page("success"), 200, mimetype="text/html")

    @app.route("/pay/fail", methods=["GET", "POST"])
    def pay_fail():
        return Response(result_page("fail"), 200, mimetype="text/html")

    def _setup_bot() -> None:
        global BOT_USERNAME
        webhook = None
        if PUBLIC_URL.startswith("https://") and os.environ.get("TELEGRAM_UPDATES", "webhook").strip().lower() != "polling":
            webhook = f"{PUBLIC_URL}/tg/{WEBHOOK_PATH}"
        bot.setup(webhook, WEBHOOK_SECRET if webhook else None)
        # Имя бота — из Telegram, если его не вписали в .env: оно нужно для водяного знака и сайта.
        if bot.username and not BOT_USERNAME:
            BOT_USERNAME = bot.username
            os.environ["TELEGRAM_BOT_USERNAME"] = bot.username

    def cleanup_loop() -> None:
        """Раз в час: убрать старые исходники, готовые ролики, сессии; в 23 часа по Москве — итоги дня владельцу."""
        from accounts import MSK
        from datetime import datetime
        reported = ""
        while True:
            try:
                cleanup_server_files()
                accounts.purge_sessions()
                moment = datetime.now(MSK)
                if moment.hour == 23 and reported != moment.strftime("%Y-%m-%d"):
                    reported = moment.strftime("%Y-%m-%d")
                    bot.daily_report()
            except Exception:  # noqa: BLE001
                app.logger.exception("Уборка не удалась")
            time.sleep(1800)


def cleanup_server_files() -> None:
    stamp = now()
    with database() as conn:
        old_uploads = conn.execute(
            "SELECT id, path, render_path FROM uploads WHERE MAX(created, last_used) < ?",
            (stamp - UPLOAD_KEEP_SECONDS,)).fetchall()
        old_jobs = conn.execute(
            "SELECT id FROM jobs WHERE updated < ? AND status NOT IN ('queued','running','cancelling')",
            (stamp - RESULT_KEEP_SECONDS,)).fetchall()
        busy = {row["upload_id"] for row in conn.execute(
            "SELECT upload_id FROM jobs WHERE status IN ('queued','running','cancelling')")}
    for row in old_uploads:
        if row["id"] in busy:
            continue
        for value in (row["path"], row["render_path"]):
            if value:
                Path(value).unlink(missing_ok=True)
    for row in old_jobs:
        shutil.rmtree(JOBS / row["id"], ignore_errors=True)
    for folder in (PREPARED, CHUNKED):
        if folder.is_dir():
            for item in folder.iterdir():
                try:
                    if stamp - item.stat().st_mtime > UPLOAD_KEEP_SECONDS:
                        shutil.rmtree(item, ignore_errors=True) if item.is_dir() else item.unlink(missing_ok=True)
                except OSError:
                    pass
    with lock, database() as conn:
        conn.execute("DELETE FROM download_tickets WHERE expires<?", (stamp,))
        conn.execute("DELETE FROM projects WHERE updated<?", (stamp - PROJECT_KEEP_SECONDS,))
        old_runs = [row["id"] for row in conn.execute("SELECT id FROM assistant_runs WHERE created<?",
                                                       (stamp - ASSISTANT_KEEP_SECONDS,))]
        conn.execute("DELETE FROM assistant_runs WHERE created<?", (stamp - ASSISTANT_KEEP_SECONDS,))
    for analysis_id in old_runs:
        _assistant_file(analysis_id).unlink(missing_ok=True)


init_database()
recover_assistant_runs()
if accounts is not None:
    accounts.refund_stale()
if SERVER_MODE:
    # Фоновые потоки — только когда модуль загружен целиком и база готова: иначе первая уборка
    # падает на ещё не объявленных функциях и недостроенной схеме.
    if os.environ.get("REELLAB_BOT_SETUP", "1").strip() != "0":
        threading.Thread(target=_setup_bot, daemon=True, name="tg-setup").start()
    threading.Thread(target=cleanup_loop, daemon=True, name="cleanup").start()

if __name__ == "__main__":
    port = int(os.environ.get("REELLAB_PORT", "8765"))
    print(f"Reel Lab Local запущен: http://127.0.0.1:{port}")
    print(f"Данные хранятся в: {DATA}")
    app.run(host="127.0.0.1", port=port, threaded=True, debug=False)



