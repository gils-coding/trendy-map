// =====================================================
// 트렌디맵 백엔드 서버
// - 카카오 로컬 API → 좌표 기반 매장 검색 + 영업시간
// =====================================================

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// ✅ 카카오 REST API 키
const KAKAO_REST_KEY = process.env.KAKAO_REST_KEY || ''; // ← 입력

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
    const rawItems = await searchKakao(query, x, y, parseInt(radius));

    console.log(`✅ [${query}] 좌표(${y.toFixed(4)}, ${x.toFixed(4)}) 반경${radius}m → ${rawItems.length}개`);

    // 영업시간 병렬 조회
    const stores = await Promise.all(
      rawItems.map(async (item, index) => {
        const detail = await getPlaceDetail(item.id);
        return {
          id: index + 1,
          placeId: item.id,
          name: item.place_name,
          addr: item.road_address_name || item.address_name,
          phone: item.phone,
          category: item.category_name,
          kakaoUrl: item.place_url,
          lat: parseFloat(item.y),
          lng: parseFloat(item.x),
          hours: detail.hours || null,
          isOpen: detail.isOpen ?? null,
        };
      })
    );

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🗺️  트렌디맵 서버 시작!`);
  console.log(`👉 브라우저에서 열기: http://localhost:${PORT}\n`);
});
