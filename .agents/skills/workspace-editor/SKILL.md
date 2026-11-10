---
name: workspace-editor
description: Use when working on plugins/workspace-editor, the legal DOCX editor plugin, to respect its six-row ownership, one-write-authority rule, lease and tracked-change model, and to know which defects are still open.
---

# workspace-editor (legal DOCX plugin)

The plugin is one bundle with six Cordis rows. Contract:
[plugins/workspace-editor/README.md](../../../plugins/workspace-editor/README.md).
Specification (requirements, invariants, acceptance gates):
[legal-docx-workspace.md](../../../docs/legal-docx-workspace.md). Audit and open defects:
[workspace-editor-audit-and-improvement-report.md](../../../scratch/testingdocs/workspace-editor-final-audit-report.md).

## Rows

| Row | Module | Owns |
|---|---|---|
| `workspace-editor` | `lib/index.js` | EuroOffice host, routes/SSE, document store and lease, right-dock tab, `editor` tool, legacy `document_edit` |
| `workspace-docx-engine` | `lib/engine/index.js` | Hidden Electron Document Builder sidecar (`docxEngine`) |
| `workspace-docx-model` | `lib/model/index.js` | Sessions, op log, diff/check, fork/merge/commit (`docxModel`) |
| `workspace-docx-tools` | `lib/tools/index.js` | `doc_*` tools, runtime context, write gate |
| `workspace-docx-fanout` | `lib/fanout/index.js` | `doc_fanout` over `ctx.subagents` |
| `workspace-legal-review` | `lib/review/index.js` | Deterministic analyzers, `doc_analyze`, review skill |

## Invariants

- **One persistent write authority.** Every write goes through the store lease
  (`editorDocuments.applyBytes` / `docs.save`) with a base revision. Do not add a second
  direct writer, and do not route a new feature through `document_edit`.
- **One lease per document.** The store owns the SHA-256 revision; the model owns the base
  revision and op log. A commit must check both and must leave the session usable.
- **Tracked changes carry the author.** Agent edits are tracked with an `agent:<id>` author;
  accept/reject stays with the lawyer. Never strip revision marks on a save.
- **Text the model edits is the text the user sees.** Do not feed it text that contains
  deleted runs or split-run artifacts; verify exact live text.
- **Scope to the DSH session and workspace.** The store, model sessions and SSE are not
  global by design; do not leak another session's document.
- **Visible-editor identity is per tab.** A close handler receives `(sessionId, tab)`; a
  restored page tab has no navigation params. Do not use module-global "current" state.

## Evidence

| Change | Run |
|---|---|
| Model/lease/commit/fork | `node plugins/workspace-editor/lib/model/verify.mjs` |
| Engine/builder/tracked changes | `node plugins/workspace-editor/lib/engine/verify.mjs --with-hooks` |
| Saved file opens in Word | `scripts/verify-word-open.ps1` on the verifier artifact |
| Tools or client surfaces | `node --test "plugins/workspace-editor/test/*.test.mjs"`, then a real dev-profile run |
| Formatting/merge fidelity | Exact-text assertions on disposable copies, not marker counts |

## Open defects (from the 2026-11-10 audit; do not assume fixed)

Merge adopts contaminated block text and can corrupt live text while reporting success; the
`document_edit` tool is an ungated direct write that destroys tracked changes; a successful
commit marks its own session stale; table changes cannot merge; duplicate/session-scoped
block ids make targets ambiguous; the client tab identity and close path are module-global;
the verifier suite cannot detect the merge defect.

## What not to claim

- Do not claim the merge is safe because it reports no conflicts.
- Do not claim the write gate makes the plugin read-only; check every write path.
- Do not claim a document survives editing because markers count; assert its live text.
