# Native 실행 구성

Docker를 사용하지 않습니다.

## Windows
1. PostgreSQL과 Redis 호환 서버를 각각 설치하고 서비스로 실행합니다.
2. PostgreSQL에 `tracelens` 데이터베이스와 전용 사용자를 생성합니다.
3. `.env`에 로컬 주소를 설정합니다.

```env
DATABASE_URL=postgresql+psycopg://tracelens:비밀번호@127.0.0.1:5432/tracelens
REDIS_URL=redis://127.0.0.1:6379/0
SCAN_ARCHIVE_DIR=./archives
```

4. `START_HERE.bat`를 실행하면 Web, Worker, Maintenance가 각각 별도 창으로 실행됩니다.

개별 실행은 `START_WORKER.bat`, `START_MAINTENANCE.bat`를 사용합니다.

## Linux 이식
Python 가상환경을 만든 뒤 다음 세 프로세스를 systemd 등으로 각각 관리합니다.

```bash
./start_web.sh
./start_worker.sh
./start_maintenance.sh
```

PostgreSQL과 Redis는 OS 서비스로 설치해 자동 시작하도록 설정합니다. 운영 환경에서는 Uvicorn의 `--reload`를 사용하지 않습니다.
