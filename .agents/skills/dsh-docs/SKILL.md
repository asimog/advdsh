---
name: dsh-docs
description: Use when adding, changing, moving or retiring documentation in docs/ or .agents/, to keep one home per fact, state only current guidance, and preserve retired versions in the trash folder.
---

# Documentation and records

`docs/` is durable reference. `.agents/` is records: `logs/`, `prompts/`, `skills/`,
`trash/`. Root `AGENTS.md` is standing orders. Read the owner first; link it, do not restate
it.

## Tiers

| Tier | Path | Owns |
|---|---|---|
| Standing orders | `AGENTS.md` | Rules an agent needs every session |
| Reference | `docs/` | Repo map, Cordis map, DSH map, plugin guide, designs. Index: [docs/README.md](../../../docs/README.md) |
| Records | `.agents/logs/`, `.agents/prompts/` | What a session did, with commands and evidence |
| Procedures | `.agents/skills/` | Reusable workflows, this skill included |
| Retired | `.agents/trash/<date>-<topic>/` | Replaced versions and retired notes, with a manifest |

## Rules

- State the current design only. No reasoning transcripts, decision provenance, change
  history, alternatives, or conversation residue.
- One owner per fact. If a second page needs it, link the owner.
- Update the index that points at the page in the same change: `docs/README.md`,
  `.agents/README.md`, or the plugin README.
- Moving or replacing a document: back up the old version under
  `.agents/trash/<date>-<topic>/` and record it in that folder's `MANIFEST.md`. Do not
  rewrite old logs or prompts; they are history.
- Never leave a file named `AGENTS.md` or `CLAUDE.md` outside the intended path. The harness
  loads any such file in the workspace as live instructions, including inside `trash/`; name
  backups `AGENTS-backup-<reason>.md`.
- Check links after a move: every relative Markdown link must resolve.

## Procedure

1. Find the owning page and the index that references it.
2. Edit the owner. Delete or restate stale prose; do not add a history section.
3. Update the index and any cross-links.
4. Retire what the change replaced, with a manifest entry.
5. Verify links and report what changed and what was retired.

## What not to claim

- Do not claim a page is current while it contains history, alternatives or provenance.
- Do not claim a move is complete while an index or link still points at the old path.
- Do not delete a retired document without a trash copy and a manifest entry.
