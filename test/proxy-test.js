// proxy.js SSRF/동작 단위 점검 (vsce 패키지에서 제외됨: .vscodeignore test/**)
'use strict';
const { fetchProxied } = require('../src/proxy');

(async () => {
  const cases = [
    ['빈 URL', ''],
    ['스킴 거부(ftp)', 'ftp://example.com/'],
    ['루프백 IP', 'http://127.0.0.1/'],
    ['메타데이터 IP', 'http://169.254.169.254/latest/meta-data/'],
    ['사설 IP(10/8)', 'http://10.0.0.5/'],
    ['localhost 호스트명', 'http://localhost:8080/'],
  ];
  for (const [name, url] of cases) {
    const r = await fetchProxied(url);
    console.log(`[차단기대] ${name.padEnd(18)} → ok=${r.ok}  ${r.ok ? '!!! 차단 실패' : '차단 OK ('+r.error+')'}`);
  }
  // 네트워크 가능 시: 정상 HTML + <base> 주입 확인
  try {
    const r = await fetchProxied('https://example.com/');
    if (r.ok) {
      const hasBase = /<base href="https:\/\/example\.com\/">/.test(r.html);
      console.log(`[정상기대] example.com       → ok=true  <base>주입=${hasBase}  길이=${r.html.length}`);
    } else {
      console.log(`[정상기대] example.com       → ok=false (${r.error})  ※ 네트워크 불가 환경일 수 있음`);
    }
  } catch (e) {
    console.log('[정상기대] example.com       → 예외(네트워크 불가?): ' + e.message);
  }
})();
