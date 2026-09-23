#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/home/zuri/Desktop/TraceLens}"
APP_USER="${APP_USER:-zuri}"
APP_GROUP="${APP_GROUP:-zuri}"

for f in "$APP_DIR/start_web.sh" "$APP_DIR/start_worker.sh" "$APP_DIR/start_maintenance.sh"; do
  [[ -f "$f" ]] || { echo "[ERROR] 파일 없음: $f"; exit 1; }
  chmod +x "$f"
done

[[ -f "$APP_DIR/.env" ]] || { echo "[ERROR] .env 파일 없음"; exit 1; }
chmod 600 "$APP_DIR/.env"

sudo tee /etc/systemd/system/tracelens-web.service >/dev/null <<EOF
[Unit]
Description=TraceLens Web
After=network-online.target postgresql.service redis-server.service
Wants=network-online.target
Requires=postgresql.service redis-server.service

[Service]
Type=simple
User=$APP_USER
Group=$APP_GROUP
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
ExecStart=$APP_DIR/start_web.sh
Restart=always
RestartSec=5
TimeoutStopSec=30
KillSignal=SIGTERM

[Install]
WantedBy=multi-user.target
EOF

sudo tee /etc/systemd/system/tracelens-worker.service >/dev/null <<EOF
[Unit]
Description=TraceLens RQ Worker
After=network-online.target postgresql.service redis-server.service
Wants=network-online.target
Requires=postgresql.service redis-server.service

[Service]
Type=simple
User=$APP_USER
Group=$APP_GROUP
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
ExecStart=$APP_DIR/start_worker.sh
Restart=always
RestartSec=5
TimeoutStopSec=30
KillSignal=SIGTERM

[Install]
WantedBy=multi-user.target
EOF

sudo tee /etc/systemd/system/tracelens-maintenance.service >/dev/null <<EOF
[Unit]
Description=TraceLens Maintenance
After=network-online.target postgresql.service redis-server.service
Wants=network-online.target
Requires=postgresql.service redis-server.service

[Service]
Type=simple
User=$APP_USER
Group=$APP_GROUP
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
ExecStart=$APP_DIR/start_maintenance.sh
Restart=always
RestartSec=10
TimeoutStopSec=30
KillSignal=SIGTERM

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now postgresql redis-server
sudo systemctl enable --now tracelens-web tracelens-worker tracelens-maintenance

echo
echo "설치 완료"
echo "상태 확인:"
echo "  sudo systemctl status tracelens-web --no-pager"
echo "  sudo systemctl status tracelens-worker --no-pager"
echo "  sudo systemctl status tracelens-maintenance --no-pager"
echo
echo "실시간 로그:"
echo "  sudo journalctl -u tracelens-web -f"
