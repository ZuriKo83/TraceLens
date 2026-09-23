#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
exec .venv/bin/gunicorn -c gunicorn.conf.py app.main:app
