#!/usr/bin/env bash
# Устанавливает сервер судьи и худ в Docker на Ubuntu. Запускается из папки репозитория.
# Адрес запоминается, поэтому при повторном запуске его можно не указывать.
set -euo pipefail

app="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$app"

address="${1:-}"
[[ -n "$address" ]] || address="$(sed -n 's/^ADDRESS=//p' .env 2>/dev/null || true)"
[[ -n "$address" ]] || address="${FALLBACK_ADDRESS:-}"
if [[ ! "$address" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]]; then
  echo "Укажите домен или IP сервера, например: bash server-setup.sh judge.example.com" >&2
  exit 1
fi
if [[ "$(id -u)" -ne 0 ]]; then
  echo "Запустите скрипт от имени root." >&2
  exit 1
fi

packages=()
docker compose version >/dev/null 2>&1 || packages+=(docker.io docker-compose-v2)
command -v curl >/dev/null || packages+=(curl)
if (( ${#packages[@]} )); then
  echo "Устанавливаю ${packages[*]}..."
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq "${packages[@]}" >/dev/null
  systemctl enable --now docker
fi

# Прошлая версия работала без Docker и занимала порты 80 и 443.
if [[ -f /etc/systemd/system/mafia-judge.service ]]; then
  echo "Отключаю прошлую установку без Docker..."
  systemctl disable --now mafia-judge caddy
  rm /etc/systemd/system/mafia-judge.service
  systemctl daemon-reload
fi

echo "Запускаю контейнеры..."
# Пароль сервера создаётся один раз и не меняется при обновлениях.
secret="$(sed -n 's/^JUDGE_SECRET=//p' .env 2>/dev/null || true)"
[[ -n "$secret" ]] || secret="$(od -An -tx1 -N16 /dev/urandom | tr -d ' \n')"

if [[ "$address" =~ ^[0-9.]+$ ]]; then
  # Для голого IP нет сертификата: сервер судьи отвечает на порту 80 без HTTPS.
  url="http://$address"
  printf 'ADDRESS=%s\nJUDGE_SECRET=%s\nJUDGE_PUBLISH=80\n' "$address" "$secret" > .env
  # Caddy мог остаться от установки с доменом и занимать порт 80.
  docker compose --profile https rm -sf caddy
else
  url="https://$address"
  printf 'ADDRESS=%s\nJUDGE_SECRET=%s\nDOMAIN=%s\nCOMPOSE_PROFILES=https\n' "$address" "$secret" "$address" > .env
fi
chmod 600 .env
docker compose up -d --build --remove-orphans

echo "Пароль сервера для пульта: $secret"
echo "Проверяю адрес $url ..."
for _ in {1..30}; do
  if curl -fsS --noproxy '*' -o /dev/null --max-time 5 "$url/" 2>/dev/null; then
    echo "Готово. Откройте пульт $url/panel и войдите с паролем сервера."
    exit 0
  fi
  sleep 2
done

echo "Контейнеры запущены, но адрес $url пока не открывается." >&2
echo "Проверьте, что адрес указывает на этот сервер и что у хостинга открыты порты 80 и 443." >&2
echo "Журнал: docker compose -f $app/compose.yaml logs" >&2
exit 1
