// =====================================================
// 트렌디맵 백엔드 서버
// - 카카오 로컬 API → 좌표 기반 매장 검색 + 영업시간
// =====================================================

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST'],
}));
app.use(express.json());

// ✅ 카카오 REST API 키
const KAKAO_REST_KEY = process.env.KAKAO_REST_KEY || '';

// ✅ 네이버 검색 API 키
const NAVER_CLIENT_ID = process.env.NAVER_CLIENT_ID || '';
const NAVER_CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET || '';

// =====================================================
// 카카오 로컬 키워드 검색
// x, y: 중심 좌표 / radius: 검색 반경(m)
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

  // 중복 제거
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

    const items = res.data.items || [];
    return items.map(item => ({
      name: item.title.replace(/<[^>]+>/g, ''),   // HTML 태그 제거
      addr: item.roadAddress || item.address,
      phone: item.telephone || null,
      category: item.category || null,
      // 네이버 좌표는 카텍(KATEC) → WGS84 변환 필요
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

// 네이버 좌표계(KATEC) → WGS84 변환
function katecToWgs84(mapy, mapx) {
  // 네이버 local API는 소수점 7자리 정수로 줌 (e.g. 374708810 → 37.4708810)
  return {
    lat: mapy / 1e7,
    lng: mapx / 1e7,
  };
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
// API: 좌표 기반 매장 검색
// GET /api/stores?query=두바이쫀득쿠키&lat=37.47&lng=126.95&radius=5000
// =====================================================
app.get('/api/stores', async (req, res) => {
  const { query, lat, lng, radius = 5000 } = req.query;
  if (!query) return res.status(400).json({ error: 'query 파라미터가 필요합니다.' });

  // 좌표 없으면 서울 시청 기본값
  const x = parseFloat(lng) || 126.9784;
  const y = parseFloat(lat) || 37.5665;

  try {
    // 카카오 + 네이버 병렬 검색
    const [kakaoRaw, naverRaw] = await Promise.all([
      searchKakao(query, x, y, parseInt(radius)),
      searchNaver(query, y, x),
    ]);

    console.log(`✅ [${query}] 카카오 ${kakaoRaw.length}개 + 네이버 ${naverRaw.length}개`);

    // 카카오 결과 영업시간 병렬 조회
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

    // 네이버 결과 중복 제거 (카카오에 이미 있는 매장 제외 - 이름 기준)
    const kakaoNames = new Set(kakaoStores.map(s => s.name.trim()));
    const naverUnique = naverRaw.filter(s => {
      const name = s.name.trim();
      // 이름이 완전히 같거나 카카오 결과에 포함되면 제외
      return !kakaoNames.has(name) && ![...kakaoNames].some(k => k.includes(name) || name.includes(k));
    });

    // 네이버 결과에 id 부여 후 합치기
    const naverStores = naverUnique.map((s, i) => ({ ...s, id: kakaoStores.length + i + 1 }));
    const stores = [...kakaoStores, ...naverStores];

    console.log(`📦 최종 ${stores.length}개 (카카오 ${kakaoStores.length} + 네이버 신규 ${naverStores.length})`);

    res.json({ total: stores.length, stores });

  } catch (error) {
    console.error('오류:', error.response?.data || error.message);
    res.status(500).json({ error: '검색 중 오류가 발생했습니다.' });
  }
});

// =====================================================
// API: 주소 → 좌표 변환 (시군구 검색용)
// GET /api/geocode?query=서울시 관악구
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
      // 주소 검색 실패 시 키워드 검색으로 재시도
      const kwRes = await axios.get('https://dapi.kakao.com/v2/local/search/keyword.json', {
        params: { query, size: 1 },
        headers: { Authorization: `KakaoAK ${KAKAO_REST_KEY}` },
      });
      const kw = kwRes.data.documents?.[0];
      if (!kw) return res.status(404).json({ error: '위치를 찾을 수 없습니다.' });
      return res.json({ lat: parseFloat(kw.y), lng: parseFloat(kw.x), name: kw.place_name });
    }

    res.json({ lat: parseFloat(doc.y), lng: parseFloat(doc.x), name: query });
  } catch (error) {
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
  console.log(`👉 브라우저에서 열기: http://localhost:${PORT}\n`);
});