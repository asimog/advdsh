# Repo map — advodsh

Status: current (2026-11-10). Paths are absolute. This page owns the workspace paths,
write boundaries and traversal rules. It does not restate the DSH repository map; that is
[deepseek-harness-map.md](deepseek-harness-map.md).

## Top level

| Path | Read | Write | Purpose |
|---|---|---|---|
| `C:\dev\advodsh` | yes | yes | DSH plugin testbed: author, test and publish plugins. Not a product repository. |
| `C:\dev\advodsh\upstream\deepseek-harness` | yes | **no** | Pinned DSH source and knowledge base (`dsh@0.2.2-rc.1`). Read docs and packages; never edit. |
| `C:\dev\advodsh\docs` | yes | yes | Durable reference: this map, Cordis map, DSH repo map, plugin guide, designs. Index: [`docs/README.md`](README.md). |
| `C:\dev\advodsh\plugins\<name>` | yes | yes | Plugin source. Current plugin: `plugins/workspace-editor`. |
| `C:\dev\advodsh\resources` | yes | yes | Generated EuroOffice, x2t and font assets. Large; address a known path, do not scan. |
| `C:\dev\advodsh\spike` | yes | yes | Throwaway proofs. Never imported by a plugin. |
| `C:\dev\advodsh\scripts` | yes | yes | Dev launchers, vendoring, verification scripts. |
| `C:\dev\advodsh\vendor` | yes | yes | Vendored pins and manifests (e.g. `vendor/euro-office/manifest.json`). |
| `C:\dev\advodsh\scratch` | yes | yes | Session working copies, audits, extractions. Disposable. |
| `C:\dev\advodsh\.agents` | yes | yes | Records: logs, prompts, skills, trash. Not durable reference. |
| `C:\dev\advodsh\.dsh-home` | yes | yes | Isolated DSH home and profiles for the dev app. |
| `C:\dev\advodsh\.dsh-desktop` | yes | yes | Isolated Electron userData for the dev app. |
| `C:\dev\advodsh\.dsh-agents` | yes | yes | Isolated agent home for the dev app. |
| `%USERPROFILE%\.dsh` and the installed app | **no** | **no** | Installed harness and config. Never read or modify. |

`C:\dev\openadvocate` is a separate product repository. Read it only when a task names it;
its `vendor/` is pristine and changes go through `vendor/patches/`.

## Within docs and .agents

```
docs/        durable reference, indexed by docs/README.md
.agents/
  logs/      dated session logs, append-only
  prompts/   handovers and successor prompts
  skills/    session workflows (orchestrator-session)
  trash/     retired documents and replaced versions, with manifests; not current guidance
```

## Traversal

1. Start at root `AGENTS.md`, then [`docs/README.md`](README.md).
2. Open the owning doc or file before searching. The owning docs are indexed by
   [`docs/README.md`](README.md).
3. Search a leaf path with an include filter. Do not glob a repository root; do not search
   `node_modules`, `resources` or `upstream` unless the task is DSH knowledge; never read
   `app.asar`.
4. Read DSH source only for the specific package or doc page that answers the question.
   The entry points are listed in [deepseek-harness-map.md](deepseek-harness-map.md).

## Write boundaries

- Plugin source goes under `plugins/`; generated assets under `resources/`; spikes under
  `spike/`; durable docs under `docs/`; records under `.agents/`.
- DSH source and the installed harness are read-only. If a goal needs a DSH source change,
  report the missing seam.
- No secrets: environment keys only; no copied credentials, `.env` files or installed home.
- Retired docs and replaced versions go to `.agents/trash/<date>-<topic>/` with a manifest;
  do not delete history silently.

## Where knowledge lives

| Knowledge | Path |
|---|---|
| Standing orders and boundaries | [`AGENTS.md`](../AGENTS.md) |
| Documentation index and read order | [`docs/README.md`](README.md) |
| Workspace paths and traversal | this page |
| Cordis framework model and API map | [cordis-map.md](cordis-map.md) |
| DSH upstream repository navigation | [deepseek-harness-map.md](deepseek-harness-map.md) |
| Building, testing and publishing a plugin | [plugin-knowledge-base.md](plugin-knowledge-base.md) |
| Normative plugin specification | [legal-docx-workspace.md](legal-docx-workspace.md) |
| EuroOffice hosting decision | [eurooffice-hosting-assessment.md](eurooffice-hosting-assessment.md) |
| Session records | [`.agents/README.md`](../.agents/README.md) |
| Procedures and workflows | [`.agents/skills/`](../.agents/skills/) — start with the skill matching the task |
| Deep process reference | [`scratch/deepseek-harness-agent-playbook.md`](../scratch/deepseek-harness-agent-playbook.md) |
