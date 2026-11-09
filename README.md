# advdsh

DSH plugin workspace for a legal DOCX editor.

- `plugins/workspace-editor` — EuroOffice-based right-dock editor and agent document tools.
- `.agents/docs/legal-docx-workspace.md` — current design.
- `.agents/docs/eurooffice-hosting-assessment.md` — EuroOffice / EuroOfficeLite hosting decision.

The workspace runs stock DSH from `upstream/deepseek-harness` (pinned, not committed here) with isolated state under `.dsh-home/`. Large generated assets live under `resources/` and are not committed.
