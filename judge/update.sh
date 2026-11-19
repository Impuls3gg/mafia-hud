#!/usr/bin/env bash
# Совместимость со старыми установками и командами обновления.
exec bash "$(dirname "${BASH_SOURCE[0]}")/../deploy/update.sh" "$@"
