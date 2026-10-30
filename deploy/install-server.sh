#!/usr/bin/env bash
# Reel Lab — установка сервера одной командой (Ubuntu 22.04/24.04, под root).
#
#   sudo bash deploy/install-server.sh
#
# Что делает: ставит FFmpeg, Google Chrome (сборка роликов), Caddy (HTTPS),
# Python-окружение, распознавание речи (GigaAM для русского, Whisper для
# остальных языков), записывает настройки, запускает службу reellab,
# подключает вебхук бота и проверяет, что всё работает.
# Повторный запуск безопасен: обновит программу; настройки возьмёт из settings.txt (если он есть), остальное не тронет.
set -Eeuo pipefail

APP=/opt/reellab
DATA=/srv/reellab
ENV_FILE=$APP/.env
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG=/var/log/reellab-install.log
GIGAAM_FILE=gigaam-v3-e2e-ctc-q8_0.gguf
GIGAAM_URLS=(
  "https://huggingface.co/cstr/gigaam-v3-GGUF/resolve/main/$GIGAAM_FILE"
  "https://hf-mirror.com/cstr/gigaam-v3-GGUF/resolve/main/$GIGAAM_FILE"
)
# Проверенная версия CrispASR. В новых выпусках сборки для Linux появляются не сразу
# (в v0.8.46 их нет вовсе), поэтому сначала берём эту, а «последнюю» — только запасным вариантом.
CRISP_VERSION=v0.8.45
CRISP_URLS=(
  "https://github.com/CrispStrobe/CrispASR/releases/download/$CRISP_VERSION"
  "https://github.com/CrispStrobe/CrispASR/releases/latest/download"
)

say()  { printf '\n\033[1;33m▶ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✔ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;31m! %s\033[0m\n' "$*"; }
trap 'warn "Ошибка в строке $LINENO. Подробности: $LOG"; exit 1' ERR
exec > >(tee -a "$LOG") 2>&1

[[ $EUID -eq 0 ]] || { warn "Запусти через sudo: sudo bash deploy/install-server.sh"; exit 1; }
[[ -f "$SRC/app.py" ]] || { warn "Не найден app.py рядом со скриптом ($SRC)."; exit 1; }
. /etc/os-release
[[ "${ID:-}" == "ubuntu" ]] || warn "Скрипт проверен на Ubuntu 24.04 — на ${PRETTY_NAME:-этой системе} могут быть отличия."
CPUS=$(nproc)
MEM_GB=$(( $(awk '/MemTotal/ {print $2}' /proc/meminfo) / 1024 / 1024 ))
ok "Сервер: ${PRETTY_NAME:-Linux}, процессоров: $CPUS, памяти: ${MEM_GB} ГБ"

# --- 1. Настройки ---------------------------------------------------------------
# Файл настроек с компьютера: settings.txt из папки программы («УСТАНОВИТЬ НА СЕРВЕР.cmd» кладёт его
# в /root/reellab-settings.txt). Всё, что в нём заполнено, подставляется без вопросов — и при первой
# установке, и при обновлении: так позже включают оплату картой или ИИ (вписать в settings.txt и
# запустить установку ещё раз). Без файла установщик спрашивает сам.
SETTINGS=""
for candidate in /root/reellab-settings.txt "$SRC/settings.txt"; do
  if [[ -s "$candidate" ]]; then SETTINGS="$candidate"; break; fi
done
setting() {  # setting KEY → значение из файла настроек (пустая строка, если нет)
  [[ -n "$SETTINGS" ]] || return 0
  sed -e '1s/^\xEF\xBB\xBF//' -e 's/\r$//' "$SETTINGS" | awk -v key="$1" '
    BEGIN { q = sprintf("%c", 39); val = "" }
    /^[[:space:]]*#/ { next }
    { i = index($0, "="); if (i == 0) next
      k = substr($0, 1, i - 1); gsub(/[[:space:]]/, "", k)
      if (k != key) next
      v = substr($0, i + 1); sub(/^[[:space:]]+/, "", v); sub(/[[:space:]]+$/, "", v)
      f = substr(v, 1, 1); l = substr(v, length(v), 1)
      if (length(v) >= 2 && ((f == "\"" && l == "\"") || (f == q && l == q))) v = substr(v, 2, length(v) - 2)
      val = v }
    END { printf "%s", val }'
}
set_env() {  # set_env KEY VALUE — заменить строку KEY=… в .env или дописать её
  local key=$1 value=$2 tmp
  if [[ "$value" == *"'"* ]]; then
    warn "В значении $key есть апостроф ' — такое значение не записываю. Убери апостроф в settings.txt и запусти установку ещё раз."
    return 0
  fi
  tmp=$(mktemp)
  KEY="$key" VAL="'$value'" awk 'BEGIN { k = ENVIRON["KEY"]; v = ENVIRON["VAL"]; done = 0 }
    { if (index($0, k "=") == 1) { if (!done) print k "=" v; done = 1; next } print }
    END { if (!done) print k "=" v }' "$ENV_FILE" > "$tmp"
  cat "$tmp" > "$ENV_FILE"
  rm -f "$tmp"
}
env_value() {  # env_value KEY → текущее значение в .env
  ( trap - ERR; set +e; set -a; . "$ENV_FILE" >/dev/null 2>&1; printf '%s' "${!1:-}" )
}
load_env() {  # переменные из .env — в окружение установщика; кривая строка (правили вручную) не роняет установку
  trap - ERR; set +e
  set -a; . "$ENV_FILE" >/dev/null 2>&1; set +a
  set -e; trap 'warn "Ошибка в строке $LINENO. Подробности: $LOG"; exit 1' ERR
}
# Поля, которые человек задаёт сам (в settings.txt или ответами на вопросы).
USER_KEYS=(TELEGRAM_BOT_TOKEN REELLAB_OWNER_IDS YANDEX_API_KEY YANDEX_FOLDER_ID
  ROBOKASSA_LOGIN ROBOKASSA_PASSWORD1 ROBOKASSA_PASSWORD2 ROBOKASSA_HASH ROBOKASSA_TEST
  REELLAB_OWNER_NAME REELLAB_OWNER_INN REELLAB_OWNER_NPD REELLAB_CONTACT_EMAIL REELLAB_SUPPORT)
ask() { # ask VAR "Вопрос" [по умолчанию]
  local var=$1 text=$2 def=${3:-} value
  if [[ -n "${!var:-}" ]]; then return; fi
  read -r -p "$text${def:+ [$def]}: " value </dev/tty || true
  printf -v "$var" '%s' "${value:-$def}"
}
valid_token() { [[ "$1" =~ ^[0-9]+:[A-Za-z0-9_-]{30,}$ ]]; }
clean_domain() { local d=${1#https://}; d=${d#http://}; printf '%s' "${d%%/*}"; }
IP=$(curl -fsS4 --max-time 8 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
[[ -z "$SETTINGS" ]] || ok "Настройки из файла: $SETTINGS"

if [[ -f "$ENV_FILE" ]]; then
  ok "Настройки уже есть ($ENV_FILE) — оставляю их."
else
  say "Настройки (Enter — пропустить необязательное)"
  DOMAIN=$(clean_domain "$(setting REELLAB_DOMAIN)")
  BOT_TOKEN=$(setting TELEGRAM_BOT_TOKEN)
  if [[ -z "$SETTINGS" ]]; then
    ask DOMAIN "Домен бота (например reellab.ru). Нет домена — Enter, возьму ${IP//./-}.sslip.io" ""
  fi
  [[ -n "$DOMAIN" ]] || DOMAIN="${IP//./-}.sslip.io"
  ask BOT_TOKEN "Токен бота от @BotFather (обязательно)" ""
  valid_token "$BOT_TOKEN" || { warn "Токен бота выглядит неверно: он вида 1234567890:AAH… (из @BotFather). Исправь settings.txt и запусти установку ещё раз."; exit 1; }
  declare -A VALUE=([TELEGRAM_BOT_TOKEN]="$BOT_TOKEN")
  if [[ -n "$SETTINGS" ]]; then
    for key in "${USER_KEYS[@]}"; do [[ $key == TELEGRAM_BOT_TOKEN ]] || VALUE[$key]=$(setting "$key"); done
  else
    ask OWNER_ID "Твой Telegram ID (узнать: @userinfobot), можно несколько через запятую" ""
    ask YANDEX_KEY "API-ключ Яндекса (ИИ: перевод, хук, картинки) — можно позже" ""
    ask YANDEX_FOLDER "ID каталога Яндекс Облака" ""
    ask OWNER_NAME "ФИО владельца для оферты (можно позже)" ""
    ask OWNER_INN "ИНН (можно позже)" ""
    ask CONTACT_EMAIL "Почта для связи (для оферты)" ""
    VALUE[REELLAB_OWNER_IDS]=$OWNER_ID; VALUE[YANDEX_API_KEY]=$YANDEX_KEY; VALUE[YANDEX_FOLDER_ID]=$YANDEX_FOLDER
    VALUE[REELLAB_OWNER_NAME]=$OWNER_NAME; VALUE[REELLAB_OWNER_INN]=$OWNER_INN; VALUE[REELLAB_CONTACT_EMAIL]=$CONTACT_EMAIL
  fi
  SECRET=$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 40)
  mkdir -p "$APP"
  cat > "$ENV_FILE" <<ENVFILE
# Reel Lab — настройки сервера. Удобнее менять через settings.txt на компьютере и «УСТАНОВИТЬ НА СЕРВЕР.cmd».
# Если правишь здесь: значения с пробелами — в кавычках; потом sudo systemctl restart reellab
# (или впиши новое в settings.txt на компьютере и запусти «УСТАНОВИТЬ НА СЕРВЕР.cmd» ещё раз).
REELLAB_MODE=server
REELLAB_PUBLIC_URL=https://$DOMAIN
REELLAB_DOMAIN=$DOMAIN
REELLAB_PORT=8765
REELLAB_DATA_DIR=$DATA/data
REELLAB_SECRET=$SECRET
TELEGRAM_BOT_TOKEN=
REELLAB_OWNER_IDS=

# Нагрузка: одновременно сборок и распознаваний (на 8 ядрах — по 2)
REELLAB_RENDER_SLOTS=$(( CPUS >= 8 ? 2 : 1 ))
REELLAB_ASR_SLOTS=$(( CPUS >= 8 ? 2 : 1 ))
REELLAB_ASR_THREADS=$(( CPUS >= 8 ? 4 : 2 ))
REELLAB_WHISPER_THREADS=$(( CPUS >= 8 ? 4 : 2 ))
REELLAB_MAX_UPLOAD_BYTES=1073741824
REELLAB_UPLOAD_KEEP_HOURS=48
REELLAB_RESULT_KEEP_HOURS=72

# Распознавание речи
REELLAB_CRISPASR_BIN=$APP/crispasr/crispasr
REELLAB_GIGAAM_MODEL=$DATA/models/$GIGAAM_FILE
REELLAB_WHISPER_MODEL=large-v3-turbo
REELLAB_WHISPER_DIR=$DATA/models/whisper
REELLAB_BROWSER=/usr/bin/google-chrome-stable

# ИИ: Яндекс AI Studio (перевод, ИИ-монтаж, картинки YandexART)
YANDEX_API_KEY=
YANDEX_FOLDER_ID=

# Оплата картой и СБП через Robokassa (после регистрации самозанятым).
# Пока пусто — в боте только оплата звёздами.
ROBOKASSA_LOGIN=
ROBOKASSA_PASSWORD1=
ROBOKASSA_PASSWORD2=
ROBOKASSA_HASH=md5
ROBOKASSA_TEST=0
REELLAB_CARD_PAYMENTS=1

# Данные для оферты и сайта
REELLAB_OWNER_NAME=
REELLAB_OWNER_INN=
REELLAB_OWNER_NPD=0
REELLAB_CONTACT_EMAIL=
REELLAB_SUPPORT=
ENVFILE
  chmod 600 "$ENV_FILE"
  for key in "${!VALUE[@]}"; do
    if [[ -n "${VALUE[$key]}" ]]; then set_env "$key" "${VALUE[$key]}"; fi
  done
  ok "Настройки записаны в $ENV_FILE"
fi
# Обновление: всё, что заполнено в settings.txt, переносится в .env (токен, ИИ, Robokassa, данные оферты, домен).
if [[ -n "$SETTINGS" && -f "$ENV_FILE" ]]; then
  changed=0
  for key in "${USER_KEYS[@]}"; do
    value=$(setting "$key")
    [[ -n "$value" ]] || continue
    if [[ $key == TELEGRAM_BOT_TOKEN ]] && ! valid_token "$value"; then
      warn "Токен бота в settings.txt выглядит неверно — оставляю прежний."
      continue
    fi
    if [[ "$(env_value "$key")" != "$value" ]]; then set_env "$key" "$value"; changed=$((changed + 1)); fi
  done
  domain=$(clean_domain "$(setting REELLAB_DOMAIN)")
  # Домен стёрли (не заработал) — возвращаемся к адресу, который работает сразу.
  [[ -n "$domain" ]] || domain="${IP//./-}.sslip.io"
  if [[ "$(env_value REELLAB_DOMAIN)" != "$domain" ]]; then
    set_env REELLAB_DOMAIN "$domain"
    set_env REELLAB_PUBLIC_URL "https://$domain"
    changed=$((changed + 1))
  fi
  chmod 600 "$ENV_FILE"
  if (( changed > 0 )); then ok "Из settings.txt обновлено настроек: $changed"; fi
  # Пароли из файла уже в $ENV_FILE (его читают только root и служба) — копию с компьютера стираем.
  if [[ "$SETTINGS" == /root/reellab-settings.txt ]]; then rm -f "$SETTINGS"; fi
fi
load_env
DOMAIN=${REELLAB_DOMAIN:-${REELLAB_PUBLIC_URL#https://}}

# --- 2. Пакеты ------------------------------------------------------------------
say "Ставлю системные пакеты (FFmpeg, Python, шрифты)"
export DEBIAN_FRONTEND=noninteractive
APT_WAIT=(-o DPkg::Lock::Timeout=900)
# Прошлую установку прервали посреди apt — доделываем, иначе apt откажется работать.
dpkg --configure -a >/dev/null 2>&1 || true
apt-get "${APT_WAIT[@]}" update -qq
apt-get "${APT_WAIT[@]}" install -y -qq ffmpeg python3 python3-venv python3-pip curl wget rsync ca-certificates gnupg sqlite3 \
  fonts-noto-color-emoji fonts-dejavu-core libgomp1 ufw debian-keyring debian-archive-keyring apt-transport-https \
  >/dev/null
ffmpeg -hide_banner -filters 2>/dev/null | grep -q zscale && ok "FFmpeg с zscale (HDR → SDR)" || warn "В FFmpeg нет zscale: HDR-видео с iPhone будут блёклыми"

say "Ставлю Google Chrome (сборка роликов без экрана)"
if ! command -v google-chrome-stable >/dev/null; then
  if wget -q -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb; then
    apt-get "${APT_WAIT[@]}" install -y -qq /tmp/chrome.deb >/dev/null && rm -f /tmp/chrome.deb
  fi
fi
if command -v google-chrome-stable >/dev/null; then
  ok "$(google-chrome-stable --version)"
else
  warn "Google Chrome не скачался — поставлю Chromium через Playwright"
  python3 -m venv /opt/reellab/pwvenv && /opt/reellab/pwvenv/bin/pip -q install playwright
  PLAYWRIGHT_BROWSERS_PATH=/opt/reellab/pw-browsers /opt/reellab/pwvenv/bin/playwright install --with-deps chromium
  chmod -R a+rX /opt/reellab/pw-browsers
  CHROME=$(find /opt/reellab/pw-browsers -type f -name chrome -path '*chrome-linux*' | head -1)
  sed -i "s#^REELLAB_BROWSER=.*#REELLAB_BROWSER=$CHROME#" "$ENV_FILE"
  ok "Chromium: $CHROME"
fi

say "Ставлю Caddy (HTTPS с автоматическим сертификатом)"
if ! command -v caddy >/dev/null; then
  if curl -1sLf --max-time 60 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
       | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg \
     && curl -1sLf --max-time 60 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
       > /etc/apt/sources.list.d/caddy-stable.list; then
    apt-get "${APT_WAIT[@]}" update -qq || true
  else
    warn "Репозиторий Caddy недоступен — ставлю Caddy из репозитория Ubuntu"
    rm -f /etc/apt/sources.list.d/caddy-stable.list
  fi
  apt-get "${APT_WAIT[@]}" install -y -qq caddy >/dev/null
fi
command -v caddy >/dev/null || { warn "Caddy не установился — без него не будет HTTPS."; exit 1; }
ok "$(caddy version | head -1)"

# --- 3. Программа ---------------------------------------------------------------
say "Копирую Reel Lab в $APP/app"
id reellab >/dev/null 2>&1 || useradd --system --home "$DATA" --shell /usr/sbin/nologin reellab
mkdir -p "$APP/app" "$DATA/data" "$DATA/models/whisper" "$DATA/backups"
if command -v rsync >/dev/null; then
  rsync -a --delete --exclude /data --exclude /.env --exclude '__pycache__' --exclude /static/test-media "$SRC/" "$APP/app/"
else
  cp -a "$SRC/." "$APP/app/"
fi
ln -sf "$ENV_FILE" "$APP/app/.env"
chown -R reellab:reellab "$DATA" "$APP/app"
chmod -R u=rwX,go=rX "$APP/app"
# Скрипты проверки запускает root — они принадлежат root, служба их менять не может.
chown -R root:root "$APP/app/deploy"
chown root:reellab "$ENV_FILE" && chmod 640 "$ENV_FILE"

say "Python-окружение и библиотеки"
[[ -x $APP/venv/bin/python ]] || python3 -m venv "$APP/venv"
"$APP/venv/bin/pip" install -q --upgrade pip
"$APP/venv/bin/pip" install -q -r "$APP/app/requirements-server.txt"
ok "Python: $("$APP/venv/bin/python" --version)"

# --- 4. Распознавание речи ---------------------------------------------------------
say "Русская речь: CrispASR + GigaAM v3"
if [[ ! -x "$APP/crispasr/crispasr" ]]; then
  ARCHIVE=crispasr-linux-x86_64.tar.gz
  grep -qw avx2 /proc/cpuinfo || ARCHIVE=crispasr-linux-x86_64-cpu-legacy.tar.gz
  rm -rf /tmp/crisp; mkdir -p /tmp/crisp "$APP/crispasr"
  GOT=""
  for base in "${CRISP_URLS[@]}"; do
    # Скачанное проверяем: на месте файла GitHub может отдать страницу «Not Found».
    if wget -q --tries=3 --timeout=60 -O /tmp/crisp/crisp.tgz "$base/$ARCHIVE" && tar -tzf /tmp/crisp/crisp.tgz >/dev/null 2>&1; then
      GOT="$base/$ARCHIVE"; break
    fi
  done
  [[ -n "$GOT" ]] || { warn "CrispASR не скачался с GitHub. Проверь интернет на сервере и запусти установку ещё раз."; exit 1; }
  tar -xzf /tmp/crisp/crisp.tgz -C /tmp/crisp
  BIN=$(find /tmp/crisp -type f -name crispasr | head -1)
  [[ -n "$BIN" ]] || { warn "В архиве CrispASR не нашёлся файл crispasr"; exit 1; }
  cp -a "$(dirname "$BIN")/." "$APP/crispasr/"
  chmod +x "$APP/crispasr/crispasr"
  rm -rf /tmp/crisp
fi
chown -R root:root "$APP/crispasr"
ok "CrispASR: $APP/crispasr/crispasr"
if [[ ! -s "$DATA/models/$GIGAAM_FILE" ]]; then
  # Модель, привезённую с компьютера (ЗАЛИТЬ НА СЕРВЕР.cmd кладёт её рядом с архивом), берём первой.
  for local in "$SRC/../$GIGAAM_FILE" "/root/$GIGAAM_FILE"; do
    if [[ -s "$local" ]]; then cp "$local" "$DATA/models/$GIGAAM_FILE"; ok "Модель GigaAM взята с компьютера"; break; fi
  done
fi
if [[ ! -s "$DATA/models/$GIGAAM_FILE" ]]; then
  for url in "${GIGAAM_URLS[@]}"; do
    if wget -q --show-progress -O "$DATA/models/$GIGAAM_FILE.part" "$url"; then
      mv "$DATA/models/$GIGAAM_FILE.part" "$DATA/models/$GIGAAM_FILE"; break
    fi
  done
fi
if [[ -s "$DATA/models/$GIGAAM_FILE" ]]; then ok "Модель GigaAM: $(du -h "$DATA/models/$GIGAAM_FILE" | cut -f1)"
else warn "Модель GigaAM не скачалась (нет связи с huggingface). Запусти установку ещё раз — модель докачается."; fi

say "Остальные языки: Whisper large-v3-turbo (скачиваю модель ~1,6 ГБ, один раз)"
sudo -u reellab env HF_HUB_DISABLE_TELEMETRY=1 HOME="$DATA" REELLAB_WHISPER_MODEL="${REELLAB_WHISPER_MODEL:-large-v3-turbo}" \
  REELLAB_WHISPER_DIR="${REELLAB_WHISPER_DIR:-$DATA/models/whisper}" "$APP/venv/bin/python" - <<'PY' || warn "Модель Whisper не скачалась — повтори установку позже"
import os
from faster_whisper import WhisperModel
WhisperModel(os.environ.get("REELLAB_WHISPER_MODEL", "large-v3-turbo"), device="cpu", compute_type="int8",
             download_root=os.environ.get("REELLAB_WHISPER_DIR"))
print("ok")
PY
chown -R reellab:reellab "$DATA"

# --- 5. Служба и HTTPS --------------------------------------------------------------
say "Служба reellab (запуск при старте сервера, перезапуск при сбое)"
cat > /etc/systemd/system/reellab.service <<EOF
[Unit]
Description=Reel Lab — бот и студия субтитров
After=network-online.target
Wants=network-online.target

[Service]
User=reellab
Group=reellab
WorkingDirectory=$APP/app
EnvironmentFile=$ENV_FILE
Environment=PYTHONUNBUFFERED=1
ExecStart=$APP/venv/bin/python $APP/app/serve_server.py
Restart=always
RestartSec=3
LimitNOFILE=65536
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable reellab >/dev/null 2>&1
systemctl restart reellab

say "Caddy: https://$DOMAIN"
mkdir -p /etc/caddy
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	encode zstd gzip
	request_body {
		max_size 1100MB
	}
	# Студию (/ready-captions) телефон сверяет с сервером при каждом открытии — так отдаёт сама
	# программа, ответ 304 мгновенный, и после обновления все сразу получают новую версию.
	# Звуки и оформление сайта меняются редко — их держим сутки.
	@longcache path /sounds/sfx/* /sounds/keys/* /site/*
	header @longcache {
		Cache-Control "public, max-age=86400"
		defer
	}
	reverse_proxy 127.0.0.1:${REELLAB_PORT:-8765} {
		transport http {
			read_timeout 15m
			write_timeout 15m
		}
	}
}
EOF
systemctl enable caddy >/dev/null 2>&1
systemctl reload caddy 2>/dev/null || systemctl restart caddy

say "Файрвол: открыты SSH, 80 и 443"
ufw allow OpenSSH >/dev/null
# SSH мог быть на нестандартном порту — откроем и его, чтобы не потерять доступ.
for port in $(ss -tlnp 2>/dev/null | awk '/sshd/ {n=split($4,a,":"); print a[n]}' | sort -u); do ufw allow "$port/tcp" >/dev/null; done
ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

say "Ночная резервная копия базы"
cat > /etc/cron.daily/reellab-backup <<EOF
#!/bin/sh
sqlite3 $DATA/data/reellab.sqlite3 ".backup '$DATA/backups/reellab-\$(date +%F).sqlite3'"
find $DATA/backups -name 'reellab-*.sqlite3' -mtime +14 -delete
EOF
chmod +x /etc/cron.daily/reellab-backup

# --- 6. Проверка ---------------------------------------------------------------------
say "Проверяю, что всё работает"
for i in $(seq 1 30); do curl -fsS "http://127.0.0.1:${REELLAB_PORT:-8765}/api/health" >/dev/null 2>&1 && break; sleep 1; done
bash "$APP/app/deploy/check.sh" || true

cat <<EOF

────────────────────────────────────────────────────────────
  Reel Lab установлен.
  Сайт и студия:  https://$DOMAIN
  Бот:            открой бота в Telegram и нажми /start
  Настройки:      впиши в settings.txt на компьютере и снова запусти «УСТАНОВИТЬ НА СЕРВЕР.cmd»
  Проверка:       «ПРОВЕРИТЬ СЕРВЕР.cmd» (или на сервере: sudo bash $APP/app/deploy/check.sh)
  Журнал:         sudo journalctl -u reellab -f
────────────────────────────────────────────────────────────
EOF
