#!/usr/bin/env bash
# Собирает настоящие контейнеры и проверяет оба режима: по IP и с HTTPS. Порты 80 и 443 должны быть свободны.
# Нужны Docker и curl. Запуск: bash test/compose.test.sh
set -u

deploy="$(cd "$(dirname "$0")/../deploy" && pwd)"
project=mafia-judge-test
work="$(mktemp -d)"
secret=test-secret
failed=0

mkdir "$work/deploy"
cp "$deploy/Dockerfile" "$deploy/compose.yaml" "$deploy/Caddyfile" "$work/deploy/"
cp "$deploy/../.dockerignore" "$deploy/../package.json" "$deploy/../package-lock.json" "$work/"
cp -r "$deploy/../src" "$work/"
cd "$work/deploy" || exit 1

had_node="$(docker images -q node:24-alpine)"
had_caddy="$(docker images -q caddy:2-alpine)"
compose() { docker compose -f "$work/deploy/compose.yaml" -p "$project" --profile https "$@"; }
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
  docker compose -p "$project" up -d --build --wait --remove-orphans || { echo 'FAIL контейнеры не запустились'; failed=1; }
}

create_game() {
  docker run --rm --network host node:24-alpine node -e '
const key = process.argv[1];
const json = {"content-type":"application/json"};
(async () => {
  const session = await fetch("http://localhost/api/session", {method:"POST", headers:json, body:JSON.stringify({key})});
  if (!session.ok) throw new Error("Не выполнен вход: " + session.status);
  const cookie = session.headers.get("set-cookie").split(";")[0];
  const create = async (route, payload) => {
    const response = await fetch("http://localhost/api" + route, {
      method:"POST", headers:{...json,cookie}, body:JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(route + ": " + response.status);
    return response.json();
  };
  const tournament = await create("/tournaments", {title:"Турнир Docker"});
  const path = "/tournaments/" + tournament.id;
  const read = route => fetch("http://localhost/api" + route, {headers:{cookie}}).then(response => response.json());
  const player = await create(path + "/participants", {nick:"Игрок 1"});
  await create(path + "/admin/stage", {name:"Игра Docker", rounds:1, players:10, coefficient:1, final:false, swiss:false});
  const {stages:[stage]} = await read(path + "/admin");
  await create(path + "/admin/create", {stageId:stage.id});
  const {games:[game]} = await read(path);
  await create(path + "/admin/place", {gameId:game.id, seating:[player.id,...Array(9).fill("")], overwrite:true});
  console.log(game.id);
})();
' "$secret"
}

websocket() {
  docker run --rm --network host -e NODE_TLS_REJECT_UNAUTHORIZED=0 node:24-alpine node --no-warnings -e '
const [base, secret, gameId] = process.argv.slice(1);
function open({role, ...credentials}) {
  const ws = new WebSocket(base + "/ws?role=" + role + "&game=" + gameId);
  ws.addEventListener("open", () => ws.send(JSON.stringify({kind:"auth", ...credentials})));
  return ws;
}
function waitMessage(ws, check) {
  return new Promise(resolve => ws.addEventListener("message", event => {
    const m = JSON.parse(event.data);
    if (check(m)) resolve(m);
  }));
}
const action = (ws, message) => ws.send(JSON.stringify(message));
const timeout = setTimeout(() => process.exit(1), 8000);
(async () => {
  const wrong = open({role:"host",key:"wrong"});
  const rejected = await new Promise(resolve => wrong.onclose = e => resolve(e.code));
  if (rejected !== 4401) process.exit(1);

  const host = open({role:"host",key:secret});
  const {S} = await waitMessage(host, m => m.kind === "game" && m.hello);
  const judge = open({role:"judge",room:S.judge.room});
  await waitMessage(judge, m => m.kind === "ready");
  action(judge,{kind:"hello"});
  const before = await waitMessage(judge, m => m.kind === "state");
  const screen = open({role:"screen",room:S.judge.hud});
  await waitMessage(screen, m => m.kind === "ready");
  action(screen,{kind:"hello"});
  await waitMessage(screen, m => m.kind === "view");

  const largePhoto = "data:image/jpeg;base64," + "A".repeat(250000);
  const gotPhoto = waitMessage(screen, m => m.kind === "photo" && m.data === largePhoto);
  action(host, {kind:"photo",pid:S.seats[0].pid,data:largePhoto});
  await gotPhoto;

  const afterFoul = waitMessage(screen, m => m.kind === "view" && m.view.seats[0].fouls !== before.seats[0].fouls);
  action(judge,{kind:"cmd",a:"foul",i:0,d:before.seats[0].fouls >= 4 ? -1 : 1});
  await afterFoul;
  clearTimeout(timeout);
  console.log("ok");
  process.exit(0);
})();
' "$1" "$secret" "$game_id" 2>/dev/null | tail -1
}
want=ok

# Меняет название игры через пульт на сервере или, без аргумента, читает его.
game_title() {
  docker run --rm --network host node:24-alpine node --no-warnings -e '
const [key, gameId, title] = process.argv.slice(1);
const ws=new WebSocket("ws://localhost/ws?role=host&game="+gameId);
ws.onopen=()=>ws.send(JSON.stringify({kind:"auth",key}));
ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.kind!=="game")return;
  if(title&&m.hello){ws.send(JSON.stringify({kind:"patch",client:require("node:crypto").randomBytes(16).toString("hex"),seq:1,revision:m.S.revision,ops:[[["title"],title,{value:m.S.title}]]}));return}
  console.log(m.S.title);process.exit(0)};
setTimeout(()=>{console.log("timeout");process.exit(1)},5000);
' "$secret" "$game_id" "$1" 2>/dev/null | tail -1
}

printf 'JUDGE_SECRET=%s\nJUDGE_PUBLISH=80\n' "$secret" > .env
start
game_id="$(create_game)" || exit 1
for page in / "/games/$game_id/hud" "/games/$game_id/judge" "/games/$game_id/win-civilians" "/games/$game_id/win-mafia"; do
  expect "по IP: страница $page" "$(status "http://localhost$page")" 200
done
expect 'по IP: файлы сервера закрыты' "$(status http://localhost/server.js)" 404
expect 'по IP: связь и пароль' "$(websocket ws://localhost)" "$want"
expect 'по IP: страница пульта' "$(status "http://localhost/games/$game_id/panel")" 200
expect 'игра сохраняется' "$(game_title Финал)" Финал
docker compose -p "$project" down || failed=1
start
expect 'игра переживает остановку и повторный запуск' "$(game_title '')" Финал

printf 'JUDGE_SECRET=%s\nDOMAIN=localhost\nCOMPOSE_PROFILES=https\n' "$secret" > .env
start
for try in {1..15}; do
  [ "$(status "https://localhost/games/$game_id/hud")" = 200 ] && break
  sleep 1
done
expect 'HTTPS: страница OBS' "$(status "https://localhost/games/$game_id/hud")" 200
expect 'HTTPS: http перенаправляется' "$(status "http://localhost/games/$game_id/hud")" 308
expect 'HTTPS: связь и пароль' "$(websocket wss://localhost)" "$want"

printf 'JUDGE_SECRET=%s\nJUDGE_PUBLISH=80\n' "$secret" > .env
compose rm -sf caddy >/dev/null 2>&1
start
expect 'возврат с домена на IP' "$(status "http://localhost/games/$game_id/hud")" 200

if [ "$failed" = 0 ]; then echo 'ALL PASSED'; else echo 'SOME FAILED'; fi
exit "$failed"
