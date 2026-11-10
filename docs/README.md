# Documentation

Durable reference for `C:\dev\advodsh`. Read the owning page for the task; do not read the
whole folder. Records (logs, prompts, skills, trash) live in `.agents/`.

| Page | What | Read when |
|---|---|---|
| [repo-map.md](repo-map.md) | Workspace paths, write boundaries and traversal | Starting any session |
| [cordis-map.md](cordis-map.md) | How Cordis works in DSH: context, services, events, lifecycle, loader | Working on plugin composition or APIs |
| [deepseek-harness-map.md](deepseek-harness-map.md) | Upstream DSH repository map and where to look | Reading or verifying DSH source |
| [plugin-knowledge-base.md](plugin-knowledge-base.md) | Building, composing, testing and publishing a DSH plugin | Authoring or changing a plugin |
| [legal-docx-workspace.md](legal-docx-workspace.md) | Normative specification (revision 3) of the legal DOCX workspace: requirements, invariants, OOXML view, current defects, verified controls, acceptance gates | Working on `plugins/workspace-editor` or changing its design |
| [eurooffice-hosting-assessment.md](eurooffice-hosting-assessment.md) | EuroOffice / EuroOfficeLite hosting decision | Vendoring or changing the editor frontend |

## Reading order

1. Root [AGENTS.md](../AGENTS.md) — standing orders.
2. [repo-map.md](repo-map.md) — where things are and what may be written.
3. The owning page above.
4. For DSH work, [cordis-map.md](cordis-map.md) and
   [deepseek-harness-map.md](deepseek-harness-map.md).
5. For plugin work, [plugin-knowledge-base.md](plugin-knowledge-base.md) and the plugin's
   own `README.md`.

## Records

Session logs, handovers, skills and retired documents are in
[`.agents/`](../.agents/README.md). They are not durable reference; read the docs above
first.
