# workspace-editor

Stage 6: the Euro-Office document editor as a right-sidebar tab in the DSH
window, with an agent tool that edits the same file.

## Which components are used

- **Euro-Office Lite** (`delmarguillen/euro-office-lite`, Tauri) is a
  third-party, local-only lightweight shell. It is not the Euro-Office desktop
  app; it is the reference for how the editor is hosted (`bridge.js`,
  `src-tauri/src/{x2t_task,converter,temp_layout}.rs`). Its Rust/Tauri half is
  **not** used.
- **Euro-Office `web-apps` + `sdkjs`** (`resources/euro-office`, built by the
  pinned Lite `setup.ps1`/`prepare-dist.ps1`) are the editor frontend and
  engine, served over HTTP by this plugin.
- **x2t** is the ONLYOFFICE converter binary that Euro-Office DesktopEditors
  ships: the Stage 5 setup extracts `converter/` and `editors/{web-apps,sdkjs}`
  from `Euro-Office-DesktopEditors-9.3.6` into `resources/euro-office-de`, and
  copies the converter to `%LOCALAPPDATA%\advodsh-eo\converter`. Fonts for the
  PDF renderer come from `x2t -create-allfonts` in the same folder.

No Euro-Office DesktopEditors UI or Tauri shell is used; only its converter and
its compiled editor resources for PDF export.

## Host half (`lib/index.js`, `lib/x2t.js`, `lib/docs.js`, `lib/docs-edit.js`)

Serves one origin under `ctx.webServer`:

| Route | Purpose |
|---|---|
| `GET /workspace-editor/host.html?doc=<id>` | Host page: shim, `api.js`, boot. |
| `GET /workspace-editor/shim.js`, `/boot.js` | `window.AscDesktopEditor` and the document loader. |
| `GET /workspace-editor/app/*` | `web-apps`, `sdkjs`, `fonts` from the Euro-Office release build (precompiled CSS), served `immutable`. `sdkjs/common/AllFonts.js` is answered with the generated font cache, which is what makes real documents render. |
| `POST /workspace-editor/api/open` | `{ path }` → `{ id, name, kind }`; DOCX is converted to `Editor.bin` in a per-document temp folder. |
| `GET /workspace-editor/api/info` | Name, kind, path, file mtime, modified flag. |
| `GET /workspace-editor/api/bin` | The bytes the editor opens. |
| `POST /workspace-editor/api/save` | Editor bytes → x2t → the document's own path, renamed atomically. |
| `POST /workspace-editor/api/save-as?path=` | Same, to another path. |
| `POST /workspace-editor/api/close` | Tab closed: drop the doc session and delete its temp folder. |
| `GET /workspace-editor/api/pdf` | DOCX → PDF through x2t with the font cache. |
| `GET /workspace-editor/api/font?path=` | Font bytes for the generated font list only. |
| `GET /workspace-editor/api/media/<doc>/<name>` | Per-document media folder for inserted images. |

Performance work is recorded in [`spike/stage6/PERFORMANCE.md`](../../spike/stage6/PERFORMANCE.md):
the release frontend removes the runtime LESS compile, fonts load on demand
instead of 389 synchronous preloads, static assets are immutable-cached, and a
closed tab returns the renderer to baseline (33 MB heap, 2.2 k nodes).

x2t runs as a child process, one conversion at a time, with a cleared temp
folder per run (stale state can return the previous document). Non-zero exits
carry stderr into the log and the caller's error.

The host half also registers **`document_edit`**: read a `.docx`, replace text,
append a paragraph, or replace a paragraph by index. The open editor tab polls
the file mtime and reloads when the agent changed it and the editor holds no
unsaved work.

## Client half (`lib/client.js`)

- Tab type `workspace-editor` with `keepMounted: true`, body registered in
  `sidebar.right.pane.tab`.
- **Edit** action on `.docx`, `.doc` and `.pdf` preview tabs
  (`sidebar.right.tab.document.actions`); it opens the editor tab with the file.
- Tab body: file name, **Reload**, **Export PDF**, and the host page in an
  iframe.

## Deviations and known gaps

- PDF editing (form fields, highlights, comments, outline) is not wired yet;
  the tab opens a PDF but the save path assumes Word documents.
- Unsaved-changes confirmation on tab close is not wired.
- Save As has a host route but no UI.
- Editor saves are not yet compared against Word's own save of the same file;
  the Stage 5 harness covers the converter, not the editor's save flow.
- Requirements for the browser session (authentication on these routes) follow
  the Host's normal route authentication; this was not separately proven.
- The release frontend is preferred when `resources/euro-office-de/editors`
  exists; without it the Lite build is served, which compiles LESS at runtime
  and is roughly 2 s slower per open.
- After a restart the tab restores the last document path (stored in
  localStorage); it does not re-open unsaved work.

## Setup

Stage 5 must have run `scripts/stage5/setup-x2t.ps1` first (converter, editors,
font cache). Then reload the dev Desktop; the plugin is already linked into the
isolated profile.
