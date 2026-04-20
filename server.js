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

app.delete('/api/admin/stores-by-category', authAdmin, async (req, res) => {
  const { category } = req.query;
  if (!category) return res.status(400).json({ error: 'category 필수' });
  const result = await pool.query(
    `DELETE FROM custom_stores WHERE query_tags ILIKE $1 OR category ILIKE $1`,
    [`%${category}%`]
  );
  res.json({ ok: true, deleted: result.rowCount });
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
  '소금빵': '소금빵', '탕후루': '탕후루',
};

// 버터떡·두바이는 PlaceSummary(/place/list), 소금빵·탕후루는 RestaurantListSummary(/restaurant/list)
const CATEGORY_ENDPOINT = {
  '버터떡': 'place',
  '두바이 쫀득쿠키': 'restaurant', '소금빵': 'restaurant', '탕후루': 'restaurant',
};

// 대도시 동 단위 데이터 (구 → 행정동 목록)
const DONG_BY_GU = {
  '서울': {
    '강남구': ['개포1동','개포2동','개포4동','논현1동','논현2동','대치1동','대치2동','대치4동','도곡1동','도곡2동','삼성1동','삼성2동','세곡동','수서동','신사동','압구정동','역삼1동','역삼2동','일원1동','일원2동','일원본동','자곡동','청담동'],
    '강동구': ['강일동','고덕1동','고덕2동','길1동','길2동','둔촌1동','둔촌2동','명일1동','명일2동','상일동','성내1동','성내2동','성내3동','암사1동','암사2동','암사3동','천호1동','천호2동','천호3동'],
    '강북구': ['번1동','번2동','번3동','수유1동','수유2동','수유3동','우이동','인수동','미아동','송중동','송천동','삼각산동','오패산동'],
    '강서구': ['가양1동','가양2동','가양3동','개화동','공항동','등촌1동','등촌2동','등촌3동','마곡동','방화1동','방화2동','방화3동','발산1동','염창동','우장산동','화곡1동','화곡2동','화곡3동','화곡4동','화곡본동'],
    '관악구': ['봉천동','청림동','행운동','낙성대동','청룡동','인헌동','남현동','신림동','신사동','조원동','대학동','중앙동','난곡동','난향동','삼성동','서원동','신원동'],
    '광진구': ['광장동','구의1동','구의2동','구의3동','군자동','능동','자양1동','자양2동','자양3동','자양4동','중곡1동','중곡2동','중곡3동','중곡4동','화양동'],
    '구로구': ['가리봉동','고척1동','고척2동','구로1동','구로2동','구로3동','구로4동','궁동','신도림동','오류1동','오류2동','온수동','천왕동','항동'],
    '금천구': ['가산동','독산1동','독산2동','독산3동','독산4동','시흥1동','시흥2동','시흥3동','시흥4동','시흥5동'],
    '노원구': ['공릉1동','공릉2동','광운동','노원동','상계1동','상계2동','상계3동','상계4동','상계5동','상계6동','상계7동','상계8동','상계9동','상계10동','월계1동','월계2동','월계3동','중계1동','중계2동','중계3동','중계4동','중계본동','하계1동','하계2동'],
    '도봉구': ['창1동','창2동','창3동','창4동','창5동','도봉1동','도봉2동','방학1동','방학2동','방학3동','쌍문1동','쌍문2동','쌍문3동','쌍문4동'],
    '동대문구': ['답십리1동','답십리2동','장안1동','장안2동','전농1동','전농2동','청량리동','회기동','휘경1동','휘경2동','이문1동','이문2동','용신동','제기동','신설동'],
    '동작구': ['노량진1동','노량진2동','대방동','동작동','본동','사당1동','사당2동','사당3동','사당4동','사당5동','상도1동','상도2동','상도3동','상도4동','신대방1동','신대방2동'],
    '마포구': ['공덕동','대흥동','도화동','망원1동','망원2동','상암동','서교동','성산1동','성산2동','신수동','아현동','연남동','염리동','용강동','합정동'],
    '서대문구': ['남가좌1동','남가좌2동','북가좌1동','북가좌2동','신촌동','연희동','천연동','충현동','홍제1동','홍제2동','홍제3동','홍은1동','홍은2동','북아현동'],
    '서초구': ['내곡동','반포1동','반포2동','반포3동','반포4동','반포본동','방배1동','방배2동','방배3동','방배본동','서초1동','서초2동','서초3동','서초4동','양재1동','양재2동','잠원동'],
    '성동구': ['금호1가동','금호2가3가동','금호4가동','마장동','사근동','성수1가1동','성수1가2동','성수2가1동','성수2가3동','송정동','옥수동','왕십리1동','왕십리2동','행당1동','행당2동'],
    '성북구': ['길음1동','길음2동','돈암1동','돈암2동','동선동','보문동','삼선동','석관동','성북동','월곡1동','월곡2동','장위1동','장위2동','장위3동','정릉1동','정릉2동','정릉3동','정릉4동','종암동'],
    '송파구': ['가락1동','가락2동','가락본동','거여1동','거여2동','마천1동','마천2동','방이1동','방이2동','삼전동','석촌동','송파1동','송파2동','신천동','위례동','잠실1동','잠실2동','잠실3동','잠실4동','잠실6동','잠실7동','잠실본동','장지동','풍납1동','풍납2동','오금동'],
    '양천구': ['목1동','목2동','목3동','목4동','목5동','신월1동','신월2동','신월3동','신월4동','신월5동','신월6동','신월7동','신정1동','신정2동','신정3동','신정4동','신정6동','신정7동'],
    '영등포구': ['당산1동','당산2동','대림1동','대림2동','대림3동','도림동','문래동','양평1동','양평2동','영등포동','여의동','신길1동','신길3동','신길4동','신길5동','신길6동','신길7동'],
    '용산구': ['원효로1동','원효로2동','효창동','용문동','한강로동','이촌1동','이촌2동','이태원1동','이태원2동','한남동','서빙고동','보광동','청파동'],
    '은평구': ['갈현1동','갈현2동','구산동','녹번동','대조동','불광1동','불광2동','수색동','신사동','역촌동','응암1동','응암2동','응암3동','증산동','진관동'],
    '종로구': ['가회동','교남동','무악동','부암동','사직동','삼청동','숭인1동','숭인2동','연건동','이화동','종로1234가동','종로56가동','창신1동','창신2동','창신3동','청운효자동','평창동','혜화동'],
    '중구': ['광희동','다산동','명동','을지로동','장충동','신당1동','신당2동','신당3동','신당4동','신당5동','신당6동','황학동','소공동','회현동'],
    '중랑구': ['면목1동','면목2동','면목3동','면목4동','면목5동','면목6동','면목7동','면목8동','상봉1동','상봉2동','신내1동','신내2동','중화1동','중화2동','묵1동','묵2동'],
  },
  '부산': {
    '중구': ['중앙동','동광동','대청동','보수동','부평동','광복동','남포동','영주동'],
    '서구': ['동대신1동','동대신2동','동대신3동','서대신1동','서대신3동','서대신4동','부민동','아미동','초장동','충무동','남부민1동','남부민2동','암남동'],
    '동구': ['초량1동','초량2동','초량3동','초량6동','수정1동','수정2동','수정3동','수정4동','수정5동','좌천1동','좌천3동','범일1동','범일2동','범일3동','범일5동'],
    '영도구': ['남항동','영선1동','영선2동','신선동','봉래1동','봉래2동','청학1동','청학2동','동삼1동','동삼2동','동삼3동'],
    '부산진구': ['부전1동','부전2동','연지동','초읍동','양정1동','양정2동','전포1동','전포2동','부암1동','부암2동','부암3동','가야1동','가야2동','개금1동','개금2동','개금3동'],
    '동래구': ['수민동','복산동','명장1동','명장2동','안락1동','안락2동','온천1동','온천2동','온천3동','온천4동','사직1동','사직2동','사직3동'],
    '남구': ['대연1동','대연2동','대연3동','대연4동','대연5동','대연6동','용호1동','용호2동','용호3동','용호4동','용당동','감만1동','감만2동','우암동','문현1동','문현2동','문현3동','문현4동'],
    '북구': ['구포1동','구포2동','구포3동','덕천1동','덕천2동','덕천3동','만덕1동','만덕2동','만덕3동','화명1동','화명2동','화명3동','금곡동','청천1동','청천2동'],
    '해운대구': ['우1동','우2동','우3동','좌1동','좌2동','좌3동','좌4동','중1동','중2동','중3동','중4동','반여1동','반여2동','반여3동','반여4동','반송1동','반송2동','석대동','재송1동','재송2동'],
    '사하구': ['괴정1동','괴정2동','괴정3동','괴정4동','당리동','하단1동','하단2동','신평1동','신평2동','구평동','감천1동','감천2동','다대1동','다대2동','장림1동','장림2동'],
    '금정구': ['서1동','서2동','서3동','부곡1동','부곡2동','부곡3동','부곡4동','청룡동','남산동','구서1동','구서2동','금사동','회동동','선두구동','두구동','오륜동'],
    '강서구': ['대저1동','대저2동','강동동','명지1동','명지2동','가락동','녹산동','가덕도동'],
    '연제구': ['거제1동','거제2동','거제3동','거제4동','연산1동','연산2동','연산3동','연산4동','연산5동','연산6동','연산9동'],
    '수영구': ['남천1동','남천2동','광안1동','광안2동','광안3동','광안4동','민락동','수영동','망미1동','망미2동'],
    '사상구': ['삼락동','모라1동','모라3동','덕포1동','덕포2동','괘법동','감전동','주례1동','주례2동','주례3동','학장동','엄궁동'],
    '기장군': ['기장읍','장안읍','정관읍','일광읍','철마면'],
  },
  '대구': {
    '중구': ['동인1가동','동인2가3가동','동인4가동','삼덕동','성내1동','성내2동','성내3동','남산1동','남산2동','남산3동','남산4동','대봉1동','대봉2동'],
    '동구': ['효목1동','효목2동','신암1동','신암2동','신암3동','신암4동','신암5동','동촌동','방촌동','해안동','공산동','율하동','신서동','혁신동','안심1동','안심2동','안심3동','안심4동'],
    '서구': ['평리1동','평리2동','평리3동','평리4동','평리5동','평리6동','내당1동','내당2동','내당3동','내당4동','비산1동','비산2동','비산3동','비산4동','비산5동','비산6동','비산7동'],
    '남구': ['이천동','봉덕1동','봉덕2동','봉덕3동','대명1동','대명2동','대명3동','대명4동','대명5동','대명6동','대명9동','대명10동','대명11동'],
    '북구': ['고성동','칠성동','산격1동','산격2동','산격3동','산격4동','대현동','검단동','침산1동','침산2동','침산3동','노원동','복현1동','복현2동','구암동','태전1동','태전2동','국우동','관음동','조야동'],
    '수성구': ['수성1가동','수성2가3가동','수성4가동','황금1동','황금2동','중동','범물1동','범물2동','파동','고산1동','고산2동','고산3동','시지동','사월동','신매동','매호동','성동'],
    '달서구': ['신당동','월성1동','월성2동','본리동','본동','유천1동','유천2동','두류1동','두류2동','두류3동','감삼동','죽전동','장기동','용산1동','용산2동','이곡1동','이곡2동','갈산동','도원동','진천동','상인1동','상인2동','상인3동','월암동','대천동'],
    '달성군': ['화원읍','논공읍','다사읍','옥포읍','현풍읍','가창면','하빈면','구지면'],
  },
  '인천': {
    '중구': ['운서동','운남동','운북동','을왕동','남북동','영종1동','영종2동','신흥동','답동','전동','중산동','항동'],
    '동구': ['화수1동','화수2동','화평동','창영동','금곡동','만석동','송현1동','송현2동'],
    '미추홀구': ['용현1동','용현2동','용현3동','용현4동','용현5동','학익1동','학익2동','주안1동','주안2동','주안3동','주안4동','주안5동','주안6동','주안7동','주안8동','도화1동','도화2동','도화3동','숭의1동','숭의2동','숭의3동','숭의4동'],
    '연수구': ['옥련1동','옥련2동','선학동','연수1동','연수2동','연수3동','청학동','동춘1동','동춘2동','동춘3동','송도1동','송도2동','송도3동'],
    '남동구': ['구월1동','구월2동','구월3동','구월4동','간석1동','간석2동','간석3동','간석4동','만수1동','만수2동','만수3동','만수4동','만수5동','만수6동','서창동','논현1동','논현2동','논현고잔동'],
    '부평구': ['부평1동','부평2동','부평3동','부평4동','부평5동','부평6동','부개1동','부개2동','부개3동','일신동','청천1동','청천2동','산곡1동','산곡2동','산곡3동','산곡4동','삼산1동','삼산2동','갈산1동','갈산2동'],
    '계양구': ['효성1동','효성2동','계산1동','계산2동','계산3동','계산4동','작전1동','작전2동','작전서운동','오류왕길동','귤현동','박촌동','병방동','평동'],
    '서구': ['검암경서동','연희동','청라1동','청라2동','청라3동','가정1동','가정2동','가정3동','석남1동','석남2동','석남3동','신현원창동','심곡동','오류동'],
    '강화군': ['강화읍','선원면','불은면','길상면','화도면','양도면','내가면','하점면','양사면','송해면','교동면','삼산면','서도면'],
    '옹진군': ['북도면','영흥면','자월면','덕적면','대청면','백령면','연평면'],
  },
  '광주': {
    '동구': ['충장동','지산1동','지산2동','산수1동','산수2동','서남동','학동','방림1동','방림2동','백운1동','백운2동','양림동','동명동'],
    '서구': ['양동','농성1동','농성2동','광천동','유덕동','치평동','상무1동','상무2동','화정1동','화정2동','화정3동','화정4동','서창동','풍암동','금호1동','금호2동'],
    '남구': ['양과동','봉선1동','봉선2동','주월1동','주월2동','진월동','효덕동','송암동','대촌동','월산4동','월산5동'],
    '북구': ['중흥1동','중흥2동','중흥3동','유동','임동','풍향동','문화동','오치1동','오치2동','신안동','우산동','동림동','건국동','두암1동','두암2동','두암3동','삼각동','일곡동','매곡동','용봉동','운암1동','운암2동','운암3동','신용동','각화동'],
    '광산구': ['송정1동','송정2동','도산동','신흥동','어룡동','우산동','월곡1동','월곡2동','비아동','첨단1동','첨단2동','신창동','동곡동','평동','삼도동','본량동','임곡동','하남동','수완동','흑석동','장덕동','운남동'],
  },
  '대전': {
    '동구': ['원동','성남동','인동','효동','판암1동','판암2동','신촌동','대동','가오동','용운동','중리동','홍도동','삼성1동','삼성2동','자양동','소제동'],
    '중구': ['은행동','선화동','목동','대흥동','문화동','오류동','태평1동','태평2동','유천1동','유천2동','중촌동','산성동'],
    '서구': ['둔산1동','둔산2동','둔산3동','갈마1동','갈마2동','월평1동','월평2동','월평3동','가수원동','도마1동','도마2동','변동','복수동','괴정동','내동','탄방동','삼천동','정림동','만년동','관저1동','관저2동','기성동'],
    '유성구': ['진잠동','온천1동','온천2동','노은1동','노은2동','노은3동','신성동','전민동','관평동','구즉동','반석동','원신흥동','장대동','갑동'],
    '대덕구': ['회덕동','목상동','법1동','법2동','송촌동','자운동','신탄진동','미호동','석봉동','중리동','오정동'],
  },
  '울산': {
    '중구': ['성안동','학성동','옥교동','남외동','태화동','다운동','유곡동','약사동','복산동','우정동'],
    '남구': ['신정1동','신정2동','신정3동','신정4동','신정5동','달동','삼산동','무거동','옥동','야음장생포동','선암동'],
    '동구': ['방어동','화정동','일산동','전하1동','전하2동','화봉동','서부동','동부동'],
    '북구': ['중산동','양정동','호계동','창평동','연암동','효문동','송정동','강동동'],
    '울주군': ['언양읍','온양읍','범서읍','청량읍','삼남읍','삼동면','두서면','두동면','상북면','중남면','서생면','온산읍'],
  },
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

async function fetchNaverPlaceList(query, x, y, cookie, start = 1, endpointType = 'place') {
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

  // 429 시 최대 3회 지수 백오프 재시도
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await axios.get(`https://pcmap.place.naver.com/${endpointType}/list?${params}`, {
        headers, timeout: 15000, maxRedirects: 5,
      });
      return typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
    } catch (err) {
      if (err.response?.status === 429 && attempt < 2) {
        const wait = (attempt + 1) * 8000 + Math.random() * 4000; // 8s, 16s
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
  }
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
  const { sido, categories, cookie, query_tags, purge, startIndex: startIdxStr } = req.query;
  if (!sido || (sido !== '전국' && !SIGUNGU_SERVER[sido])) {
    return res.status(400).json({ error: '유효한 sido 필수' });
  }
  const startIndex = Math.max(0, parseInt(startIdxStr) || 0);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let stopped = false;
  const keepAlive = setInterval(() => { if (!res.writableEnded) res.write('event: ping\ndata: {}\n\n'); }, 10000);
  req.on('close', () => { stopped = true; clearInterval(keepAlive); });

  const send = (data) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`); };

  const catList = categories
    ? categories.split(',').map(s => s.trim()).filter(Boolean)
    : Object.keys(CATEGORY_KEYWORDS);

  // 동 단위 확장: 대도시는 구→동 목록으로 펼침
  let searchUnits;
  if (sido === '전국') {
    searchUnits = Object.entries(SIGUNGU_SERVER).flatMap(([s, guList]) =>
      guList.flatMap(gu => {
        const dongList = DONG_BY_GU[s]?.[gu];
        if (dongList) return dongList.map(dong => ({ label: `${s} ${gu} ${dong}`, addr: `${s} ${gu} ${dong}` }));
        return [{ label: `${s} ${gu}`, addr: `${s} ${gu}` }];
      })
    );
  } else {
    const districts = SIGUNGU_SERVER[sido];
    searchUnits = districts.flatMap(gu => {
      const dongList = DONG_BY_GU[sido]?.[gu];
      if (dongList) return dongList.map(dong => ({ label: `${gu} ${dong}`, addr: `${sido} ${gu} ${dong}` }));
      return [{ label: gu, addr: `${sido} ${gu}` }];
    });
  }

  const unitsToProcess = searchUnits.slice(startIndex);
  send({ type: 'start', total: searchUnits.length * catList.length, startIndex, districts: unitsToProcess.length, categories: catList.length });

  let totalInserted = 0, totalSkipped = 0;
  const foundNaverIds = new Set();

  for (let ui = 0; ui < unitsToProcess.length; ui++) {
    const unit = unitsToProcess[ui];
    const absoluteUnitIdx = startIndex + ui;
    if (stopped) break;
    const gu = unit.label;

    const coords = await geocodeAddress(unit.addr);
    if (!coords) { send({ type: 'skip', district: gu, msg: '좌표 조회 실패' }); continue; }

    for (const cat of catList) {
      if (stopped) break;

      const keyword = CATEGORY_KEYWORDS[cat] || cat;
      const tags = catList.length === 1 && query_tags ? query_tags : cat;
      const endpointType = CATEGORY_ENDPOINT[cat] || 'place';
      const typename = endpointType === 'restaurant' ? 'RestaurantListSummary' : 'PlaceSummary';

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
          const html = await fetchNaverPlaceList(keyword, coords.lng, coords.lat, cookie, pageStart, endpointType);
          const apolloState = extractApolloState(html);
          if (!apolloState) {
            if (pageNum === 1) fetchError = '__APOLLO_STATE__ 없음 (차단됐거나 응답 구조 변경)';
            break;
          }
          const pagePlaces = Object.entries(apolloState)
            .filter(([, v]) =>
              v && typeof v === 'object' && v.__typename === typename &&
              v.name && typeof v.name === 'string' &&
              (v.roadAddress || v.address || v.fullAddress)
            )
            .map(([key, v]) => ({ ...v, id: v.id || key.split(':')[1] }));
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
        send({ type: 'result', district: gu, category: cat, found: places.length, inserted, skipped, unitIndex: absoluteUnitIdx });

        // 카테고리 간 딜레이 (429 방지)
        if (!stopped) await new Promise(r => setTimeout(r, 2000 + Math.random() * 2000));
      } catch (e) {
        send({ type: 'error', district: gu, category: cat, msg: e.message });
      }

      // 1.5~3.5초 랜덤 딜레이 (봇 감지 우회)
      await new Promise(r => setTimeout(r, 1500 + Math.random() * 2000));
    }
  }

  clearInterval(keepAlive);

  let totalPurged = 0;
  if (purge === 'true' && !stopped && startIndex === 0 && sido !== '전국') {
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