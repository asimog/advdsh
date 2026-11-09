# .agents - agent context

Agent context for `C:\dev\advodsh`. The root [AGENTS.md](../AGENTS.md) is authoritative; this page indexes the detail.

## Context budget

- Read only what the task needs. Start here, then the owning doc.
- One fact, one home. Link, do not copy.
- No chain-of-thought, owner decisions, alternatives or history in docs, logs or prompts.
- Stable docs live in `docs/`; session records in `logs/` and `prompts/`; agent scratch in `scratch/`.
- Deep process reference, read when designing workflow: `../scratch/deepseek-harness-agent-playbook.md`.

## Index

| Path | What |
|---|---|
| `docs/legal-docx-workspace.md` | Current design: plugin rows, DSH mapping, editor, engine, tools, right-click → chat |
| `docs/eurooffice-hosting-assessment.md` | EuroOffice / EuroOfficeLite hosting decision and engine gate |
| `logs/` | Dated session logs, append-only |
| `prompts/` | Handovers and successor prompts |

## Start order

1. Root `AGENTS.md`.
2. This file.
3. The owning doc for the task.
4. The latest log and the successor prompt that started the session.

## Records

A session that changes code or a component leaves a log in `logs/` and a successor prompt in `prompts/`. Record the command, result and evidence path. Do not record reasoning or history.
