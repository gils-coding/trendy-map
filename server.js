// =====================================================
// 트렌디맵 백엔드 서버
// - 카카오 로컬 API → 좌표 기반 매장 검색 + 영업시간
// - 네이버 지역검색 API
// - SQLite 직접 등록 DB
// =====================================================

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const Database = require('better-sqlite3');

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE'] }));
app.use(express.json());

// =====================================================
// SQLite 초기화
// =====================================================
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'stores.db');
const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS custom_stores (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    addr        TEXT    NOT NULL,
    phone       TEXT,
    category    TEXT,
    lat         REAL    NOT NULL,
    lng         REAL    NOT NULL,
    kakao_url   TEXT,
    naver_url   TEXT,
    query_tags  TEXT    NOT NULL,  -- 콤마 구분 키워드 (예: "버터떡,버터 떡")
    memo        TEXT,
    created_at  TEXT    DEFAULT (datetime('now','localtime'))
  )
`);
console.log('✅ SQLite DB 준비:', DB_PATH);

// =====================================================
// API 키
// =====================================================
const KAKAO_REST_KEY = process.env.KAKAO_REST_KEY || '';
const NAVER_CLIENT_ID = process.env.NAVER_CLIENT_ID || '';
const NAVER_CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'trendymap2024'; // 관리자 비밀번호

// =====================================================
// 유틸: 두 좌표 사이 거리(m) — Haversine
// =====================================================
function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// =====================================================
// 카카오 로컬 키워드 검색
// =====================================================
async function searchKakao(query, x, y, radius = 5000) {
  const results = [];
  const headers = { Authorization: `KakaoAK ${KAKAO_REST_KEY}` };

  for (let page = 1; page <= 5; page++) {
    try {
      const res = await axios.get('https://dapi.kakao.com/v2/local/search/keyword.json', {
        params: { query, x, y, radius, size: 15, page, sort: 'accuracy' },
        headers,
      });
      const items = res.data.documents || [];
      results.push(...items);
      if (res.data.meta.is_end) break;
    } catch (err) {
      console.error(`카카오 검색 오류 (page ${page}):`, err.response?.data || err.message);
      break;
    }
  }

  const seen = new Set();
  return results.filter(item => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

// =====================================================
// 네이버 지역검색 API
// =====================================================
async function searchNaver(query, lat, lng) {
  if (!NAVER_CLIENT_ID || !NAVER_CLIENT_SECRET) return [];
  try {
    const res = await axios.get('https://openapi.naver.com/v1/search/local.json', {
      params: { query, display: 5, start: 1, sort: 'comment' },
      headers: {
        'X-Naver-Client-Id': NAVER_CLIENT_ID,
        'X-Naver-Client-Secret': NAVER_CLIENT_SECRET,
      },
      timeout: 5000,
    });
    return (res.data.items || []).map(item => ({
      name: item.title.replace(/<[^>]+>/g, ''),
      addr: item.roadAddress || item.address,
      phone: item.telephone || null,
      category: item.category || null,
      lat: katecToWgs84(parseInt(item.mapy), parseInt(item.mapx)).lat,
      lng: katecToWgs84(parseInt(item.mapy), parseInt(item.mapx)).lng,
      naverUrl: item.link || null,
      kakaoUrl: null,
      hours: null,
      isOpen: null,
      source: 'naver',
    }));
  } catch (err) {
    console.error('네이버 검색 오류:', err.response?.data || err.message);
    return [];
  }
}

function katecToWgs84(mapy, mapx) {
  return { lat: mapy / 1e7, lng: mapx / 1e7 };
}

// =====================================================
// SQLite 커스텀 DB 검색
// 현재 지도 중심에서 radius 이내 + query_tags 매칭
// =====================================================
function searchCustomDB(query, lat, lng, radius) {
  // query_tags 컬럼에 해당 키워드가 포함된 행 모두 가져온 뒤 거리 필터
  const rows = db.prepare(
    `SELECT * FROM custom_stores WHERE ',' || query_tags || ',' LIKE ?`
  ).all(`%,${query},%`);

  return rows
    .filter(row => haversineM(lat, lng, row.lat, row.lng) <= radius)
    .map(row => ({
      name: row.name,
      addr: row.addr,
      phone: row.phone || null,
      category: row.category || null,
      lat: row.lat,
      lng: row.lng,
      kakaoUrl: row.kakao_url || null,
      naverUrl: row.naver_url || null,
      hours: null,
      isOpen: null,
      source: 'custom',
      memo: row.memo || null,
    }));
}

// =====================================================
// 카카오 장소 상세 (영업시간)
// =====================================================
async function getPlaceDetail(placeId) {
  try {
    const res = await axios.get(`https://place.map.kakao.com/main/v/${placeId}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 3000,
    });
    const openHour = res.data?.basicInfo?.openHour;
    if (!openHour) return {};

    const hourLines = [];
    for (const period of openHour.periodList || []) {
      for (const t of period.timeList || []) {
        hourLines.push(`${t.dayOfWeek}  ${t.timeSE}`);
        if (t.breakTime) hourLines.push(`  브레이크  ${t.breakTime}`);
      }
    }
    const isOpen = openHour.realtime?.open === 'Y' ? true
      : openHour.realtime?.open === 'N' ? false : null;

    return { hours: hourLines.join('\n') || null, isOpen };
  } catch {
    return {};
  }
}

// =====================================================
// 중복 제거 헬퍼
// 기준: 이름+주소 유사 OR 좌표 50m 이내
// =====================================================
function isDuplicate(store, referenceList) {
  const name = store.name.trim();
  const addr = (store.addr || '').trim();
  return referenceList.some(ref => {
    // 1) 이름이 같거나 포함 관계 + 주소 앞 10글자 일치
    const sameName = ref.name.trim() === name
      || ref.name.trim().includes(name)
      || name.includes(ref.name.trim());
    const sameAddr = addr && ref.addr &&
      addr.substring(0, 10) === (ref.addr || '').trim().substring(0, 10);
    if (sameName && sameAddr) return true;

    // 2) 좌표 50m 이내
    if (store.lat && store.lng && ref.lat && ref.lng) {
      if (haversineM(store.lat, store.lng, ref.lat, ref.lng) <= 50) return true;
    }
    return false;
  });
}

// =====================================================
// API: 좌표 기반 매장 검색
// GET /api/stores?query=버터떡&lat=37.47&lng=126.95&radius=5000
// =====================================================
app.get('/api/stores', async (req, res) => {
  const { query, lat, lng, radius = 5000 } = req.query;
  if (!query) return res.status(400).json({ error: 'query 파라미터가 필요합니다.' });

  const x = parseFloat(lng) || 126.9784;
  const y = parseFloat(lat) || 37.5665;
  const rad = parseInt(radius);

  try {
    // 세 소스 병렬 조회
    const [kakaoRaw, naverRaw] = await Promise.all([
      searchKakao(query, x, y, rad),
      searchNaver(query, y, x),
    ]);
    const customRaw = searchCustomDB(query, y, x, rad);

    console.log(`✅ [${query}] 카카오 ${kakaoRaw.length} + 네이버 ${naverRaw.length} + DB ${customRaw.length}`);

    // ── 카카오 영업시간 병렬 조회 ──
    const kakaoStores = await Promise.all(
      kakaoRaw.map(async (item, index) => {
        const detail = await getPlaceDetail(item.id);
        return {
          id: index + 1,
          placeId: item.id,
          name: item.place_name,
          addr: item.road_address_name || item.address_name,
          phone: item.phone,
          category: item.category_name,
          kakaoUrl: item.place_url,
          naverUrl: null,
          lat: parseFloat(item.y),
          lng: parseFloat(item.x),
          hours: detail.hours || null,
          isOpen: detail.isOpen !== null ? detail.isOpen : null,
          source: 'kakao',
        };
      })
    );

    // ── 네이버: 카카오와 중복 제거 ──
    const naverUnique = naverRaw.filter(s => !isDuplicate(s, kakaoStores));
    const naverStores = naverUnique.map((s, i) => ({
      ...s, id: kakaoStores.length + i + 1,
    }));

    // ── DB: 카카오+네이버 모두와 중복 제거 ──
    const allSoFar = [...kakaoStores, ...naverStores];
    const customUnique = customRaw.filter(s => !isDuplicate(s, allSoFar));
    const customStores = customUnique.map((s, i) => ({
      ...s, id: allSoFar.length + i + 1,
    }));

    const stores = [...kakaoStores, ...naverStores, ...customStores];

    console.log(
      `📦 최종 ${stores.length}개 (카카오 ${kakaoStores.length} ` +
      `+ 네이버 ${naverStores.length} + DB ${customStores.length})`
    );

    res.json({ total: stores.length, stores });

  } catch (error) {
    console.error('오류:', error.response?.data || error.message);
    res.status(500).json({ error: '검색 중 오류가 발생했습니다.' });
  }
});

// =====================================================
// API: 주소 → 좌표 변환
// =====================================================
app.get('/api/geocode', async (req, res) => {
  const { query } = req.query;
  if (!query) return res.status(400).json({ error: 'query 필요' });

  try {
    const response = await axios.get('https://dapi.kakao.com/v2/local/search/address.json', {
      params: { query, size: 1 },
      headers: { Authorization: `KakaoAK ${KAKAO_REST_KEY}` },
    });
    const doc = response.data.documents?.[0];
    if (!doc) {
      const kwRes = await axios.get('https://dapi.kakao.com/v2/local/search/keyword.json', {
        params: { query, size: 1 },
        headers: { Authorization: `KakaoAK ${KAKAO_REST_KEY}` },
      });
      const kw = kwRes.data.documents?.[0];
      if (!kw) return res.status(404).json({ error: '위치를 찾을 수 없습니다.' });
      return res.json({ lat: parseFloat(kw.y), lng: parseFloat(kw.x), name: kw.place_name });
    }
    res.json({ lat: parseFloat(doc.y), lng: parseFloat(doc.x), name: query });
  } catch {
    res.status(500).json({ error: 'Geocoding 실패' });
  }
});

// =====================================================
// 관리자 API — 가게 등록 / 수정 / 삭제 / 목록
// 모든 요청에 ?pw=ADMIN_PASSWORD 필요
// =====================================================
function authAdmin(req, res, next) {
  const pw = req.query.pw || req.body?.pw;
  if (pw !== ADMIN_PASSWORD) return res.status(401).json({ error: '비밀번호가 틀렸습니다.' });
  next();
}

// 목록 조회
app.get('/api/admin/stores', authAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM custom_stores ORDER BY created_at DESC').all();
  res.json({ total: rows.length, stores: rows });
});

// 가게 등록
app.post('/api/admin/stores', authAdmin, (req, res) => {
  const { name, addr, phone, category, lat, lng, kakao_url, naver_url, query_tags, memo } = req.body;
  if (!name || !addr || !lat || !lng || !query_tags)
    return res.status(400).json({ error: 'name, addr, lat, lng, query_tags 필수' });

  const stmt = db.prepare(`
    INSERT INTO custom_stores (name, addr, phone, category, lat, lng, kakao_url, naver_url, query_tags, memo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(name, addr, phone || null, category || null, lat, lng, kakao_url || null, naver_url || null, query_tags, memo || null);
  res.json({ ok: true, id: info.lastInsertRowid });
});

// 가게 수정
app.put('/api/admin/stores/:id', authAdmin, (req, res) => {
  const { name, addr, phone, category, lat, lng, kakao_url, naver_url, query_tags, memo } = req.body;
  const stmt = db.prepare(`
    UPDATE custom_stores
    SET name=?, addr=?, phone=?, category=?, lat=?, lng=?, kakao_url=?, naver_url=?, query_tags=?, memo=?
    WHERE id=?
  `);
  stmt.run(name, addr, phone || null, category || null, lat, lng, kakao_url || null, naver_url || null, query_tags, memo || null, req.params.id);
  res.json({ ok: true });
});

// 가게 삭제
app.delete('/api/admin/stores/:id', authAdmin, (req, res) => {
  db.prepare('DELETE FROM custom_stores WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// 주소로 좌표 자동 조회 (관리 페이지용)
app.get('/api/admin/geocode', authAdmin, async (req, res) => {
  const { query } = req.query;
  if (!query) return res.status(400).json({ error: 'query 필요' });
  try {
    const response = await axios.get('https://dapi.kakao.com/v2/local/search/address.json', {
      params: { query, size: 1 },
      headers: { Authorization: `KakaoAK ${KAKAO_REST_KEY}` },
    });
    const doc = response.data.documents?.[0];
    if (!doc) {
      const kwRes = await axios.get('https://dapi.kakao.com/v2/local/search/keyword.json', {
        params: { query, size: 1 },
        headers: { Authorization: `KakaoAK ${KAKAO_REST_KEY}` },
      });
      const kw = kwRes.data.documents?.[0];
      if (!kw) return res.status(404).json({ error: '주소를 찾을 수 없습니다.' });
      return res.json({ lat: parseFloat(kw.y), lng: parseFloat(kw.x) });
    }
    res.json({ lat: parseFloat(doc.y), lng: parseFloat(doc.x) });
  } catch {
    res.status(500).json({ error: 'Geocoding 실패' });
  }
});

// =====================================================
// 정적 파일 서빙
// =====================================================
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`\n🗺️  트렌디맵 서버 시작!`);
  console.log(`👉 브라우저에서 열기: http://localhost:${PORT}`);
  console.log(`🔧 관리 페이지: http://localhost:${PORT}/admin.html\n`);
});