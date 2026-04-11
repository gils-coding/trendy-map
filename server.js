// =====================================================
// 트렌디맵 백엔드 서버
// - 카카오 로컬 API → 좌표 기반 매장 검색 + 영업시간
// - 네이버 지역검색 API
// - PostgreSQL 직접 등록 DB
// =====================================================

if (process.env.NODE_ENV !== 'production') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE'] }));
app.use(express.json());

// =====================================================
// PostgreSQL 연결
// =====================================================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway.internal')
    ? false
    : { rejectUnauthorized: false },
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS custom_stores (
      id          SERIAL PRIMARY KEY,
      name        TEXT    NOT NULL,
      addr        TEXT    NOT NULL,
      phone       TEXT,
      category    TEXT,
      lat         DOUBLE PRECISION NOT NULL,
      lng         DOUBLE PRECISION NOT NULL,
      kakao_url   TEXT,
      naver_url   TEXT,
      query_tags  TEXT    NOT NULL,
      memo        TEXT,
      created_at  TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS store_suggestions (
      id          SERIAL PRIMARY KEY,
      category    TEXT NOT NULL,
      name        TEXT NOT NULL,
      region      TEXT NOT NULL,
      addr        TEXT,
      memo        TEXT,
      status      TEXT DEFAULT 'pending',
      created_at  TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS food_suggestions (
      id          SERIAL PRIMARY KEY,
      food_name   TEXT NOT NULL,
      reason      TEXT,
      sns_link    TEXT,
      contact     TEXT,
      status      TEXT DEFAULT 'pending',
      created_at  TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('✅ PostgreSQL 테이블 준비 완료');
}

// =====================================================
// API 키
// =====================================================
const KAKAO_REST_KEY = process.env.KAKAO_REST_KEY || '';
const NAVER_CLIENT_ID = process.env.NAVER_CLIENT_ID || '';
const NAVER_CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  console.error('⚠️  ADMIN_PASSWORD 환경변수가 설정되지 않았습니다. 서버를 종료합니다.');
  process.exit(1);
}

// =====================================================
// 유틸: Haversine 거리(m)
// =====================================================
function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
    * Math.sin(dLng / 2) ** 2;
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
// 네이버 지역검색 공개 API (fallback용)
// =====================================================
async function searchNaverOpen(query, lat, lng, radius = 10000) {
  if (!NAVER_CLIENT_ID || !NAVER_CLIENT_SECRET) return [];
  const results = [];
  const headers = {
    'X-Naver-Client-Id': NAVER_CLIENT_ID,
    'X-Naver-Client-Secret': NAVER_CLIENT_SECRET,
  };
  for (let start = 1; start <= 96; start += 5) {
    try {
      const res = await axios.get('https://openapi.naver.com/v1/search/local.json', {
        params: { query, display: 5, start, sort: 'comment' },
        headers,
        timeout: 5000,
      });
      const items = res.data.items || [];
      if (items.length === 0) break;
      results.push(...items);
      if (items.length < 5) break;
    } catch (err) {
      console.error('네이버 공개 API 오류:', err.response?.data || err.message);
      break;
    }
  }
  const mapped = results.map(item => ({
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
  return mapped.filter(s => haversineM(lat, lng, s.lat, s.lng) <= radius);
}

// =====================================================
// 네이버 지도 내부 API (map.naver.com) — 실제 지도 앱과 동일한 결과
// =====================================================
async function searchNaverMaps(query, lat, lng, radius = 5000) {
  const results = [];
  const searchCoord = `${lng};${lat}`;

  // 반경(m)으로 뷰포트 bounding box 계산 → boundary 파라미터로 전달
  const deltaLat = radius / 111320;
  const deltaLng = radius / (111320 * Math.cos(lat * Math.PI / 180));
  const boundary = `${(lng - deltaLng).toFixed(6)},${(lat - deltaLat).toFixed(6)},${(lng + deltaLng).toFixed(6)},${(lat + deltaLat).toFixed(6)}`;

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'ko-KR,ko;q=0.8,en-US;q=0.6,en;q=0.4',
    'Referer': `https://map.naver.com/p/search/${encodeURIComponent(query)}`,
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
  };

  for (let page = 1; page <= 10; page++) {
    try {
      const res = await axios.get('https://map.naver.com/p/api/search/allSearch', {
        params: { query, type: 'all', searchCoord, boundary, sscode: 'svc.mapv5.search', page },
        headers,
        timeout: 8000,
      });
      const place = res.data?.result?.place;
      if (!place?.list?.length) break;
      results.push(...place.list);
      if (results.length >= (place.totalCount || 0)) break;
    } catch (err) {
      console.error(`네이버 지도 내부 API 오류 (page ${page}):`, err.message);
      break;
    }
  }

  const mapped = results.map(item => ({
    name: item.name,
    addr: item.roadAddress || item.address,
    phone: item.tel || null,
    category: item.category ? item.category.join(', ') : null,
    lat: parseFloat(item.y),
    lng: parseFloat(item.x),
    naverUrl: `https://map.naver.com/p/entry/place/${item.id}`,
    kakaoUrl: null,
    hours: item.bizhourInfo || null,
    isOpen: item.businessStatus?.status?.code === 2 ? true
          : item.businessStatus?.status?.code === 3 ? false : null,
    source: 'naver',
  }));

  // boundary 파라미터가 무시되므로 반경 내 결과만 직접 필터링
  const filtered = mapped.filter(s => haversineM(lat, lng, s.lat, s.lng) <= radius);
  console.log(`🔍 네이버 원본 ${mapped.length}개 → 반경 ${radius}m 필터 후 ${filtered.length}개`);
  return filtered;
}

// 좌표로 시/구 이름 추출 (카카오 역지오코딩)
async function getRegionName(lat, lng) {
  try {
    const res = await axios.get('https://dapi.kakao.com/v2/local/geo/coord2regioncode.json', {
      params: { x: lng, y: lat },
      headers: { Authorization: `KakaoAK ${KAKAO_REST_KEY}` },
      timeout: 3000,
    });
    const doc = res.data.documents?.find(d => d.region_type === 'H') || res.data.documents?.[0];
    if (!doc) return '';
    // "광주광역시 서구" 형태로 반환 (시 + 구)
    return [doc.region_1depth_name, doc.region_2depth_name].filter(Boolean).join(' ');
  } catch {
    return '';
  }
}

// 내부 API 먼저 시도, 실패 시 공개 API fallback
async function searchNaver(query, lat, lng, radius = 5000) {
  const mapsResult = await searchNaverMaps(query, lat, lng, radius);
  if (mapsResult.length > 0) {
    console.log(`✅ 네이버 지도 내부 API: ${mapsResult.length}개`);
    return mapsResult;
  }
  console.log('⚠️ 네이버 지도 내부 API 실패 → 공개 API fallback');
  return searchNaverOpen(query, lat, lng, radius);
}

function katecToWgs84(mapy, mapx) {
  return { lat: mapy / 1e7, lng: mapx / 1e7 };
}

// =====================================================
// PostgreSQL 커스텀 DB 검색
// =====================================================
async function searchCustomDB(query, lat, lng, radius) {
  const result = await pool.query(
    `SELECT * FROM custom_stores WHERE ',' || query_tags || ',' LIKE $1`,
    [`%,${query},%`]
  );
  // 반경 내 매장만 표시, 가까운 순 정렬
  return result.rows
    .map(row => ({
      name: row.name,
      addr: row.addr,
      phone: row.phone || null,
      category: row.category || null,
      lat: parseFloat(row.lat),
      lng: parseFloat(row.lng),
      kakaoUrl: row.kakao_url || null,
      naverUrl: row.naver_url || null,
      hours: null,
      isOpen: null,
      source: 'custom',
      memo: row.memo || null,
      _dist: haversineM(lat, lng, parseFloat(row.lat), parseFloat(row.lng)),
    }))
    .filter(s => s._dist <= radius)
    .sort((a, b) => a._dist - b._dist)
    .map(({ _dist, ...store }) => store);
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
// 중복 제거: 이름+주소 유사 OR 좌표 50m 이내
// =====================================================
function isDuplicate(store, referenceList) {
  const name = store.name.trim();
  const addr = (store.addr || '').trim();
  return referenceList.some(ref => {
    const sameName = ref.name.trim() === name
      || ref.name.trim().includes(name)
      || name.includes(ref.name.trim());
    const sameAddr = addr && ref.addr &&
      addr.substring(0, 10) === (ref.addr || '').trim().substring(0, 10);
    if (sameName && sameAddr) return true;
    if (store.lat && store.lng && ref.lat && ref.lng) {
      if (haversineM(store.lat, store.lng, ref.lat, ref.lng) <= 50) return true;
    }
    return false;
  });
}

// =====================================================
// API: 프론트엔드 설정 (Naver Maps 키 등)
// =====================================================
const NAVER_MAP_CLIENT_ID = process.env.NAVER_MAP_CLIENT_ID || '';
app.get('/api/config', (req, res) => {
  res.json({ naverMapClientId: NAVER_MAP_CLIENT_ID });
});

// =====================================================
// API: 좌표 기반 매장 검색
// =====================================================
app.get('/api/stores', async (req, res) => {
  const { query, lat, lng, radius = 5000 } = req.query;
  if (!query) return res.status(400).json({ error: 'query 파라미터가 필요합니다.' });

  const x = parseFloat(lng) || 126.9784;
  const y = parseFloat(lat) || 37.5665;
  const rad = parseInt(radius);

  try {
    // 지역명을 네이버 검색어에 포함시켜 로컬 결과 우선 확보
    const regionName = await getRegionName(y, x);
    const naverQuery = regionName ? `${regionName} ${query}` : query;
    console.log(`🌍 지역명: "${regionName}" → 네이버 검색어: "${naverQuery}"`);

    const [kakaoRaw, naverRaw, customRaw] = await Promise.all([
      searchKakao(query, x, y, rad),
      searchNaver(naverQuery, y, x, rad),
      searchCustomDB(query, y, x, rad),
    ]);

    console.log(`✅ [${query}] 카카오 ${kakaoRaw.length} + 네이버 ${naverRaw.length} + DB ${customRaw.length}`);

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

    const naverUnique = naverRaw.filter(s => !isDuplicate(s, kakaoStores));
    const naverStores = naverUnique.map((s, i) => ({ ...s, id: kakaoStores.length + i + 1 }));

    const allSoFar = [...kakaoStores, ...naverStores];
    const customUnique = customRaw.filter(s => !isDuplicate(s, allSoFar));
    const customStores = customUnique.map((s, i) => ({ ...s, id: allSoFar.length + i + 1 }));

    const stores = [...kakaoStores, ...naverStores, ...customStores]
      .sort((a, b) => haversineM(y, x, a.lat, a.lng) - haversineM(y, x, b.lat, b.lng));
    console.log(`📦 최종 ${stores.length}개 (카카오 ${kakaoStores.length} + 네이버 ${naverStores.length} + DB ${customStores.length})`);

    res.json({ total: stores.length, stores });
  } catch (error) {
    console.error('오류:', error.response?.data || error.message);
    res.status(500).json({ error: '검색 중 오류가 발생했습니다.' });
  }
});

// =====================================================
// API: 디버그 — 각 소스별 원본 결과 확인
// =====================================================
app.get('/api/debug-search', async (req, res) => {
  const { query = '버터떡', lat = 35.1595, lng = 126.8526, radius = 10000 } = req.query;
  const x = parseFloat(lng), y = parseFloat(lat), rad = parseInt(radius);
  const [kakaoRaw, naverRaw, customRaw] = await Promise.all([
    searchKakao(query, x, y, rad).catch(e => ({ error: e.message })),
    searchNaver(query, y, x, rad).catch(e => ({ error: e.message })),
    searchCustomDB(query, y, x, rad).catch(e => ({ error: e.message })),
  ]);
  res.json({
    query, lat: y, lng: x, radius: rad,
    kakao: { count: Array.isArray(kakaoRaw) ? kakaoRaw.length : 0, data: kakaoRaw },
    naver: { count: Array.isArray(naverRaw) ? naverRaw.length : 0, data: naverRaw },
    custom: { count: Array.isArray(customRaw) ? customRaw.length : 0, data: customRaw },
  });
});

// =====================================================
// API: 매장명 전국 검색
// =====================================================
app.get('/api/store-search', async (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Surrogate-Control', 'no-store');

  const { category, keyword } = req.query;
  const kw = (keyword || '').trim();
  if (!kw) return res.json({ total: 0, stores: [] });

  try {
    const headers = { Authorization: `KakaoAK ${KAKAO_REST_KEY}` };

    const kwClean = category
      ? kw.split(/\s+/).filter(w => !category.includes(w) && !w.includes(category)).join(' ').trim()
      : kw;

    const kakaoResults = [];

    for (let page = 1; page <= 2; page++) {
      try {
        const r = await axios.get('https://dapi.kakao.com/v2/local/search/keyword.json', {
          params: { query: kw, size: 15, page, sort: 'accuracy' },
          headers,
        });
        kakaoResults.push(...(r.data.documents || []));
        if (r.data.meta.is_end) break;
      } catch (e) { break; }
    }

    if (category && kwClean) {
      for (let page = 1; page <= 2; page++) {
        try {
          const r = await axios.get('https://dapi.kakao.com/v2/local/search/keyword.json', {
            params: { query: `${category} ${kwClean}`, size: 15, page, sort: 'accuracy' },
            headers,
          });
          kakaoResults.push(...(r.data.documents || []));
          if (r.data.meta.is_end) break;
        } catch (e) { break; }
      }
    }

    const seenKakao = new Set();
    const kakaoUnique = kakaoResults.filter(s => {
      if (seenKakao.has(s.id)) return false;
      seenKakao.add(s.id);
      return true;
    });

    const kakaoStores = kakaoUnique.map(s => ({
      name: s.place_name,
      addr: s.road_address_name || s.address_name,
      phone: s.phone || null,
      category: s.category_name || null,
      lat: parseFloat(s.y),
      lng: parseFloat(s.x),
      kakaoUrl: s.place_url || null,
      source: 'kakao',
    }));

    const kwLower = kw.toLowerCase();
    let dbStores = [];
    try {
      const dbResult = await pool.query(
        `SELECT * FROM custom_stores WHERE LOWER(name) LIKE $1 OR LOWER(addr) LIKE $1 LIMIT 30`,
        [`%${kwLower}%`]
      );
      dbStores = dbResult.rows.map(row => ({
        name: row.name,
        addr: row.addr,
        phone: row.phone || null,
        category: row.category || null,
        lat: parseFloat(row.lat),
        lng: parseFloat(row.lng),
        kakaoUrl: row.kakao_url || null,
        naverUrl: row.naver_url || null,
        source: 'custom',
      }));
    } catch (dbErr) {
      console.error('DB 검색 오류:', dbErr.message);
    }

    const dbUnique = dbStores.filter(d => !isDuplicate(d, kakaoStores));
    const allStores = [...kakaoStores, ...dbUnique];

    function relevanceScore(store) {
      let score = 0;
      const name = (store.name || '').toLowerCase();
      const cat = (store.category || '').toLowerCase();
      const cat_kw = (category || '').toLowerCase();
      const kw_lower = kw.toLowerCase();
      if (store.source === 'custom') score += 100;
      if (name.includes(kw_lower)) score += 50;
      if (cat_kw && (name.includes(cat_kw) || cat.includes(cat_kw))) score += 30;
      return score;
    }

    allStores.sort((a, b) => relevanceScore(b) - relevanceScore(a));
    const stores = allStores.slice(0, 30);

    console.log(`🔍 매장명검색 [${kw}] 카카오 ${kakaoStores.length} + DB ${dbUnique.length}`);
    res.json({ total: stores.length, stores });

  } catch (err) {
    console.error('매장명 검색 오류:', err.message);
    res.status(500).json({ error: '검색 중 오류 발생' });
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
// API: 매장 제안
// =====================================================
app.post('/api/suggest', async (req, res) => {
  const { category, name, region, addr, memo } = req.body;
  if (!category || !name || !region)
    return res.status(400).json({ error: 'category, name, region 필수' });
  try {
    await pool.query(
      `INSERT INTO store_suggestions (category, name, region, addr, memo) VALUES ($1,$2,$3,$4,$5)`,
      [category, name, region, addr || null, memo || null]
    );
    console.log(`📬 매장 제안: [${category}] ${name} (${region})`);
    res.json({ ok: true });
  } catch (err) {
    console.error('매장 제안 오류:', err.message);
    res.status(500).json({ error: '저장 중 오류 발생' });
  }
});

// =====================================================
// API: 유행 음식 제안
// =====================================================
app.post('/api/suggest-food', async (req, res) => {
  const { food_name, reason, sns_link, contact } = req.body;
  if (!food_name)
    return res.status(400).json({ error: 'food_name 필수' });
  try {
    await pool.query(
      `INSERT INTO food_suggestions (food_name, reason, sns_link, contact) VALUES ($1,$2,$3,$4)`,
      [food_name, reason || null, sns_link || null, contact || null]
    );
    console.log(`🍽️ 유행 음식 제안: ${food_name}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('음식 제안 오류:', err.message);
    res.status(500).json({ error: '저장 중 오류 발생' });
  }
});

app.get('/api/admin/food-suggestions', authAdmin, async (req, res) => {
  const result = await pool.query('SELECT * FROM food_suggestions ORDER BY created_at DESC');
  res.json({ total: result.rows.length, suggestions: result.rows });
});

app.put('/api/admin/food-suggestions/:id', authAdmin, async (req, res) => {
  await pool.query('UPDATE food_suggestions SET status=$1 WHERE id=$2', [req.body.status, req.params.id]);
  res.json({ ok: true });
});

app.delete('/api/admin/food-suggestions/:id', authAdmin, async (req, res) => {
  await pool.query('DELETE FROM food_suggestions WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// =====================================================
// 관리자 API
// =====================================================
function authAdmin(req, res, next) {
  const pw = req.query.pw || req.body?.pw;
  if (pw !== ADMIN_PASSWORD) return res.status(401).json({ error: '비밀번호가 틀렸습니다.' });
  next();
}

app.get('/api/admin/stores', authAdmin, async (req, res) => {
  const result = await pool.query('SELECT * FROM custom_stores ORDER BY created_at DESC');
  res.json({ total: result.rows.length, stores: result.rows });
});

app.post('/api/admin/stores', authAdmin, async (req, res) => {
  const { name, addr, phone, category, lat, lng, kakao_url, naver_url, query_tags, memo } = req.body;
  if (!name || !addr || !lat || !lng || !query_tags)
    return res.status(400).json({ error: 'name, addr, lat, lng, query_tags 필수' });
  const result = await pool.query(
    `INSERT INTO custom_stores (name,addr,phone,category,lat,lng,kakao_url,naver_url,query_tags,memo)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [name, addr, phone || null, category || null, lat, lng, kakao_url || null, naver_url || null, query_tags, memo || null]
  );
  res.json({ ok: true, id: result.rows[0].id });
});

app.put('/api/admin/stores/:id', authAdmin, async (req, res) => {
  const { name, addr, phone, category, lat, lng, kakao_url, naver_url, query_tags, memo } = req.body;
  await pool.query(
    `UPDATE custom_stores SET name=$1,addr=$2,phone=$3,category=$4,lat=$5,lng=$6,
     kakao_url=$7,naver_url=$8,query_tags=$9,memo=$10 WHERE id=$11`,
    [name, addr, phone || null, category || null, lat, lng, kakao_url || null, naver_url || null, query_tags, memo || null, req.params.id]
  );
  res.json({ ok: true });
});

app.delete('/api/admin/stores/:id', authAdmin, async (req, res) => {
  await pool.query('DELETE FROM custom_stores WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

app.get('/api/admin/suggestions', authAdmin, async (req, res) => {
  const result = await pool.query('SELECT * FROM store_suggestions ORDER BY created_at DESC');
  res.json({ total: result.rows.length, suggestions: result.rows });
});

app.put('/api/admin/suggestions/:id', authAdmin, async (req, res) => {
  await pool.query('UPDATE store_suggestions SET status=$1 WHERE id=$2', [req.body.status, req.params.id]);
  res.json({ ok: true });
});

app.delete('/api/admin/suggestions/:id', authAdmin, async (req, res) => {
  await pool.query('DELETE FROM store_suggestions WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

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

// =====================================================
// 서버 시작
// =====================================================
const PORT = process.env.PORT || 8080;
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🗺️  트렌디맵 서버 시작!`);
    console.log(`👉 http://localhost:${PORT}`);
    console.log(`🔧 관리 페이지: http://localhost:${PORT}/admin.html\n`);
  });
}).catch(err => {
  console.error('❌ DB 초기화 실패:', err.message);
  process.exit(1);
});