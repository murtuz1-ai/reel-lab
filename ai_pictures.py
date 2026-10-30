"""Картинки к словам субтитров.

ИИ-«режиссёр» (языковая модель) читает текст ролика, выбирает слова,
которые надо подсветить цветом, и слова, к которым нужна картинка, и
придумывает, что на картинке нарисовать. ИИ-«художник» (FLUX) рисует
картинку на чёрном фоне — студия потом сама вырезает фон и вплавляет её
рядом со словом.

Основной поставщик — Cloudflare Workers AI (бесплатный дневной лимит,
дальше около цента за ролик). Ключ хранится только на этом компьютере
(data/ai-settings.json) или задаётся переменными окружения на сервере бота.
Без ключа работает запасной бесплатный генератор Pollinations: медленнее,
но позволяет попробовать стиль сразу.

Сеть — только стандартная библиотека Python (urllib), чтобы переносная
версия для друга не тянула лишних пакетов.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import random
import re
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any

CF_BASE = "https://api.cloudflare.com/client/v4/accounts/{account}"
CF_IMAGE_MODELS = (
    "@cf/black-forest-labs/flux-2-klein-4b",
    "@cf/black-forest-labs/flux-1-schnell",
)
CF_RESPONSES_MODEL = "@cf/openai/gpt-oss-120b"
CF_CHAT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
POLLINATIONS_IMAGE = "https://image.pollinations.ai/prompt/"
POLLINATIONS_TEXT = "https://text.pollinations.ai/openai"
USER_AGENT = "ReelLab/1.0 (+subtitle studio)"

ACCENT_COLORS = ("gold", "green", "red", "blue", "violet", "pink")
DENSITIES = ("low", "medium", "high")
MAX_PICTURES = 60
MIN_PICTURE_GAP = 1.2  # секунд между двумя картинками

# Как выглядит картинка. Описание предмета пишет режиссёр, стиль и
# требования к фону добавляются здесь — одинаково для всех картинок ролика.
PICTURE_STYLES: dict[str, str] = {
    "cinema": "cinematic photorealistic image, dramatic rim lighting, epic mood, ultra detailed, sharp focus",
    "art": "epic digital painting, fantasy concept art, dramatic lighting, rich painterly detail",
    "3d": "glossy 3D render, soft studio lighting, stylized, smooth materials, high detail",
    "neon": "glowing neon light sculpture made of bright neon tubes, vivid saturated colors, light glow",
}
CUTOUT_SUFFIX = (
    "single subject, centered, the whole subject visible with empty space around it, "
    "isolated on a pure black background, no text, no letters, no watermark, no frame, no border"
)

STOP_WORDS = set((
    "это этот эта эти того тому такой такая также когда потому чтобы который которая которые очень "
    "всегда сегодня сейчас просто только здесь вообще можно нужно будет будут было была были есть "
    "меня тебя себя нами вами него неё них свой своя свои мой моя мои твой твоя твои наш ваш если "
    "даже тоже чтоб ведь вот где куда тогда потом теперь там тут уже еще ещё или либо хотя "
    "которыми которых которого которой котором которую кто что чего чем зачем почему"
).split())

CYRILLIC = re.compile(r"[А-Яа-яЁё]")


class AiError(Exception):
    """Понятная человеку ошибка ИИ (сообщение уже на русском)."""

    def __init__(self, message: str, status: int = 400, code: str | None = None):
        super().__init__(message)
        self.message, self.status, self.code = message, status, code


# ---------------------------------------------------------------------------
# Ключ


class AiSettings:
    """Ключ Cloudflare: из переменных окружения (сервер бота) или из файла на этом компьютере."""

    def __init__(self, data_dir: Path):
        self.path = Path(data_dir) / "ai-settings.json"
        self._lock = threading.Lock()

    def _stored(self) -> dict[str, Any]:
        try:
            value = json.loads(self.path.read_text(encoding="utf-8"))
            return value if isinstance(value, dict) else {}
        except (OSError, ValueError):
            return {}

    def load(self) -> dict[str, str]:
        env_account = os.environ.get("REELLAB_CF_ACCOUNT_ID", "").strip()
        env_token = os.environ.get("REELLAB_CF_API_TOKEN", "").strip()
        if env_account and env_token:
            return {"account_id": env_account, "api_token": env_token, "source": "env"}
        stored = self._stored()
        account = str(stored.get("account_id") or "").strip()
        token = str(stored.get("api_token") or "").strip()
        if account and token:
            return {"account_id": account, "api_token": token, "source": "local"}
        return {}

    def public(self) -> dict[str, Any]:
        current = self.load()
        if not current:
            return {"configured": False, "provider": "free", "source": None, "account_hint": ""}
        account = current["account_id"]
        return {
            "configured": True,
            "provider": "cloudflare",
            "source": current["source"],
            "account_hint": f"…{account[-4:]}" if len(account) > 4 else "",
        }

    def save(self, account_id: str, api_token: str) -> None:
        account = str(account_id or "").strip()
        token = str(api_token or "").strip()
        if not re.fullmatch(r"[0-9a-fA-F]{32}", account):
            raise AiError("Account ID — это 32 знака из цифр и латинских букв a–f. Скопируй его ещё раз со страницы Workers AI.")
        if not re.fullmatch(r"[A-Za-z0-9_\-\.]{20,200}", token):
            raise AiError("Токен выглядит неполным. Скопируй его ещё раз кнопкой Copy API Token.")
        payload = {"account_id": account.lower(), "api_token": token, "saved": int(time.time())}
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temp = self.path.with_suffix(".tmp")
            temp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
            try:
                os.chmod(temp, 0o600)
            except OSError:
                pass
            temp.replace(self.path)

    def clear(self) -> None:
        with self._lock:
            try:
                self.path.unlink()
            except FileNotFoundError:
                pass


# ---------------------------------------------------------------------------
# Сеть


_ssl_context = ssl.create_default_context()


def _http(method: str, url: str, *, headers: dict[str, str] | None = None, data: bytes | None = None,
          timeout: float = 90) -> tuple[int, bytes]:
    request = urllib.request.Request(url, data=data, method=method)
    request.add_header("User-Agent", USER_AGENT)
    for key, value in (headers or {}).items():
        request.add_header(key, value)
    try:
        with urllib.request.urlopen(request, timeout=timeout, context=_ssl_context) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        try:
            body = error.read()
        except Exception:  # noqa: BLE001 - тело ошибки может не прочитаться
            body = b""
        return error.code, body
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        reason = getattr(error, "reason", error)
        raise AiError(f"Нет связи с сервисом ИИ ({reason}). Проверь интернет и попробуй ещё раз.", 502, "network") from error


def _json(body: bytes) -> Any:
    try:
        return json.loads(body.decode("utf-8", errors="replace")) if body else {}
    except ValueError:
        return {}


def _multipart(fields: dict[str, Any]) -> tuple[bytes, str]:
    boundary = "----reellab" + uuid.uuid4().hex
    chunks: list[bytes] = []
    for key, value in fields.items():
        if value is None:
            continue
        chunks.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode("utf-8")
        )
    chunks.append(f"--{boundary}--\r\n".encode("ascii"))
    return b"".join(chunks), f"multipart/form-data; boundary={boundary}"


def _cf_messages(payload: Any) -> str:
    texts: list[str] = []
    if isinstance(payload, dict):
        for key in ("errors", "messages"):
            for item in payload.get(key) or []:
                if isinstance(item, dict) and item.get("message"):
                    texts.append(str(item["message"]))
                elif isinstance(item, str):
                    texts.append(item)
        if isinstance(payload.get("error"), str):
            texts.append(payload["error"])
        if isinstance(payload.get("error"), dict) and payload["error"].get("message"):
            texts.append(str(payload["error"]["message"]))
    return "; ".join(texts)[:300]


def _cf_error(status: int, payload: Any) -> AiError:
    message = _cf_messages(payload)
    lower = message.lower()
    if status in (401, 403) or "authentication" in lower or "unauthorized" in lower:
        return AiError("Cloudflare не принял ключ. Проверь Account ID и токен в «Ключ ИИ».", 400, "ai_auth")
    if status == 429 or "neuron" in lower or "quota" in lower or "rate limit" in lower or "capacity" in lower:
        return AiError("Бесплатный лимит ИИ на сегодня закончился (Cloudflare). Завтра он обновится — или включи оплату в Cloudflare.", 429, "ai_limit")
    if "nsfw" in lower or "safety" in lower or "flagged" in lower or "inappropriate" in lower:
        return AiError("ИИ отказался рисовать эту картинку. Опиши её по-другому.", 400, "ai_refused")
    if status >= 500:
        return AiError("Сервис ИИ Cloudflare сейчас не отвечает. Попробуй ещё раз через минуту.", 502, "ai_down")
    return AiError(f"Cloudflare ответил ошибкой ({status}): {message or 'без подробностей'}", 502, "ai_error")


class Cloudflare:
    def __init__(self, account_id: str, api_token: str):
        self.base = CF_BASE.format(account=account_id)
        self.auth = {"Authorization": f"Bearer {api_token}"}

    def run_json(self, model: str, body: dict[str, Any], timeout: float = 120) -> Any:
        status, raw = _http("POST", f"{self.base}/ai/run/{model}", data=json.dumps(body).encode("utf-8"),
                            headers={**self.auth, "Content-Type": "application/json"}, timeout=timeout)
        payload = _json(raw)
        if status == 200 and (not isinstance(payload, dict) or payload.get("success", True)):
            return payload.get("result", payload) if isinstance(payload, dict) else payload
        raise _cf_error(status, payload)

    def run_multipart(self, model: str, fields: dict[str, Any], timeout: float = 120) -> Any:
        data, content_type = _multipart(fields)
        status, raw = _http("POST", f"{self.base}/ai/run/{model}", data=data,
                            headers={**self.auth, "Content-Type": content_type}, timeout=timeout)
        payload = _json(raw)
        if status == 200 and (not isinstance(payload, dict) or payload.get("success", True)):
            return payload.get("result", payload) if isinstance(payload, dict) else payload
        raise _cf_error(status, payload)

    def responses(self, model: str, system: str, user: str, *, effort: str = "low", max_tokens: int = 6000) -> str:
        body = {
            "model": model,
            "reasoning": {"effort": effort},
            "max_output_tokens": max_tokens,
            "input": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        }
        status, raw = _http("POST", f"{self.base}/ai/v1/responses", data=json.dumps(body).encode("utf-8"),
                            headers={**self.auth, "Content-Type": "application/json"}, timeout=150)
        payload = _json(raw)
        if status != 200:
            raise _cf_error(status, payload)
        text = _output_text(payload)
        if not text:
            raise AiError("ИИ-режиссёр вернул пустой ответ.", 502, "ai_empty")
        return text

    def chat(self, model: str, system: str, user: str, *, max_tokens: int = 4096) -> str:
        result = self.run_json(model, {
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            "max_tokens": max_tokens,
            "temperature": 0.4,
        }, timeout=150)
        if isinstance(result, dict):
            response = result.get("response")
            if isinstance(response, (dict, list)):
                return json.dumps(response, ensure_ascii=False)
            if isinstance(response, str):
                return response
        text = _output_text(result)
        if not text:
            raise AiError("ИИ-режиссёр вернул пустой ответ.", 502, "ai_empty")
        return text

    def verify(self) -> None:
        status, raw = _http("GET", f"{self.base}/ai/models/search?per_page=1", headers=self.auth, timeout=30)
        payload = _json(raw)
        if status == 200 and isinstance(payload, dict) and payload.get("success", True):
            return
        raise _cf_error(status, payload)


def _output_text(payload: Any) -> str:
    """Достаёт текст ответа модели из форматов Responses API и Chat Completions."""
    found: list[str] = []

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            kind = node.get("type")
            if kind in ("output_text", "text") and isinstance(node.get("text"), str):
                found.append(node["text"])
                return
            if kind == "reasoning":
                return
            if isinstance(node.get("message"), dict) and isinstance(node["message"].get("content"), str):
                found.append(node["message"]["content"])
                return
            if isinstance(node.get("response"), str):
                found.append(node["response"])
                return
            for key, value in node.items():
                if key in ("reasoning", "usage", "metadata"):
                    continue
                walk(value)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    if isinstance(payload, dict) and isinstance(payload.get("output_text"), str):
        return payload["output_text"]
    walk(payload)
    return "\n".join(part for part in found if part.strip())


def _extract_json(text: str) -> Any:
    clean = re.sub(r"```(?:json)?", "", str(text or "")).strip()
    start = clean.find("{")
    end = clean.rfind("}")
    if start < 0 or end <= start:
        raise AiError("ИИ-режиссёр ответил не по форме. Попробуй ещё раз.", 502, "ai_format")
    try:
        return json.loads(clean[start:end + 1])
    except ValueError as error:
        raise AiError("ИИ-режиссёр ответил не по форме. Попробуй ещё раз.", 502, "ai_format") from error


# ---------------------------------------------------------------------------
# Режиссёр: какие слова подсветить и к каким нарисовать картинки


DENSITY_RULES = {
    "low": "Add about one picture per 4 phrases — only the most powerful moments.",
    "medium": "Add about one picture per 2 phrases.",
    "high": "Add a picture to almost every phrase that has a visual word (still at least ~1.5 s apart).",
}

PLAN_SYSTEM = """You are the art director of Reel Lab, a tool that adds animated Russian subtitles with small illustrations to short vertical videos (Reels, TikTok, Shorts).
You receive the transcript split into short phrases. Every word has a number. Decide:
1) which words get an accent colour;
2) which words get a small illustration that pops up next to the word.

Accent colours — the most meaningful word of a phrase, usually one per phrase, at most two, none for filler phrases:
- gold: the main emphasis, success, value, pride, fame, light
- green: action, growth, money, health, victory, nature, "yes"
- red: love, heart, danger, anger, pain, fire, war, "no"
- blue: calm, sadness, cold, water, night, sky, technology
- violet: mystery, dreams, magic, the unknown, the future
- pink: tenderness, beauty, cuteness

Illustrations:
- Only for words that can be shown as one clear, striking image: concrete nouns (monster, heart, car, crown, city), strong verbs (to fight -> two warriors clashing), or a bold visual metaphor for an abstract idea (fame -> a golden trophy under a spotlight; fear -> a dark shadowy figure with glowing eyes).
- "subject" is in English, 4-14 words, ONE subject, understood in the context of the phrase and of the whole story. Make it vivid and specific (material, pose, mood).
- Never describe text, letters, logos, brands, real or famous people, gore, blood or nudity. Do not draw the speaker ("I", "me") as a person — show the idea instead.
- Pictures at least ~2 seconds apart, never two in the same phrase.
- {density}
- Keep one consistent visual world across the whole video.

Return ONLY JSON, no comments:
{"accents":[{"w":<word number>,"color":"gold"}],"pictures":[{"w":<word number>,"subject":"..."}]}"""

SUBJECT_SYSTEM = """You write prompts for an illustration generator. Return ONLY JSON: {"subject":"..."}.
"subject" is in English, 4-14 words, ONE clear vivid subject (material, pose, mood).
Never describe text, letters, logos, brands, real or famous people, gore, blood or nudity."""


def _clean_word(text: str) -> str:
    return re.sub(r"[^\w-]+", "", str(text or ""), flags=re.UNICODE)


def _phrases_from_request(raw: Any) -> list[dict[str, Any]]:
    if not isinstance(raw, list) or not raw:
        raise AiError("Нет текста для ИИ: сначала распознай речь или загрузи субтитры.")
    phrases: list[dict[str, Any]] = []
    seen: set[int] = set()
    for item in raw[:2000]:
        if not isinstance(item, dict) or not isinstance(item.get("words"), list):
            continue
        words = []
        for word in item["words"][:40]:
            if not isinstance(word, dict):
                continue
            try:
                index = int(word.get("w"))
                start = float(word.get("start") or 0)
            except (TypeError, ValueError):
                continue
            text = str(word.get("text") or "").strip()[:60]
            if index < 0 or index in seen or not text:
                continue
            seen.add(index)
            words.append({"w": index, "text": text, "start": start})
        if words:
            phrases.append({"words": words, "start": words[0]["start"]})
    if not phrases:
        raise AiError("Нет текста для ИИ: сначала распознай речь или загрузи субтитры.")
    if sum(len(p["words"]) for p in phrases) > 6000:
        raise AiError("Текст слишком длинный для одного запроса ИИ.")
    return phrases


def _plan_prompt(phrases: list[dict[str, Any]]) -> str:
    lines = []
    for number, phrase in enumerate(phrases, 1):
        words = " | ".join(f"{word['w']} {word['text']}" for word in phrase["words"])
        lines.append(f"P{number} ({phrase['start']:.1f}s): {words}")
    return "Phrases:\n" + "\n".join(lines)


def _validate_plan(raw: Any, phrases: list[dict[str, Any]], density: str) -> dict[str, Any]:
    words: dict[int, dict[str, Any]] = {}
    phrase_of: dict[int, int] = {}
    for number, phrase in enumerate(phrases):
        for word in phrase["words"]:
            words[word["w"]] = word
            phrase_of[word["w"]] = number
    accents: list[dict[str, Any]] = []
    per_phrase: dict[int, int] = {}
    used: set[int] = set()
    for item in (raw.get("accents") if isinstance(raw, dict) else None) or []:
        try:
            index = int(item.get("w"))
        except (TypeError, ValueError, AttributeError):
            continue
        color = str(item.get("color") or "gold").lower().strip()
        if index not in words or index in used or color not in ACCENT_COLORS:
            continue
        number = phrase_of[index]
        if per_phrase.get(number, 0) >= 2:
            continue
        per_phrase[number] = per_phrase.get(number, 0) + 1
        used.add(index)
        accents.append({"w": index, "color": color})

    candidates = []
    for item in (raw.get("pictures") if isinstance(raw, dict) else None) or []:
        try:
            index = int(item.get("w"))
        except (TypeError, ValueError, AttributeError):
            continue
        subject = re.sub(r"\s+", " ", str(item.get("subject") or "")).strip()[:240]
        if index in words and subject:
            candidates.append({"w": index, "subject": subject, "start": words[index]["start"]})
    candidates.sort(key=lambda item: item["start"])
    pictures: list[dict[str, Any]] = []
    last_time = -1e9
    last_phrase = -1
    limit = MAX_PICTURES if density != "low" else MAX_PICTURES // 2
    for item in candidates:
        number = phrase_of[item["w"]]
        if number == last_phrase or item["start"] - last_time < MIN_PICTURE_GAP:
            continue
        pictures.append({"w": item["w"], "word": words[item["w"]]["text"], "subject": item["subject"]})
        last_time = item["start"]
        last_phrase = number
        if len(pictures) >= limit:
            break
    # Слово с картинкой всегда подсвечено: картинка и цвет работают вместе.
    for picture in pictures:
        if picture["w"] not in used:
            accents.append({"w": picture["w"], "color": "gold"})
            used.add(picture["w"])
    return {"accents": accents, "pictures": pictures}


VERB_ENDINGS = ("ть", "ться", "ться", "л", "ла", "ли", "ло", "лся", "лась", "ешь", "ет", "ют", "ят", "ит", "ишь",
                "ем", "им", "ни", "ите", "йте", "ай", "ей")


def _word_weight(clean: str) -> float:
    # Существительные рисуются лучше глаголов: глагольные окончания получают штраф.
    penalty = 2.5 if clean.endswith(VERB_ENDINGS) else 0.0
    return len(clean) - penalty


def _heuristic_plan(phrases: list[dict[str, Any]], density: str) -> dict[str, Any]:
    """Запасной план без языковой модели: самое весомое содержательное слово фразы."""
    step = {"low": 4, "medium": 2, "high": 1}.get(density, 2)
    accents = []
    raw_pictures = []
    for number, phrase in enumerate(phrases):
        best = None
        best_weight = 0.0
        for word in phrase["words"]:
            clean = _clean_word(word["text"]).lower()
            if len(clean) < 4 or clean in STOP_WORDS:
                continue
            weight = _word_weight(clean)
            if best is None or weight > best_weight:
                best, best_weight = word, weight
        if best is None:
            continue
        accents.append({"w": best["w"], "color": "gold"})
        if number % step == 0:
            raw_pictures.append({"w": best["w"], "subject": _clean_word(best["text"])})
    return _validate_plan({"accents": accents, "pictures": raw_pictures}, phrases, density)


# ---------------------------------------------------------------------------
# Учёт расходов: сервер бота списывает с ИИ-бюджета человека фактическую
# стоимость запроса (токены и картинки). Запросы внутри usage_scope()
# записываются сюда; без scope (локальная студия) ничего не считается.

_usage = threading.local()


class UsageScope:
    def __init__(self, tier: str = "best"):
        self.tier = tier if tier in ("best", "cheap") else "best"
        self.text: list[tuple[str, int, int]] = []
        self.images: list[str] = []
        # Сервер: сколько копеек ИИ осталось у человека. Проверяется перед каждым вызовом модели:
        # длинный перевод или монтаж — это много вызовов, и бюджет не должен уходить в минус.
        self.cap_kop: float | None = None
        self.prices: dict[str, Any] | None = None

    def ensure_budget(self) -> None:
        if self.cap_kop is None or not self.prices:
            return
        if self.cost_kop(self.prices) >= self.cap_kop:
            raise AiError("ИИ-лимит закончился посреди задачи: сделано, сколько хватило. Остальное — с новым лимитом "
                          "или в тарифах.", 402, "ai_budget")

    def add_text(self, model: str, prompt_tokens: int, completion_tokens: int) -> None:
        self.text.append((model, max(0, int(prompt_tokens or 0)), max(0, int(completion_tokens or 0))))

    def add_image(self, model: str) -> None:
        self.images.append(model)

    def cost_kop(self, prices: dict[str, Any]) -> float:
        total = 0.0
        for model, prompt, completion in self.text:
            name = model.split("://", 1)[1].split("/", 1)[1] if "://" in model and model.count("/") >= 3 else model
            name = name.split("/")[0]
            price = prices.get(name) or prices.get("default")
            if isinstance(price, (tuple, list)):
                total += prompt / 1000 * price[0] + completion / 1000 * price[1]
        total += len(self.images) * float(prices.get("image", 0))
        return total

    def units(self) -> int:
        return sum(prompt + completion for _, prompt, completion in self.text) + len(self.images)

    def describe(self) -> str:
        parts = [f"{model}:{prompt}+{completion}" for model, prompt, completion in self.text]
        if self.images:
            parts.append(f"images:{len(self.images)}")
        return " ".join(parts)[:300]


class usage_scope:  # noqa: N801 — используется как «with usage_scope(...)»
    def __init__(self, tier: str = "best"):
        self.scope = UsageScope(tier)
        self.previous: UsageScope | None = None

    def __enter__(self) -> UsageScope:
        self.previous = getattr(_usage, "scope", None)
        _usage.scope = self.scope
        return self.scope

    def __exit__(self, *_: Any) -> None:
        _usage.scope = self.previous


def current_usage() -> UsageScope | None:
    return getattr(_usage, "scope", None)


# ---------------------------------------------------------------------------
# Яндекс AI Studio: тексты (OpenAI-совместимый API), разбор картинок и рисование.
# Работает из России без иностранной карты. Настройки (.env):
#   YANDEX_API_KEY  — API-ключ сервисного аккаунта (роли ai.languageModels.user и ai.imageGeneration.user);
#   YANDEX_FOLDER_ID — ID каталога;
#   YANDEX_TEXT_MODELS — модели по порядку для платных тарифов (по умолчанию Alice AI LLM, затем DeepSeek V4.1 Flash);
#   YANDEX_TEXT_MODELS_CHEAP — для бесплатного тарифа (Alice AI LLM Flash, затем Qwen3.6 35B);
#   YANDEX_VISION_MODELS — модели, которые видят картинки (кадры ролика для ИИ-помощника): Qwen3.6 35B;
#   YANDEX_IMAGE_MODEL — художник (по умолчанию aliceai-image-art-3.0).
# gpt-oss Яндекс отключает 30.10.2026, YandexGPT Lite 5 — 15.11.2026: в списках по умолчанию их нет.
# Старые имена из .env по-прежнему работают, пока их принимает Яндекс.

YANDEX_BASE = os.environ.get("YANDEX_AI_BASE", "https://ai.api.cloud.yandex.net").strip().rstrip("/")
YANDEX_OPERATIONS = (
    f"{YANDEX_BASE}/operations/",
    "https://llm.api.cloud.yandex.net/operations/",
    "https://operation.api.cloud.yandex.net/operations/",
)
YANDEX_DEFAULT_BEST = "aliceai-llm,deepseek-v4.1-flash,yandexgpt-5.1"
YANDEX_DEFAULT_CHEAP = "aliceai-llm-flash,qwen3.6-35b-a3b,deepseek-v4.1-flash"
YANDEX_DEFAULT_VISION = "qwen3.6-35b-a3b"
YANDEX_DEFAULT_IMAGE = "aliceai-image-art-3.0"
# Старые семейства моделей адресуются с веткой «/latest»; новые — просто по имени.
_YANDEX_LEGACY = {"yandexgpt", "yandexgpt-lite", "yandexgpt-32k", "llama", "llama-lite", "summarization"}
# Модели с «размышлениями»: просим думать поменьше — дешевле и быстрее.
_YANDEX_REASONING = ("gpt-oss", "deepseek", "qwen")


def _model_list(value: str, default: str) -> list[str]:
    items = [item.strip() for item in (value or default).split(",") if item.strip()]
    return items or [item.strip() for item in default.split(",")]


def _model_problem(status: int, payload: Any) -> bool:
    """Ответ Яндекса про саму модель (нет такой, не тот адрес, не разрешена) — пробуем другой адрес или модель."""
    if status == 404:
        return True
    if status != 400:
        return False
    text = json.dumps(payload, ensure_ascii=False).lower() if payload else ""
    return any(word in text for word in ("model", "модел", "not found", "not allowed", "unknown", "does not exist", "uri"))


class YandexAI:
    def __init__(self, api_key: str, folder_id: str, best: list[str], cheap: list[str], *, iam: bool = False,
                 vision: list[str] | None = None, image_model: str = YANDEX_DEFAULT_IMAGE):
        self.api_key = api_key
        self.folder_id = folder_id
        self.models = {"best": best, "cheap": cheap}
        self.vision_models = vision or _model_list("", YANDEX_DEFAULT_VISION)
        self.image_model = image_model or YANDEX_DEFAULT_IMAGE
        self.iam = iam
        self._broken: dict[str, float] = {}
        self._form: dict[str, str] = {}      # какой адрес модели сработал
        self._old_art = False                 # новый художник недоступен — сразу старый YandexART

    @classmethod
    def from_env(cls) -> "YandexAI | None":
        key = os.environ.get("YANDEX_API_KEY", "").strip()
        folder = os.environ.get("YANDEX_FOLDER_ID", "").strip()
        if not (key and folder):
            return None
        return cls(key, folder,
                   _model_list(os.environ.get("YANDEX_TEXT_MODELS", ""), YANDEX_DEFAULT_BEST),
                   _model_list(os.environ.get("YANDEX_TEXT_MODELS_CHEAP", ""), YANDEX_DEFAULT_CHEAP),
                   vision=_model_list(os.environ.get("YANDEX_VISION_MODELS", ""), YANDEX_DEFAULT_VISION),
                   image_model=os.environ.get("YANDEX_IMAGE_MODEL", "").strip() or YANDEX_DEFAULT_IMAGE)

    def _headers(self) -> dict[str, str]:
        auth = f"Bearer {self.api_key}" if self.iam else f"Api-Key {self.api_key}"
        return {"Authorization": auth, "OpenAI-Project": self.folder_id, "x-folder-id": self.folder_id,
                "Content-Type": "application/json"}

    def _uri(self, model: str) -> str:
        return self._uris(model)[0]

    def _uris(self, model: str) -> list[str]:
        """Адреса модели по порядку: сначала тот, что уже сработал."""
        if model.startswith(("gpt://", "art://")):
            return [model]
        base = f"gpt://{self.folder_id}/{model}"
        if "/" in model:
            return [base]
        forms = [f"{base}/latest", base] if model in _YANDEX_LEGACY else [base, f"{base}/latest"]
        known = self._form.get(model)
        if known in forms:
            forms.remove(known)
            forms.insert(0, known)
        return forms

    @staticmethod
    def _error(status: int, payload: Any) -> AiError:
        message = ""
        if isinstance(payload, dict):
            error = payload.get("error")
            message = (error.get("message") if isinstance(error, dict) else str(error or "")) or str(payload.get("message") or "")
        if status in (401, 403):
            return AiError("Ключ Яндекса не подходит или у него нет прав. Проверь YANDEX_API_KEY и роли сервисного аккаунта.",
                           502, "ai_auth")
        if status == 429:
            return AiError("Яндекс просит подождать: слишком много запросов. Попробуй через минуту.", 429, "ai_limit")
        return AiError(f"ИИ Яндекса не ответил ({status}). {message}".strip(), 502, "ai_error")

    def _complete(self, model: str, messages: list[dict[str, Any]], max_tokens: int, temperature: float) -> tuple[int, Any]:
        """Один запрос к модели: перебирает адреса модели и убирает reasoning_effort, если его не понимают."""
        last: tuple[int, Any] = (0, {})
        for uri in self._uris(model):
            body: dict[str, Any] = {"model": uri, "messages": messages, "max_tokens": int(max_tokens),
                                    "temperature": temperature}
            if model.startswith(_YANDEX_REASONING):
                body["reasoning_effort"] = "low"  # меньше «размышлений» — дешевле и быстрее
            for attempt in range(2):
                status, raw = _http("POST", f"{YANDEX_BASE}/v1/chat/completions", headers=self._headers(),
                                    data=json.dumps(body, ensure_ascii=False).encode("utf-8"), timeout=150)
                payload = _json(raw)
                if status == 400 and "reasoning_effort" in body and attempt == 0:
                    # Модель не понимает reasoning_effort — повторим без него. «Нет такой модели» — сразу другой адрес.
                    said = json.dumps(payload, ensure_ascii=False).lower() if payload else ""
                    if "reasoning" in said or not _model_problem(status, payload):
                        body.pop("reasoning_effort", None)
                        continue
                break
            if status == 200:
                self._form[model] = uri
                return status, payload
            last = (status, payload)
            if not _model_problem(status, payload):
                break
        return last

    def _answer(self, model: str, status: int, payload: Any) -> str | None:
        if status != 200 or not isinstance(payload, dict):
            return None
        choices = payload.get("choices") or []
        message = (choices[0].get("message") if choices and isinstance(choices[0], dict) else None) or {}
        text = message.get("content") if isinstance(message, dict) else None
        if isinstance(text, list):
            text = "".join(str(part.get("text", "")) for part in text if isinstance(part, dict))
        usage = payload.get("usage") if isinstance(payload.get("usage"), dict) else {}
        scope = current_usage()
        if scope is not None:
            scope.add_text(model, usage.get("prompt_tokens") or usage.get("input_tokens") or 0,
                           usage.get("completion_tokens") or usage.get("output_tokens") or 0)
        return text if isinstance(text, str) and text.strip() else None

    def _run(self, models: list[str], messages: list[dict[str, Any]], max_tokens: int, temperature: float) -> str:
        last: AiError | None = None
        scope = current_usage()
        if scope is not None:
            scope.ensure_budget()
        for model in models:
            if time.time() - self._broken.get(model, 0) < 600:
                continue  # модель недавно не отвечала (нет в каталоге и т. п.) — сразу следующая
            status, payload = self._complete(model, messages, max_tokens, temperature)
            text = self._answer(model, status, payload)
            if text is not None:
                return text
            if status == 200:
                last = AiError("ИИ Яндекса прислал пустой ответ.", 502, "ai_empty")
                continue
            error = self._error(status, payload)
            if error.code in ("ai_auth", "ai_limit"):
                raise error
            if _model_problem(status, payload):
                self._broken[model] = time.time()
            last = error
        raise last or AiError("ИИ Яндекса недоступен.", 502, "ai_error")

    def chat(self, system: str, user: str, *, tier: str = "best", max_tokens: int = 4000, temperature: float = 0.3) -> str:
        messages = [{"role": "system", "content": system}, {"role": "user", "content": user}]
        return self._run(self.models.get(tier) or self.models["best"], messages, max_tokens, temperature)

    def vision(self, system: str, text: str, images: list[bytes], *, max_tokens: int = 1500,
               temperature: float = 0.2) -> str:
        """Вопрос о картинках (JPEG или PNG): модель видит кадры и отвечает текстом."""
        content: list[dict[str, Any]] = [{"type": "text", "text": text}]
        for data in images:
            kind = "png" if data[:8] == b"\x89PNG\r\n\x1a\n" else "jpeg"
            content.append({"type": "image_url",
                            "image_url": {"url": f"data:image/{kind};base64,{base64.b64encode(data).decode('ascii')}"}})
        messages = [{"role": "system", "content": system}, {"role": "user", "content": content}]
        return self._run(self.vision_models, messages, max_tokens, temperature)

    def image(self, prompt: str, seed: int) -> bytes:
        """Картинка 1:1. Новый OpenAI-совместимый художник (Alice AI ART); старый YandexART — запасной путь."""
        scope = current_usage()
        if scope is not None:
            scope.ensure_budget()
        if not self._old_art:
            model = self.image_model if self.image_model.startswith("art://") else f"art://{self.folder_id}/{self.image_model}"
            body = {"model": model, "prompt": prompt[:500], "size": "1024x1024"}
            status, raw = _http("POST", f"{YANDEX_BASE}/v1/images/generations", headers=self._headers(),
                                data=json.dumps(body, ensure_ascii=False).encode("utf-8"), timeout=150)
            payload = _json(raw)
            if status == 200 and isinstance(payload, dict):
                items = payload.get("data") or []
                first = items[0] if items and isinstance(items[0], dict) else {}
                data: bytes | None = None
                if first.get("b64_json"):
                    try:
                        data = base64.b64decode(first["b64_json"])
                    except ValueError as error:
                        raise AiError("Художник Яндекса прислал повреждённую картинку.", 502, "ai_bad_image") from error
                elif first.get("url"):
                    got, data = _http("GET", str(first["url"]), timeout=60)
                    if got != 200:
                        data = None
                if not data:
                    raise AiError("Художник Яндекса ничего не нарисовал.", 502, "ai_empty")
                scope = current_usage()
                if scope is not None:
                    scope.add_image(self.image_model)
                return data
            text = raw.decode("utf-8", errors="replace").lower()
            if status == 400 and ("ethic" in text or "safety" in text or "moderat" in text):
                raise AiError("Яндекс не стал рисовать это слово. Опиши картинку по-другому.", 422, "ai_refused")
            if status in (401, 403) and "model" not in text:
                raise self._error(status, payload)
            if status == 429:
                raise self._error(status, payload)
            if not (_model_problem(status, payload) or status in (403, 405, 501)):
                raise self._error(status, payload)
            self._old_art = True  # у этого каталога только старый художник
        return self._image_async(prompt, seed)

    def _image_async(self, prompt: str, seed: int) -> bytes:
        body = {
            "modelUri": f"art://{self.folder_id}/yandex-art/latest",
            "generationOptions": {"seed": str(int(seed) % 2_000_000_000), "mimeType": "image/jpeg",
                                  "aspectRatio": {"widthRatio": "1", "heightRatio": "1"}},
            "messages": [{"weight": "1", "text": prompt[:500]}],
        }
        status, raw = _http("POST", f"{YANDEX_BASE}/foundationModels/v1/imageGenerationAsync", headers=self._headers(),
                            data=json.dumps(body, ensure_ascii=False).encode("utf-8"), timeout=60)
        payload = _json(raw)
        if status != 200 or not isinstance(payload, dict) or not payload.get("id"):
            error = self._error(status, payload)
            if status == 400 and "ethic" in raw.decode("utf-8", errors="replace").lower():
                raise AiError("Яндекс не стал рисовать это слово. Опиши картинку по-другому.", 422, "ai_refused")
            raise error
        operation = str(payload["id"])
        deadline = time.time() + 120
        bases = list(YANDEX_OPERATIONS)
        while time.time() < deadline:
            time.sleep(1.5)
            status, raw = _http("GET", bases[0] + urllib.parse.quote(operation), headers=self._headers(), timeout=30)
            if status == 404 and len(bases) > 1:
                bases.pop(0)  # другой адрес службы операций
                continue
            result = _json(raw)
            if status != 200 or not isinstance(result, dict):
                continue
            if result.get("error"):
                message = str((result.get("error") or {}).get("message") or "")
                if "ethic" in message.lower() or "safety" in message.lower():
                    raise AiError("Яндекс не стал рисовать это слово. Опиши картинку по-другому.", 422, "ai_refused")
                raise AiError(f"Художник Яндекса не справился: {message}"[:300], 502, "ai_error")
            if result.get("done"):
                image = (result.get("response") or {}).get("image")
                if not image:
                    raise AiError("Художник Яндекса ничего не нарисовал.", 502, "ai_empty")
                scope = current_usage()
                if scope is not None:
                    scope.add_image("yandex-art")
                try:
                    return base64.b64decode(image)
                except ValueError as error:
                    raise AiError("Художник Яндекса прислал повреждённую картинку.", 502, "ai_bad_image") from error
        raise AiError("Художник Яндекса рисует слишком долго. Попробуй ещё раз.", 504, "ai_timeout")


def _compact_png(data: bytes) -> bytes:
    """Большой PNG без прозрачности → JPEG: картинка к слову в 5–10 раз легче, на вид та же."""
    if data[:8] != b"\x89PNG\r\n\x1a\n" or len(data) < 300_000 or len(data) < 26 or data[25] not in (0, 2):
        return data
    import shutil
    import subprocess
    try:
        done = subprocess.run([shutil.which("ffmpeg") or "ffmpeg", "-v", "error", "-f", "png_pipe", "-i", "-",
                               "-q:v", "3", "-f", "mjpeg", "-"], input=data, capture_output=True, timeout=30,
                              creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except (OSError, subprocess.SubprocessError):
        return data
    return done.stdout if done.returncode == 0 and done.stdout[:3] == b"\xff\xd8\xff" else data


class PicturesService:
    def __init__(self, data_dir: Path):
        self.settings = AiSettings(data_dir)
        self.folder = Path(data_dir) / "pictures"
        self.folder.mkdir(parents=True, exist_ok=True)
        self.yandex = YandexAI.from_env()
        self._pollinations_lock = threading.Lock()
        self._pollinations_last = 0.0

    # --- ключ ---------------------------------------------------------------

    def configured(self) -> bool:
        return self.yandex is not None or bool(self.settings.load())

    def provider(self) -> str:
        return "yandex" if self.yandex is not None else ("cloudflare" if self.settings.load() else "free")

    def cloudflare(self) -> Cloudflare | None:
        current = self.settings.load()
        if not current:
            return None
        return Cloudflare(current["account_id"], current["api_token"])

    def save_key(self, account_id: str, api_token: str) -> dict[str, Any]:
        account = str(account_id or "").strip().lower()
        token = str(api_token or "").strip()
        self.settings.save(account, token)
        try:
            Cloudflare(account, token).verify()
        except AiError as error:
            if error.code == "ai_auth":
                self.settings.clear()
                raise
            return {**self.settings.public(), "warning": error.message}
        return self.settings.public()

    # --- языковая модель ----------------------------------------------------

    def _ask_json(self, system: str, user: str, *, max_tokens: int = 6000) -> tuple[Any, str]:
        budget = current_usage()
        if budget is not None:
            budget.ensure_budget()
        if self.yandex is not None:
            scope = current_usage()
            tier = scope.tier if scope is not None else "best"
            try:
                text = self.yandex.chat(system, user, tier=tier, max_tokens=min(max_tokens, 6000))
                return _extract_json(text), f"yandex:{tier}"
            except AiError as error:
                if error.code == "ai_auth" or self.cloudflare() is None:
                    raise
        client = self.cloudflare()
        errors: list[str] = []
        limit_error: AiError | None = None
        if client is not None:
            try:
                text = client.responses(CF_RESPONSES_MODEL, system, user, max_tokens=max_tokens)
                return _extract_json(text), f"cloudflare:{CF_RESPONSES_MODEL}"
            except AiError as error:
                if error.code == "ai_auth":
                    raise
                if error.code == "ai_limit":
                    limit_error = error
                else:
                    errors.append(error.message)
            if limit_error is None:
                try:
                    text = client.chat(CF_CHAT_MODEL, system, user, max_tokens=min(max_tokens, 4096))
                    return _extract_json(text), f"cloudflare:{CF_CHAT_MODEL}"
                except AiError as error:
                    if error.code == "ai_auth":
                        raise
                    if error.code == "ai_limit":
                        limit_error = error
                    else:
                        errors.append(error.message)
            if limit_error is None:
                raise AiError(errors[-1] if errors else "ИИ-режиссёр не ответил.", 502, "ai_error")
        # Без ключа или когда дневной лимит Cloudflare исчерпан: бесплатный текстовый сервис Pollinations.
        try:
            body = json.dumps({
                "model": "openai",
                "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
                "temperature": 0.4,
            }).encode("utf-8")
            status, raw = _http("POST", POLLINATIONS_TEXT, data=body, headers={"Content-Type": "application/json"}, timeout=120)
            if status != 200:
                raise AiError(f"Бесплатный ИИ-режиссёр недоступен ({status}).", 502, "free_text_down")
            payload = _json(raw)
            text = _output_text(payload) if isinstance(payload, (dict, list)) else ""
            if not text:
                text = raw.decode("utf-8", errors="replace")
            return _extract_json(text), "pollinations:text"
        except AiError:
            if limit_error is not None:
                raise limit_error
            raise

    def plan(self, raw_phrases: Any, density: str = "medium") -> dict[str, Any]:
        density = density if density in DENSITIES else "medium"
        phrases = _phrases_from_request(raw_phrases)
        system = PLAN_SYSTEM.replace("{density}", DENSITY_RULES[density])
        try:
            raw, provider = self._ask_json(system, _plan_prompt(phrases))
            plan = _validate_plan(raw, phrases, density)
            if not plan["pictures"] and not plan["accents"]:
                raise AiError("пустой план", 502, "ai_empty")
            return {**plan, "provider": provider, "smart": True}
        except AiError as error:
            if error.code in ("ai_auth", "ai_limit"):
                raise
            plan = _heuristic_plan(phrases, density)
            return {**plan, "provider": "rules", "smart": False,
                    "note": "ИИ-режиссёр не ответил, слова подобраны по простому правилу. " + error.message}

    def subject(self, word: str, phrase: str, description: str = "") -> dict[str, Any]:
        word = str(word or "").strip()[:60]
        phrase = str(phrase or "").strip()[:400]
        description = str(description or "").strip()[:400]
        if not (word or description):
            raise AiError("Не указано, что нарисовать.")
        if description and not CYRILLIC.search(description):
            return {"subject": description[:240], "provider": "user"}
        user = f"Word: «{word}». Phrase: «{phrase}»."
        if description:
            user += f" The user describes the picture like this (follow it closely): «{description}»."
        try:
            raw, provider = self._ask_json(SUBJECT_SYSTEM, user, max_tokens=800)
            subject = re.sub(r"\s+", " ", str(raw.get("subject") or "")).strip()[:240] if isinstance(raw, dict) else ""
            if subject:
                return {"subject": subject, "provider": provider}
        except AiError as error:
            if error.code in ("ai_auth", "ai_limit"):
                raise
        # Перевода нет — художник получит русские слова (Pollinations сам их переведёт).
        return {"subject": description or word, "provider": "raw"}

    # --- художник -----------------------------------------------------------

    @staticmethod
    def build_prompt(subject: str, style: str) -> str:
        look = PICTURE_STYLES.get(style, PICTURE_STYLES["cinema"])
        return f"{subject.strip().rstrip('.')}, {look}, {CUTOUT_SUFFIX}"

    def _cached(self, key: str) -> Path | None:
        for ext in ("jpg", "png", "webp"):
            path = self.folder / f"{key}.{ext}"
            if path.is_file() and path.stat().st_size > 0:
                return path
        return None

    def _store(self, key: str, data: bytes) -> Path:
        if data[:8] == b"\x89PNG\r\n\x1a\n":
            ext = "png"
        elif data[:3] == b"\xff\xd8\xff":
            ext = "jpg"
        elif data[:4] == b"RIFF" and data[8:12] == b"WEBP":
            ext = "webp"
        else:
            raise AiError("Художник прислал не картинку. Попробуй ещё раз.", 502, "ai_bad_image")
        path = self.folder / f"{key}.{ext}"
        temp = path.with_suffix(f".{ext}.tmp")
        temp.write_bytes(data)
        temp.replace(path)
        return path

    def bank_key(self, subject: str, style: str) -> str:
        """Общий банк картинок: тот же предмет в том же стиле второй раз не рисуется (и не стоит денег)."""
        normal = re.sub(r"[^\w ]+", " ", subject.lower().replace("ё", "е"))
        normal = " ".join(normal.split())
        return hashlib.sha1(f"bank|{self.provider()}|{style}|{normal}".encode("utf-8")).hexdigest()

    def generate(self, subject: str, style: str = "cinema", seed: int | None = None, size: int = 512,
                 fresh: bool = True) -> dict[str, Any]:
        subject = re.sub(r"\s+", " ", str(subject or "")).strip()[:240]
        if not subject:
            raise AiError("Не указано, что нарисовать.")
        style = style if style in PICTURE_STYLES else "cinema"
        size = 1024 if int(size or 512) >= 1024 else 512
        seed = int(seed) if seed is not None else random.randint(1, 2_000_000_000)
        seed = abs(seed) % 2_000_000_000 or 1
        if not fresh:
            banked = self._cached(self.bank_key(subject, style))
            if banked is not None:
                return {"url": f"/api/pictures/file/{banked.name}", "name": banked.name, "subject": subject,
                        "prompt": "", "seed": seed, "provider": self.provider(), "model": "bank"}
        if self.yandex is not None:
            # YandexART понимает русский: переводить предмет не нужно (и это экономит запрос к ИИ).
            prompt = self.build_prompt(subject, style)
            key = self.bank_key(subject, style) if not fresh else \
                hashlib.sha1(f"yandex|{seed}|{prompt}".encode("utf-8")).hexdigest()
            cached = self._cached(key)
            if cached is None:
                cached = self._store(key, _compact_png(self.yandex.image(prompt, seed)))
                model = self.yandex.image_model
            else:
                model = "cache"
            if fresh:
                # Новая картинка тоже ложится в банк — пригодится следующему.
                bank = self.bank_key(subject, style)
                if self._cached(bank) is None:
                    self._store(bank, cached.read_bytes())
            return {"url": f"/api/pictures/file/{cached.name}", "name": cached.name, "subject": subject,
                    "prompt": prompt, "seed": seed, "provider": "yandex", "model": model}
        client = self.cloudflare()
        if client is not None and CYRILLIC.search(subject):
            subject = self.subject(subject, subject)["subject"]
        prompt = self.build_prompt(subject, style)
        provider = "cloudflare" if client is not None else "pollinations"
        key = hashlib.sha1(f"{provider}|{size}|{seed}|{prompt}".encode("utf-8")).hexdigest()
        if provider == "pollinations":
            # «f» — картинка бесплатного генератора: студия срежет его подпись в углу.
            key = "f" + key[:39]
        cached = self._cached(key)
        if cached is None:
            data, model = self._draw_cloudflare(client, prompt, seed, size) if client is not None \
                else self._draw_pollinations(prompt, seed, size)
            cached = self._store(key, data)
        else:
            model = "cache"
        return {"url": f"/api/pictures/file/{cached.name}", "name": cached.name, "subject": subject,
                "prompt": prompt, "seed": seed, "provider": provider, "model": model}

    def _draw_cloudflare(self, client: Cloudflare, prompt: str, seed: int, size: int) -> tuple[bytes, str]:
        last: AiError | None = None
        for model in CF_IMAGE_MODELS:
            try:
                if model.endswith("flux-2-klein-4b"):
                    result = client.run_multipart(model, {"prompt": prompt, "width": size, "height": size, "seed": seed})
                else:
                    result = client.run_json(model, {"prompt": prompt, "steps": 6, "seed": seed})
            except AiError as error:
                if error.code in ("ai_auth", "ai_limit", "ai_refused", "network"):
                    raise
                last = error
                continue
            image = result.get("image") if isinstance(result, dict) else None
            if isinstance(image, str) and image:
                if image.startswith("data:"):
                    image = image.split(",", 1)[-1]
                try:
                    return base64.b64decode(image), model
                except ValueError:
                    last = AiError("Художник прислал повреждённую картинку.", 502, "ai_bad_image")
                    continue
            last = AiError("Художник ничего не нарисовал. Попробуй ещё раз.", 502, "ai_empty")
        raise last or AiError("Художник недоступен.", 502, "ai_error")

    def _draw_pollinations(self, prompt: str, seed: int, size: int) -> tuple[bytes, str]:
        query = urllib.parse.urlencode({
            "width": size, "height": size, "seed": seed, "nologo": "true", "model": "flux",
            "enhance": "true" if CYRILLIC.search(prompt) else "false", "safe": "true", "referrer": "reellab",
        })
        url = POLLINATIONS_IMAGE + urllib.parse.quote(prompt, safe="") + "?" + query
        attempts = 3
        for attempt in range(attempts):
            # Бесплатный режим разрешает примерно один запрос в несколько секунд.
            with self._pollinations_lock:
                pause = 5.0 - (time.time() - self._pollinations_last)
                if pause > 0:
                    time.sleep(pause)
                status, raw = _http("GET", url, timeout=120)
                self._pollinations_last = time.time()
            if status == 200 and raw[:3] in (b"\xff\xd8\xff", b"\x89PN", b"RIF"):
                return raw, "pollinations:flux"
            if status in (401, 402, 403):
                raise AiError("Бесплатный генератор на сегодня больше не рисует без ключа. Добавь свой ключ ИИ — "
                              "это бесплатно и займёт 5 минут (кнопка «Ключ ИИ» вверху).", 429, "free_limit")
            if status == 429 and attempt < attempts - 1:
                time.sleep(16)
                continue
            if status == 429:
                raise AiError("Бесплатный генератор перегружен. Подожди минуту или добавь свой ключ ИИ — он намного быстрее.", 429, "free_limit")
            if status >= 500 and attempt < attempts - 1:
                time.sleep(3)
                continue
            raise AiError(f"Бесплатный генератор картинок не ответил ({status}). Добавь свой ключ ИИ или попробуй позже.", 502, "free_down")
        raise AiError("Бесплатный генератор картинок не ответил.", 502, "free_down")

    # --- свои картинки ------------------------------------------------------

    def store_upload(self, data: bytes) -> dict[str, Any]:
        if not data:
            raise AiError("Файл картинки пустой.")
        if len(data) > 12 * 1024 * 1024:
            raise AiError("Картинка больше 12 МБ — выбери файл поменьше.")
        key = "u" + hashlib.sha1(data).hexdigest()[:39]
        path = self._cached(key) or self._store(key, data)
        return {"url": f"/api/pictures/file/{path.name}", "name": path.name, "provider": "user"}

    def file_path(self, name: str) -> Path | None:
        if not re.fullmatch(r"[0-9a-fu]{40}\.(?:jpg|png|webp)", name or ""):
            return None
        path = self.folder / name
        return path if path.is_file() else None


# ---------------------------------------------------------------------------
# ИИ-монтажёр: лишние слова, хук и описание, лучшие моменты, перевод

SMARTCUT_SYSTEM = """You edit spoken Russian transcripts of short vertical videos to make the speech tight.
Every word has a number. Find words that should be cut:
- filler sounds and filler words (э, ээ, эм, мм, ну, типа, как бы, короче, вот, значит, это самое) — ONLY when they carry no meaning in this place;
- stutters and immediate repeats of the same word ("я я хотел" -> remove one "я");
- false starts: a phrase that is abandoned and restarted — remove the abandoned part;
- repeated takes: if the same sentence is said twice, remove the earlier attempt.
Never remove meaningful words, never break grammar. Be conservative: when unsure, keep the word.
Return ONLY JSON: {"remove":[{"from":<first word number>,"to":<last word number>,"reason":"filler|repeat|false_start|retake"}]}"""

HOOK_SYSTEM = """You are a social media editor for Russian short videos (Reels, TikTok, Shorts).
From the transcript write, in Russian:
- "hook": a short catchy line (max 7 words) shown on screen in the first 2 seconds; intriguing, honest (no false clickbait), no emojis, no quotes;
- "title": a short title (max 8 words);
- "description": 1-3 sentences for the post;
- "hashtags": 5-8 relevant hashtags (Russian or English), each starting with #, no spaces.
Return ONLY JSON: {"hook":"...","title":"...","description":"...","hashtags":["#..."]}"""

MOMENTS_SYSTEM = """You pick the best standalone moments from a long Russian video transcript for short vertical clips.
Sentences are numbered and have start/end times in seconds. Each moment must:
- make sense on its own, without the rest of the video;
- start at the beginning of a sentence and end at the end of a sentence;
- grab attention in the first seconds;
- last between {min} and {max} seconds.
Return 3-5 non-overlapping moments, best first.
Return ONLY JSON: {"moments":[{"from":<sentence number>,"to":<sentence number>,"title":"короткое название по-русски","why":"почему это сильный момент, по-русски"}]}"""

TRANSLATE_SYSTEM = """Translate numbered subtitles of a short social media video into {language}. The subtitles may be in any language (Russian, Arabic, English, Turkish and others); if an item is already in {language}, keep it as it is.
Each item is a whole sentence (or a whole spoken phrase). Translate every item as a whole, the way a native speaker would naturally say it in such a video: correct grammar and natural word order of the target language, simple everyday words, same meaning and tone.
Keep names, brands and English words as they are. Write numbers with the digits 0-9. Do not merge or split items, do not add numbering, quotes or explanations.
Return ONLY JSON: {"lines":["...", "..."]} with exactly {count} lines, in the same order."""

LANGUAGES = {
    "ru": "Russian (natural spoken Russian, as in popular Russian social media videos)",
    "az": "Azerbaijani (Latin script)", "tg": "Tajik (Cyrillic script)",
    "en": "English", "es": "Spanish", "de": "German", "fr": "French", "it": "Italian", "pt": "Portuguese",
    "tr": "Turkish", "uk": "Ukrainian", "kk": "Kazakh (Cyrillic script)", "uz": "Uzbek (Latin script)", "pl": "Polish",
    "ar": ("Arabic (Modern Standard Arabic, natural and simple, as in popular Arabic social media videos; Arabic script, "
           "no transliteration, no diacritics/tashkeel; use the Arabic comma ، and question mark ؟)"),
    "ce": ("Chechen (нохчийн мотт) in Cyrillic script, as Chechens write it; write the letter palochka as the Latin capital I "
           "(for example: дIа, хIун, кIант). Use real Chechen words, not Russian; keep names and brands as they are"),
    "ky": ("Kyrgyz (кыргыз тили) in Cyrillic script, as people in Kyrgyzstan write it, with the letters ң, ө, ү; "
           "use real Kyrgyz words, not Kazakh or Russian; keep names and brands as they are"),
}


def _strip_numbering(text: str) -> str:
    """Номер пункта, который модель иногда повторяет: «3. », «٣) », «۳- »."""
    text = re.sub(r"^\s*[0-9\u0660-\u0669\u06F0-\u06F9]+\s*[.)\-:،]\s+", "", text).strip()
    # Кавычки вокруг всей строки — тоже от модели, не от фразы.
    if len(text) >= 2 and text[0] in "\"«“" and text[-1] in "\"»”":
        text = text[1:-1].strip()
    return text


def _clean_translation(text: str, language: str) -> str:
    """Чеченский: палочка всегда латинской «I» — она есть в любом шрифте."""
    if language != "ce":
        return text
    text = text.replace("\u04C0", "I").replace("\u04CF", "I")
    # Цифра 1 вместо палочки внутри слова (кI1ант → кIант), но не в числах.
    return re.sub(r"(?<=[А-Яа-яЁё])1|1(?=[А-Яа-яЁё])", "I", text)


def _words_from_request(raw: Any) -> list[dict[str, Any]]:
    if not isinstance(raw, list) or not raw:
        raise AiError("Нет текста: сначала распознай речь или загрузи субтитры.")
    words = []
    for item in raw[:8000]:
        if not isinstance(item, dict):
            continue
        try:
            words.append({"w": int(item["w"]), "text": str(item.get("text") or "")[:60],
                          "start": float(item.get("start") or 0), "end": float(item.get("end") or 0)})
        except (KeyError, TypeError, ValueError):
            continue
    if not words:
        raise AiError("Нет текста: сначала распознай речь или загрузи субтитры.")
    return words


class EditorTools:
    """Задачи ИИ-монтажёра. Использует того же «режиссёра», что и картинки."""

    def __init__(self, service: "PicturesService"):
        self.service = service

    def smartcut(self, raw_words: Any) -> dict[str, Any]:
        words = _words_from_request(raw_words)
        by_index = {word["w"]: word for word in words}
        removals: list[dict[str, Any]] = []
        provider = "rules"
        note = ""
        for start in range(0, len(words), 700):
            chunk = words[start:start + 700]
            prompt = "Words:\n" + " | ".join(f"{word['w']} {word['text']}" for word in chunk)
            try:
                raw, provider = self.service._ask_json(SMARTCUT_SYSTEM, prompt, max_tokens=4000)
            except AiError as error:
                if error.code in ("ai_auth", "ai_limit"):
                    raise
                if error.code == "ai_budget" and removals:
                    # Лимит кончился посреди ролика: начало — от ИИ, остальное — по простому правилу.
                    rest = [word for word in words if word["w"] >= chunk[0]["w"]]
                    removals.extend(_rule_fillers(rest))
                    note = "ИИ-лимит закончился посреди ролика: конец почищен по простому правилу."
                    break
                return {"remove": _rule_fillers(words), "provider": "rules",
                        "note": "ИИ-монтажёр не ответил — лишние слова найдены по простому правилу."}
            for item in (raw.get("remove") if isinstance(raw, dict) else None) or []:
                try:
                    first, last = int(item.get("from")), int(item.get("to", item.get("from")))
                except (TypeError, ValueError, AttributeError):
                    continue
                if first not in by_index or last not in by_index or last < first or last - first > 12:
                    continue
                reason = str(item.get("reason") or "filler")
                removals.append({"from": first, "to": last, "reason": reason if reason in ("filler", "repeat", "false_start", "retake") else "filler"})
        removed = sum(item["to"] - item["from"] + 1 for item in removals)
        if removed > len(words) * 0.3:
            # Слишком смело — оставляем только короткие слова-паразиты.
            removals = [item for item in removals if item["reason"] in ("filler", "repeat")]
        result: dict[str, Any] = {"remove": removals, "provider": provider}
        if note:
            result["note"] = note
        return result

    def hook(self, text: str) -> dict[str, Any]:
        clean = re.sub(r"\s+", " ", str(text or "")).strip()
        if len(clean) < 10:
            raise AiError("Слишком мало текста, чтобы придумать хук.")
        raw, provider = self.service._ask_json(HOOK_SYSTEM, "Transcript:\n" + clean[:12000], max_tokens=1500)
        if not isinstance(raw, dict):
            raise AiError("ИИ ответил не по форме. Попробуй ещё раз.", 502, "ai_format")
        tags = [str(tag).strip().replace(" ", "") for tag in (raw.get("hashtags") or []) if str(tag).strip()]
        tags = [tag if tag.startswith("#") else f"#{tag}" for tag in tags][:10]
        return {
            "hook": str(raw.get("hook") or "").strip().strip('"«»')[:90],
            "title": str(raw.get("title") or "").strip()[:120],
            "description": str(raw.get("description") or "").strip()[:900],
            "hashtags": tags,
            "provider": provider,
        }

    def moments(self, raw_sentences: Any, min_seconds: float, max_seconds: float) -> dict[str, Any]:
        if not isinstance(raw_sentences, list) or len(raw_sentences) < 2:
            raise AiError("Видео слишком короткое для поиска лучших моментов.")
        sentences = []
        for item in raw_sentences[:1500]:
            try:
                sentences.append({"n": int(item["n"]), "start": float(item["start"]), "end": float(item["end"]),
                                  "text": str(item.get("text") or "")[:400]})
            except (KeyError, TypeError, ValueError):
                continue
        by_n = {s["n"]: s for s in sentences}
        system = MOMENTS_SYSTEM.replace("{min}", str(int(min_seconds))).replace("{max}", str(int(max_seconds)))
        prompt = "Sentences:\n" + "\n".join(f"{s['n']} [{s['start']:.1f}-{s['end']:.1f}] {s['text']}" for s in sentences)
        raw, provider = self.service._ask_json(system, prompt, max_tokens=3000)
        moments = []
        used: list[tuple[float, float]] = []
        for item in (raw.get("moments") if isinstance(raw, dict) else None) or []:
            try:
                first, last = by_n[int(item["from"])], by_n[int(item["to"])]
            except (KeyError, TypeError, ValueError):
                continue
            start, end = first["start"], last["end"]
            if end <= start or any(start < b and end > a for a, b in used):
                continue
            used.append((start, end))
            moments.append({"start": round(start, 2), "end": round(end, 2),
                            "title": str(item.get("title") or "").strip()[:80],
                            "why": str(item.get("why") or "").strip()[:240]})
        if not moments:
            raise AiError("ИИ не нашёл подходящих моментов. Попробуй другую длину.", 502, "ai_empty")
        return {"moments": moments[:5], "provider": provider}

    def translate(self, raw_lines: Any, language: str) -> dict[str, Any]:
        if language not in LANGUAGES:
            raise AiError("Этот язык пока не поддерживается.")
        if not isinstance(raw_lines, list) or not raw_lines:
            raise AiError("Нет текста для перевода.")
        if len(raw_lines) > 1500:
            raise AiError("Слишком много строк для перевода за раз (больше 1500). Переведи ролик частями.", 413, "too_long")
        lines = [re.sub(r"\s+", " ", str(line or "")).strip()[:300] for line in raw_lines]
        result: list[str] = []
        provider = ""
        for start in range(0, len(lines), 60):
            chunk = lines[start:start + 60]
            system = TRANSLATE_SYSTEM.replace("{language}", LANGUAGES[language]).replace("{count}", str(len(chunk)))
            prompt = "\n".join(f"{i + 1}. {line}" for i, line in enumerate(chunk))
            raw, provider = self.service._ask_json(system, prompt, max_tokens=6000)
            translated = raw.get("lines") if isinstance(raw, dict) else None
            if not isinstance(translated, list) or len(translated) != len(chunk):
                raise AiError("Переводчик сбился с количества строк. Попробуй ещё раз.", 502, "ai_format")
            result.extend(_clean_translation(_strip_numbering(str(line or "")), language) or chunk[i]
                          for i, line in enumerate(translated))
        return {"lines": result, "provider": provider}


FILLERS = {"э", "ээ", "эээ", "эм", "эмм", "мм", "ммм", "эх", "ам"}


def _rule_fillers(words: list[dict[str, Any]]) -> list[dict[str, Any]]:
    removals = []
    previous = None
    for word in words:
        clean = re.sub(r"[^\w-]+", "", word["text"].lower(), flags=re.UNICODE)
        if clean in FILLERS:
            removals.append({"from": word["w"], "to": word["w"], "reason": "filler"})
        elif previous is not None and clean and clean == previous["clean"] and word["start"] - previous["end"] < 0.6:
            removals.append({"from": previous["w"], "to": previous["w"], "reason": "repeat"})
        previous = {"w": word["w"], "clean": clean, "end": word["end"]}
    return removals
