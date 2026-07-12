#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/Desktop/TraceLens}"
COMMIT_MSG="${1:-Add Linux deployment service files}"

cd "$APP_DIR"

mkdir -p deploy/systemd deploy/apache

for service in tracelens-web.service tracelens-worker.service tracelens-maintenance.service; do
  src="/etc/systemd/system/$service"
  if [[ -f "$src" ]]; then
    sudo cp "$src" "deploy/systemd/$service"
    sudo chown "$USER":"$USER" "deploy/systemd/$service"
  else
    echo "[WARN] 찾을 수 없음: $src"
  fi
done

for conf in tracelens.kr.conf tracelens.kr-le-ssl.conf; do
  src="/etc/apache2/sites-available/$conf"
  if [[ -f "$src" ]]; then
    sudo cp "$src" "deploy/apache/$conf"
    sudo chown "$USER":"$USER" "deploy/apache/$conf"
  fi
done

# 비밀정보는 GitHub에 올리지 않음
grep -qxF ".env" .gitignore || echo ".env" >> .gitignore
grep -qxF ".venv/" .gitignore || echo ".venv/" >> .gitignore
grep -qxF "__pycache__/" .gitignore || echo "__pycache__/" >> .gitignore
grep -qxF ".pytest_cache/" .gitignore || echo ".pytest_cache/" >> .gitignore
grep -qxF "archives/" .gitignore || echo "archives/" >> .gitignore
grep -qxF "backups/" .gitignore || echo "backups/" >> .gitignore

if git ls-files --error-unmatch .env >/dev/null 2>&1; then
  git rm --cached .env
fi

git add \
  .gitignore \
  gunicorn.conf.py \
  start_web.sh \
  start_worker.sh \
  start_maintenance.sh \
  start_backup.sh \
  start_monitor.sh \
  deploy/systemd \
  deploy/apache

if git diff --cached --quiet; then
  echo "올릴 변경사항이 없습니다."
  exit 0
fi

git status --short
git commit -m "$COMMIT_MSG"
git push origin main

echo "GitHub 업로드 완료"
