# workspace-editor

Version 0.3.0. The bundle provides the document model, agent tools, fan-out and
legal review beside the Euro-Office editor; see the row sections below.

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

## Host half (`lib/index.js`, `lib/x2t.js`, `lib/docs.js`)

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

The host half owns the document write authority: every agent and editor write
goes through `ctx.editorDocuments`, the lease and the store. The retired
whole-file writer is not registered.

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
  cancelled request is reported to the caller. A crashed sidecar writes
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
  crash/restart, sidecar-survives-cancel and awaited exit. The saved package is
  also checked for unique `w:ins`/`w:del` `w:id` values and unique `w14:paraId`
  values. It writes `lib/engine/out/verification.json` and exits non-zero on a
  failed check.

## Model half (`lib/model/`, row `workspace-docx-model`)

The model row provides **`ctx.docxModel`**, the per-activation document session
service the agent tools use. Sessions are keyed by absolute path + SHA-256
content hash; re-opening the same bytes reuses the handle, and a changed file
mints a new one.

- **Surface.** `open`, `describe`, `read`, `search`, `context` (as read modes),
  `edit`, `undo`, `diff`, `check`, `revisions`, `commit`, `reload`, `close`,
  `rehydrate`, `status`, `statusLines`, plus lease notes from editor events.
- **Stable targets.** Edits target a block id (`w14:paraId` when the block has
  one, else a session id) or index, carry the expected text, and fail with
  `DOC_STALE_TARGET` when the block changed. One op per call; the op log keeps
  the inverse for `undo`.
- **Read budget.** A full read is allowed only under `DOC_FULL_READ_TOKENS`
  (default 20,000) and `DOC_FULL_READ_PARAGRAPHS` (default 400); above that the
  model reports `DOC_TOO_LARGE` and the agent uses outline, range, search or
  context.
- **Lease and commit.** One lease per path. `commit` serializes through the
  engine, re-reads the editor document, and refuses a dirty editor
  (`DOC_EDITOR_DIRTY`) or a base revision that moved (`DOC_STALE_BASE`) before
  writing anything. The write goes through `editorDocuments.applyBytes`, so the
  open tab reloads from it; after a commit the engine session rebases on the new
  bytes and the change set is empty.
- **Write gate.** `WORKSPACE_DOCX_WRITE=off` disables edits and commits with
  `DOC_WRITE_DISABLED`; the tools row also omits `doc_edit`/`doc_commit`.
- **Verification.** `node lib/model/verify.mjs` runs the model over the real
  engine and document store: reads, tracked replace + list item, diff, check,
  fork/merge, commit, OOXML markers/author, reload, dirty and stale refusals. It
  writes `lib/model/out/verification.json` and exits non-zero on a failed check.
  `scripts/verify-word-open.ps1 -Docx <file> -Marker <text>` opens the saved DOCX
  through Word COM with alerts and macros disabled and asserts it opens with its
  tracked revisions; it writes a log and exits non-zero on failure.

## Tool half (`lib/tools/`, row `workspace-docx-tools`)

The tools row registers the model-facing `doc_*` tools, the runtime context and
the write gate:

| Tool | Purpose |
|---|---|
| `doc_open` | Open a path into a session; returns handle, content hash, revision, read mode and outline. |
| `doc_read` | Read in `auto`/`full`/`outline`/`range`/`search`/`context` mode as annotated `[blockId] text`. |
| `doc_search` | Phrase search with block ids and snippets. |
| `doc_edit` (gated) | One atomic tracked op: paragraph replace/insert/delete, list item, table row insert/delete. |
| `doc_diff` | Working document against its base revision, with block ids. |
| `doc_check` | Uncommitted changes plus registered analyzer findings with stable codes. |
| `doc_commit` (gated) | Serialize and write through the store under the lease's base check. |
| `doc_state` | `status`, `revisions`, `reload`, `close`. |
| `editor` | Editor session control only: `status`, `open`, `save`, `reload`, `export_pdf`, `wait`, `review` commands. |

`doc_edit`, `doc_diff` and `doc_commit` carry replayable presenter
cards projected from persisted result metadata. Runtime
context `document-model:open` (order 130) lists one line per open agent document
under the agent's cwd: handle, path, revision, base, block count, read mode,
editor state and pending ops. Unloading the row removes every tool and the
context through the registration effects.

## Review half (`lib/review/`, row `workspace-legal-review`)

The review row registers legal analyzers on `ctx.docxModel`, the `doc_analyze`
tool and the `legal-document-review` runtime skill. Analyzers are pure functions
over described blocks, so `doc_check` and `doc_analyze` share one finding set.

| Finding code | What it reports |
|---|---|
| `HEADING_LEVEL_SKIP` / `HEADING_EMPTY` / `HEADING_DUPLICATE` | Outline defects: a level jump, a heading with no text, repeated heading text. |
| `TOC_MISMATCH` | A table-of-contents entry with no matching heading. |
| `LIST_LEVEL_JUMP` | A numbered list item more than one level below its predecessor. |
| `DEFINED_TERM_ORDER` | A quoted defined term used before its definition. |
| `UNDEFINED_ABBREVIATION` | An abbreviation whose first use is not introduced in parentheses; all-caps headings are skipped and citation markers are excluded. |
| `CROSS_REFERENCE_MISSING` | An `Exhibit`/`Annexure`/`Schedule` reference with no target heading or leading block. |
| `CITATION_SHAPE` | A reporter citation that does not match the configured pattern (Indian Supreme Court `SCC`/`AIR` by default). |
| `PLACEHOLDER_TEXT` | `TBD`, `TODO`, `[insert …]`, `<<…>>` and similar text left in the document. |
| `EMPTY_PARAGRAPH_RUN` | Three or more consecutive empty paragraphs. |
| `TABLE_HEADER_MISSING` | A table whose first row has no text. |

Findings carry a stable code, a severity, a message and the affected block ids.
`doc_analyze` can be limited to specific codes and never reports the
`PENDING_REVISIONS` finding (that belongs to `doc_check`). The skill is
registered only when the host mounts a skills service; the row's `legalReview`
service exposes the code list, analyzer set and playbook.

## Fan-out half (`lib/fanout/`, row `workspace-docx-fanout`)

`doc_fanout(doc, tasks[], concurrency?)` runs several child agents on isolated
forks and merges the results into the parent by stable block id, so a parent can
review one merged change set and commit once:

1. `docxModel.fork(doc, label)` serializes the working state and opens it as an
   isolated engine session. Forks cannot commit; only the parent does.
2. One child per fork starts through `ctx.subagents.startActivation` with
   `provider: 'spawn'`, `delivery: 'caller'`, the parent Agent, its cwd and (only
   when the provider supports `depthLimit`) a depth cap of
   `delegationDepth + 1`. Children edit their own fork handle.
3. At most `concurrency` children run at once (default 3, max 8). A failed or
   cancelled child is isolated: the others still complete.
4. `docxModel.merge(doc, forks)` compares base, parent and each fork by block id.
   Unchanged-in-a-fork takes the other side; a change present in one fork or
   identical in several applies; a different change on both sides, delete-vs-edit
   or distinct changes to one block return as conflicts with each candidate.
   Non-conflicting changes still apply and insertions at one anchor keep task
   order.
5. Forks close after the merge; the parent reviews `doc_diff`/`doc_check` and
   commits with `doc_commit`.

`doc_fanout` is registered only when writes are enabled. Fork/merge need stable
block ids, so paragraphs use `w14:paraId` and tables use a header-derived id that
survives save/reopen; identical tables in one document share an id.

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
  document path, the content revision the tab loaded (SHA-256, falling back to
  the file mtime) and the dirty flag through the session's composer input
  (`insertQuote`, `focus`, `submit`); Copy uses the clipboard.
- The tab reloads on a shared `events` SSE document-reload frame for its path
  (and surfaces a `conflict` frame); a 4 s `/api/info` poll remains as the
  fallback when `EventSource` is unavailable. The host page consumes the same
  channel for review command frames and reports editor state back on
  `POST /api/editor`.

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

All six rows are implemented: Euro-Office host, engine, model, tools, fan-out and
legal review, under one bundle patch, one ngines.dsh range and one gate.

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
- The whole-file writer is retired; writes go through `doc_edit`, `doc_commit` and `ctx.editorDocuments`.
- Legal analyzers are structural and textual only: fields, comments, bookmarks and
  tracked-change metadata are not inspected yet.
- `replace_paragraph` is reliable on a paragraph without revision marks. On a
  paragraph that already carries tracked revisions the builder range can split
  and the call can append the new text instead of replacing; use
  `insert_paragraph` plus `delete_paragraph`, or accept/reload the document
  first. The engine verifier covers the clean path only.
- The fan-out row is implemented and unit-tested; the live acceptance run
  reported both forks completed and one merged change with no conflicts, but the
  document used had no target for one task, so a live two-child conflict run is
  still worth adding to the record.
- The engine sidecar's DOCX round trip is verified on the fixture, including
  tracked `w:ins`/`w:del` with the agent author, `w14:paraId` stability across
  a save/reopen, a Word-open sweep with the tracked revisions intact, and unique
  `w:id`/`w14:paraId` values in the saved package.
- After a restart the tab restores the last document path (stored in
  localStorage); it does not re-open unsaved work.

## Setup

Stage 5 must have run `scripts/stage5/setup-x2t.ps1` first (converter, editors,
font cache). Then reload the dev Desktop; the plugin is already linked into the
isolated profile.

Check the engine and the model without the app:

```powershell
node plugins/workspace-editor/lib/engine/verify.mjs --with-hooks
node plugins/workspace-editor/lib/model/verify.mjs
node --test "plugins/workspace-editor/test/*.test.mjs"
```

The verifiers need the vendored frontend, x2t and an Electron binary (they fall
back to `process.execPath` inside Electron, otherwise `spike/editor-host`'s
Electron).
