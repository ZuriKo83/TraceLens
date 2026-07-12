# TraceLens v1.0.7

TraceLens는 여러 웹사이트에 흩어진 **내 게시글·댓글·질문·답변**을 한곳에서 조회하고 검색하는 웹 앱과 Chrome 확장 프로그램입니다.

## 핵심 기능

- 이메일 매직 링크 로그인
- 사용자별 보관함 분리
- 웹 대시보드에서 조회 사이트 선택 및 실행
- YouTube, Instagram, Threads, Facebook, X, 네이버 블로그, 네이버 지식iN 지원
- 플랫폼·계정·활동 유형별 검색
- 관리자 전용 `/admin` 화면
- Chrome 확장 프로그램 자동 연결

## 로컬 실행

Windows에서는 프로젝트 루트의 `START_HERE.bat`를 실행합니다.

직접 실행:

```bat
copy .env.example .env
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --reload --host 0.0.0.0 --port 8021
```

접속 주소:

```text
http://127.0.0.1:8021
```


## 관리자 계정

관리자 권한은 `.env`의 `ADMIN_EMAILS`에 명시된 이메일에만 부여됩니다.
첫 가입자는 자동으로 관리자가 되지 않습니다.

```env
ADMIN_EMAILS=drkoby0803@gmail.com
FIRST_USER_IS_ADMIN=false
```

서버 시작 시 기존 DB의 관리자 권한도 이 설정에 맞춰 자동 동기화됩니다.
따라서 예전에 첫 가입자에게 부여됐던 관리자 권한은 자동으로 해제됩니다.

## Chrome 확장 프로그램

개발 모드 설치:

1. `chrome://extensions` 열기
2. 개발자 모드 활성화
3. `압축해제된 확장 프로그램을 로드합니다` 선택
4. `chrome_extension` 폴더 선택
5. TraceLens 로그인 후 `/app` 접속

Chrome Web Store 업로드 파일은 프로젝트와 함께 제공되는
`tracelens-extension-v1.0.7-cloudflare-https.zip`입니다.

## 이메일의 역할

이메일은 TraceLens 로그인, 사용자 데이터 분리, 계정 복구에 사용됩니다.
사이트 활동은 이메일로 검색하지 않습니다. 실제 조회 기준은 현재 Chrome에 로그인된 각 사이트 계정입니다.

## 데이터베이스

새 기본 파일명은 `tracelens.db`입니다. `START_HERE.bat`는 같은 폴더에 기존 `footprint.db`가 있으면 최초 실행 시 `tracelens.db`로 복사합니다.

## 공개 배포 전 필수 작업

- 실제 HTTPS 도메인에 웹 앱 배포
- `.env`의 `PUBLIC_BASE_URL`, SMTP, `SESSION_SECRET`, `SECURE_COOKIES` 설정
- 배포 도메인을 확장 프로그램 `manifest.json`의 `host_permissions`와 `content_scripts.matches`에 추가
- 개인정보처리방침 공개
- Chrome Web Store 개인정보 보호 항목 및 권한 사용 이유 작성

현재 패키지는 로컬 주소 `localhost:8021`, `127.0.0.1:8021`을 포함합니다.
일반 사용자에게 공개하려면 실제 서비스 도메인을 반드시 추가해야 합니다.

## 테스트

```bat
pytest -q
```


## v1.0.3 관리자 필터 수정

관리자 화면에서 `모든 사용자` 또는 `모든 플랫폼`을 선택했을 때 빈 쿼리 문자열이 전송되어
FastAPI가 `user_id`를 정수로 변환하지 못하던 문제를 수정했습니다.

- 빈 `user_id`는 필터 없음으로 처리
- 잘못된 `user_id` 값도 422 오류 없이 무시
- 브라우저에서도 빈 필터 파라미터를 URL에서 제거


## tracelens.kr 및 Resend 연결

공개 주소와 매직 링크 기본값은 `https://tracelens.kr`이며, Cloudflare Tunnel이 로컬 `127.0.0.1:8021`로 전달합니다.
운영 설정은 `.env.production.example`을 사용합니다. 실제 배포 절차는 `DEPLOY_TRACELENS_KR.md`를 참고하세요.

중요: 도메인 DNS 인증은 메일 발송 권한만 확인합니다. 웹사이트를 열려면 별도의 FastAPI 서버 배포와 가비아 A/CNAME 연결이 필요합니다.


## 연결 구성 (v1.0.7)

- TraceLens 내부 서버: `0.0.0.0:8021`
- 공유기 포트포워딩: 외부 `80/TCP` → `192.168.0.19:8021`
- 로컬 접속: `http://127.0.0.1:8021`
- 공개 접속: `https://tracelens.kr`
- Tunnel 원본 서비스: `http://localhost:8021`

외부 포트가 HTTP 기본 포트 80이므로 주소에서 포트 번호를 생략할 수 있습니다.




## 실행 명령어

- cd ~/Desktop/TraceLens
- nano .env

- sudo systemctl restart tracelens-web tracelens-worker tracelens-maintenance
- sudo systemctl status tracelens-web tracelens-worker tracelens-maintenance --no-pager
- sudo journalctl -u tracelens-web -n 50 --no-pager


이 명령은 모든 사용자의 보관함 데이터를 영구 삭제합니다.

``` sudo -u postgres psql -d tracelens -c "
TRUNCATE TABLE scan_logs, activities RESTART IDENTITY CASCADE;
" ```
