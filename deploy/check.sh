#!/usr/bin/env bash
# Проверка сервера Reel Lab: службы, движки, ИИ, бот. Запуск: sudo bash /opt/reellab/app/deploy/check.sh
APP=/opt/reellab
echo "Служба reellab: $(systemctl is-active reellab)   Caddy: $(systemctl is-active caddy)"
sudo -u reellab bash -c "set -a; . '$APP/.env'; set +a; cd '$APP/app'; exec '$APP/venv/bin/python' deploy/selftest.py $*"
echo
echo "Последние строки журнала:"
journalctl -u reellab -n 12 --no-pager 2>/dev/null | tail -12
