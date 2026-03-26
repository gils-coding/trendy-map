// =====================================================
// 네이버 블로그 맛집 조사 스크립트
// 사용법: node blog-search.js "서울 버터떡 맛집"
// =====================================================

const https = require('https');

// ⚠️ 여기에 네이버 API 키 입력
const NAVER_CLIENT_ID = 'af92015VWkBED6l313do';
const NAVER_CLIENT_SECRET = 'grSkcecCWs';

const query = process.argv[2];
if (!query) {
  console.log('사용법: node blog-search.js "검색어"');
  console.log('예시:   node blog-search.js "서울 버터떡 맛집"');
  process.exit(1);
}

async function fetchBlogPosts(query, start) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({ query, display: 10, start, sort: 'sim' });
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
  return str.replace(/<[^>]+>/g, '').replace(/&[a-z]+;/gi, ' ').trim();
}

async function main() {
  console.log(`\n🔍 "${query}" 블로그 검색 중...\n`);
  console.log('='.repeat(70));

  const allItems = [];
  for (let start = 1; start <= 41; start += 10) {
    try {
      const data = await fetchBlogPosts(query, start);
      if (!data.items?.length) break;
      allItems.push(...data.items);
      if (data.items.length < 10) break;
    } catch (e) {
      console.error('오류:', e.message);
      break;
    }
  }

  console.log(`총 ${allItems.length}개 글 수집\n`);
  console.log('='.repeat(70));

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

  console.log(`\n✅ 완료! 총 ${allItems.length}개 글`);
  console.log(`👆 링크를 복사해서 브라우저에서 열어보세요\n`);
}

main();
