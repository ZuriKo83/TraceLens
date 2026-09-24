# Linux 직접 실행 (Docker 없음)

이 구성은 Ubuntu/Debian 계열 Linux에서 웹, RQ 작업자, 유지보수 작업, 브라우저 수집기를 systemd 서비스로 실행합니다. PostgreSQL과 Redis는 서버에 설치합니다. 사용자는 웹 브라우저만 필요합니다.

## 준비

- Python 3.11 이상, Node.js 22 이상, PostgreSQL, Redis를 서버에 설치합니다.
- `/opt/tracelens`에 저장소를 배치하고 `tracelens` 시스템 사용자에게 소유권을 줍니다. 사용자의 홈 디렉터리는 `/var/lib/tracelens`처럼 영속 경로로 설정합니다.
- PostgreSQL에 `tracelens` 데이터베이스와 전용 계정을 만듭니다. `DATABASE_URL`의 암호와 일치시킵니다.

```bash
sudo useradd --system --create-home --home-dir /var/lib/tracelens --shell /usr/sbin/nologin tracelens
sudo chown -R tracelens:tracelens /opt/tracelens
sudo -u tracelens python3 -m venv /opt/tracelens/.venv
sudo -u tracelens /opt/tracelens/.venv/bin/pip install -r /opt/tracelens/requirements.txt
sudo -u tracelens bash -c 'cd /opt/tracelens/local_collector && npm ci'
sudo bash -c 'cd /opt/tracelens/local_collector && npx playwright install-deps chromium firefox'
sudo -H -u tracelens bash -c 'cd /opt/tracelens/local_collector && npx playwright install chromium firefox'
```

`/etc/tracelens/tracelens.env`를 만들고 권한을 `root:tracelens`, `0640`으로 설정합니다. `.env.example`을 출발점으로 사용하되 다음 값은 실제 서버에 맞춰 설정하세요.

```dotenv
DATABASE_URL=postgresql+psycopg://tracelens:CHANGE_ME@127.0.0.1:5432/tracelens
REDIS_URL=redis://127.0.0.1:6379/0
SESSION_SECRET=CHANGE_ME_TO_LONG_RANDOM_VALUE
PUBLIC_BASE_URL=http://127.0.0.1:8021
BROWSER_COLLECTOR_URL=http://127.0.0.1:3080
BROWSER_PROFILE_DIR=/var/lib/tracelens-browser
TRACELENS_SERVER_URL=http://127.0.0.1:8021
TRACELENS_COLLECTOR_HOST=127.0.0.1
TRACELENS_COLLECTOR_PORT=3080
TRACELENS_BROWSER=chromium
```

다른 `.env.example`의 설정도 필요에 따라 옮깁니다. `TRACELENS_SERVER_URL`은 수집기에서 웹으로 접속하는 내부 주소이고, `BROWSER_COLLECTOR_URL`은 웹에서 수집기로 접속하는 내부 주소입니다. 두 포트 모두 로컬 인터페이스에만 바인딩합니다. `BROWSER_PROFILE_DIR`은 웹과 수집기가 동일하게 사용하며 사이트 로그인 쿠키를 보관합니다.

```bash
sudo cp /opt/tracelens/systemd/tracelens-*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now tracelens-web tracelens-worker tracelens-maintenance tracelens-collector
sudo systemctl status tracelens-web tracelens-collector
curl --fail http://127.0.0.1:8021/health
curl --fail http://127.0.0.1:3080/health
```

웹 서비스가 시작되기 전에 Alembic 마이그레이션이 실행됩니다. 로그에서 마이그레이션 오류가 없는지 확인하세요.

서비스 파일은 `/opt/tracelens`, `/etc/tracelens/tracelens.env`, `/usr/bin/node`를 기준으로 작성했습니다. 다른 경로를 사용하면 서비스 파일을 함께 수정합니다. 웹은 기본적으로 `127.0.0.1:8021`에 바인딩됩니다. 외부 사용자는 HTTPS 역방향 프록시를 준비한 후 접근시켜야 합니다. 현재 화면에 표시되는 인증번호는 이메일 소유를 검증하지 않으므로 그 상태로 공개 운영하면 안 됩니다. 공개 전 이메일 인증과 HTTPS 쿠키 설정을 복원해야 합니다.

로그는 `journalctl -u tracelens-web -u tracelens-collector -f`로 확인합니다. 기존 Docker 볼륨의 데이터는 자동으로 옮겨지지 않습니다. DB와 브라우저 프로필을 옮기려면 별도 백업·이전 절차가 필요합니다.
