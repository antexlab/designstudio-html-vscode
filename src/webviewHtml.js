// Design Studio (VSCode) — 웹뷰 HTML 빌더.
// media/editor.html 을 읽어 (1) <head> 맨앞에 CSP + 초기 전역(__DS_INIT_LANG/__DS_MODE),
// (2) </body> 직전에 host-adapter.js 를 주입한다. editor.html 본문은 그대로 사용.
'use strict';

const fs = require('fs');
const path = require('path');

function buildHtml(context, webview, opts) {
  opts = opts || {};
  const mediaDir = path.join(context.extensionPath, 'media');
  let html = fs.readFileSync(path.join(mediaDir, 'editor.html'), 'utf8');
  const adapter = fs.readFileSync(path.join(mediaDir, 'host-adapter.js'), 'utf8');
  const cspSource = webview.cspSource;

  // CSP: 인라인 onclick 핸들러 다수의 SPA → script-src 'unsafe-inline'(nonce 로는 인라인 핸들러 인가 불가).
  // 통제된 로컬 콘텐츠에 대한 의도적 보안 완화(설계 R1). 외부 폰트/이미지/콘텐츠 리소스만 추가 허용.
  const csp = [
    "default-src 'none'",
    `img-src ${cspSource} https: data: blob:`,
    `media-src ${cspSource} blob: data:`,
    `style-src ${cspSource} 'unsafe-inline' https://fonts.googleapis.com`,
    `font-src ${cspSource} https://fonts.gstatic.com data:`,
    `script-src 'unsafe-inline' 'unsafe-eval' ${cspSource} https://cdn.jsdelivr.net`,
    `connect-src ${cspSource} https: data: blob:`,
    "frame-src 'self' about: data: blob:",
  ].join('; ');
  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;

  // 초기 언어/모드는 i18n 스크립트보다 먼저 주입 (detectLang 가 window.__DS_INIT_LANG 우선)
  const lang = (opts.lang === 'ko' || opts.lang === 'ja' || opts.lang === 'en') ? opts.lang : '';
  const early = `<script>window.__DS_INIT_LANG=${JSON.stringify(lang)};window.__DS_MODE=${JSON.stringify(opts.mode || 'tool')};</script>`;

  if (/<head[^>]*>/i.test(html)) {
    html = html.replace(/<head[^>]*>/i, (m) => `${m}\n  ${cspMeta}\n  ${early}\n`);
  } else {
    html = `${cspMeta}\n${early}\n${html}`;
  }

  // 어댑터는 에디터 본문 스크립트 "뒤"(문서의 마지막 </body> 직전)에 주입 → downloadToBrowser 오버라이드가 이긴다.
  // ★중요: "첫" </body> 가 아니라 "마지막" </body> 에 주입한다. editor.html 의 인라인 스크립트 문자열
  //   리터럴에 '</body>' 가 들어 있어, 첫 매치에 주입하면 어댑터의 </script> 가 메인 스크립트를 조기
  //   종료시켜 이후 JS 가 페이지 텍스트로 새어 나온다(실측 버그).
  const scriptTag = `<script>\n${adapter}\n</script>`;
  const idx = html.toLowerCase().lastIndexOf('</body>');
  if (idx !== -1) html = html.slice(0, idx) + scriptTag + '\n' + html.slice(idx);
  else html = `${html}\n${scriptTag}`;

  return html;
}

module.exports = { buildHtml };
