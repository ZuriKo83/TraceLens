# Cloudflare Tunnel 운영 설정

TraceLens 공개 주소는 `https://tracelens.kr`입니다.

## Tunnel 공개 호스트 이름

- 호스트 이름: `tracelens.kr`
- 서비스 유형: `HTTP`
- 서비스 URL: `localhost:8021`

Cloudflare가 외부 HTTPS를 처리하고 로컬 TraceLens 서버에는 HTTP로 전달합니다.
공유기 포트포워딩과 외부 80/443 포트 개방은 필요하지 않습니다.

## 운영 환경

`.env.production.example`을 `.env`로 복사한 뒤 비밀값을 입력합니다.

```env
PUBLIC_BASE_URL=https://tracelens.kr
SECURE_COOKIES=true
DEBUG_MAGIC_LINKS=false
```

`SESSION_SECRET`과 `SMTP_PASSWORD`는 실제 비밀값으로 교체해야 합니다.

## 실행 확인

1. `START_HERE.bat`으로 TraceLens 서버 실행
2. `http://127.0.0.1:8021/health` 확인
3. Cloudflare Tunnel 상태가 `Healthy`인지 확인
4. `https://tracelens.kr/health` 확인

Tunnel을 Windows 서비스로 설치했다면 PC 재부팅 뒤에도 `cloudflared` 서비스가 자동 시작되는지 확인합니다.
