// Design Studio (VSCode) — host 측 공유 메시지 핸들러.
// 웹뷰가 보낸 요청(외부 URL 프록시 / 파일·폴더 열기 / 언어 저장)을 처리해 회신한다.
// 명령 패널(panelController)과 CustomTextEditor(editorProvider) 양쪽이 공유.
'use strict';

const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const { fetchProxied } = require('./proxy');
const state = require('./state');

const FALLBACK_SAMPLE =
  '<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"></head><body style="font-family:system-ui;padding:40px"><h1>Design Studio</h1><p>편집할 화면입니다.</p></body></html>';

function readSample(context) {
  try { return fs.readFileSync(path.join(context.extensionPath, 'media', 'sample.html'), 'utf8'); }
  catch { return FALLBACK_SAMPLE; }
}

async function handleProxy(webview, msg) {
  let res;
  try { res = await fetchProxied(msg.url); }
  catch (e) { res = { ok: false, error: String((e && e.message) || e) }; }
  webview.postMessage({ type: 'proxyResult', id: msg.id, ok: !!res.ok, html: res.html, error: res.error });
}

async function handleOpenFile(webview, msg) {
  try {
    const picks = await vscode.window.showOpenDialog({
      canSelectMany: false, canSelectFolders: false, canSelectFiles: true,
      filters: { 'HTML': ['html', 'htm'], 'All files': ['*'] },
      openLabel: 'Design Studio: 열기',
    });
    if (!picks || !picks.length) { webview.postMessage({ type: 'openResult', id: msg.id, ok: false, canceled: true }); return; }
    const uri = picks[0];
    const content = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    const name = uri.path.split('/').pop() || 'file.html';
    webview.postMessage({ type: 'openResult', id: msg.id, ok: true, name, content });
  } catch (e) {
    webview.postMessage({ type: 'openResult', id: msg.id, ok: false, error: String((e && e.message) || e) });
  }
}

// 폴더 직계의 .html(목록) + .css(전역 인라인)를 모은다. (1차: 최상위 깊이만 — 재귀 비용/안전 고려)
async function handleOpenFolder(webview, msg) {
  try {
    const picks = await vscode.window.showOpenDialog({
      canSelectMany: false, canSelectFolders: true, canSelectFiles: false,
      openLabel: 'Design Studio: 폴더 열기',
    });
    if (!picks || !picks.length) { webview.postMessage({ type: 'folderResult', id: msg.id, ok: false, canceled: true }); return; }
    const root = picks[0];
    const entries = await vscode.workspace.fs.readDirectory(root);
    const files = []; let css = '';
    for (const [name, ftype] of entries) {
      if (ftype !== vscode.FileType.File) continue;
      const low = name.toLowerCase();
      const uri = vscode.Uri.joinPath(root, name);
      if (low.endsWith('.html') || low.endsWith('.htm')) {
        const content = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
        files.push({ name, relPath: name, content });
      } else if (low.endsWith('.css')) {
        const content = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
        css += '\n/* File: ' + name + ' */\n' + content;
      }
    }
    files.sort((a, b) => a.name.localeCompare(b.name));
    webview.postMessage({ type: 'folderResult', id: msg.id, ok: true, files, css });
  } catch (e) {
    webview.postMessage({ type: 'folderResult', id: msg.id, ok: false, error: String((e && e.message) || e) });
  }
}

async function handleSetLang(context, msg) {
  await state.setLang(context, msg.lang);
}

// 저장 대화상자 → 디스크 기록 (명령 도구창의 저장, 그리고 CustomEditor 의 "다른 이름으로 저장"에서 공유)
async function saveWithDialog(webview, m) {
  try {
    if (m.content == null) throw new Error('내용 없음');
    const base = String(m.fileName || 'untitled.html').split(/[\\/]/).pop() || 'untitled.html';
    const root = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    const defaultUri = root ? vscode.Uri.joinPath(root.uri, base) : vscode.Uri.file(base);
    const uri = await vscode.window.showSaveDialog({
      defaultUri,
      filters: { 'HTML': ['html', 'htm'], 'All files': ['*'] },
      saveLabel: 'Design Studio 저장',
    });
    if (!uri) { webview.postMessage({ type: 'saved', ok: false, error: '취소됨' }); return; }
    await vscode.workspace.fs.writeFile(uri, Buffer.from(String(m.content), 'utf8'));
    webview.postMessage({ type: 'saved', ok: true, path: uri.fsPath });
    vscode.window.showInformationMessage('Design Studio: 저장 완료 → ' + uri.fsPath);
  } catch (e) {
    webview.postMessage({ type: 'saved', ok: false, error: String((e && e.message) || e) });
  }
}

module.exports = { readSample, handleProxy, handleOpenFile, handleOpenFolder, handleSetLang, saveWithDialog };
