#!/usr/bin/env bash
# Проходит путь сервера целиком: git clone, установка, новый коммит, обновление. Docker настоящий.
# Порт 80 должен быть свободен. Нужны Docker, git и curl. Запуск: bash judge/test/update.test.sh
set -u

source_repo="$(cd "$(dirname "$0")/../.." && pwd)"
tmp="$(mktemp -d)"
origin="$tmp/origin"
server="$tmp/server"
export COMPOSE_PROJECT_NAME=mafia-judge-update-test
failed=0

had_node="$(docker images -q node:24-alpine)"
cleanup() {
  (cd "$server/judge" 2>/dev/null && docker compose --profile https down -v --rmi local >/dev/null 2>&1)
  [ -n "$had_node" ] || docker rmi -f node:24-alpine >/dev/null 2>&1
  rm -rf "$tmp"
}
trap cleanup EXIT

expect() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: ожидалось [$3], получено [$2]"; failed=1; fi; }
page() { curl -s --noproxy '*' --max-time 10 http://127.0.0.1/; }
secret() { sed -n 's/^JUDGE_SECRET=//p' "$server/judge/.env"; }

# Запуск от обычного пользователя: скрипт проверяет root, остальное настоящее.
mkdir "$tmp/bin"
printf '#!/bin/sh\necho 0\n' > "$tmp/bin/id"
chmod +x "$tmp/bin/id"
export PATH="$tmp/bin:$PATH"

# Текущая рабочая копия становится временным «GitHub».
mkdir "$origin"
(cd "$source_repo" && git -c safe.directory='*' ls-files -co --exclude-standard -z | tar --null -T - -cf - | tar -xf - -C "$origin")
git -C "$origin" init -q -b main
git -C "$origin" add -A
git -C "$origin" -c user.name=test -c user.email=test@example.com commit -q -m first

git clone -q "$origin" "$server"
bash "$server/judge/server-setup.sh" 127.0.0.1 > "$tmp/install.log" 2>&1
expect 'установка из клона' "$?" 0
expect 'страница открывается' "$(page | grep -c 'Мафия · судья')" 1
password="$(secret)"
expect 'пароль создан' "${#password}" 32

sed -i 's/<title>Мафия · судья<\/title>/<title>Новая версия<\/title>/' "$origin/judge/judge.html"
git -C "$origin" -c user.name=test -c user.email=test@example.com commit -q -am second

bash "$server/judge/update.sh" > "$tmp/update.log" 2>&1
expect 'обновление' "$?" 0
expect 'открывается новая версия' "$(page | grep -c 'Новая версия')" 1
expect 'пароль сохранён' "$(secret)" "$password"
expect 'адрес сохранён' "$(sed -n 's/^ADDRESS=//p' "$server/judge/.env")" 127.0.0.1
expect 'рабочая копия чистая' "$(git -C "$server" status --porcelain)" ''

sed -i 's/<title>Новая версия<\/title>/<title>Третья<\/title>/' "$server/judge/judge.html"
sed -i 's/<title>Новая версия<\/title>/<title>Другая<\/title>/' "$origin/judge/judge.html"
git -C "$origin" -c user.name=test -c user.email=test@example.com commit -q -am third
bash "$server/judge/update.sh" > "$tmp/conflict.log" 2>&1
if [ "$?" -ne 0 ]; then echo 'ok   правки на сервере останавливают обновление'; else echo 'FAIL правки на сервере не остановили обновление'; failed=1; fi
expect 'старая версия продолжает работать' "$(page | grep -c 'Новая версия')" 1

if [ "$failed" = 0 ]; then echo 'ALL PASSED'; else cat "$tmp/install.log" "$tmp/update.log" | tail -15; echo 'SOME FAILED'; fi
exit "$failed"
