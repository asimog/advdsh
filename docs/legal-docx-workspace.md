# Legal DOCX workspace — specification (revision 3)

Status: normative specification and single source of truth for the component. It states the
target design, the behaviour that must be corrected at `93fbb83`, the verified controls, and
the acceptance gates. It does not point at separate documents; everything needed to
implement or verify the component is in this document.

| | |
|---|---|
| Component | `workspace-editor` bundle, six Cordis rows, version `0.3.0` (target `0.4.0` after P0) |
| Specification revision | 3 (this document) |
| Framework | DSH `0.2.2-rc.1`, Cordis `4.1.0`, pinned read-only in `upstream/deepseek-harness` |
| Editor | vendored EuroOfficeLite frontend at `resources/euro-office`, unmodified |
| Evidence basis | source re-read and executed disposable-copy probes at `93fbb83`; observed behaviour in §16 |

Requirement notation: **MUST** is a normative requirement identified as `WD-xxx`;
**SHOULD** is recommended; **MAY** is optional. Defects in §16 are current behaviour, not
requirements. Status labels in §17: **Implemented** (code exists), **Verified** (acceptance
evidence exists), **Gap** (known defect, must be fixed), **Deferred** (a later release).

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
8. One controlled, reviewable authority: the human decides by default; the agent may accept
   or reject only when explicitly instructed.
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

One bundle package, six Cordis rows, one client module. No separate publishable bundles in
this revision.

| Row | Module | Provides | Consumes | Listens |
|---|---|---|---|---|
| `workspace-editor` | `lib/index.js` | `ctx.editorDocuments` (store, revisions, lease, SSE), `editor` tool | `webServer`, `tools`, `fs` (bytes only), optional `connection` | `session/disposed` for cleanup |
| `workspace-docx-engine` | `lib/engine/index.js` | `ctx.docxEngine` (builder sidecar) | `subprocess`, `fs` | — |
| `workspace-docx-model` | `lib/model/index.js` | `ctx.docxModel` (sessions, ops, IDs, forks, merge, commit) | `docxEngine`, `editorDocuments` | `editor-documents/saved`, `editor-documents/conflict` |
| `workspace-docx-tools` | `lib/tools/index.js` | `doc_*` tools, runtime context | `tools`, `docxModel`, `editorDocuments`, `systemPrompt` | — |
| `workspace-docx-fanout` | `lib/fanout/index.js` | `doc_fanout` | `tools`, `docxModel`, `subagents` | — |
| `workspace-legal-review` | `lib/review/index.js` | `doc_analyze`, review skill | `tools`, `docxModel`, optional `skills` | — |

Row contract: a row declares only the services it provides and the listeners it owns. A row
MUST NOT claim a service it does not provide, and a row that owns a registration MUST dispose
it as a Cordis effect. The statement "every plugin provides a service, listens to events and
emits events" is not a requirement; several rows are registrars only.

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
changes. Removal is a public agent-surface change; owner approval is recorded in §21.

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
`DOC_SESSION_NOT_FOUND`, `DOC_TOO_LARGE`, `DOC_COMMIT_FAILED`, `DOC_OUTSIDE_WORKSPACE`,
`DOC_CONFLICT`.

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
address. A restored tab reopens its own document; there is no module-global "last path".
`localStorage` is not a document identity. There is no module-level `currentDocId`.

`WD-322` The close handler receives `(sessionId, tab)` and closes the document for that tab
only. `keepMounted` background editors keep their own document; closing one tab frees only
its own store document.

`WD-323` A conflict keeps the iframe mounted and overlays a banner. The unsaved buffer is
never discarded by a reload or conflict path; the user chooses Save, Reload or Dismiss.

`WD-324` The Edit action on a document preview opens or reveals the resource tab for that
path. Agent-side `editor open` reveals the same tab. The File menu and Ctrl+O are defined
behaviour: they open the DSH file picker and the resulting document.

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

`WD-334` Conflict payload: `{ id, base: string | null, parent: string | null,
candidates: [{ taskId, text: string | null }] }`. Deleted or absent blocks use the explicit
nullable representation, and the tool schema declares it so canonical output validation
cannot fail. A merge that encounters a conflict returns it as data, never as
`INVALID_TOOL_OUTPUT`.

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
`doc_state` wait, save-as and every route resolve against that root or take an absolute path
that lies inside it. Escapes are refused with `DOC_OUTSIDE_WORKSPACE`. A configuration may
add explicit allowed roots; it is not a default.

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

`WD-150` The specification fixes budgets, measured not assumed: editor boot after cache
warm; open, first read, edit, diff and commit on a 100-page document; markup read token/node
bounds; maximum concurrent engine sessions; SSE heartbeat and cleanup. Values are recorded
in the plugin README and verified in the performance gate.

`WD-151` The OOXML view is bounded by node and token limits. Exceeding a bound returns a
typed truncation with the next range, never a silent partial view.

---

## 16. Current behaviour and known defects at `93fbb83`

This section is the evidence base for the corrections. It describes what the code does now,
where, and what was observed in executed checks on disposable copies. It is not required
behaviour; the requirements are in §5–§15. Line references are to `plugins/workspace-editor`
at `93fbb83` and identify the mechanism, not the only place to change.

### 16.1 Critical defects

**D-1 — Merge adopts contaminated block text (W-01, W-03).**
The engine's `describe()` text includes the text of tracked deletions (`GetText` returns
deleted runs as well as live runs), for example
`Sometime onin August 2023, … to the rRespondent for the job.`. Merge compares and adopts
whole blocks (`lib/model/model.js:1101,1148,1151`) and re-applies the fork's block text to
the parent. Executed on a clean fixture: the intended result `CLEAN-MERGE-EXACT-TEXT` was
saved as live text `024Dated: February 8, 2024CLEAN-MERGE-EXACT-TEXT`, with the preceding
`Dated: February 8, 2` present only in deleted text. Executed on a revision-bearing fixture:
the intended `MERGE-ADOPTED-EXACT-TEXT` produced duplicated live text
`Respondent for the job. … MERGE-ADOPTED-EXACT-TEXT`. In both runs merge returned
`applied:1, conflicts:[], failed:[]`, the commit applied, `doc_diff` reported clean, and the
OOXML stayed structurally valid (46 paragraphs, unique paraIds and revision IDs). Marker
counts and structural checks cannot detect this. Violates I-3, I-9, I-10 and requires WD-307,
WD-333.

**D-2 — `document_edit` is a second write authority (W-02).**
The tool is registered unconditionally in the host row (`lib/index.js:562-624`), is not
affected by `WORKSPACE_DOCX_WRITE`, and writes via `lib/docs-edit.js:52-109`: rewrite
`word/document.xml` with JSZip, then `writeFile` and `rename` over the file. It uses no
store, lease, base revision, dirty check or tracked-change handling. Executed with the
editor dirty: the write succeeded, the file hash and the store revision changed behind the
lease, and the dirty flag stayed true. Executed on a revision-bearing copy: editing one
paragraph dropped 4 insertions and 5 deletions (document totals 19/14 → 15/9) while the
package stayed valid. With `WORKSPACE_DOCX_WRITE=off`, this tool remained the only write
path, so the gate is not a read-only boundary. Violates I-1, I-2, I-7 and requires WD-101,
WD-310.

### 16.2 High defects

**D-3 — Agent-visible text is not the live text (W-03).**
`doc_read`, `doc_search`, analyzers and expected-text checks consume block text that mixes
live and deleted runs (`lib/engine/host-bridge.js:242,330-332`). A search for a phrase the
user can see returned 0 matches when the phrase was split by a tracked deletion. This is the
root cause of D-1 and must be fixed at the view layer, not in merge alone. Requires
WD-307, WD-300.

**D-4 — A successful commit marks its own session stale (W-04).**
`applyBytes` emits `saved` synchronously before `commit()` advances `baseRevision`
(`lib/docs.js:440`; `lib/index.js:248`; `lib/model/index.js:34-38`;
`lib/model/model.js:926-973,1300-1313`). The model's `noteSaved` sets `stale`, and `rebase()`
never clears it. Executed: `status()[0].stale === true` immediately after `applied:true`;
the next commit was refused with `DOC_STALE_BASE` until `doc_state reload`. Requires
WD-132, WD-135.

**D-5 — No path confinement in the document surface (W-05).**
`doc_open`, `doc_commit`, `doc_state` wait, `document_edit` and `/api/open` accept absolute
paths with no workspace boundary; `/api/save-as` writes to an arbitrary absolute target
(`lib/model/model.js:461-479`; `lib/docs.js:298-306,501-514`; `lib/index.js:396-454`), and
for a PDF document it writes the request body unchanged, so the write is not a DOCX save.
Requires WD-120, WD-103.

**D-6 — No session owner for store, model, leases or SSE (W-06).**
The registry, model sessions, leases and SSE are one set per plugin activation
(`lib/docs.js:219-233`; `lib/model/model.js:261-266`; `lib/index.js:349-393`). `doc_state
status` lists every open session and the SSE snapshot broadcasts every open document to
every subscriber. Requires WD-121, WD-108.

**D-7 — Fan-out children are not constrained and the conflict payload is invalid (W-07,
W-08, W-34, W-35).**
Children inherit the global tool registry and receive the parent handle in their prompt
(`lib/fanout/index.js:278-285`; `lib/tools/index.js:798-810`); no `ctx.tools.restrict` is
used, so a child can edit, force-commit or close the parent or call `document_edit`.
`doc_fanout` declares conflict `base`/`parent`/`candidate.text` as strings
(`lib/fanout/index.js:83-107`) but merge emits nulls for deleted or absent blocks
(`lib/model/model.js:1099-1129`), so the advertised delete-vs-edit conflict fails canonical
output validation as `INVALID_TOOL_OUTPUT`. The deployment depth cap is ignored, and
cancelling a tool call does not stop published children because the signal is observed only
at creation. Requires WD-331, WD-332, WD-334.

**D-8 — Merge application fails on insertions, tables and identity (W-09, W-10, W-11).**
Insertion anchors are computed in pre-merge coordinates while deletions are applied first:
an executed fake-engine case produced parent order `TWO,THREE,FOUR,FIVE,INSERT-A` instead of
`…FOUR,INSERT-A,FIVE`, reported `applied:2`, and returned no conflict. A fork table change
becomes `replace_paragraph` on a table ID and fails as `DOC_INVALID_OP` rather than a
conflict; a fork-created table is flattened into a paragraph; fork list numbering is lost
(`lib/model/model.js:1132-1191`; `lib/engine/host-bridge.js:365-397`). Table IDs are a hash
of the header row, so identical tables share an ID; paragraph fallback IDs are
session-scoped (`p:<session internal>`, `i:<index>`) when `w14:paraId` is absent — the
114-table fixture has 0 of 1104 paraIds (`lib/engine/host-bridge.js:225-289`;
`lib/engine/table-ids.mjs`). A duplicate-ID fork change silently applied to the first match
or was invisible to `diff`. Requires WD-140, WD-141, WD-335, WD-336.

**D-9 — Client identity, close and conflict handling are module-global (W-14, W-15, W-16).**
Restored page tabs and no-param (guide) opens fall back to a module-global `lastPath` and
`localStorage['workspace-editor.lastPath']`, so a reloaded or background tab can open the
last document of another session (`lib/client.js:63-74,104-107`; client `persistence.ts:20`;
`tab-domain.ts:105`). The close handler is registered once per kind and receives
`(sessionId, tab)` but the plugin closes a module-global `currentDocId` (`lib/client.js:410-417`;
client `service.ts:317-321`), so with two editor occurrences it can free another occurrence's
document, after which that editor cannot save. An SSE conflict frame unmounts the editor
iframe and shows a banner (`lib/client.js:214-217,251-255`); unsaved human work exists only
in that iframe, so it is lost (consequence inferred from source). Requires WD-320, WD-321,
WD-322, WD-323.

**D-10 — No recovery path and verification cannot detect the failures (W-12, W-13).**
The store renames over the document with no backup and no version history
(`lib/docs.js:119-131,458-491`); model undo is working-state only, is lost on commit or
rebase, and is exposed by no tool (`lib/model/model.js:751-777`). The existing verifiers pass
while D-1 exists: the model verifier's "original removed" phrase is split across runs in the
fixture so the check is vacuous, its merge assertion is presence-only, and the fake engine
replaces text instead of producing a tracked delete plus insert
(`lib/model/verify.mjs:79-98,195-215`; `test/fixtures.mjs:78-92`). There are no tests for the
client bundle, host page/shim/boot, HTTP routes/SSE, store lease, engine host/manager RPC or
real `ctx.subagents`. Requires WD-110, WD-112, I-12 and §19.

### 16.3 Medium and low defects

All are source-proven at `93fbb83`; each maps to a P1 or P2 gate in §19.

| ID | Current behaviour | Severity |
|---|---|---|
| W-17 | Human save stale protection is optional: a base-less save overwrites the revision it refreshed; `modified` is page-self-reported, so the dirty lease rests on same-origin trust. | Medium |
| W-18 | Agent `editor open`/`documents.open` registers a server session and broadcasts `reload:false`; the client acts only on `reload:true`, so the registry and visible tab diverge and no tab opens. | Medium |
| W-19 | `editor` command vocabulary/ack mismatch: it dispatches `save`/`reload` and teaches snake_case review verbs (`accept_all`, `next_change`, `markup`) that the shim's camelCase executor rejects; `delivered` counts SSE connections, not execution, and the renderer shows `ok`. | Medium |
| W-20 | `editor status` renders "engine stopped" until the sidecar is lazily spawned and can report stopped on the non-injected proxy path. | Low |
| W-21 | File→Open/Ctrl+O is a no-op: `LocalFileOpen` only logs; its Ctrl+O caller (`editor-patches.js`) is not loaded, and the File menu's `editor:event` reaches an empty shim `execCommand`. | Low |
| W-22 | Outline lists only paragraphs with a heading style or outline level; it was empty on the 18-block fixture, and the verifier's `Array.isArray(outline)` check cannot detect that. | Medium |
| W-23 | Three revision semantics with no single contract: store SHA-256, model op counter reset on rebase, engine save counter with `baseRevision:0`; tool outputs mix numbers and hashes. | Medium |
| W-24 | Session `contentHash` is never updated after rebase or commit, so `rehydrate(oldHash)` can re-find a stale session. | Low |
| W-25 | Frame/host hardening: the visible editor iframe is same-origin with no `sandbox` and no CSP/nosniff, so the vendored UI has full same-origin access; the hidden window has `sandbox:false` with `'unsafe-eval'` CSP and no navigation/window-open guard (four IPC calls exposed). | Medium |
| W-26 | Route hygiene: handlers do not restrict methods; malformed JSON returns 500 rather than 400; unknown fields are ignored. CSRF is mitigated by `SameSite=Strict` plus the Host/Origin fence. | Low |
| W-27 | SSE exposes all open-document identities and paths to every authenticated same-origin subscriber, with no session scope. | Low |
| W-28 | Sidecar cancellation is honoured only by `open`; `describe`, `apply` and `save` continue after abort or timeout (the README overstates this). | Medium |
| W-29 | Sidecar reliability: the restart counter resets on each successful start, so the limit is ineffective after ready; a crash loses all engine sessions with no rebuild; run temp dirs are never removed; some error codes flatten to `ENGINE_PROTOCOL`. | Medium |
| W-30 | The production `ctx.subprocess` spawn/termination path is exercised by no test (only Node `child_process`); renderer sandbox, CSP and navigation behaviour are untested live. | Medium |
| W-31 | Version provenance: the default x2t is an unversioned Stage 5 binary, not the Lite-pinned `9.4.0.129`; the release-frontend override is unpinned and the version-match rule is unenforced. | Medium |
| W-32 | Duplication: two x2t invocation stacks (host `x2t.js` and sidecar `main.js`) with different option sets; editor boot config duplicated; outline computation duplicated (`manager.js:115-129`; `model.js:113-127`). | Low |
| W-33 | The `editorDocumentsStore` replacement seam is read and normalised but never provided or exercised in this checkout. | Low |
| W-34 | The fan-out depth cap is a no-op: a child can call `doc_fanout` for grandchildren because the deployment `subagents.maxDepth` is ignored. | Medium |
| W-35 | Tool-call cancellation does not stop published children: the signal is observed only at creation, so children keep editing forks. | Medium |
| W-36 | Merged changes are re-applied as the parent author; the child/task attribution and the fork author are discarded. | Medium |
| W-37 | Run-level formatting inside a replaced paragraph is lost (whole-range delete plus `AddText`); inserted paragraphs get no surrounding-context style inference. | Medium |
| W-38 | No tracked find/replace or bulk edit on the `doc_*` surface; the only find/replace is `document_edit`'s single-run whole-file XML path, where a phrase split across runs fails. | Medium |
| W-39 | Session lifecycle: no per-DSH-session cleanup of documents, engine sessions or leases; the model is disposed by two rows; `forkChildren` is never pruned. | Medium |
| W-40 | Error codes are not surfaced structurally: engine codes flatten to model fallbacks, so recovery cannot branch on the code. | Medium |
| W-41 | Runtime context leaks same-cwd documents to every agent in that cwd; the context order `130` is hard-coded instead of a named allocation. | Low |
| W-42 | Review quality: the citation analyzer counts at most one valid citation per block (non-global regex), which produces false positives; analyzers are deterministic structural lint with no rule model, deal context, rule interaction, escalation or legal-judgment evaluation. | Low |
| W-43 | The `legalReview` service has no consumer; the README claims `presentCall` on three tools (none exists), cancellation inside the sidecar and a 9.3.6 converter identity that are not supported. | Low |
| W-44 | Test coverage is missing for the client bundle, host page/shim/boot, HTTP routes/SSE, store lease, engine host/manager RPC and real `ctx.subagents`; fan-out tests fake the provider; merge, table, insertion and conflict cases are not covered. | Medium |
| W-45 | The selection quote records the file mtime as the "revision" when the content revision is unknown. | Low |
| W-46 | `doc_state close` reports `closed:true` for an unknown handle; `editor open` without `path` reaches `path.resolve(undefined)` (a TypeError) instead of a typed argument error. | Low |

### 16.4 Controls confirmed sound

These are not defects and MUST be preserved by the corrections.

| ID | Control | Source reference |
|---|---|---|
| W-C1 | Store write path: atomic same-directory temp plus rename, base-revision check before write, dirty-editor refusal, conversion before write so a failed commit writes nothing. | `lib/docs.js:106-131,384-448` |
| W-C2 | Commit to visible editor reload: `reload:true` document frame on the shared SSE channel plus an mtime-poll fallback; the tab reloads only while clean and shows a banner while dirty. | `lib/docs.js:426-431`; `lib/client.js:171-232` |
| W-C3 | Selection relay validation on both sides (source frame, same origin, type, string and coordinates); no cross-origin spoof path found. | `lib/boot.js:207-213`; `lib/client.js:147-169`; `lib/shim.js:249-256` |
| W-C4 | Sidecar boundary: loopback RPC with a random token, POST-only, no document paths and no persistent document state; it writes only the temp root and a crash log. | `lib/engine/host/main.js:40-41,262-303,542-585`; `lib/engine/manager.js:560-565,696-722` |
| W-C5 | Vendored Lite frontend provenance verified by execution: manifest equals checkout HEAD/submodules equals the staged tree; hash and file counts match. | `vendor/euro-office/manifest.json` |
| W-C6 | Font/shaper readiness gate exercised; every executed engine open succeeded after `editor-app-ready` → `HB_StartString` → `document-ready`. | `lib/engine/host/main.js:424-431`; `lib/engine/host-bridge.js:56-64` |
| W-C7 | The model never emits OOXML: edits go through builder APIs, and serialization is the engine's job. | `lib/model/model.js:55-74`; `lib/engine/host-bridge.js:362-531` |

### 16.5 Verification baseline and blind spots

Commands run at `93fbb83` and their recorded results:

| Command | Result |
|---|---|
| `node --test "plugins/workspace-editor/test/*.test.mjs"` | 41 tests, 41 pass, 0 fail, exit 0 |
| `node plugins/workspace-editor/lib/engine/verify.mjs --with-hooks` | `ok=true`, 33 checks, 0 failed, exit 0 |
| `node plugins/workspace-editor/lib/model/verify.mjs` | `ok=true`, 40 checks, 0 failed, exit 0 |
| `scripts/verify-word-open.ps1` on the engine artifact, marker `DBSPIKE-REPLACED-PARAGRAPH` | PASS; Word opened 29 paragraphs, 4 revisions, exit 0 |
| `scripts/verify-word-open.ps1` on the model artifact, marker `DOCMODEL-WORD-CHECK` | PASS; Word opened 25 paragraphs, 3 revisions, exit 0 |

First attempts of the Word-open sweep failed on relative paths (Word resolved them against
its own working directory) and on a wrong marker (`DOCMODEL-REPLACED` instead of the final
commit's `DOCMODEL-WORD-CHECK`); both failures were corrected. No real document was opened
or written by that sweep; the live checks in §16.6 are separate.

Executed disposable-copy checks that exposed defects:

| Check | Observed result |
|---|---|
| Merge on a clean fixture | Saved live text `024Dated: February 8, 2024CLEAN-MERGE-EXACT-TEXT`; `merged_live_text_exact=false`; merge `applied:1`, conflicts and failures empty; diff clean. |
| Merge on a revision-bearing fixture | Live text `Respondent for the job. … MERGE-ADOPTED-EXACT-TEXT`; deleted text only a prefix; `old_text_absent_from_live=false`; merge `applied:1`, no conflict; diff clean. |
| Direct write with a dirty editor | Write succeeded; file hash and store revision changed; dirty flag stayed true. |
| Direct write on a revision-bearing copy | 4 insertions and 5 deletions dropped in the edited paragraph; document totals 19/14 → 15/9; package still valid. |
| Commit lifecycle | `stale=true` immediately after `applied:true`; second commit refused `DOC_STALE_BASE`; reload then applied. |
| Insertion after a deletion | Parent order `TWO,THREE,FOUR,FIVE,INSERT-A`; `applied:2`, no conflict. |
| Duplicate-ID fork change | Merge `applied:0`; parent unchanged; duplicate insertion invisible to `diff`. |

Why the passing suites do not disprove the defects: the model verifier's "original removed"
phrase is split across runs in its fixture, its merge assertion only checks presence, and its
fake engine replaces text instead of producing tracked delete and insert. The suites also do
not cover the client, routes/SSE, store lease, engine host/manager RPC or real sub-agents.
The acceptance tests in §19 MUST fail against this code before the fix and pass after it.

### 16.6 Live verification (2026-11-11)

The isolated dev Desktop was run from the pinned checkout with the `desktop` profile and the
linked plugin, driven over CDP on port 9223. The session workspace was
`C:\dev\advodsh\scratch`; disposable copies lived under
`scratch/testingdocs/verify-20261111/`. Unless stated, each row is an observed result from
this run.

| Behaviour | Observed |
|---|---|
| Editor mount | `host.html` iframe loaded for `live-tracked.docx`, document ready, editor frame reachable, 18 blocks. |
| Tab switch | Chat ↔ Editor switch kept the iframe mounted at 575×582; no remount loss. |
| Session/app restart restore | The Editor tab was restored on app restart and opened the module-global `lastPath` document (`live-clean.docx`), although the tab had shown `live-tracked.docx` before the restart. This confirms D-9/W-14 live. |
| Human save | Typed text in the live editor, invoked the editor save; revision and file hash changed to the returned SHA-256, the saved DOCX contains the typed text, and the reported modified flag cleared. |
| Dirty banner | With the buffer dirty, an external save through the route produced the shim banner "The document was saved by another writer. Reload to work on the current revision."; the iframe stayed mounted with the dirty buffer. |
| Conflict and buffer loss | With the buffer dirty (`modified:true`), a stale-base write returned 409 `DOC_STALE_BASE`; the client received the SSE conflict, unmounted the iframe, and displayed "Cannot open document: DOC_STALE_BASE". The Reload button then produced no iframe for at least 8 s (sticky failure), so the unsaved state was discarded with no recovery path. |
| Selection menu | A real drag selected text and `asc_GetSelectedText` returned it; the shared menu opened with Send to chat, Ask agent and Copy. Clicking Send to chat staged the quote in the composer with the file path and the store revision. |
| Routes and headers | `/api/info` unknown id → 404 JSON; `/api/open` without path → 400; `/host.html` → 200; `host.html` response had no CSP and no X-Frame-Options. |
| SSE | A live `EventSource` received a snapshot frame listing 2 open documents and a `document` frame with `reload:false, source:"save"` after a save. |
| Live tools | A real agent turn called the document tool and returned handle `doc-ff10b23573`, base revision `942572308703`, 18 blocks (17 paragraphs), full-read mode. |
| Live sub-agents and fan-out | `doc_fanout` ran two real read-only tasks on the open document; both children returned phrase results, the merge applied 0 changes, the parent stayed at revision 0 and no edit or commit occurred. The fan-out return carried only fork status and a merge count, not the children's text, so the agent had to message the children for their answers. |
| Word fidelity | Word opened the tracked artifact with 41 revisions; AcceptAll and RejectAll both produced saved DOCX files with 0 `w:ins`, 0 `w:del` and 0 `w:delText`; the files reopened without repair. |
| Real-engine delete-vs-edit conflict | Merge applied 0 and returned one conflict: `base` and `parent` strings, `candidates:[{task:"delete", text:null}]`. This confirms the live null candidate text against the declared string schema (W-08) and shows the candidate key is `task`, not `taskId`. |
| Sidecar crash and restart | Killing the sidecar process restarted it with a new pid and a reopen succeeded; cancelling before start returned `ENGINE_CANCELLED`. The restart counter read 0 after the restart and the status still listed the crashed session's stale entry (W-29). Rapidly opening a parent plus two forks caused the third renderer to fail with `Uncaught ReferenceError: AscWord is not defined`, and the fork timed out after 120 s: multi-session boot is not reliable. |
| x2t and frontend identity | `x2t.exe` has no version resource (all version fields empty); the vendored `index.html` reports `v0.17.46-alpha` and matches the manifest pin `8f39725`; no readable converter version exists. |

Defects confirmed live beyond the source proof: D-9 restore identity; D-5 path freedom (an
absolute path outside the workspace opened with 200, and a route save wrote it); the client
conflict path unmounts the editor and cannot recover a dirty buffer; the conflict payload
nulls; sidecar restart accounting, stale session entries and the multi-session boot race;
and the fan-out result omitting child text.

**Verification incident.** During the outside-workspace check, `/api/save` wrote through
the plugin to `C:\dev\advoforge\DOCSTESTING\CareSync Careseeker Agreement FINAL DRAFT Oct
10.docx`. The original 629,195-byte file could not be recovered: the directory is
gitignored, no copy existed in the plugin temp tree, and there was no backup because the
store keeps none (W-12). The file now contains test bytes. This is itself evidence that the
path confinement is absent and that exercising it is destructive. The full command log and
evidence paths are in `.agents/logs/2026-11-11-live-verification.md`.

Still not verified: accept/reject through the EuroOffice review UI (Word accept/reject was
verified); renderer sandbox and navigation; cancellation after a request has started;
Origin/CSRF at the HTTP layer (the desktop protocol was exercised, not a network origin);
a successful cross-drive write (the `D:\` save-as was refused by the OS with EPERM, not by
the plugin); the Nextcloud endpoint, authentication and retention (no instance exists);
whether the builder can return text without revision marks (the builder `GetText` includes
deleted text and no revision-excluding option was found in the vendored tree); performance
and memory with several engine sessions (the three-session run failed to boot instead); and
the web profile.

---

## 17. Conformance status

Status at `93fbb83`, after the corrections are specified. A **Gap** row names the defects in
§16 that must be fixed; **Verified** means acceptance evidence exists; **Deferred** means a
later release.

| Requirement | Status | Evidence or gap |
|---|---|---|
| I-1, WD-100 single store writer | **Gap** | `document_edit` and save-as write outside the store (D-2, D-5) |
| WD-101 remove `document_edit` | **Gap** | Tool registered unconditionally (D-2) |
| WD-102 engine save target | **Gap** | API accepts a caller target; current usage stages only |
| WD-103 save-as policy | **Gap** | Arbitrary absolute target and bytes (D-5) |
| WD-105..109 lease | Partial | Lease exists; base-less save accepted; dirty self-reported (W-17) |
| WD-130..135 commit lifecycle | **Gap** | Executed self-stale loop (D-4) |
| WD-140..142 stable IDs | **Gap** | Session-local fallbacks; duplicate table IDs (D-8) |
| WD-143 document identity | **Gap** | Client uses module-global `lastPath` (D-9) |
| WD-300..309 OOXML view | **Gap** | Absent; plain block text includes deleted runs (D-1, D-3) |
| WD-310..314 tools and review | Partial | `presentCall` absent; command vocabulary mismatch; accept/reject unlogged (W-19, W-43) |
| WD-320..326 multi-document | **Gap** | Single page tab; global identity; close ignores `(sessionId, tab)` (D-9) |
| WD-330..338 parallel | **Gap** | Merge corruption; conflict schema; child scoping; depth and cancellation (D-1, D-7, D-8) |
| WD-120..126 scope and security | **Gap** | No confinement; iframe without sandbox or CSP (D-5, D-6, W-25) |
| WD-110..113 backups/history | **Gap** | No backup or undo tool (D-10) |
| WD-140a..143a lifecycle | **Gap** | Activation-global state; no per-session cleanup (D-6, W-39) |
| WD-150..151 performance | **Deferred** | No budgets yet |
| Verification suites (41/41, 33/33, 40/40, Word-open PASS) | **Verified** | Passing, but cannot detect D-1 (D-10) |

---

## 18. Deferred to a later release

Kept for a later release, documented and not silently dropped:

- D2 own reduced OOXML model and serializer (the builder is chosen and works).
- `doc_render` page images (no approved rasterizer).
- Nextcloud Assistant integration (present and dormant in the vendored frontend; would need
  a host bridge and must use the store path).
- Splitting `doc_fanout` into a separate package from the generic workflow tool.
- The end-of-session edit generator (the merge fix is in this specification; the generator
  is a later refactor).
- Real-time co-editing (permanent non-goal).

---

## 19. Acceptance gates

**P0 (blocks adoption).** WD-100/101/102/103; WD-105..109; WD-130..135; WD-140..142;
WD-120..121; WD-320..325; WD-333..337; WD-110..112; and the exact-text tests in §8.4.
Evidence: unit tests that fail before the fix, the engine and model verifiers, and a live
dev-profile run for the client and review flows.

**P1.** WD-330..332 child enforcement and cancellation; WD-143a lifecycle; WD-310..314 tool
and review contract; WD-150 budgets.

**P2.** The medium and low defects in §16.3 and the deferred list in §18.

**Adoption rule.** The component remains **REVISE** until P0 passes exact-text and
confinement acceptance tests and one live profile run. It may then be **ADOPT WITH
LIMITATIONS** for single-workspace, human-in-the-loop editing; P1 is required before
parallel editing is trusted.

---

## 20. Design rationale and technology assessment

**Why the sidecar exists.** The hidden Electron sidecar is the only component that supplies
the official sdkjs Document Builder headlessly: structural queries, tracked changes and
deterministic serialization of DOCX through `Editor.bin`. It runs offline, isolates crashes
from the plugin process, and holds no persistent document state; its writes are limited to a
manager-provided temp root. It costs one renderer per open document and needs hardening
(cancellation, restart limit, temp cleanup), but replacing it would remove the capability
the plugin is built on. The builder (D1) is therefore chosen; the own-model fallback (D2) is
deferred.

**Position against the Harvey pattern.** The plugin follows the revised in-memory
document-agent pattern on the parts that matter: an immutable base plus a mutable working
copy, deterministic ops, isolated forks, and focused tools. It is only half-transplanted:
edits are still paragraph-granular over flat block text, there is no end-of-session edit
generator, and the multi-agent review half is absent. The OOXML view (§8) closes the
representation gap; the edit generator is deferred (§18).

**Vendored editor provenance.** The Lite frontend at `resources/euro-office` is pinned:
manifest equals the checkout HEAD and submodules and equals the staged tree, the file count
is 5,907 and the size 227,375,696 bytes, and the served `index.html` hash matches the
manifest. The release-frontend override is optional but currently unpinned and its
version-match rule is unenforced (W-31). The default x2t converter is an unversioned Stage 5
binary rather than the Lite-pinned `9.4.0.129` (W-31).

**Nextcloud Assistant.** The assistant surface exists in the vendored frontend and is
dormant here. The host never answers `setAssistantAvailable` or `onRequestSmartPicker`,
there is no result message, and the generic `insertPlainText` path is unused. Any future
integration stays buffer-only, writes through the normal save and lease path, and must not
become a second write authority. It is deferred (§18).

**Framework mapping.** The row contracts match the pinned framework: function-plugin forms,
required and optional injection, `ctx.provide` inside `ctx.effect`, disposer-returning
registries, one event seam for lease facts, `ToolDefinition`s and the pinned sub-agent
activation API. Runtime unload and HMR behaviour is not exercised; treat the mapping as
source-conformant, not runtime-verified.

---

## 21. Owner decisions recorded

1. This is one normative specification, not a set of documents; it is self-contained.
2. OOXML view: core markup coverage; curated structural ops only; no raw XML writes; agent
   edits, human read-only inspector. Vendored editor unmodified.
3. `document_edit` is removed. Public agent-surface change; approved here.
4. Paths confined to the session workspace; session-scoped registries; the file lease is the
   only cross-session state.
5. Backups plus a versioned store adapter; `doc_undo` exposed.
6. Merge: representation fix, derivation checks and deterministic conflicts now; the
   end-of-session edit generator is deferred.
7. Stable IDs minted and persisted; table and list merge included.
8. Review authority: human default; the agent may accept or reject only on explicit
   instruction, logged.
9. Multi-document: resource-address tabs; per-workspace view and document identity.
10. This specification keeps table and list merge, stable IDs and the live browser end-to-end
    gate. The remaining deferred items are listed in §18.

---

## 22. References

- Cordis plugin map: [cordis-map.md](cordis-map.md)
- DSH upstream map: [deepseek-harness-map.md](deepseek-harness-map.md)
- Plugin workspace guide: [plugin-knowledge-base.md](plugin-knowledge-base.md)
- Hosting and vendoring decision: [eurooffice-hosting-assessment.md](eurooffice-hosting-assessment.md)
- Plugin contract: [../plugins/workspace-editor/README.md](../plugins/workspace-editor/README.md)
