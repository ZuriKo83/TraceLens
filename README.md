# TraceLens 로컬 개발

FastAPI, PostgreSQL, Redis, RQ worker를 Docker Compose로 실행합니다. 웹 서버는 현재 컴퓨터의 `localhost:8021`에만 열립니다. 데이터베이스와 Redis는 호스트에 공개하지 않으며 Docker 볼륨에 보관됩니다.

## 시작

Windows PowerShell:

```powershell
Copy-Item .env.example .env
docker compose up --build -d
docker compose logs -f web
```

macOS/Linux에서는 `cp .env.example .env` 후 동일한 Docker 명령을 실행합니다. 브라우저에서 http://localhost:8021 을 여세요. 웹 컨테이너 시작 시 Alembic 마이그레이션을 실행합니다. 코드 변경은 자동 재시작됩니다.

`.env`의 `SESSION_SECRET`을 임의의 긴 값으로 바꾸세요. `POSTGRES_PASSWORD`를 바꾸려면 최초 실행 전에 영문·숫자 값으로 설정하세요. 이미 생성된 DB 볼륨의 암호는 환경 변수만 바꿔도 변경되지 않습니다. `.env`를 Git에 올리지 마세요.

이 브랜치에는 SMTP 발송 코드와 설정이 없습니다. 가입·재설정 번호 및 이메일 연결 링크는 개발 화면에 표시되며, 입력한 이메일의 소유 여부를 검증하지 않습니다. 외부에 공개하지 마세요. `ADMIN_EMAILS`에 사용할 이메일을 넣으면 관리자로 동기화됩니다. 실제 서버 데이터를 가져오려면 별도의 PostgreSQL 백업 및 복원 절차가 필요합니다. 새 설치는 빈 데이터베이스로 시작합니다.

```powershell
docker compose ps
docker compose down
```

`docker compose down -v`는 로컬 DB와 Redis 볼륨까지 삭제하므로 데이터가 필요하다면 실행하지 마세요.

## 확장 프로그램으로 수집

1. Chrome `chrome://extensions`에서 개발자 모드를 켭니다.
2. `chrome_extension` 폴더를 압축해제된 확장 프로그램으로 로드합니다. 이미 로드했다면 새로고침합니다.
3. http://localhost:8021 에 로그인해 대시보드를 다시 열면 로컬 토큰이 연결됩니다.
4. 수집할 각 사이트에 동일한 Chrome 프로필로 로그인하고 조회합니다.

이 브랜치의 확장 프로그램은 `localhost:8021` 또는 `127.0.0.1:8021` 서버에만 기록을 전송합니다. 기존 공개 도메인 권한과 기본 연결은 제거했습니다. 수집 대상 플랫폼의 웹페이지는 여전히 인터넷 연결이 필요합니다.

## 확장 프로그램 없는 수집 검토

현재 수집 코드는 Chrome 확장 프로그램의 `tabs`, `scripting` 권한과 사용자의 로그인 세션을 이용하여 각 플랫폼의 본인 활동 화면을 읽습니다. Docker의 웹 서버만 실행해서는 이 세션에 접근할 수 없습니다.

우선 단계는 플랫폼에서 제공하는 공식 데이터 내보내기 파일을 사용자가 직접 업로드하고, 기존 활동 스키마에 맞춰 가져오는 방식입니다. 파일 형식과 본인 활동 검증을 플랫폼별로 구현해야 합니다. 이후 공식 OAuth/API가 해당 본인 활동 범위를 제공하는 플랫폼에 한해 계정 연결 방식을 검토할 수 있습니다. 브라우저 자동화는 로그인·2단계 인증·화면 변경과 세션 보관 문제가 있어 별도로 평가해야 합니다. **현재 확장 프로그램 없는 수집 기능은 구현되지 않았습니다.**

## 검사

```powershell
docker compose exec web pytest -q
```

이전 Linux `systemd` 및 공개 배포 문서는 현재 로컬 Docker 실행에는 사용하지 않습니다.
