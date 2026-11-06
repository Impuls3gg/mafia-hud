#!/usr/bin/env bash
# Собирает настоящие контейнеры и проверяет оба режима: по IP и с HTTPS. Порты 80 и 443 должны быть свободны.
# Нужны Docker и curl. Запуск: bash judge/test/compose.test.sh
set -u

judge="$(cd "$(dirname "$0")/.." && pwd)"
project=mafia-judge-test
work="$(mktemp -d)"
secret=test-secret
failed=0

mkdir "$work/judge"
cp "$judge/server.js" "$judge/game.js" "$judge/judge.html" "$judge/Dockerfile" "$judge/compose.yaml" "$judge/Caddyfile" "$work/judge/"
cp "$judge/../mafia-hud.html" "$judge/../win-civilians.html" "$judge/../win-mafia.html" "$judge/../.dockerignore" "$work/"
cd "$work/judge" || exit 1

had_node="$(docker images -q node:24-alpine)"
had_caddy="$(docker images -q caddy:2-alpine)"
compose() { docker compose -p "$project" --profile https "$@"; }
cleanup() {
  cd /
  compose down -v --rmi local >/dev/null 2>&1
  [ -n "$had_node" ] || docker rmi -f node:24-alpine >/dev/null 2>&1
  [ -n "$had_caddy" ] || docker rmi -f caddy:2-alpine >/dev/null 2>&1
  rm -rf "$work"
}
trap cleanup EXIT

expect() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: ожидалось [$3], получено [$2]"; failed=1; fi; }
status() { curl -sk -o /dev/null -w '%{http_code}' --max-time 10 "$1"; }
start() {
  docker compose -p "$project" up -d --build --remove-orphans >/dev/null 2>&1 || { echo 'FAIL контейнеры не запустились'; failed=1; }
  sleep 4
}

websocket() {
  docker run --rm --network host -e NODE_TLS_REJECT_UNAUTHORIZED=0 node:24-alpine node --no-warnings -e "
const base='$1',room='e'.repeat(32),url=(role,key)=>base+'/ws?room='+room+'&role='+role+(key?'&key='+key:'');
const result=ws=>new Promise(done=>{ws.onclose=e=>done(e.code);ws.onopen=()=>setTimeout(()=>done('open'),400)});
(async()=>{
  const out=[await result(new WebSocket(url('panel','nope'))),await result(new WebSocket(url('judge')))];
  const panel=new WebSocket(url('panel','$secret'));out.push(await result(panel));
  const judge=new WebSocket(url('judge'));out.push(await result(judge));
  const screen=new WebSocket(url('screen'));out.push(await result(screen));
  out.push(await new Promise(done=>{screen.onmessage=e=>{if(e.data.length>200000)done('big')};panel.send('x'.repeat(250000));setTimeout(()=>done('no big'),5000)}));
  out.push(await new Promise(done=>{panel.onmessage=e=>{if(e.data==='cmd')done('cmd')};judge.send('cmd');setTimeout(()=>done('no cmd'),5000)}));
  console.log(out.join(' '));process.exit(0);
})();
" 2>/dev/null | tail -1
}
want='4401 4403 open open open big cmd'

# Меняет название игры через пульт на сервере или, без аргумента, читает его.
game_title() {
  docker run --rm --network host node:24-alpine node --no-warnings -e "
const ws=new WebSocket('ws://localhost/ws?role=host&key=$secret');
ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.kind!=='game')return;
  if('$1'&&m.hello){ws.send(JSON.stringify({kind:'patch',seq:1,ops:[[['title'],'$1']]}));return}
  console.log(m.S.title);process.exit(0)};
setTimeout(()=>{console.log('timeout');process.exit(1)},5000);
" 2>/dev/null | tail -1
}

printf 'JUDGE_SECRET=%s\nJUDGE_PUBLISH=80\n' "$secret" > .env
start
for page in / /hud /win-civilians /win-mafia; do expect "по IP: страница $page" "$(status "http://localhost$page")" 200; done
expect 'по IP: файлы сервера закрыты' "$(status http://localhost/server.js)" 404
expect 'по IP: связь и пароль' "$(websocket ws://localhost)" "$want"
expect 'по IP: страница пульта' "$(status http://localhost/panel)" 200
expect 'игра сохраняется' "$(game_title Финал)" Финал
docker compose -p "$project" up -d --force-recreate >/dev/null 2>&1
sleep 4
expect 'игра переживает пересоздание контейнера' "$(game_title '')" Финал

printf 'JUDGE_SECRET=%s\nDOMAIN=localhost\nCOMPOSE_PROFILES=https\n' "$secret" > .env
start
expect 'HTTPS: страница /hud' "$(status https://localhost/hud)" 200
expect 'HTTPS: http перенаправляется' "$(status http://localhost/hud)" 308
expect 'HTTPS: связь и пароль' "$(websocket wss://localhost)" "$want"

printf 'JUDGE_SECRET=%s\nJUDGE_PUBLISH=80\n' "$secret" > .env
compose rm -sf caddy >/dev/null 2>&1
start
expect 'возврат с домена на IP' "$(status http://localhost/hud)" 200

if [ "$failed" = 0 ]; then echo 'ALL PASSED'; else echo 'SOME FAILED'; fi
exit "$failed"
