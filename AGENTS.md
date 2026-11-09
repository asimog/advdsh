# AGENTS.md - advdsh

This workspace builds and tests DeepSeek Harness (DSH) plugins for a legal DOCX workspace. It runs stock DSH: the DSH agent loop and provider. It is not a product repository.

## Context budget

Treat agent context as a budgeted interface, not a dumping ground.

- This file carries standing orders only. Detail lives in `.agents/` and is linked, not restated.
- Read only what the task needs. Start at `.agents/README.md`.
- One fact, one home. Do not copy architecture, component rules or logs between documents.
- Docs state the current design. No chain-of-thought, owner decisions, alternatives or history.
- Deep process reference, read only when designing workflow: `scratch/deepseek-harness-agent-playbook.md`.

## Advice boundary

The owner is a lawyer. Never give licensing, legal or compliance advice. Record license facts as facts only when the task asks for them; do not recommend, warn about, evaluate or speculate about licenses. This rule overrides any earlier instruction that asked for licensing guidance.

## Operating rules

- When an instruction file and the existing code disagree, follow the conventions in the code and list each mismatch in the final reply.
- Do not delegate multiple tasks to subagents or teams that may conflict with each other.

## Component workflow

1. Build in `C:\dev\advodsh` against unmodified DSH. A component lives in `plugins/<name>`, uses only documented DSH plugin APIs, and is tested in a real DSH profile under `.dsh-home/profiles/`.
2. Publish it as a versioned bundle. Semver, `dsh.bundle.patch`, optional `dsh.client`, `engines.dsh`, docs and provenance.
3. Keep component releases independent of any downstream application. DSH upgrades happen here first.
4. The current component is `dsh-workspace-editor`. Source: `plugins/workspace-editor`.

## Boundaries

- **DSH source is read-only.** `upstream/deepseek-harness` is never edited. If a goal needs a source change, report the missing seam.
- **The installed harness is read-only.** Never edit `%USERPROFILE%\.dsh`, the installed app config or the user's harness files. Dev runs use `DSH_HOME=C:\dev\advodsh\.dsh-home`, `DSH_DESKTOP_USER_DATA_DIR=C:\dev\advodsh\.dsh-desktop`, `DSH_AGENTS_HOME=C:\dev\advodsh\.dsh-agents` and a separate port.
- **Plugin source goes under `plugins/`.** Generated assets under `resources/`; spikes under `spike/`.
- **Records go to `.agents/`.** Logs, prompts, docs and assessments. No plugin code there.
- **No secrets.** Environment keys only; no copied `.credentials.yaml`, `.env` or installed home.
- **Only official EuroOffice or EuroOfficeLite** may be vendored for the editor. GenOffice, WordCraft and PDFCraft are not used.
- **Automation never shows modal dialogs.** Spikes, headless runs and Electron automation write errors to a log file and exit non-zero; they never block on a dialog.

## Start a session

1. Read this file and `.agents/README.md`.
2. Read the owning doc for the task: `plugins/<name>/README.md`, `.agents/docs/legal-docx-workspace.md`, `.agents/docs/eurooffice-hosting-assessment.md`.
3. For plugin work, use the DSH knowledge base under `upstream/deepseek-harness/docs/` and its creator skills.
4. State GOAL / SCOPE / DONE / STOP / REPORT. Plan before multi-file work.

## Close a session

Write a dated log and a successor prompt under `.agents/logs/` and `.agents/prompts/`. Record commands, results and evidence paths, not reasoning or history.

## Ask before

- Publishing a component, changing its registry or scope, or recording a compatibility verdict.
- Changing a public plugin API or a vendored asset version.
- Adding a new process, a database or a module-table row.
- Editing the installed harness config.

## Editing this file

Keep this file under about 1,200 words. Add a rule only if it is needed every session; otherwise put the detail in `.agents/docs/` and link it. Do not restate a linked document.
