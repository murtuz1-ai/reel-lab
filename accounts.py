"""Пользователи, сессии, тарифы и лимиты Reel Lab в серверном режиме.

Всё хранится в той же базе SQLite, что и задания. Деньги — в копейках,
звёзды Telegram — штуками. День и месяц считаются по Москве: бот работает
для России, и «2 ролика в день» обнуляются в полночь по МСК.

Тарифы
------
* Бесплатно: 2 ролика в день, до 1 минуты, с водяным знаком, без ИИ-картинок
  и озвучки; на текстовый ИИ (перевод, хук, вырезка пауз) — маленький
  дневной бюджет на дешёвой модели.
* Пакеты 10 и 50 роликов: без знака, ролик до 3 минут, не сгорают.
* Безлимит на 30 дней: без знака, до 10 роликов в день (честное
  использование), ролик до 3 минут.

ИИ-бюджет — внутренний счётчик в копейках: каждая покупка добавляет его, а
каждый запрос к ИИ списывает фактическую стоимость (токены, картинки,
секунды озвучки). Так даже самый активный пользователь не уводит тариф в
минус. Пользователь видит только понятные вещи: сколько роликов осталось.
"""
from __future__ import annotations

import hashlib
import json
import secrets
import sqlite3
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator, Mapping

MSK = timezone(timedelta(hours=3))
DAY = 24 * 3600

# --- Тарифы -----------------------------------------------------------------

FREE_PLAN = {
    "videos_per_day": 2,
    "max_seconds": 60,
    "watermark": True,
    "ai_kop_per_day": 100,          # 1 ₽ в день на текстовый ИИ (дешёвая модель)
    "transcriptions_per_day": 6,
    "max_source_seconds": 3 * 60,   # исходник до 3 минут: обрежь до минуты в студии
}
PAID_LIMITS = {
    "max_seconds": 3 * 60,
    "transcriptions_per_day": 40,
    "max_source_seconds": 15 * 60,
}
UNLIMITED_PER_DAY = 10
RERENDER_WINDOW = DAY                # пересобрать тот же ролик бесплатно — в течение суток
RERENDER_MAX = 5                     # …и не больше 5 раз
RERENDER_MAX_FREE = 2                # в бесплатном доступе — 2 раза: поправить опечатку хватит, а сервер не тратим
RERENDER_TOLERANCE = 3.0             # «тот же ролик»: начало и конец куска ±3 секунды

# Цены в звёздах подобраны так, чтобы покупатель платил примерно как картой
# (звезда в России обходится в ~1,5–1,8 ₽), а после вывода через Fragment
# (~1,08 ₽ за звезду) даже самый активный покупатель не уводил тариф в минус.
PRODUCTS: dict[str, dict[str, Any]] = {
    "pack10": {
        "title": "10 роликов", "short": "10 роликов без знака",
        "credits": 10, "days": 0, "rub": 290, "stars": 199, "ai_kop": 150_00,
        "text": "10 роликов без водяного знака, каждый до 3 минут. Не сгорают.",
    },
    "pack50": {
        "title": "50 роликов", "short": "50 роликов без знака",
        "credits": 50, "days": 0, "rub": 990, "stars": 690, "ai_kop": 600_00,
        "text": "50 роликов без водяного знака, каждый до 3 минут. Не сгорают. Выгоднее в 1,5 раза.",
    },
    "unlim30": {
        "title": "Безлимит на месяц", "short": "Безлимит на 30 дней",
        "credits": 0, "days": 30, "rub": 1490, "stars": 990, "ai_kop": 600_00,
        "text": "30 дней без водяного знака: до 10 роликов в день, каждый до 3 минут.",
    },
}

# Стоимость ИИ в копейках с НДС (Yandex AI Studio, цены октября 2026).
AI_PRICES_KOP = {
    # за 1000 токенов: (вход, выход)
    "aliceai-llm": (50, 120),
    "aliceai-llm-flash": (10, 20),
    "deepseek-v4.1-flash": (30, 50),
    "deepseek-v4-flash": (30, 50),
    "qwen3.6-35b-a3b": (20, 30),
    "yandexgpt-5.1": (80, 80),
    "yandexgpt-5-pro": (120, 120),
    "yandexgpt-5-lite": (20, 20),
    "gpt-oss-120b": (30, 30),       # Яндекс отключает 30.10.2026
    "gpt-oss-20b": (10, 10),
    "yandexgpt-lite": (20, 20),
    "yandexgpt": (120, 120),
    "default": (50, 120),           # модель не из списка (своя в .env) — считаем по самой дорогой
    "image": 223,                   # Alice AI ART / YandexART, одна картинка
    "tts_second": 2.04,             # озвучка, секунда готовой речи
}


class AccountsError(Exception):
    """Понятная пользователю причина отказа: лимит, тариф, оплата."""

    def __init__(self, message: str, status: int = 402, code: str = "limit", **extra: Any):
        super().__init__(message)
        self.message = message
        self.status = status
        self.code = code
        self.extra = extra


def msk_day(ts: float | None = None) -> str:
    return datetime.fromtimestamp(time.time() if ts is None else ts, MSK).strftime("%Y-%m-%d")


def msk_month(ts: float | None = None) -> str:
    return datetime.fromtimestamp(time.time() if ts is None else ts, MSK).strftime("%Y-%m")


def seconds_to_msk_midnight(ts: float | None = None) -> int:
    moment = datetime.fromtimestamp(time.time() if ts is None else ts, MSK)
    tomorrow = (moment + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    return max(1, int((tomorrow - moment).total_seconds()))


def _now() -> int:
    return int(time.time())


def _load_footage(value: Any) -> list[list[Any]]:
    try:
        loaded = json.loads(value or "[]")
    except (TypeError, ValueError):
        return []
    return loaded if isinstance(loaded, list) else []


def _ranges_apart(a: Any, b: Any) -> float:
    """Сколько секунд оставлено только в одном из двух вариантов (симметрическая разность)."""
    def clean(value: Any) -> list[tuple[float, float]]:
        out = []
        for item in value if isinstance(value, list) else []:
            try:
                start, end = float(item[0]), float(item[1])
            except (TypeError, ValueError, IndexError):
                continue
            if end > start:
                out.append((start, end))
        return sorted(out)

    left, right = clean(a), clean(b)
    points = sorted({p for item in left + right for p in item})
    apart = 0.0
    for start, end in zip(points, points[1:]):
        middle = (start + end) / 2
        inside_left = any(s <= middle < e for s, e in left)
        inside_right = any(s <= middle < e for s, e in right)
        if inside_left != inside_right:
            apart += end - start
    return apart


def _footage_close(a: list[list[Any]], b: list[list[Any]], tolerance: float) -> bool:
    """Те же куски тех же видео: число и порядок совпадают, границы — в пределах допуска.

    Запись ["k", [[начало, конец], …]] — оставленные куски ролика: вырезать «э-э» или сдвинуть
    край — та же пересборка, а оставить другие минуты того же видео — уже другой ролик.
    """
    if len(a) != len(b):
        return False
    for left, right in zip(a, b):
        if not isinstance(left, list) or not isinstance(right, list) or len(left) != len(right) or left[:1] != right[:1]:
            return False
        if left[:1] == ["k"]:
            if _ranges_apart(left[1] if len(left) > 1 else [], right[1] if len(right) > 1 else []) > 2 * tolerance:
                return False
            continue
        for x, y in zip(left[1:], right[1:]):
            if isinstance(x, (int, float)) and isinstance(y, (int, float)) and not isinstance(x, bool) and not isinstance(y, bool):
                if abs(float(x) - float(y)) > tolerance:
                    return False
            elif x != y:
                return False
    return True


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def videos_ru(count: int) -> str:
    count = abs(int(count))
    if count % 10 == 1 and count % 100 != 11:
        word = "ролик"
    elif count % 10 in (2, 3, 4) and count % 100 not in (12, 13, 14):
        word = "ролика"
    else:
        word = "роликов"
    return f"{count} {word}"


SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    first_name TEXT NOT NULL DEFAULT '', last_name TEXT NOT NULL DEFAULT '',
    username TEXT NOT NULL DEFAULT '', language_code TEXT NOT NULL DEFAULT '',
    is_premium INTEGER NOT NULL DEFAULT 0,
    created INTEGER NOT NULL, last_seen INTEGER NOT NULL,
    credits INTEGER NOT NULL DEFAULT 0,
    unlimited_until INTEGER NOT NULL DEFAULT 0,
    ai_budget_kop INTEGER NOT NULL DEFAULT 0,
    unl_ai_kop INTEGER NOT NULL DEFAULT 0,
    ref TEXT NOT NULL DEFAULT '',
    blocked INTEGER NOT NULL DEFAULT 0,
    bot_blocked INTEGER NOT NULL DEFAULT 0,
    chat_id INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, csrf TEXT NOT NULL,
    created INTEGER NOT NULL, expires INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS renders (
    job_id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, upload_id TEXT NOT NULL,
    plan TEXT NOT NULL, charged INTEGER NOT NULL, parent_job TEXT,
    fp_start REAL NOT NULL DEFAULT 0, fp_end REAL NOT NULL DEFAULT 0,
    seconds REAL NOT NULL DEFAULT 0, watermark INTEGER NOT NULL DEFAULT 0,
    day TEXT NOT NULL, status TEXT NOT NULL,
    created INTEGER NOT NULL, updated INTEGER NOT NULL,
    fp_media TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS renders_user_day ON renders(user_id, day);
CREATE TABLE IF NOT EXISTS transcriptions (
    job_id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, seconds REAL NOT NULL,
    day TEXT NOT NULL, created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS transcriptions_user_day ON transcriptions(user_id, day);
CREATE TABLE IF NOT EXISTS ai_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
    kind TEXT NOT NULL, pool TEXT NOT NULL, cost_kop REAL NOT NULL,
    units INTEGER NOT NULL DEFAULT 0, day TEXT NOT NULL, month TEXT NOT NULL,
    created INTEGER NOT NULL, meta TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ai_usage_user_day ON ai_usage(user_id, day);
CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, provider TEXT NOT NULL,
    product TEXT NOT NULL, amount INTEGER NOT NULL, currency TEXT NOT NULL,
    status TEXT NOT NULL, external_id TEXT UNIQUE, charge_id TEXT,
    created INTEGER NOT NULL, updated INTEGER NOT NULL, meta TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS payments_user ON payments(user_id);
CREATE TABLE IF NOT EXISTS grants (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
    payment_id TEXT, product TEXT NOT NULL,
    credits INTEGER NOT NULL DEFAULT 0, days INTEGER NOT NULL DEFAULT 0,
    ai_kop INTEGER NOT NULL DEFAULT 0, reason TEXT NOT NULL DEFAULT '',
    created INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
);
"""


class Accounts:
    def __init__(self, db_path: Path | str, owner_ids: set[int] | None = None):
        self.db_path = Path(db_path)
        self.owner_ids = set(owner_ids or ())
        self._lock = threading.RLock()
        self._seen: dict[int, float] = {}
        self.init_schema()

    # --- база ---------------------------------------------------------------

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=30)
        conn.row_factory = sqlite3.Row
        return conn

    @contextmanager
    def _db(self, write: bool = False) -> Iterator[sqlite3.Connection]:
        conn = self._connect()
        try:
            if write:
                conn.execute("BEGIN IMMEDIATE")
            yield conn
            conn.commit()
        except BaseException:
            conn.rollback()
            raise
        finally:
            conn.close()

    def init_schema(self) -> None:
        with self._lock:
            conn = self._connect()
            try:
                conn.execute("PRAGMA journal_mode=WAL")
                conn.executescript(SCHEMA)
                columns = {row[1] for row in conn.execute("PRAGMA table_info(renders)")}
                if "fp_media" not in columns:  # база от ранней версии
                    conn.execute("ALTER TABLE renders ADD COLUMN fp_media TEXT NOT NULL DEFAULT ''")
                conn.commit()
            finally:
                conn.close()

    # --- пользователи -------------------------------------------------------

    def is_admin(self, user_id: int) -> bool:
        return int(user_id) in self.owner_ids

    def touch_user(self, tg_user: Mapping[str, Any], ref: str = "") -> dict[str, Any]:
        """Создаёт или обновляет пользователя по подписанным данным Telegram."""
        user_id = int(tg_user["id"])
        stamp = _now()
        fields = {
            "first_name": str(tg_user.get("first_name") or "")[:120],
            "last_name": str(tg_user.get("last_name") or "")[:120],
            "username": str(tg_user.get("username") or "")[:64],
            "language_code": str(tg_user.get("language_code") or "")[:12],
            "is_premium": 1 if tg_user.get("is_premium") else 0,
        }
        with self._lock, self._db(write=True) as conn:
            row = conn.execute("SELECT id, ref FROM users WHERE id=?", (user_id,)).fetchone()
            if row is None:
                conn.execute(
                    """INSERT INTO users(id, first_name, last_name, username, language_code, is_premium,
                       created, last_seen, ref) VALUES(?,?,?,?,?,?,?,?,?)""",
                    (user_id, *fields.values(), stamp, stamp, str(ref or "")[:64]),
                )
            else:
                conn.execute(
                    """UPDATE users SET first_name=?, last_name=?, username=?, language_code=?, is_premium=?,
                       last_seen=? WHERE id=?""",
                    (*fields.values(), stamp, user_id),
                )
                if ref and not row["ref"]:
                    conn.execute("UPDATE users SET ref=? WHERE id=?", (str(ref)[:64], user_id))
        self._seen[user_id] = time.time()
        return self.get_user(user_id) or {}

    def get_user(self, user_id: int) -> dict[str, Any] | None:
        with self._db() as conn:
            row = conn.execute("SELECT * FROM users WHERE id=?", (int(user_id),)).fetchone()
        return dict(row) if row else None

    def mark_seen(self, user_id: int) -> None:
        if time.time() - self._seen.get(user_id, 0) < 300:
            return
        self._seen[user_id] = time.time()
        with self._lock, self._db(write=True) as conn:
            conn.execute("UPDATE users SET last_seen=? WHERE id=?", (_now(), user_id))

    def set_chat(self, user_id: int, chat_id: int | None, *, bot_blocked: bool | None = None) -> None:
        with self._lock, self._db(write=True) as conn:
            if chat_id is not None:
                conn.execute("UPDATE users SET chat_id=?, bot_blocked=0 WHERE id=?", (int(chat_id), int(user_id)))
            if bot_blocked is not None:
                conn.execute("UPDATE users SET bot_blocked=? WHERE id=?", (1 if bot_blocked else 0, int(user_id)))

    def set_blocked(self, user_id: int, blocked: bool) -> None:
        with self._lock, self._db(write=True) as conn:
            conn.execute("UPDATE users SET blocked=? WHERE id=?", (1 if blocked else 0, int(user_id)))

    # --- сессии -------------------------------------------------------------

    def create_session(self, user_id: int, ttl: int = 30 * DAY) -> tuple[str, str]:
        token = secrets.token_urlsafe(32)
        csrf = secrets.token_urlsafe(24)
        stamp = _now()
        with self._lock, self._db(write=True) as conn:
            conn.execute(
                "INSERT INTO sessions(token_hash, user_id, csrf, created, expires) VALUES(?,?,?,?,?)",
                (_hash_token(token), int(user_id), csrf, stamp, stamp + ttl),
            )
            # Старые сессии одного человека не копятся бесконечно.
            conn.execute(
                """DELETE FROM sessions WHERE user_id=? AND token_hash NOT IN
                   (SELECT token_hash FROM sessions WHERE user_id=? ORDER BY created DESC LIMIT 8)""",
                (int(user_id), int(user_id)),
            )
        return token, csrf

    def resolve_session(self, token: str) -> tuple[dict[str, Any], str] | None:
        if not token or len(token) > 200:
            return None
        with self._db() as conn:
            row = conn.execute(
                """SELECT s.csrf, s.expires, u.* FROM sessions s JOIN users u ON u.id = s.user_id
                   WHERE s.token_hash=?""",
                (_hash_token(token),),
            ).fetchone()
        if row is None or int(row["expires"]) < _now():
            return None
        user = dict(row)
        csrf = user.pop("csrf")
        user.pop("expires", None)
        return user, csrf

    def purge_sessions(self) -> None:
        with self._lock, self._db(write=True) as conn:
            conn.execute("DELETE FROM sessions WHERE expires<?", (_now(),))

    # --- что доступно -------------------------------------------------------

    def _plan_of(self, user: Mapping[str, Any], stamp: int) -> str:
        if self.is_admin(int(user["id"])):
            return "admin"
        if int(user["unlimited_until"] or 0) > stamp:
            return "unlimited"
        if int(user["credits"] or 0) > 0:
            return "pack"
        return "free"

    def _count(self, conn: sqlite3.Connection, sql: str, args: tuple) -> int:
        return int(conn.execute(sql, args).fetchone()[0] or 0)

    def _free_used(self, conn: sqlite3.Connection, user_id: int, day: str) -> int:
        return self._count(conn, """SELECT COUNT(*) FROM renders WHERE user_id=? AND day=? AND plan='free'
                                    AND charged=1 AND status IN ('reserved','done')""", (user_id, day))

    def _unlimited_used(self, conn: sqlite3.Connection, user_id: int, day: str) -> int:
        return self._count(conn, """SELECT COUNT(*) FROM renders WHERE user_id=? AND day=? AND plan='unlimited'
                                    AND charged=1 AND status IN ('reserved','done')""", (user_id, day))

    def _free_ai_used(self, conn: sqlite3.Connection, user_id: int, day: str) -> float:
        row = conn.execute("SELECT COALESCE(SUM(cost_kop),0) FROM ai_usage WHERE user_id=? AND day=? AND pool='free'",
                           (user_id, day)).fetchone()
        return float(row[0] or 0)

    def status(self, user_id: int) -> dict[str, Any]:
        """Всё, что нужно студии и боту, чтобы показать тариф и остатки."""
        stamp = _now()
        day = msk_day(stamp)
        with self._db() as conn:
            row = conn.execute("SELECT * FROM users WHERE id=?", (int(user_id),)).fetchone()
            if row is None:
                raise AccountsError("Пользователь не найден. Открой студию из бота заново.", 401, "no_user")
            user = dict(row)
            plan = self._plan_of(user, stamp)
            free_used = self._free_used(conn, user_id, day)
            unl_used = self._unlimited_used(conn, user_id, day)
            free_ai = self._free_ai_used(conn, user_id, day)
        unlimited = int(user["unlimited_until"] or 0) > stamp
        paid = plan in ("admin", "unlimited", "pack")
        if plan == "unlimited" and unl_used >= UNLIMITED_PER_DAY and int(user["credits"] or 0) <= 0:
            next_render = "unlimited_cap"
        elif plan == "free" and free_used >= FREE_PLAN["videos_per_day"]:
            next_render = "free_cap"
        else:
            next_render = "ok"
        ai_left = (
            None if plan == "admin"
            else (int(user["unl_ai_kop"]) if unlimited else 0) + int(user["ai_budget_kop"] or 0)
            if paid else max(0, FREE_PLAN["ai_kop_per_day"] - free_ai)
        )
        return {
            "user": {
                "id": int(user["id"]), "first_name": user["first_name"], "username": user["username"],
            },
            "plan": plan,
            "admin": plan == "admin",
            "credits": int(user["credits"] or 0),
            "unlimited_until": int(user["unlimited_until"] or 0) if unlimited else 0,
            "unlimited_left_today": max(0, UNLIMITED_PER_DAY - unl_used) if unlimited else 0,
            "free_left_today": max(0, FREE_PLAN["videos_per_day"] - free_used),
            "free_per_day": FREE_PLAN["videos_per_day"],
            "resets_in": seconds_to_msk_midnight(stamp),
            "watermark": not paid,
            "max_seconds": PAID_LIMITS["max_seconds"] if paid else FREE_PLAN["max_seconds"],
            "max_source_seconds": PAID_LIMITS["max_source_seconds"] if paid else FREE_PLAN["max_source_seconds"],
            "next_render": next_render,
            "features": {"pictures": paid, "dubbing": paid, "ai_text": True},
            "ai_left_kop": ai_left,
            "blocked": bool(user["blocked"]),
        }

    # --- списание роликов ---------------------------------------------------

    def reserve_render(self, user_id: int, job_id: str, upload_id: str, seconds: float,
                       span: tuple[float, float], footage: list[list[Any]] | None = None) -> dict[str, Any]:
        """Резервирует ролик под задание сборки. Бросает AccountsError, если лимит.

        Пересборка того же ролика в течение суток бесплатна (до 5 раз, без тарифа — до 2): поправить опечатку
        или сменить стиль не стоит ещё одного ролика. «Тот же ролик» — тот же кусок того же
        видео (±3 с) и те же вставки (footage); текст, стиль и эффекты могут быть любыми.
        """
        stamp = _now()
        day = msk_day(stamp)
        fp_start, fp_end = float(span[0]), float(span[1])
        footage = list(footage or [])
        fp_media = json.dumps(footage, ensure_ascii=False, separators=(",", ":"))
        with self._lock, self._db(write=True) as conn:
            row = conn.execute("SELECT * FROM users WHERE id=?", (int(user_id),)).fetchone()
            if row is None:
                raise AccountsError("Пользователь не найден. Открой студию из бота заново.", 401, "no_user")
            user = dict(row)
            if user["blocked"]:
                raise AccountsError("Доступ к студии закрыт. Напиши в поддержку бота.", 403, "blocked")
            plan = self._plan_of(user, stamp)
            paid = plan != "free"
            limit = PAID_LIMITS["max_seconds"] if paid else FREE_PLAN["max_seconds"]
            if seconds > limit + 0.5 and plan != "admin":
                if paid:
                    raise AccountsError(
                        f"Ролик длиннее {limit // 60} минут. Обрежь видео на ленте монтажа.", 413, "too_long",
                        max_seconds=limit)
                raise AccountsError(
                    "Бесплатно — ролики до 1 минуты. Обрежь видео на ленте монтажа или выбери тариф: "
                    "там ролики до 3 минут и без водяного знака.", 413, "too_long_free", max_seconds=limit)

            # Тот же ролик ещё раз? Ищем среди последних оплаченных сборок этого видео.
            parent = None
            for candidate in conn.execute(
                    """SELECT * FROM renders WHERE user_id=? AND upload_id=? AND charged=1
                       AND status IN ('reserved','done') AND created>=? ORDER BY created DESC LIMIT 10""",
                    (user_id, upload_id, stamp - RERENDER_WINDOW)):
                if abs(candidate["fp_start"] - fp_start) <= RERENDER_TOLERANCE \
                        and abs(candidate["fp_end"] - fp_end) <= RERENDER_TOLERANCE \
                        and bool(candidate["watermark"]) == (not paid) \
                        and _footage_close(_load_footage(candidate["fp_media"]), footage, RERENDER_TOLERANCE):
                    parent = candidate
                    break
            if parent is not None:
                repeats = self._count(conn, "SELECT COUNT(*) FROM renders WHERE parent_job=? AND status IN ('reserved','done')",
                                      (parent["job_id"],))
                if repeats < (RERENDER_MAX_FREE if parent["watermark"] else RERENDER_MAX):
                    conn.execute(
                        """INSERT INTO renders(job_id, user_id, upload_id, plan, charged, parent_job, fp_start, fp_end,
                           seconds, watermark, day, status, created, updated, fp_media)
                           VALUES(?,?,?,?,0,?,?,?,?,?,?,?,?,?,?)""",
                        (job_id, user_id, upload_id, parent["plan"], parent["job_id"], fp_start, fp_end, seconds,
                         parent["watermark"], day, "reserved", stamp, stamp, fp_media),
                    )
                    return {"plan": parent["plan"], "watermark": bool(parent["watermark"]), "charged": False,
                            "repeat": repeats + 1}

            charge_plan = plan
            if plan == "unlimited" and self._unlimited_used(conn, user_id, day) >= UNLIMITED_PER_DAY:
                if int(user["credits"] or 0) > 0:
                    charge_plan = "pack"
                else:
                    raise AccountsError(
                        f"В безлимите — до {UNLIMITED_PER_DAY} роликов в день. Новый день начнётся в полночь по Москве.",
                        402, "unlimited_cap", resets_in=seconds_to_msk_midnight(stamp))
            if charge_plan == "free" and self._free_used(conn, user_id, day) >= FREE_PLAN["videos_per_day"]:
                raise AccountsError(
                    f"Бесплатные {videos_ru(FREE_PLAN['videos_per_day'])} на сегодня закончились. "
                    "Новые будут после полуночи по Москве — или выбери тариф: ролики сразу и без водяного знака.",
                    402, "free_cap", resets_in=seconds_to_msk_midnight(stamp))
            if charge_plan == "pack":
                updated = conn.execute("UPDATE users SET credits=credits-1 WHERE id=? AND credits>0", (user_id,))
                if updated.rowcount != 1:
                    raise AccountsError("Оплаченные ролики закончились. Выбери тариф, чтобы продолжить.", 402, "no_credits")
            watermark = charge_plan == "free"
            conn.execute(
                """INSERT INTO renders(job_id, user_id, upload_id, plan, charged, parent_job, fp_start, fp_end,
                   seconds, watermark, day, status, created, updated, fp_media)
                   VALUES(?,?,?,?,1,NULL,?,?,?,?,?,?,?,?,?)""",
                (job_id, user_id, upload_id, charge_plan, fp_start, fp_end, seconds, 1 if watermark else 0,
                 day, "reserved", stamp, stamp, fp_media),
            )
            return {"plan": charge_plan, "watermark": watermark, "charged": True, "repeat": 0}

    def render_info(self, job_id: str) -> dict[str, Any] | None:
        with self._db() as conn:
            row = conn.execute("SELECT * FROM renders WHERE job_id=?", (job_id,)).fetchone()
        return dict(row) if row else None

    def finish_render(self, job_id: str, ok: bool) -> None:
        """Ролик собран — списание окончательно; не собрался — ролик возвращается."""
        stamp = _now()
        with self._lock, self._db(write=True) as conn:
            row = conn.execute("SELECT * FROM renders WHERE job_id=?", (job_id,)).fetchone()
            if row is None or row["status"] != "reserved":
                return
            if ok:
                conn.execute("UPDATE renders SET status='done', updated=? WHERE job_id=?", (stamp, job_id))
                return
            conn.execute("UPDATE renders SET status='refunded', updated=? WHERE job_id=?", (stamp, job_id))
            if row["charged"] and row["plan"] == "pack":
                conn.execute("UPDATE users SET credits=credits+1 WHERE id=?", (row["user_id"],))

    def refund_stale(self) -> int:
        """После перезапуска сервера незаконченные сборки не продолжатся — ролики возвращаются."""
        with self._db() as conn:
            rows = conn.execute("SELECT job_id FROM renders WHERE status='reserved'").fetchall()
        for row in rows:
            self.finish_render(row["job_id"], False)
        return len(rows)

    # --- распознавание ------------------------------------------------------

    def check_transcription(self, user_id: int, job_id: str, source_seconds: float) -> None:
        stamp = _now()
        day = msk_day(stamp)
        with self._lock, self._db(write=True) as conn:
            row = conn.execute("SELECT * FROM users WHERE id=?", (int(user_id),)).fetchone()
            if row is None:
                raise AccountsError("Пользователь не найден. Открой студию из бота заново.", 401, "no_user")
            user = dict(row)
            if user["blocked"]:
                raise AccountsError("Доступ к студии закрыт. Напиши в поддержку бота.", 403, "blocked")
            plan = self._plan_of(user, stamp)
            limits = FREE_PLAN if plan == "free" else PAID_LIMITS
            if plan != "admin" and source_seconds > limits["max_source_seconds"] + 1:
                minutes = limits["max_source_seconds"] // 60
                if plan == "free":
                    raise AccountsError(
                        f"Бесплатно можно загрузить видео до {minutes} минут (готовый ролик — до 1 минуты). "
                        "Обрежь видео в галерее телефона или выбери тариф.", 413, "source_too_long_free")
                raise AccountsError(f"Видео длиннее {minutes} минут. Обрежь его перед загрузкой.", 413, "source_too_long")
            used = self._count(conn, "SELECT COUNT(*) FROM transcriptions WHERE user_id=? AND day=?", (user_id, day))
            if plan != "admin" and used >= limits["transcriptions_per_day"]:
                raise AccountsError("На сегодня распознаваний слишком много. Попробуй завтра или напиши в поддержку.",
                                    429, "transcription_cap", resets_in=seconds_to_msk_midnight(stamp))
            conn.execute("INSERT OR IGNORE INTO transcriptions(job_id, user_id, seconds, day, created) VALUES(?,?,?,?,?)",
                         (job_id, user_id, float(source_seconds), day, stamp))

    # --- ИИ-бюджет ----------------------------------------------------------

    def ai_allowance(self, user_id: int, kind: str, estimate_kop: float = 0) -> dict[str, Any]:
        """Можно ли сейчас запрос к ИИ и из какого бюджета он спишется.

        kind: «text» (перевод, хук, монтаж), «image» (ИИ-картинки), «tts» (озвучка).
        Возвращает pool (admin | unlimited | pack | free) и tier (best | cheap).
        """
        stamp = _now()
        with self._db() as conn:
            row = conn.execute("SELECT * FROM users WHERE id=?", (int(user_id),)).fetchone()
            if row is None:
                raise AccountsError("Пользователь не найден. Открой студию из бота заново.", 401, "no_user")
            user = dict(row)
            plan = self._plan_of(user, stamp)
            if plan == "admin":
                return {"pool": "admin", "tier": "best", "left_kop": None}
            if user["blocked"]:
                raise AccountsError("Доступ к студии закрыт. Напиши в поддержку бота.", 403, "blocked")
            need = max(1.0, float(estimate_kop or 0))
            unlimited = int(user["unlimited_until"] or 0) > stamp
            if unlimited and int(user["unl_ai_kop"] or 0) >= need:
                return {"pool": "unlimited", "tier": "best", "left_kop": float(user["unl_ai_kop"] or 0)}
            if int(user["ai_budget_kop"] or 0) >= need:
                return {"pool": "pack", "tier": "best", "left_kop": float(user["ai_budget_kop"] or 0)}
            if unlimited or int(user["credits"] or 0) > 0:
                raise AccountsError(
                    "Лимит ИИ на этот период исчерпан. Субтитры, стили и сборка работают как обычно; "
                    "ИИ-функции вернутся с новым пакетом или периодом безлимита.", 402, "ai_budget")
            if kind != "text":
                what = "ИИ-картинки" if kind == "image" else "Озвучка"
                raise AccountsError(f"{what} — в платных тарифах. Выбери тариф, чтобы включить.", 402, "paid_feature",
                                    feature=kind)
            used = self._free_ai_used(conn, user_id, msk_day(stamp))
            if used + need > FREE_PLAN["ai_kop_per_day"]:
                raise AccountsError(
                    "Бесплатный ИИ на сегодня закончился. Он обновится после полуночи по Москве — "
                    "или выбери тариф.", 402, "free_ai_cap", resets_in=seconds_to_msk_midnight(stamp))
            return {"pool": "free", "tier": "cheap", "left_kop": max(0.0, FREE_PLAN["ai_kop_per_day"] - used)}

    def charge_ai(self, user_id: int, pool: str, kind: str, cost_kop: float, units: int = 0, meta: str = "") -> None:
        stamp = _now()
        cost = max(0.0, float(cost_kop or 0))
        with self._lock, self._db(write=True) as conn:
            conn.execute(
                """INSERT INTO ai_usage(user_id, kind, pool, cost_kop, units, day, month, created, meta)
                   VALUES(?,?,?,?,?,?,?,?,?)""",
                (int(user_id), kind, pool, cost, int(units), msk_day(stamp), msk_month(stamp), stamp, str(meta)[:300]),
            )
            whole = int(round(cost))
            if pool == "unlimited":
                conn.execute("UPDATE users SET unl_ai_kop=MAX(0, unl_ai_kop-?) WHERE id=?", (whole, user_id))
            elif pool == "pack":
                conn.execute("UPDATE users SET ai_budget_kop=MAX(0, ai_budget_kop-?) WHERE id=?", (whole, user_id))

    # --- покупки ------------------------------------------------------------

    def grant(self, user_id: int, product_id: str, payment_id: str | None = None, reason: str = "",
              *, credits: int | None = None, days: int | None = None) -> dict[str, Any]:
        """Начисляет пакет, безлимит или ручной подарок администратора."""
        with self._lock, self._db(write=True) as conn:
            self._grant_in(conn, user_id, product_id, payment_id, reason, credits=credits, days=days)
        return self.status(int(user_id))

    def _grant_in(self, conn: sqlite3.Connection, user_id: int, product_id: str, payment_id: str | None, reason: str,
                  *, credits: int | None = None, days: int | None = None) -> None:
        """Начисление внутри уже открытой записи в базу (оплата и начисление — одним махом)."""
        product = PRODUCTS.get(product_id, {}) if product_id in PRODUCTS else {}
        add_credits = int(product.get("credits", 0) if credits is None else credits)
        add_days = int(product.get("days", 0) if days is None else days)
        ai_kop = int(product.get("ai_kop", 0))
        if product_id not in PRODUCTS:
            # Подарок вручную: ИИ-бюджет пропорционально подаренному.
            ai_kop = add_credits * 1500 + add_days * 2000
        stamp = _now()
        row = conn.execute("SELECT * FROM users WHERE id=?", (int(user_id),)).fetchone()
        if row is None:
            conn.execute("INSERT INTO users(id, created, last_seen) VALUES(?,?,?)", (int(user_id), stamp, stamp))
            row = conn.execute("SELECT * FROM users WHERE id=?", (int(user_id),)).fetchone()
        user = dict(row)
        if add_credits:
            conn.execute("UPDATE users SET credits=MAX(0, credits+?), ai_budget_kop=ai_budget_kop+? WHERE id=?",
                         (add_credits, ai_kop if not add_days else 0, user_id))
        if add_days:
            base = max(stamp, int(user["unlimited_until"] or 0))
            unl_budget = int(user["unl_ai_kop"] or 0) if int(user["unlimited_until"] or 0) > stamp else 0
            conn.execute("UPDATE users SET unlimited_until=?, unl_ai_kop=? WHERE id=?",
                         (base + add_days * DAY, unl_budget + ai_kop, user_id))
        conn.execute(
            """INSERT INTO grants(user_id, payment_id, product, credits, days, ai_kop, reason, created)
               VALUES(?,?,?,?,?,?,?,?)""",
            (int(user_id), payment_id, product_id, add_credits, add_days, ai_kop, reason[:200], stamp),
        )

    def revoke_payment(self, payment_id: str) -> bool:
        """Возврат денег: забираем то, что было начислено за этот платёж (сколько осталось)."""
        stamp = _now()
        with self._lock, self._db(write=True) as conn:
            grants = conn.execute("SELECT * FROM grants WHERE payment_id=? AND revoked=0", (payment_id,)).fetchall()
            if not grants:
                return False
            for grant in grants:
                user = conn.execute("SELECT * FROM users WHERE id=?", (grant["user_id"],)).fetchone()
                if user is None:
                    continue
                if grant["credits"]:
                    conn.execute("UPDATE users SET credits=MAX(0, credits-?), ai_budget_kop=MAX(0, ai_budget_kop-?) WHERE id=?",
                                 (grant["credits"], grant["ai_kop"] if not grant["days"] else 0, grant["user_id"]))
                if grant["days"]:
                    until = int(user["unlimited_until"] or 0) - grant["days"] * DAY
                    conn.execute("UPDATE users SET unlimited_until=?, unl_ai_kop=MAX(0, unl_ai_kop-?) WHERE id=?",
                                 (max(0, until), grant["ai_kop"], grant["user_id"]))
                conn.execute("UPDATE grants SET revoked=? WHERE id=?", (stamp, grant["id"]))
            conn.execute("UPDATE payments SET status='refunded', updated=? WHERE id=?", (stamp, payment_id))
        return True

    # --- платежи ------------------------------------------------------------

    def create_payment(self, user_id: int, provider: str, product_id: str, amount: int, currency: str,
                       meta: Mapping[str, Any] | None = None) -> str:
        if product_id not in PRODUCTS:
            raise AccountsError("Такого тарифа нет.", 400, "bad_product")
        payment_id = "p" + secrets.token_hex(11)
        stamp = _now()
        with self._lock, self._db(write=True) as conn:
            conn.execute(
                """INSERT INTO payments(id, user_id, provider, product, amount, currency, status, created, updated, meta)
                   VALUES(?,?,?,?,?,?,?,?,?,?)""",
                (payment_id, int(user_id), provider, product_id, int(amount), currency, "pending", stamp, stamp,
                 json.dumps(dict(meta or {}), ensure_ascii=False)),
            )
        return payment_id

    def payment(self, payment_id: str) -> dict[str, Any] | None:
        with self._db() as conn:
            row = conn.execute("SELECT * FROM payments WHERE id=?", (payment_id,)).fetchone()
        return dict(row) if row else None

    def payment_by_external(self, external_id: str) -> dict[str, Any] | None:
        with self._db() as conn:
            row = conn.execute("SELECT * FROM payments WHERE external_id=?", (external_id,)).fetchone()
        return dict(row) if row else None

    def set_external_id(self, payment_id: str, external_id: str) -> None:
        with self._lock, self._db(write=True) as conn:
            conn.execute("UPDATE payments SET external_id=?, updated=? WHERE id=?", (external_id, _now(), payment_id))

    def complete_payment(self, payment_id: str, *, amount: int, currency: str, charge_id: str = "",
                         external_id: str = "") -> dict[str, Any] | None:
        """Отмечает платёж оплаченным и начисляет тариф — ровно один раз.

        Возвращает статус пользователя, если начисление произошло сейчас, и
        None, если платёж уже был учтён раньше (повтор уведомления).
        """
        stamp = _now()
        with self._lock, self._db(write=True) as conn:
            row = conn.execute("SELECT * FROM payments WHERE id=?", (payment_id,)).fetchone()
            if row is None:
                raise AccountsError("Платёж не найден.", 404, "no_payment")
            if row["status"] in ("paid", "refunded"):
                return None
            if int(row["amount"]) != int(amount) or str(row["currency"]).upper() != str(currency).upper():
                raise AccountsError("Сумма платежа не совпадает с тарифом.", 409, "amount_mismatch")
            conn.execute(
                """UPDATE payments SET status='paid', charge_id=?, external_id=COALESCE(NULLIF(?, ''), external_id),
                   updated=? WHERE id=?""",
                (charge_id or None, external_id, stamp, payment_id),
            )
            user_id, product = int(row["user_id"]), row["product"]
            # Отметка «оплачен» и начисление — в одной записи: сбой между ними не оставит оплату без тарифа.
            self._grant_in(conn, user_id, product, payment_id, f"payment:{row['provider']}")
        return self.status(user_id)

    def cancel_payment(self, payment_id: str) -> None:
        with self._lock, self._db(write=True) as conn:
            conn.execute("UPDATE payments SET status='canceled', updated=? WHERE id=? AND status='pending'",
                         (_now(), payment_id))

    # --- для администратора -------------------------------------------------

    def stats(self) -> dict[str, Any]:
        stamp = _now()
        day = msk_day(stamp)
        month = msk_month(stamp)
        with self._db() as conn:
            users = self._count(conn, "SELECT COUNT(*) FROM users", ())
            new_today = self._count(conn, "SELECT COUNT(*) FROM users WHERE created>=?", (stamp - DAY,))
            active_today = self._count(conn, "SELECT COUNT(*) FROM users WHERE last_seen>=?", (stamp - DAY,))
            renders_today = self._count(conn, "SELECT COUNT(*) FROM renders WHERE day=? AND status='done'", (day,))
            free_today = self._count(conn, "SELECT COUNT(*) FROM renders WHERE day=? AND status='done' AND plan='free'", (day,))
            failed_today = self._count(conn, "SELECT COUNT(*) FROM renders WHERE day=? AND status='refunded'", (day,))
            unlimited = self._count(conn, "SELECT COUNT(*) FROM users WHERE unlimited_until>?", (stamp,))
            with_credits = self._count(conn, "SELECT COUNT(*) FROM users WHERE credits>0", ())
            paid_rub = conn.execute(
                "SELECT COALESCE(SUM(amount),0) FROM payments WHERE status='paid' AND currency='RUB' AND updated>=?",
                (stamp - 30 * DAY,)).fetchone()[0]
            paid_stars = conn.execute(
                "SELECT COALESCE(SUM(amount),0) FROM payments WHERE status='paid' AND currency='XTR' AND updated>=?",
                (stamp - 30 * DAY,)).fetchone()[0]
            ai_month = conn.execute("SELECT COALESCE(SUM(cost_kop),0) FROM ai_usage WHERE month=?", (month,)).fetchone()[0]
            ai_today = conn.execute("SELECT COALESCE(SUM(cost_kop),0) FROM ai_usage WHERE day=?", (day,)).fetchone()[0]
        return {
            "users": users, "new_24h": new_today, "active_24h": active_today,
            "renders_today": renders_today, "free_renders_today": free_today, "failed_today": failed_today,
            "unlimited_active": unlimited, "with_credits": with_credits,
            "revenue_30d_rub": round(int(paid_rub or 0) / 100, 2), "revenue_30d_stars": int(paid_stars or 0),
            "ai_cost_month_rub": round(float(ai_month or 0) / 100, 2), "ai_cost_today_rub": round(float(ai_today or 0) / 100, 2),
        }

    def find_users(self, query: str, limit: int = 10) -> list[dict[str, Any]]:
        query = str(query or "").strip().lstrip("@")
        with self._db() as conn:
            if query.isdigit():
                rows = conn.execute("SELECT * FROM users WHERE id=?", (int(query),)).fetchall()
            else:
                rows = conn.execute("SELECT * FROM users WHERE username LIKE ? COLLATE NOCASE LIMIT ?",
                                    (f"%{query}%", limit)).fetchall()
        return [dict(row) for row in rows]

    def recent_payments(self, user_id: int, limit: int = 5) -> list[dict[str, Any]]:
        with self._db() as conn:
            rows = conn.execute("SELECT * FROM payments WHERE user_id=? ORDER BY created DESC LIMIT ?",
                                (int(user_id), int(limit))).fetchall()
        return [dict(row) for row in rows]

    def chat_ids(self) -> list[int]:
        with self._db() as conn:
            rows = conn.execute("SELECT id, chat_id FROM users WHERE bot_blocked=0 AND blocked=0").fetchall()
        return [int(row["chat_id"] or row["id"]) for row in rows]
