#!/usr/bin/env bash
# Установка/обновление квиз-кнопки на чистой Ubuntu (22.04 / 24.04). Запускать от root:
#   curl -fsSL https://raw.githubusercontent.com/nikolay-savchenko/web_quiz_button/main/deploy/install.sh | bash
# или с параметрами:
#   DOMAIN=quiz.example.ru HOST_KEY=секрет bash install.sh
#
# Что делает: ставит git, Node.js 20, Caddy (автоматический HTTPS), клонирует репо в /opt/web_quiz_button,
# создаёт systemd-сервис quiz и конфиг Caddy. Повторный запуск = обновление до свежего main.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/nikolay-savchenko/web_quiz_button.git}"
BRANCH="${BRANCH:-main}"
APP_DIR="${APP_DIR:-/opt/web_quiz_button}"
APP_PORT="${APP_PORT:-3000}"

[ "$(id -u)" = 0 ] || { echo "Запусти от root (sudo -i)"; exit 1; }
export DEBIAN_FRONTEND=noninteractive

echo "==> Пакеты"
apt-get update -qq
apt-get install -y -qq git curl ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https openssl >/dev/null

# Node.js >= 18
NODE_MAJOR=$(node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/' || echo 0)
if [ "${NODE_MAJOR:-0}" -lt 18 ]; then
  echo "==> Node.js 20 (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
echo "    node $(node -v)"

# Caddy
if ! command -v caddy >/dev/null; then
  echo "==> Caddy"
  if ! apt-get install -y -qq caddy >/dev/null 2>&1; then
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq && apt-get install -y -qq caddy >/dev/null
  fi
fi

echo "==> Код"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch -q origin "$BRANCH" && git -C "$APP_DIR" reset -q --hard "origin/$BRANCH"
else
  git clone -q -b "$BRANCH" "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"
npm ci --omit=dev --no-fund --no-audit --loglevel=error

# .env: создаём один раз, дальше не трогаем (кроме явно переданных DOMAIN/HOST_KEY)
ENV_FILE="$APP_DIR/.env"
touch "$ENV_FILE"
getenv() { grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- || true; }
setenv() { grep -vE "^$1=" "$ENV_FILE" > "$ENV_FILE.tmp" || true; echo "$1=$2" >> "$ENV_FILE.tmp"; mv "$ENV_FILE.tmp" "$ENV_FILE"; }

if [ -n "${DOMAIN:-}" ]; then setenv DOMAIN "$DOMAIN"; fi
if [ -z "$(getenv DOMAIN)" ]; then
  IP=$(curl -fsS4 --max-time 5 https://ifconfig.me 2>/dev/null || curl -fsS4 --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
  # sslip.io: домен вида 1-2-3-4.sslip.io указывает на IP 1.2.3.4 — можно получить HTTPS без своего домена
  setenv DOMAIN "$(echo "$IP" | tr . -).sslip.io"
fi
if [ -n "${HOST_KEY:-}" ]; then setenv HOST_KEY "$HOST_KEY"; fi
[ -n "$(getenv HOST_KEY)" ] || setenv HOST_KEY "$(openssl rand -hex 4)"
setenv PORT "$APP_PORT"
DOMAIN=$(getenv DOMAIN)
HOST_KEY=$(getenv HOST_KEY)
setenv PUBLIC_URL "https://$DOMAIN/"
chmod 600 "$ENV_FILE"

echo "==> systemd-сервис quiz"
cat > /etc/systemd/system/quiz.service <<EOF
[Unit]
Description=Quiz buzzer
After=network.target

[Service]
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$(command -v node) server.js
Restart=always
RestartSec=2
User=root

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable -q quiz
systemctl restart quiz

echo "==> Caddy ($DOMAIN)"
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:$APP_PORT
}
EOF
systemctl enable -q caddy
systemctl restart caddy

if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
fi

sleep 2
if curl -fsS --max-time 3 "http://127.0.0.1:$APP_PORT/health" >/dev/null; then echo "    приложение отвечает"; else echo "    !!! приложение не отвечает: journalctl -u quiz -n 50"; fi

cat <<EOF

Готово.
  Игроки:   https://$DOMAIN/
  Ведущий:  https://$DOMAIN/host?key=$HOST_KEY

Сертификат Caddy получает сам в первые секунды (нужны открытые порты 80 и 443).
Логи:      journalctl -u quiz -f      |  journalctl -u caddy -f
Обновить:  bash $APP_DIR/deploy/install.sh
EOF
