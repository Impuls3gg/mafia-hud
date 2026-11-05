#!/usr/bin/env bash
# Проверяет server-setup.sh на подменённых командах и ненастоящей файловой системе. Сервер не нужен.
# Запуск: bash judge/test/setup.test.sh
set -u

judge="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
fake="$tmp/root"
app="$tmp/repo/judge"
env_file="$app/.env"
service="$fake/etc/systemd/system/mafia-judge.service"
failed=0

mkdir -p "$tmp/bin" "$fake/etc/systemd/system" "$app"
cp "$judge/update.sh" "$app/"

stub() { printf '#!/bin/sh\necho "%s $*" >> "%s/calls.log"\n%s\n' "$1" "$tmp" "${2:-}" > "$tmp/bin/$1"; }
stub apt-get
stub git
stub systemctl
stub docker 'if [ "$1 $2" = "compose version" ]; then exit ${COMPOSE_EXIT:-0}; fi'
printf '#!/bin/sh\necho 0\n' > "$tmp/bin/id"
printf '#!/bin/sh\nexit 0\n' > "$tmp/bin/sleep"
printf '#!/bin/sh\nexit ${CURL_EXIT:-0}\n' > "$tmp/bin/curl"
chmod +x "$tmp"/bin/*
sed -e "s|/etc/|$fake/etc/|g" "$judge/server-setup.sh" > "$app/server-setup.sh"

run() { : > "$tmp/calls.log"; PATH="$tmp/bin:$PATH" bash "$app/server-setup.sh" "$@" > "$tmp/out.log" 2>&1; }
update() { : > "$tmp/calls.log"; PATH="$tmp/bin:$PATH" bash "$app/update.sh" "$@" > "$tmp/out.log" 2>&1; }
pass() { echo "ok   $1"; }
fail() { echo "FAIL $1"; failed=1; }
expect() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1: ожидалось [$3], получено [$2]"; fi; }
has() { if grep -q -- "$3" "$2"; then pass "$1"; else fail "$1: нет [$3] в $(basename "$2")"; fi; }
hasnt() { if grep -q -- "$3" "$2"; then fail "$1: есть [$3] в $(basename "$2")"; else pass "$1"; fi; }
secret() { sed -n 's/^JUDGE_SECRET=//p' "$env_file"; }

run 'bad domain;rm'; expect 'неверный адрес отклонён' "$?" 1
run; expect 'адрес обязателен' "$?" 1

run 203.0.113.5; expect 'установка по IP' "$?" 0
has 'по IP сервер на порту 80' "$env_file" '^JUDGE_PUBLISH=80$'
hasnt 'по IP нет Caddy' "$env_file" 'COMPOSE_PROFILES'
has 'адрес показан с http' "$tmp/out.log" 'http://203.0.113.5'
has 'старый Caddy убирается' "$tmp/calls.log" 'docker compose --profile https rm -sf caddy'
has 'контейнеры запускаются' "$tmp/calls.log" 'docker compose up -d --build --remove-orphans'
hasnt 'Docker уже есть' "$tmp/calls.log" 'apt-get'
first="$(secret)"
expect 'пароль из 32 символов' "${#first}" 32
has 'пароль показан' "$tmp/out.log" "$first"

run judge.example.com; expect 'установка с доменом' "$?" 0
has 'включён HTTPS' "$env_file" '^COMPOSE_PROFILES=https$'
has 'домен записан' "$env_file" '^DOMAIN=judge.example.com$'
hasnt 'с доменом порт 80 у Caddy' "$env_file" 'JUDGE_PUBLISH'
expect 'пароль не меняется при обновлении' "$(secret)" "$first"

run; expect 'адрес запоминается' "$?" 0
has 'повторный запуск берёт сохранённый адрес' "$tmp/out.log" 'https://judge.example.com'

FALLBACK_ADDRESS=198.51.100.7 run; expect 'запасной адрес не заменяет сохранённый' "$?" 0
has 'сохранённый адрес важнее запасного' "$env_file" '^ADDRESS=judge.example.com$'

update; expect 'обновление' "$?" 0
has 'обновление скачивает код' "$tmp/calls.log" "git -C $app pull --ff-only"
has 'обновление пересобирает контейнеры' "$tmp/calls.log" 'docker compose up -d --build'
expect 'пароль не меняется при обновлении кода' "$(secret)" "$first"
has 'обновление сохраняет домен' "$env_file" '^DOMAIN=judge.example.com$'

update other.example.com
has 'обновление меняет адрес по запросу' "$env_file" '^DOMAIN=other.example.com$'
run judge.example.com

mv "$env_file" "$tmp/env.bak"
FALLBACK_ADDRESS=198.51.100.7 run; expect 'первая установка берёт запасной адрес' "$?" 0
has 'запасной адрес записан' "$env_file" '^ADDRESS=198.51.100.7$'
mv "$tmp/env.bak" "$env_file"

COMPOSE_EXIT=1 run judge.example.com
has 'ставит Docker, если его нет' "$tmp/calls.log" 'apt-get install -y -qq docker.io docker-compose-v2'

touch "$service"
run judge.example.com
has 'отключает установку без Docker' "$tmp/calls.log" 'systemctl disable --now mafia-judge caddy'
if [ -e "$service" ]; then fail 'файл службы удалён'; else pass 'файл службы удалён'; fi

CURL_EXIT=7 run judge.example.com; expect 'недоступный адрес считается ошибкой' "$?" 1
has 'подсказка при ошибке' "$tmp/out.log" 'порты 80 и 443'

if [ "$failed" = 0 ]; then echo 'ALL PASSED'; else echo 'SOME FAILED'; fi
exit "$failed"
