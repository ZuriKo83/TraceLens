# TraceLens 빠른 실행

## 1. 환경설정
`.env.production.example`을 `.env`로 복사한 뒤 아래 비밀값을 입력합니다.

```env
SESSION_SECRET=직접_생성한_긴_무작위_문자열
SMTP_PASSWORD=Resend_API_Key
```

운영 기본값:

```env
PUBLIC_BASE_URL=https://tracelens.kr
SECURE_COOKIES=true
DEBUG_MAGIC_LINKS=false
```

## 2. 서버 실행
`START_HERE.bat` 실행

내부 서비스 주소:

```text
http://127.0.0.1:8021
```

외부 공개 주소:

```text
https://tracelens.kr
```

Cloudflare Tunnel 원본 서비스는 `http://localhost:8021`이어야 합니다.

## 3. 확장 프로그램
Chrome 확장 프로그램 관리 페이지에서 개발자 모드를 켠 뒤 `chrome_extension` 폴더를 압축 해제된 확장 프로그램으로 로드합니다.

## 4. 운영 시 유지할 것
- TraceLens 서버 실행
- Cloudflare Tunnel 서비스 실행
- 공유기 포트포워딩 불필요
- `.env`와 API 키는 GitHub에 업로드 금지
