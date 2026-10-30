"""Telegram-бот Reel Lab: команды, тарифы, оплата звёздами, поддержка и доставка роликов.

Бот работает внутри того же сервера, что и студия: обновления приходят на
вебхук /tg/<секрет> (или забираются опросом, пока нет HTTPS), а готовые
ролики бот отправляет сам, как только сборка закончилась.
"""
from __future__ import annotations

import json
import logging
import os
import re
import shutil
import threading
import time
import urllib.parse
import uuid
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Mapping

import requests

from accounts import MSK, PRODUCTS, Accounts, AccountsError, videos_ru
from billing import Billing

log = logging.getLogger("reellab.bot")
VIDEO_LIMIT_BYTES = 49 * 1024 * 1024      # Bot API принимает файлы до 50 МБ
FETCH_LIMIT_BYTES = 20 * 1024 * 1024      # а отдаёт боту (getFile) — до 20 МБ; свой сервер Bot API — до 2 ГБ
VIDEO_NAME = re.compile(r"\.(mp4|mov|m4v|webm|mkv|avi)$", re.I)
ALLOWED_UPDATES = ["message", "callback_query", "pre_checkout_query", "my_chat_member"]


class TelegramError(Exception):
    def __init__(self, code: int, description: str):
        super().__init__(f"{code}: {description}")
        self.code = int(code or 0)
        self.description = str(description or "")


class TelegramApi:
    """Тонкая обёртка над Bot API: JSON-запросы и загрузка файлов."""

    def __init__(self, token: str, timeout: float = 40):
        # TELEGRAM_API_BASE — свой сервер Bot API (файлы до 2 ГБ) или заглушка для проверки.
        base = os.environ.get("TELEGRAM_API_BASE", "https://api.telegram.org").strip().rstrip("/")
        self.base = f"{base}/bot{token}/"
        self.file_base = f"{base}/file/bot{token}/"
        self.custom_server = base != "https://api.telegram.org"
        self._token = token
        self.timeout = timeout
        self.session = requests.Session()

    def _redact(self, error: object) -> str:
        # В тексте ошибок requests есть адрес запроса, а в адресе — токен бота. В журнал он попасть не должен.
        text = str(error)
        return text.replace(self._token, "<токен>") if self._token else text

    def __call__(self, method: str, **params: Any) -> Any:
        return self._request(method, json_body={k: v for k, v in params.items() if v is not None})

    def upload(self, method: str, params: Mapping[str, Any], files: Mapping[str, tuple[str, Any, str]],
               timeout: float = 300) -> Any:
        data = {key: (json.dumps(value, ensure_ascii=False) if isinstance(value, (dict, list)) else str(value))
                for key, value in params.items() if value is not None}
        return self._request(method, data=data, files=files, timeout=timeout)

    def download(self, file_id: str, target: Path, max_bytes: int) -> Path:
        """Скачать файл, присланный боту (видео из чата), не больше max_bytes."""
        info = self("getFile", file_id=file_id) or {}
        file_path = str(info.get("file_path") or "")
        if not file_path:
            raise TelegramError(0, "Telegram не отдал файл")
        local = Path(file_path)
        if local.is_absolute() and local.is_file():  # свой сервер Bot API (--local) отдаёт путь на диске
            if local.stat().st_size > max_bytes:
                raise TelegramError(413, "файл слишком большой")
            shutil.copyfile(local, target)
            return target
        try:
            with self.session.get(self.file_base + file_path, stream=True, timeout=120) as response:
                if response.status_code != 200:
                    raise TelegramError(response.status_code, "файл не скачался")
                size = 0
                with target.open("wb") as handle:
                    for chunk in response.iter_content(1 << 20):
                        size += len(chunk)
                        if size > max_bytes:
                            raise TelegramError(413, "файл слишком большой")
                        handle.write(chunk)
        except requests.RequestException as error:
            raise TelegramError(0, f"нет связи с Telegram: {self._redact(error)}") from None
        return target

    def _request(self, method: str, *, json_body: Any = None, data: Any = None, files: Any = None,
                 timeout: float | None = None) -> Any:
        last: Exception | None = None
        for attempt in range(3):
            try:
                response = self.session.post(self.base + method, json=json_body, data=data, files=files,
                                             timeout=timeout or self.timeout)
                payload = response.json()
            except (requests.RequestException, ValueError) as error:
                last = error
                if files is not None:  # файл уже частично ушёл — повторять загрузку целиком не будем
                    break
                time.sleep(1.5 * (attempt + 1))
                continue
            if payload.get("ok"):
                return payload.get("result")
            code = int(payload.get("error_code") or 0)
            retry_after = (payload.get("parameters") or {}).get("retry_after")
            if code == 429 and retry_after and attempt < 2:
                time.sleep(min(30, float(retry_after)) + 0.5)
                continue
            raise TelegramError(code, payload.get("description") or "ошибка Telegram")
        raise TelegramError(0, f"нет связи с Telegram: {self._redact(last)}")


def _name(user: Mapping[str, Any]) -> str:
    return str(user.get("first_name") or user.get("username") or "друг").strip()[:40]


def _duration(seconds: float) -> str:
    seconds = int(round(float(seconds or 0)))
    return f"{seconds // 60}:{seconds % 60:02d}"


def _until(ts: int) -> str:
    return datetime.fromtimestamp(int(ts), MSK).strftime("%d.%m.%Y")


class ReelBot:
    def __init__(self, api: TelegramApi, accounts: Accounts, billing: Billing, *, webapp_url: str,
                 public_url: str, owners: set[int], username: str = "",
                 job_file: Callable[[str], tuple[Path | None, dict[str, Any]]] | None = None,
                 make_link: Callable[[str, int], str] | None = None,
                 queue_info: Callable[[], dict[str, Any]] | None = None,
                 assistant: Any = None, work_dir: Path | None = None):
        self.api = api
        self.accounts = accounts
        self.billing = billing
        self.webapp_url = webapp_url
        self.public_url = public_url.rstrip("/")
        self.owners = set(owners)
        self.username = username
        self.job_file = job_file
        self.make_link = make_link
        self.queue_info = queue_info
        self.pool = ThreadPoolExecutor(max_workers=8, thread_name_prefix="tg")
        # Оплата не ждёт в общей очереди: на pre_checkout у бота 10 секунд.
        self.pay_pool = ThreadPoolExecutor(max_workers=3, thread_name_prefix="tg-pay")
        # Скачать видео и спросить ИИ — долго: это не должно задерживать команды и кнопки.
        self.slow_pool = ThreadPoolExecutor(max_workers=6, thread_name_prefix="tg-slow")
        # Сообщения одного человека обрабатываются строго по порядку (разные люди — параллельно):
        # иначе «/support» и следующий за ним текст могли разойтись, и текст уходил помощнику.
        self._order_lock = threading.Lock()
        self._order: dict[int, deque[Mapping[str, Any]]] = {}
        self.assistant = assistant
        self.work_dir = Path(work_dir) if work_dir else Path(".")
        self._chats: dict[int, deque[dict[str, Any]]] = {}     # последние вопросы и ответы помощника
        self._asking: set[int] = set()
        self._support_wait: dict[int, tuple[float, str]] = {}
        self._broadcasts: dict[str, str] = {}
        self._polling = False

    # --- запуск -------------------------------------------------------------

    def setup(self, webhook_url: str | None, secret: str | None, attempt: int = 1) -> None:
        """Команды, кнопка меню «Открыть студию» и вебхук (или опрос).

        Не получилось (сразу после установки HTTPS-сертификат ещё выдаётся, нет связи с Telegram) —
        повторяем сами: через 1, 2, 5 минут и дальше раз в 10 минут, пока не получится.
        """
        try:
            me = self.api("getMe")
            self.username = self.username or str(me.get("username") or "")
            self.api("setMyCommands", commands=[
                {"command": "start", "description": "Открыть Reel Lab"},
                {"command": "tariffs", "description": "Тарифы и оплата"},
                {"command": "balance", "description": "Мой тариф и остаток"},
                {"command": "help", "description": "Как пользоваться"},
                {"command": "assistant", "description": "ИИ-помощник: разбор видео и вопросы"},
                {"command": "support", "description": "Написать в поддержку"},
                {"command": "paysupport", "description": "Вопрос по оплате"},
            ])
            self.api("setChatMenuButton", menu_button={"type": "web_app", "text": "Студия",
                                                       "web_app": {"url": self.webapp_url}})
            # Описание бота: его видят до нажатия «Старт» и в профиле.
            try:
                self.api("setMyDescription", description=(
                    "Сделаю из твоего видео ролик с красивыми анимированными субтитрами для Reels, TikTok и Shorts: "
                    "распознаю речь, подберу готовый монтаж, добавлю перевод — и пришлю готовое видео сюда.\n\n"
                    "Пришли любой ролик, который понравился, — ИИ-помощник расскажет, как он сделан, и соберёт похожий.\n\n"
                    "Бесплатно — 2 ролика в день. Нажми «Старт»."))
                self.api("setMyShortDescription", short_description="Субтитры и монтаж для Reels, TikTok и Shorts за минуту")
            except TelegramError as error:
                log.warning("Описание бота не обновилось: %s", error)
            if webhook_url:
                self.api("setWebhook", url=webhook_url, secret_token=secret, allowed_updates=ALLOWED_UPDATES,
                         max_connections=20)
            else:
                self.api("deleteWebhook", drop_pending_updates=False)
                self.start_polling()
        except TelegramError as error:
            delay = {1: 60, 2: 120, 3: 300}.get(attempt, 600)
            log.error("Бот не настроился (попытка %s): %s — повторю через %s с", attempt, error, delay)
            timer = threading.Timer(delay, self.setup, args=(webhook_url, secret, attempt + 1))
            timer.daemon = True
            timer.start()

    def start_polling(self) -> None:
        if self._polling:
            return
        self._polling = True
        threading.Thread(target=self._poll_loop, daemon=True, name="tg-poll").start()

    def _poll_loop(self) -> None:
        offset = 0
        while self._polling:
            try:
                updates = self.api._request("getUpdates", json_body={"offset": offset, "timeout": 40,
                                                                     "allowed_updates": ALLOWED_UPDATES}, timeout=60)
            except TelegramError as error:
                log.warning("getUpdates: %s", error)
                time.sleep(5)
                continue
            for update in updates or []:
                offset = max(offset, int(update.get("update_id", 0)) + 1)
                self.submit(update)

    def submit(self, update: Mapping[str, Any]) -> None:
        message = update.get("message") if isinstance(update.get("message"), dict) else {}
        if "pre_checkout_query" in update or "successful_payment" in message or "refunded_payment" in message:
            self.pay_pool.submit(self.handle, update)
            return
        key = self._order_key(update)
        if key is None:
            self.pool.submit(self.handle, update)
            return
        with self._order_lock:
            waiting = self._order.get(key)
            if waiting is not None:          # у этого человека уже идёт обработка — встанет следом
                waiting.append(update)
                return
            self._order[key] = deque()
        self.pool.submit(self._handle_in_order, key, update)

    @staticmethod
    def _order_key(update: Mapping[str, Any]) -> int | None:
        """Чей это апдейт: id чата (или человека) — для очереди по порядку."""
        for field in ("message", "edited_message", "callback_query", "my_chat_member"):
            item = update.get(field)
            if isinstance(item, dict):
                chat = item.get("chat") or (item.get("message") or {}).get("chat") or {}
                who = chat.get("id") or (item.get("from") or {}).get("id")
                try:
                    return int(who) if who is not None else None
                except (TypeError, ValueError):
                    return None
        return None

    def _handle_in_order(self, key: int, update: Mapping[str, Any]) -> None:
        while True:
            self.handle(update)
            with self._order_lock:
                waiting = self._order.get(key)
                if not waiting:
                    self._order.pop(key, None)
                    return
                update = waiting.popleft()

    def slow(self, action: Callable[..., Any], *args: Any) -> None:
        """Долгое дело (скачать видео, ответ ИИ) — в отдельном пуле, ошибки — в журнал."""
        def run() -> None:
            try:
                action(*args)
            except Exception:  # noqa: BLE001
                log.exception("Ошибка в долгом деле бота")
        self.slow_pool.submit(run)

    # --- кнопки -------------------------------------------------------------

    def studio_url(self, **params: str) -> str:
        """Адрес студии с параметрами: video — открыть присланное видео, assistant — разбор, act — действие."""
        clean = {key: value for key, value in params.items() if value}
        if not clean:
            return self.webapp_url
        return self.webapp_url + ("&" if "?" in self.webapp_url else "?") + urllib.parse.urlencode(clean)

    def studio_button(self, text: str = "🎬 Открыть студию", **params: str) -> dict[str, Any]:
        return {"text": text, "web_app": {"url": self.studio_url(**params)}}

    def keyboard(self, *rows: list[dict[str, Any]]) -> dict[str, Any]:
        return {"inline_keyboard": [row for row in rows if row]}

    def send(self, chat_id: int, text: str, markup: dict[str, Any] | None = None, **extra: Any) -> Any:
        try:
            return self.api("sendMessage", chat_id=chat_id, text=text, reply_markup=markup,
                            link_preview_options={"is_disabled": True}, **extra)
        except TelegramError as error:
            if error.code == 403:
                self.accounts.set_chat(chat_id, None, bot_blocked=True)
            log.warning("sendMessage %s: %s", chat_id, error)
            return None

    # --- обработка обновлений -----------------------------------------------

    def handle(self, update: Mapping[str, Any]) -> None:
        try:
            if "pre_checkout_query" in update:
                self.on_pre_checkout(update["pre_checkout_query"])
            elif "callback_query" in update:
                self.on_callback(update["callback_query"])
            elif "message" in update:
                self.on_message(update["message"])
            elif "my_chat_member" in update:
                self.on_member(update["my_chat_member"])
        except Exception:  # noqa: BLE001 — одно сломанное обновление не должно ронять бота
            log.exception("Ошибка обработки обновления")

    def on_member(self, member: Mapping[str, Any]) -> None:
        user = member.get("from") or {}
        status = (member.get("new_chat_member") or {}).get("status")
        if user.get("id") and (member.get("chat") or {}).get("type") == "private":
            self.accounts.set_chat(int(user["id"]), None, bot_blocked=status == "kicked")

    def on_pre_checkout(self, query: Mapping[str, Any]) -> None:
        ok, message = self.billing.pre_checkout(query)
        params: dict[str, Any] = {"pre_checkout_query_id": query["id"], "ok": ok}
        if not ok:
            params["error_message"] = message
        self.api("answerPreCheckoutQuery", **params)

    def on_message(self, message: Mapping[str, Any]) -> None:
        chat = message.get("chat") or {}
        user = message.get("from") or {}
        if chat.get("type") != "private" or not user.get("id"):
            return
        user_id = int(user["id"])
        chat_id = int(chat["id"])
        if "successful_payment" in message:
            self.on_paid_message(user_id, chat_id, message["successful_payment"])
            return
        if "refunded_payment" in message:
            payload = str((message["refunded_payment"] or {}).get("invoice_payload") or "")
            if payload and self.accounts.revoke_payment(payload):
                self.send(chat_id, "Возврат звёзд оформлен, тариф за этот платёж отменён.")
            return
        text = str(message.get("text") or "").strip()
        command, _, rest = text.partition(" ")
        command = command.split("@", 1)[0].lower()
        if command == "/start":
            self.accounts.touch_user(user, ref=rest.strip()[:64])
            self.accounts.set_chat(user_id, chat_id)
            self.cmd_start(chat_id, user, rest.strip())
            return
        known = self.accounts.get_user(user_id)
        if known is None:
            self.accounts.touch_user(user)
        if user_id in self.owners and self.on_owner(chat_id, command, rest, message):
            return
        if command.startswith("/") and command not in ("/support", "/paysupport"):
            self._support_wait.pop(user_id, None)   # передумал писать в поддержку
        blocked = bool(known and known.get("blocked")) and user_id not in self.owners
        if blocked and command not in ("/support", "/paysupport", "/help", "/terms", "/privacy", "/balance", "/me") \
                and user_id not in self._support_wait:
            self.send(chat_id, "Доступ к Reel Lab закрыт. Если это ошибка — напиши /support.")
            return
        handlers = {
            "/tariffs": self.cmd_tariffs, "/plan": self.cmd_tariffs, "/buy": self.cmd_tariffs,
            "/balance": self.cmd_balance, "/me": self.cmd_balance,
            "/help": self.cmd_help, "/terms": self.cmd_terms, "/privacy": self.cmd_terms,
        }
        if command in handlers:
            handlers[command](chat_id, user_id)
            return
        if command in ("/support", "/paysupport"):
            kind = "оплата" if command == "/paysupport" else "вопрос"
            if rest.strip():
                self.forward_support(user, rest.strip(), kind)
                self.send(chat_id, "Передал. Ответ придёт сюда, в чат.")
            else:
                self._support_wait[user_id] = (time.time(), kind)
                prompt = ("Опиши проблему с оплатой одним сообщением: что покупал, когда и чем платил. "
                          "Если тариф не начислился — разберёмся и вернём звёзды или деньги."
                          if kind == "оплата" else "Напиши вопрос одним сообщением — я передам его команде Reel Lab.")
                self.send(chat_id, prompt)
            return
        waiting = self._support_wait.pop(user_id, None)
        if waiting and time.time() - waiting[0] < 30 * 60 and text:
            self.forward_support(user, text, waiting[1])
            self.send(chat_id, "Передал. Ответ придёт сюда, в чат.")
            return
        media = self.video_of(message)
        if media is not None:
            self.slow(self.on_video, chat_id, user, media, str(message.get("caption") or ""))
            return
        if message.get("document") or message.get("photo") or message.get("audio") or message.get("voice"):
            self.send(chat_id, "Пришли видео (MP4 или MOV): разберу, как оно сделано, или открою его в студии для монтажа.",
                      self.keyboard([self.studio_button()]))
            return
        if command == "/assistant":
            self.send(chat_id, (
                "✦ ИИ-помощник\n\n"
                "• Пришли любой ролик, который понравился (файлом или видео), — расскажу, как он сделан: склейки, "
                "музыка, цвет, переходы, субтитры. Кнопка «Сделать похожий» настроит студию так же.\n"
                "• Задай вопрос текстом: «как сделать переходы», «как наложить музыку», «как нарезать под бит» — отвечу.\n"
                "• В студии — кнопка «✦ ИИ-помощник»."), self.keyboard([self.studio_button(act="open:assistant")]))
            return
        if text and not text.startswith("/") and self.assistant is not None:
            if user_id in self._asking:
                self.send(chat_id, "Секунду — ещё отвечаю на прошлый вопрос. Этот пришли ещё раз после ответа.")
                return
            self._asking.add(user_id)
            self.slow(self.on_question, chat_id, user_id, text)
            return
        self.send(chat_id, "Я делаю субтитры и монтаж в студии. Нажми кнопку ниже 👇",
                  self.keyboard([self.studio_button()], [{"text": "💎 Тарифы", "callback_data": "tariffs"},
                                                         {"text": "❓ Помощь", "callback_data": "help"}]))

    # --- ИИ-помощник: видео из чата и вопросы ---------------------------------

    @staticmethod
    def video_of(message: Mapping[str, Any]) -> Mapping[str, Any] | None:
        for key in ("video", "animation", "video_note"):
            if isinstance(message.get(key), dict):
                return message[key]
        document = message.get("document")
        if isinstance(document, dict) and (str(document.get("mime_type") or "").startswith("video/")
                                           or VIDEO_NAME.search(str(document.get("file_name") or ""))):
            return document
        return None

    def fetch_limit(self) -> int:
        return 2000 * 1024 * 1024 if self.api.custom_server else FETCH_LIMIT_BYTES

    def on_video(self, chat_id: int, user: Mapping[str, Any], media: Mapping[str, Any], caption: str) -> None:
        user_id = int(user["id"])
        if self.assistant is None:
            self.send(chat_id, "Видео загружается в студии: нажми «Открыть студию» — там выбор стиля и предпросмотр.",
                      self.keyboard([self.studio_button()]))
            return
        size = int(media.get("file_size") or 0)
        if size > self.fetch_limit():
            self.send(chat_id, (f"Видео большое ({size / 1024 / 1024:.0f} МБ): Telegram не отдаёт ботам файлы больше 20 МБ. "
                                "Открой студию и выбери его там — для монтажа или в «✦ ИИ-помощник» → «Разобрать ролик»."),
                      self.keyboard([self.studio_button()]))
            return
        name = str(media.get("file_name") or "").strip() or "video.mp4"
        if not VIDEO_NAME.search(name):
            name += ".mp4"
        part = self.work_dir / f".tg-{uuid.uuid4().hex}.part"
        try:
            self.api("sendChatAction", chat_id=chat_id, action="upload_video")
        except TelegramError:
            pass
        try:
            self.api.download(str(media["file_id"]), part, self.fetch_limit())
            saved = self.assistant.save_video(user_id, part, name)
        except AccountsError as error:
            self.send(chat_id, error.message, self.keyboard([{"text": "💎 Тарифы", "callback_data": "tariffs"}]))
            return
        except TelegramError as error:
            log.warning("Видео из чата не скачалось: %s", error)
            if error.code == 413 or "too big" in error.description.lower():
                text = ("Видео больше 20 МБ: Telegram не отдаёт ботам такие файлы. Открой студию и выбери его там — "
                        "для монтажа или в «✦ ИИ-помощник» → «Разобрать ролик».")
            else:
                text = "Не получилось забрать видео из Telegram. Пришли его ещё раз или загрузи в студии."
            self.send(chat_id, text, self.keyboard([self.studio_button()]))
            return
        except Exception as error:  # noqa: BLE001 — понятная причина (формат, длина) или общая фраза
            message = getattr(error, "message", None) or "Не получилось принять это видео."
            self.send(chat_id, f"{message}", self.keyboard([self.studio_button()]))
            return
        finally:
            part.unlink(missing_ok=True)
        upload_id = str(saved["id"])
        wants = re.search(r"\?|как|разбер|разбор|сделан|повтор", caption.lower())
        if wants:
            self.start_analysis(chat_id, user_id, upload_id)
            return
        self.send(chat_id, "Видео у меня ✅ Что с ним сделать?", self.keyboard(
            [{"text": "🔍 Как это сделано? (разбор)", "callback_data": f"as:{upload_id}"}],
            [self.studio_button("✂️ Монтировать в студии", video=upload_id)]))

    def start_analysis(self, chat_id: int, user_id: int, upload_id: str) -> None:
        announced = threading.Event()

        def done(record: Mapping[str, Any]) -> None:
            announced.wait(15)   # разбор приходит после «Смотрю ролик…», а не раньше
            self.send_analysis(chat_id, record)

        try:
            self.assistant.analyse(user_id, upload_id, done)
        except AccountsError as error:
            announced.set()
            markup = self.keyboard([{"text": "💎 Тарифы", "callback_data": "tariffs"}]) if error.code == "assistant_cap" else None
            self.send(chat_id, error.message, markup)
            return
        except Exception as error:  # noqa: BLE001
            announced.set()
            self.send(chat_id, getattr(error, "message", None) or "Не получилось начать разбор. Пришли видео ещё раз.")
            return
        try:
            self.send(chat_id, "🔍 Смотрю ролик: склейки, музыку, цвет и текст. Обычно это до минуты — разбор придёт сюда.")
        finally:
            announced.set()

    def send_analysis(self, chat_id: int, record: Mapping[str, Any]) -> None:
        if record.get("status") != "done" or not record.get("result"):
            self.send(chat_id, f"Не получилось разобрать ролик 😔\n{record.get('error') or 'Попробуй другое видео.'}",
                      self.keyboard([self.studio_button()]))
            return
        result = record["result"]
        text = str(result.get("telegram") or "Разбор готов.")
        if result.get("note"):
            text += f"\n\nℹ️ {result['note']}"
        if len(text) > 4000:
            text = text[:3990].rsplit("\n", 1)[0] + "\n…"
        self.send(chat_id, text, self.keyboard(
            [self.studio_button("🎬 Сделать похожий в студии", assistant=str(record["id"]))]))

    def on_question(self, chat_id: int, user_id: int, text: str) -> None:
        self._asking.add(user_id)
        try:
            history = self._chats.get(user_id)
            if history and time.time() - (history[-1].get("t") or 0) > 1800:
                history.clear()
            try:
                self.api("sendChatAction", chat_id=chat_id, action="typing")
            except TelegramError:
                pass
            try:
                result = self.assistant.ask(user_id, text, list(history or []))
            except Exception as error:  # noqa: BLE001
                log.warning("Помощник не ответил: %s", error)
                self.send(chat_id, "ИИ-помощник сейчас не отвечает. Попробуй через минуту или напиши /support.")
                return
            answer = str(result.get("answer") or "").strip() or "Не понял вопрос. Спроси по-другому."
            store = self._chats.setdefault(user_id, deque(maxlen=8))
            store.append({"role": "user", "text": text[:500], "t": time.time()})
            store.append({"role": "assistant", "text": answer[:500], "t": time.time()})
            actions = result.get("actions") or []
            first = actions[0] if actions else None
            act = f"{first['do']}:{first['id']}" if isinstance(first, dict) and first.get("do") else ""
            self.send(chat_id, answer[:4000], self.keyboard([self.studio_button("🎬 Открыть в студии" if act else "🎬 Открыть студию", act=act)]))
        finally:
            self._asking.discard(user_id)

    def on_callback(self, query: Mapping[str, Any]) -> None:
        data = str(query.get("data") or "")
        user = query.get("from") or {}
        message = query.get("message") or {}
        chat_id = int((message.get("chat") or {}).get("id") or user.get("id") or 0)
        user_id = int(user.get("id") or 0)
        answer: dict[str, Any] = {"callback_query_id": query["id"]}
        try:
            known = self.accounts.get_user(user_id)
            if known is None:
                self.accounts.touch_user(user)
            elif known.get("blocked") and user_id not in self.owners and data.split(":", 1)[0] in ("as", "buy", "stars", "tariffs"):
                raise AccountsError("Доступ к Reel Lab закрыт. Если это ошибка — напиши /support.", 403, "blocked")
            if data == "tariffs":
                self.cmd_tariffs(chat_id, user_id)
            elif data == "help":
                self.cmd_help(chat_id, user_id)
            elif data == "balance":
                self.cmd_balance(chat_id, user_id)
            elif data.startswith("buy:"):
                self.show_payment(chat_id, user_id, data[4:])
            elif data.startswith("stars:"):
                self.billing.stars_send(chat_id, user_id, data[6:])
            elif data.startswith("bc:") and user_id in self.owners:
                self.confirm_broadcast(chat_id, data[3:])
            elif data.startswith("as:") and self.assistant is not None:
                answer.update(text="Смотрю ролик…")
                self.start_analysis(chat_id, user_id, data[3:])
        except AccountsError as error:
            answer.update(text=error.message[:190], show_alert=True)
        except TelegramError as error:
            answer.update(text=f"Telegram: {error.description}"[:190], show_alert=True)
        self.api("answerCallbackQuery", **answer)

    # --- команды ------------------------------------------------------------

    def cmd_start(self, chat_id: int, user: Mapping[str, Any], payload: str) -> None:
        text = (
            f"Привет, {_name(user)}! Я Reel Lab — делаю из твоего видео ролик с красивыми субтитрами "
            "для Reels, TikTok и Shorts.\n\n"
            "Как это работает:\n"
            "1. Нажми «Открыть студию» и загрузи видео.\n"
            "2. Я распознаю речь — проверь текст.\n"
            "3. Выбери готовый монтаж или стиль и нажми «Собрать видео».\n"
            "Готовый ролик придёт сюда, в чат.\n\n"
            "✦ Понравился чужой ролик? Пришли его сюда — расскажу, как он сделан, и соберу похожий. "
            "Есть вопрос по монтажу — просто напиши.\n\n"
            "Бесплатно — 2 ролика в день до 1 минуты (с водяным знаком). Без знака и до 3 минут — /tariffs"
        )
        self.send(chat_id, text, self.keyboard([self.studio_button()],
                                               [{"text": "💎 Тарифы", "callback_data": "tariffs"},
                                                {"text": "❓ Помощь", "callback_data": "help"}]))
        if payload.startswith("buy_") and payload[4:] in PRODUCTS:
            self.show_payment(chat_id, int(user["id"]), payload[4:])

    def cmd_help(self, chat_id: int, user_id: int) -> None:
        self.send(chat_id, (
            "Как сделать ролик:\n"
            "• «Открыть студию» → «Выбрать видео». Выбери язык речи — субтитры будут на нём.\n"
            "• Готовый монтаж — стиль, цвет, зум и звуки в одно нажатие. Или выбери стиль сам.\n"
            "• Текст можно поправить, добавить перевод второй строкой.\n"
            "• «Собрать видео» — сервер соберёт ролик и пришлёт его сюда. Телефон при этом не нагружается: "
            "можно закрыть студию.\n"
            "• Пришли сюда любое видео — разберу, как оно сделано (склейки, музыка, цвет, субтитры), "
            "или открою его в студии. Вопрос по монтажу — просто напиши его.\n\n"
            "Тарифы — /tariffs, остаток — /balance, поддержка — /support, вопрос по оплате — /paysupport."
        ), self.keyboard([self.studio_button()]))

    def cmd_terms(self, chat_id: int, user_id: int) -> None:
        self.send(chat_id, f"Оферта: {self.public_url}/legal/offer\nПолитика конфиденциальности: {self.public_url}/legal/privacy")

    def tariffs_text(self) -> str:
        lines = ["💎 Тарифы Reel Lab", ""]
        for item in PRODUCTS.values():
            lines.append(f"• {item['title']} — {item['rub']} ₽ или {item['stars']} ⭐")
            lines.append(f"  {item['text']}")
        lines += ["", "Бесплатно: 2 ролика в день до 1 минуты, с водяным знаком.",
                  "Пересобрать тот же ролик в течение суток — бесплатно."]
        return "\n".join(lines)

    def cmd_tariffs(self, chat_id: int, user_id: int) -> None:
        rows = [[{"text": f"{item['title']} — {item['rub']} ₽ / {item['stars']} ⭐", "callback_data": f"buy:{key}"}]
                for key, item in PRODUCTS.items()]
        self.send(chat_id, self.tariffs_text(), self.keyboard(*rows))

    def show_payment(self, chat_id: int, user_id: int, product_id: str) -> None:
        product = PRODUCTS.get(product_id)
        if product is None:
            raise AccountsError("Такого тарифа нет.", 400, "bad_product")
        rows = [[{"text": f"⭐ Оплатить {product['stars']} звёздами", "callback_data": f"stars:{product_id}"}]]
        if self.billing.methods()["card"]:
            rows.append([{"text": f"💳 Картой или СБП — {product['rub']} ₽", "url": self.billing.card_link(user_id, product_id)}])
        self.send(chat_id, f"{product['title']}\n{product['text']}\n\nКак удобнее оплатить?", self.keyboard(*rows))

    def balance_text(self, user_id: int) -> str:
        status = self.accounts.status(user_id)
        plan = status["plan"]
        if plan == "admin":
            return "Ты владелец бота: всё без ограничений."
        lines = []
        if plan == "unlimited":
            lines.append(f"Тариф: безлимит до {_until(status['unlimited_until'])}.")
            lines.append(f"Сегодня можно ещё {videos_ru(status['unlimited_left_today'])}.")
        if status["credits"]:
            lines.append(f"Оплаченных роликов: {status['credits']}.")
        if plan == "free":
            lines.append(f"Бесплатный тариф: сегодня осталось {videos_ru(status['free_left_today'])} "
                         f"из {status['free_per_day']} (до 1 минуты, с водяным знаком).")
            lines.append("Без знака и до 3 минут — /tariffs")
        return "\n".join(lines) or "Тариф: бесплатный."

    def cmd_balance(self, chat_id: int, user_id: int) -> None:
        self.send(chat_id, self.balance_text(user_id), self.keyboard([self.studio_button()],
                                                                     [{"text": "💎 Тарифы", "callback_data": "tariffs"}]))

    # --- оплата -------------------------------------------------------------

    def on_paid_message(self, user_id: int, chat_id: int, payment: Mapping[str, Any]) -> None:
        try:
            self.billing.stars_paid(user_id, payment)
        except AccountsError as error:
            log.error("Оплата звёздами не учтена: %s %s", error.code, payment)
            self.send(chat_id, "Оплата прошла, но я не смог начислить тариф автоматически. Уже разбираемся — "
                               "напиши /paysupport, если не начислится в течение часа.")
            self.notify_owners(f"⚠️ Оплата звёздами не учтена: user {user_id}, {error.message}, "
                               f"payload {payment.get('invoice_payload')}")

    def paid_notice(self, user_id: int, payment: Mapping[str, Any], status: Mapping[str, Any]) -> None:
        """Вызывается после любой успешной оплаты (звёзды или карта)."""
        product = PRODUCTS.get(str(payment.get("product")), {})
        user = self.accounts.get_user(user_id) or {}
        chat_id = int(user.get("chat_id") or user_id)
        self.send(chat_id, f"Оплата прошла ✅ {product.get('title', 'Тариф')} начислен.\n\n{self.balance_text(user_id)}",
                  self.keyboard([self.studio_button("🎬 Сделать ролик")]))
        amount = payment.get("amount")
        money = f"{int(amount) // 100} ₽" if payment.get("currency") == "RUB" else f"{amount} ⭐"
        self.notify_owners(f"💰 Покупка: {product.get('title')} — {money}, {user.get('first_name', '')} "
                           f"@{user.get('username', '')} (id {user_id})")

    # --- поддержка ----------------------------------------------------------

    @staticmethod
    def _unmark(value: str) -> str:
        """Чужое «#u123» в имени или тексте не должно увести ответ поддержки другому человеку."""
        return re.sub(r"#\s*u", "u", str(value or ""), flags=re.IGNORECASE)

    def forward_support(self, user: Mapping[str, Any], text: str, kind: str) -> None:
        user_id = int(user["id"])
        username = f"@{user['username']}" if user.get("username") else "без ника"
        try:
            plan = self.accounts.status(user_id)["plan"]
        except AccountsError:
            plan = "?"
        self.notify_owners(f"#u{user_id} ✉️ {kind.capitalize()} от {self._unmark(_name(user))} ({self._unmark(username)}, "
                           f"тариф {plan})\n\n{self._unmark(text[:3500])}\n\n"
                           "Ответь на это сообщение — ответ уйдёт человеку.")

    def notify_owners(self, text: str) -> None:
        for owner in self.owners:
            self.send(owner, text)

    def on_owner(self, chat_id: int, command: str, rest: str, message: Mapping[str, Any]) -> bool:
        """Команды владельца. Возвращает True, если сообщение обработано."""
        reply_to = message.get("reply_to_message") or {}
        if not command.startswith("/") and reply_to:
            match = re.match(r"#u(\d+)\b", str(reply_to.get("text") or ""))   # метка — только в начале сообщения
            if match:
                answer = str(message.get("text") or "").strip()
                if not answer:
                    self.send(chat_id, "Пока передаю только текст. Напиши ответ словами.")
                    return True
                sent = self.send(int(match.group(1)), f"Ответ поддержки Reel Lab:\n\n{answer}")
                self.send(chat_id, "Отправил." if sent is not None else "Не доставлено: человек, похоже, остановил бота.")
                return True
        args = rest.split()
        try:
            if command == "/stats":
                stats = self.accounts.stats()
                queue = self.queue_info() if self.queue_info else {}
                self.send(chat_id, (
                    "📊 Reel Lab\n"
                    f"Пользователей: {stats['users']} (новых за сутки {stats['new_24h']}, активных {stats['active_24h']})\n"
                    f"Роликов сегодня: {stats['renders_today']} (бесплатных {stats['free_renders_today']})\n"
                    f"Безлимит: {stats['unlimited_active']}, с пакетами: {stats['with_credits']}\n"
                    f"Выручка за 30 дней: {stats['revenue_30d_rub']} ₽ и {stats['revenue_30d_stars']} ⭐\n"
                    f"ИИ: сегодня {stats['ai_cost_today_rub']} ₽, за месяц {stats['ai_cost_month_rub']} ₽\n"
                    f"Очередь: {queue}"
                ))
                return True
            if command == "/user" and args:
                found = self.accounts.find_users(args[0])
                if not found:
                    self.send(chat_id, "Не найден.")
                for item in found[:5]:
                    status = self.accounts.status(int(item["id"]))
                    payments = self.accounts.recent_payments(int(item["id"]))
                    lines = [f"  {p['id']} {p['product']} {p['amount'] // 100 if p['currency'] == 'RUB' else p['amount']}"
                             f"{' ₽' if p['currency'] == 'RUB' else ' ⭐'} {p['status']}" for p in payments]
                    self.send(chat_id, f"id {item['id']} {item['first_name']} @{item['username']}\n"
                                       f"тариф {status['plan']}, роликов {status['credits']}, безлимит до "
                                       f"{_until(status['unlimited_until']) if status['unlimited_until'] else '—'}, "
                                       f"бесплатных сегодня {status['free_left_today']}, откуда: {item['ref'] or '—'}"
                                       + ("\nПлатежи:\n" + "\n".join(lines) if lines else ""))
                return True
            if command == "/grant" and len(args) >= 2:
                target = int(args[0])
                what = args[1]
                if what in PRODUCTS:
                    self.accounts.grant(target, what, reason="admin")
                elif what.startswith("credits="):
                    self.accounts.grant(target, "gift", reason="admin", credits=int(what.split("=", 1)[1]), days=0)
                elif what.startswith("days="):
                    self.accounts.grant(target, "gift", reason="admin", credits=0, days=int(what.split("=", 1)[1]))
                else:
                    self.send(chat_id, "Формат: /grant <id> pack10|pack50|unlim30|credits=N|days=N")
                    return True
                self.send(chat_id, f"Начислено. {self.balance_text(target)}")
                self.send(target, f"🎁 Тебе начислен подарок от Reel Lab!\n\n{self.balance_text(target)}",
                          self.keyboard([self.studio_button()]))
                return True
            if command in ("/block", "/unblock") and args:
                self.accounts.set_blocked(int(args[0]), command == "/block")
                self.send(chat_id, "Готово.")
                return True
            if command == "/refund" and args:
                self.billing.stars_refund(args[0])
                self.send(chat_id, "Звёзды возвращены, тариф отменён.")
                return True
            if command == "/revoke" and args:
                done = self.accounts.revoke_payment(args[0])
                self.send(chat_id, "Тариф по платежу отменён." if done else "Платёж не найден.")
                return True
            if command == "/reply" and len(args) >= 2:
                self.send(int(args[0]), f"Ответ поддержки Reel Lab:\n\n{rest.split(' ', 1)[1]}")
                self.send(chat_id, "Отправил.")
                return True
            if command == "/broadcast" and rest.strip():
                key = str(int(time.time()))
                self._broadcasts[key] = rest.strip()
                count = len(self.accounts.chat_ids())
                self.send(chat_id, f"Разослать это сообщение {count} пользователям?\n\n{rest.strip()}",
                          self.keyboard([{"text": f"Отправить всем ({count})", "callback_data": f"bc:{key}"}]))
                return True
            if command == "/admin":
                self.send(chat_id, "/stats, /user <id|ник>, /grant <id> pack10|pack50|unlim30|credits=N|days=N, "
                                   "/block <id>, /unblock <id>, /refund <платёж>, /revoke <платёж>, "
                                   "/reply <id> <текст>, /broadcast <текст>")
                return True
        except (AccountsError, TelegramError, ValueError) as error:
            self.send(chat_id, f"Ошибка: {getattr(error, 'message', None) or error}")
            return True
        return False

    def daily_report(self) -> None:
        stats = self.accounts.stats()
        self.notify_owners(
            "🌙 Итоги дня Reel Lab\n"
            f"Новых пользователей: {stats['new_24h']}, активных: {stats['active_24h']}\n"
            f"Роликов: {stats['renders_today']} (бесплатных {stats['free_renders_today']}, не собралось {stats['failed_today']})\n"
            f"ИИ сегодня: {stats['ai_cost_today_rub']} ₽ (за месяц {stats['ai_cost_month_rub']} ₽)\n"
            f"Выручка за 30 дней: {stats['revenue_30d_rub']} ₽ и {stats['revenue_30d_stars']} ⭐")

    def confirm_broadcast(self, chat_id: int, key: str) -> None:
        text = self._broadcasts.pop(key, None)
        if not text:
            self.send(chat_id, "Рассылка уже отправлена или устарела.")
            return

        def run() -> None:
            sent = failed = 0
            for target in self.accounts.chat_ids():
                if self.send(target, text, self.keyboard([self.studio_button()])):
                    sent += 1
                else:
                    failed += 1
                time.sleep(0.05)  # ~20 сообщений в секунду: ниже лимита Telegram
            self.send(chat_id, f"Рассылка готова: доставлено {sent}, не доставлено {failed}.")

        threading.Thread(target=run, daemon=True).start()
        self.send(chat_id, "Рассылка началась.")

    # --- готовые ролики -----------------------------------------------------

    def job_finished(self, job: Mapping[str, Any]) -> None:
        """Сборка закончилась: шлём ролик в чат или говорим, что пошло не так."""
        user_id = int(job.get("user_id") or 0)
        if not user_id:
            return
        user = self.accounts.get_user(user_id) or {}
        if user.get("bot_blocked"):
            return
        chat_id = int(user.get("chat_id") or user_id)
        settings = job.get("settings") or {}
        if isinstance(settings, str):
            try:
                settings = json.loads(settings)
            except ValueError:
                settings = {}
        status = job.get("status")
        if status == "cancelled":
            return
        if status != "completed":
            refunded = settings.get("charged") and settings.get("plan") in ("pack", "free")
            self.send(chat_id, f"Не получилось собрать ролик 😔\n{job.get('error') or 'Неизвестная ошибка.'}"
                               + ("\nРолик не списан — попробуй ещё раз." if refunded else ""),
                      self.keyboard([self.studio_button("Открыть студию")]))
            return
        path, info = self.job_file(str(job["id"])) if self.job_file else (None, {})
        free = bool(settings.get("watermark"))
        caption = f"Готово! 🎬 Ролик {_duration(info.get('duration') or settings.get('output_seconds') or 0)}"
        try:
            status_now = self.accounts.status(user_id)
        except AccountsError:
            status_now = {}
        if free:
            left = status_now.get("free_left_today", 0)
            caption += (f"\nБесплатных на сегодня осталось: {left}." if left else "\nБесплатные на сегодня закончились.")
            caption += "\nБез водяного знака и до 3 минут — /tariffs"
        rows: list[list[dict[str, Any]]] = [[self.studio_button("🎬 Ещё ролик")]]
        if free:
            rows.append([{"text": "💎 Убрать водяной знак", "callback_data": "tariffs"}])
        markup = self.keyboard(*rows)
        if path is None or not path.is_file():
            self.send(chat_id, caption + "\n(файл ролика не найден — собери его ещё раз)", markup)
            return
        size = path.stat().st_size
        if size <= VIDEO_LIMIT_BYTES:
            try:
                with path.open("rb") as handle:
                    self.api.upload("sendVideo", {
                        "chat_id": chat_id, "caption": caption, "supports_streaming": "true",
                        "width": info.get("width"), "height": info.get("height"),
                        "duration": int(round(float(info.get("duration") or 0))) or None,
                        "reply_markup": markup,
                    }, {"video": (info.get("file_name") or "reel.mp4", handle, "video/mp4")})
                return
            except TelegramError as error:
                log.warning("sendVideo %s: %s — шлю ссылку", chat_id, error)
        link = self.make_link(str(job["id"]), 48) if self.make_link else ""
        mb = size / 1024 / 1024
        self.send(chat_id, f"{caption}\n\nРолик большой ({mb:.0f} МБ) — забери его по ссылке (действует 48 часов):",
                  self.keyboard([{"text": "⬇️ Скачать ролик", "url": link}], *rows) if link else markup)
