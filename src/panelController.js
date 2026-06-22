// Design Studio (VSCode) — 명령 진입(도구 창) 패널.
// designstudio.open 명령으로 파일에 매이지 않은 Webview 패널을 띄운다(초기 콘텐츠=sample).
// 저장은 '저장 대화상자 → 디스크 기록'(원본 파일이 없으므로). 외부 URL·로컬 파일/폴더 탐색용.
'use strict';

const vscode = require('vscode');
const { buildHtml } = require('./webviewHtml');
const host = require('./host');
const state = require('./state');

let panel = null;

function openPanel(context) {
  if (panel) { panel.reveal(vscode.ViewColumn.One); return; }
  panel = vscode.window.createWebviewPanel('designstudio.panel', 'Design Studio', vscode.ViewColumn.One, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [
      vscode.Uri.joinPath(context.extensionUri, 'media'),
      ...((vscode.workspace.workspaceFolders || []).map((f) => f.uri)),
    ],
  });
  panel.webview.html = buildHtml(context, panel.webview, { mode: 'tool', lang: state.getLang(context) || 'en' });

  panel.webview.onDidReceiveMessage(async (m) => {
    if (!m || !panel) return;
    switch (m.type) {
      case 'ready': {
        const sample = host.readSample(context);
        panel.webview.postMessage({
          type: 'init', mode: 'tool', initialHtml: sample, fileName: 'sample.html', sampleHtml: sample,
        });
        return;
      }
      case 'proxy': return host.handleProxy(panel.webview, m);
      case 'openFile': return host.handleOpenFile(panel.webview, m);
      case 'openFolder': return host.handleOpenFolder(panel.webview, m);
      case 'setLang': return host.handleSetLang(context, m);
      case 'save': return host.saveWithDialog(panel.webview, m);   // 도구창은 항상 저장 대화상자
    }
  }, null, context.subscriptions);

  panel.onDidDispose(() => { panel = null; }, null, context.subscriptions);
}

module.exports = { openPanel };
