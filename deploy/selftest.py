"""Проверка сервера Reel Lab после установки или обновления.

    sudo bash /opt/reellab/app/deploy/check.sh            — всё, кроме платной картинки
    sudo bash /opt/reellab/app/deploy/check.sh --image    — ещё и одна картинка YandexART (≈2 ₽)

Печатает понятные ✔/✘ по каждому узлу: FFmpeg, Chrome, распознавание речи,
ИИ Яндекса, бот Telegram, HTTPS, оплата.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
DEMO = ROOT / "static" / "ready-captions" / "demo" / "demo.mp4"
results: list[bool] = []


def mark(ok: bool, text: str, hint: str = "") -> bool:
    results.append(ok)
    print(("\033[32m✔\033[0m " if ok else "\033[31m✘\033[0m ") + text + (f"\n    → {hint}" if hint and not ok else ""))
    return ok


def note(text: str, hint: str = "") -> None:
    """Необязательное не подключено — не ошибка (серая точка)."""
    print("\033[90m•\033[0m " + text + (f"\n    → {hint}" if hint else ""))


def section(title: str) -> None:
    print(f"\n\033[1m{title}\033[0m")


def run(command: list[str], timeout: int = 60) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, capture_output=True, text=True, timeout=timeout)


def main() -> None:
    want_image = "--image" in sys.argv
    section("Настройки")
    mark(os.environ.get("REELLAB_MODE") == "server", "Режим сервера (REELLAB_MODE=server)")
    public = os.environ.get("REELLAB_PUBLIC_URL", "")
    mark(public.startswith("https://"), f"Адрес: {public or 'не задан'}", "Свой домен — REELLAB_DOMAIN: впиши в settings.txt и снова запусти «УСТАНОВИТЬ НА СЕРВЕР.cmd»")
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
    mark(bool(token), "Токен бота задан", "TELEGRAM_BOT_TOKEN: впиши в settings.txt и снова запусти «УСТАНОВИТЬ НА СЕРВЕР.cmd»")
    owners = os.environ.get("REELLAB_OWNER_IDS", "")
    if owners.strip():
        mark(any(part.strip().isdigit() for part in owners.split(",")), f"Владелец бота: {owners}",
             "Нужен числовой Telegram ID (узнать у @userinfobot), не @ник — впиши в settings.txt и снова запусти «УСТАНОВИТЬ НА СЕРВЕР.cmd»")
    else:
        note("Владелец бота не указан — не будет уведомлений и команд /stats, /admin",
             "Свой Telegram ID (узнать у @userinfobot) — REELLAB_OWNER_IDS: впиши в settings.txt и снова запусти «УСТАНОВИТЬ НА СЕРВЕР.cmd»")

    section("Сервер")
    total, used, free = shutil.disk_usage(os.environ.get("REELLAB_DATA_DIR", "/"))
    mark(free > 10 * 1024 ** 3, f"Свободно на диске: {free / 1024 ** 3:.0f} ГБ из {total / 1024 ** 3:.0f}",
         "Мало места: увеличь диск сервера в панели хостинга")
    ffmpeg = shutil.which("ffmpeg")
    if mark(bool(ffmpeg), f"FFmpeg: {ffmpeg}", "Запусти «УСТАНОВИТЬ НА СЕРВЕР.cmd» ещё раз — установщик поставит FFmpeg"):
        filters = run([ffmpeg, "-hide_banner", "-filters"]).stdout
        mark(" zscale " in filters, "FFmpeg умеет HDR → SDR (zscale)", "Видео с iPhone в HDR будут блёклыми")
    browser = os.environ.get("REELLAB_BROWSER") or shutil.which("google-chrome-stable") or ""
    if mark(bool(browser) and Path(browser).is_file(), f"Браузер для сборки: {browser or 'не найден'}", "Запусти «УСТАНОВИТЬ НА СЕРВЕР.cmd» ещё раз — установщик поставит Chrome"):
        mark(True, run([browser, "--version"]).stdout.strip() or "версия не прочиталась")

    section("Распознавание речи")
    try:
        from gigaam_adapter import resolve_runtime, transcribe_video
        runtime = resolve_runtime()
        mark(True, f"GigaAM: {runtime.model.name}")
        sample = Path(sys.argv[sys.argv.index("--sample") + 1]) if "--sample" in sys.argv else DEMO
        with tempfile.TemporaryDirectory() as folder:
            started = time.time()
            result = transcribe_video(sample, folder, language="ru")
            text = " ".join(line for line in Path(result.srt_path).read_text(encoding="utf-8").splitlines()
                            if line and "-->" not in line and not line.isdigit())
            if result.cue_count > 0:
                mark(bool(result.vtt_path), f"Русский распознан за {time.time() - started:.1f} с: «{text[:80]}»",
                     "Нет времени слов — проверь версию CrispASR")
            elif sample == DEMO:
                # В примере синтезированный голос — GigaAM его иногда не слышит. Главное, что движок запустился.
                mark(True, f"Движок GigaAM запускается ({time.time() - started:.1f} с). Проверить на живой речи: "
                           "check.sh --sample /путь/к/видео.mp4")
            else:
                mark(False, "Речь в примере не распознана", "Проверь, что в видео есть русская речь")
    except Exception as error:  # noqa: BLE001
        mark(False, f"GigaAM не работает: {error}", "Запусти «УСТАНОВИТЬ НА СЕРВЕР.cmd» ещё раз — модель и программа докачаются")
    try:
        import speech_local
        if mark(speech_local.available(), "faster-whisper установлен", "Запусти «УСТАНОВИТЬ НА СЕРВЕР.cmd» ещё раз"):
            started = time.time()
            model = speech_local._load_model()
            segments, info = model.transcribe(str(DEMO), language="ru", word_timestamps=True, vad_filter=True)
            words = sum(len(segment.words or []) for segment in segments)
            mark(words > 3, f"Whisper ({os.environ.get('REELLAB_WHISPER_MODEL', 'large-v3-turbo')}) работает: "
                            f"{words} слов за {time.time() - started:.1f} с (с загрузкой модели)")
    except Exception as error:  # noqa: BLE001
        mark(False, f"Whisper не работает: {error}", "Запусти «УСТАНОВИТЬ НА СЕРВЕР.cmd» ещё раз: модель могла не скачаться")

    section("ИИ Яндекса")
    try:
        from ai_pictures import YandexAI, usage_scope
        ai = YandexAI.from_env()
        if ai is None:
            note("ИИ Яндекса не подключён — нет перевода, хука, ИИ-картинок и помощника (субтитры и монтаж работают)",
                 "YANDEX_API_KEY и YANDEX_FOLDER_ID (как получить — README.md): впиши в settings.txt и снова запусти «УСТАНОВИТЬ НА СЕРВЕР.cmd»")
        else:
            mark(True, "Ключ и каталог Яндекса заданы")
            for tier in ("best", "cheap"):
                with usage_scope(tier) as usage:
                    try:
                        reply = ai.chat("Отвечай одним словом.", "Скажи «готово».", tier=tier, max_tokens=300)
                        model = usage.text[-1][0] if usage.text else "?"
                        mark(True, f"Тексты ({'платные' if tier == 'best' else 'бесплатные'}): {model} → «{reply.strip()[:30]}»")
                    except Exception as error:  # noqa: BLE001
                        mark(False, f"Тексты ({tier}): {getattr(error, 'message', error)}",
                             "Проверь роль ai.languageModels.user у сервисного аккаунта")
            # Зрение — для ИИ-помощника (разбор чужого ролика по кадрам). Проверка стоит копейки.
            try:
                import subprocess
                frame = subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=96x96", "-frames:v", "1",
                                        "-f", "mjpeg", "-"], capture_output=True, timeout=30).stdout
                with usage_scope("cheap") as usage:
                    seen = ai.vision("Отвечай одним словом.", "Какого цвета картинка?", [frame], max_tokens=200)
                model = usage.text[-1][0] if usage.text else "?"
                mark(bool(seen.strip()), f"Зрение (ИИ-помощник): {model} → «{seen.strip()[:30]}»")
            except Exception as error:  # noqa: BLE001
                mark(False, f"Зрение (ИИ-помощник): {getattr(error, 'message', error)}",
                     "Без него помощник разбирает ролики по замерам, но не видит субтитры в кадре. Проверь YANDEX_VISION_MODELS")
            if want_image:
                try:
                    started = time.time()
                    data = ai.image("красный воздушный шар на белом фоне", 42)
                    mark(len(data) > 1000, f"Художник ({ai.image_model}) нарисовал картинку за {time.time() - started:.1f} с ({len(data) // 1024} КБ)")
                except Exception as error:  # noqa: BLE001
                    mark(False, f"Художник: {getattr(error, 'message', error)}", "Нужна роль ai.imageGeneration.user")
            else:
                print("    (картинку не рисую — добавь --image, это ≈2 ₽)")
    except Exception as error:  # noqa: BLE001
        mark(False, f"Модуль ИИ: {error}")

    section("Telegram")
    if token:
        base = os.environ.get("TELEGRAM_API_BASE", "https://api.telegram.org").rstrip("/")
        try:
            me = json.load(urllib.request.urlopen(f"{base}/bot{token}/getMe", timeout=20))
            mark(me.get("ok"), f"Бот: @{me['result']['username']}")
            info = json.load(urllib.request.urlopen(f"{base}/bot{token}/getWebhookInfo", timeout=20))["result"]
            url = info.get("url") or ""
            shown = url.split("/tg/")[0] + "/tg/…" if "/tg/" in url else url  # секретную часть адреса не печатаем
            mark(url.startswith(public + "/tg/") if public else bool(url), f"Вебхук: {shown or 'не установлен'}",
                 "Запусти «УСТАНОВИТЬ НА СЕРВЕР.cmd» ещё раз — бот заново подключится к Telegram")
            if info.get("last_error_message"):
                mark(False, f"Telegram жалуется: {info['last_error_message']}",
                     "Обычно это адрес сайта: свой домен должен указывать на IP сервера (A-запись); можно оставить REELLAB_DOMAIN пустым")
            if info.get("pending_update_count"):
                print(f"    в очереди обновлений: {info['pending_update_count']}")
        except Exception as error:  # noqa: BLE001
            mark(False, f"Telegram не отвечает: {error}", "Проверь токен бота (TELEGRAM_BOT_TOKEN): впиши в settings.txt и снова запусти «УСТАНОВИТЬ НА СЕРВЕР.cmd»")

    section("HTTPS и сайт")
    if public.startswith("https://"):
        try:
            health = json.load(urllib.request.urlopen(f"{public}/api/health", timeout=20))
            mark(health.get("mode") == "server", f"{public} открывается, сервис отвечает (сборка {health.get('build')})")
            page = urllib.request.urlopen(f"{public}/legal/offer", timeout=20).read().decode("utf-8", "replace")
            mark("{{" not in page, "Оферта и политика открываются", "")
            if "владелец сервиса Reel Lab" not in page:
                mark(True, "В оферте указаны данные владельца")
            else:
                note("В оферте нет данных владельца — их нужно заполнить до приёма оплаты",
                     "REELLAB_OWNER_NAME, REELLAB_OWNER_INN, REELLAB_CONTACT_EMAIL: впиши в settings.txt и снова запусти «УСТАНОВИТЬ НА СЕРВЕР.cmd»")
        except Exception as error:  # noqa: BLE001
            mark(False, f"{public} не открывается: {error}",
                 "Проверь, что домен указывает на IP сервера (A-запись) и порты 80/443 открыты; Caddy получает сертификат 1–2 минуты")

    section("Оплата")
    stars = bool(token)
    mark(stars, "Звёзды Telegram — работают без настройки")
    card = all(os.environ.get(name) for name in ("ROBOKASSA_LOGIN", "ROBOKASSA_PASSWORD1", "ROBOKASSA_PASSWORD2"))
    if card:
        try:
            from billing import Robokassa
            mark(Robokassa.from_env() is not None, "Robokassa подключена (карта и СБП)",
                 "ROBOKASSA_HASH должен быть md5, sha256 или sha512 — как в «Технических настройках» магазина")
        except Exception as error:  # noqa: BLE001
            mark(False, f"Robokassa: {error}")
        print(f"    Тестовый режим: {'да (деньги не списываются)' if os.environ.get('ROBOKASSA_TEST', '').strip() in ('1', 'true', 'yes') else 'нет — настоящие платежи'}")
    else:
        note("Robokassa не подключена — в боте только оплата звёздами (карту можно подключить позже)")
    print("    Адреса для магазина Robokassa («Технические настройки»):")
    print(f"      Result URL:  {public}/api/billing/robokassa/result   (метод POST)")
    print(f"      Success URL: {public}/pay/success   (метод GET)")
    print(f"      Fail URL:    {public}/pay/fail   (метод GET)")

    bad = results.count(False)
    print(f"\nИтог: {'всё в порядке' if not bad else f'проблем: {bad} (строки с ✘ выше)'}")


if __name__ == "__main__":
    main()
