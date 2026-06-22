// Design Studio (VSCode) — 영속 상태(언어 등) globalState 브리지.
// 웹뷰의 document.cookie 는 vscode 웹뷰에서 비영속(출처 회전·백그라운드 파괴)이라
// 신뢰할 수 없으므로, 언어 선택은 확장 host 의 globalState(머신 전역, 세션 간 영속)에 저장한다.
'use strict';

const LANG_KEY = 'designstudio.lang';

function getLang(context) {
  const v = context.globalState.get(LANG_KEY);
  return (v === 'ko' || v === 'ja' || v === 'en') ? v : null;
}

async function setLang(context, lang) {
  if (lang === 'ko' || lang === 'ja' || lang === 'en') {
    await context.globalState.update(LANG_KEY, lang);
  }
}

module.exports = { getLang, setLang, LANG_KEY };
