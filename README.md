# TraceLens 로컬 개발

FastAPI, PostgreSQL, Redis, RQ worker를 Docker Compose로 실행합니다. 웹 서버는 현재 컴퓨터의 `localhost:8021`에만 열립니다. 데이터베이스와 Redis는 호스트에 공개하지 않으며 Docker 볼륨에 보관됩니다.

## Windows에서 시작

1. Docker Desktop을 실행하고 Node.js 22 이상을 설치합니다.
2. 프로젝트 폴더의 `START_HERE.bat`을 실행합니다.
3. 배치파일이 설치된 Edge, Chrome 순서로 확인하고 둘 다 없으면 Chromium을 자동으로 설치합니다.
4. 열린 브라우저에서 TraceLens에 가입·로그인합니다.
5. 대시보드의 **사이트 연결** 버튼으로 각 사이트에 직접 로그인합니다. 로그인 화면과 2단계 인증은 사용자가 직접 처리합니다.
6. 대시보드로 돌아와 사이트를 선택하고 **조회 시작**을 누릅니다. 결과는 기존 수집 API와 중복 제거 로직을 통해 저장됩니다.

최초 실행 시 `.env`가 없으면 생성합니다. 기존 `.env`는 덮어쓰지 않습니다. 배치파일은 Docker Compose 서비스와 Node.js 로컬 수집기를 실행하고, 확장 프로그램 설치 없이 동작합니다. 수집 중에는 배치파일 창과 수집용 브라우저를 열어 두세요.

| 브라우저 | 실행 방식 |
|---|---|
| Edge | PC에 설치된 Microsoft Edge, 별도 프로필 |
| Chrome | PC에 설치된 Google Chrome, 별도 프로필 |
| Firefox | Playwright용 Firefox를 처음 실행할 때 다운로드 |
| Chromium | Playwright용 Chromium을 처음 실행할 때 다운로드 |

Firefox는 자동 선택 대상이 아닙니다. 특정 브라우저를 쓰려면 명령 프롬프트에서 `set TRACELENS_BROWSER=chrome`(또는 `edge`, `firefox`, `chromium`)을 설정한 뒤 같은 창에서 `START_HERE.bat`을 실행하세요.

기존 일반 브라우저 프로필의 로그인을 가져오지 않습니다. 로그인 상태는 브라우저별 `.local-browser/` 폴더에 보관되며, Git 및 Docker 이미지에서 제외됩니다. 브라우저를 바꾸거나 사이트가 세션을 만료시키면 다시 로그인해야 합니다. 이 폴더에는 계정 세션이 있으므로 공유하지 마세요.

## 직접 실행 / macOS·Linux

프로젝트 루트에서 `.env.example`을 `.env`로 복사합니다(최초 한 번).

```bash
docker compose up --build -d
cd local_collector
npm ci
npx playwright install chromium
node index.mjs --browser chromium
```

`--browser edge`, `--browser chrome`, `--browser firefox`도 사용할 수 있습니다. Firefox 선택 시 `npx playwright install firefox`가 필요합니다. Linux에서 브라우저 시스템 라이브러리가 없으면 Playwright 공식 설치 안내에 따라 `npx playwright install --with-deps chromium firefox`를 실행합니다.

일반 브라우저에서 `http://localhost:8021`을 직접 열면 보관함을 볼 수 있지만 로컬 수집기 연결은 없습니다. 조회는 실행기가 열어 준 브라우저의 대시보드에서 진행합니다.

## 지원 범위와 제한

- YouTube 댓글·실시간 채팅, Instagram 댓글, Threads 게시글·답글, Facebook 게시글·댓글, X, 네이버 블로그·지식iN의 기존 추출 코드와 본인 활동 확인 절차를 재사용합니다.
- 수집은 **조회 시작 버튼을 누를 때** 실행됩니다. 상시 감시나 예약 수집은 포함하지 않습니다.
- 이번 로컬 수집기는 조회·저장 범위입니다. 원본 사이트에서 삭제하는 기능은 기존 확장 프로그램에 남아 있으며 로컬 수집기에는 연결하지 않았습니다.
- 사이트 화면 변경, 로그인 차단, CAPTCHA, 세션 만료 시 일부 사이트 조회가 실패할 수 있습니다. 로그인 자동 우회 기능은 없습니다.
- Chromium·Firefox용 합성 페이지 통합 검사를 포함했습니다. 이 작업 환경에서는 브라우저 실행이 제한되어 통합 검사를 완료하지 못했습니다. 실제 플랫폼 계정과 설치된 Chrome·Edge의 동작은 해당 PC에서 확인해야 합니다.

## 로컬 설정과 데이터

`.env`의 `SESSION_SECRET`을 임의의 긴 값으로 바꾸세요. `POSTGRES_PASSWORD`는 최초 실행 전에 영문·숫자 값으로 설정하세요. 이미 생성된 DB 볼륨의 암호는 환경 변수만 바꿔도 변경되지 않습니다.

SMTP 발송 코드와 설정은 제거되어 있습니다. 인증번호는 로컬 화면에 표시되며 이메일 소유 여부를 검증하지 않습니다. 외부에 공개하지 마세요. `ADMIN_EMAILS`에 사용할 이메일을 넣으면 관리자로 동기화됩니다. 새 설치는 빈 데이터베이스로 시작합니다.

```bash
docker compose logs -f web
docker compose down
```

`docker compose down -v`는 DB와 Redis 볼륨을 삭제합니다. `.local-browser` 폴더를 지우면 사이트 로그인 상태가 없어집니다.

## 검사

로컬 수집기 테스트(플랫폼 실제 계정 사용 없음):

```bash
cd local_collector
npm ci
npx playwright install --with-deps chromium firefox
npm test
```

브라우저 다운로드 없이 보안 경계와 동시 실행 제한만 검사하려면 `node --test test/policy.test.mjs`를 실행합니다.

기존 Python 테스트:

```powershell
docker compose exec web pytest -q
```

이전 Linux `systemd` 및 공개 배포 문서는 현재 로컬 Docker 실행에는 사용하지 않습니다.
