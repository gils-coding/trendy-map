# 🗺️ 트렌디맵 실행 가이드

## 준비물 (API 키 2종)

### 1. 네이버 개발자센터 키 (매장 검색용, 무료)
1. https://developers.naver.com 접속 → 로그인
2. Application → 애플리케이션 등록
3. 사용 API: **검색** 선택
4. Client ID, Client Secret 복사
5. `server.js` 상단의 `NAVER_CLIENT_ID`, `NAVER_CLIENT_SECRET` 에 붙여넣기

### 2. 네이버 클라우드 플랫폼 키 (지도 표시 + 주소→좌표 변환용)
1. https://console.ncloud.com 접속 → 회원가입 (카드 등록 필요, 크레딧 제공)
2. AI·NAVER API → Maps → **Web Dynamic Map** 신청
3. AI·NAVER API → Maps → **Geocoding** 신청
4. 인증키 관리에서 Client ID, Client Secret 복사
5. `server.js` 상단의 `NCLOUD_CLIENT_ID`, `NCLOUD_CLIENT_SECRET` 에 붙여넣기
6. `public/index.html` 상단 script src의 `YOUR_NCLOUD_CLIENT_ID` 에 붙여넣기

---

## 실행 방법

```bash
# 1. 이 폴더로 이동
cd trendy-map

# 2. 필요한 패키지 설치 (최초 1회)
npm install

# 3. 서버 실행
npm start

# 4. 브라우저에서 열기
# http://localhost:3000
```

---

## 파일 구조

```
trendy-map/
├── server.js          ← 백엔드 (네이버 API 프록시)
├── package.json
└── public/
    └── index.html     ← 프론트엔드 (지도 화면)
```

## API 흐름

```
브라우저 → /api/stores?query=두바이쫀득쿠키
  → server.js
    → 네이버 로컬검색 API (매장 목록)
    → 네이버 Geocoding API (주소 → 위경도)
  → 브라우저 (좌표 포함 매장 데이터)
  → 네이버 지도에 마커 표시
```
