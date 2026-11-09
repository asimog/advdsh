# Legal DOCX workspace inside DSH — current design

Status: current plan. One bundle package, several Cordis plugin rows, a vendored EuroOfficeLite editor in the right dock, a deterministic document engine for the agent, and a right-click selection gesture that stages text into the chat composer.

## Goal

A first-class legal DOCX workspace that lives inside DeepSeek Harness: the EuroOffice editor in the right dock, the agent driven from the chat pane, and a right-click gesture that stages document text into the composer for reasoning.

Done means:

1. The right dock hosts the vendored EuroOfficeLite editor (official EuroOffice `sdkjs`/`web-apps` with Lite's bridge and patches) with x2t conversion; the user edits there while the chat pane drives the agent.
2. The agent reads, searches, reasons over and edits the same document through focused tools on a deterministic in-memory model; every edit is atomic and the agent sees the current state after each edit.
3. The agent commits tracked changes (`w:ins`/`w:del`, distinct agent author). The open editor reloads in review/markup mode; the lawyer accepts or rejects in EuroOffice's review UI or through host-page review commands.
4. Right-click on a selection opens the shared DSH context menu; **Send to chat** stages a Markdown quote plus path and revision into the composer and focuses it; **Ask agent** stages and submits. Copy and the shipped file actions remain available.
5. Human saves and agent commits share one write path with a base-revision check and a per-document lease; a stale writer gets a conflict, never a silent overwrite.
6. Large documents force outline/search/context reads; small documents allow full reads. The agent self-reviews with `doc_diff`/`doc_check` before commit; page rendering is optional and gated.
7. Parallel editing works: sub-agents edit isolated forks, non-conflicting changes merge by stable block ID, conflicts return to the orchestrating agent.
8. Every plugin provides a service, listens to events and emits events; every contribution is a `ctx.effect`/`ctx.on` effect and unloads cleanly.

Non-goals: PDF text editing (open/display/export only), chart/SmartArt/shape/equation editing (preserved, not editable), cloud co-editing, a legal knowledge base, publication or registry changes.

## DSH mapping

| Need | DSH mechanism | Evidence |
|---|---|---|
| Right-dock editor | `ctx.sidebarRightTabs.register({id,kind,keepMounted,title,guide})`; keyed `sidebar.right.pane.tab` body; `sidebar.right.pane.tab.title`; Edit action on `sidebar.right.tab.document.actions`; close cleanup `ctx.sidebarRight.registerCloseHandler(kind, (sessionId, tab) => …)` | `docs/subsystems/sidebar-right.md`; `packages/client/ui-sidebar-right/src/client/contract/slots.ts`; `registerCloseHandler` in `service.ts` |
| Session context for the tab | The tab body is `scope:'session'`; standard props include `sessionId`, `useSession`, `useProjection`, `useAccess`, `useConversation`, `useInput`, `inputActions`; the registration `inject` factory also receives `sessionId` | `docs/subsystems/slots.md` standard-props table; `packages/client/ui-conversation/src/client/contract/slots.ts` |
| Right-click menu | `ctx.contextMenus.register({id,target,order,resolve})` + `ctx.contextMenus.open(target,{x,y})`; target value is untrusted JSON validated in `resolve`; icons `{key,src}` via `contextMenu.icon`; **not** `sidebar.right.tab.menu.item` and **no** hand-built popup | `packages/client/ui-context-menu/README.md`, `types.ts`, `registry.ts`; `docs/upgrade-guide/v0.2.2-alpha.2/context-menu-target/guide.md` |
| Iframe right-click | The editor page is same-origin but the text lives in nested frames; `boot.js` already walks frames, so it attaches `contextmenu` listeners per frame, reads `Asc.editor.asc_GetSelectedText(false)`, and relays one message to the parent. Only a non-empty selection is intercepted; empty selections keep EuroOffice's native menu. A native context-menu item is a later enhancement (`pluginMethod_AddContextMenuItem` requires a EuroOffice plugin guid) | `resources/euro-office/sdkjs/word/sdk-all-min.js`; `plugins/workspace-editor/lib/editor/boot.js` frame walk |
| Stage into chat (apply world) | `ctx.sessions.scope(sessionId)` → scope `get('conversation')` → `conversation.input.for(scope)` (`SessionInput`): `insertQuote(text)`, `focus()`, `submit()`, `notify()`. Fallback when the scope or service is unavailable: the tab body registers a session-keyed staging callback through the plugin's inject face, disposed with the tab. No global current composer, no effect pushing composer state | `packages/client/ui-conversation/src/client/contract/input.ts`; `.../input/hub.ts`; `docs/subsystems/slots.md` |
| Agent tools | Raw `ToolDefinition` through `ctx.tools.register` (the linked plugin cannot resolve `@deepseek-ai/dsh-tools`); canonical `output.schema` + `render`, `exec.signal`, `exec.agent`, optional `timeoutMs`, `presentCall`/`presentResult` | `docs/cookbook/adding-a-tool.md`; `docs/subsystems/tools.md`; `plugins/workspace-editor/lib/index.js` |
| Runtime context | `ctx.systemPrompt.context({name,order,text})`; numeric order is legal; scope the registration to the agent/session context | `docs/subsystems/system-prompt.md`; `packages/session/working-directory/src/index.ts` |
| Sub-agents | `ctx.subagents.startActivation({provider,label,request:{prompt,parent,cwd,maxDepth},signal,delivery:'caller'})`; `result`, `dispose()`; depth from `agent.session.header.delegationDepth` | `docs/subsystems/subagent.md`; `packages/subagent/tool-subagent/src/index.ts` |
| Editor process | `ctx.subprocess.spawn` runs the hidden-Electron Document Builder sidecar; the plugin owns one child process and awaits its exit on dispose | `docs/subsystems/subprocess.md` |
| SSE / routes | `ctx.webServer.register({kind,path,handler})` owns the response; gzip skips `text/event-stream`; every route calls `ctx.get('connection')?.requestRejection(req)` and verifies same-origin when the service exists; dispose force-closes held sockets | `docs/subsystems/web-server.md`; `packages/host/open-in-app/src/index.ts`; `packages/client/hmr/src/index.ts` |
| Files | `ctx.fs.resolve/stat/readBytes/watch` for bytes and change observation; writes only through the editor store | `docs/subsystems/filesystem.md` |
| Session lifecycle | `session/disposed` drops per-session state; `session/event` observes turns/tools; `agent/turn-stopping` flushes | `docs/subsystems/session.md`; `packages/deliverables/workspace-changes/src/index.ts` |
| Model-visible ⟺ logged | Tool results and the runtime-context snapshot are logged; the staged prompt is a normal user message; no hidden model input, no business field on `UserMessage`. Human accept/reject is not a session event; the agent learns it from the next tool read/diff | root `AGENTS.md`; `docs/defensive-patterns/conversation-and-session.md` |

Client-component rules applied: stable module-scope components, no `ctx` in components, narrow inject face (plain data/callbacks), no module-level `current`/`active`, declared stores built inside `apply`, no effects writing render-derived data, no `useLayoutEffect` by default, locale-owned copy, menus only through `ctx.contextMenus` (`docs/defensive-patterns/client-components.md`; `packages/client/AGENTS.md`).

## Packaging: one bundle, several Cordis plugin rows

One package, `workspace-editor`, keeps the component identity, one `engines.dsh` range and one compatibility gate. Its `cordis.patch.yml` inserts distinct rows for the following internal modules (package `exports` subpaths), each a normal Cordis plugin with its own `inject`/`apply`:

| Row | Module | Role | Provides | Consumes |
|---|---|---|---|---|
| `workspace-editor` | `lib/index.js` | EuroOffice host, file/revision authority, right-dock tab, selection menu | `ctx.editorDocuments`, store seam, `editor` tool, SSE/POST routes | `webServer`, `tools`, `fs`, `systemPrompt`, optional `connection`, client services |
| `workspace-docx-engine` | `lib/engine/index.js` | Document Builder sidecar (hidden Electron) | `ctx.docxEngine` | `subprocess`, `fs` |
| `workspace-docx-model` | `lib/model/index.js` | Sessions, stable IDs, forks, merge, lease, commit | `ctx.docxModel` | `docxEngine`, `editorDocuments`, `fs` |
| `workspace-docx-tools` | `lib/tools/index.js` | Agent tools + runtime context + lifecycle | `doc_*` tools | `tools`, `docxModel`, `editorDocuments` |
| `workspace-docx-fanout` | `lib/fanout/index.js` | Parallel editing | `doc_fanout` | `tools`, `docxModel`, `subagents` |
| `workspace-legal-review` | `lib/review/index.js` | Legal analyzers + playbook | `doc_analyze`, runtime skill | `tools`, `docxModel`, optional `skills` |

The client half stays one dynamic CJS bundle (`lib/client.js`, `dsh.client.platform: web`) with no `@deepseek-ai/*` value imports. Separate publishable bundles are a later split and need approval; until then one package, one gate.

## Architecture

```
Chat pane (DSH conversation)  ◀── staged quote / inputActions ──  right-dock tab (workspace-editor client)
        │                                                                  │
        │ agent tools                                                      │ iframe
        ▼                                                                  ▼
workspace-docx-tools ──▶ workspace-docx-model ──▶ workspace-docx-engine
        │                        │                    (sdkjs Document Builder, or own reduced model + x2t)
        │                        └──▶ editorDocuments (store, revisions, SSE, x2t)
        ▼
workspace-legal-review / workspace-docx-fanout ──▶ docx-model + ctx.subagents
```

## Editor surface: vendored EuroOfficeLite

Per `.agents/docs/eurooffice-hosting-assessment.md`, method B is chosen: vendor the EuroOfficeLite frontend stack (official EuroOffice `sdkjs`/`web-apps` at the pinned Lite commit, Lite's `bridge.js`/`editor-patches.js`/`font-patches.js`, the slim `src-dist`, and x2t). The release frontend (`resources/euro-office-de`) remains an optional performance override only when its sdkjs version matches the vendored builder.

- The host page/shim adapts Lite's `bridge.js` to the DSH plugin's HTTP routes: `AscDesktopEditor`, local file open, `LocalFileSave`, media URL, fonts, and the x2t task path.
- The editor opens with review configuration (`customization.review.{trackChanges,reviewDisplay,showReviewChanges}`, `permissions.review`) so tracked changes render and the lawyer can accept/reject.
- Host-page review commands use the editor API (`pluginMethod_AcceptReviewChanges`, `RejectReviewChanges`, `SetDisplayModeInReview`, `MoveToNextReviewChange`).
- No Tauri/Rust backend is used; printing, dictionaries and native file dialogs are DSH concerns or omitted.
- The vendored tree is committed as assets; it is never edited in place. Its version and build steps are recorded in the assessment and the plugin README.

## Agent document engine

The engine is the **official sdkjs Word Document Builder** (`resources/euro-office/sdkjs/word/apiBuilder.js`), proven headlessly in `spike/s0/docbuilder`: Electron 44.7.0, hidden window, open a DOCX, replace a paragraph, insert a numbered list item and a table row, save through x2t, verify the markers. It runs as a managed Electron sidecar behind `ctx.docxEngine`.

- **D1 — Document Builder (chosen).** The sidecar owns one hidden `BrowserWindow`, loads the vendored Lite editor page and the builder, and speaks request/response JSON over stdio. The plugin sends bytes and ops; the sidecar returns block descriptions, diffs and saved DOCX bytes. No filesystem or network access in the sidecar.
- **D2 — own reduced model (fallback).** A reduced in-memory representation with byte-preserving block anchors, stable IDs, deterministic ops, word diff and an OOXML tracked-change serializer, using x2t for DOCX↔Editor.bin. Used only if the builder cannot express a required operation (tracked-change serialization is the first candidate).

Either way the model contract is the same:

- **Two copies.** Immutable base bytes at open; mutable working state edited by the agent. The edit generator diffs base vs working at commit.
- **Stable IDs.** `w14:paraId` when present, otherwise a session ID; tool results carry ID and current engine index; edits carry expected ID and revision and fail with `STALE_TARGET` on drift. Forks and merges use IDs only.
- **Ops.** Curated legal ops: replace text, find/replace, insert/delete paragraph, insert list item, insert content, apply/define style, table row/column/cell ops, comments, footnotes, page setup, section breaks, accept/reject changes, properties. One op per `doc_edit` call; atomic and one undo step; style and numbering inferred deterministically from the anchor and style parts.
- **Tracked commit.** The builder turns on `ApiDocument.SetTrackRevisions(true)` before applying ops, and the sidecar's editor user is `agent:<session>`, so the saved DOCX carries the agent as the revision author. The human editor's own user is never swapped. S1 verifies `w:ins`/`w:del`, the author, and a Word open. D2's OOXML serializer is a fallback only for an operation the builder cannot track.
- **Edit style.** Prefer run-level edits (`ApiParagraph.AddText`, run properties) over `RemoveAllElements` + `AddText`, which drops the paragraph's run formatting.
- **Context modes.** Small documents allow a full read under a token/paragraph budget; large documents force outline/search/context.
- **Fidelity gate.** Unchanged block slices and package parts are byte-identical; changed block count equals re-serialized block count; `paraId`/`rsid` preserved; no duplicate `w:id`; output opens in Word and EuroOffice.

## Model service, lease and agent tools

`ctx.docxModel` sessions are keyed by `path + content hash`, not an opaque process id: `open(path,{baseRevision,bytes})`, `close` (idempotent), `rehydrate(hash)`, `describe`, `read`, `search`, `context`, `edit`, `undo`, `diff`, `check`, `revisions`, `fork`, `merge`, `commit`, `reload`. Tool handles carry the path and content hash.

**Lease.** `docxModel` owns one lease per path: `{ revision, editorDirty, holder }`. Agent commits and editor saves take the lease through `editorDocuments.applyBytes`. A commit while the editor is dirty or has advanced is refused with `DOC_EDITOR_DIRTY` or `DOC_STALE_BASE`; the agent can ask the editor to save, reload, or rebase. The staged quote records the revision the tab loaded and whether the tab was dirty.

| Tool | Behavior |
|---|---|
| `doc_open` (path) | Opens through `editorDocuments` (shared revision) or bytes; returns handle, path, content hash, revision, mode, outline, token count |
| `doc_read` (doc, mode: outline/range/search/context) | Annotated `[id] text` blocks; full read only under `DOC_FULL_READ_TOKENS` (default 20000) and `DOC_FULL_READ_PARAGRAPHS`, otherwise `DOC_TOO_LARGE` with a mode hint |
| `doc_edit` (doc, op, fields) | One atomic op; affected blocks, IDs+indexes, compact diff |
| `doc_diff` (doc) | Model-friendly change set from the op log |
| `doc_check` (doc) | Engine codes + legal findings |
| `doc_commit` (doc, mode) | Serialize; `editorDocuments.applyBytes(path, bytes, {baseRevision, lease})`; returns revision/applied; stale/dirty → structured error |
| `doc_state` (doc?, action: status/revisions/reload/close/wait) | Status, pending revisions, reload after a human change, idempotent close, wait for a revision |
| `doc_render` (doc, pages) — optional | Page PNGs through x2t/PDF and the vetted rasterizer, admitted as image content; gated on rasterizer approval |
| `doc_analyze` (doc, checks?) | Legal findings |
| `doc_fanout` (doc, tasks[]) — optional | Fork/merge over `ctx.subagents`; the generic `workflow` tool remains available |
| `editor` (action) | Session control only: status/open/save/reload/export_pdf/wait/review; never edits text |

`doc_edit`/`doc_diff`/`doc_commit` carry `presentCall`/`presentResult` cards (a diff card and a commit card) derived from raw events and persisted metadata, so replay renders without live state. Runtime context `document-model:open` (order 130, optional) reports one line per open document under the agent's cwd: path, content hash, revision, block count, read mode, editor dirty/conflict, pending revisions. Write tools are env-gated (`WORKSPACE_DOCX_WRITE=off`).

## EuroOffice integration

- **Vendored Lite editor**: `web-apps`/`sdkjs` from the vendored tree served by `ctx.webServer`; x2t for DOCX↔Editor.bin and live-byte PDF. The release frontend is an optional override after a version-match check.
- **Review config:** `editorConfig.customization.review = {trackChanges:true, reviewDisplay:'markup', showReviewChanges:true}`, `permissions.review = true`, `permissions.edit = true`.
- **Commit path:** agent `doc_commit` → tracked DOCX bytes → `editorDocuments.applyBytes` → lease + base check → atomic store write → Editor.bin refresh → SSE `reload` → editor shows tracked changes → `editor-documents/saved`.
- **Human path:** editor save → shim sends bytes + loaded revision → `applyBytes` → new revision → open model session marked stale; commit refuses and offers reload/rebase.
- **Conflicts:** external write or stale save → `editor-documents/conflict`; the tab disables Save and offers Reload; no silent overwrite.
- **`applyBytes` is our service method**, not a EuroOffice API: it writes the file through the store and triggers a controlled reload. There is no in-editor byte patch and no editor-user swap; authorship is in the tracked-change author.
- **Store seam:** `ctx.get('editorDocumentsStore')` optional; default local store writes in place with a SHA-256 revision and base check; a revision-store adapter can write versioned files. All writes go through it.
- **Wire:** `GET /workspace-editor/events` (SSE, snapshot first, then document/editor/command frames), `POST /api/editor`, `POST /api/command`; `bin` reconverts stale `Editor.bin`; save/save-as carry `base`; every route calls `requestRejection` when `connection` exists, and SSE aborts on request close and plugin dispose.

## Right-click selection → chat

1. `boot.js` attaches `contextmenu` listeners to the host document and every nested editor frame it already walks. On a non-empty `Asc.editor.asc_GetSelectedText(false)`, it `preventDefault()`s and `postMessage`s `{type:'workspace-editor/selection', x, y, text, dirty}` to the parent. Empty selections keep the native EuroOffice menu.
2. The tab body validates `event.source === iframe.contentWindow` and the origin, maps the point to the app viewport, builds the target from its doc state, and calls the injected `openMenu(target, point)`.
3. `apply` registers one contribution with `ctx.contextMenus.register({id:'workspace-editor.selection', target:'eurooffice', order:100, resolve})`. The target value is `{sessionId, path, revision, text, dirty}`, validated as untrusted JSON in `resolve`.
4. `resolve` returns localized actions when `text` is non-empty: **Send to chat** (stage), **Ask agent** (stage + submit), **Copy** (clipboard), plus the shipped file actions that resolve for this target. Icons are `{key,src}` through `contextMenu.icon`.
5. `run` calls a shared `stage(value, submit)` helper in `apply`:
   ```js
   const scope = ctx.sessions.scope(value.sessionId)
   const conversation = scope?.get('conversation')
   if (scope === undefined || conversation === undefined) return
   const input = conversation.input.for(scope)
   const quote = `> ${truncate(value.text, 8000)}\n\nFrom \`${value.path}\` at revision ${value.revision}` +
     `${value.dirty ? ' (editor has unsaved changes)' : ''}.\n`
   if (!input.insertQuote(quote)) { input.notify('error', t('stage.failed')); return }
   if (submit) input.submit()
   input.focus()
   ```
   `insertQuote` is the atomic quote path; `focus` returns the keyboard to the composer; `submit` uses the composer's own queue/steer policy and Host authorization; `notify` reports a blocked or locked composer. If `sessions.scope` or `conversation.input` is unavailable, the tab body's session-keyed staging callback is the fallback, disposed with the tab.
6. The staged text is a normal user message when sent: no business field on `UserMessage`, no new source kind. The agent sees the quote, path, revision and dirty flag, then uses `doc_open`/`doc_read`/`doc_search` from that revision.
7. The menu is the shared DSH menu; the contribution is registered by the plugin fiber and removed on unload. The component never sees `ctx`; its inject face exposes only `openMenu`.

## Parallel editing

`doc_fanout(doc, tasks[], concurrency?)`: for each task, `docxModel.fork(doc, label)` creates an isolated engine session; start one child with `ctx.subagents.startActivation({provider:'spawn', label, delivery:'caller', signal:exec.signal, request:{prompt, parent:exec.agent, cwd, maxDepth}})`, where `maxDepth` is set only when the provider exposes `depthLimit`, computed from `exec.agent.session.header.delegationDepth + 1`. The prompt names the fork and forbids further delegation. Await results with bounded concurrency (default 3), isolate per-task failures, `dispose()` on cancellation.

Merge into the parent by stable block ID: unchanged in a fork takes the other side; changed in one applies; identical changes apply once; different changes to one block, delete-vs-edit, or ambiguous insertion at one anchor become conflicts `{id, base, candidates:[{taskId,text}]}`; non-conflicting insertions at one anchor keep task order. Merge is deterministic. Children cannot commit; the parent commits once. This wraps `ctx.subagents`; the generic `workflow` tool remains available for model-written scripts.

## Legal reasoning

`workspace-legal-review` provides `doc_analyze(doc, checks?)` and the `legal-document-review` runtime skill (`ctx.skills.register`). Checks: heading/outline sequence and level skips; TOC vs headings; list numbering continuity/restarts; defined terms and first use; undefined abbreviations; cross-reference targets; duplicate/empty headings; citation-pattern shape (configurable, Indian Supreme Court patterns by default); fields without results; pending revisions; unresolved comments; placeholder text; broken bookmarks; empty paragraphs; tables without headers. Findings carry stable codes, block IDs, severity, message, snippet and an optional suggestion. The skill playbook: outline → analyze → targeted search/context → edit → diff → check → commit; cite document blocks, never invent authorities.

## Flows

**Agent edit and lawyer review.** Open (shared revision) → read/search/context → one-op edits → diff → check → commit (tracked) → lease/base check → store write → Editor.bin refresh → SSE reload → editor review/markup → lawyer accepts/rejects → save → new revision → model session stale.

**Lawyer edit while the agent works.** Editor modified → SSE `editor-state` → agent context shows dirty/revision → editor save → store revision → model marked stale → agent reloads/rebases or gets a conflict.

**Selection reasoning.** Right-click → shared menu → Send to chat → composer has the quote + path + revision + dirty → user adds instructions and sends → agent opens the same revision and reasons/edits.

**Parallel drafting.** Orchestrator `doc_fanout` → forks → children edit isolated copies → merge → conflicts → orchestrator resolves → one commit.

**Commit safety.** Every write carries a base revision and a lease; stale/dirty writes are rejected; failed commits write nothing; an interrupted commit is re-read and reconciled, never replayed blindly.

## Stages, gates and write scopes

| Stage | Deliverable | Gate |
|---|---|---|
| S0 | Vendored Lite editor boots in the right dock; frame selection bridge; shared context menu; composer staging; Document Builder headless spike | Editor boots from the vendored tree; menu opens at the pointer; staging reaches the composer; builder spike passed (`spike/s0/docbuilder/REPORT.md`); no DSH source edit |
| S1 | Engine behind `ctx.docxEngine`: Electron builder sidecar, block descriptions, ops, diff, tracked serializer, fidelity harness | Open/edit/diff/commit round trip; Word and EuroOffice open; IDs stable |
| S2 | Model + tools: sessions keyed by path+hash, lease, modes, forks/merge, `doc_*` tools | Agent workflow on `TRO - Motion.docx` and a 100-page document; context-mode enforcement; stale/dirty commit errors |
| S3 | EuroOffice commit/review: `applyBytes`, review mode, accept/reject, SSE, conflicts, `editor` tool | Agent edit → tracked changes visible → accept → save; human edit → conflict |
| S4 | Fan-out and merge | Two children, one clean merge and one conflict; cancellation/dispose |
| S5 | Legal review + skill | Planted defects found with stable codes; skill installed and used |
| S6 | Hardening, packaging, docs, records | Full acceptance run; dispose leaves no SSE, watchers or forks |

S1 is the critical path: S0 proved the builder runs headlessly, so the remaining risk is the sidecar contract, the op surface and tracked-change serialization.

## Testing and evidence

- **Unit (`node --test`):** engine golden/byte tests and fidelity gates; model ID mapping, op validation, stale targets, lease, undo, diff/merge; tool schemas and result bounds; fan-out merge/conflict; review analyzers; composer staging helper and menu `resolve`/`run` with fake `ctx.sessions`/`ctx.contextMenus`/`conversation.input`.
- **Browser e2e (CDP, dev Desktop):** open the right-dock editor; right-click a selection → shared menu → Send to chat → composer contains the quote + path/revision/dirty; Ask agent submits; agent edits and commits; editor reloads in markup with tracked changes; accept all → save; human edit → stale/dirty commit conflict; fan-out with two children.
- **Fidelity evidence:** byte diff + locality count + `paraId`/`rsid` assertions; Word open sweep and EuroOffice page renders.
- **Performance evidence:** open/apply/commit timings on the large corpus; no polling.
- **Cleanup:** plugin dispose ends SSE responses, closes `ctx.fs.watch` watchers, rejects pending calls, clears forks and temp files.

## Conflict resolutions

| # | Conflict | Resolution |
|---|---|---|
| 1 | Engine dependency unverified | Vendor the EuroOfficeLite sdkjs and prove the Document Builder headlessly in S0; fall back to the own reduced model (D2) in the same seam |
| 2 | `inputActions` not reachable from a global menu `run` | Apply-world `ctx.sessions.scope(sessionId).get('conversation').input.for(scope)`; tab-registered session-keyed staging callback as fallback |
| 3 | Editor process lifecycle | In-process engine; a worker process only if the builder requires one, spawned through `ctx.subprocess` with awaited quiescence |
| 4 | Plugin routes unauthenticated | `requestRejection` on every `/workspace-editor` route, same-origin check, SSE abort on dispose; typert Remote not feasible for the hand-authored bundle |
| 5 | Selection gesture targets the wrong object | Host-page frame listeners + verified `postMessage` relay; sdkjs `asc_GetSelectedText` inside the editor frame; only non-empty selections intercept |
| 6 | `applyBytes` does not exist | It is our service method: store write + controlled reload, not an in-editor byte patch; authorship is in the tracked-change author |
| 7 | Two writers, no lease | Per-path lease in `docxModel`; dirty/advanced editor blocks commit; reload after a clean checkpoint; quote records revision and dirty |
| 8 | Human editor state unlogged | Model-visible facts only through logged tool results and the logged runtime-context snapshot; no new `SessionEventMap` event |
| 9 | `doc_fanout` duplicates workflow | Focused domain tool over `ctx.subagents`; generic `workflow` remains |
| 10 | Stable IDs vs engine indexes | Model mints and persists IDs; results carry ID+index; edits carry expected ID+revision and fail loud |
| 11 | Multiple packages vs component workflow | One bundle package with several Cordis rows, one `engines.dsh` and one gate |
| 12 | Process-local sessions vs replay | Key by path+content hash; lazy rehydrate; idempotent close |
| 13 | Custom menu target kind | Plain runtime string; validate target value as untrusted JSON |
| 14 | Tool surface and rendering unproven | ~9 core tools plus optional `doc_render`; add `presentCall`/`presentResult` cards in the same change |

## Risks

- The Document Builder headless spike may fail; the fallback is the own reduced model, which is more work but stays inside the same service seam.
- The vendored Lite tree is large and its build is version-sensitive; the release frontend is an override only after a version-match check.
- Nested editor frames make the selection bridge application-level.
- Composer staging depends on a plain, mounted composer; the fallback callback covers the unmounted case.
- One editor per document; PDF is display/export only; `doc_render` depends on rasterizer approval.

## Records

- `.agents/docs/eurooffice-hosting-assessment.md` — why EuroOfficeLite is vendored and how the engine choice is gated.
- Per-row README sections in `plugins/workspace-editor/README.md` — routes, services, events, tools, env vars, limits.
- `.agents/logs/2026-11-10-legal-docx-workspace.md` and `.agents/prompts/2026-11-10-successor-legal-docx-workspace.md` — session record and successor brief.
