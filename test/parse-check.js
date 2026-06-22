// editor.html 의 인라인 <script> 블록을 new Function 으로 파싱해 구문 오류를 잡는다(브라우저 없이).
'use strict';
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'media', 'editor.html'), 'utf8');
const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
let m, i = 0, bad = 0;
while ((m = re.exec(html))) {
  i++;
  const body = m[1];
  try { new Function(body); }            // 파싱만(실행 안 함) → 구문 오류 검출
  catch (e) { bad++; console.log(`[SYNTAX ERROR] script #${i}: ${e.message}`); }
}
console.log(`인라인 <script> 블록 ${i}개 검사 → 구문오류 ${bad}개`);
process.exit(bad ? 1 : 0);
