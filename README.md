# TraceLens 로컬 Docker 실행

FastAPI, PostgreSQL, Redis, 작업자, 브라우저 수집기를 Docker Compose에서 실행합니다. Docker를 돌리는 서버에만 설치가 필요합니다. 사용자는 Node.js, Docker, 확장 프로그램 없이 웹 브라우저로 접속합니다.

최종 Linux 서버는 Docker 없이도 실행할 수 있습니다. 설치 순서와 systemd 설정은 [Linux 직접 실행 안내](deploy/linux/README.md)에 있습니다. 웹과 수집기의 내부 주소, 브라우저 프로필 경로를 환경 변수로 지정하므로 개발용 Docker 구성과 같은 애플리케이션 코드를 사용합니다.

## 서버 시작

Windows 서버에서는 Docker Desktop을 실행한 뒤 `START_HERE.bat`을 실행합니다. Linux 또는 macOS 서버에서는 `.env.example`을 `.env`로 복사하고 `docker compose up --build -d`를 실행합니다. 첫 빌드는 Chromium과 Firefox를 내려받아 시간이 걸립니다.

기본 웹 주소는 **http://localhost:8021**입니다. 현재 Compose 파일은 서버 자신의 `127.0.0.1`에만 포트를 엽니다. 다른 PC에서 접속시키려면 별도 네트워크·HTTPS 배포 설정이 필요합니다. 이 로컬 설정을 외부에 그대로 공개하지 마세요.

## 사용자 조회

1. 일반 브라우저에서 TraceLens에 로그인합니다.
2. 대시보드의 **사이트 연결** 버튼을 누릅니다.
3. 서버의 전용 브라우저 화면을 클릭하고 로그인합니다. 화면 아래 입력란으로 글자를 전송하고 Enter 버튼으로 진행합니다.
4. 대시보드로 돌아와 사이트를 고르고 **조회 시작**을 누릅니다. 기존 추출·중복 제거·저장 API가 작동합니다.

사이트별 로그인 세션은 Docker의 `browser_profiles` 볼륨에 사용자별로 분리해 저장됩니다. 이 볼륨에는 사이트 로그인 쿠키가 포함됩니다. 사이트 화면·로그인 방식이 바뀌거나 자동화 브라우저를 차단하면 로그인이 실패할 수 있습니다. 자격 증명은 서버 브라우저로 입력되므로 서버 관리자에게 신뢰가 필요한 구조입니다.

서버 브라우저는 기본 Chromium입니다. 서버에서 Playwright Firefox를 사용하려면 `.env`에 `TRACELENS_BROWSER=firefox`를 넣고 수집기 컨테이너를 재시작하세요. 사용자 PC에 설치된 Edge, Chrome, Firefox와 무관하게 동작합니다.

## 지원 범위

YouTube 댓글·실시간 채팅, Instagram 댓글, Threads 게시글·답글, Facebook 게시글·댓글, X, 네이버 블로그·지식iN의 기존 추출 코드와 본인 활동 확인 절차를 재사용합니다. 조회 시작을 누를 때만 읽고 저장합니다. 원본 사이트 삭제와 상시 수집은 이 방식에 포함하지 않았습니다. 실제 사이트별 로그인과 추출 결과는 계정으로 확인해야 합니다.

## 로컬 설정

`.env`의 `SESSION_SECRET`을 임의의 긴 값으로 바꾸세요. `POSTGRES_PASSWORD`는 최초 실행 전에 영문·숫자 값으로 설정하세요. 이미 생성된 DB 볼륨의 암호는 환경 변수만 바꿔도 변경되지 않습니다.

SMTP 발송 코드는 제거되어 있습니다. 인증번호는 로컬 화면에 표시되며 이메일 소유 여부를 검증하지 않습니다. `ADMIN_EMAILS`에 사용할 이메일을 넣으면 관리자로 동기화됩니다. 새 설치는 빈 데이터베이스로 시작합니다.

```bash
docker compose logs -f web collector
docker compose down
```

`docker compose down -v`는 DB, Redis, 브라우저 로그인 볼륨을 삭제합니다.

## 검사

서버 브라우저 통합 검사는 합성 페이지로 Chromium·Firefox의 조회와 업로드를 확인합니다. 서버의 수집기는 `local_collector/`의 기존 추출 어댑터를 사용합니다.

```bash
cd local_collector
npm ci
npx playwright install --with-deps chromium firefox
npm test
```

기존 Python 테스트는 `docker compose exec web pytest -q`로 실행합니다.
