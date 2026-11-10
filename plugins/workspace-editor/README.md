# workspace-editor

Stage 6: the Euro-Office document editor as a right-sidebar tab in the DSH
window, with an agent tool that edits the same file and a right-click selection
gesture that stages document text into the chat composer.

The vendored Euro-Office **Lite** frontend (`resources/euro-office`) is the
default because it ships the Document Builder the agent engine uses. The
release frontend (`resources/euro-office-de/editors`) is an override for a
version-matched performance run: set `WORKSPACE_EDITOR_FRONTEND` to it.

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

## Engine half (`lib/engine/`, row `workspace-docx-engine`)

The engine row provides **`ctx.docxEngine`**: a hidden-Electron sidecar that runs
the official sdkjs Word Document Builder from the vendored Lite tree
(`resources/euro-office/sdkjs/word/apiBuilder.js`) and converts through x2t.

- **Process.** One hidden Electron child, spawned through `ctx.subprocess` (the
  verification harness passes Node's `child_process` instead). It loads the
  vendored editor page, opens a DOCX as `Editor.bin`, and owns one hidden
  `BrowserWindow` per session. Each run gets its own temp root and log files.
- **Wire.** stdout carries one `ready` frame (protocol 1, loopback RPC port and
  token) and sidecar events; every request is a JSON POST to
  `http://127.0.0.1:<port>/engine-rpc` with an `x-engine-token` header. Electron
  child stdin is not used because it is unreliable on Windows.
- **Requests.** Per-request id, timeout and `AbortSignal`; a timed-out or
  cancelled request aborts inside the sidecar. A crashed sidecar writes
  `crash.log`, marks its sessions lost and restarts (limit 10). `dispose()`
  sends shutdown, then terminates and awaits the exit. `status().ready` is true
  only when the RPC listener accepts requests; `running` is the process range.
- **Service surface.** `open`, `describe`, `apply`, `diff`, `save`, `close`, and
  a read-only `status()`. Blocks carry a stable id (`w14:paraId` when present,
  else `p:<serial>`), an engine index, kind, text and style/numbering facts.
  Edits carry the expected text and fail with `ENGINE_STALE_TARGET` on drift.
  `save` returns DOCX bytes/hash and writes the destination atomically.
- **Tracked changes.** The sidecar enables `ApiDocument.SetTrackRevisions(true)`
  and edits as author `agent:<session>`, so the saved DOCX carries `w:ins`/
  `w:del` attributed to the agent. The human editor's user is never swapped.
- **Env overrides.** `WORKSPACE_EDITOR_ENGINE_ELECTRON`,
  `WORKSPACE_EDITOR_ENGINE_EO_ROOT`, `WORKSPACE_EDITOR_ENGINE_X2T` (or
  `WORKSPACE_EDITOR_X2T`), `WORKSPACE_EDITOR_ENGINE_TEMP`,
  `WORKSPACE_EDITOR_ENGINE_LOGS`, and the `..._STARTUP_TIMEOUT_MS` /
  `..._TIMEOUT_MS` / `..._OPEN_TIMEOUT_MS` / `..._SAVE_TIMEOUT_MS` /
  `..._SHUTDOWN_TIMEOUT_MS` overrides. Without a binary the row still loads and
  every call rejects with `ENGINE_UNAVAILABLE` plus the tried paths.
  `WORKSPACE_EDITOR_ENGINE_TEST_HOOKS=1` enables the crash/timeout hooks.
- **Verification.** `node plugins/workspace-editor/lib/engine/verify.mjs
  --with-hooks` opens the fixture, applies a tracked replace plus a list item and
  a table row, saves through x2t, asserts the OOXML markers and the agent author,
  reopens the saved DOCX, then exercises cancelled open, stale target, timeout,
  crash/restart, sidecar-survives-cancel and awaited exit. It writes
  `lib/engine/out/verification.json` and exits non-zero on a failed check.

## Client half (`lib/client.js`)

- Tab type `workspace-editor` with `keepMounted: true`, body registered in
  `sidebar.right.pane.tab`.
- **Edit** action on `.docx`, `.doc` and `.pdf` preview tabs
  (`sidebar.right.tab.document.actions`); it opens the editor tab with the file.
- Tab body: file name, **Reload**, **Export PDF**, and the host page in an
  iframe.
- Right-click on a non-empty selection inside the editor: the host page relays
  the selection; the tab opens the shared DSH context menu with **Send to
  chat**, **Ask agent** and **Copy**. Send/Ask stage a Markdown quote plus the
  document path, revision and dirty flag through the session's composer input
  (`insertQuote`, `focus`, `submit`); Copy uses the clipboard.

## Bundle rows (`cordis.patch.yml`)

One package inserts several Cordis rows, one `engines.dsh` and one gate:

| Row | Module | Role |
|---|---|---|
| `workspace-editor` | `lib/index.js` | Euro-Office host, routes, right-sidebar tab type |
| `workspace-docx-engine` | `lib/engine/index.js` | deterministic document engine seam (`ctx.docxEngine`) |
| `workspace-docx-model` | `lib/model/index.js` | document sessions, lease, forks, commit |
| `workspace-docx-tools` | `lib/tools/index.js` | agent `doc_*` tools and runtime context |
| `workspace-docx-fanout` | `lib/fanout/index.js` | parallel editing over sub-agents |
| `workspace-legal-review` | `lib/review/index.js` | legal analyzers and review skill |

The engine row is implemented; the model, tools, fan-out and review rows are
placeholders in this version. They load so the patch and package exports are
stable.

## Deviations and known gaps

- PDF editing (form fields, highlights, comments, outline) is not wired yet;
  the tab opens a PDF but the save path assumes Word documents.
- Unsaved-changes confirmation on tab close is not wired.
- Save As has a host route but no UI.
- Editor saves are not yet compared against Word's own save of the same file;
  the Stage 5 harness covers the converter, not the editor's save flow.
- Requirements for the browser session (authentication on these routes) follow
  the Host's normal route authentication; this was not separately proven.
- The vendored Lite frontend compiles LESS at runtime, so the first open is
  slower than the release build. Set `WORKSPACE_EDITOR_FRONTEND` to the
  release editors path for a version-matched performance run.
- The engine row provides `ctx.docxEngine`, but the `doc_*` agent tools, the
  document model, fan-out and legal review are still placeholders;
  `document_edit` remains the only agent edit path.
- The engine sidecar's DOCX round trip is verified on the fixture, including
  tracked `w:ins`/`w:del` with the agent author. A Word-open sweep and a
  duplicate-`w:id`/`paraId` fidelity sweep are not part of the harness yet.
- After a restart the tab restores the last document path (stored in
  localStorage); it does not re-open unsaved work.

## Setup

Stage 5 must have run `scripts/stage5/setup-x2t.ps1` first (converter, editors,
font cache). Then reload the dev Desktop; the plugin is already linked into the
isolated profile.

Check the engine without the app:

```powershell
node plugins/workspace-editor/lib/engine/verify.mjs --with-hooks
```

It needs the vendored frontend, x2t and an Electron binary (it falls back to
`process.execPath` inside Electron, otherwise `spike/editor-host`'s Electron).
