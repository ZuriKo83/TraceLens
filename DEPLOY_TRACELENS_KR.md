# tracelens.kr 기본 HTTP 포트 연결 가이드

현재 구성은 **외부 80/TCP → 내부 192.168.0.19:8021**입니다.
공개 주소와 이메일 인증 링크는 `https://tracelens.kr`로 설정되어 있습니다.

## 1. TraceLens 서버

`START_HERE.bat`는 다음 주소에서 서버를 실행합니다.

```text
0.0.0.0:8021
```

로컬 확인 주소:

```text
http://127.0.0.1:8021
```

## 2. 공유기 포트포워딩

```text
서비스 이름: TraceLens
장치 IP: 192.168.0.27
외부 포트: 80
내부 포트: 8021
프로토콜: TCP
사용: 켜짐
```

## 3. Windows 방화벽

관리자 PowerShell에서 한 번 실행합니다.

```powershell
New-NetFirewallRule -DisplayName "TraceLens 8021" -Direction Inbound -Protocol TCP -LocalPort 8021 -Action Allow
```

## 4. 가비아 DNS

웹 연결 레코드는 다음과 같습니다. 포트 번호는 DNS에 입력하지 않습니다.

```text
A      @      공인 IPv4
CNAME  www    tracelens.kr.
```

Resend용 `send`, `resend._domainkey`, `_dmarc` 레코드는 유지합니다.

## 5. 환경 파일

`PREPARE_PRODUCTION_ENV.bat`를 실행한 뒤 다음 값을 설정합니다.

```env
PUBLIC_BASE_URL=https://tracelens.kr
SECURE_COOKIES=false
SESSION_SECRET=충분히 긴 무작위 문자열
SMTP_PASSWORD=re_Resend_API_Key
```

## 6. 외부 확인

휴대폰 Wi-Fi를 끄고 모바일 데이터에서 접속합니다.

```text
https://tracelens.kr
https://tracelens.kr/health
```

## 7. 주의

이 구성은 HTTP 외부 테스트용입니다. 정식 운영은 외부 443과 HTTPS 리버스 프록시(Caddy/Nginx 등)를 사용해야 합니다.
