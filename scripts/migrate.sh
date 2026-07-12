#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

python3 -m alembic upgrade head

echo "TraceLens database migration completed"
