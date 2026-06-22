# Design Studio (HTML) — VS Code extension

A visual HTML editor (`designstudio-html`) re-ported to run inside VS Code. **Click elements to edit HTML pages** and **save straight back to the original file**. No server required — external URLs are fetched through the extension host's safe proxy.

## Usage

### 1) Edit a file visually (recommended — in-place save)
- Open the **Design Studio** view in the Activity Bar, then click any HTML file (or right-click a `.html` file in the Explorer → **Reopen Editor With…** → **Design Studio (Visual Edit)**).
- Click elements on the page to edit their style / text / layout, and drag in components.
- Click **Save** at the top (or `Ctrl+S`) → the change is written back to the **original file**. Dirty state, undo, and external-change sync are integrated with VS Code.

### 2) Tool window (start with no file / external URL / local browsing)
- Command Palette (`Ctrl+Shift+P`) → **Design Studio: Open Editor**.
- Use the **Target file** dropdown at the top to load an *external URL / a local file / a folder*.
- After editing, **Save** opens a save dialog so you can choose the location and name.

### Side view & "Select Folder"
- The **Design Studio** Activity-Bar view lists the HTML files in your workspace.
- Click **Select Folder** (folder icon in the view title) to list the HTML files of a specific folder (it may be outside the workspace).
- Click a file → it opens in the editor as the **Target file** and is rendered.

## Features
- Click-based visual editing (typography, box model, layout, background/border), add / duplicate / delete / move elements, source view, and CSS extraction.
- **Load external URL**: fetched through an SSRF-protected proxy in the extension host (for login-only sites, copy the capture bookmarklet code first).
- **Multilingual**: English / 한국어 / 日本語. The default is **English**; switch from the menu at the top right, and your choice is remembered across sessions.

## Security / limitations
- The **external-URL proxy** allows `http/https` only, pins the resolved IP to block **DNS rebinding**, and blocks private / loopback / link-local / metadata (169.254.169.254) / CGNAT / multicast ranges. Responses are capped at 25 MB. **Only HTML documents** are supported (no images/PDFs).
- Relative resources (images/CSS) of a loaded single local file may not render because there is no server (a folder load inlines `.css`). Relative resources of an external page are requested directly from the origin.
- To run a large inline-handler SPA, the webview CSP uses `script-src 'unsafe-inline' 'unsafe-eval'` (a deliberate relaxation limited to controlled local content).
- Desktop VS Code is the primary target (vscode.dev on the web is more restricted).

## Development / running
- Press **F5** (Run Extension) → verify in the Extension Development Host as described above.
- Package: `npm i -g @vscode/vsce`, then `vsce package` → produces a `.vsix`. Install: `code --install-extension designstudio-html-vscode-0.1.0.vsix`.
- No runtime dependencies (the proxy uses Node built-ins `net` / `dns` / `http(s)` / `zlib`). See `DESIGN.md` in the repository for the full design.
