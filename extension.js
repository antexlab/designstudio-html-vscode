// Design Studio (VSCode) — 확장 진입점.
// (1) 액티비티 바 뷰(HTML 파일 목록) — '폴더 선택'으로 소스 폴더 지정, 항목 클릭 시 편집기로 열기,
// (2) 명령 designstudio.open → 빈 도구 창,
// (3) CustomTextEditor(.html in-place 시각 편집),
// (4) 탐색기 우클릭 "Design Studio에서 열기".
'use strict';

const vscode = require('vscode');
const { openPanel } = require('./src/panelController');
const { DesignStudioEditorProvider } = require('./src/editorProvider');
const { DesignStudioFileProvider } = require('./src/fileTree');

function activate(context) {
  const fileProvider = new DesignStudioFileProvider();
  const treeView = vscode.window.createTreeView('designstudio.files', { treeDataProvider: fileProvider });

  // 워크스페이스의 .html/.htm 추가·삭제 시 트리 갱신 (폴더 선택 모드에서도 무해)
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.{html,htm}');
  watcher.onDidCreate(() => fileProvider.refresh());
  watcher.onDidDelete(() => fileProvider.refresh());

  context.subscriptions.push(
    treeView,
    watcher,
    vscode.workspace.onDidChangeWorkspaceFolders(() => fileProvider.refresh()),
    vscode.commands.registerCommand('designstudio.selectFolder', () => selectFolder(fileProvider, treeView)),
    vscode.commands.registerCommand('designstudio.refreshFiles', () => fileProvider.refresh()),
    vscode.commands.registerCommand('designstudio.openFile', (uri) => openInDesignStudio(uri)),
    vscode.commands.registerCommand('designstudio.open', () => openPanel(context)),
    DesignStudioEditorProvider.register(context),
  );
}

// '폴더 선택': 폴더를 골라 그 폴더의 HTML 만 목록에 표시
async function selectFolder(provider, treeView) {
  try {
    const picks = await vscode.window.showOpenDialog({
      canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
      openLabel: '이 폴더의 HTML 보기',
    });
    if (!picks || !picks.length) return;
    provider.setRootFolder(picks[0]);
    treeView.message = '📁 ' + picks[0].fsPath;
  } catch (e) {
    vscode.window.showErrorMessage('Design Studio: 폴더 선택 실패 — ' + String((e && e.message) || e));
  }
}

// 파일을 Design Studio 시각 편집기로 연다 → 그 파일이 '대상 파일'(loaded_local)로 렌더·표시되고 원본 in-place 저장.
// uri 없으면(명령 팔레트) 파일 선택 대화상자.
async function openInDesignStudio(uri) {
  try {
    if (!uri) {
      const picks = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { 'HTML': ['html', 'htm'], 'All files': ['*'] },
        openLabel: 'Design Studio에서 열기',
      });
      if (!picks || !picks.length) return;
      uri = picks[0];
    }
    await vscode.commands.executeCommand('vscode.openWith', uri, 'designstudio.htmlEditor');
  } catch (e) {
    vscode.window.showErrorMessage('Design Studio: 열기 실패 — ' + String((e && e.message) || e));
  }
}

function deactivate() {}

module.exports = { activate, deactivate };
