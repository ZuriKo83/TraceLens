# TraceLens 운영 구성

## Redis 세션
로그인 세션 본문은 Redis에 저장되고 브라우저 쿠키에는 서명된 세션 ID만 저장됩니다. Redis를 재시작하면 기존 로그인 세션이 만료될 수 있으므로 운영 환경에서는 Redis 영속화(AOF)를 켜십시오.

## DB 백업
- Windows: `START_BACKUP.bat`
- Linux: `./start_backup.sh`
- PostgreSQL은 `pg_dump`가 PATH에 있어야 합니다.
- 기본 보관 기간은 14일이며 `.env`의 `BACKUP_RETENTION_DAYS`로 변경합니다.
- Linux에서는 cron, Windows에서는 작업 스케줄러로 하루 1회 실행하십시오.

## 실패 재시도
수집 작업은 실패 시 10초, 60초, 300초 간격으로 최대 3회 자동 재시도합니다. 세 번 모두 실패한 작업은 RQ failed registry에 남습니다.

## Nginx
`nginx/tracelens.conf`를 `/etc/nginx/sites-available/`에 복사하고 도메인 및 TLS 설정을 추가하십시오. 인증, 수집 API, 일반 요청에 서로 다른 제한과 타임아웃이 적용됩니다.

## 다중 worker
Linux 웹 서버는 `start_web.sh`가 Gunicorn + Uvicorn worker로 실행합니다. worker 수는 `gunicorn.conf.py`에서 CPU 기준으로 자동 계산됩니다. Windows 개발 환경은 기존 Uvicorn 단일 프로세스를 유지하십시오.

## 관리자 필터
관리자 화면에서 사용자 이메일, 조회 메시지·이메일, 플랫폼, 사용자 번호, 활동 내용, 시작일·종료일로 검색할 수 있습니다.

## 성능 테스트
```bash
python tools/collector_load_test.py --token "확장프로그램토큰" --requests 100 --concurrency 10
```
운영 서버에 무작정 실행하지 말고 테스트 환경에서 먼저 수행하십시오.

## 모니터링
- Windows: `START_MONITOR.bat`
- Linux: `./start_monitor.sh`
CPU, 메모리, 디스크, Redis, 큐 길이, DB 연결, DB 용량, 최근 5분 서버 오류 수를 JSON으로 출력합니다.
