#!/usr/bin/env bash
# Устанавливает или обновляет сервер судьи в Docker на Ubuntu. Запускается из deploy.bat.
set -euo pipefail

address="${1:-}"
if [[ ! "$address" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]]; then
  echo "Укажите домен или IP сервера, например: bash server-setup.sh judge.example.com" >&2
  exit 1
fi
if [[ "$(id -u)" -ne 0 ]]; then
  echo "Запустите скрипт от имени root." >&2
  exit 1
fi

app=/opt/mafia-judge
chmod 755 "$app"
chmod 644 "$app"/*
cd "$app"

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
  printf 'JUDGE_SECRET=%s\nJUDGE_PUBLISH=80\n' "$secret" > .env
  # Caddy мог остаться от установки с доменом и занимать порт 80.
  docker compose --profile https rm -sf caddy
else
  url="https://$address"
  printf 'JUDGE_SECRET=%s\nDOMAIN=%s\nCOMPOSE_PROFILES=https\n' "$secret" "$address" > .env
fi
chmod 600 .env
docker compose up -d --build --remove-orphans

echo "Пароль сервера для пульта: $secret"
echo "Проверяю адрес $url ..."
for _ in {1..30}; do
  if curl -fsS -o /dev/null --max-time 5 "$url/" 2>/dev/null; then
    echo "Готово. Вставьте в пульт адрес $url и пароль сервера."
    exit 0
  fi
  sleep 2
done

echo "Контейнеры запущены, но адрес $url пока не открывается." >&2
echo "Проверьте, что адрес указывает на этот сервер и что у хостинга открыты порты 80 и 443." >&2
echo "Журнал: docker compose -f $app/compose.yaml logs" >&2
exit 1
