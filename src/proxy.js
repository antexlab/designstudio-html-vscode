// Design Studio (VSCode) — 외부 URL 프록시 (extension host, Node).
// designstudio-html/server.js 의 /api/proxy SSRF 안전 프록시를 "값 반환형"으로 이식한 것.
// 웹뷰엔 서버가 없으므로, 웹뷰가 {type:'proxy',url} 을 보내면 host 가 이 모듈로
// 안전하게 가져온 HTML 문자열을 회신한다 → 웹뷰가 iframe 에 같은-출처로 렌더.
//
// 보안(server.js 동등): http/https 만 허용 · DNS 조회 후 공인 IP 핀(검증한 IP로만 연결)
// · DNS 리바인딩 차단 · 사설/루프백/링크로컬/메타데이터/CGNAT/멀티캐스트 대역 차단(v4/v6)
// · 리다이렉트 5회 한계 + 매 홉 재검증 · 응답 25MB 상한(zip bomb 방지) · 압축 해제 · charset 디코드
// · <base href=원본> 주입(상대경로 리소스가 원본 기준 해석). Cloudflare worker.js 가정(엣지 격리)은
//   Node 에선 성립하지 않으므로 net/dns 핀 경로를 채택한다(전역 fetch 단독 사용 금지).
'use strict';

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const net = require('net');
const dns = require('dns').promises;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_PROXY_BYTES = 25 * 1024 * 1024; // 프록시 응답 상한(메모리 DoS 방지)

function htmlEscape(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// 응답 본문을 압축 해제하며 상한까지만 읽는다(zip bomb·메모리 DoS 방지: 해제 후 누적 바이트로 검사).
async function readResponse(res, max) {
  const enc = String(res.headers['content-encoding'] || '').toLowerCase();
  let stream = res;
  if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(zlib.createGunzip());
  else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
  else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
  const chunks = []; let total = 0;
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > max) { res.destroy(); throw new Error('응답이 너무 큽니다.'); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function charsetFromCT(ct) { const m = /charset=([^;]+)/i.exec(ct || ''); return m ? m[1].trim().toLowerCase() : null; }
function decodeBody(buf, ct) {
  const cs = charsetFromCT(ct) || 'utf-8';
  try { return new TextDecoder(cs, { fatal: false }).decode(buf); }
  catch { return new TextDecoder('utf-8', { fatal: false }).decode(buf); }
}

// 내부/사설/메타데이터 IP 차단 (169.254.169.254 등으로의 요청 방지)
function ipIsPrivate(ip) {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (m) ip = m[1];
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    const n = ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
    const inR = (base, bits) => (n >>> (32 - bits)) === (base >>> (32 - bits));
    return inR(0x00000000, 8) || inR(0x0a000000, 8) || inR(0x7f000000, 8) ||
      inR(0xa9fe0000, 16) || inR(0xac100000, 12) ||
      inR(0xc0a80000, 16) || inR(0x64400000, 10) || inR(0xc6120000, 15) || p[0] >= 224;
  }
  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase();
    return low === '::1' || low === '::' || low.startsWith('fe80') || low.startsWith('fc') || low.startsWith('fd');
  }
  return true;
}

// URL 검증 + DNS 조회 → 통과한 '공인 IP 하나를 고정(pin)'해 반환.
// 이후 연결을 이 IP 로만 하면 검증 시점과 연결 시점의 IP 가 동일해져 DNS 리바인딩을 차단한다.
async function resolveAndPin(rawUrl) {
  const u = new URL(rawUrl);
  const scheme = u.protocol.replace(':', '').toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') throw new Error('http:// 또는 https:// 주소만 허용됩니다.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await dns.lookup(host, { all: true });
  if (!addrs.length) throw new Error('주소를 확인할 수 없습니다.');
  for (const a of addrs) if (ipIsPrivate(a.address)) throw new Error('내부/사설 주소로의 요청은 차단됩니다.');
  const pin = addrs[0];
  return { u, ip: pin.address, family: pin.family || net.isIP(pin.address) || 4 };
}

// 검증된 IP 로만 연결(lookup 고정). SNI·Host 는 원래 호스트명을 유지해 인증서 검증을 보존한다.
function requestPinned(u, ip, family, headers, ms) {
  return new Promise((resolve, reject) => {
    const isHttps = u.protocol === 'https:';
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const isIpHost = net.isIP(host) !== 0;
    const req = (isHttps ? https : http).request({
      protocol: u.protocol,
      hostname: host,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      method: 'GET',
      headers: { ...headers, Host: u.host, 'Accept-Encoding': 'gzip, deflate, br' },
      // ← 핵심: 재조회 없이 검증된 IP 로 고정. Happy Eyeballs(all:true)는 배열을 기대하므로 양쪽 시그니처 대응
      lookup: (h, o, cb) => (o && o.all) ? cb(null, [{ address: ip, family }]) : cb(null, ip, family),
      servername: isHttps && !isIpHost ? host : undefined,        // SNI = 원래 호스트명(인증서 검증 유지)
      timeout: ms,
    }, resolve);
    req.on('timeout', () => req.destroy(new Error('요청 시간이 초과되었습니다.')));
    req.on('error', reject);
    req.end();
  });
}

async function fetchSafe(url, headers, ms = 15000, maxRedirects = 5) {
  let current = url;
  for (let i = 0; i <= maxRedirects; i++) {
    const { u, ip, family } = await resolveAndPin(current);
    const res = await requestPinned(u, ip, family, headers, ms);
    const loc = res.headers.location;
    if (res.statusCode >= 300 && res.statusCode < 400 && loc) {
      res.resume();                                               // 본문 폐기 후 리다이렉트 대상 재검증
      current = new URL(loc, u).toString();
      continue;
    }
    const buf = await readResponse(res, MAX_PROXY_BYTES);
    return { status: res.statusCode, headers: res.headers, buf };
  }
  throw new Error('리다이렉트 횟수가 너무 많습니다.');
}

// 값 반환형 진입점. 성공: {ok:true, html, contentType} / 실패: {ok:false, error}
// 1차 범위: HTML 문서만 지원(이미지/PDF 등 비HTML 은 srcdoc 렌더 불가 → 명확한 에러).
async function fetchProxied(targetUrl) {
  if (!targetUrl) return { ok: false, error: 'URL이 지정되지 않았습니다.' };
  try {
    const r = await fetchSafe(targetUrl, {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
    });
    const ct = r.headers['content-type'] || '';
    if (!ct.includes('text/html')) {
      return { ok: false, error: 'HTML 문서만 불러올 수 있습니다. (이미지/PDF 등 비HTML 응답은 지원하지 않습니다.)' };
    }
    let s = decodeBody(r.buf, ct);
    const baseTag = `<base href="${htmlEscape(targetUrl)}">`; // 상대경로 리소스가 원본 기준 해석되게. 값 그대로 삽입 시 마크업 주입 → 이스케이프
    const m = /<head[^>]*>/i.exec(s);
    if (m) s = s.slice(0, m.index + m[0].length) + '\n  ' + baseTag + s.slice(m.index + m[0].length);
    else s = baseTag + '\n' + s;
    return { ok: true, html: s, contentType: 'text/html; charset=utf-8' };
  } catch (e) {
    return { ok: false, error: '이 사이트를 불러오지 못했습니다: ' + (e && e.message ? e.message : String(e)) };
  }
}

module.exports = { fetchProxied };
