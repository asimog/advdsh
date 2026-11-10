# .agents — agent records and skills

Agent records for `C:\dev\advodsh`. Durable reference lives in the repository root
[`docs/`](../docs/README.md); this folder holds what past sessions did, not current design.

## Index

| Path | What |
|---|---|
| `logs/` | Dated session logs, append-only |
| `prompts/` | Handovers and successor prompts |
| `skills/` | Procedures: `orchestrator-session`, `dsh-cordis-plugin`, `dsh-harness-research`, `dsh-evidence`, `dsh-docs`, `workspace-editor` |
| `trash/` | Retired documents and replaced versions, with manifests; not current guidance |

## Start order

1. Root `AGENTS.md`.
2. [`docs/README.md`](../docs/README.md), then the owning page.
3. The latest log and the successor prompt that started the session.

## Records

A session that changes code or a component leaves a log in `logs/` and a successor prompt
in `prompts/`. Record the command, result and evidence path. Retired documents move to
`trash/<date>-<topic>/` with a manifest; do not delete history silently.
