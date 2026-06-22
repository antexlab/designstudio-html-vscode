// Design Studio (VSCode) — CustomTextEditorProvider (주 진입).
// .html/.htm 을 "Design Studio (시각 편집)"으로 열면 그 파일이 데이터 모델이 되고,
// 편집 결과를 WorkspaceEdit + applyEdit 로 원본에 in-place 저장한다(Ctrl+S/dirty/undo 통합).
// 외부 변경은 onDidChangeTextDocument 로 웹뷰에 반영하되, 웹뷰 자기유발 편집은 스킵(갱신 루프 방어).
'use strict';

const vscode = require('vscode');
const { buildHtml } = require('./webviewHtml');
const host = require('./host');
const state = require('./state');

const VIEW_TYPE = 'designstudio.htmlEditor';

class DesignStudioEditorProvider {
  constructor(context) { this.context = context; }

  static register(context) {
    const provider = new DesignStudioEditorProvider(context);
    return vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    });
  }

  async resolveCustomTextEditor(document, webviewPanel, _token) {
    const context = this.context;
    const webview = webviewPanel.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(context.extensionUri, 'media'),
        ...((vscode.workspace.workspaceFolders || []).map((f) => f.uri)),
      ],
    };
    webview.html = buildHtml(context, webview, { mode: 'document', lang: state.getLang(context) || 'en' });

    const fileName = document.uri.path.split('/').pop() || 'untitled.html';
    let lastAppliedText = null;     // 웹뷰가 방금 applyEdit 한 텍스트(자기유발 변경을 결정론적으로 스킵)

    const postInit = () => webview.postMessage({
      type: 'init', mode: 'document', initialHtml: document.getText(), fileName,
      sampleHtml: host.readSample(context),
    });

    const msgSub = webview.onDidReceiveMessage(async (m) => {
      if (!m) return;
      switch (m.type) {
        case 'ready': return postInit();
        case 'proxy': return host.handleProxy(webview, m);
        case 'openFile': return host.handleOpenFile(webview, m);
        case 'openFolder': return host.handleOpenFolder(webview, m);
        case 'setLang': return host.handleSetLang(context, m);
        case 'save': return this._save(document, webview, m, (text) => { lastAppliedText = text; });
      }
    });

    const norm = (s) => String(s == null ? '' : s).replace(/\r\n/g, '\n');
    const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString()) return;
      if (!e.contentChanges.length) return;
      if (norm(document.getText()) === norm(lastAppliedText)) return;   // 웹뷰 자기유발 편집(EOL 정규화 비교) → 재렌더 스킵
      webview.postMessage({ type: 'externalChange', initialHtml: document.getText(), fileName });
    });

    webviewPanel.onDidDispose(() => { msgSub.dispose(); changeSub.dispose(); });
  }

  async _save(document, webview, m, markApplied) {
    if (m.saveAs) return host.saveWithDialog(webview, m);   // "다른 이름으로 저장" → 저장 대화상자(원본 유지)
    try {
      if (m.content == null) throw new Error('내용 없음');
      const text = String(m.content);
      markApplied(text);                             // onDidChange 비교용(자기유발 편집 스킵)
      const edit = new vscode.WorkspaceEdit();
      const full = new vscode.Range(0, 0, document.lineCount, 0);
      edit.replace(document.uri, full, text);
      const applied = await vscode.workspace.applyEdit(edit);
      if (applied) await document.save();            // 원본 디스크에 즉시 기록
      webview.postMessage({ type: 'saved', ok: !!applied, path: document.uri.fsPath, error: applied ? undefined : '편집 적용 실패' });
      if (applied) vscode.window.showInformationMessage('Design Studio: 저장 완료 → ' + document.uri.fsPath);
    } catch (e) {
      webview.postMessage({ type: 'saved', ok: false, error: String((e && e.message) || e) });
    }
  }
}

module.exports = { DesignStudioEditorProvider, VIEW_TYPE };
