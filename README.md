# TraceLens 로컬 Docker 실행

FastAPI, PostgreSQL, Redis, 작업자, 유지보수 작업을 Docker Compose에서 실행합니다. 사용자는 확장 프로그램 대신 PC 수집기를 실행합니다. Windows 배포 묶음에는 Node.js 실행 파일이 포함되므로 별도로 설치하지 않습니다.

최종 Linux 서버는 Docker 없이도 실행할 수 있습니다. 설치 순서와 systemd 설정은 [Linux 직접 실행 안내](deploy/linux/README.md)에 있습니다. 사용자 PC의 수집기는 서버 운영 방식과 관계없이 별도로 실행합니다.

## 서버 시작

Windows 서버에서는 Docker Desktop을 실행한 뒤 `START_HERE.bat`을 실행합니다. Linux 또는 macOS 서버에서는 `.env.example`을 `.env`로 복사하고 `docker compose up --build -d`를 실행합니다.

Windows에서 서버 PC는 `START_HERE.bat`을 실행합니다. 사용자 PC는 설치 파일을 한 번 실행한 뒤 시작 메뉴의 **TraceLens PC Collector**를 클릭합니다. 같은 PC에서 서버와 수집기를 실행한다면 서버를 먼저 시작합니다. Docker Compose가 웹·작업자·유지보수 작업을 함께 시작합니다.

기본 웹 주소는 **http://localhost:8021**입니다. 현재 Compose 파일은 서버 자신의 `127.0.0.1`에만 포트를 엽니다. 다른 PC에서 접속시키려면 별도 네트워크·HTTPS 배포 설정이 필요합니다. 이 로컬 설정을 외부에 그대로 공개하지 마세요.

## 사용자 PC에서 조회

1. Docker 서버를 먼저 실행합니다. 현재 개발 주소는 `http://localhost:8021`입니다.
2. [Windows 설치 파일](https://github.com/ZuriKo83/TraceLens/releases/download/pc-collector/TraceLens-PC-Setup.exe)을 설치하고 시작 메뉴의 **TraceLens PC Collector**를 실행합니다. PC에 설치된 Edge를 전용 프로필로 엽니다. Edge가 없으면 설치된 Chrome을 사용합니다. 이미 열린 다른 브라우저 창을 닫을 필요는 없습니다. 압축 해제나 배치파일 선택, Node.js 별도 설치는 필요하지 않습니다.
3. 새로 열린 창에서 TraceLens에 로그인합니다. 연결 가능한 사이트의 **사이트 로그인** 버튼을 눌러 직접 로그인을 시도하고 2차 인증을 마칩니다. 이 전용 프로필의 로그인 상태는 다음 실행에도 유지되지만, 사이트가 세션을 만료시키거나 자동화된 브라우저의 로그인을 거부할 수 있습니다. 기존 브라우저의 로그인 세션은 복사하지 않습니다.
4. 대시보드에 **전용 브라우저 연결됨**이 표시되면 사이트를 선택하고 **조회 시작**을 누릅니다. 조회 탭은 전용 프로필의 백그라운드에서 열리고 결과만 서버 API로 보냅니다. 조회 중에는 수집기 창을 열어 두세요.

현재 설치 파일은 코드 서명 인증서가 없어 Windows가 게시자를 확인할 수 없습니다. 설치 파일 형식만으로 신뢰가 생기지는 않으므로 공개 배포 전에 게시자 코드 서명을 준비해야 합니다. Node.js와 Playwright가 포함되어 최초 다운로드 용량도 여전히 큽니다. 개발 환경에서는 `cd local_collector && npm ci && node index.mjs --browser=edge`로 실행할 수 있습니다.

전용 프로필은 Windows의 `%LOCALAPPDATA%\TraceLens\collector-profile\edge`에 저장됩니다. Windows 앱 설정에서 수집기를 제거해도 로그인 데이터가 남으므로, 완전히 삭제하려면 모든 수집기 창을 닫은 뒤 이 폴더도 직접 지우세요.

Linux 서버로 이전할 때는 PC 수집기 실행 환경의 `TRACELENS_SERVER_URL`을 실제 HTTPS 웹 주소로 설정해야 합니다. 서버는 브라우저 쿠키나 비밀번호를 받지 않고 수집 결과만 저장합니다. 같은 PC에서 여러 사이트를 조회할 때에는 한 작업이 끝난 뒤 다음 작업을 시작합니다.

## 지원 범위

Instagram 댓글, Threads 게시글·답글, Facebook 게시글·댓글, X, 네이버 블로그·지식iN의 기존 추출 코드를 재사용합니다. 조회 시작을 누를 때만 읽고 저장합니다. 각 사이트의 로그인과 추출 성공 여부는 실제 계정으로 확인해야 합니다. Google이 전용 브라우저의 로그인을 거부하는 사례를 확인하여 현재 PC 수집기의 YouTube 연결과 조회는 비활성화했습니다. 기존 YouTube 추출 코드가 남아 있어도 이 설치 파일로 새 Google 로그인을 할 수 있다는 뜻은 아닙니다. PC 수집기에서는 원본 사이트 삭제와 상시 수집을 지원하지 않습니다.

## 로컬 설정

`.env`의 `SESSION_SECRET`을 임의의 긴 값으로 바꾸세요. `POSTGRES_PASSWORD`는 최초 실행 전에 영문·숫자 값으로 설정하세요. 이미 생성된 DB 볼륨의 암호는 환경 변수만 바꿔도 변경되지 않습니다.

SMTP 발송 코드는 제거되어 있습니다. 인증번호는 로컬 화면에 표시되며 이메일 소유 여부를 검증하지 않습니다. `ADMIN_EMAILS`에 사용할 이메일을 넣으면 관리자로 동기화됩니다. 새 설치는 빈 데이터베이스로 시작합니다.

```bash
docker compose logs -f web worker maintenance
docker compose down
```

`docker compose down -v`는 DB와 Redis 볼륨을 삭제합니다.

## 검사

브라우저 통합 검사는 합성 페이지로 추출 어댑터의 조회와 업로드를 확인합니다. 사용자 PC 수집기는 `local_collector/`의 동일한 추출 어댑터를 사용합니다.

```bash
cd local_collector
npm ci
npx playwright install --with-deps chromium firefox
npm test
```

기존 Python 테스트는 `docker compose exec web pytest -q`로 실행합니다.
