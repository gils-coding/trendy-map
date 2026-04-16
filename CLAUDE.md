# 트렌디맵 (Trendy Map) — CLAUDE.md

유행 음식·상품 매장을 지도에서 찾아주는 서비스.
카카오·네이버 API로 매장을 검색하고, PostgreSQL DB에 직접 등록한 매장도 통합 표시한다.

---

## 아키텍처

```
trendy-map/
├── server.js          # Express 백엔드 (모든 API + 정적 파일 서빙)
├── public/
│   ├── index.html     # 메인 지도 서비스 (프론트엔드 전체)
│   ├── admin.html     # 관리자 패널 (매장 직접 등록·수정·삭제)
│   └── suggest.html   # 사용자 매장/음식 제안 폼
└── blog-search.js     # 블로그 검색 유틸 (미사용 가능성 있음)
```

- **백엔드**: Node.js + Express, 외부 API 호출은 axios
- **프론트엔드**: 바닐라 HTML/CSS/JS (프레임워크 없음)
- **DB**: PostgreSQL (Railway 호스팅), `pg` 라이브러리 직접 사용
- **배포**: Railway (프로덕션), `DATABASE_URL`에 `railway.internal` 포함 시 SSL 비활성화

---

## 환경변수

```
DATABASE_URL          # PostgreSQL 연결 문자열 (Railway 제공)
KAKAO_REST_KEY        # 카카오 로컬 API 키
NAVER_CLIENT_ID       # 네이버 검색 API Client ID
NAVER_CLIENT_SECRET   # 네이버 검색 API Client Secret
NAVER_MAP_CLIENT_ID   # 네이버 지도 JS API 키 (프론트 지도 렌더링)
ADMIN_PASSWORD        # 관리자 패널 비밀번호 (미설정 시 서버 종료)
```

로컬 개발 시 `.env` 파일 생성 (`.env.example` 참고). 단, `dotenv`를 명시적으로 `require`하는 코드가 없으면 수동으로 추가해야 한다.

---

## DB 테이블

### `custom_stores` — 관리자가 직접 등록한 매장
| 컬럼 | 타입 | 설명 |
|---|---|---|
| id | SERIAL PK | |
| name | TEXT | 매장명 |
| addr | TEXT | 도로명 주소 |
| phone | TEXT | 전화번호 |
| category | TEXT | 카테고리 |
| lat / lng | DOUBLE | 좌표 |
| kakao_url | TEXT | 카카오맵 링크 |
| naver_url | TEXT | 네이버지도 링크 |
| query_tags | TEXT | 콤마 구분 검색 키워드 (예: `버터떡,버터 떡`) |
| memo | TEXT | 내부 메모 |

`query_tags` 검색은 `',' || query_tags || ','` LIKE 패턴으로 정확히 매칭한다.

### `store_suggestions` — 사용자 매장 제안
### `food_suggestions` — 사용자 유행 음식 제안

---

## API 엔드포인트

### 공개
| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/config` | 프론트용 설정 (네이버 지도 키) |
| GET | `/api/stores` | 좌표 기반 매장 검색 (`query, lat, lng, radius`) |
| GET | `/api/store-search` | 매장명 전국 검색 (`category, keyword`) |
| POST | `/api/suggest/store` | 매장 제안 등록 |
| POST | `/api/suggest/food` | 음식 제안 등록 |

### 관리자 (`/api/admin/*`, pw 인증 필요)
| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/admin/stores` | 등록 매장 목록 조회 |
| POST | `/api/admin/stores` | 매장 단건 등록 |
| PUT | `/api/admin/stores/:id` | 매장 수정 |
| DELETE | `/api/admin/stores/:id` | 매장 삭제 |
| POST | `/api/admin/bulk-import` | 네이버맵 JSON 일괄 등록 |
| GET | `/api/admin/geocode` | 주소 → 좌표 변환 (카카오) |
| GET | `/api/admin/suggestions` | 매장 제안 목록 |
| GET | `/api/admin/food-suggestions` | 음식 제안 목록 |

관리자 인증은 `authAdmin` 미들웨어가 담당하며, `pw` 파라미터(GET) 또는 `body.pw`(POST/PUT)로 전달한다.

---

## 매장 검색 흐름

```
/api/stores 요청
    │
    ├─ 카카오 로컬 API (searchKakao)       ← 좌표 + 반경, 최대 5페이지
    ├─ 네이버 지도 내부 API (searchNaverMaps) ← 실패 시 공개 API fallback
    └─ PostgreSQL custom_stores (searchCustomDB)
          │
          ▼
    중복 제거 (isDuplicate: 이름+주소 유사 OR 좌표 50m 이내)
          │
          ▼
    거리순 정렬 → 응답
```

네이버 지도 내부 API(`map.naver.com/p/api/search/allSearch`)는 비공식 엔드포인트다. 응답 구조가 바뀌면 `searchNaverMaps` 함수를 먼저 확인한다.

---

## Rate Limiting

- 일반 API (`/api/stores`, `/api/store-search`): 분당 60회
- 관리자 API (`/api/admin/*`): 분당 10회

---

## 프론트엔드 함수명 규칙 (admin.html)

| 기능 | 함수명 |
|---|---|
| 등록 매장 목록 갱신 | `loadList()` |
| 매장 제안 목록 갱신 | `loadSuggestions()` |
| 음식 제안 목록 갱신 | `loadFoodSuggestions()` |
| 네이버 JSON 일괄 등록 | `bulkImport()` |
| 주소 → 좌표 자동입력 | `autoGeocode()` |

> **주의**: `loadStores()`라는 함수는 존재하지 않는다. 목록 갱신은 반드시 `loadList()`를 사용한다.

---

## 디버그

개발 환경(`NODE_ENV !== 'production'`)에서만 활성화되는 엔드포인트:

```
GET /api/debug-search?query=버터떡&lat=35.1595&lng=126.8526&radius=10000
```

카카오/네이버/DB 원본 결과를 분리해서 확인할 수 있다.

---

## 로컬 실행

```bash
# 환경변수 설정 후
node server.js
# → http://localhost:3000
```

`NODE_ENV`가 `production`이 아니면 TLS 검증이 비활성화된다(`NODE_TLS_REJECT_UNAUTHORIZED=0`).
