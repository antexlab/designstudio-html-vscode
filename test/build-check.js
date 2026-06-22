// 실제 buildHtml() 출력으로 "스크립트 누수" 회귀를 검사한다(브라우저 없이).
// 버그: 어댑터를 첫 </body>(스크립트 문자열 내부)에 주입하면 메인 스크립트가 조기 종료되어
//       브리지 전역 JS 가 페이지 텍스트로 새어 나옴. 수정 후엔 새지 않아야 한다.
'use strict';
const path = require('path');
const { buildHtml } = require('../src/webviewHtml');

const built = buildHtml(
  { extensionPath: path.join(__dirname, '..') },
  { cspSource: 'vscode-webview://fake' },
  { mode: 'tool', lang: 'ko' },
);

// 1) 모든 인라인 <script> 블록이 구문상 온전한가
const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
let m, i = 0, bad = 0;
while ((m = re.exec(built))) { i++; try { new Function(m[1]); } catch (e) { bad++; console.log(`[SYNTAX] script #${i}: ${e.message}`); } }

// 2) 위치 관계: 브리지 전역(__dsApplyInit..__dsLoadFolder)은 같은 메인 스크립트 안,
//    어댑터(window.dsHost)는 메인 스크립트의 </script> 뒤 + 마지막 </body> 앞.
const bridgeIdx = built.indexOf('window.__dsApplyInit');
const mainCloseIdx = built.indexOf('</script>', bridgeIdx);   // 브리지 다음의 첫 </script> = 메인 스크립트 닫기(수정 후)
const loadFolderIdx = built.indexOf('window.__dsLoadFolder');
const adapterIdx = built.indexOf('acquireVsCodeApi');   // 어댑터에만 존재하는 고유 마커
const lastBody = built.toLowerCase().lastIndexOf('</body>');

const bridgeInMain = loadFolderIdx > -1 && loadFolderIdx < mainCloseIdx;   // 브리지가 조기종료 전(=메인 안)
const adapterAfterMain = adapterIdx > mainCloseIdx;
const adapterBeforeBody = adapterIdx > -1 && adapterIdx < lastBody;

console.log('built length         :', built.length);
console.log('script blocks        :', i, ' syntax errors:', bad);
console.log('bridge in main script:', bridgeInMain, ` (loadFolder=${loadFolderIdx} < mainClose=${mainCloseIdx})`);
console.log('adapter after main   :', adapterAfterMain, ` (dsHost=${adapterIdx})`);
console.log('adapter before </body>:', adapterBeforeBody, ` (lastBody=${lastBody})`);

const ok = bad === 0 && bridgeInMain && adapterAfterMain && adapterBeforeBody;
console.log(ok ? '\nBUILD CHECK PASS — 스크립트 누수 없음' : '\nBUILD CHECK FAIL');
process.exit(ok ? 0 : 1);
