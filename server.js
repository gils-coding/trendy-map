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
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');

const app = express();
app.set('trust proxy', 1);
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE'] }));
app.use(express.json({ limit: '10mb' }));

// =====================================================
// Rate Limiting
// =====================================================
// 일반 API: 1분에 60회
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' },
});
// 관리자 API: 1분에 10회 (브루트포스 방지)
const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '너무 많은 시도가 감지되었습니다. 1분 후 다시 시도해주세요.' },
});
app.use('/api/stores', apiLimiter);
app.use('/api/store-search', apiLimiter);
app.use('/api/admin', adminLimiter);

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
  const seenTitles = new Set();
  for (let start = 1; start <= 96; start += 5) {
    try {
      const res = await axios.get('https://openapi.naver.com/v1/search/local.json', {
        params: { query, display: 5, start, sort: 'random' },
        headers,
        timeout: 5000,
      });
      const items = res.data.items || [];
      if (items.length === 0) break;
      // 이번 페이지가 이미 본 결과면 순환 반복 → 중단
      const newItems = items.filter(i => !seenTitles.has(i.title + i.address));
      if (newItems.length === 0) break;
      newItems.forEach(i => seenTitles.add(i.title + i.address));
      results.push(...newItems);
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

// =====================================================
// 네이버 플레이스 목록 API (pcmap.place.naver.com)
// allSearch에서 누락되는 메뉴 매칭 매장까지 커버
// =====================================================
async function searchNaverPlaceList(query, lat, lng, radius = 5000) {
  const results = [];
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
    'Referer': `https://pcmap.place.naver.com/restaurant/list?query=${encodeURIComponent(query)}&x=${lng}&y=${lat}`,
    'Origin': 'https://pcmap.place.naver.com',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
  };

  for (let start = 1; start <= 81; start += 20) {
    try {
      const res = await axios.get('https://pcmap.place.naver.com/place/list', {
        params: { query, x: lng, y: lat, display: 20, start, sort: 'distance' },
        headers,
        timeout: 8000,
      });
      const data = res.data;
      const contentType = res.headers['content-type'] || '';
      if (contentType.includes('text/html') || (typeof data === 'string' && data.trim().startsWith('<'))) {
        console.warn(`⚠️ pcmap HTML 반환 — 인증/차단 가능성. start=${start}`);
        break;
      }
      console.log(`🗺️ pcmap 응답 (start=${start}): ${JSON.stringify(data)?.slice(0, 200)}`);
      const list = Array.isArray(data?.list) ? data.list
        : Array.isArray(data?.result?.place?.list) ? data.result.place.list
        : Array.isArray(data) ? data : [];
      if (!list.length) break;
      results.push(...list);
      if (list.length < 20) break;
    } catch (err) {
      console.error(`pcmap 오류 (start ${start}):`, err.message);
      break;
    }
  }

  const mapped = results
    .map(item => ({
      name: item.name,
      addr: item.roadAddress || item.address || item.fullAddress || null,
      phone: item.tel || item.phone || null,
      category: Array.isArray(item.category) ? item.category.join(', ') : (item.category || null),
      lat: parseFloat(item.y || item.lat),
      lng: parseFloat(item.x || item.lng),
      naverUrl: item.id ? `https://map.naver.com/p/entry/place/${item.id}` : null,
      kakaoUrl: null,
      hours: item.bizhourInfo || null,
      isOpen: item.businessStatus?.status?.code === 2 ? true
            : item.businessStatus?.status?.code === 3 ? false : null,
      source: 'naver',
    }))
    .filter(s => s.name && !isNaN(s.lat) && !isNaN(s.lng));

  const filtered = mapped.filter(s => haversineM(lat, lng, s.lat, s.lng) <= radius);
  console.log(`🗺️  pcmap 원본 ${mapped.length}개 → 반경 ${radius}m 필터 후 ${filtered.length}개`);
  return filtered;
}

// allSearch + pcmap 병렬 실행 후 병합
async function searchNaver(query, lat, lng, radius = 5000) {
  const [allSearchResult, placeListResult] = await Promise.all([
    searchNaverMaps(query, lat, lng, radius).catch(e => { console.error('allSearch 실패:', e.message); return []; }),
    searchNaverPlaceList(query, lat, lng, radius).catch(e => { console.error('pcmap 실패:', e.message); return []; }),
  ]);

  const merged = [...allSearchResult];
  let added = 0;
  placeListResult.forEach(s => {
    if (!isDuplicate(s, merged)) { merged.push(s); added++; }
  });
  console.log(`✅ 네이버 통합: allSearch ${allSearchResult.length} + pcmap 신규 ${added}개 = ${merged.length}개`);

  if (merged.length > 0) return merged;

  console.log('⚠️ 네이버 API 모두 실패 → 공개 API fallback');
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
    // 지역 접두어 없이 순수 쿼리 + searchCoord/boundary로 로컬라이즈 (네이버 지도 프론트와 동일)
    console.log(`🔍 네이버 검색어: "${query}" (searchCoord: ${x};${y})`);

    const [naverRaw, customRaw] = await Promise.all([
      searchNaver(query, y, x, rad),
      searchCustomDB(query, y, x, rad),
    ]);

    console.log(`✅ [${query}] 네이버 ${naverRaw.length} + DB ${customRaw.length}`);

    const naverStores = naverRaw.map((s, i) => ({ ...s, id: i + 1 }));

    const customUnique = customRaw.filter(s => !isDuplicate(s, naverStores));
    const customStores = customUnique.map((s, i) => ({ ...s, id: naverStores.length + i + 1 }));

    const stores = [...naverStores, ...customStores]
      .sort((a, b) => haversineM(y, x, a.lat, a.lng) - haversineM(y, x, b.lat, b.lng));
    console.log(`📦 최종 ${stores.length}개 (네이버 ${naverStores.length} + DB ${customStores.length})`);

    res.json({ total: stores.length, stores });
  } catch (error) {
    console.error('오류:', error.response?.data || error.message);
    res.status(500).json({ error: '검색 중 오류가 발생했습니다.' });
  }
});

// =====================================================
// API: 디버그 — 개발 환경 전용
// =====================================================
if (process.env.NODE_ENV !== 'production') {
  app.get('/api/debug-search', async (req, res) => {
    const { query = '버터떡', lat = 35.1595, lng = 126.8526, radius = 10000 } = req.query;
    const x = parseFloat(lng), y = parseFloat(lat), rad = parseInt(radius);
    const [naverRaw, customRaw] = await Promise.all([
      searchNaver(query, y, x, rad).catch(e => ({ error: e.message })),
      searchCustomDB(query, y, x, rad).catch(e => ({ error: e.message })),
    ]);
    res.json({
      query, lat: y, lng: x, radius: rad,
      naver: { count: Array.isArray(naverRaw) ? naverRaw.length : 0, data: naverRaw },
      custom: { count: Array.isArray(customRaw) ? customRaw.length : 0, data: customRaw },
    });
  });
}

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
  const pw = req.query.pw || req.body?.pw || '';
  try {
    const valid = crypto.timingSafeEqual(
      Buffer.from(pw).subarray(0, Math.max(pw.length, ADMIN_PASSWORD.length)),
      Buffer.from(ADMIN_PASSWORD).subarray(0, Math.max(pw.length, ADMIN_PASSWORD.length))
    ) && pw.length === ADMIN_PASSWORD.length;
    if (!valid) return res.status(401).json({ error: '비밀번호가 틀렸습니다.' });
  } catch {
    return res.status(401).json({ error: '비밀번호가 틀렸습니다.' });
  }
  next();
}

app.get('/api/admin/stores', authAdmin, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = 50;
  const offset = (page - 1) * limit;
  const countResult = await pool.query('SELECT COUNT(*) FROM custom_stores');
  const total = parseInt(countResult.rows[0].count);
  const result = await pool.query('SELECT * FROM custom_stores ORDER BY created_at DESC LIMIT $1 OFFSET $2', [limit, offset]);
  res.json({ total, page, limit, pages: Math.ceil(total / limit), stores: result.rows });
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

// 이름+좌표 기준 중복 제거 (좌표 50m 이내 + 이름 동일 → id 낮은 것 유지)
app.post('/api/admin/dedup', authAdmin, async (_req, res) => {
  const result = await pool.query('SELECT id, name, lat, lng FROM custom_stores ORDER BY id ASC');
  const stores = result.rows;
  const toDelete = new Set();

  const normName = s => s.normalize('NFC').replace(/\s+/g, '').toLowerCase();
  for (let i = 0; i < stores.length; i++) {
    if (toDelete.has(stores[i].id)) continue;
    for (let j = i + 1; j < stores.length; j++) {
      if (toDelete.has(stores[j].id)) continue;
      if (normName(stores[i].name) !== normName(stores[j].name)) continue;
      const dlat = Number(stores[i].lat) - Number(stores[j].lat);
      const dlng = Number(stores[i].lng) - Number(stores[j].lng);
      const dist = Math.sqrt(dlat * dlat + dlng * dlng) * 111000;
      if (dist < 100) toDelete.add(stores[j].id);
    }
  }

  if (toDelete.size > 0) {
    await pool.query('DELETE FROM custom_stores WHERE id = ANY($1)', [Array.from(toDelete)]);
  }
  res.json({ ok: true, deleted: toDelete.size });
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

// 객체/배열에서 매장 목록처럼 생긴 배열을 재귀 탐색
function findPlaceArray(obj, depth = 0) {
  if (depth > 12) return null;
  if (Array.isArray(obj) && obj.length > 0) {
    const first = obj[0];
    if (first && typeof first === 'object' && first.name &&
        (first.x || first.y || first.lat || first.lng || first.roadAddress || first.address)) {
      return obj;
    }
  }
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const key of Object.keys(obj)) {
      const found = findPlaceArray(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

// 자동 수집용 카테고리 대표 키워드
const CATEGORY_KEYWORDS = {
  '버터떡': '버터떡', '두바이 쫀득쿠키': '두바이 쫀득쿠키',
  '소금빵': '소금빵', '탕후루': '탕후루', '크로플': '크로플', '마라탕': '마라탕',
};

// 전국 시군구 데이터
const SIGUNGU_SERVER = {
  '서울': ['강남구','강동구','강북구','강서구','관악구','광진구','구로구','금천구','노원구','도봉구','동대문구','동작구','마포구','서대문구','서초구','성동구','성북구','송파구','양천구','영등포구','용산구','은평구','종로구','중구','중랑구'],
  '경기': [
    // 구가 있는 대도시 → 구 단위로 세분화
    '수원시 장안구','수원시 권선구','수원시 팔달구','수원시 영통구',
    '성남시 수정구','성남시 중원구','성남시 분당구',
    '안양시 만안구','안양시 동안구',
    '안산시 단원구','안산시 상록구',
    '고양시 덕양구','고양시 일산동구','고양시 일산서구',
    '용인시 처인구','용인시 기흥구','용인시 수지구',
    // 구 없는 시/군
    '의정부시','부천시','광명시','평택시','동두천시','과천시','구리시','남양주시',
    '오산시','시흥시','군포시','의왕시','하남시','파주시','이천시','안성시',
    '김포시','화성시','광주시','양주시','포천시','여주시','연천군','가평군','양평군',
  ],
  '인천': ['중구','동구','미추홀구','연수구','남동구','부평구','계양구','서구','강화군','옹진군'],
  '부산': ['중구','서구','동구','영도구','부산진구','동래구','남구','북구','해운대구','사하구','금정구','강서구','연제구','수영구','사상구','기장군'],
  '대구': ['중구','동구','서구','남구','북구','수성구','달서구','달성군'],
  '대전': ['동구','중구','서구','유성구','대덕구'],
  '광주': ['동구','서구','남구','북구','광산구'],
  '울산': ['중구','남구','동구','북구','울주군'],
  '세종': ['세종시'],
  '강원': ['춘천시','원주시','강릉시','동해시','태백시','속초시','삼척시','홍천군','횡성군','영월군','평창군','정선군','철원군','화천군','양구군','인제군','고성군','양양군'],
  '충북': [
    '청주시 상당구','청주시 서원구','청주시 흥덕구','청주시 청원구',
    '충주시','제천시','보은군','옥천군','영동군','증평군','진천군','괴산군','음성군','단양군',
  ],
  '충남': [
    '천안시 동남구','천안시 서북구',
    '공주시','보령시','아산시','서산시','논산시','계룡시','당진시','금산군','부여군','서천군','청양군','홍성군','예산군','태안군',
  ],
  '전북': [
    '전주시 완산구','전주시 덕진구',
    '군산시','익산시','정읍시','남원시','김제시','완주군','진안군','무주군','장수군','임실군','순창군','고창군','부안군',
  ],
  '전남': ['목포시','여수시','순천시','나주시','광양시','담양군','곡성군','구례군','고흥군','보성군','화순군','장흥군','강진군','해남군','영암군','무안군','함평군','영광군','장성군','완도군','진도군','신안군'],
  '경북': [
    '포항시 남구','포항시 북구',
    '경주시','김천시','안동시','구미시','영주시','영천시','상주시','문경시','경산시','의성군','청송군','영양군','영덕군','청도군','고령군','성주군','칠곡군','예천군','봉화군','울진군','울릉군',
  ],
  '경남': [
    '창원시 의창구','창원시 성산구','창원시 마산합포구','창원시 마산회원구','창원시 진해구',
    '진주시','통영시','사천시','김해시','밀양시','거제시','양산시','의령군','함안군','창녕군','고성군','남해군','하동군','산청군','함양군','거창군','합천군',
  ],
  '제주': ['제주시','서귀포시'],
};

// 시도 → 주소 내 포함 문자열 (purge 시 지역 필터용)
const SIDO_ADDR = {
  '서울': '서울특별시', '경기': '경기도', '인천': '인천광역시',
  '부산': '부산광역시', '대구': '대구광역시', '대전': '대전광역시',
  '광주': '광주광역시', '울산': '울산광역시', '세종': '세종특별자치시',
  '강원': '강원', '충북': '충청북도', '충남': '충청남도',
  '전북': '전라북도', '전남': '전라남도', '경북': '경상북도', '경남': '경상남도',
  '제주': '제주특별자치도',
};

// 주소 → 좌표 (Kakao) — bulk-import + auto-collect 공용
async function geocodeAddress(query) {
  try {
    const r = await axios.get('https://dapi.kakao.com/v2/local/search/address.json', {
      params: { query, size: 1 },
      headers: { Authorization: `KakaoAK ${KAKAO_REST_KEY}` },
      timeout: 5000,
    });
    const doc = r.data.documents?.[0];
    if (doc) return { lat: parseFloat(doc.y), lng: parseFloat(doc.x) };
    const kw = await axios.get('https://dapi.kakao.com/v2/local/search/keyword.json', {
      params: { query, size: 1 },
      headers: { Authorization: `KakaoAK ${KAKAO_REST_KEY}` },
      timeout: 5000,
    });
    const kd = kw.data.documents?.[0];
    if (kd) return { lat: parseFloat(kd.y), lng: parseFloat(kd.x) };
  } catch {}
  return null;
}

// Naver pcmap list?query 페이지 가져오기
const _UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.4 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
];
const _REFERER_POOL = [
  'https://map.naver.com/',
  'https://map.naver.com/p/',
  'https://naver.com/',
  'https://search.naver.com/search.naver?query=',
];

async function fetchNaverPlaceList(query, x, y, cookie, start = 1) {
  const ua = _UA_POOL[Math.floor(Math.random() * _UA_POOL.length)];
  const referer = _REFERER_POOL[Math.floor(Math.random() * _REFERER_POOL.length)]
    + (Math.random() < 0.5 ? encodeURIComponent(query) : '');

  // clientX/Y에 미세한 랜덤 오프셋 추가 (실제 브라우저 뷰포트처럼)
  const jitterX = (Math.random() - 0.5) * 0.002;
  const jitterY = (Math.random() - 0.5) * 0.002;
  const bounds = `${(x - 0.05).toFixed(7)};${(y - 0.05).toFixed(7)};${(x + 0.05).toFixed(7)};${(y + 0.05).toFixed(7)}`;

  const params = new URLSearchParams({
    query, x: String(x), y: String(y),
    clientX: (x + jitterX).toFixed(7), clientY: (y + jitterY).toFixed(7),
    bounds, display: '70', start: String(start),
    ts: String(Date.now()),
    additionalHeight: String(70 + Math.floor(Math.random() * 20)), locale: 'ko',
    mapUrl: `https://map.naver.com/p/search/${encodeURIComponent(query)}`,
  });
  const headers = {
    'User-Agent': ua,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8',
    'Referer': referer,
    'sec-ch-ua': ua.includes('Chrome') ? `"Chromium";v="124", "Google Chrome";v="124"` : undefined,
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'cross-site',
  };
  if (cookie) headers['Cookie'] = cookie;
  const resp = await axios.get(`https://pcmap.place.naver.com/place/list?${params}`, {
    headers, timeout: 15000, maxRedirects: 5,
  });
  return typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
}

// HTML에서 window.__APOLLO_STATE__ 추출 (중괄호 균형 탐색)
function extractApolloState(html) {
  const marker = html.includes('window.__APOLLO_STATE__=')
    ? 'window.__APOLLO_STATE__='
    : 'window.__APOLLO_STATE__ =';
  const from = html.indexOf(marker);
  if (from === -1) return null;
  const braceStart = html.indexOf('{', from + marker.length);
  if (braceStart === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = braceStart; i < html.length; i++) {
    const c = html[i];
    if (esc) { esc = false; continue; }
    if (c === '\\' && inStr) { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { try { return JSON.parse(html.slice(braceStart, i + 1)); } catch { return null; } } }
  }
  return null;
}

// 네이버맵 JSON 일괄 등록
app.post('/api/admin/bulk-import', authAdmin, async (req, res) => {
  const { json, query_tags } = req.body;
  if (!json || !query_tags) return res.status(400).json({ error: 'json, query_tags 필수' });

  let raw;
  const jsonStr = typeof json === 'string' ? json.trim() : JSON.stringify(json);

  // HTML 입력 처리 — __APOLLO_STATE__ (pcmap) 또는 __NEXT_DATA__ 추출
  if (jsonStr.startsWith('<!') || jsonStr.startsWith('<html') || jsonStr.startsWith('<HTML')) {
    // 1) __APOLLO_STATE__ 시도 (pcmap SPA)
    const apolloMatch = jsonStr.match(/window\.__APOLLO_STATE__\s*=\s*(\{[\s\S]*?\});\s*(?:window\.|<\/script>)/);
    if (apolloMatch) {
      try {
        const apolloState = JSON.parse(apolloMatch[1]);
        // PlaceSummary:* 엔트리 전부 수집
        const places = Object.values(apolloState).filter(v => v && v.__typename === 'PlaceSummary' && v.name);
        if (places.length === 0) return res.status(400).json({ error: '__APOLLO_STATE__에서 PlaceSummary를 찾을 수 없습니다.' });
        // 좌표 없으므로 Kakao geocoding으로 보완
        const geocoded = [];
        for (const p of places) {
          const addr = p.roadAddress || p.fullAddress || p.address || null;
          if (!addr || !p.name) continue;
          let lat = null, lng = null;
          try {
            const gr = await axios.get('https://dapi.kakao.com/v2/local/search/address.json', {
              params: { query: addr, size: 1 },
              headers: { Authorization: `KakaoAK ${KAKAO_REST_KEY}` },
              timeout: 5000,
            });
            const doc = gr.data.documents?.[0];
            if (doc) { lat = parseFloat(doc.y); lng = parseFloat(doc.x); }
          } catch { /* geocoding 실패 시 스킵 */ }
          if (!lat || !lng) continue;
          geocoded.push({
            name: p.name,
            roadAddress: p.roadAddress || null,
            address: p.address || null,
            fullAddress: p.fullAddress || null,
            category: p.category || null,
            phone: p.virtualPhone || p.phone || null,
            id: p.id || null,
            y: String(lat), x: String(lng),
          });
        }
        raw = geocoded;
        // 이후 Array.isArray(raw) 분기에서 처리
      } catch (e) { return res.status(400).json({ error: '__APOLLO_STATE__ 파싱 실패: ' + e.message }); }
    } else {
      // 2) __NEXT_DATA__ 시도
      const nextMatch = jsonStr.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
      if (!nextMatch) return res.status(400).json({ error: 'HTML에서 __APOLLO_STATE__ 또는 __NEXT_DATA__를 찾을 수 없습니다.' });
      try { raw = JSON.parse(nextMatch[1]); } catch { return res.status(400).json({ error: '__NEXT_DATA__ JSON 파싱 실패' }); }
    }
  } else {
    try {
      raw = typeof json === 'string' ? JSON.parse(json) : json;
    } catch {
      return res.status(400).json({ error: 'JSON 파싱 실패 — 올바른 JSON인지 확인하세요.' });
    }
  }

  // 네이버맵 응답 구조에서 list 추출 (allSearch / pcmap / __NEXT_DATA__ / PlaceSummary raw JSON 모두 지원)
  // 키가 "PlaceSummary:ID" 형태인 raw JSON 감지
  const isPlaceSummaryFormat = !Array.isArray(raw) &&
    raw !== null && typeof raw === 'object' &&
    Object.keys(raw).some(k => k.startsWith('PlaceSummary:'));
  let list = [];
  if (isPlaceSummaryFormat) {
    list = Object.entries(raw)
      .filter(([k]) => k.startsWith('PlaceSummary:'))
      .map(([, v]) => v)
      .filter(v => v && v.name);
  } else if (Array.isArray(raw)) {
    list = raw;
  } else if (Array.isArray(raw?.result?.place?.list)) {
    list = raw.result.place.list;
  } else if (Array.isArray(raw?.place?.list)) {
    list = raw.place.list;
  } else if (Array.isArray(raw?.list)) {
    list = raw.list;
  } else {
    // __NEXT_DATA__ 등 중첩 구조에서 재귀 탐색
    const found = findPlaceArray(raw);
    if (found) { list = found; }
    else return res.status(400).json({ error: '매장 목록 배열을 찾을 수 없습니다. 올바른 Naver Place HTML 또는 JSON인지 확인하세요.' });
  }

  if (list.length === 0) return res.status(400).json({ error: '매장 목록이 비어있습니다.' });

  let inserted = 0, skipped = 0, errors = [];

  async function geocodeAddress(query) {
    try {
      const r = await axios.get('https://dapi.kakao.com/v2/local/search/address.json', {
        params: { query, size: 1 },
        headers: { Authorization: `KakaoAK ${KAKAO_REST_KEY}` },
      });
      const doc = r.data.documents?.[0];
      if (doc) return { lat: parseFloat(doc.y), lng: parseFloat(doc.x) };
      const kw = await axios.get('https://dapi.kakao.com/v2/local/search/keyword.json', {
        params: { query, size: 1 },
        headers: { Authorization: `KakaoAK ${KAKAO_REST_KEY}` },
      });
      const kd = kw.data.documents?.[0];
      if (kd) return { lat: parseFloat(kd.y), lng: parseFloat(kd.x) };
    } catch {}
    return null;
  }

  for (const item of list) {
    const name = item.name;
    // PlaceSummary는 fullAddress 우선, allSearch는 roadAddress 우선
    const addr = item.fullAddress || item.roadAddress || item.jibunAddress || item.address || null;

    if (!name || !addr) {
      errors.push(`스킵 (필드 누락): ${name || '이름없음'}`);
      skipped++;
      continue;
    }

    let lat = parseFloat(item.y ?? item.lat ?? item.mapy);
    let lng = parseFloat(item.x ?? item.lng ?? item.mapx);

    // 좌표 없으면 (PlaceSummary raw JSON 등) fullAddress로 지오코딩
    if (isNaN(lat) || isNaN(lng)) {
      const coords = await geocodeAddress(addr);
      if (!coords) {
        errors.push(`좌표 못 찾음 (스킵): ${name}`);
        skipped++;
        continue;
      }
      lat = coords.lat;
      lng = coords.lng;
    }

    // 중복 체크 (이름 + 주소)
    const dup = await pool.query(
      'SELECT id FROM custom_stores WHERE name=$1 AND addr=$2',
      [name, addr]
    );
    if (dup.rows.length > 0) {
      skipped++;
      continue;
    }

    const phone = item.phone || item.tel || null;
    const category = Array.isArray(item.category)
      ? item.category.join(', ')
      : (item.category || null);
    const naver_url = item.id ? `https://map.naver.com/p/entry/place/${item.id}` : null;

    await pool.query(
      `INSERT INTO custom_stores (name,addr,phone,category,lat,lng,kakao_url,naver_url,query_tags)
       VALUES ($1,$2,$3,$4,$5,$6,NULL,$7,$8)`,
      [name, addr, phone, category, lat, lng, naver_url, query_tags]
    );
    inserted++;
  }

  res.json({ ok: true, total: list.length, inserted, skipped, errors });
});

// 자동 수집 SSE 엔드포인트
app.get('/api/admin/auto-collect', authAdmin, async (req, res) => {
  const { sido, categories, cookie, query_tags, purge } = req.query;
  if (!sido || !SIGUNGU_SERVER[sido]) {
    return res.status(400).json({ error: '유효한 sido 필수' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let stopped = false;
  const keepAlive = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 25000);
  req.on('close', () => { stopped = true; clearInterval(keepAlive); });

  const send = (data) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`); };

  const districts = SIGUNGU_SERVER[sido];
  const catList = categories
    ? categories.split(',').map(s => s.trim()).filter(Boolean)
    : Object.keys(CATEGORY_KEYWORDS);

  send({ type: 'start', total: districts.length * catList.length, districts: districts.length, categories: catList.length });

  let totalInserted = 0, totalSkipped = 0;
  const foundNaverIds = new Set();

  for (const gu of districts) {
    if (stopped) break;

    const coords = await geocodeAddress(`${sido} ${gu}`);
    if (!coords) { send({ type: 'skip', district: gu, msg: '좌표 조회 실패' }); continue; }

    for (const cat of catList) {
      if (stopped) break;

      const keyword = CATEGORY_KEYWORDS[cat] || cat;
      const tags = catList.length === 1 && query_tags ? query_tags : cat;

      send({ type: 'fetching', district: gu, category: cat });

      try {
        // 최대 8페이지까지 페이지네이션 수집 — ID 중복 체크로 start 파라미터 미동작 시에도 안전
        const MAX_PAGES = 8;
        const PAGE_SIZE = 70;
        let allPlaces = [];
        const seenPageIds = new Set();
        let fetchError = null;

        for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
          if (stopped) break;
          const pageStart = (pageNum - 1) * PAGE_SIZE + 1;
          const html = await fetchNaverPlaceList(`${gu} ${keyword}`, coords.lng, coords.lat, cookie, pageStart);
          const apolloState = extractApolloState(html);
          if (!apolloState) {
            if (pageNum === 1) fetchError = '__APOLLO_STATE__ 없음 (차단됐거나 응답 구조 변경)';
            break;
          }
          const pagePlaces = Object.values(apolloState).filter(v => v && v.__typename === 'PlaceSummary' && v.name);
          // ID 중복 체크: start 파라미터 미동작 시 동일 결과 반복 방지
          const newPlaces = pagePlaces.filter(p => {
            if (!p.id || seenPageIds.has(p.id)) return false;
            seenPageIds.add(p.id);
            return true;
          });
          allPlaces.push(...newPlaces);
          if (newPlaces.length === 0 || pagePlaces.length < PAGE_SIZE) break;
          if (pageNum < MAX_PAGES) await new Promise(r => setTimeout(r, 800 + Math.random() * 700));
        }

        if (fetchError && allPlaces.length === 0) {
          send({ type: 'error', district: gu, category: cat, msg: fetchError });
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }

        const places = allPlaces;
        // 발견된 모든 place ID를 즉시 등록 (스킵되더라도 purge 대상에서 제외)
        for (const p of places) { if (p.id) foundNaverIds.add(String(p.id)); }

        let inserted = 0, skipped = 0;

        // 지오코딩 병렬 처리
        const geocoded = await Promise.all(
          places.map(async (p) => {
            const addr = p.roadAddress || p.fullAddress || p.address || null;
            if (!p.name || !addr) return null;
            const c = await geocodeAddress(addr).catch(() => null);
            if (!c) return null;
            return { p, addr, c };
          })
        );

        for (const item of geocoded) {
          if (!item) { skipped++; continue; }
          const { p, addr, c } = item;

          const dup = await pool.query(
            `SELECT id FROM custom_stores WHERE name=$1 AND (addr=$2 OR (
              lat BETWEEN $3-0.0005 AND $3+0.0005 AND lng BETWEEN $4-0.0005 AND $4+0.0005
            ))`,
            [p.name, addr, c.lat, c.lng]
          );
          if (dup.rows.length > 0) { skipped++; continue; }

          const phone = p.virtualPhone || p.phone || null;
          const category = Array.isArray(p.category) ? p.category.join(', ') : (p.category || null);
          const naver_url = p.id ? `https://map.naver.com/p/entry/place/${p.id}` : null;

          await pool.query(
            `INSERT INTO custom_stores (name,addr,phone,category,lat,lng,kakao_url,naver_url,query_tags) VALUES ($1,$2,$3,$4,$5,$6,NULL,$7,$8)`,
            [p.name, addr, phone, category, c.lat, c.lng, naver_url, tags]
          );
          inserted++;
        }

        totalInserted += inserted;
        totalSkipped += skipped;
        send({ type: 'result', district: gu, category: cat, found: places.length, inserted, skipped });
      } catch (e) {
        send({ type: 'error', district: gu, category: cat, msg: e.message });
      }

      // 1.5~3.5초 랜덤 딜레이 (봇 감지 우회)
      await new Promise(r => setTimeout(r, 1500 + Math.random() * 2000));
    }
  }

  clearInterval(keepAlive);

  let totalPurged = 0;
  if (purge === 'true' && !stopped) {
    const addrKeyword = SIDO_ADDR[sido] || sido;
    for (const cat of catList) {
      const existing = await pool.query(
        `SELECT id, naver_url FROM custom_stores WHERE query_tags ILIKE $1 AND naver_url IS NOT NULL AND addr LIKE $2`,
        [`%${cat}%`, `%${addrKeyword}%`]
      );
      const toDelete = existing.rows.filter(r => {
        const m = r.naver_url.match(/\/place\/(\d+)/);
        return m && !foundNaverIds.has(m[1]);
      });
      if (toDelete.length > 0) {
        await pool.query('DELETE FROM custom_stores WHERE id = ANY($1)', [toDelete.map(r => r.id)]);
        totalPurged += toDelete.length;
      }
    }
  }

  send({ type: 'done', totalInserted, totalSkipped, totalPurged });
  res.end();
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