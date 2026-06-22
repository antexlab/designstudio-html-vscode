// Design Studio (VSCode) — 액티비티 바 뷰: HTML 파일 목록(TreeView).
//  · 기본: 워크스페이스의 .html/.htm
//  · '폴더 선택'(designstudio.selectFolder) 후: 선택한 폴더(워크스페이스 밖이어도 됨)의 .html/.htm
//  · 항목 클릭 → designstudio.openFile → vscode.openWith(uri,'designstudio.htmlEditor')
//    → 그 파일이 Design Studio 편집기의 '대상 파일'(loaded_local)로 렌더·표시되고 원본 in-place 저장.
'use strict';

const vscode = require('vscode');
const path = require('path');

const SKIP_DIRS = new Set(['node_modules', '.git', '.wrangler', 'dist', 'out', '.vscode', '.idea']);
const MAX_FILES = 2000;

// 임의 폴더(워크스페이스 밖 포함)를 재귀 순회하며 .html/.htm 수집 (findFiles 는 워크스페이스 내부만 안정적이므로 fs 사용)
async function collectHtml(dirUri, acc, depth, seen) {
  if (acc.length >= MAX_FILES || depth > 8) return;
  const key = dirUri.fsPath;
  if (seen.has(key)) return;                        // 심볼릭 링크 순환 방어
  seen.add(key);
  let entries;
  try { entries = await vscode.workspace.fs.readDirectory(dirUri); } catch (e) { return; }
  for (const [name, ftype] of entries) {
    if (acc.length >= MAX_FILES) return;
    // FileType 은 비트 플래그(디렉터리/파일이 SymbolicLink 와 OR 될 수 있음) → 마스크 비교
    if (ftype & vscode.FileType.Directory) {
      if (SKIP_DIRS.has(name) || name.startsWith('.')) continue;
      await collectHtml(vscode.Uri.joinPath(dirUri, name), acc, depth + 1, seen);
    } else if ((ftype & vscode.FileType.File) && /\.html?$/i.test(name)) {
      acc.push(vscode.Uri.joinPath(dirUri, name));
    }
  }
}

class DesignStudioFileProvider {
  constructor() {
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this.rootFolder = null;   // Uri | null — '폴더 선택'으로 지정한 폴더
  }

  setRootFolder(uri) { this.rootFolder = uri || null; this.refresh(); }
  refresh() { this._onDidChangeTreeData.fire(); }
  getTreeItem(element) { return element; }

  async getChildren() {
    let uris = [];
    if (this.rootFolder) {
      await collectHtml(this.rootFolder, uris, 0, new Set());
    } else {
      const folders = vscode.workspace.workspaceFolders;
      if (!folders || !folders.length) return [];           // 폴더 미선택·미오픈 → viewsWelcome
      try { uris = await vscode.workspace.findFiles('**/*.{html,htm}', '**/{node_modules,.git,.wrangler,dist,out,.vscode,.idea}/**', MAX_FILES); }
      catch (e) { return []; }
    }
    uris.sort((a, b) => a.fsPath.localeCompare(b.fsPath));
    const baseDir = this.rootFolder ? this.rootFolder.fsPath : null;
    return uris.map((uri) => {
      const item = new vscode.TreeItem(uri, vscode.TreeItemCollapsibleState.None);  // label=파일명 + 파일 아이콘
      const rel = baseDir ? path.relative(baseDir, uri.fsPath) : vscode.workspace.asRelativePath(uri);
      const dir = path.dirname(rel);
      if (dir && dir !== '.') item.description = dir;
      item.tooltip = uri.fsPath;
      item.contextValue = 'designstudioHtmlFile';
      item.command = { command: 'designstudio.openFile', title: 'Design Studio에서 열기', arguments: [uri] };
      return item;
    });
  }
}

module.exports = { DesignStudioFileProvider };
