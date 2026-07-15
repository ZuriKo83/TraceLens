# TraceLens

TraceLens는 여러 플랫폼에 흩어진 사용자의 게시글·댓글·질문·답변을 수집해 개인 보관함에서 조회하고 검색할 수 있게 하는 웹 애플리케이션과 Chrome 확장 프로그램입니다.

## 주요 기능

- 이메일·비밀번호 로그인, 이메일 인증 및 비밀번호 재설정
- 사용자별 활동 보관함과 플랫폼·계정·활동 유형별 검색
- YouTube, Instagram, Threads, Facebook, X, 네이버 블로그, 네이버 지식iN 지원
- Chrome 확장 프로그램 기반 활동 수집
- 관리자 도구, 커뮤니티, 신고 및 이용 제한 기능
- PostgreSQL, Redis 세션, RQ 백그라운드 작업 지원

## 디렉터리 구성

- `app/`: FastAPI 웹 애플리케이션
- `chrome_extension/`: Chrome 확장 프로그램
- `alembic/`: 데이터베이스 마이그레이션
- `scripts/`: 백업·검증·마이그레이션 도구
- `systemd/`: Linux 서비스 정의
- `tests/`: 자동화 테스트

## 환경 설정

저장소를 받은 뒤 예제 환경 파일을 복사하고 실제 값을 입력합니다.

```bash
cp .env.example .env
```

최소한 다음 항목은 운영 환경에 맞게 변경해야 합니다.

- `DATABASE_URL`
- `REDIS_URL`
- `SESSION_SECRET`
- `PUBLIC_BASE_URL`
- `SMTP_PASSWORD`
- `ADMIN_EMAILS`

`.env`와 API 키, 비밀번호는 Git에 커밋하지 않습니다.

## Linux 설치 및 실행

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
./scripts/migrate.sh
```

개별 프로세스 실행:

```bash
./start_web.sh
./start_worker.sh
./start_maintenance.sh
```

systemd 서비스 설치:

```bash
chmod +x install_tracelens_services.sh
APP_DIR="$PWD" APP_USER="$USER" APP_GROUP="$(id -gn)" ./install_tracelens_services.sh
```

상태 확인:

```bash
sudo systemctl status tracelens-web tracelens-worker tracelens-maintenance --no-pager
sudo journalctl -u tracelens-web -n 100 --no-pager
```

## Windows 개발 실행

```bat
copy .env.example .env
py -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
START_HERE.bat
```

## Chrome 확장 프로그램

1. Chrome에서 `chrome://extensions`를 엽니다.
2. 개발자 모드를 활성화합니다.
3. `압축해제된 확장 프로그램을 로드합니다`를 선택합니다.
4. `chrome_extension` 폴더를 지정합니다.

Web Store 제출 정보는 `CHROME_WEB_STORE.md`를 참고합니다.

## 공개 배포

Cloudflare Tunnel을 사용하는 경우 공개 호스트의 원본 서비스는 다음과 같이 설정합니다.

```text
http://localhost:8021
```

외부 주소는 `.env`의 `PUBLIC_BASE_URL`과 일치해야 하며, 운영 환경에서는 `SECURE_COOKIES=true`를 유지합니다.

## 테스트

```bash
pytest -q
```

## 관련 문서

- `OPERATIONS.md`: 백업, 모니터링, Redis 및 운영 구성
- `CHROME_WEB_STORE.md`: Chrome Web Store 등록 정보
- `PRIVACY_POLICY.md`: 개인정보처리방침
