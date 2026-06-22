# Change Log

## 0.1.0
- Initial release. Re-ports the `designstudio-html` editor as a VS Code extension.
- **CustomTextEditor**: open `.html`/`.htm` with "Design Studio (Visual Edit)" to edit by clicking, then save in place to the original file (integrated with `Ctrl+S` / dirty state / undo).
- **Activity-Bar view**: lists HTML files; **Select Folder** lists a specific folder; clicking a file opens it in the editor as the target file. Also available via the Explorer right-click "Open in Design Studio".
- **Command** `Design Studio: Open Editor`: a file-independent tool window (starts from the sample). Saves through a save dialog.
- **Load external URL**: fetched by the extension host's SSRF-safe proxy (DNS IP pinning, private/metadata blocking, redirect re-validation, 25 MB cap) and rendered same-origin for editing.
- **Open local file/folder**: through VS Code's native dialogs.
- **Multilingual (en/ko/ja)**: default English; the language choice is persisted in `globalState`.
