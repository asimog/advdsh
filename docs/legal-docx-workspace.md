# Legal DOCX workspace — specification (revision 3)

This document specifies the fixes for the DOCX editor in the DSH plugin
`plugins/workspace-editor`. It is self-contained. A requirement states what must be true
after the fix. Line references are to the plugin source at commit `06b546c`.

| Item | Value |
|---|---|
| Component | `workspace-editor` bundle, six Cordis rows, version `0.3.0` |
| Framework | DSH `>=0.2.0 <0.3.0` (`engines.dsh` of the plugin), pinned read-only in `upstream/deepseek-harness` |
| Editor | Vendored EuroOfficeLite frontend at `resources/euro-office`, not modified |
| Vendoring decision | [eurooffice-hosting-assessment.md](eurooffice-hosting-assessment.md) |

How to read a requirement:

- **ID.** `WD-001`, `WD-002` and so on, in section order.
- **MUST sentence.** One sentence. It states one behavior.
- **Fixes** names the defect from section 21, or **Owner decision** names the decision from
  section 22.
- **Test** is the acceptance test: given, when, then. Text in `code style` is an exact value.
- **Today** is the behavior of the code now, with file and line.

Paths in **Today** lines are relative to `plugins/workspace-editor/`.

In a Test, "the agent" is the agent role that may call the tool (section 4.11). In a Test,
"commits" means a call of `doc_diff` and then a call of `doc_commit`.

---

## 1. Scope

### 1.1 Purpose

The plugin gives DSH a legal DOCX workspace. The vendored editor runs in the right dock.
The agent works from the chat pane. The human and the agent work on one controlled document.

### 1.2 In scope

1. One writer for document files, with one lease for each file.
2. A commit that leaves the agent session usable.
3. Agent text that is equal to the text the human sees.
4. Stable block IDs.
5. A markup view and structural edit operations.
6. Parallel editing with forks, a deterministic merge and explicit conflicts.
7. One editor tab for each document, in each workspace.
8. Path confinement and session scope.
9. Backups, history and undo.
10. Cleanup of sessions and of the engine sidecar.
11. Tests that can fail.
12. A reasoning step that works on text, and a separate apply step that works on markup.

### 1.3 Out of scope

PDF text editing. Editing of charts, SmartArt, shapes and equations. Real-time co-editing.
Raw OOXML written by the model. Changes to the vendored editor tree. Changes to the DSH
source. Publication and registry changes.

---

## 2. Terms

| Term | Meaning |
|---|---|
| **DSH session** | The harness session that owns tools, prompt context and client tabs. It has an ID and a working directory. |
| **Workspace root** | The working directory of the DSH session (`cwd` in the session header). |
| **Allowed root** | The workspace root, plus each directory in the configuration list `allowedRoots`. The list is empty by default. |
| **Store** | The service `ctx.editorDocuments`. It is the only component that writes a document file. |
| **Store adapter** | An optional service `editorDocumentsStore` that replaces the local file access of the store. It has `stat` and `write`. It can also have `backup` and `history`. |
| **Store revision** | The lowercase hex SHA-256 of the document file bytes. It is the only durable revision. |
| **Base revision** | The store revision that a writer read before it writes. |
| **Working copy** | The agent's document in the engine, or the human's buffer in the editor. A working copy is not a file. |
| **Model session** | One agent working copy. It belongs to one DSH session. It has a handle. |
| **Handle** | The string that names a model session in tool calls, for example `doc-ff10b23573`. |
| **Lease** | The record for one file that holds the store revision, the editor dirty state and the conflict state. |
| **Commit** | The agent writes its working copy through the store. A commit makes one store revision. |
| **Save** | The human editor writes its buffer through the store. |
| **Block** | One body element of the document: a paragraph or a table. |
| **Block ID** | The stable identity of a block. Section 4.2 defines the forms. |
| **Live text** | The text of the runs of a block that are not tracked deletions, in order, without the paragraph end mark. It includes tracked insertions. |
| **Deleted text** | The text of the runs that are tracked deletions. |
| **Op** | One edit operation that `doc_edit` applies to a working copy. |
| **Pending op** | An op that is applied to the working copy and is not committed. |
| **Fork** | A model session that is a copy of a parent working copy. A fork cannot commit. |
| **Merge** | The parent adopts the changes of its forks, block by block. |
| **Conflict** | A fork change that the merge does not adopt. Section 4.6 defines the payload. |
| **Markup view** | The reduced, read-only representation of the working copy: paragraphs, runs, properties, tables, sections and tracked changes. Section 4.7 defines the schema. |
| **Reasoning agent** | An agent that reads documents as text and decides which changes are necessary. It does not see markup and does not call `doc_edit`. |
| **Applier agent** | A child agent that `doc_fanout` starts for an `apply` task. It applies proposed changes to a fork with the markup view and the ops. It makes no legal decision. |
| **Change proposal** | One change that a reasoning agent proposes, in text terms. Section 4.12 defines the fields. |
| **Chunk** | The list of block IDs that one `doc_fanout` task may read or change. |
| **Constraints** | One text that `doc_fanout` gives to each child of a call, for example defined terms and cross-references that all children must keep. |
| **Host page** | The page `host.html` that runs the editor in the tab's iframe. |
| **Sidecar** | The hidden Electron process that runs the Document Builder for the engine. |
| **Review command** | A command that the `editor` tool sends to the host page. Section 4.8 lists the commands. |

---

## 3. Components

One bundle package, six Cordis rows, one client module.

| Row | Module | Provides |
|---|---|---|
| `workspace-editor` | `lib/index.js` | `ctx.editorDocuments` (store, lease, backups), HTTP routes, SSE channel |
| `workspace-docx-engine` | `lib/engine/index.js` | `ctx.docxEngine` (sidecar manager) |
| `workspace-docx-model` | `lib/model/index.js` | `ctx.docxModel` (model sessions, ops, forks, merge, commit) |
| `workspace-docx-tools` | `lib/tools/index.js` | The `doc_*` tools, the `editor` tool, the runtime context |
| `workspace-docx-fanout` | `lib/fanout/index.js` | `doc_fanout` |
| `workspace-legal-review` | `lib/review/index.js` | `doc_analyze`, the review skill, the analyzers |
| client | `lib/client.js` | The editor tab, the Edit action, the selection menu |

Data flow:

```
chat pane ── tools ──▶ docx-tools ──▶ docx-model ──▶ docx-engine ──▶ sidecar
                                          │
                                          ▼
editor tab ── host page ── routes ──▶ editorDocuments (store) ──▶ document file
```

---

## 4. Data contracts

### 4.1 Revisions

| Field | Owner | Type | Meaning |
|---|---|---|---|
| `storeRevision` | store | 64 hex characters | SHA-256 of the file bytes. Every write and every lease uses it. |
| `contentHash` | model session | 64 hex characters | SHA-256 of the bytes that the working copy was last loaded from. |
| `pendingOps` | model session | integer | The number of pending ops. |

No tool result has a field named `revision`.

### 4.2 Block IDs

| Block | Form | Rule |
|---|---|---|
| Paragraph | `w14:<n>` | `<n>` is the `w14:paraId` of the paragraph as a decimal number. |
| Table | `t:<h>` | `<h>` is 8 hex characters: the FNV-1a hash of the header row cells and the column count. |
| Table, same hash as an earlier table | `t:<h>#<k>` | `<k>` is the position among the tables with that hash, in document order, from 2. |

A block ID that starts with `p:`, `i:` or `e:` is not permitted.

### 4.3 Lease

Lease record, one for each absolute file path:

| Field | Type | Meaning |
|---|---|---|
| `path` | string | Absolute file path. |
| `storeRevision` | string | The current store revision. |
| `editorDirty` | boolean | The last dirty state that the host page reported. |
| `conflict` | string or null | The code of the last refused write, or null. |
| `holder` | string or null | The handle or the tab that wrote last. |

Lease states:

| State | Condition | Agent commit | Human save |
|---|---|---|---|
| `clean` | `editorDirty` is false, and the writer's base revision is equal to `storeRevision` | Permitted | Permitted |
| `editor-dirty` | `editorDirty` is true | Refused with `DOC_EDITOR_DIRTY` | Permitted when the base revision is current |
| `stale` | The writer's base revision is not equal to `storeRevision` | Refused with `DOC_STALE_BASE` | Refused with `DOC_STALE_BASE` |
| `conflict` | `conflict` is not null | As for the state above that applies | As for the state above that applies |

A successful write or a reload sets `conflict` to null.

### 4.4 Error codes

A tool error text has the form `Error: <CODE>: <message>`. A route error body has the form
`{ "error": "<message>", "code": "<CODE>" }`.

| Code | Meaning | HTTP status |
|---|---|---|
| `DOC_STALE_BASE` | The file is not at the base revision of the writer. | 409 |
| `DOC_EDITOR_DIRTY` | The editor has unsaved changes. | 409 |
| `DOC_BASE_REQUIRED` | The write has no base revision. | 400 |
| `DOC_OUTSIDE_WORKSPACE` | The path is not inside an allowed root. | 403 |
| `DOC_TARGET_EXISTS` | The save-as target exists and `overwrite` is not true. | 409 |
| `DOC_INVALID_TARGET` | The save-as target has a different file type. | 400 |
| `DOC_INVALID_ARGS` | A tool argument or a request field is missing, unknown or has the wrong type. | 400 |
| `DOC_SESSION_NOT_FOUND` | The handle or the document ID does not belong to the calling DSH session. | 404 |
| `DOC_TARGET_NOT_FOUND` | The op names a block, row or run that does not exist. | — |
| `DOC_AMBIGUOUS_TARGET` | The op names a block ID that more than one block has. | — |
| `DOC_STALE_TARGET` | The target text is not the expected text. | — |
| `DOC_INVALID_OP` | The op is not valid for the target. | — |
| `DOC_UNSUPPORTED_EDIT` | The engine cannot express the op. | — |
| `DOC_TOO_LARGE` | The document is too large for a full read. | — |
| `DOC_WRITE_DISABLED` | `WORKSPACE_DOCX_WRITE` is `off`. | — |
| `DOC_FORKED_COMMIT` | A fork cannot commit. | — |
| `DOC_UNDO_UNAVAILABLE` | There is no pending op to undo. | — |
| `DOC_COMMIT_FAILED` | The commit did not write. | — |
| `DOC_EDITOR_NOT_OPEN` | No host page for the document acknowledged the command. | — |
| `DOC_REVIEW_NOT_AUTHORIZED` | An accept or reject command has no `userInstruction`. | — |
| `DOC_FANOUT_DEPTH` | The deployment depth limit does not permit a child. | — |
| `DOC_APPLIER_ONLY` | The caller is not an applier agent. | — |
| `DOC_OUTSIDE_CHUNK` | The op changes a block that is not in the chunk of the applier agent. | — |
| `DOC_REVIEW_REQUIRED` | The working copy changed after the last `doc_diff` call. | — |
| `DOC_ENGINE_TIMEOUT` | The engine did not answer in time. | — |
| `DOC_ENGINE_UNAVAILABLE` | The sidecar is not running or cannot start. | — |
| `DOC_CLOSED` | The engine session is gone. Reload the document. | — |

Engine error mapping:

| Sidecar code | Engine code | Tool code |
|---|---|---|
| `TARGET_NOT_FOUND` | `ENGINE_TARGET_NOT_FOUND` | `DOC_TARGET_NOT_FOUND` |
| `AMBIGUOUS_TARGET` | `ENGINE_AMBIGUOUS_TARGET` | `DOC_AMBIGUOUS_TARGET` |
| `STALE_TARGET` | `ENGINE_STALE_TARGET` | `DOC_STALE_TARGET` |
| `WRONG_KIND`, `BAD_OP`, `UNKNOWN_OP` | `ENGINE_INVALID_OP` | `DOC_INVALID_OP` |
| `UNSUPPORTED` | `ENGINE_UNSUPPORTED` | `DOC_UNSUPPORTED_EDIT` |
| `TIMEOUT` | `ENGINE_TIMEOUT` | `DOC_ENGINE_TIMEOUT` |
| `CANCELLED` | `ENGINE_CANCELLED` | `ABORTED` |
| process exit, start failure | `ENGINE_CRASHED`, `ENGINE_START_FAILED`, `ENGINE_UNAVAILABLE` | `DOC_ENGINE_UNAVAILABLE` |
| session lost | `ENGINE_SESSION_LOST`, `ENGINE_SESSION_NOT_FOUND` | `DOC_CLOSED` |

### 4.5 SSE frames

The channel is `GET /workspace-editor/events?session=<DSH session ID>`.

| Frame `type` | Fields | Sent when |
|---|---|---|
| `snapshot` | `documents[]` | The connection opens. It lists the documents of that DSH session only. |
| `document` | `source`, `document`, `reload`, `closed` | A document opens, closes or gets a new store revision. |
| `editor` | `document`, `command`, `ok` | The host page reports its state or a command result. |
| `conflict` | `path`, `base`, `current`, `code` | The store refuses a write. |
| `command` | `id`, `path`, `command`, `args`, `requestId` | The `editor` tool sends a command to the host page. |
| `open` | `path`, `session` | The `editor` tool asks the client to open a tab. |

### 4.6 Merge result and conflict payload

Merge result:

| Field | Type | Meaning |
|---|---|---|
| `applied` | integer | The number of adopted changes. |
| `changed` | boolean | True when `applied` is more than 0. |
| `pendingOps` | integer | The pending ops of the parent after the merge. |
| `operations[]` | `{ op, id, task }` | One entry for each adopted change. `task` is the task label of the fork. |
| `conflicts[]` | Conflict | One entry for each change that is not adopted. |

Conflict:

| Field | Type | Meaning |
|---|---|---|
| `id` | string | The block ID. |
| `reason` | string | `both-changed`, `divergent-forks`, `delete-vs-edit`, `not-derived`, `unsupported` or `apply-failed`. |
| `base` | string or null | The live text of the block at the fork point. Null when the block did not exist. |
| `parent` | string or null | The live text of the block in the parent now. Null when the block does not exist. |
| `candidates[]` | `{ task, text }` | `task` is the task label. `text` is the live text in that fork, or null when the fork deleted the block. |

The output schema of `doc_fanout` declares `base`, `parent` and `candidates[].text` as
string or null.

### 4.7 Markup view

`doc_read` with `mode: "markup"` returns `view`:

| Field | Type | Meaning |
|---|---|---|
| `schema` | integer | The schema version. The value is `1`. |
| `nodes[]` | Node | The blocks in the requested range, in document order. |
| `truncated` | boolean | True when the node limit or the token limit stopped the output. |
| `next` | integer or null | The index of the first block that is not in the output. Null when `truncated` is false. |

Node kinds:

| `kind` | Fields |
|---|---|
| `paragraph` | `id`, `index`, `text` (live text), `props` (`style`, `align`, `indentLeft`, `indentRight`, `indentFirstLine`, `spacingBefore`, `spacingAfter`, `numbering`), `runs[]` |
| `run` | `runIndex`, `text`, `props` (`bold`, `italic`, `underline`, `size`, `font`, `color`, `highlight`), `inserted` (boolean), `deleted` (boolean), `author` |
| `table` | `id`, `index`, `rows[]`; each row has `cells[]`; each cell has `text` (live text) and `paragraphs[]` |
| `section` | `index`, `props` (`pageWidth`, `pageHeight`, `marginTop`, `marginBottom`, `marginLeft`, `marginRight`, `orientation`) |
| `opaque` | `type` (the construct name, for example `drawing`, `math`, `sdt`), and `id` and `index` for a block or `runIndex` for a run |

A run that holds a construct that the schema does not model is an `opaque` node in `runs[]`.

Limits: 400 nodes and 20,000 tokens for one read. A paragraph, a run, a table, a cell, a
section and an opaque node each count as one node. The default value of `props.align` is
`left`.

### 4.8 Review commands

| Command | Argument | Changes the document |
|---|---|---|
| `acceptAll` | — | Yes |
| `rejectAll` | — | Yes |
| `acceptSelection` | — | Yes |
| `rejectSelection` | — | Yes |
| `nextChange` | — | No |
| `prevChange` | — | No |
| `displayMode` | `final`, `original`, `simple` or `edit` | No |
| `trackChanges` | boolean | No |

### 4.9 Tools

Write tools are `doc_edit`, `doc_undo`, `doc_commit` and `doc_fanout`. The other tools are
read tools.

| Tool | Input | Output |
|---|---|---|
| `doc_open` | `path` | `handle`, `path`, `name`, `contentHash`, `storeRevision`, `pendingOps`, `readMode` (`full` or `large`), `blocks`, `paragraphs`, `tables`, `tokens`, `outline[]` |
| `doc_read` | `doc`, `mode` (`auto`, `full`, `outline`, `range`, `search`, `context`, `markup`), `redline`, `from`, `to`, `ids[]`, `query`, `limit`, `caseSensitive`, `blockId`, `index`, `before`, `after` | `doc`, `path`, `storeRevision`, `pendingOps`, `contentHash`, `mode`, `totalBlocks`, `tokens`, `text`, `truncated`, `blocks[]`, `matches[]`, `outline[]`, `view` (markup mode only) |
| `doc_search` | `doc`, `query`, `limit`, `caseSensitive` | `doc`, `path`, `query`, `truncated`, `matches[]` (`id`, `index`, `kind`, `snippet`) |
| `doc_edit` | `doc`, `type`, and the fields of the op (section 4.10) | `doc`, `path`, `pendingOps`, `op`, `tracked`, `changed`, `affected[]` (`id`, `index`, `kind`, `textBefore`, `textAfter`), `replacements` (`replace_text` only) |
| `doc_undo` | `doc` | `doc`, `undone`, `pendingOps`, `affected[]` |
| `doc_diff` | `doc` | `doc`, `path`, `changed`, `pendingOps`, `storeRevision`, `changes[]`, `counts`, `blocksChanged`, `blocksTotal` |
| `doc_check` | `doc`, `checks[]` | `doc`, `ok`, `codes[]`, `findings[]` |
| `doc_commit` | `doc`, `force` | `doc`, `path`, `applied`, `changed`, `storeRevision`, `previousRevision`, `size`, `contributors[]`, `blocksChanged`, `blocksTotal` |
| `doc_state` | `action` (`status`, `revisions`, `reload`, `close`), `doc` | `action`, `sessions[]`, `doc`, `closed`, `revisions`, `reloaded`, `storeRevision` |
| `doc_analyze` | `doc`, `checks[]` | `doc`, `ok`, `codes[]`, `findings[]` (`code`, `severity`, `message`, `blocks[]`) |
| `doc_fanout` | `doc`, `constraints`, `allowOverlap`, `tasks[]` (`label`, `kind` (`review` or `apply`), `blockIds[]`, `prompt`, `changes[]`), `concurrency` | `doc`, `forks[]` (`handle`, `label`, `status`, `summary`), `proposals[]` and `rejected[]` (`review` tasks), `changes[]` (`id`, `status`; `apply` tasks), `merged` (section 4.6) |
| `editor` | `action` (`status`, `open`, `save`, `reload`, `export_pdf`, `wait`, `review`), `path`, `doc`, `command`, `args`, `userInstruction`, `since`, `timeoutMs` | `action`, `documents[]`, `engine`, `document`, `executed`, `command`, `changeCount`, `userInstruction`, `path`, `storeRevision`, `changed`, `timedOut`, `pdf` |

The `editor` tool does not edit document text.

### 4.10 Ops

| Op `type` | Fields | Effect |
|---|---|---|
| `replace_paragraph` | `blockId`, `expectedText`, `text` | Replaces the live text of a paragraph. Tracked. |
| `insert_paragraph` | `afterBlockId` or `beforeBlockId`, `text`, `style` | Inserts a paragraph directly after or before the anchor block. Tracked. |
| `delete_paragraph` | `blockId`, `expectedText` | Deletes a paragraph. Tracked. |
| `insert_list_item` | `afterBlockId` or `beforeBlockId`, `text`, `numbering`, `level` | Inserts a list paragraph directly after or before the anchor block. Tracked. |
| `replace_text` | `find`, `replace`, `blockId` (optional) | Replaces each occurrence of `find` in the live text of one block or of all blocks. Tracked. |
| `insert_table_row` | `tableBlockId`, `cells[]`, `create` | Adds a row to a table. Tracked. |
| `delete_table_row` | `blockId`, `rowIndex` | Deletes a table row. Tracked. |
| `insert_table_column` | `blockId`, `columnIndex`, `cells[]` | Adds a column to a table. Tracked. |
| `delete_table_column` | `blockId`, `columnIndex` | Deletes a table column. Tracked. |
| `set_cell_text` | `blockId`, `rowIndex`, `columnIndex`, `expectedText`, `text` | Replaces the live text of a table cell. Tracked. |
| `set_run_text` | `blockId`, `runIndex`, `expectedText`, `text` | Replaces the text of one run. Tracked. |
| `set_run_props` | `blockId`, `runIndex`, `expectedText`, `props` | Sets run properties (section 4.7). Tracked. |
| `split_run` | `blockId`, `runIndex`, `expectedText`, `offset` | Splits one run into two at a character offset. |
| `merge_runs` | `blockId`, `runIndex`, `expectedText` | Merges a run with the run after it when their properties are equal. |
| `set_paragraph_props` | `blockId`, `expectedText`, `props` | Sets paragraph properties (section 4.7). Tracked. |
| `set_section_props` | `sectionIndex`, `props` | Sets section properties (section 4.7). |

No op has an `index` field for a block. An op names a block by its block ID.
`expectedText` is the live text of the target run, cell or paragraph. When an op has no
`expectedText`, the tool uses the live text that the session read last.

### 4.11 Agent roles

| Role | Tools | Text that the role reads |
|---|---|---|
| Reasoning agent | `doc_open`, `doc_read` (all modes but `markup`), `doc_search`, `doc_diff`, `doc_check`, `doc_analyze`, `doc_state`, `doc_fanout`, `doc_undo`, `doc_commit`, `editor` | Live text, or live text with inline redline tags |
| Review child (a `review` task) | `doc_read` (all modes but `markup`), `doc_search`, `doc_check`, `doc_analyze` | The same as the reasoning agent |
| Applier agent (an `apply` task) | `doc_read` (all modes), `doc_search`, `doc_edit`, `doc_diff` | Live text and the markup view |

Handles: `doc_fanout` gives a review child the handle of the parent, for reading only. It
gives an applier agent the handle of its own fork only.

The workflow has four steps:

1. **Reason.** The reasoning agent reads one or more documents as text. For a long document
   it calls `doc_fanout` with `review` tasks, one for each chunk.
2. **Propose.** The result of step 1 is a list of change proposals.
3. **Apply.** The reasoning agent calls `doc_fanout` with `apply` tasks. Each applier agent
   applies the change proposals of its chunk to a fork. The parent merges the forks.
4. **Review and commit.** The reasoning agent calls `doc_diff`, reads the changes, and
   calls `doc_commit`.

### 4.12 Change proposal

| Field | Type | Meaning |
|---|---|---|
| `id` | string | The identity of the proposal. It is unique in one `doc_fanout` call. |
| `kind` | string | `replace`, `insert`, `delete` or `format`. |
| `blockId` | string | The target block of a `replace`, `delete` or `format` proposal. |
| `afterBlockId` | string | The anchor block of an `insert` proposal. The new block comes directly after it. |
| `expectedText` | string | The live text of the target block or of the anchor block when the proposal was made. |
| `newText` | string | The live text that the block must have after a `replace` or an `insert`. |
| `instruction` | string | Plain words for a change that text cannot express, for example `make this paragraph a level 2 heading`. |
| `reason` | string | The legal reason for the change, in plain words. |

Status of a change proposal after an `apply` task:

| Status | Condition |
|---|---|
| `applied` | `replace` or `insert`: the block in the parent has the live text `newText`. `delete`: the block is not in the parent. |
| `not-applied` | The condition for `applied` is false. |
| `unverified` | `format`: the tool cannot compare text. |

Reason of a rejected change proposal of a `review` task: `invalid`, `unknown-block`,
`outside-chunk` or `stale-text`.

Inline redline tags: with `redline: true`, `doc_read` returns each tracked deletion as
`<del>text</del>` and each tracked insertion as `<ins>text</ins>` inside the block text.

---

## 5. Test fixtures

Each fixture is a DOCX file that the test suite builds. A paragraph is written as its runs
in order. `[del:x]` is a tracked deletion of `x`. `[ins:x]` is a tracked insertion of `x`.

| Fixture | Content |
|---|---|
| `F-CLEAN` | Five paragraphs with `w14:paraId` values 1 to 5 and the texts `ONE`, `TWO`, `THREE`, `FOUR`, `FIVE`. No tracked changes. |
| `F-TRACKED` | One paragraph with `w14:paraId` 1 and the runs `Paid to the `, `[del:r]`, `[ins:R]`, `espondent.` The live text is `Paid to the Respondent.` The deleted text is `r`. |
| `F-NOID` | The paragraphs of `F-CLEAN` without `w14:paraId` attributes. |
| `F-DUPID` | Two paragraphs `ALPHA` and `BETA` that have the same `w14:paraId` value 7. |
| `F-TABLES` | Paragraph `INTRO`, then two tables. Each table has one row with the cells `A` and `B`. |
| `F-SPLIT` | One paragraph with the runs `The Agree` and `ment.` The live text is `The Agreement.` |
| `F-BOLD` | One paragraph with style `Body Text` and the runs `plain ` and `BOLD` (bold). |
| `F-DRAWING` | Paragraph `BEFORE`, then a paragraph that contains one inline drawing, then paragraph `AFTER`. |
| `F-WORDS` | One paragraph with `w14:paraId` 1 and the text `The seller shall deliver the goods.` |
| `F-LARGE` | 500 paragraphs. Paragraph `n` has the text `PARA n`. No paragraph has a heading style. |

Test environments:

| Name | Meaning |
|---|---|
| **Unit** | `node --test` in `plugins/workspace-editor`, with the fake engine from `test/fixtures.mjs`. |
| **Engine** | A test that uses the real sidecar and the real converter on a copy of a fixture. |
| **Composition** | A test that loads the bundle in a DSH headless composition. |
| **Live** | A run of the app with the plugin loaded, driven by browser automation. It runs in the testweb harness first, and then in the localbuild harness (section 23). |

The testweb harness is the web build of the app in a browser. The localbuild harness is
the same web build in an Electron window. In a Live test, "the app restarts" means a reload
of the page in the testweb harness and a restart of the app in the localbuild harness.

---

## 6. Write authority

**WD-001** — The bundle MUST NOT register a tool named `document_edit`.
- Fixes: W-02. Owner decision: OD-3.
- Test: Given a Composition with the bundle and `WORKSPACE_DOCX_WRITE` not set, when the test lists the tool names, then the list does not contain `document_edit`.
- Today: `lib/index.js:562-624` registers `document_edit` in all cases. It writes the file through `lib/docs-edit.js:102-106` with no store, no lease and no tracked changes.

**WD-002** — When `WORKSPACE_DOCX_WRITE` is `off`, the bundle MUST register only the read tools.
- Fixes: W-02.
- Test: Given a Composition with `WORKSPACE_DOCX_WRITE=off`, when the test lists the tool names of the bundle in alphabetical order, then the list is exactly `doc_analyze`, `doc_check`, `doc_diff`, `doc_open`, `doc_read`, `doc_search`, `doc_state`, `editor`.
- Today: `lib/index.js:562` registers `document_edit` without a check of the variable, so one write tool stays.

**WD-003** — When `WORKSPACE_DOCX_WRITE` is `off`, the `editor` tool MUST refuse the `save` action and each review command that changes the document with `DOC_WRITE_DISABLED`.
- Fixes: W-02.
- Test: Given a Composition with `WORKSPACE_DOCX_WRITE=off`, when the agent calls `editor` with `action: "review"` and `command: "acceptAll"`, then the error text starts with `Error: DOC_WRITE_DISABLED:` and no `command` frame is sent.
- Today: `lib/tools/index.js:780-791` sends the command without a check of the variable.

**WD-004** — `ctx.docxEngine.save` MUST NOT write to a path that the caller supplies.
- Fixes: W-49.
- Test: Given a Unit test with a stub sidecar and a path `X` that does not exist, when the test calls `save(sessionId, { targetPath: X })`, then the result has `bytes` and the file `X` does not exist.
- Today: `lib/engine/manager.js:696-707` writes the bytes to `options.targetPath`, or to the path that the session was opened from.

**WD-005** — Save-as MUST refuse a target file that exists unless the request has `overwrite=true`.
- Fixes: W-05.
- Test: Given an open document `a.docx` and an existing file `b.docx` in the workspace root, when the host page posts `/api/save-as` with `path=b.docx` and no `overwrite`, then the status is 409, the code is `DOC_TARGET_EXISTS` and the SHA-256 of `b.docx` does not change.
- Today: `lib/docs.js:501-514` writes the target with an empty option set, so it overwrites an existing file.

**WD-006** — Save-as MUST refuse a target whose file extension is different from the extension of the open document.
- Fixes: W-05.
- Test: Given an open document `a.pdf`, when the host page posts `/api/save-as` with `path=b.docx`, then the status is 400, the code is `DOC_INVALID_TARGET` and `b.docx` does not exist.
- Today: `lib/docs.js:510-511` writes the request body of a PDF document to a target with any extension.

---

## 7. Lease and human save

**WD-007** — The store MUST refuse a human save that has no base revision.
- Fixes: W-17.
- Test: Given an open document, when the test posts `/api/save` with no `base` parameter and no `x-workspace-editor-base` header, then the status is 400, the code is `DOC_BASE_REQUIRED` and the SHA-256 of the file does not change.
- Today: `lib/docs.js:461-469` skips the base check when `base` is absent and then writes with the revision that it read a moment before.

**WD-008** — `editorDocuments.applyBytes` MUST refuse a write that has no base revision.
- Fixes: W-17.
- Test: Given a Unit test with a document file, when the test calls `applyBytes(path, bytes, {})`, then the call rejects with code `DOC_BASE_REQUIRED` and the file does not change.
- Today: `lib/docs.js:387-389` and `lib/docs.js:410` write without a base check when `baseRevision` is absent.

**WD-009** — An editor state report that has no boolean `modified` field MUST NOT change `editorDirty`.
- Fixes: W-17.
- Test: Given an open document whose `modified` is `true`, when the test posts `/api/editor` with the fields `id`, `command: "nextChange"` and `ok: true` only, then `/api/info` returns `"modified": true`.
- Today: `lib/docs.js:524` sets `modified` to `false` when the field is absent. `lib/editor/shim.js:187` sends such a report after each command.

**WD-010** — The host page MUST send a failed state report again until the server answers with status 200.
- Fixes: W-17.
- Test: Given a host page whose first `POST /api/editor` gets status 500, when the editor buffer becomes modified, then `/api/info` returns `"modified": true` within 5 seconds.
- Today: `lib/editor/shim.js:60-69` sends the report one time and ignores a failure.

---

## 8. Commit

**WD-011** — A successful commit MUST leave the model session not stale.
- Fixes: W-04.
- Test: Given an Engine test that opens a copy of `F-CLEAN`, when the test replaces `TWO` with `TWO-A`, commits, replaces `THREE` with `THREE-A` and commits again without a reload, then `doc_state status` after the first commit has `"stale": false`, the second commit returns `"applied": true`, and the file has the live texts `ONE`, `TWO-A`, `THREE-A`, `FOUR`, `FIVE`.
- Today: `lib/docs.js:440` emits `saved` before `lib/model/model.js:954` advances the base revision, so `lib/model/model.js:1311` sets `stale` to `true`. The second commit fails at `lib/model/model.js:884-888`.

**WD-012** — A commit and a reload MUST set `contentHash` to the SHA-256 of the file bytes.
- Fixes: W-24.
- Test: Given a Unit test with an open model session whose first `contentHash` is `H0`, when the test commits one edit, then `doc_state status` returns a `contentHash` that is equal to the SHA-256 of the file, and `rehydrate(H0)` rejects with `DOC_SESSION_NOT_FOUND`.
- Today: `lib/model/model.js:425-435` and `lib/model/model.js:1210-1227` do not change `contentHash`, and `lib/model/model.js:1249-1254` finds the session by the old hash.

---

## 9. Text and ops

**WD-013** — The `text` of each block and of each table cell that the engine describes MUST be the live text.
- Fixes: W-03.
- Test: Given an Engine test that opens `F-TRACKED`, when the agent calls `doc_read` with `mode: "full"`, then `text` is exactly `[w14:1] Paid to the Respondent.`
- Today: `lib/engine/host/host-bridge.js:242` reads `GetText`, which returns the deleted text and the paragraph end mark: `Paid to the rRespondent.\r\n`.

**WD-014** — `doc_search` MUST match the query against the live text.
- Fixes: W-03.
- Test: Given an Engine test that opens `F-TRACKED`, when the agent calls `doc_search` with `query: "the Respondent"`, then `matches` has exactly 1 entry and its `id` is `w14:1`.
- Today: `lib/model/model.js:648-650` searches `block.text`, which contains `the rRespondent`, so the search finds nothing.

**WD-015** — After `replace_paragraph` with `text` T, the live text of the target paragraph MUST be exactly T.
- Fixes: W-01, W-37.
- Test: Given an Engine test that opens a copy of `F-TRACKED`, when the agent replaces block `w14:1` with `NEW TEXT` and commits, then the paragraph in the saved file has the live text `NEW TEXT`, and `doc_read` returns `[w14:1] NEW TEXT`.
- Today: `lib/engine/host/host-bridge.js:339-360` deletes a range whose length is the length of the mixed live and deleted text, so parts of the old live text stay in the paragraph.

**WD-016** — `insert_paragraph` MUST give the new paragraph the style in `style`, or the style of the block before the insertion point when `style` is absent.
- Fixes: W-37.
- Test: Given an Engine test that opens `F-BOLD`, when the agent inserts a paragraph `NEXT` with `afterBlockId: "w14:1"` and no `style`, then `doc_read` with `mode: "markup"` returns for the new block `props.style` equal to `Body Text`.
- Today: `lib/engine/host/host-bridge.js:378-379` creates the paragraph with no style.

**WD-017** — `doc_edit` MUST support the op `replace_text`, which replaces each occurrence of `find` in the live text as a tracked change, also when the occurrence is in more than one run.
- Fixes: W-38.
- Test: Given an Engine test that opens a copy of `F-SPLIT`, when the agent calls `doc_edit` with `type: "replace_text"`, `find: "Agreement"` and `replace: "Contract"`, then the result has `"replacements": 1` and `doc_read` returns `[w14:1] The Contract.`
- Today: `lib/model/model.js:55-62` has no such op, so the call fails with `DOC_INVALID_OP`.

**WD-018** — `insert_table_row` MUST fail with `DOC_TARGET_NOT_FOUND` when the target table does not exist and `create` is not `true`.
- Fixes: W-47.
- Test: Given an Engine test that opens `F-CLEAN`, when the agent calls `doc_edit` with `type: "insert_table_row"`, `tableBlockId: "t:00000000"` and `cells: ["X"]`, then the error text starts with `Error: DOC_TARGET_NOT_FOUND:` and `doc_diff` returns `"changed": false`.
- Today: `lib/engine/host/host-bridge.js:438-444` creates a new table at the end of the document unless `create` is `false`.

**WD-019** — `doc_read` with `mode: "outline"` MUST return a fixed hint text when the document has no heading.
- Fixes: W-22.
- Test: Given a Unit test with `F-LARGE`, when the agent calls `doc_read` with `mode: "outline"`, then `text` is exactly `No headings. Use range, search or context.`
- Today: `lib/model/model.js:612-619` returns an empty `text`, and `lib/tools/index.js:221` shows `no content`.

---

## 10. Block identity

**WD-020** — When a paragraph has no `w14:paraId`, the engine MUST give it a new `w14:paraId` when the document opens.
- Fixes: W-11. Owner decision: OD-7.
- Test: Given an Engine test that opens `F-NOID`, when the agent calls `doc_read` with `mode: "full"`, then each of the 5 block IDs matches `^w14:[1-9][0-9]*$` and the 5 IDs are different.
- Today: `lib/engine/host/host-bridge.js:239-241` gives such a paragraph the ID `p:<internal id>` or `i:<index>`.

**WD-021** — A commit MUST write each new `w14:paraId` into the document file.
- Fixes: W-11. Owner decision: OD-7.
- Test: Given an Engine test that opens a copy of `F-NOID` and records the 5 block IDs, when the agent replaces `TWO` with `TWO-A`, commits and closes, and a second DSH session opens the file, then `doc_open` of the second session returns `"blocks": 5`, and its 5 block IDs are equal to the recorded IDs, in the same order.
- Today: `lib/engine/host/host-bridge.js:241` makes the ID from an internal ID that is different in each engine session.

**WD-022** — A fork MUST report the same block ID as its parent for each block that the fork did not create.
- Fixes: W-11. Owner decision: OD-7.
- Test: Given an Engine test that opens `F-NOID` and makes one fork, when the test reads the block IDs of the parent and of the fork, then each list has 5 entries that match `^w14:[1-9][0-9]*$`, and the two lists are equal.
- Today: `lib/model/model.js:1003` opens the fork as a new engine session, and `lib/engine/host/host-bridge.js:241` gives it different internal IDs.

**WD-023** — Each table in a document MUST have a block ID that no other block has.
- Fixes: W-11. Owner decision: OD-7.
- Test: Given an Engine test that opens `F-TABLES`, when the agent calls `doc_read` with `mode: "full"`, then the block IDs of the two tables are `t:<h>` and `t:<h>#2` with the same `<h>`.
- Today: `lib/engine/host/host-bridge.js:279-283` gives the two tables the same ID.

**WD-024** — An op whose block ID is the ID of more than one block MUST fail with `DOC_AMBIGUOUS_TARGET`.
- Fixes: W-11.
- Test: Given an Engine test that opens `F-DUPID`, when the agent calls `doc_edit` with `type: "replace_paragraph"`, `blockId: "w14:7"` and `text: "X"`, then the error text starts with `Error: DOC_AMBIGUOUS_TARGET:` and `doc_diff` returns `"changed": false`.
- Today: `lib/engine/host/host-bridge.js:315-322` applies the op to the first block that has the ID.

---

## 11. Markup view and structural ops

**WD-025** — `doc_read` MUST accept `mode: "markup"` and return the markup view of section 4.7.
- Owner decision: OD-2.
- Test: Given an Engine test that opens `F-BOLD`, when the agent calls `doc_read` with `mode: "markup"`, then `view.schema` is `1`, `view.nodes[0].kind` is `paragraph`, and its runs are `plain ` with `props.bold` `false` and `BOLD` with `props.bold` `true`.
- Today: `lib/model/model.js:65` has no `markup` mode, so `lib/model/model.js:573-575` fails with `DOC_INVALID_OP`.

**WD-026** — The markup view MUST mark each tracked deletion run with `deleted: true` and each tracked insertion run with `inserted: true`.
- Fixes: W-03. Owner decision: OD-2.
- Test: Given an Engine test that opens `F-TRACKED`, when the agent reads the markup view, then the run texts are `Paid to the `, `r`, `R`, `espondent.` in that order, the second run has `"deleted": true`, the third run has `"inserted": true`, and the paragraph `text` is `Paid to the Respondent.`
- Today: `lib/engine/host/host-bridge.js:242` returns one text string for a paragraph, with no run data.

**WD-027** — The markup view MUST return each construct that the schema does not model as a node of kind `opaque`.
- Owner decision: OD-2.
- Test: Given an Engine test that opens `F-DRAWING`, when the agent reads the markup view, then the first run of the block at index 1 is `{ "kind": "opaque", "runIndex": 0, "type": "drawing" }`.
- Today: `lib/engine/host/host-bridge.js:226-289` describes block text only.

**WD-028** — An op that the engine cannot express MUST fail with `DOC_UNSUPPORTED_EDIT`.
- Owner decision: OD-2.
- Test: Given an Engine test that opens `F-DRAWING`, when the agent calls `doc_edit` with `type: "set_run_text"` on run 0 of the block at index 1, then the error text starts with `Error: DOC_UNSUPPORTED_EDIT:` and `doc_diff` returns `"changed": false`.
- Today: `lib/model/model.js:188-193` refuses each op that is not in its list with `DOC_INVALID_OP`.

**WD-029** — A markup read that reaches a limit MUST return `truncated: true` and the index of the next block in `next`.
- Owner decision: OD-2.
- Test: Given an Engine test that opens `F-LARGE`, when the agent calls `doc_read` with `mode: "markup"` and `from: 0`, then `view.truncated` is `true` and `view.next` is `200`.
- Today: `lib/model/model.js:65` has no `markup` mode.

**WD-030** — `doc_edit` MUST support the op `set_run_props`.
- Owner decision: OD-2.
- Test: Given an Engine test that opens a copy of `F-BOLD`, when the agent sets `props: { "bold": true }` on run 0 of block `w14:1` and commits, then the markup view of the saved file has `props.bold` `true` for the run `plain `.
- Today: `lib/model/model.js:55-62` has no such op.

**WD-031** — `doc_edit` MUST support the op `set_run_text`, which keeps the properties of the run.
- Owner decision: OD-2.
- Test: Given an Engine test that opens a copy of `F-BOLD`, when the agent calls `set_run_text` on run 1 with `expectedText: "BOLD"` and `text: "STRONG"`, then the paragraph live text is `plain STRONG` and the run `STRONG` has `props.bold` `true`.
- Today: `lib/model/model.js:55-62` has no such op.

**WD-032** — `doc_edit` MUST support the op `split_run`.
- Owner decision: OD-2.
- Test: Given an Engine test that opens `F-BOLD`, when the agent calls `split_run` on run 1 with `offset: 2`, then the run texts are `plain `, `BO`, `LD` and the last two runs have `props.bold` `true`.
- Today: `lib/model/model.js:55-62` has no such op.

**WD-033** — `doc_edit` MUST support the op `merge_runs`.
- Owner decision: OD-2.
- Test: Given an Engine test that opens `F-SPLIT`, when the agent calls `merge_runs` on run 0, then the paragraph has exactly one run with the text `The Agreement.`
- Today: `lib/model/model.js:55-62` has no such op.

**WD-034** — `doc_edit` MUST support the op `set_paragraph_props`.
- Owner decision: OD-2.
- Test: Given an Engine test that opens `F-CLEAN`, when the agent sets `props: { "align": "center" }` on block `w14:2`, then the markup view has `props.align` `center` for block `w14:2` and `left` for block `w14:1`.
- Today: `lib/model/model.js:55-62` has no such op.

**WD-035** — `doc_edit` MUST support the table ops `set_cell_text`, `insert_table_column` and `delete_table_column`.
- Owner decision: OD-2.
- Test: Given an Engine test that opens `F-TABLES`, when the agent calls `set_cell_text` on the first table with `rowIndex: 0`, `columnIndex: 1`, `expectedText: "B"` and `text: "C"`, and then `insert_table_column` with `columnIndex: 2` and `cells: ["D"]`, then the first table row is `A`, `C`, `D` and the second table row is `A`, `B`.
- Today: `lib/model/model.js:55-62` has no such ops.

**WD-036** — `doc_edit` MUST support the op `set_section_props`.
- Owner decision: OD-2.
- Test: Given an Engine test that opens `F-CLEAN`, when the agent sets `props: { "orientation": "landscape" }` on section 0, then the markup view has a `section` node with `props.orientation` `landscape`.
- Today: `lib/model/model.js:55-62` has no such op.

**WD-037** — The editor tab MUST show the markup view of its document in a read-only inspector pane outside the editor iframe.
- Owner decision: OD-2.
- Test: Given a Live run with `F-BOLD` open in a tab, when the user selects the `Markup` button of the tab, then a pane shows the two runs `plain ` and `BOLD`, and the pane has no input element.
- Today: `lib/client.js:234-249` has only the Reload and Export PDF controls.

---

## 12. Merge and parallel editing

**WD-038** — After a merge adopts a fork change to a paragraph, the live text of that paragraph in the parent MUST be equal to its live text in the fork.
- Fixes: W-01. Owner decision: OD-6.
- Test: Given an Engine test that opens a copy of `F-TRACKED` and makes one fork, when the fork replaces block `w14:1` with `MERGED TEXT`, the parent merges and commits, then the merge returns `"applied": 1` and the paragraph in the saved file has the live text `MERGED TEXT`.
- Today: `lib/model/model.js:1151` takes the fork block text and `lib/model/model.js:1165-1170` applies it as a paragraph replace on mixed live and deleted text. The result keeps old live text.

**WD-039** — A merge MUST put each inserted block between the same two neighbor blocks that it has in the fork.
- Fixes: W-09.
- Test: Given a Unit test with `F-CLEAN` and two forks, when fork `a` deletes `ONE`, fork `b` inserts `INSERT-A` before `FIVE`, and the parent merges both, then the parent block texts are exactly `TWO`, `THREE`, `FOUR`, `INSERT-A`, `FIVE`.
- Today: `lib/model/model.js:1142-1148` computes the insertion index before `lib/model/model.js:1155-1162` applies the deletions. The result is `TWO`, `THREE`, `FOUR`, `FIVE`, `INSERT-A`.

**WD-040** — A merge MUST adopt a fork change to a table as table ops.
- Fixes: W-10. Owner decision: OD-7.
- Test: Given an Engine test that opens `F-TABLES` and makes one fork, when the fork adds the row `X`, `Y` to the first table and the parent merges, then the first table of the parent has the rows `A`, `B` and `X`, `Y`, and `operations[0].op` is `insert_table_row`.
- Today: `lib/model/model.js:1151` queues a `replace_paragraph` for the table ID. The engine refuses it at `lib/engine/host/host-bridge.js:368`.

**WD-041** — A merge MUST adopt a table that a fork created as a table.
- Fixes: W-10. Owner decision: OD-7.
- Test: Given an Engine test that opens `F-CLEAN` and makes one fork, when the fork creates a table with the row `P`, `Q` and the parent merges, then the last block of the parent has `kind` `table`.
- Today: `lib/model/model.js:1136-1148` queues the table as an inserted paragraph with the table text.

**WD-042** — A merge MUST adopt a list item that a fork created with its list numbering.
- Fixes: W-10. Owner decision: OD-7.
- Test: Given an Engine test that opens `F-CLEAN` and makes one fork, when the fork inserts the list item `ITEM` with `afterBlockId: "w14:5"` and the parent merges, then the block `ITEM` of the parent has `numbering.level` `0`.
- Today: `lib/model/model.js:1182-1186` inserts each new block with `insert_paragraph`.

**WD-043** — A merge MUST return each fork change that it does not adopt as a conflict with a `reason`.
- Fixes: W-10.
- Test: Given a Unit test with `F-CLEAN`, one fork that replaces `TWO` with `TWO-F`, and a fake engine that refuses that adoption op, when the parent merges, then the result has no `failed` field and `conflicts[0]` has `"id": "w14:2"` and `"reason": "apply-failed"`.
- Today: `lib/model/model.js:1159-1161` and `lib/model/model.js:1172-1174` put such a change in `failed` with a code and no texts.

**WD-044** — When one adoption op of a merge fails, the merge MUST undo the ops that it applied.
- Fixes: W-10.
- Test: Given a Unit test with `F-CLEAN`, one fork that replaces `TWO` with `TWO-F` and `FOUR` with `FOUR-F`, and a fake engine that refuses the second adoption op, when the parent merges, then the result has `"applied": 0` and the parent block texts are exactly `ONE`, `TWO`, `THREE`, `FOUR`, `FIVE`.
- Today: `lib/model/model.js:1155-1191` keeps each op that it applied before the failure.

**WD-045** — The output schema of `doc_fanout` MUST permit null for `base`, `parent` and `candidates[].text` of a conflict.
- Fixes: W-08.
- Test: Given a Composition test with a stub child provider and `F-CLEAN`, when `doc_fanout` runs with `allowOverlap: true`, fork `a` deletes `TWO`, fork `b` replaces `TWO` with `TWO-B` and `doc_fanout` returns, then the tool result is not an error and `merged.conflicts[0]` has `"reason": "delete-vs-edit"` and one candidate with `"task": "a"` and `"text": null`.
- Today: `lib/fanout/index.js:89-97` declares the three fields as `string`. `lib/model/model.js:1109-1113` returns null.

**WD-046** — A merge result and the next commit record MUST name the task label of each fork whose change was adopted.
- Fixes: W-36.
- Test: Given a Unit test with `F-CLEAN` and one fork with the label `task-a` that replaces `TWO`, when the parent merges and commits, then `operations[0].task` is `task-a` and the `doc_commit` result has `"contributors": ["task-a"]`.
- Today: `lib/model/model.js:1158` and `lib/model/model.js:1171` record the op and the block ID only. `lib/model/model.js:943-952` records no contributor.

**WD-047** — The child of an `apply` task MUST see only the tools `doc_read`, `doc_search`, `doc_edit` and `doc_diff`.
- Fixes: W-07.
- Test: Given a Composition test in which `doc_fanout` starts one child for an `apply` task, when the child lists its tool names in alphabetical order, then the list is exactly `doc_diff`, `doc_edit`, `doc_read`, `doc_search`.
- Today: `lib/fanout/index.js:160-170` starts the child with no tool restriction. The child sees all global tools.

**WD-048** — A doc tool call from an applier agent MUST fail with `DOC_SESSION_NOT_FOUND` when the handle is not the fork handle of that agent.
- Fixes: W-07.
- Test: Given a Composition test in which `doc_fanout` starts one applier agent for the parent handle `H`, when the applier agent calls `doc_edit` with `doc: H`, then the error text starts with `Error: DOC_SESSION_NOT_FOUND:` and the parent has `"pendingOps": 0`.
- Today: `lib/model/model.js:271-277` resolves each handle for each caller.

**WD-049** — The prompt of an applier agent MUST NOT contain the handle of the parent.
- Fixes: W-07.
- Test: Given a Unit test that captures the child prompt for the parent handle `doc-0123456789`, when `doc_fanout` starts an applier agent, then the prompt does not contain `doc-0123456789`.
- Today: `lib/fanout/index.js:280` writes `(parent <handle>)` into the prompt.

**WD-050** — `doc_fanout` MUST fail with `DOC_FANOUT_DEPTH` when the delegation depth of the caller is equal to or more than the deployment depth limit.
- Fixes: W-34.
- Test: Given a Composition with the subagent setting `maxDepth: 0`, when the root agent calls `doc_fanout` with one task, then the error text starts with `Error: DOC_FANOUT_DEPTH:` and no child starts.
- Today: `lib/fanout/index.js:262-266` passes its own value `delegationDepth + 1` as the limit, so the deployment limit has no effect.

**WD-051** — When the tool call is cancelled, `doc_fanout` MUST dispose each child that it started.
- Fixes: W-35.
- Test: Given a Unit test with a stub provider whose two children do not finish, when the test aborts the tool call signal, then `dispose` is called one time on each of the two activations and the parent has `"pendingOps": 0`.
- Today: `lib/fanout/index.js:153-164` reads the signal only before a child starts. `lib/fanout/index.js:178` then waits for the child result.

**WD-052** — The rendered result of `doc_fanout` MUST contain the summary text of each child.
- Fixes: W-48.
- Test: Given a Unit test with a stub child whose label is `a` and whose output is `Changed w14:2.`, when the test renders the tool result, then the text contains the line `a=completed: Changed w14:2.`
- Today: `lib/fanout/index.js:129-134` renders the label and the status only.

**WD-053** — When a fork closes, the model MUST remove it from the fork set of its parent.
- Fixes: W-39.
- Test: Given a Unit test with an open model session, when the test makes a fork with no label, closes it and makes a second fork with no label, then the label of the second fork is `fork-1`.
- Today: `lib/model/model.js:1230-1242` does not change `forkChildren` of the parent, so the second label is `fork-2`.

---

## 13. Agent tools

**WD-054** — The tools row MUST register the write tool `doc_undo`, which reverses the last pending op.
- Fixes: W-12. Owner decision: OD-5.
- Test: Given a Unit test with `F-CLEAN`, when the agent replaces `TWO` with `TWO-A` and then calls `doc_undo`, then the result has `"undone": "replace_paragraph"` and `"pendingOps": 0`, and `doc_read` returns `TWO` for block `w14:2`.
- Today: `lib/model/model.js:751-777` has `undo`, and `lib/tools/index.js` registers no tool that calls it.

**WD-055** — The text of each error of a bundle tool MUST start with the error code and a colon.
- Fixes: W-40.
- Test: Given a Unit test with a model session whose file changed on disk, when the agent calls `doc_commit`, then the tool result text starts with `Error: DOC_STALE_BASE:`.
- Today: `lib/model/model.js:885` throws a message that does not contain the code, and the code does not reach the model.

**WD-056** — The engine and the model MUST map each sidecar error code as the mapping table of section 4.4 states.
- Fixes: W-40, W-29.
- Test: Given an Engine test that opens `F-TABLES`, when the agent calls `doc_edit` with `type: "delete_table_row"` and `blockId: "t:ffffffff"`, then the error text starts with `Error: DOC_TARGET_NOT_FOUND:`.
- Today: `lib/engine/manager.js:387-397` maps the sidecar code `TARGET_NOT_FOUND` to `ENGINE_PROTOCOL`, and `lib/model/model.js:371` maps that to `DOC_INVALID_OP`.

**WD-057** — A result of a bundle tool MUST NOT have a field named `revision`.
- Fixes: W-23.
- Test: Given a Unit test with `F-CLEAN`, when the agent calls `doc_open`, one `doc_edit` and `doc_commit`, then no result has the key `revision`, `doc_open` returns `"pendingOps": 0`, `doc_edit` returns `"pendingOps": 1`, and `storeRevision` of `doc_commit` matches `^[0-9a-f]{64}$`.
- Today: `lib/tools/index.js:81` declares `revision` as a number for `doc_open`, and `lib/tools/index.js:488` declares `revision` as a string for `doc_commit`.

**WD-058** — `doc_state` with `action: "close"` MUST fail with `DOC_SESSION_NOT_FOUND` when the handle is not known.
- Fixes: W-46.
- Test: Given a Unit test with no open model session, when the agent calls `doc_state` with `action: "close"` and `doc: "doc-none"`, then the error text starts with `Error: DOC_SESSION_NOT_FOUND:`.
- Today: `lib/model/model.js:1232` returns `closed: true` for a handle that is not known.

**WD-059** — The `editor` tool MUST fail with `DOC_INVALID_ARGS` when an action needs `path` or `doc` and the argument is absent.
- Fixes: W-46.
- Test: Given a Unit test, when the agent calls `editor` with `action: "open"` and no `path`, then the error text starts with `Error: DOC_INVALID_ARGS:`.
- Today: `lib/tools/index.js:770` passes `undefined` to `lib/docs.js:299`, where `path.resolve` throws a `TypeError`.

**WD-060** — The `editor` tool MUST accept only the review commands of section 4.8.
- Fixes: W-19.
- Test: Given a Unit test, when the agent calls `editor` with `action: "review"` and `command: "accept_all"`, then the error text is exactly `Error: DOC_INVALID_ARGS: unknown review command accept_all`, and the tool description contains `acceptAll` and does not contain `accept_all`.
- Today: `lib/tools/index.js:720` and `lib/tools/index.js:789` name `accept_all`, `reject_all`, `next_change`, `previous_change` and `markup`. `lib/editor/shim.js:153-168` refuses each of them.

**WD-061** — The `editor` tool MUST return `executed` from the acknowledgement of the host page, or fail with `DOC_EDITOR_NOT_OPEN` when no host page acknowledges the command in 10 seconds.
- Fixes: W-19.
- Test: Given a Composition with an open document and no connected host page, when the agent calls `editor` with `action: "review"` and `command: "nextChange"`, then the error text starts with `Error: DOC_EDITOR_NOT_OPEN:`.
- Today: `lib/index.js:261-264` returns the number of SSE connections, and `lib/tools/index.js:762` renders `ok` for each result.

**WD-062** — The host page MUST execute the commands `save` and `reload` that the `editor` tool sends.
- Fixes: W-19.
- Test: Given a Live run with an open document whose buffer has the unsaved text `LIVE-SAVE`, when the agent calls `editor` with `action: "save"`, then the result has `"executed": true`, and the saved file contains `LIVE-SAVE`.
- Today: `lib/editor/shim.js:153-168` has no branch for `save` or `reload` and answers `unknown command`.

**WD-063** — The `editor` tool MUST refuse a review command that changes the document with `DOC_REVIEW_NOT_AUTHORIZED` when the call has no `userInstruction` text.
- Owner decision: OD-8.
- Test: Given a Unit test, when the agent calls `editor` with `action: "review"`, `command: "acceptAll"` and no `userInstruction`, then the error text starts with `Error: DOC_REVIEW_NOT_AUTHORIZED:` and no `command` frame is sent.
- Today: `lib/tools/index.js:787-791` sends each review command with no check.

**WD-064** — The result of a review command that changes the document MUST contain `command`, `changeCount` and `userInstruction`.
- Owner decision: OD-8.
- Test: Given a Live run with `F-TRACKED` open in a tab, when the agent calls `editor` with `action: "review"`, `command: "acceptAll"` and `userInstruction: "accept all changes"`, then the result is `"command": "acceptAll"`, `"changeCount": 2`, `"userInstruction": "accept all changes"`, `"executed": true`.
- Today: `lib/tools/index.js:791` returns `action`, `command` and `delivered` only.

**WD-065** — `editor` with `action: "open"` MUST open or show the editor tab of that document in the client of the calling DSH session.
- Fixes: W-18.
- Test: Given a Live run with no editor tab, when the agent calls `editor` with `action: "open"` and the path of `F-CLEAN`, then one editor tab with the title `F-CLEAN.docx` is visible in 10 seconds.
- Today: `lib/docs.js:335` sends a `document` frame with `reload: false`, and `lib/client.js:218` ignores each frame that has no `reload: true`.

**WD-066** — `editor` with `action: "status"` MUST report the engine state as `not-started`, `ready`, `restarting` or `broken`.
- Fixes: W-20.
- Test: Given a Composition in which no document was opened, when the agent calls `editor` with `action: "status"`, then `engine.state` is `not-started` and the rendered text contains `engine not started`.
- Today: `lib/tools/index.js:757` renders `engine stopped` before the first use, because `lib/engine/manager.js:543-544` starts the sidecar only on the first open.

---

## 14. Editor tab

The address of a document is `dsh-resource://file/absolute/<absolute path>`.

**WD-067** — The client MUST show one editor tab for each document address in a workspace.
- Fixes: W-14. Owner decision: OD-9.
- Test: Given a Live run with the files `A.docx` and `B.docx`, when the user chooses Edit on `A.docx`, on `B.docx` and again on `A.docx`, then there are exactly two editor tabs with the titles `A.docx` and `B.docx`, and the tab `A.docx` is active.
- Today: `lib/client.js:293` opens the one tab kind `workspace-editor`, and `lib/client.js:64-66` holds one path and one document ID for the whole module.

**WD-068** — A restored editor tab MUST open the document of its own address.
- Fixes: W-14. Owner decision: OD-9.
- Test: Given a Live run with the tabs `A.docx` and `B.docx` where `B.docx` was opened last, when the app restarts, then the tab `A.docx` shows `A.docx` and the tab `B.docx` shows `B.docx`.
- Today: `lib/client.js:106` falls back to the module variable `lastPath` and then to `localStorage`, so a restored tab can show the document that was opened last.

**WD-069** — An editor tab that has no document address MUST show the empty state.
- Fixes: W-14.
- Test: Given a Live run in which `A.docx` was opened and closed, when the user opens the editor tab from the guide, then the tab shows exactly `Open a .docx or .pdf preview and choose Edit.` and no iframe.
- Today: `lib/client.js:106` opens the path in `localStorage['workspace-editor.lastPath']`.

**WD-070** — When a tab closes, the client MUST close only the store document of that tab.
- Fixes: W-15.
- Test: Given a Live run with the tabs `A.docx` and `B.docx` where `B.docx` was opened last, when the user closes the tab `A.docx`, then `/api/info` for the document of `B.docx` returns status 200 and `/api/info` for the document of `A.docx` returns status 404.
- Today: `lib/client.js:411-417` ignores the arguments of the close handler and closes the module variable `currentDocId`, which is the document that was opened last.

**WD-071** — When a `conflict` frame for its document arrives, the tab MUST keep the editor iframe mounted and show a banner.
- Fixes: W-16.
- Test: Given a Live run with a tab whose buffer has the unsaved text `KEEP-ME`, when the store refuses a write to that file with `DOC_STALE_BASE`, then the iframe element is the same element as before, the editor text contains `KEEP-ME`, and the banner shows exactly `This document changed on disk. Your unsaved changes are kept.` with the buttons `Save as copy`, `Reload` and `Dismiss`.
- Today: `lib/client.js:214-216` sets a failure text, and `lib/client.js:252-253` then renders the failure text in place of the iframe. The unsaved buffer is lost.

**WD-072** — The Reload control of a tab MUST load the current store revision of the document, also after a conflict.
- Fixes: W-16.
- Test: Given a Live run with a tab that shows a conflict banner for a file whose live text on disk is `ON-DISK`, when the user selects `Reload`, then in 10 seconds the banner is gone and the editor text is `ON-DISK`.
- Today: `lib/client.js:241` changes the reload token and does not clear the failure text, so `lib/client.js:252` keeps the iframe unmounted.

**WD-073** — The host page MUST ignore a `conflict` frame whose `path` is not the path of its document.
- Fixes: W-50.
- Test: Given a Live run with the tabs `A.docx` and `B.docx`, when the store refuses a write to `B.docx`, then the host page of `A.docx` shows no banner.
- Today: `lib/editor/shim.js:243` shows the conflict banner for each `conflict` frame, with no path check.

**WD-074** — File > Open and Ctrl+O in the editor MUST show a notice that names the DSH file panel.
- Fixes: W-21.
- Test: Given a Live run with an open document, when the user presses Ctrl+O in the editor, then the host page shows exactly `Open documents from the DSH file panel.` and the document stays open.
- Today: `lib/editor/shim.js:287-289` writes a log line only, and `lib/editor/shim.js:347` is an empty `execCommand`.

**WD-075** — The client MUST NOT open the selection menu while the store revision of the tab is not known.
- Fixes: W-45.
- Test: Given a Unit test of the tab with an empty loaded revision and the file time `1700000000000`, when a valid selection message arrives, then the selection menu does not open, and no staged quote contains `at revision 1700000000000`.
- Today: `lib/client.js:162` passes the file time as the revision, and the staged quote then says `at revision 1700000000000`.

**WD-076** — The host row MUST send the response headers of section 14.1 with `host.html`.
- Fixes: W-25.
- Test: Given a Composition, when the test requests `GET /workspace-editor/host.html`, then the header `content-security-policy` is exactly the value of section 14.1 and the header `x-content-type-options` is `nosniff`.
- Today: `lib/index.js:101-110` sends `content-type` and `cache-control` only.

**WD-077** — The editor iframe MUST have the `sandbox` attribute of section 14.1.
- Fixes: W-25.
- Test: Given a Live run with an open document, when the test reads the `sandbox` attribute of the editor iframe, then the value is exactly `allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads`, and the document is shown.
- Today: `lib/client.js:257-263` creates the iframe with no `sandbox` attribute.

**WD-078** — A sidecar window MUST refuse each navigation to a different origin and each request to open a window.
- Fixes: W-25.
- Test: Given an Engine test with test hooks and one open engine session, when the page runs `window.open('https://example.com/')` and then sets `location.href` to `https://example.com/`, then `window.open` returns `null`, the sidecar has one window, and the page URL starts with `http://127.0.0.1:`.
- Today: `lib/engine/host/main.js:359-362` sets the window preferences, and the file has no handler for `will-navigate` and no window open handler.

### 14.1 Host page policy

Content security policy, one header line:

```
default-src 'self'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' 'unsafe-inline' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'self' data: blob:; worker-src 'self' blob:; frame-src 'self' blob: data:; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'self'
```

Iframe `sandbox` value:

```
allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads
```

---

## 15. Scope, paths and routes

A tool call belongs to the DSH session of the calling agent. A route request names its DSH
session in the query parameter `session`.

**WD-079** — Each tool argument that names a document path MUST resolve inside an allowed root of the calling DSH session, or the call fails with `DOC_OUTSIDE_WORKSPACE`.
- Fixes: W-05. Owner decision: OD-4.
- Test: Given a Composition whose workspace root is `W` and a file `X.docx` in a sibling directory of `W`, when the agent calls `doc_open` with the absolute path of `X.docx`, and then `editor` with `action: "open"` and the same path, then each error text starts with `Error: DOC_OUTSIDE_WORKSPACE:` and `editor status` lists no document.
- Today: `lib/model/model.js:461-479` and `lib/docs.js:298-302` resolve each absolute path with no root check.

**WD-080** — Each route parameter that names a document path MUST resolve inside an allowed root of the DSH session of the request, or the route answers with status 403 and `DOC_OUTSIDE_WORKSPACE`.
- Fixes: W-05. Owner decision: OD-4.
- Test: Given a Composition whose workspace root is `W`, an open document in `W`, and a path `T.docx` in a sibling directory of `W`, when the test posts `/api/open` with the path of `T.docx`, and then `/api/save-as` with `path` set to `T.docx`, then each status is 403, each code is `DOC_OUTSIDE_WORKSPACE`, and `T.docx` does not exist.
- Today: `lib/index.js:396-404` and `lib/index.js:441-454` pass the path to the store, and `lib/docs.js:504-511` writes it.

**WD-081** — The path check MUST use the real path of the file, after links are resolved.
- Fixes: W-05.
- Test: Given a Composition whose workspace root `W` contains a directory link `out` that points to a sibling directory of `W` with the file `X.docx`, when the agent calls `doc_open` with `W/out/X.docx`, then the error text starts with `Error: DOC_OUTSIDE_WORKSPACE:`.
- Today: `lib/model/model.js:466` calls `path.resolve` only.

**WD-082** — A handle MUST be valid only in the DSH session that opened it and in a child session to which `doc_fanout` gave that handle.
- Fixes: W-06. Owner decision: OD-4.
- Test: Given a Composition with the DSH sessions `S1` and `S2` in the same workspace root, when `S1` and `S2` each call `doc_open` on the same file, and `S2` then calls `doc_read` with the handle of `S1`, then the two handles are different and the `doc_read` error text starts with `Error: DOC_SESSION_NOT_FOUND:`.
- Today: `lib/model/model.js:481-486` returns the same model session and the same handle to each caller, and `lib/model/model.js:271-277` resolves a handle for each caller.

**WD-083** — `doc_state` with `action: "status"` MUST list only the model sessions of the calling DSH session.
- Fixes: W-06. Owner decision: OD-4.
- Test: Given a Composition in which `S1` opened `A.docx` and `S2` opened `B.docx`, when `S2` calls `doc_state` with `action: "status"`, then `sessions` has exactly 1 entry and its `path` ends with `B.docx`.
- Today: `lib/tools/index.js:699` calls `model.status()` with no argument, and `lib/model/model.js:1257-1279` then returns each open model session.

**WD-084** — The runtime context `document-model:open` MUST list only the model sessions of the DSH session of the agent.
- Fixes: W-41.
- Test: Given a Composition in which `S1` and `S2` have the same workspace root, `S1` opened `A.docx` and `S2` opened `B.docx`, when the system prompt of `S2` is assembled, then the context text contains `B.docx` and does not contain `A.docx`.
- Today: `lib/tools/index.js:804` filters by working directory, so `lib/model/model.js:1283-1293` returns the sessions of each agent in that directory.

**WD-085** — The SSE channel MUST send to a connection only the frames of documents that are open in the DSH session of that connection.
- Fixes: W-06, W-27.
- Test: Given a Composition in which `S1` opened `A.docx` and `S2` opened `B.docx`, when a client connects to `/workspace-editor/events?session=S2` and `S1` then commits `A.docx`, then the `snapshot` frame lists exactly 1 document whose `path` ends with `B.docx`, and the client receives no frame whose path ends with `A.docx`.
- Today: `lib/index.js:370` sends each open document in the snapshot, and `lib/index.js:170-179` writes each frame to each connection.

**WD-086** — A route that takes a document ID MUST answer with status 404 and `DOC_SESSION_NOT_FOUND` when the document is not open in the DSH session of the request.
- Fixes: W-06.
- Test: Given a Composition in which `S1` opened `A.docx` with the document ID `D`, when the test requests `/api/info?id=D&session=S2`, then the status is 404 and the code is `DOC_SESSION_NOT_FOUND`.
- Today: `lib/docs.js:342-346` resolves a document ID for each caller.

**WD-087** — A commit from one DSH session MUST make the model sessions of the same file in the other DSH sessions stale.
- Owner decision: OD-4.
- Test: Given a Composition in which `S1` and `S2` each opened a copy of `F-CLEAN` at the same path, when `S1` replaces `TWO` and commits, and `S2` then replaces `THREE` and commits, then the `S2` error text starts with `Error: DOC_STALE_BASE:` and the file has the live text `THREE` for block `w14:3`.
- Today: `lib/model/model.js:481-486` gives `S1` and `S2` one shared model session, so the edit of `S2` goes into the working copy of `S1`.

**WD-088** — Each route MUST answer with status 405 and an `allow` header to a request whose method the route does not use.
- Fixes: W-26.
- Test: Given a Composition, when the test sends `GET /workspace-editor/api/save?id=x`, then the status is 405 and the header `allow` is `POST`.
- Today: `lib/index.js:296-306` registers each route with no method check. Only `lib/index.js:358-362` checks the method.

**WD-089** — A route MUST answer with status 400 and `DOC_INVALID_ARGS` to a request body that is not valid JSON.
- Fixes: W-26.
- Test: Given a Composition, when the test posts the body `{"path":` to `/workspace-editor/api/open`, then the status is 400 and the code is `DOC_INVALID_ARGS`.
- Today: `lib/index.js:124-127` lets `JSON.parse` throw, and `lib/index.js:637-638` answers with status 500.

**WD-090** — A route MUST answer with status 400 and `DOC_INVALID_ARGS` to a JSON body that has a field that the route does not define.
- Fixes: W-26.
- Test: Given a Composition, when the test posts `{"path":"a.docx","extra":1}` to `/workspace-editor/api/open`, then the status is 400, the code is `DOC_INVALID_ARGS` and no document opens.
- Today: `lib/index.js:398-400` reads `path` and ignores each other field.

---

## 16. Backups and history

The backup directory of a document is
`<workspace root>/.workspace-editor/backups/<document ID>/`. The document ID is the first
12 hex characters of the SHA-1 of the absolute path. The configuration value
`backupRetention` is the number of backups that the store keeps for one document. The
default is 20.

**WD-091** — Before the store overwrites a document file, it MUST copy the current file bytes to the backup directory with the name `<store revision of those bytes><extension>`.
- Fixes: W-12. Owner decision: OD-5.
- Test: Given a Unit test with a document file whose store revision is `R0`, when the test commits one edit, then the file `<R0>.docx` exists in the backup directory and its SHA-256 is `R0`.
- Today: `lib/docs.js:119-126` renames the new bytes over the file and keeps no copy.

**WD-092** — The store MUST keep the newest `backupRetention` backups of a document and delete the older backups.
- Owner decision: OD-5.
- Test: Given a Unit test with `backupRetention: 2` and a document at store revision `R0`, when the test makes three commits that produce `R1`, `R2` and `R3`, then the backup directory contains exactly `<R1>.docx` and `<R2>.docx`.
- Today: `lib/docs.js:108-131` makes no backup.

**WD-093** — When the store adapter `editorDocumentsStore` has a `backup` function, the store MUST call it with the path, the previous bytes and the previous store revision before each overwrite.
- Fixes: W-33. Owner decision: OD-5.
- Test: Given a Unit test with an adapter that records its calls and a document at store revision `R0`, when the test makes two commits that produce `R1` and `R2`, then the adapter has exactly two `backup` calls, with the revisions `R0` and `R1`, and each `write` call has a `baseRevision`.
- Today: `lib/docs.js:143-151` accepts an adapter with `stat` and `write` only, and no test uses an adapter.

---

## 17. Lifecycle and sidecar

**WD-094** — When a DSH session is disposed, the plugin MUST close the model sessions, the engine sessions and the store documents of that DSH session.
- Fixes: W-39.
- Test: Given a Composition in which `S1` opened `A.docx` and `S2` opened `B.docx`, when `S1` is disposed, then the engine status lists exactly 1 session, and `editor status` from `S2` lists exactly 1 document whose `path` ends with `B.docx`.
- Today: no file under `lib/` listens to `session/disposed`. `lib/model/index.js:34-41` listens only to the two store events.

**WD-095** — Only the model row MUST dispose the model.
- Fixes: W-39.
- Test: Given a Composition with one open model session, when the tools row is unloaded and loaded again, then `doc_state` with `action: "status"` lists the model session.
- Today: `lib/tools/index.js:813` disposes the model when the tools row unloads, and `lib/model/index.js:32` disposes it a second time.

**WD-096** — The sidecar MUST NOT start the work of a `describe`, `apply` or `save` request after the request is cancelled.
- Fixes: W-28.
- Test: Given an Engine test with test hooks, a copy of `F-CLEAN`, and a hook that delays each method by 500 ms, when the test calls `apply` to replace `TWO` with `X` and aborts the signal after 100 ms, then the call rejects with `ENGINE_CANCELLED`, and a later `describe` returns `TWO` for block `w14:2`.
- Today: `lib/engine/host/main.js:523-525` calls the three methods without the abort signal, so the op runs after the cancel.

**WD-097** — The manager MUST stop the restart of the sidecar after 10 crashes in 10 minutes.
- Fixes: W-29.
- Test: Given a Unit test with a stub runtime whose process sends the ready frame and then exits, when the process exits 11 times, then `status().broken` is not null and the next `open` rejects with `ENGINE_UNAVAILABLE`.
- Today: `lib/engine/manager.js:325` sets the restart count to 0 after each successful start, so `lib/engine/manager.js:354` is never true.

**WD-098** — After a sidecar crash, the engine status MUST NOT list the engine sessions that were lost.
- Fixes: W-29.
- Test: Given an Engine test with test hooks and one open engine session, when the sidecar exits, then `status().sessions` is an empty list.
- Today: `lib/engine/manager.js:348` marks each session as not alive, and `lib/engine/manager.js:518-527` still lists it.

**WD-099** — When the engine is disposed, the manager MUST delete the temp directory of its run.
- Fixes: W-29.
- Test: Given an Engine test with the temp root `T`, when the test opens one document and disposes the engine, then the directory `T` has no entry.
- Today: `lib/engine/manager.js:220-222` makes the run directory, and `lib/engine/manager.js:803-812` does not delete it.

**WD-100** — The sidecar MUST exit with code 2 when it starts without `--eo-root`, `--x2t` or `--temp-root`.
- Fixes: W-29.
- Test: Given the sidecar host app, when the test starts it with no arguments, then the process exits with code 2 and the last stderr line is exactly `missing argument --eo-root`.
- Today: `lib/engine/host/main.js:34` falls back to the path `plugins/resources/euro-office`, which does not exist.

**WD-101** — When `WORKSPACE_EDITOR_X2T_SHA256` is set, the engine MUST refuse to start a sidecar whose converter file has a different SHA-256.
- Fixes: W-31.
- Test: Given a Composition with `WORKSPACE_EDITOR_X2T_SHA256` set to 64 zeros, when the agent calls `doc_open`, then the error text starts with `Error: DOC_ENGINE_UNAVAILABLE:` and contains `x2t hash mismatch`.
- Today: `lib/engine/locate.js:109-117` and `lib/x2t.js:19-21` select the converter by path, with no identity check.

**WD-102** — The engine row MUST fail with `DOC_ENGINE_UNAVAILABLE` when its frontend directory is not the frontend directory of the host row.
- Fixes: W-31.
- Test: Given a Composition with `WORKSPACE_EDITOR_FRONTEND` set to a directory that has no `sdkjs/word/apiBuilder.js`, when the agent calls `doc_open`, then the error text starts with `Error: DOC_ENGINE_UNAVAILABLE:` and contains `frontend mismatch`.
- Today: `lib/index.js:31` serves the directory in the variable, and `lib/engine/locate.js:100-106` then selects a different directory for the engine with no error.

**WD-103** — The engine MUST open a document when the sidecar is started through the DSH `subprocess` service.
- Fixes: W-30.
- Test: Given a Composition with the bundle and a copy of `F-CLEAN` in the workspace root, when the agent calls `doc_open` and then `editor` with `action: "status"`, then `doc_open` returns `"blocks": 5` and `engine.state` is `ready`.
- Today: `lib/engine/verify.mjs:142` starts the sidecar with the Node runtime only. No test starts it through `ctx.subprocess` (`lib/engine/index.js:41`).

**WD-104** — The plugin MUST compute the outline of a document in one function.
- Fixes: W-32.
- Test: Given the plugin source under `lib/`, when the test counts the definitions of `function outlineOf`, then the count is `1`.
- Today: `lib/engine/manager.js:116-130` and `lib/model/model.js:113-127` each define `outlineOf`.

**WD-105** — The plugin MUST build the converter parameter XML in one function.
- Fixes: W-32.
- Test: Given the plugin source under `lib/`, when the test counts the files that contain `TaskQueueDataConvert`, then the count is `1`.
- Today: `lib/x2t.js:67-73` and `lib/engine/host/main.js:130-143` each build the parameter XML, with different options.

---

## 18. Review, documentation and tests

**WD-106** — The citation analyzer MUST count each valid citation in a block.
- Fixes: W-42.
- Test: Given a Unit test with one block whose text is `See (2019) 5 SCC 1 and (2020) 3 SCC 45.`, when the citation analyzer runs, then its result is `[]`.
- Today: `lib/review/analyzers.js:308-311` counts each marker and at most one valid citation, so it returns one `CITATION_SHAPE` finding.

**WD-107** — The review row MUST NOT provide a service named `legalReview`.
- Fixes: W-43.
- Test: Given a Composition with the bundle, when the test reads `ctx.get('legalReview')`, then the value is `undefined`.
- Today: `lib/review/index.js:125` provides `legalReview`, and no module uses it.

**WD-108** — The plugin README MUST describe only tools and behavior that the code has.
- Fixes: W-43.
- Test: Given `README.md` of the plugin, when the test searches for `presentCall`, for `document_edit` and for `aborts inside the sidecar`, then each count is `0`.
- Today: `README.md:162` names `presentCall`, which no tool has. `README.md:62` and `README.md:270` describe `document_edit`. `README.md:82` says that a cancelled request aborts inside the sidecar.

**WD-109** — The fake engine of the test suite MUST keep the replaced text of a paragraph as deleted text.
- Fixes: W-13.
- Test: Given a Unit test with the fake engine and `F-CLEAN`, when the test replaces `TWO` with `TWO-A` and reads the raw block, then the block has `text` `TWO-A` and `deletedText` `TWO`.
- Today: `test/fixtures.mjs:84-85` overwrites the block text and keeps no deleted text.

**WD-110** — The model verifier MUST compare the live text of a merged paragraph with the exact expected text.
- Fixes: W-13.
- Test: Given `lib/model/verify.mjs` and an engine that returns mixed live and deleted text, when the verifier runs, then it exits with a code that is not 0 and reports the failed check `merged_live_text_exact`.
- Today: `lib/model/verify.mjs:210-213` checks only that a search finds the new text.

**WD-111** — The test suite MUST have a test file for each surface of section 18.1.
- Fixes: W-44.
- Test: Given the plugin directory, when the test runs `npm test`, then the run includes each file of section 18.1 and exits with code `0`.
- Today: the directory `test/` has only `fanout.test.mjs`, `model.test.mjs`, `review.test.mjs` and `tools.test.mjs`. `test/fanout.test.mjs:40-75` uses a fake child provider.

### 18.1 Test files

| File | Surface |
|---|---|
| `test/store.test.mjs` | Store, lease, backups, adapter |
| `test/routes.test.mjs` | HTTP routes and the SSE channel |
| `test/client.test.mjs` | Client tab state, close handler, selection menu |
| `test/host-page.test.mjs` | Host page: state reports, commands, conflict frames |
| `test/engine-rpc.test.mjs` | Manager and sidecar RPC with a stub sidecar |
| `test/merge.test.mjs` | Merge: insertions, tables, lists, conflicts |
| `test/composition.test.mjs` | The bundle in a DSH headless composition, with the real child provider |

---

## 19. Reasoning and apply

Section 4.11 defines the roles. Section 4.12 defines the change proposal.

**WD-112** — `doc_read` with `redline: true` MUST return the tracked changes of each block as inline `<ins>` and `<del>` tags.
- Owner decision: OD-12.
- Test: Given an Engine test that opens `F-TRACKED`, when the agent calls `doc_read` with `mode: "full"` and `redline: true`, then `text` is exactly `[w14:1] Paid to the <del>r</del><ins>R</ins>espondent.`
- Today: `lib/tools/index.js:139-153` has no `redline` parameter, and the call fails the argument check.

**WD-113** — `doc_edit` MUST fail with `DOC_INVALID_ARGS` when an op names a block by an index.
- Owner decision: OD-12.
- Test: Given a Unit test with `F-CLEAN`, when the agent calls `doc_edit` with `type: "insert_paragraph"`, `index: 1` and `text: "X"`, then the error text starts with `Error: DOC_INVALID_ARGS:` and `doc_diff` returns `"changed": false`.
- Today: `lib/tools/index.js:544` declares `index` as a target and as an insertion point.

**WD-114** — An insert op MUST put the new block directly after the block in `afterBlockId`, or directly before the block in `beforeBlockId`.
- Owner decision: OD-12.
- Test: Given a Unit test with `F-CLEAN`, when the agent calls `doc_edit` with `type: "insert_paragraph"`, `afterBlockId: "w14:2"` and `text: "NEW"`, then the block texts are exactly `ONE`, `TWO`, `NEW`, `THREE`, `FOUR`, `FIVE`.
- Today: `lib/model/model.js:69` gives `insert_paragraph` the fields `text` and `index` only.

**WD-115** — `replace_paragraph` MUST make tracked changes only for the words that are different between the old live text and the new text.
- Owner decision: OD-13.
- Test: Given an Engine test that opens a copy of `F-WORDS`, when the agent replaces block `w14:1` with `The seller must deliver the goods.`, then the markup view has exactly the runs `The seller `, `shall` with `"deleted": true`, `must` with `"inserted": true`, and ` deliver the goods.`
- Today: `lib/engine/host/host-bridge.js:339-360` deletes the whole paragraph text and adds the whole new text.

**WD-116** — `doc_edit` MUST fail with `DOC_APPLIER_ONLY` when the caller is not an applier agent.
- Owner decision: OD-11.
- Test: Given a Composition with a copy of `F-CLEAN`, when the root agent of a DSH session calls `doc_edit` with `type: "replace_paragraph"`, `blockId: "w14:2"` and `text: "X"`, then the error text starts with `Error: DOC_APPLIER_ONLY:` and `doc_state status` returns `"pendingOps": 0`.
- Today: `lib/tools/index.js:607-633` applies the op for each caller.

**WD-117** — `doc_read` with `mode: "markup"` MUST fail with `DOC_APPLIER_ONLY` when the caller is not an applier agent.
- Owner decision: OD-11.
- Test: Given a Composition with a copy of `F-CLEAN`, when the root agent of a DSH session calls `doc_read` with `mode: "markup"`, then the error text starts with `Error: DOC_APPLIER_ONLY:`.
- Today: `lib/tools/index.js:224-237` passes the mode to the model with no check of the caller.

**WD-118** — For an `apply` task, `doc_fanout` MUST give the applier agent the change proposals of that task as JSON in its prompt.
- Owner decision: OD-11.
- Test: Given a Unit test that captures the child prompt, when the agent calls `doc_fanout` with one `apply` task whose `changes` has one proposal with `id: "c1"`, `kind: "replace"`, `blockId: "w14:2"`, `expectedText: "TWO"` and `newText: "TWO-A"`, then the prompt contains `"id":"c1"` and `"newText":"TWO-A"`.
- Today: `lib/fanout/index.js:43-51` accepts `label` and `prompt` only, and `lib/fanout/index.js:278-285` writes the free prompt text.

**WD-119** — An op of an applier agent MUST fail with `DOC_OUTSIDE_CHUNK` when its target block or its anchor block is not in the chunk of the task.
- Owner decision: OD-12.
- Test: Given a Composition test with `F-CLEAN` and one `apply` task with `blockIds: ["w14:2"]`, when the applier agent calls `doc_edit` with `type: "replace_paragraph"`, `blockId: "w14:4"` and `text: "X"`, then the error text starts with `Error: DOC_OUTSIDE_CHUNK:` and the fork has `"pendingOps": 0`.
- Today: `lib/model/model.js:696-700` applies an op to each block of the session.

**WD-120** — `doc_fanout` MUST fail with `DOC_INVALID_ARGS` when two `apply` tasks have a block ID in common and `allowOverlap` is not `true`.
- Owner decision: OD-12.
- Test: Given a Unit test with `F-CLEAN`, when the agent calls `doc_fanout` with two `apply` tasks that each have `blockIds: ["w14:2"]`, then the error text starts with `Error: DOC_INVALID_ARGS:` and no child starts.
- Today: `lib/fanout/index.js:226-236` checks the label and the prompt of a task only.

**WD-121** — `doc_fanout` MUST put the `constraints` text into the prompt of each child of the call.
- Owner decision: OD-12.
- Test: Given a Unit test that captures the child prompts, when the agent calls `doc_fanout` with two tasks and `constraints: "Use Buyer, not Purchaser."`, then each of the two prompts contains `Use Buyer, not Purchaser.`
- Today: `lib/fanout/index.js:278-285` builds the prompt from the fork, the label and the task prompt only.

**WD-122** — For a `review` task, `doc_fanout` MUST start a child that has only the tools `doc_read`, `doc_search`, `doc_check` and `doc_analyze`, and no fork.
- Owner decision: OD-11.
- Test: Given a Composition test in which `doc_fanout` starts one child for a `review` task, when the child lists its tool names in alphabetical order, then the list is exactly `doc_analyze`, `doc_check`, `doc_read`, `doc_search`, and the `doc_fanout` result has `"forks": []`.
- Today: `lib/fanout/index.js:147-151` makes a fork for each task, and `lib/fanout/index.js:160-170` starts each child with all tools.

**WD-123** — `doc_fanout` MUST return a change proposal of a `review` task in `proposals` only when its fields are valid, its block is in the chunk and its `expectedText` is equal to the live text of the block.
- Owner decision: OD-11.
- Test: Given a Unit test with `F-CLEAN` and a stub review child that returns the proposal `c1` (`replace`, `w14:2`, `expectedText: "TWO"`, `newText: "TWO-A"`) and the proposal `c2` (`replace`, `w14:3`, `expectedText: "WRONG"`, `newText: "X"`), when `doc_fanout` returns, then `proposals` has exactly the proposal `c1`, and `rejected` is exactly `[{ "id": "c2", "reason": "stale-text" }]`.
- Today: `lib/fanout/index.js:179-180` returns the free text of the child and no structured proposal.

**WD-124** — After the merge of an `apply` task, `doc_fanout` MUST set the status of each change proposal from the live text of the parent, as section 4.12 states.
- Owner decision: OD-11.
- Test: Given a Unit test with `F-CLEAN`, one `apply` task with the proposals `c1` (`replace` `w14:2` with `TWO-A`) and `c2` (`replace` `w14:4` with `FOUR-A`), and a stub applier that applies `c1` only, when `doc_fanout` returns, then `changes` is exactly `[{ "id": "c1", "status": "applied" }, { "id": "c2", "status": "not-applied" }]`.
- Today: `lib/fanout/index.js:196-211` returns the fork status and the merge counts only.

**WD-125** — `doc_diff` and `doc_commit` MUST return the number of changed blocks and the number of all blocks.
- Owner decision: OD-12.
- Test: Given a Unit test with `F-CLEAN` in which block `w14:2` is replaced, when the agent calls `doc_diff`, then the result has `"blocksChanged": 1` and `"blocksTotal": 5`.
- Today: `lib/tools/index.js:371` and `lib/tools/index.js:493` list the required result fields, and they have no block count.

**WD-126** — `doc_commit` MUST fail with `DOC_REVIEW_REQUIRED` when the working copy changed after the last `doc_diff` call.
- Owner decision: OD-13.
- Test: Given a Unit test with `F-CLEAN` in which block `w14:2` is replaced, when the agent calls `doc_commit` with no `doc_diff` call before it, then the error text starts with `Error: DOC_REVIEW_REQUIRED:`, and after one `doc_diff` call the next `doc_commit` returns `"applied": true`.
- Today: `lib/model/model.js:889-891` commits when the session has a pending op, with no check for a diff.

**WD-127** — A merge MUST adopt a changed fork block only when the ops in the log of that fork produce its live text from the live text of the base block.
- Owner decision: OD-6.
- Test: Given a Unit test with `F-CLEAN` and one fork whose fake engine block `w14:2` is changed to `SIDE-EFFECT` with no op in the log of the fork, when the parent merges, then the result has `"applied": 0`, `conflicts[0]` has `"id": "w14:2"` and `"reason": "not-derived"`, and the parent block text is `TWO`.
- Today: `lib/model/model.js:1090-1093` compares the block signatures only and adopts each different fork block.

---

## 20. Op checks, kept behavior and history

The requirements WD-130 to WD-136 state behavior that the code has today. The fix of
the other requirements must not remove it.

**WD-128** — `doc_edit` MUST fail with `DOC_STALE_BASE` when the model session is stale.
- Owner decision: OD-2.
- Test: Given a Unit test with an open model session of `F-CLEAN` and a human save that changes the store revision, when the agent calls `doc_edit` with `type: "replace_paragraph"`, `blockId: "w14:2"` and `text: "X"`, then the error text starts with `Error: DOC_STALE_BASE:` and the session has `"pendingOps": 0`.
- Today: `lib/model/model.js:696-698` applies an op with no check of `session.stale`. Only `lib/model/model.js:884-888` checks it, at the commit.

**WD-129** — An op that names a run, a cell or a paragraph MUST fail with `DOC_STALE_TARGET` when its `expectedText` is not the live text of that target.
- Owner decision: OD-2.
- Test: Given an Engine test that opens `F-BOLD`, when the agent calls `doc_edit` with `type: "set_run_props"`, `runIndex: 0`, `expectedText: "WRONG"` and `props: { "bold": true }`, then the error text starts with `Error: DOC_STALE_TARGET:` and `doc_diff` returns `"changed": false`.
- Today: `lib/model/model.js:55-62` has no run op, and `lib/engine/host/host-bridge.js:369-371` checks `expectedText` for a paragraph replace only.

**WD-130** — The store MUST refuse an agent commit with `DOC_EDITOR_DIRTY` while `editorDirty` of the file is true.
- Owner decision: OD-14.
- Test: Given a Unit test with an open document whose `modified` is `true` and whose store revision is `R0`, when the agent commits one edit, then the error text starts with `Error: DOC_EDITOR_DIRTY:` and the SHA-256 of the file is `R0`.
- Today: `lib/docs.js:392-395` and `lib/model/model.js:901-905` refuse the commit. No test covers it.

**WD-131** — The store MUST write a document file through a temp file in the same directory and a rename.
- Owner decision: OD-14.
- Test: Given a Unit test with a document at store revision `R0` and a store whose rename step fails, when the agent commits one edit, then the SHA-256 of the file is `R0` and the directory has no file whose name ends with `.tmp`.
- Today: `lib/docs.js:119-126` writes the temp file, renames it and removes it. No test covers it.

**WD-132** — The store MUST convert the new bytes for the open editor before it writes the document file.
- Owner decision: OD-14.
- Test: Given a Unit test with an open document at store revision `R0` and a converter that fails, when the test calls `applyBytes` with a current base revision, then the call rejects and the SHA-256 of the file is `R0`.
- Today: `lib/docs.js:404-408` converts before `lib/docs.js:410` writes. No test covers it.

**WD-133** — After an agent commit, an editor tab of that document with no unsaved change MUST show the new store revision.
- Owner decision: OD-14.
- Test: Given a Live run with a copy of `F-CLEAN` open in a tab with no unsaved change, when an applier agent replaces `TWO` with `TWO-A` and the agent commits, then in 10 seconds the editor text contains `TWO-A`.
- Today: `lib/docs.js:426-431` sends a `document` frame with `reload: true`, and `lib/editor/shim.js:218` reloads the page.

**WD-134** — A human save MUST make each model session of that file stale.
- Owner decision: OD-14.
- Test: Given a Unit test with an open model session of `F-CLEAN` and one pending op, when a human save changes the store revision and the agent then commits, then the error text starts with `Error: DOC_STALE_BASE:` and `doc_state status` returns `"stale": true`.
- Today: `lib/model/model.js:1309-1312` sets `stale` when the saved revision is not the base revision of the session.

**WD-135** — The client MUST ignore a selection message that does not come from its own editor iframe and its own origin.
- Owner decision: OD-14.
- Test: Given a Unit test of the tab, when a window that is not the editor iframe posts a message of type `workspace-editor/selection` with the text `SPOOF`, then the selection menu does not open, and no staged quote contains `SPOOF`.
- Today: `lib/client.js:149-158` checks the source window, the origin, the type and the fields.

**WD-136** — The sidecar MUST refuse an RPC request that has no valid token with status 403.
- Owner decision: OD-14.
- Test: Given an Engine test with a running sidecar, when the test posts to `/engine-rpc` with the header `x-engine-token: wrong`, then the status is `403`.
- Today: `lib/engine/host/main.js:544` compares the header with the token of the run.

**WD-137** — `doc_state` with `action: "revisions"` MUST return in `revisions.history` the earlier store revisions of the file, oldest first, from the `history` function of the store adapter or from the backup directory.
- Owner decision: OD-5.
- Test: Given a Unit test with the local store and a document at store revision `R0`, when the agent makes two commits that produce `R1` and `R2` and then calls `doc_state` with `action: "revisions"`, then `revisions.history` is exactly `[R0, R1]`.
- Today: `lib/model/model.js:848-867` returns the commits of the session only, and `lib/docs.js:143-151` knows no `history` function.

---

## 21. Issues and coverage

Each row is a defect in the code at commit `06b546c`, and the requirements that fix it.

| Issue | Defect in the code today | Requirements |
|---|---|---|
| W-01 | A merge leaves old text in the live text of the merged paragraph and reports success. | WD-015, WD-038 |
| W-02 | The tool `document_edit` writes document files outside the store, the lease and the write gate. | WD-001, WD-002, WD-003 |
| W-03 | The block text that the agent reads contains deleted text. | WD-013, WD-014, WD-026 |
| W-04 | A successful commit makes its own model session stale. The next commit is refused. | WD-011 |
| W-05 | Tools and routes accept each absolute path. Save-as writes each target and each file type. | WD-005, WD-006, WD-079, WD-080, WD-081 |
| W-06 | The store, the model sessions and the SSE channel have no DSH session owner. | WD-082, WD-083, WD-085, WD-086 |
| W-07 | A fan-out child sees all tools and gets the parent handle. | WD-047, WD-048, WD-049 |
| W-08 | The output schema of `doc_fanout` does not permit the null values that a merge returns. | WD-045 |
| W-09 | A merge puts an inserted block at the wrong position after a deletion. | WD-039 |
| W-10 | A merge cannot adopt table changes, new tables or list items. It reports them as failures or changes them to paragraphs. | WD-040, WD-041, WD-042, WD-043, WD-044 |
| W-11 | Block IDs are not stable and not unique: fallback paragraph IDs change between sessions, and equal tables share one ID. | WD-020, WD-021, WD-022, WD-023, WD-024 |
| W-12 | The store keeps no backup, and no tool gives access to undo. | WD-054, WD-091 |
| W-13 | The fake engine and the model verifier cannot detect wrong live text. | WD-109, WD-110 |
| W-14 | The editor tab takes its document from a module variable and from `localStorage`. | WD-067, WD-068, WD-069 |
| W-15 | The close handler closes the document that was opened last, not the document of the closed tab. | WD-070 |
| W-16 | A conflict unmounts the editor iframe. The unsaved buffer is lost, and Reload does not recover. | WD-071, WD-072 |
| W-17 | A human save needs no base revision, and the dirty state can be lost. | WD-007, WD-008, WD-009, WD-010 |
| W-18 | `editor open` does not open a tab. | WD-065 |
| W-19 | The `editor` tool sends commands that the host page refuses, and reports success without an acknowledgement. | WD-060, WD-061, WD-062 |
| W-20 | `editor status` shows `engine stopped` before the first use of the engine. | WD-066 |
| W-21 | File > Open and Ctrl+O in the editor do nothing. | WD-074 |
| W-22 | The outline of a document without headings is empty, with no hint. | WD-019 |
| W-23 | Tool results use the name `revision` for a count and for a hash. | WD-057 |
| W-24 | `contentHash` does not change after a commit or a reload. | WD-012 |
| W-25 | The editor iframe has no sandbox, the host page has no content security policy, and a sidecar window has no navigation guard. | WD-076, WD-077, WD-078 |
| W-26 | Routes accept each method, answer 500 to bad JSON and ignore unknown fields. | WD-088, WD-089, WD-090 |
| W-27 | The SSE channel sends the documents of all sessions to each client. | WD-085 |
| W-28 | The sidecar runs `describe`, `apply` and `save` after the request is cancelled. | WD-096 |
| W-29 | The sidecar restart limit has no effect, lost sessions stay in the status, the run temp directory stays, sidecar error codes are lost, and the default frontend path of the sidecar is wrong. | WD-056, WD-097, WD-098, WD-099, WD-100 |
| W-30 | No test starts the sidecar through the DSH `subprocess` service. | WD-103 |
| W-31 | The plugin does not check the identity of the converter or that the host and the engine use one frontend. | WD-101, WD-102 |
| W-32 | The outline function and the converter parameter XML each exist two times. | WD-104, WD-105 |
| W-33 | No test uses the store adapter. | WD-093 |
| W-34 | The deployment depth limit has no effect on `doc_fanout`. | WD-050 |
| W-35 | A cancelled `doc_fanout` call does not stop its children. | WD-051 |
| W-36 | A merge and a commit do not record the fork that made a change. | WD-046 |
| W-37 | A paragraph replace does not produce the requested text, and an inserted paragraph gets no style. | WD-015, WD-016 |
| W-38 | The `doc_*` tools have no tracked find and replace. | WD-017 |
| W-39 | A disposed DSH session leaves its documents open, two rows dispose the model, and closed forks stay in the fork set. | WD-053, WD-094, WD-095 |
| W-40 | Error codes do not reach the model, and engine codes change to wrong codes. | WD-055, WD-056 |
| W-41 | The runtime context lists the documents of other sessions in the same directory. | WD-084 |
| W-42 | The citation analyzer counts at most one valid citation in a block. | WD-106 |
| W-43 | The README describes behavior that the code does not have, and the service `legalReview` has no user. | WD-107, WD-108 |
| W-44 | The client, the host page, the routes, the store, the engine RPC and the real child provider have no test. | WD-111 |
| W-45 | The selection quote can name a file time as the revision. | WD-075 |
| W-46 | `doc_state close` accepts a handle that is not known, and `editor open` without a path throws a `TypeError`. | WD-058, WD-059 |
| W-47 | `insert_table_row` creates a new table when the target table does not exist. | WD-018 |
| W-48 | The rendered result of `doc_fanout` does not contain the child summaries. | WD-052 |
| W-49 | `ctx.docxEngine.save` writes to a path that the caller supplies. | WD-004 |
| W-50 | The host page shows a conflict banner for conflicts of other documents. | WD-073 |

---

## 22. Owner decisions

| ID | Decision |
|---|---|
| OD-1 | This document is the one specification of the component, and it is self-contained. |
| OD-2 | The agent gets a markup view with core markup coverage. It edits through curated structural ops only, with expected-text checks and base checks. It does not write raw XML. The human gets a read-only inspector. The vendored editor is not modified. |
| OD-3 | The tool `document_edit` is removed. |
| OD-4 | Paths are confined to the session workspace. Registries are session-scoped. The file lease is the only state that DSH sessions share. |
| OD-5 | The store makes backups and supports a versioned store adapter. The tool `doc_undo` is available. |
| OD-6 | The merge gets the text fix, derivation checks and deterministic, explicit conflicts. An end-of-session edit generator is not part of this specification. |
| OD-7 | Stable block IDs are minted and persisted. Table merge and list merge are included. |
| OD-8 | The human decides on tracked changes by default. The agent accepts or rejects a tracked change only on an explicit instruction of the user, and the action is recorded. |
| OD-9 | Each document has its own tab with a resource address. The view and the document identity are per workspace. |
| OD-10 | The P0 gate includes table merge, list merge, stable IDs and the Live tests. |
| OD-11 | Legal reasoning and document editing are separate. A reasoning agent works on text and proposes changes. An applier agent applies the proposed changes to the markup. |
| OD-12 | The agent can read tracked changes as inline tags. Insertions are anchored to a block. Each `doc_fanout` task has a chunk, and all tasks of a call share one constraints text. Diff and commit results give a coverage number. |
| OD-13 | A paragraph replace makes word-level tracked changes. The agent reviews the diff before each commit. |
| OD-14 | Behavior that works today stays, and a test covers it. |
| OD-15 | Live tests run first in the testweb harness and then in the localbuild harness. |

Requirements that implement an owner decision and fix no issue: WD-025, WD-027, WD-028,
WD-029, WD-030, WD-031, WD-032, WD-033, WD-034, WD-035, WD-036, WD-037, WD-063, WD-064,
WD-087, WD-092, WD-112, WD-113, WD-114, WD-115, WD-116, WD-117, WD-118, WD-119, WD-120,
WD-121, WD-122, WD-123, WD-124, WD-125, WD-126, WD-127, WD-128, WD-129, WD-130, WD-131,
WD-132, WD-133, WD-134, WD-135, WD-136, WD-137.

---

## 23. Gates

Each requirement is in exactly one gate. A gate passes when the Test of each of its
requirements passes.

**P0** — WD-001..WD-015, WD-018, WD-020..WD-024, WD-038..WD-046, WD-054, WD-067..WD-073, WD-079..WD-087, WD-091, WD-092, WD-109, WD-110, WD-127, WD-128, WD-130..WD-134

**P1** — WD-025..WD-036, WD-047..WD-053, WD-055..WD-066, WD-093..WD-095, WD-111..WD-124, WD-126, WD-129, WD-137

**P2** — WD-016, WD-017, WD-019, WD-074..WD-078, WD-088..WD-090, WD-037, WD-096..WD-108, WD-125, WD-135, WD-136

Order of the tests in a gate:

1. Unit, Engine and Composition tests.
2. The Live tests in the testweb harness.
3. The same Live tests in the localbuild harness. This step starts only when step 2 passes.

The component is ready for single-workspace editing with a human in the loop when P0
passes. The reasoning and apply workflow with `doc_fanout` is ready when P1 passes.

---

## 24. V2: not in this specification

Each item of this list is V2. No requirement of this specification covers it.

- An own OOXML model and serializer. The Document Builder in the sidecar stays the engine.
- Page images of a document (`doc_render`).
- An integration of the Nextcloud Assistant.
- A separate package for `doc_fanout`.
- An end-of-session edit generator.
- Performance budgets.
- Byte-identical package parts after a commit. The converter writes the whole package again.
