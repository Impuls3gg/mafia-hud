#!/usr/bin/env bash
# Скачивает новую версию из GitHub и пересобирает сервер. Настройки и пароль сохраняются.
# bash judge/update.sh                   обновить
# bash judge/update.sh judge.example.com обновить и сменить адрес
set -euo pipefail

app="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
git -C "$app" pull --ff-only
exec bash "$app/server-setup.sh" "$@"
