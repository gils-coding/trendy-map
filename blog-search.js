// =====================================================
// 네이버 블로그 맛집 조사 스크립트
// 사용법: node blog-search.js "서울 버터떡 맛집"
// =====================================================
require('dotenv').config();


const https = require('https');

// server.js와 동일하게 환경변수로 관리
// Railway 환경변수에 NAVER_CLIENT_ID, NAVER_CLIENT_SECRET 설정되어 있으면 자동 사용
// 로컬 실행 시: $env:NAVER_CLIENT_ID="키"; $env:NAVER_CLIENT_SECRET="시크릿"; node blog-search.js "검색어"
const NAVER_CLIENT_ID = process.env.NAVER_CLIENT_ID || '';
const NAVER_CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET || '';

const query = process.argv[2];
const showList = process.argv.includes('--list');

if (!query) {
  console.log('사용법: node blog-search.js "검색어" [--list]');
  console.log('예시:   node blog-search.js "서울 버터떡 맛집"');
  console.log('        node blog-search.js "잠실 버터떡" --list  ← 블로그 글 목록도 표시');
  process.exit(1);
}

async function fetchBlogPosts(query, start) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({ query, display: 100, start, sort: 'sim' });
    const options = {
      hostname: 'openapi.naver.com',
      path: `/v1/search/blog.json?${params}`,
      headers: {
        'X-Naver-Client-Id': NAVER_CLIENT_ID,
        'X-Naver-Client-Secret': NAVER_CLIENT_SECRET,
      },
    };
    https.get(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

function stripHtml(str) {
  return str.replace(/<[^>]+>/g, '').replace(/&[^;]+;/gi, ' ').trim();
}

// 제목+미리보기에서 매장명 후보 추출
function extractStoreNames(text) {
  const names = [];

  // 패턴 1: 한글+영문 고유명사 (2~12자) + 카페/베이커리/떡집 등 접미사
  const p1 = /([가-힣a-zA-Z0-9][가-힣a-zA-Z0-9 ]{0,10}(?:카페|베이커리|떡집|빵집|디저트|브레드|브런치|케이크|공방|마켓))/g;
  // 패턴 2: 접두사 + 고유명사
  const p2 = /(?:카페|베이커리|떡집|빵집)\s+([가-힣a-zA-Z0-9][가-힣a-zA-Z0-9]{1,10})/g;
  // 패턴 3: 대문자 시작 영문+한글 혼합 고유명사 (브랜드명 스타일)
  const p3 = /([A-Z][a-zA-Z]+[가-힣]*|[가-힣]+[A-Z][a-zA-Z가-힣]*)/g;

  for (const m of text.matchAll(p1)) names.push(m[1].trim());
  for (const m of text.matchAll(p2)) names.push(m[1].trim());
  for (const m of text.matchAll(p3)) {
    if (m[1].length >= 2 && m[1].length <= 15) names.push(m[1].trim());
  }

  return names;
}

// 불용어 (매장명이 아닌 것들)
const STOP_WORDS = new Set([
  '서울', '경기', '인천', '부산', '대구', '대전', '광주', '울산', '세종',
  '강남', '홍대', '잠실', '신촌', '이태원', '합정', '성수', '건대', '압구정',
  '여의도', '신림', '구로', '영등포', '종로', '마포', '용산', '송파', '강동',
  '수원', '성남', '분당', '일산', '안양', '부천',
  '오늘', '하루', '정말', '너무', '매장', '방문', '추천', '리뷰', '후기',
  '맛있', '먹었', '좋았', '강추', '이번', '우리', '여기', '저기', '같이',
  '함께', '진짜', '완전', '버터떡', '맛집', '카페', '베이커리', '디저트',
  'SNS', 'AI', '유행', '인기', '핫플', '요즘',
]);

// 지역명+카테고리 조합 패턴 (매장명 아님) — 예: "잠실디저트", "홍대카페", "SNS에서"
const LOCATION_CATEGORY_RE = /^(서울|경기|인천|강남|홍대|잠실|신촌|이태원|합정|성수|건대|압구정|여의도|신림|수원|분당|송파|강동|강서|마포|용산|종로|중구|유행|요즘|SNS|AI|인기|핫플)(디저트|카페|빵집|떡집|베이커리|마켓|브런치|맛집|케이크)?$/;

// 이 단어가 포함된 이름은 매장명이 아님 (부분 일치)
const NOISE_CONTAINS = [
  '월드몰', '백화점', '아울렛', '팝업', '홈플러스', '이마트', '코스트코',
  '롯데마트', '스타필드', '코엑스', '타임스퀘어', '더현대',
  '3월', '4월', '5월', '6월', '7월', '8월', '9월', '10월', '11월', '12월',
  '1월', '2월', '상하이', '두바이', '맛집투어', '후기',
  '에서', '리단길', '로수길', '디저트맛집', '몰', '카페거리', '디저트'
];

function isNoiseName(key) {
  if (STOP_WORDS.has(key)) return true;
  if (LOCATION_CATEGORY_RE.test(key)) return true;
  // 노이즈 단어가 키 안에 포함된 경우
  if (NOISE_CONTAINS.some(w => key.includes(w))) return true;
  // 순수 카테고리어만 있는 경우
  if (/^(디저트|카페|빵집|떡집|베이커리|마켓|브런치|케이크|공방|샵|스튜디오)+$/.test(key)) return true;
  return false;
}

async function main() {
  console.log(`\n🔍 "${query}" 블로그 검색 중...\n`);
  console.log('='.repeat(70));

  const allItems = [];
  for (let start = 1; start <= 901; start += 100) {
    try {
      const data = await fetchBlogPosts(query, start);
      if (!data.items?.length) break;
      allItems.push(...data.items);
      if (data.items.length < 100) break;
    } catch (e) {
      console.error('오류:', e.message);
      break;
    }
  }

  console.log(`총 ${allItems.length}개 글 수집\n`);

  // ── 매장명 집계 (띄어쓰기 무시하고 동일 매장 통합) ──
  const storeCount = {};   // 정규화된 키 → 카운트
  const storeLabel = {};   // 정규화된 키 → 가장 많이 쓰인 표기
  const storeLabelCount = {}; // 정규화된 키 → { 표기: 횟수 }
  const storeLinks = {};   // 정규화된 키 → 첫 번째 링크

  allItems.forEach(item => {
    const text = stripHtml(item.title + ' ' + item.description);
    const names = extractStoreNames(text);
    names.forEach(name => {
      if (name.length < 2 || name.length > 15) return;

      // 띄어쓰기 제거해서 정규화 키로 사용
      const key = name.replace(/\s+/g, '');
      if (isNoiseName(key)) return;

      storeCount[key] = (storeCount[key] || 0) + 1;
      if (!storeLinks[key]) storeLinks[key] = item.link;

      // 가장 많이 쓰인 표기 추적
      if (!storeLabelCount[key]) storeLabelCount[key] = {};
      storeLabelCount[key][name] = (storeLabelCount[key][name] || 0) + 1;
    });
  });

  // 각 키에서 가장 많이 쓰인 표기를 대표 이름으로
  Object.keys(storeCount).forEach(key => {
    storeLabel[key] = Object.entries(storeLabelCount[key])
      .sort((a, b) => b[1] - a[1])[0][0];
  });

  const ranking = Object.entries(storeCount)
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1]);

  if (ranking.length > 0) {
    console.log('🏆 자주 언급된 매장 (2회 이상)\n' + '='.repeat(70));
    ranking.forEach(([key, count], i) => {
      const name = storeLabel[key];
      console.log(`  ${String(i + 1).padStart(2, '0')}. ${name.padEnd(20)} ${count}회 언급`);
      console.log(`      🔗 ${storeLinks[key]}`);
    });
    console.log('='.repeat(70) + '\n');
  } else {
    console.log('⚠️  2회 이상 언급된 매장이 없습니다. 블로그 글을 직접 확인해보세요.\n');
  }

  // ── 블로그 글 목록 (--list 옵션 시에만 출력) ──
  if (showList) {
    console.log('\n📋 블로그 글 목록\n' + '='.repeat(70));
    allItems.forEach((item, i) => {
      const title = stripHtml(item.title);
      const desc = stripHtml(item.description);
      const date = item.postdate
        ? `${item.postdate.slice(0, 4)}-${item.postdate.slice(4, 6)}-${item.postdate.slice(6, 8)}`
        : '';
      const blogger = item.bloggername || '';

      console.log(`\n[${String(i + 1).padStart(2, '0')}] ${title}`);
      console.log(`     ✍️  ${blogger}  📅 ${date}`);
      console.log(`     ${desc.slice(0, 120)}...`);
      console.log(`     🔗 ${item.link}`);
      console.log('-'.repeat(70));
    });
  } else {
    console.log('💡 블로그 글 목록을 보려면 --list 옵션을 추가하세요.');
    console.log(`   node blog-search.js "${query}" --list\n`);
  }

  console.log(`\n✅ 완료! 총 ${allItems.length}개 글 분석\n`);
}

main();