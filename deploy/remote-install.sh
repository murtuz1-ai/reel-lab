#!/usr/bin/env bash
# Запуск установки с компьютера («УСТАНОВИТЬ НА СЕРВЕР.cmd»): установщик работает на сервере сам по себе,
# а это окно только показывает его журнал. Если связь оборвётся или окно закроют — установка продолжится;
# повторный запуск .cmd подхватит идущую установку и покажет её журнал до конца.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$(cd "$HERE/.." && pwd)"
OUT=/root/reellab-install.out
STATUS=/root/reellab-install.status
LOCK=/run/reellab-install.lock

follow() {  # follow PID — показывать журнал, пока установка не закончится; вернуть её код
  local pid=$1
  tail -n +1 --pid="$pid" -f "$OUT" 2>/dev/null
  sleep 1
  [[ -s "$STATUS" ]] && exit "$(cat "$STATUS")"
  echo "Установка ещё идёт или прервалась — запусти «ПРОВЕРИТЬ СЕРВЕР.cmd» через несколько минут."
  exit 1
}

# Уже идёт установка (запущена раньше, а окно закрыли) — просто показываем её журнал.
if [[ -f "$LOCK" ]] && running=$(cat "$LOCK" 2>/dev/null) && [[ -n "$running" ]] && kill -0 "$running" 2>/dev/null; then
  echo "Установка уже идёт — показываю её ход."
  follow "$running"
fi

# Скрипты могли приехать с окончаниями строк Windows — bash такие не понимает.
sed -i 's/\r$//' "$SRC"/deploy/*.sh 2>/dev/null || true
# Прежние распакованные версии больше не нужны (оставляем две последние).
ls -1dt /root/reellab-2* 2>/dev/null | tail -n +3 | xargs -r rm -rf

rm -f "$STATUS"
: > "$OUT"
nohup setsid bash -c "echo \$\$ > '$LOCK'; bash '$SRC/deploy/install-server.sh'; code=\$?; echo \$code > '$STATUS'; rm -f '$LOCK'; exit \$code" \
  >> "$OUT" 2>&1 < /dev/null &
sleep 1
pid=$(cat "$LOCK" 2>/dev/null || echo $!)
follow "$pid"
