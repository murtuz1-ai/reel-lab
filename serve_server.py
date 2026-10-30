"""Запуск Reel Lab на сервере: бот, мини-приложение и API за веб-сервером Caddy.

Caddy принимает HTTPS (сертификат Let's Encrypt получает сам) и передаёт
запросы сюда, на 127.0.0.1:REELLAB_PORT. Один процесс, много потоков:
очереди сборки и распознавания живут в памяти этого процесса.

Запускается службой systemd (см. deploy/install-server.sh), вручную:
    /opt/reellab/venv/bin/python serve_server.py
"""
from __future__ import annotations

import logging
import os
from pathlib import Path

try:
    from dotenv import load_dotenv
except ImportError:  # на сервере пакет ставится из requirements-server.txt
    load_dotenv = None

ROOT = Path(__file__).resolve().parent
if load_dotenv is not None:
    load_dotenv(os.environ.get("REELLAB_ENV_FILE") or ROOT / ".env")
os.environ.setdefault("REELLAB_MODE", "server")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logging.getLogger("waitress.queue").setLevel(logging.ERROR)

from waitress import serve  # noqa: E402

import app as reellab  # noqa: E402

if __name__ == "__main__":
    port = int(os.environ.get("REELLAB_PORT", "8765"))
    threads = int(os.environ.get("REELLAB_HTTP_THREADS", "48"))
    logging.getLogger("reellab").info("Reel Lab (сервер) слушает 127.0.0.1:%s, потоков: %s", port, threads)
    serve(
        reellab.app, host="127.0.0.1", port=port, threads=threads,
        channel_timeout=900, connection_limit=1000, cleanup_interval=30,
        max_request_body_size=reellab.MAX_BYTES + 16 * 1024 * 1024,
        url_scheme="https", trusted_proxy="127.0.0.1", trusted_proxy_count=1,
        trusted_proxy_headers={"x-forwarded-for", "x-forwarded-proto", "x-forwarded-host"},
        clear_untrusted_proxy_headers=True, ident="ReelLab",
    )
