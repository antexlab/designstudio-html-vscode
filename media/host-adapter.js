/* Design Studio — VSCode 웹뷰 호스트 어댑터.
 * editor.html 본문 스크립트 "뒤"(</body> 직전)에 주입된다.
 * 책임:
 *   (1) 호스트(extension) ↔ 웹뷰 메시지 브리지 → window.dsHost (editor.html 의 로딩/저장 함수가 사용)
 *   (2) 초기 콘텐츠(init) · 외부변경(externalChange) 를 editor.html 의 전역 렌더 함수로 반영
 *   (3) 저장 후킹: window.downloadToBrowser → 호스트(save)
 *   (4) i18n 언어 영속: applyLang → window.__dsSetLang → 호스트 globalState
 *
 * 메시지 프로토콜
 *   webview → host: ready | proxy{id,url} | openFile{id} | openFolder{id} | save{fileName,content,mime} | setLang{lang}
 *   host → webview: init{mode,initialHtml,fileName,lang,sampleHtml} | proxyResult{id,ok,html,error}
 *                   | openResult{id,ok,name,content,error,canceled} | folderResult{id,ok,files,css,error,canceled}
 *                   | saved{ok,path,error} | externalChange{initialHtml,fileName}
 */
(function () {
  const vscode = acquireVsCodeApi();
  let seq = 0;
  const pending = new Map();   // id → {resolve}

  function request(type, extra) {
    const id = 'r' + (++seq);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(function () {                 // host 무응답 대비 상한(10분) → pending 영구 누수 방지
        if (pending.has(id)) { pending.delete(id); reject(new Error('요청 시간이 초과되었습니다.')); }
      }, 600000);
      pending.set(id, function (msg) { clearTimeout(timer); resolve(msg); });
      vscode.postMessage(Object.assign({ type, id }, extra || {}));
    });
  }

  // 웹뷰 → 호스트 브리지 (editor.html 의 submitUrlDialog / handleFileSelectChange / saveChanges 등이 사용)
  window.dsHost = {
    // 외부 URL → 안전 프록시 HTML 문자열(Promise<string>), 실패 시 reject
    proxy: function (url) {
      return request('proxy', { url }).then(function (r) {
        if (r && r.ok) return r.html;
        throw new Error((r && r.error) || '불러오기 실패');
      });
    },
    // 네이티브 파일 선택 → editor.html 전역으로 렌더
    openFile: function () {
      return request('openFile', {}).then(function (r) {
        if (r && r.ok && typeof window.__dsLoadLocal === 'function') window.__dsLoadLocal(r.name, r.content);
        else if (r && !r.canceled && typeof window.showToast === 'function') window.showToast(r.error || '파일을 열지 못했습니다.');
        return r;
      }).catch(function (e) { if (typeof window.showToast === 'function') window.showToast(String((e && e.message) || e)); });
    },
    // 네이티브 폴더 선택 → editor.html 전역으로 렌더
    openFolder: function () {
      return request('openFolder', {}).then(function (r) {
        if (r && r.ok && typeof window.__dsLoadFolder === 'function') window.__dsLoadFolder({ files: r.files || [], css: r.css || '' });
        else if (r && !r.canceled && typeof window.showToast === 'function') window.showToast(r.error || '폴더를 열지 못했습니다.');
        return r;
      }).catch(function (e) { if (typeof window.showToast === 'function') window.showToast(String((e && e.message) || e)); });
    },
    save: function (fileName, content, mime, saveAs) {
      vscode.postMessage({ type: 'save', fileName: fileName || 'untitled.html', content: String(content), mime: mime || 'text/html', saveAs: !!saveAs });
    },
    setLang: function (lang) { vscode.postMessage({ type: 'setLang', lang: lang }); },
  };

  // 저장 가로채기: 에디터의 saveChanges() 는 downloadToBrowser(name, html[, mime]) 를 호출한다.
  // window.__dsSaveAs 가 켜져 있으면 "다른 이름으로 저장"(호스트 저장 대화상자)으로 분기.
  window.downloadToBrowser = function (fileName, content, mime) {
    const saveAs = !!window.__dsSaveAs; window.__dsSaveAs = false;
    try { window.dsHost.save(fileName, content, mime, saveAs); }
    catch (e) { console.error('Design Studio: 저장 전송 실패', e); }
  };

  // VS Code 웹뷰는 alert/confirm/prompt 를 지원하지 않는다(차단 시 무반응/오동작) → 안전한 대체.
  window.alert = function (msg) { if (msg && typeof window.showToast === 'function') window.showToast(String(msg)); };
  window.confirm = function () { return true; };   // 네이티브는 차단(undefined=취소)되어 동작이 막힘 → 진행 허용. (주의: 문서 모드의 미저장 시각 편집은 VSCode undo 로 복구되지 않으므로 dirty-discard 가드는 사실상 무력화됨)
  window.prompt = function () { return null; };
  // "다른 이름으로 저장": prompt 차단 대응 — saveChanges 직렬화를 재사용하되 saveAs 플래그로 호스트 저장 대화상자 유도.
  window.saveAsChanges = function () {
    window.__dsSaveAs = true;
    try { if (typeof window.saveChanges === 'function') window.saveChanges(); }
    catch (e) { window.__dsSaveAs = false; console.error('Design Studio: 다른 이름 저장 실패', e); }
  };

  // i18n: 사용자가 메뉴에서 언어를 바꿀 때만 호출 → 호스트 globalState 동기화(쿠키 대체)
  window.__dsSetLang = function (lang) { try { window.dsHost.setLang(lang); } catch (e) {} };

  // 호스트 → 웹뷰
  window.addEventListener('message', function (e) {
    const m = e.data; if (!m) return;
    // 요청-응답 상관(proxy/openFile/openFolder)
    if (m.id && pending.has(m.id)) { const resolve = pending.get(m.id); pending.delete(m.id); resolve(m); return; }
    switch (m.type) {
      case 'init':
        window.__dsSampleHtml = m.sampleHtml || '';
        if (typeof window.__dsApplyInit === 'function') window.__dsApplyInit(m);
        break;
      case 'externalChange':
        if (typeof window.__dsExternalChange === 'function') window.__dsExternalChange(m);
        else if (typeof window.__dsApplyInit === 'function') window.__dsApplyInit({ mode: 'document', initialHtml: m.initialHtml, fileName: m.fileName });
        break;
      case 'saved':
        if (m.ok) {
          if (typeof window.__dsCommitSave === 'function') window.__dsCommitSave();   // 저장 성공 후에만 dirty/편집추적 정리
          if (typeof window.showToast === 'function') window.showToast('저장 완료: ' + (m.path || ''));
        } else {
          if (typeof window.setSaveBtn === 'function') window.setSaveBtn('변경사항 저장', false);   // 취소/실패 → 버튼 복구, dirty 보존
          if (typeof window.showToast === 'function') window.showToast('저장 취소/실패: ' + (m.error || ''));
        }
        break;
    }
  });

  // 에디터 로드 완료 → 호스트에 초기 콘텐츠 요청
  function ready() { vscode.postMessage({ type: 'ready' }); }
  if (document.readyState === 'complete' || document.readyState === 'interactive') ready();
  else document.addEventListener('DOMContentLoaded', ready);
})();
