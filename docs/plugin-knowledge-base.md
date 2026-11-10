# Plugin knowledge base — building DSH plugins in advodsh

Status: current for `dsh@0.2.2-rc.1`. Upstream paths are relative to
`upstream/deepseek-harness/`. This page is the working guide for this workspace; the
current plugin's own contract is `plugins/workspace-editor/README.md`.

## What a plugin is

A DSH plugin is a Cordis plugin: a package that mounts into the shared context and
registers contributions there. A **bundle** is a package that inserts several plugin rows
through `cordis.patch.yml`; that is this workspace's preferred shape. The current plugin
is one bundle with six rows (editor host, engine, model, tools, fan-out, review).

## Package anatomy

`package.json` fields that matter:

| Field | Meaning |
|---|---|
| `name`, `version` | Package identity and semver. Bundle `private: true` while it is local. |
| `type: "module"`, `main` | ESM host entry. |
| `exports` | Host subpaths (`./engine`, `./model`, ...) plus `./client`; row `name` values resolve through this map. |
| `dsh.bundle.patch` | Path to the bundle's `cordis.patch.yml`, e.g. `./cordis.patch.yml`. |
| `dsh.client.platform` | `web` when the package ships a client module. |
| `engines.dsh` | DSH version range, e.g. `>=0.2.0 <0.3.0`; the installed runtime is checked against it. |
| `files` | What is published: host entries, client bundle, row patches, docs, engine files. |

A row is a plugin module with named exports:

```js
export const name = 'workspace-docx-model'
export const inject = ['docxEngine', 'editorDocuments']   // or { required, optional }
export function apply(ctx) {
  const model = createModel(...)
  ctx.effect(() => ctx.provide('docxModel', model), 'workspace-docx-model.service')
  ctx.effect(() => () => model.dispose(), 'workspace-docx-model.dispose')
  ctx.on('editor-documents/saved', (payload) => model.noteSaved(payload.path, payload.revision))
}
```

Do not default-export a function plugin; the Loader discards its namespace. Use
`ctx.get(name)` for optional services, never the property proxy.

## Host extension points

| Need | API | Reference |
|---|---|---|
| Agent tool | `ctx.tools.register({ name, description, parameters, output: { schema, render }, execute })` | `docs/subsystems/tools.md`, `docs/cookbook/adding-a-tool.md` |
| Prompt context | `ctx.systemPrompt.context({ name, order, interpolate, text })`; scope to one agent with `agent.ctx.systemPrompt.context` | `docs/subsystems/system-prompt.md` |
| HTTP route / SSE | `ctx.webServer.register({ kind: 'exact' \| 'prefix', path, handler })`; plugin-owned SSE is the established pattern | `docs/subsystems/web-server.md` |
| Route auth | Call `ctx.get('connection')?.requestRejection(req)` yourself; the carrier does not authenticate plugin routes | `docs/subsystems/web-server.md`, `packages/client/connection` |
| Child process | `ctx.subprocess` with explicit stdio, abort-driven terminate, `waitForExit()` and an awaited dispose | `docs/subsystems/subprocess.md` |
| Sub-agents | `ctx.subagents.startActivation({ provider, label, request: { prompt, parent, cwd, maxDepth }, signal, delivery })`; then `result` and idempotent `dispose()` | `docs/subsystems/subagent.md` |
| Files | `ctx.fs` (`resolve`, `stat`, `readText`, `writeText`, `editText`, `moveFile`, `watch`); `resolve` is a cwd default, not containment | `docs/subsystems/fs.md` |
| Durable state | `ctx.storage` / `ctx.storageDomain` | `docs/subsystems/storage.md` |
| Skills | Register through the skills service, or ship a filesystem skill | `docs/subsystems/skills.md` |
| Session lifecycle | `session/disposed`, `session/event`, `agent/pre-step`, `agent/turn-stopping`, `tools/pre-execute`, `tools/result` | `docs/subsystems/session.md`, `docs/agent-lifecycle.md` |

Tool contract in practice:

- `parameters` and `output.schema` are JSON schemas; `render` returns presentation blocks.
- `execute(args, exec)` receives `exec.agent` and `exec.signal`. Long work must observe the
  signal and settle after quiescence.
- `presentCall` / `presentResult` / `presentationMeta` are optional; design the card or
  replay view when you add the tool, not afterwards.
- Tool text and results are model-visible and logged. Anything model-visible that comes
  from outside the tool result (prompt context, session event) must be reconstructable from
  the session log; do not invent unlogged model-visible state.
- Keep the surface focused. A dozen overlapping tools enlarge every request header and
  fragment behaviour.

## Client extension points

A client module ships through `dsh.client` and is served at
`/plugins/??<pkg>/client.js`. The file uses the loader format:

```js
window.__ModuleLoader__.load({
  id: 'workspace-editor',
  factory: (require) => { /* exports.apply = (ctx) => ...; exports.inject = [...] */ },
})
```

| Need | API | Reference |
|---|---|---|
| Right-dock tab type | `ctx.sidebarRightTabs.register({ id, kind, multiple?, keepMounted?, patterns?, priority?, canOpen?, title, guide? })` | `docs/subsystems/sidebar-right.md`; `packages/client/ui-sidebar-right` |
| Tab body | Keyed slot `sidebar.right.pane.tab` with the same `id`; session-scoped props include `sessionId` and `inputActions` | `docs/subsystems/slots.md`; `packages/client/ui-conversation/src/client/contract/slots.ts` |
| Tab title / actions | `sidebar.right.pane.tab.title`; `sidebar.right.tab.actions` (bindCommands, openResource, openTab, close); `sidebar.right.tab.document.actions` for preview-tab actions | `docs/subsystems/sidebar-right.md` |
| Close cleanup | `ctx.sidebarRight.registerCloseHandler(kind, (sessionId, tab) => ...)`: one handler per kind, receives both arguments | `packages/client/ui-sidebar-right/src/client/service.ts` |
| Context menu | `ctx.contextMenus.register({ id, target, order, resolve })`, opened with `ctx.contextMenus.open(target, { x, y })`; extend the target map by declaration merging (TS) or a plain kind string (JS); attach UI with `useContextMenu().getTriggerProps` | `packages/client/ui-context-menu/README.md`, `types.ts` |
| Composer staging | `inputActions.insertQuote(text)` for an atomic quote; `captureInsertion()` / `insertText(text, span)` for revision-CAS insertion | `docs/subsystems/slots.md`; `docs/subsystems/conversation.md` |
| Client live data | `ctx.resources` protocol + `useResource`, address `dsh-resource://<type>/...` | `docs/subsystems/client-resources.md` |

Contract details that have bitten this workspace:

- A page tab is identified by `(kind, address)` and dedupes per pane. Navigation params
  arrive on every open/reveal and `navigation.revision` steps; tab records persist only
  `{ id, kind, contentId, title }`, so page-tab params do not survive a reload.
- `multiple: true` mints a unique page address per open; without it there is one page tab
  per pane.
- `keepMounted` keeps visited bodies mounted and live in background sessions; a body must
  not rely on module-global selection state.
- A close handler is registered once per kind and receives `(sessionId, tab)`; close the
  document for that tab, not a module-global "current" document.
- Context menus are a shared overlay. `getTriggerProps` is a DOM element handler; a
  `contextmenu` event inside an iframe never reaches the parent. Read the selection inside
  the editor frame and relay it with origin/source validation; that bridge is an
  application pattern, not a DSH seam.
- Composer `inputActions` exists only in session-scope slots. From a global menu run, use a
  session-keyed callback registered by the tab body; do not add a global current-composer.
- Plugin routes have no authentication by default; call `requestRejection`. Prefer the
  remote/typert seam when the operation needs the gateway's principal and access checks.

## Composition for a dev profile

1. Build the package under `plugins/<name>/` with `cordis.patch.yml` inserting its rows.
2. In `.dsh-home/profiles/<profile>/package.json`, add the bundle and the local link
   dependency; in the profile's `cordis.patch.yml`, insert the bundle (or its rows).
3. Launch the dev app with `DSH_HOME`, `DSH_DESKTOP_USER_DATA_DIR`, `DSH_AGENTS_HOME` and a
   separate port, using `scripts/launch-dev-detached.ps1` or `scripts/start-dev-desktop.ps1`.
4. Row order follows `inject`; the `insert` order documents intent but does not schedule.

## Testing and evidence

- Unit tests: `node --test "plugins/<name>/test/*.test.mjs"`. Hand-built `ctx` fixtures are
  useful but do not prove the composition works.
- Integration: a real engine/host verifier where the plugin owns one (see
  `plugins/workspace-editor/lib/{engine,model}/verify.mjs`).
- Real composition: boot the dev profile and exercise the user-visible path. A
  product-visible plugin needs a non-unit real-composition test.
- Registry contributions need a dispose-and-observe test.
- Assert semantics, not markers. A check that counts strings or markers cannot detect text
  corruption, wrong targets or lost formatting; assert exact text and valid output.
- Match evidence to the surface and report the commands and results actually used. Do not
  claim "checks passed" without the command and its output.

## Publishing

A published component is a versioned bundle: semver, `dsh.bundle.patch`, `dsh.client` when
applicable, `engines.dsh`, docs and provenance. Keep component releases independent of any
downstream application; DSH upgrades happen in this workspace first. Getting agreement
before publishing, changing a component's registry or scope, or recording a compatibility
verdict stays with the owner.

## Local plugin map (workspace-editor)

| Row | Module | Role |
|---|---|---|
| `workspace-editor` | `lib/index.js` | EuroOffice host, routes/SSE, document store/lease, right-dock tab, `editor` tool, legacy `document_edit` |
| `workspace-docx-engine` | `lib/engine/index.js` | Hidden Electron Document Builder sidecar (`docxEngine`) |
| `workspace-docx-model` | `lib/model/index.js` | Sessions, op log, diff/check, fork/merge/commit (`docxModel`) |
| `workspace-docx-tools` | `lib/tools/index.js` | `doc_*` tools, runtime context, write gate |
| `workspace-docx-fanout` | `lib/fanout/index.js` | `doc_fanout` over `ctx.subagents` |
| `workspace-legal-review` | `lib/review/index.js` | Deterministic analyzers, `doc_analyze`, review skill |

Surfaces today: one page tab `workspace-editor` with a selection context menu and composer
staging; ~17 host routes under `/workspace-editor` plus an events SSE stream; a leased
document store with SHA-256 revisions; a sidecar engine over loopback RPC; 12 agent tools.
The normative specification is [legal-docx-workspace.md](legal-docx-workspace.md); the
evidence and open defects are in `scratch/testingdocs/workspace-editor-final-audit-report.md`;
the plugin contract is the plugin README.

## Pitfalls recorded in this workspace

- Keep one persistent write authority. A second tool or route that writes the document
  directly bypasses the lease, dirty check and tracked changes; the audit found exactly
  that pattern in `document_edit`.
- Confine paths at one seam. Tool and route entry points that accept absolute paths have no
  workspace boundary unless you add one.
- Scope state to the DSH session or workspace. A store, model or SSE registry that lives per
  plugin activation leaks handles and document identities across sessions.
- A tool's success message is not proof. Check the structured result and the page's
  acknowledgement; `delivered` counts listeners, not execution.
- Do not send editor commands the host page does not implement; keep the vocabulary in one
  place.
- Back up before overwriting a doc you edit; retirement goes to `.agents/trash/<date>-<topic>/`
  with a manifest.
