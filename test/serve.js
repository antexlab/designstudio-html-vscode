// 검증 전용 정적 서버(패키지 제외). buildHtml 출력을 stub 과 함께 서빙해 chrome i18n 을 브라우저로 관찰.
//   /built  → buildHtml({mode:'tool', lang:'ko'}) + acquireVsCodeApi stub (어댑터가 던지지 않게)
//   기타    → 프로젝트 파일 정적 서빙
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };

http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  // 아이콘 생성 보조: 브라우저 캔버스가 만든 PNG dataURL 을 받아 media/icon.png 로 저장
  if (req.method === 'POST' && p === '/save-icon') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try {
        const b64 = String(body).replace(/^data:image\/png;base64,/, '');
        const buf = Buffer.from(b64, 'base64');
        fs.writeFileSync(path.join(ROOT, 'media', 'icon.png'), buf);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, bytes: buf.length }));
      } catch (e) { res.writeHead(500); res.end(String(e)); }
    });
    return;
  }
  if (p === '/' || p === '/built') {
    try {
      const { buildHtml } = require('../src/webviewHtml');
      let html = buildHtml({ extensionPath: ROOT }, { cspSource: 'http://localhost:8092' }, { mode: 'tool', lang: 'en' });
      // 브라우저엔 acquireVsCodeApi 가 없어 어댑터가 던짐 → stub 으로 무력화(메시지는 무시). i18n chrome 만 관찰.
      const stub = '<script>window.acquireVsCodeApi=function(){return{postMessage:function(){},getState:function(){return null},setState:function(){}}};</script>';
      html = html.replace(/<head[^>]*>/i, (m) => m + '\n' + stub);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    } catch (e) { res.writeHead(500); res.end(String(e && e.stack || e)); return; }
  }
  const fp = path.normalize(path.join(ROOT, p));
  if (!fp.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(fp, (e, d) => {
    if (e) { res.writeHead(404); res.end('404'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream' });
    res.end(d);
  });
}).listen(8092, '127.0.0.1', () => console.log('dsvscode preview: http://localhost:8092/built'));
