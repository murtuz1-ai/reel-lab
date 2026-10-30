"""Оплата тарифов Reel Lab: звёзды Telegram и карта/СБП через Robokassa.

Звёзды (XTR) — штатный способ Telegram для цифровых товаров: счёт создаёт
бот, деньги приходят на баланс бота, вывод — через Fragment.

Карта и СБП — Robokassa: она работает с самозанятыми и сама отправляет чеки в
«Мой налог» (сервис «Робочеки СМЗ»). Человек нажимает «Картой» в студии,
открывается наша страница /pay/<платёж>, которая сразу ведёт на форму
Robokassa; после оплаты Robokassa присылает уведомление на ResultURL, мы
проверяем подпись паролем №2 и начисляем тариф.

Настройки (.env):
  ROBOKASSA_LOGIN, ROBOKASSA_PASSWORD1, ROBOKASSA_PASSWORD2 — из технических настроек магазина;
  ROBOKASSA_HASH=md5 (или sha256/sha512 — как выбрано в магазине);
  ROBOKASSA_TEST=1 — тестовый режим (тестовые пароли);
  ROBOKASSA_RECEIPT=1 — передавать состав чека (для «Робочеков»);
  REELLAB_CARD_PAYMENTS=0 — спрятать кнопку «Картой» (оставить только звёзды).
"""
from __future__ import annotations

import hashlib
import hmac
import html
import json
import logging
import os
import re
import sqlite3
import threading
import time
import urllib.parse
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Callable, Mapping

from accounts import PRODUCTS, Accounts, AccountsError

ROBOKASSA_URL = "https://auth.robokassa.ru/Merchant/Index.aspx"
_HASHES = {"md5": hashlib.md5, "sha256": hashlib.sha256, "sha512": hashlib.sha512, "sha1": hashlib.sha1,
           "sha384": hashlib.sha384}


def _env_flag(name: str, default: bool) -> bool:
    value = os.environ.get(name, "").strip().lower()
    if not value:
        return default
    return value in ("1", "true", "yes", "on", "да")


class Robokassa:
    def __init__(self, login: str, password1: str, password2: str, *, algorithm: str = "md5",
                 test: bool = False, receipt: bool = True):
        if algorithm not in _HASHES:
            raise ValueError(f"ROBOKASSA_HASH: неизвестный алгоритм {algorithm}")
        self.login = login
        self.password1 = password1
        self.password2 = password2
        self.algorithm = algorithm
        self.test = test
        self.receipt = receipt

    @classmethod
    def from_env(cls) -> "Robokassa | None":
        login = os.environ.get("ROBOKASSA_LOGIN", "").strip()
        password1 = os.environ.get("ROBOKASSA_PASSWORD1", "").strip()
        password2 = os.environ.get("ROBOKASSA_PASSWORD2", "").strip()
        if not (login and password1 and password2):
            return None
        # «SHA-256», «sha 256», «MD5» — всё приводится к sha256/md5. Неизвестный алгоритм не роняет бота:
        # оплата картой выключается (звёзды работают), причина — в журнале.
        algorithm = re.sub(r"[^a-z0-9]", "", os.environ.get("ROBOKASSA_HASH", "md5").lower()) or "md5"
        if algorithm not in _HASHES:
            logging.getLogger("reellab.billing").error(
                "ROBOKASSA_HASH=%s не поддерживается (нужно md5, sha1, sha256, sha384 или sha512) — оплата картой выключена",
                os.environ.get("ROBOKASSA_HASH"))
            return None
        return cls(login, password1, password2, algorithm=algorithm,
                   test=_env_flag("ROBOKASSA_TEST", False), receipt=_env_flag("ROBOKASSA_RECEIPT", True))

    def _hash(self, text: str) -> str:
        return _HASHES[self.algorithm](text.encode("utf-8")).hexdigest()

    @staticmethod
    def _shp(params: Mapping[str, str]) -> list[str]:
        return [f"{key}={params[key]}" for key in sorted(params)]

    def payment_fields(self, inv_id: int, rub: int, description: str, shp: Mapping[str, str],
                       email: str = "") -> dict[str, str]:
        """Поля формы оплаты. Подпись: Login:OutSum:InvId[:Receipt]:Пароль1[:Shp_…]."""
        out_sum = f"{int(rub)}.00"
        fields = {
            "MerchantLogin": self.login, "OutSum": out_sum, "InvId": str(int(inv_id)),
            "Description": description[:100], "Culture": "ru", "Encoding": "utf-8",
        }
        parts = [self.login, out_sum, str(int(inv_id))]
        if self.receipt:
            # Состав чека: одна услуга без НДС (самозанятый). «Робочеки» берут из него название.
            receipt = {
                "items": [{
                    "name": description[:128], "quantity": 1, "sum": int(rub),
                    "payment_method": "full_payment", "payment_object": "service", "tax": "none",
                }],
            }
            encoded = urllib.parse.quote(json.dumps(receipt, ensure_ascii=False, separators=(",", ":")), safe="")
            fields["Receipt"] = encoded
            parts.append(encoded)
        parts.append(self.password1)
        parts.extend(self._shp(shp))
        fields.update(shp)
        if email:
            fields["Email"] = email[:100]
        if self.test:
            fields["IsTest"] = "1"
        fields["SignatureValue"] = self._hash(":".join(parts))
        return fields

    def check_result(self, form: Mapping[str, str]) -> tuple[int, str, dict[str, str]]:
        """Уведомление ResultURL: подпись OutSum:InvId:Пароль2[:Shp_…]. Возвращает (InvId, OutSum, Shp)."""
        out_sum = str(form.get("OutSum") or form.get("out_summ") or "")
        inv_id = str(form.get("InvId") or form.get("inv_id") or "")
        signature = str(form.get("SignatureValue") or form.get("crc") or "").lower()
        shp = {key: str(value) for key, value in form.items() if key.startswith("Shp_")}
        if not (out_sum and inv_id.isdigit() and signature):
            raise AccountsError("Неполное уведомление об оплате.", 400, "bad_notification")
        expected = self._hash(":".join([out_sum, inv_id, self.password2, *self._shp(shp)])).lower()
        if not hmac.compare_digest(expected, signature):
            raise AccountsError("Подпись уведомления не совпала.", 403, "bad_signature")
        return int(inv_id), out_sum, shp


class Billing:
    def __init__(self, accounts: Accounts, *, db_path: Path, public_url: str, secret: str,
                 api: Callable[..., Any] | None = None, robokassa: Robokassa | None = None,
                 card_enabled: bool = True, on_paid: Callable[[int, dict[str, Any], dict[str, Any]], None] | None = None):
        self.accounts = accounts
        self.db_path = Path(db_path)
        self.public_url = public_url.rstrip("/")
        self.secret = secret.encode("utf-8")
        self.api = api                      # вызов Bot API: api(method, **params)
        self.robokassa = robokassa
        self.card_enabled = bool(card_enabled and robokassa is not None)
        self.on_paid = on_paid              # уведомить человека в чате
        self._lock = threading.Lock()
        with sqlite3.connect(self.db_path, timeout=30) as conn:
            conn.execute("""CREATE TABLE IF NOT EXISTS robokassa_inv (
                inv_id INTEGER PRIMARY KEY AUTOINCREMENT, payment_id TEXT UNIQUE NOT NULL, created INTEGER NOT NULL)""")
            # Номера счетов начинаются не с единицы: так их не перепутать с тестовыми.
            if conn.execute("SELECT COUNT(*) FROM robokassa_inv").fetchone()[0] == 0:
                conn.execute("INSERT OR IGNORE INTO sqlite_sequence(name, seq) VALUES('robokassa_inv', 100000)")

    # --- что доступно -------------------------------------------------------

    def methods(self) -> dict[str, bool]:
        return {"stars": self.api is not None, "card": self.card_enabled}

    @staticmethod
    def _product(product_id: str) -> dict[str, Any]:
        product = PRODUCTS.get(product_id)
        if product is None:
            raise AccountsError("Такого тарифа нет.", 400, "bad_product")
        return product

    # --- звёзды -------------------------------------------------------------

    def _invoice_params(self, user_id: int, product_id: str) -> dict[str, Any]:
        product = self._product(product_id)
        payment_id = self.accounts.create_payment(user_id, "stars", product_id, int(product["stars"]), "XTR")
        return {
            "title": f"Reel Lab: {product['title']}"[:32],
            "description": product["text"][:255],
            "payload": payment_id,
            "currency": "XTR",
            "prices": [{"label": product["title"][:32], "amount": int(product["stars"])}],
        }

    def stars_link(self, user_id: int, product_id: str) -> str:
        """Ссылка на счёт в звёздах: студия открывает её через Telegram.WebApp.openInvoice."""
        if self.api is None:
            raise AccountsError("Оплата звёздами сейчас недоступна.", 503, "stars_off")
        params = self._invoice_params(user_id, product_id)
        return str(self.api("createInvoiceLink", **params))

    def stars_send(self, chat_id: int, user_id: int, product_id: str) -> None:
        if self.api is None:
            raise AccountsError("Оплата звёздами сейчас недоступна.", 503, "stars_off")
        self.api("sendInvoice", chat_id=chat_id, **self._invoice_params(user_id, product_id))

    def pre_checkout(self, query: Mapping[str, Any]) -> tuple[bool, str]:
        """Проверка перед списанием звёзд: платёж наш, ждёт оплаты, сумма та же."""
        payment = self.accounts.payment(str(query.get("invoice_payload") or ""))
        if payment is None or payment["provider"] != "stars":
            return False, "Счёт устарел. Открой тарифы и нажми «Оплатить» ещё раз."
        if payment["status"] != "pending":
            return False, "Этот счёт уже оплачен или отменён."
        if int(payment["user_id"]) != int((query.get("from") or {}).get("id") or 0):
            return False, "Этот счёт выставлен другому человеку."
        if str(query.get("currency")) != "XTR" or int(query.get("total_amount") or 0) != int(payment["amount"]):
            return False, "Сумма счёта изменилась. Открой тарифы ещё раз."
        return True, ""

    def stars_paid(self, user_id: int, payment: Mapping[str, Any]) -> dict[str, Any] | None:
        payment_id = str(payment.get("invoice_payload") or "")
        record = self.accounts.payment(payment_id)
        if record is None or int(record["user_id"]) != int(user_id):
            raise AccountsError("Платёж не найден.", 404, "no_payment")
        status = self.accounts.complete_payment(
            payment_id, amount=int(payment.get("total_amount") or 0), currency=str(payment.get("currency") or ""),
            charge_id=str(payment.get("telegram_payment_charge_id") or ""),
            external_id=str(payment.get("telegram_payment_charge_id") or ""),
        )
        if status is not None and self.on_paid:
            self.on_paid(int(user_id), dict(record), status)
        return status

    def stars_refund(self, payment_id: str) -> None:
        record = self.accounts.payment(payment_id)
        if record is None or record["provider"] != "stars" or not record["charge_id"]:
            raise AccountsError("Платёж звёздами не найден.", 404, "no_payment")
        if record["status"] == "refunded":
            return
        self.api("refundStarPayment", user_id=int(record["user_id"]), telegram_payment_charge_id=record["charge_id"])
        self.accounts.revoke_payment(payment_id)

    # --- карта и СБП (Robokassa) --------------------------------------------

    def _sign(self, payment_id: str) -> str:
        return hmac.new(self.secret, f"pay:{payment_id}".encode("utf-8"), hashlib.sha256).hexdigest()[:24]

    def card_link(self, user_id: int, product_id: str) -> str:
        if not self.card_enabled:
            raise AccountsError("Оплата картой сейчас выключена. Можно оплатить звёздами.", 503, "card_off")
        product = self._product(product_id)
        payment_id = self.accounts.create_payment(user_id, "robokassa", product_id, int(product["rub"]) * 100, "RUB")
        with self._lock, sqlite3.connect(self.db_path, timeout=30) as conn:
            inv_id = conn.execute("INSERT INTO robokassa_inv(payment_id, created) VALUES(?,?)",
                                  (payment_id, int(time.time()))).lastrowid
        self.accounts.set_external_id(payment_id, f"rk:{inv_id}")
        return f"{self.public_url}/pay/{payment_id}?s={self._sign(payment_id)}"

    def card_form(self, payment_id: str, signature: str) -> str:
        """HTML-страница, которая сразу отправляет форму оплаты в Robokassa."""
        if not self.card_enabled or not hmac.compare_digest(self._sign(payment_id), str(signature or "")):
            raise AccountsError("Ссылка на оплату устарела. Открой тарифы в студии ещё раз.", 404, "bad_link")
        record = self.accounts.payment(payment_id)
        if record is None or record["provider"] != "robokassa":
            raise AccountsError("Платёж не найден.", 404, "no_payment")
        if record["status"] == "paid":
            return _page("Уже оплачено", "Этот тариф уже оплачен. Вернись в Telegram — всё начислено.", self._bot_link())
        if record["status"] != "pending":
            raise AccountsError("Этот платёж отменён. Открой тарифы в студии ещё раз.", 410, "payment_closed")
        inv_id = int(str(record["external_id"]).split(":", 1)[1])
        product = self._product(record["product"])
        fields = self.robokassa.payment_fields(
            inv_id, int(record["amount"]) // 100, f"Reel Lab: {product['title']}", {"Shp_pid": payment_id})
        inputs = "\n".join(f'<input type="hidden" name="{html.escape(key)}" value="{html.escape(value)}">'
                           for key, value in fields.items())
        return f"""<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Оплата Reel Lab</title>
<style>body{{font-family:system-ui,sans-serif;background:#0d0c10;color:#f3eee6;display:grid;place-items:center;min-height:100vh;margin:0}}
main{{max-width:420px;padding:24px;text-align:center}}button{{font:inherit;font-weight:700;padding:14px 22px;border-radius:14px;border:0;background:#f2c14e;color:#1a1206}}</style>
</head><body><main><h2>{html.escape(product['title'])} — {int(record['amount']) // 100} ₽</h2>
<p>Сейчас откроется защищённая страница оплаты Robokassa (карта или СБП).</p>
<form id="pay" method="post" action="{ROBOKASSA_URL}">{inputs}<button type="submit">Перейти к оплате</button></form>
<script>setTimeout(function(){{document.getElementById('pay').submit()}},400)</script></main></body></html>"""

    def robokassa_result(self, form: Mapping[str, str]) -> str:
        """ResultURL: проверяем подпись и сумму, начисляем тариф. Ответ «OK<InvId>»."""
        if self.robokassa is None:
            raise AccountsError("Оплата картой не настроена.", 503, "card_off")
        inv_id, out_sum, shp = self.robokassa.check_result(form)
        with sqlite3.connect(self.db_path, timeout=30) as conn:
            row = conn.execute("SELECT payment_id FROM robokassa_inv WHERE inv_id=?", (inv_id,)).fetchone()
        if row is None or (shp.get("Shp_pid") and shp["Shp_pid"] != row[0]):
            raise AccountsError("Счёт не найден.", 404, "no_payment")
        payment_id = row[0]
        record = self.accounts.payment(payment_id)
        if record is None:
            raise AccountsError("Счёт не найден.", 404, "no_payment")
        try:
            paid_kop = int((Decimal(out_sum) * 100).to_integral_value())
        except InvalidOperation:
            raise AccountsError("Неверная сумма в уведомлении.", 400, "bad_notification")
        status = self.accounts.complete_payment(payment_id, amount=paid_kop, currency="RUB",
                                                charge_id=f"rk:{inv_id}")
        if status is not None and self.on_paid:
            self.on_paid(int(record["user_id"]), dict(record), status)
        return f"OK{inv_id}"

    def _bot_link(self) -> str:
        username = os.environ.get("TELEGRAM_BOT_USERNAME", "").strip().lstrip("@")
        return f"https://t.me/{username}" if username else ""


def _page(title: str, text: str, link: str = "") -> str:
    button = f'<p><a href="{html.escape(link)}" style="color:#f2c14e">Вернуться в Telegram</a></p>' if link else ""
    return f"""<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>{html.escape(title)}</title>
<style>body{{font-family:system-ui,sans-serif;background:#0d0c10;color:#f3eee6;display:grid;place-items:center;min-height:100vh;margin:0}}
main{{max-width:420px;padding:24px;text-align:center}}</style></head>
<body><main><h2>{html.escape(title)}</h2><p>{html.escape(text)}</p>{button}</main></body></html>"""


def result_page(kind: str) -> str:
    username = os.environ.get("TELEGRAM_BOT_USERNAME", "").strip().lstrip("@")
    link = f"https://t.me/{username}" if username else ""
    if kind == "success":
        return _page("Оплата прошла", "Спасибо! Тариф начислится в течение минуты — вернись в Telegram, бот пришлёт подтверждение.", link)
    return _page("Оплата не прошла", "Деньги не списаны. Вернись в Telegram и попробуй ещё раз или оплати звёздами.", link)
