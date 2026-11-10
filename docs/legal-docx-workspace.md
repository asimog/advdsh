# Legal DOCX workspace — specification (revision 2)

Status: normative specification. This document supersedes the earlier
"current design" narrative of the same path. It states the target design, the current
conformance status, and the acceptance gates for the audit fixes.

| | |
|---|---|
| Component | `workspace-editor` bundle, six Cordis rows, version `0.3.0` (target `0.4.0` after P0) |
| Specification revision | 2 (this document) |
| Audit basis | [workspace-editor-final-audit-report.md](../scratch/testingdocs/workspace-editor-final-audit-report.md) and the first report's detailed ledger |
| Framework | DSH `0.2.2-rc.1`, Cordis `4.1.0`, pinned read-only in `upstream/deepseek-harness` |
| Editor | vendored EuroOfficeLite frontend at `resources/euro-office`, unmodified |
| Decision record | this file; deferred work is listed in §18; conformance in §17 |

Requirement notation: **MUST** is a normative requirement identified as `WD-xxx`;
**SHOULD** is recommended; **MAY** is optional. Status labels in §17:
**Implemented** (code exists), **Verified** (acceptance evidence exists),
**Gap** (audit defect, must be fixed), **Deferred** (a later release).

---

## 1. Purpose, scope and non-goals

### 1.1 Purpose

A first-class legal DOCX workspace inside DeepSeek Harness: the vendored EuroOffice editor
in the right dock, the agent driven from the chat pane, one controlled document, and a
right-click gesture that stages document text into the composer for reasoning.

### 1.2 In scope for this specification

1. One editor per document, opened in the right dock, with tracked changes and review mode.
2. A deterministic agent document model with focused read, markup, edit, diff, check and
   commit tools; one tracked-change commit path.
3. One persistent write authority and one lease per file, shared by the human editor and the
   agent.
4. A reduced OOXML view that lets the agent make markup-preserving edits through curated
   structural ops, with a read-only human inspector.
5. Stable block identity; isolated parallel editing with deterministic merge and explicit
   conflicts.
6. Multi-document editing through resource-address tabs, with per-workspace view and
   document identity.
7. Backups, bounded history and working-state undo.
8. One controlled, auditable review authority: the human decides by default; the agent may
   accept or reject only when explicitly instructed.
9. Evidence that can fail: exact-text and structural assertions, real-profile acceptance.

### 1.3 Non-goals

PDF text editing (open, display and PDF export only); chart, SmartArt, shape and equation
editing (preserved, not editable); cloud real-time co-editing; a legal knowledge base;
publication or registry changes; model-authored raw OOXML writes; editing the vendored
EuroOffice tree.

### 1.4 What "done" means

Every requirement in §17 marked **Implemented/Verified** passes its acceptance test in §19;
no requirement remains **Gap**. Deferred items are explicit in §18.

---

## 2. Definitions

| Term | Meaning |
|---|---|
| **Document identity** | Absolute path plus the content hash the session was opened from. Persisted per workspace; not an opaque process id. |
| **Store revision** | `sha256` of the document bytes at a commit or save. One value per file revision; the only durable revision. |
| **Base revision** | The store revision a writer read before writing. A write MUST carry it. |
| **Working copy** | The agent's in-memory builder session, or the human editor's buffer. Neither is a file. |
| **Lease** | The per-file write authority record: base revision, editor-dirty state, holder and conflict state. |
| **Commit** | The agent serializing its working copy and writing it through the store, producing one tracked-change revision. |
| **Save** | The human editor writing its buffer through the store with the base revision it loaded. |
| **Fork** | A serialized copy of the parent working state opened as an isolated engine session. Forks cannot commit. |
| **Merge** | Applying fork changes to the parent working state by stable block identity, with explicit conflicts. |
| **Block ID** | The stable identity of a paragraph or table: `w14:paraId` when present, otherwise a minted and persisted ID. Session-local fallbacks are forbidden. |
| **OOXML view** | The reduced, deterministic representation of the live document (paragraphs, runs, properties, styles, numbering, tables, sections, tracked changes), produced by the engine and consumed by the agent and a read-only inspector. |
| **Review authority** | Who may accept or reject tracked changes. Human by default; agent only on explicit instruction. |
| **DSH session** | The harness session that owns tools, prompt context and client tabs. |
| **Workspace** | The session working directory and the root that bounds document paths. |

---

## 3. Architecture

One bundle package, six Cordis rows, one client module. No separate publishable bundles in this revision.

| Row | Module | Provides | Consumes | Listens |
|---|---|---|---|---|
| `workspace-editor` | `lib/index.js` | `ctx.editorDocuments` (store, revisions, lease, SSE), `editor` tool | `webServer`, `tools`, `fs` (bytes only), optional `connection` | `session/disposed` for cleanup |
| `workspace-docx-engine` | `lib/engine/index.js` | `ctx.docxEngine` (builder sidecar) | `subprocess`, `fs` | — |
| `workspace-docx-model` | `lib/model/index.js` | `ctx.docxModel` (sessions, ops, IDs, forks, merge, commit) | `docxEngine`, `editorDocuments` | `editor-documents/saved`, `editor-documents/conflict` |
| `workspace-docx-tools` | `lib/tools/index.js` | `doc_*` tools, runtime context | `tools`, `docxModel`, `editorDocuments`, `systemPrompt` | — |
| `workspace-docx-fanout` | `lib/fanout/index.js` | `doc_fanout` | `tools`, `docxModel`, `subagents` | — |
| `workspace-legal-review` | `lib/review/index.js` | `doc_analyze`, review skill | `tools`, `docxModel`, optional `skills` | — |

Row contract: a row declares only the services it provides and the listeners it owns. A
row MUST NOT claim a service it does not provide, and a row that owns a registration MUST
dispose it as a Cordis effect. The earlier statement "every plugin provides a service,
listens to events and emits events" is retired; several rows are registrars only.

```
Chat pane (DSH)  ◀── staged quote / inputActions ──  right-dock resource tab
      │                                                        │ iframe
      ▼                                                        ▼
docx-tools ──▶ docx-model ──▶ docx-engine (builder sidecar)
      │              │
      │              └──▶ editorDocuments: store, revisions, lease, SSE, backups
      ▼
docx-fanout / legal-review ──▶ docx-model + ctx.subagents
```

---

## 4. Invariants

| ID | Invariant |
|---|---|
| I-1 | One persistent write authority. Every durable write goes through the store with a base revision. No tool or route writes a document file directly. |
| I-2 | One revision authority and one conflict vocabulary: store SHA-256 revisions; `DOC_STALE_BASE`, `DOC_EDITOR_DIRTY`, `DOC_CONFLICT`. |
| I-3 | Fidelity. Adopted text MUST be live text derived from the base; unchanged parts MUST remain byte-identical; changed structure MUST be serialized correctly. |
| I-4 | Separation. Immutable base plus mutable working copy; a commit is the only point that turns working state into a file revision. |
| I-5 | Commit postcondition. A successful commit MUST leave the session usable: stale false, base advanced, content hash updated, next edit and commit possible without a reload. |
| I-6 | Scope. Paths are confined to the DSH session workspace; registries and handles are session-scoped; a file lease is visible across sessions. |
| I-7 | Review authority. The human decides accept/reject by default; the agent may do so only on explicit instruction, and the action is logged. |
| I-8 | Model-visible facts are logged. Prompt context, tool results and review commands are reconstructable from the session log. |
| I-9 | Deterministic operations. One op is atomic, validated against expected ID and text, and invertible until commit. |
| I-10 | Deterministic merge. Non-conflicting changes apply; anything uncertain is a typed conflict, never a silent drop. |
| I-11 | Recovery. Bounded backups and a versioned store adapter exist; working-state undo is available before commit. |
| I-12 | Evidence. Every capability has a test that can fail for its surface; markers, presence checks and self-reports are not evidence. |

---

## 5. Single persistent write authority and lease

### 5.1 The store is the only writer

`WD-100` All durable document writes MUST go through `ctx.editorDocuments` and its store
seam. The store validates the base revision, refuses a dirty editor, writes atomically
(same-directory temp + rename), records the new SHA-256 revision, creates a backup
(WD-110), and notifies SSE after the write succeeds.

`WD-101` The `document_edit` tool MUST be removed. It is a second write authority: always
registered, unaffected by `WORKSPACE_DOCX_WRITE`, no lease, no base check, no tracked
changes. Removal is a public agent-surface change; owner approval is recorded in §16.

`WD-102` `docxEngine.save` MUST be callable only with a manager-provided staging path.
Callers cannot supply an arbitrary target. The model stages bytes in the engine temp root
and hands them to the store; the sidecar never writes a document path.

`WD-103` Save-as MUST be an explicit store operation: the target is confined by WD-120, the
operation has its own revision record, and it never silently overwrites an existing target
without a base or an explicit `overwrite` flag.

`WD-104` Files are read through `ctx.fs` where a watcher or byte access is needed; the
document store owns writes. `node:fs` in the store is internal implementation, not a public
write path.

### 5.2 Lease

`WD-105` The model owns one lease per absolute path:
`{ storeRevision, baseRevision, editorDirty, holder, conflict }`. `holder` is the model
session handle or the editor tab id that last wrote. A lease does not expire silently.

`WD-106` A write MUST carry `baseRevision`. The store refuses when the current store
revision differs (`DOC_STALE_BASE`) or when the editor holds unsaved changes
(`DOC_EDITOR_DIRTY`). A base-less human save is refused; the shim MUST send the revision it
loaded.

`WD-107` `editorDirty` is untrusted input from the same-origin page. The store treats it as
a conflict signal, not a security boundary, and records the source. A missing or failed
dirty report MUST NOT be read as clean.

`WD-108` A file lease is visible across DSH sessions. Two sessions opening the same file
share one store revision and one lease; the second writer gets the conflict, not a silent
overwrite. Handles and registries remain session-scoped (WD-121).

`WD-109` A conflict produces one SSE `conflict` frame and one typed error; the tab disables
Save and offers Reload. No retry loop and no automatic overwrite.

### 5.3 Human and agent paths

| Path | Sequence |
|---|---|
| Human save | editor buffer → shim sends bytes + loaded revision → store base/dirty check → atomic write → backup → revision → model session marked stale → SSE `document` reload |
| Agent commit | `doc_commit` → lease check (dirty, stale) → serialize working copy → staged DOCX → store base check → atomic write → backup → revision → rebase session → SSE reload |

`WD-109a` A human save marks the agent session stale; the agent reloads or commits against
the new base. An agent commit MUST NOT mark its own session stale (WD-135).

---

## 6. Commit lifecycle

`WD-130` Preconditions: an open session, at least one pending op (or `force`), base revision
current, editor not dirty, no fork handle.

`WD-131` Transaction: serialize to a staging file, validate the package (structure, IDs,
tracked marks), call the store with the base revision, receive the new revision.

`WD-132` Postcondition: `storeRevision` = new revision, `baseRevision` = new revision,
`revision` reset to 0, op log cleared, `contentHash` updated, `stale` false, a `saved` fact
emitted after the bookkeeping, and a reload frame for an open tab.

`WD-133` A failed commit writes nothing and leaves the session unchanged. A stale or dirty
refusal is typed and actionable; it names reload or save as the remedy.

`WD-134` An interrupted commit is re-read from disk and reconciled against the lease; it is
never replayed blindly.

`WD-135` Event ordering: the host row MUST emit `editor-documents/saved` only after the
model has advanced the base revision, or the model MUST ignore the revision it just wrote.
The executed self-stale loop (stale true after a successful commit) is a Gap until this
test passes.

---

## 7. Revisions, identity and block IDs

### 7.1 Revision meanings

| Field | Owner | Meaning | Rule |
|---|---|---|---|
| store `revision` | store | SHA-256 of the file bytes | The only durable revision; every write and lease uses it |
| model `revision` | model session | count of applied ops since open/rebase | Display and staleness of the working copy only; never a file revision |
| engine `revision` | sidecar | builder save counter | Internal; never exposed as a document revision |
| `contentHash` | model session | hash of the bytes the session was opened from | Updated on rebase; a stale hash is a bug |

Tool results MUST name which revision they return and MUST use hashes for durable values.

### 7.2 Block identity

`WD-140` Every paragraph and table MUST have a stable ID. `w14:paraId` is used when present.
When absent, the store of IDs mints a `w14:paraId` and persists it in the saved package; the
same ID MUST survive save, reopen, fork and merge. Session-local `p:`/`i:` fallbacks are
forbidden.

`WD-141` Table IDs MUST be unique. Identical tables are disambiguated by a stable ordinal.
Duplicate-ID operations MUST be rejected as ambiguous, not applied to the first match.

`WD-142` Tool results carry both the block ID and the current engine index. Edits carry the
expected ID and text and fail with `DOC_STALE_TARGET` on drift. Merge uses IDs only.

### 7.3 Document and tab identity

`WD-143` Document identity is absolute path plus the content hash opened. Open documents are
recorded per workspace. An address, not a module variable, identifies the visible document.

---

## 8. Reduced OOXML view and markup-preserving edits

### 8.1 Definition

`WD-300` The engine MUST produce a reduced, deterministic OOXML view of the live document.
The view represents paragraphs with `pPr`, runs with `rPr`, styles, numbering, tables and
cells, sections, and tracked insertions/deletions. Unmodeled elements are preserved
opaquely and MUST survive round-trip byte-identically where untouched.

`WD-301` The view is generated from the live builder document; it is not the editor DOM and
does not require edits to the vendored EuroOffice tree. The human inspector is a
plugin-side read-only pane outside the iframe.

`WD-302` The view schema is versioned. Unknown constructs are returned as opaque handles
with their kind and range; the model cannot edit them in this revision.

### 8.2 Consumers and exposure

`WD-303` The agent reads the view through `doc_read` mode `markup` (bounded by token and
node limits) and edits through curated structural ops. The human sees the same view
read-only in the tab's inspector pane. Raw XML editing by the model is forbidden.

### 8.3 Edit operations

`WD-304` Structural ops MUST at minimum cover: set run text; set run properties
(bold/italic/underline/size/font/colour/highlight); split and merge runs; set paragraph
properties (style, alignment, indentation, spacing, numbering); insert and delete
paragraphs; insert list items; table row/column/cell operations; section properties; and
tracked-change acceptance/rejection when explicitly instructed.

`WD-305` Each op takes the block ID, an expected text or structure predicate, and a base
revision. The op is atomic and one undo step. It fails typed when the view and the live
document disagree.

`WD-306` An op the builder cannot express MUST return `DOC_UNSUPPORTED_EDIT` with the
construct and location. It MUST NOT fall back to raw OOXML patching.

`WD-307` Edits preserve the text the user sees. The view MUST NOT include text of tracked
deletions as live text; deleted runs are represented as deleted, and read/search use live
text unless a mode explicitly includes revisions.

### 8.4 Fidelity and evidence

`WD-308` Unchanged package parts and unchanged block ranges are byte-identical after save.
Changed blocks serialize with valid OOXML and stable IDs. The saved DOCX MUST open in Word
and EuroOffice with the tracked revisions intact.

`WD-309` The acceptance test asserts exact paragraph text before and after each structural
op, plus the presence and nesting of the intended markup (`w:ins`/`w:del`, run properties,
table cells). Marker counts and presence checks are insufficient.

---

## 9. Agent tools

Final tool inventory (write tools gated by `WORKSPACE_DOCX_WRITE`; read tools always on):

| Tool | Contract |
|---|---|
| `doc_open` | Path or bytes → handle, path, content hash, store revision, read mode, outline, limits |
| `doc_read` | Modes: auto, full, outline, range, search, context, markup; bounded; exact live text |
| `doc_search` | Query over live text; bounded matches with IDs |
| `doc_edit` | One curated op; extended with structural ops (WD-304); returns affected IDs and diff |
| `doc_diff` | Model-friendly change set from the op log |
| `doc_check` | Pending revisions plus deterministic analyzers and codes |
| `doc_commit` | Commit lifecycle in §6; typed stale/dirty/fork refusals |
| `doc_state` | Status, revisions, reload, close; session-scoped |
| `doc_undo` | Undo the last working-state op; unavailable after commit |
| `doc_analyze` | Legal findings with stable codes |
| `doc_fanout` | Fork/merge over `ctx.subagents`; in scope |
| `editor` | Session control only: status, open, save, reload, export_pdf, wait, review; never edits text |

`WD-310` Write tools are removed when `WORKSPACE_DOCX_WRITE=off`, including any legacy
writer (WD-101). Read-only mode is a real boundary.

`WD-311` Tool descriptions state operation and result, not host internals. Output schemas
are canonical; presenters and replay metadata are defined with the tool.

`WD-312` Error codes are structured and survive the tool boundary: `DOC_STALE_BASE`,
`DOC_EDITOR_DIRTY`, `DOC_STALE_TARGET`, `DOC_INVALID_OP`, `DOC_UNSUPPORTED_EDIT`,
`DOC_SESSION_NOT_FOUND`, `DOC_TOO_LARGE`, `DOC_COMMIT_FAILED`, `DOC_UNSUPPORTED_EDIT`,
`DOC_OUTSIDE_WORKSPACE`.

`WD-313` `editor` review commands use one vocabulary shared with the host page and await an
acknowledgement. Fire-and-forget delivery is not success.

`WD-314` The review authority is human by default. The agent MAY accept or reject tracked
changes only when the user explicitly instructs it in the turn; the tool result records the
command and affected change count, and the session log retains it.

---

## 10. Editor surface and multi-document model

`WD-320` The right-dock surface uses a resource tab type with a durable address per
document: `dsh-resource://file/absolute/<absolute path>`. The address is the document
identity; it persists, deduplicates and restores. One tab per document; opening an already
open document reveals it.

`WD-321` The tab is workspace-scoped: its identity is the workspace path plus the document
address. A restored tab reopens its own document, never a module-global "last path".
`localStorage` is not a document identity. There is no module-level `currentDocId`.

`WD-322` The close handler receives `(sessionId, tab)` and closes the document for that tab
only. `keepMounted` background editors keep their own document; closing one tab frees only
its own store document.

`WD-323` A conflict keeps the iframe mounted and overlays a banner. The unsaved buffer is
never discarded by a reload or conflict path; the user chooses Save, Reload or Dismiss.

`WD-324` The Edit action on a document preview opens or reveals the resource tab for that
path. Agent-side `editor open` reveals the same tab. The File menu and Ctrl+O are defined
behaviour, not a dead path: they open the DSH file picker and the resulting document.

`WD-325` Review mode and the tracked-change UI remain the vendored editor's; the plugin does
not replace the review UI. Accept/reject commands are dispatched to the page and
acknowledged.

`WD-326` The selection gesture is unchanged: a non-empty selection in the editor frame is
relayed with origin and source validation; the shared context menu stages a quote carrying
the path, the loaded store revision and the dirty flag; empty selections keep EuroOffice's
native menu.

---

## 11. Parallel editing

`WD-330` A fork is an isolated engine session created from the parent working state. A fork
cannot commit; only the parent commits.

`WD-331` Fan-out children are restricted to the doc tools for their own fork. The parent
handle is not disclosed. `document_edit` and other write surfaces are unavailable to
children. Enforcement is by tool scoping, not by prompt text.

`WD-332` The deployment depth limit is honoured; a child cannot fan out beyond it. A tool
call cancellation stops published children; cancellation is re-observed after start.

`WD-333` Merge compares blocks by stable ID and adopts only changes that derive from the
base: a candidate block is applied when it differs from the base in a way that can be
reconstructed, and when the parent still matches the base. Anything else is a typed
conflict.

`WD-334` Conflict payload: `{ id, base: string, parent: string, candidates: [{ taskId, text }] }`.
Deleted or absent blocks use an explicit nullable representation, and the tool schema
declares it so canonical output validation cannot fail. A merge that encounters a conflict
returns it as data, never as `INVALID_TOOL_OUTPUT`.

`WD-335` Insertions are ordered deterministically: same-anchor insertions keep task order;
anchors are rebased after deletions. The final order is asserted exactly.

`WD-336` Table and list changes merge structurally: structure is adopted when it derives
from the base, otherwise it conflicts. A fork-created table is never flattened into a
paragraph; list numbering is preserved.

`WD-337` Merged changes carry an attribution record: fork author, task id and parent commit
revision. The parent author owns the commit; the contributing fork/task is recorded in the
revision record and the tool result.

`WD-338` A failed or conflicted merge cannot partially corrupt the parent: applied blocks
are either committed together or the merge returns the list of applied and conflicting
blocks without writing the parent.

---

## 12. Scope, paths and security

`WD-120` Paths are confined to the DSH session workspace root. `doc_open`, `doc_commit`,
`doc_state` wait, save-as, `document_edit` (removed) and every route resolve against that
root or take an absolute path that lies inside it. Escapes are refused with
`DOC_OUTSIDE_WORKSPACE`. A configuration may add explicit allowed roots; it is not a default.

`WD-121` Registries, handles, sessions and SSE are scoped to the DSH session. `doc_state
status` and the runtime context expose only the calling session's documents. The file lease
is the only cross-session state (WD-108).

`WD-122` The visible editor iframe is isolated: same-origin is not a substitute for a
sandbox. The host page sets an explicit CSP and a sandbox policy compatible with the
vendored editor; the hidden sidecar window keeps its CSP and gains a navigation/window-open
guard.

`WD-123` Every plugin route calls `ctx.get('connection')?.requestRejection(req)` and verifies
same-origin when the service exists. SSE aborts on request close and plugin dispose. No
route is authenticated by obscurity.

`WD-124` Plugin routes do not write documents. A future assistant or client integration MUST
use the same store path; no new write endpoint.

`WD-125` The OOXML view and any XML fragment are untrusted data for consumers. The host
validates the view schema, bounds input and output, and never evaluates document content.

`WD-126` No secrets in prompts, logs or documents. Credentials stay in the environment. The
sidecar keeps its loopback token and ephemeral temp root.

---

## 13. Backups, history and undo

`WD-110` Before each store overwrite, a bounded backup of the previous bytes is retained in
a per-document backup directory with the revision hash in the name. Retention is bounded
and configurable; the most recent backup is always retained.

`WD-111` The store seam supports a versioned adapter that records every committed revision.
The default local store writes in place with a backup; a versioned adapter gives full
history without changing callers.

`WD-112` `doc_undo` reverses the last working-state op before commit. After commit, undo is a
history restore operation, not a silent rewrite.

`WD-113` A failed or interrupted commit leaves the previous revision and its backup intact;
recovery reads the file and the lease, never a cached working copy.

---

## 14. Session lifecycle and cleanup

`WD-140a` `session/disposed` releases that session's documents, handles, leases, SSE
subscriptions and temp directories. A session's model is disposed once, by its owner row.

`WD-141a` A file lease is released when its holder commits, saves or is disposed; a session
that disposes leaves the file lease re-readable by the next session.

`WD-142a` Engine sessions, temp roots and Chromium profiles are closed and removed on
dispose; a crashed sidecar is reported and its sessions are not silently reused.

`WD-143a` A reopened session rehydrates a handle from the store revision and content hash;
memory state is never the only copy.

---

## 15. Performance and limits

`WD-150` The spec fixes budgets, measured not assumed: editor boot after cache warm; open,
first read, edit, diff and commit on a 100-page document; markup read token/node bounds;
maximum concurrent engine sessions; SSE heartbeat and cleanup. Values are recorded in the
plugin README and verified in the performance gate.

`WD-151` The OOXML view is bounded by node and token limits. Exceeding a bound returns a
typed truncation with the next range, never a silent partial view.

---

## 16. Owner decisions recorded

1. The updated spec is one normative document (this file), not a separate requirements file.
2. OOXML view: core markup coverage; curated structural ops only; no raw XML writes; agent
   edits, human read-only inspector. Vendored editor unmodified.
3. `document_edit` is removed. Public agent-surface change; approved here.
4. Paths confined to the session workspace; session-scoped registries; the file lease is the
   only cross-session state.
5. Backups plus a versioned store adapter; `doc_undo` exposed.
6. Merge: representation fix, derivation checks and deterministic conflicts now; the
   end-of-session edit generator is deferred.
7. Stable IDs minted and persisted; table/list merge included.
8. Review authority: human default; the agent may accept/reject only on explicit
   instruction, logged.
9. Multi-document: resource-address tabs; per-workspace view and document identity.
10. This specification keeps table/list merge, stable IDs and the live browser e2e gate. The remaining
    deferred items are listed in §18.

---

## 17. Conformance status (at `93fbb83`, after the audit)

| Requirement | Status | Evidence / gap |
|---|---|---|
| I-1, WD-100 single store writer | **Gap** | `document_edit` and `/api/save-as` write outside the store |
| WD-101 remove `document_edit` | **Gap** | Tool registered unconditionally (`lib/index.js:562-624`) |
| WD-102 engine.save target | **Gap** | API accepts a caller target; current usage stages |
| WD-103 save-as policy | **Gap** | Arbitrary absolute target |
| WD-105..109 lease | Partial | Lease exists; base-less save accepted; dirty self-reported |
| WD-130..135 commit lifecycle | **Gap** | Executed self-stale loop; contentHash not updated |
| WD-140..142 stable IDs | **Gap** | Session-local fallbacks; duplicate table IDs |
| WD-143 document identity | **Gap** | Client uses module-global `lastPath` |
| WD-300..309 OOXML view | **Gap** | Absent; plain block text includes deleted runs |
| WD-310..314 tools and review | Partial | `presentCall` absent; command vocabulary mismatch; accept/reject unlogged |
| WD-320..326 multi-document | **Gap** | Single page tab; global identity; close ignores `(sessionId, tab)` |
| WD-330..338 parallel | **Gap** | Merge corruption; conflict schema; child scoping; depth/cancel |
| WD-120..126 scope and security | **Gap** | No confinement; iframe without sandbox/CSP |
| WD-110..113 backups/history | **Gap** | No backup or undo tool |
| WD-140a..143a lifecycle | **Gap** | Activation-global state; no per-session cleanup |
| WD-150..151 performance | **Deferred** | No budgets yet |
| Verifiers: unit 41/41, engine 33/33, model 40/40, Word-open PASS | **Verified** | But cannot detect merge corruption (audit C-9) |

Full finding IDs and line evidence: final audit report §3 and Appendix A.

---

## 18. Deferred to a later release

Kept for a later release, documented and not silently dropped:

- D2 own reduced OOXML model and serializer (the builder is chosen and works).
- `doc_render` page images (no approved rasterizer).
- Nextcloud Assistant integration (present and dormant in the vendored frontend; would need
  a host bridge and must use the store path).
- Splitting `doc_fanout` into a separate package from the generic workflow tool.
- The end-of-session edit generator (the merge fix is in this specification; the generator is a later refactor).
- Real-time co-editing (permanent non-goal).

---

## 19. Acceptance gates

**P0 (blocks adoption).** WD-100/101/102/103; WD-105..109; WD-130..135; WD-140..142;
WD-120..121; WD-320..325; WD-333..337; WD-110..112; and the exact-text tests in §8.4.
Evidence: unit tests that fail before the fix, the engine/model verifiers, and a live
dev-profile run for the client and review flows.

**P1.** WD-330..332 child enforcement and cancellation; WD-143a lifecycle; WD-310..314 tool
and review contract; WD-150 budgets.

**P2.** Remaining medium/low findings from the audit and the deferred list in §18.

**Adoption rule.** The component remains **REVISE** until P0 passes exact-text and
confinement acceptance tests and one live profile run. It may then be **ADOPT WITH
LIMITATIONS** for single-workspace, human-in-the-loop editing; P1 is required before
parallel editing is trusted.

---

## 20. References

- Final audit report: [../scratch/testingdocs/workspace-editor-final-audit-report.md](../scratch/testingdocs/workspace-editor-final-audit-report.md)
- First report (detailed ledger): [../scratch/testingdocs/workspace-editor-audit-and-improvement-report.md](../scratch/testingdocs/workspace-editor-audit-and-improvement-report.md)
- Cordis map: [cordis-map.md](cordis-map.md)
- DSH upstream map: [deepseek-harness-map.md](deepseek-harness-map.md)
- Plugin guide: [plugin-knowledge-base.md](plugin-knowledge-base.md)
- Hosting decision: [eurooffice-hosting-assessment.md](eurooffice-hosting-assessment.md)
- Plugin contract: [../plugins/workspace-editor/README.md](../plugins/workspace-editor/README.md)
