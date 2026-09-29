# TraceLens 로컬 Docker 실행

FastAPI, PostgreSQL, Redis, 작업자, 유지보수 작업을 Docker Compose에서 실행합니다. 사용자는 확장 프로그램 대신 PC 수집기를 실행합니다. Windows 배포 묶음에는 Node.js 실행 파일이 포함되므로 별도로 설치하지 않습니다.

최종 Linux 서버는 Docker 없이도 실행할 수 있습니다. 설치 순서와 systemd 설정은 [Linux 직접 실행 안내](deploy/linux/README.md)에 있습니다. 사용자 PC의 수집기는 서버 운영 방식과 관계없이 별도로 실행합니다.

## 서버 시작

Windows 서버에서는 Docker Desktop을 실행한 뒤 `START_HERE.bat`을 실행합니다. Linux 또는 macOS 서버에서는 `.env.example`을 `.env`로 복사하고 `docker compose up --build -d`를 실행합니다.

Windows에서 평소 누를 파일은 서버 PC의 `START_HERE.bat`, 수집할 사용자 PC의 다운로드 묶음에 든 `START_PC_COLLECTOR.bat` 두 개입니다. 같은 PC에서 서버와 수집기를 실행한다면 이 순서대로 한 번씩 실행합니다. Docker Compose가 웹·작업자·유지보수 작업을 함께 시작합니다.

기본 웹 주소는 **http://localhost:8021**입니다. 현재 Compose 파일은 서버 자신의 `127.0.0.1`에만 포트를 엽니다. 다른 PC에서 접속시키려면 별도 네트워크·HTTPS 배포 설정이 필요합니다. 이 로컬 설정을 외부에 그대로 공개하지 마세요.

## 사용자 PC에서 조회

1. 브라우저에서 TraceLens에 로그인합니다. 현재 Docker 개발 주소는 `http://localhost:8021`입니다.
2. 사용 중인 브라우저가 로컬 DevTools 연결을 허용해야 합니다. Edge가 꺼져 있다면 PC 수집기 실행 파일이 기존 Edge 프로필을 연결 가능한 상태로 엽니다. 이미 브라우저가 켜져 있는데 연결 기능이 없다면 창을 닫고 실행 파일을 다시 열어야 합니다. 브라우저 세션을 다른 프로필로 복사하지 않습니다.
3. [Windows PC 수집기 파일](https://github.com/ZuriKo83/TraceLens/actions/runs/36509547196/artifacts/11008731747)을 내려받아 압축을 푼 뒤 `START_PC_COLLECTOR.bat`을 실행합니다. GitHub 로그인과 Actions 파일 보관 기간이 적용됩니다. Node.js 설치는 필요하지 않습니다. 개발 환경에서는 `cd local_collector && npm ci && node attach.mjs`로 실행할 수 있습니다. 디버깅 포트는 로컬 PC에서만 열어야 합니다.
4. 대시보드에 **사용 중인 브라우저 연결됨**이 표시되면 사이트를 선택하고 **조회 시작**을 누릅니다. PC 수집기가 현재 브라우저의 로그인 세션에서 별도 조회 탭을 열고 결과만 서버 API로 보냅니다. 사이트 로그인 오류가 나온 경우에만 대시보드의 사이트 링크를 눌러 직접 로그인한 뒤 다시 조회하세요.

Chrome 136 이상은 기본 프로필에 `--remote-debugging-port`를 적용하지 않습니다. 현재 로그인 상태를 유지하려면 새 프로필로 우회할 수 없으므로, Chrome에서는 기존 브라우저가 별도로 디버깅 연결을 허용한 경우에만 수집할 수 있습니다. 웨일도 로컬 DevTools 포트를 제공하는 환경에서만 연결할 수 있으며 실제 웨일 버전별 동작은 아직 검증되지 않았습니다. Firefox는 이 CDP 수집기에 연결되지 않습니다. 디버깅 연결을 열지 않은 일반 실행 중 브라우저에 PC 프로그램이 자동으로 붙을 수는 없습니다.

Linux 서버로 이전할 때는 PC 수집기 실행 환경의 `TRACELENS_SERVER_URL`을 실제 HTTPS 웹 주소로 설정해야 합니다. 서버는 브라우저 쿠키나 비밀번호를 받지 않고 수집 결과만 저장합니다. 같은 PC에서 여러 사이트를 조회할 때에는 한 작업이 끝난 뒤 다음 작업을 시작합니다.

## 지원 범위

YouTube 댓글·실시간 채팅, Instagram 댓글, Threads 게시글·답글, Facebook 게시글·댓글, X, 네이버 블로그·지식iN의 기존 추출 코드와 본인 활동 확인 절차를 재사용합니다. 조회 시작을 누를 때만 읽고 저장합니다. PC 수집기에서는 원본 사이트 삭제와 상시 수집을 지원하지 않습니다. 실제 사이트별 로그인과 추출 결과는 계정으로 확인해야 합니다.

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
