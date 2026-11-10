---
name: orchestrator-session
description: Use when starting, running, or closing a long DSH plugin session in C:\dev\advodsh, to keep traversal narrow, coordinate work, and leave a log and successor prompt.
---

# DSH plugin session

One session, one objective, one record. The session is a full actor: it can edit plugin
source, use tools to verify work, and assign sub-agents when delegation pays for itself.

## Read first

1. `C:\dev\advodsh\AGENTS.md` and `C:\dev\advodsh\docs\README.md`.
2. `C:\dev\advodsh\docs\repo-map.md` — paths, write boundaries, traversal.
3. For DSH work: `docs\cordis-map.md` and `docs\deepseek-harness-map.md` under the same
   `docs` directory.
4. For plugin work: `docs\plugin-knowledge-base.md`, then the plugin's own `README.md` and
   the owning design doc. Read only targeted files.

## Open

State GOAL / SCOPE / DONE / STOP / REPORT in one short block. For multi-file work, post the
plan before editing. Name the evidence that will prove the result.

## Work

- **Plugin work:** author under `C:\dev\advodsh\plugins\<name>`; test in a profile under
  `C:\dev\advodsh\.dsh-home\profiles`; never edit `upstream\deepseek-harness`.
- **Vendored assets:** change pins and manifests under `vendor\`; never edit a fetched tree
  by hand.
- **Subagents and teams:** delegate only when the work is independent, isolated or
  verification-shaped; give each a self-contained brief, a write scope and an output path.
- **Records:** logs, prompts and skills go under `C:\dev\advodsh\.agents`; retired documents
  go to `.agents\trash\<date>-<topic>\` with a manifest.
- **Never edit:** DSH source, the installed harness home or config, or the user's harness
  files.
- **Never copy:** credentials, `.env`, installed home data or matter data.

## Traverse

Start from the repo map and open the owning file. Use `rg` on a leaf path with an include
filter. Do not glob a repository root; do not search `node_modules`, `resources` or
`upstream` unless the task is DSH knowledge; never search `app.asar`.

## Close

Write `C:\dev\advodsh\.agents\logs\YYYY-MM-DD-<topic>.md` with goal, commands run, results,
evidence paths, blockers and next action. Write
`C:\dev\advodsh\.agents\prompts\YYYY-MM-DD-successor-<topic>.md` with goal, context, scope,
done criteria, stop conditions and report format. Record commands and evidence, not
reasoning or history.

## Report

Report what changed, the evidence path, what is unverified, and the next target. Do not
claim a check passed without the command and its result.
