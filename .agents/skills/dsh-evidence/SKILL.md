---
name: dsh-evidence
description: Use when about to claim a plugin change works, skip a check, or report completion in this repo, to select evidence that can fail for the surface changed and report the commands actually run.
---

# Evidence for this repo

Evidence is a command or observation that fails when the claimed behaviour regresses. A
check that passes against a stub, a fake `ctx`, or the wrong surface proves nothing.

## Evidence by surface

| Surface changed | Evidence that covers it |
|---|---|
| Plugin logic (model, tools, fan-out, review) | The owning `plugins/workspace-editor/test/*.test.mjs` file, run with `node --test` |
| Engine sidecar, builder ops, tracked changes | `node plugins/workspace-editor/lib/engine/verify.mjs --with-hooks` |
| Document model, lease, commit, fork/merge | `node plugins/workspace-editor/lib/model/verify.mjs` |
| Saved DOCX opens in Word | `scripts/verify-word-open.ps1` on the verifier artifact, with the artifact's marker |
| Agent tool or prompt context | The tool's structured result plus a real dev-profile run; a registered tool is not a working tool |
| Route or SSE stream | A real request against the dev profile; route auth via `requestRejection` |
| Client module, right dock, menus | The dev profile: the tab loads, the slot renders, the action does what it says |
| Registry contribution or disposal | Dispose the fiber and observe the contribution removed |

## Rules

- Match the proof to the change and to the smallest surface that can fail. Do not default to
  the full suite; CI owns exhaustive coverage. Run it only when no narrower check is credible
  or the owner asks.
- Assert the semantic outcome: exact paragraph text, exact file content, valid OOXML, the
  structured tool result. Counts, markers and presence checks cannot detect corruption,
  wrong targets or lost formatting.
- Verify the world, not the report: re-read the file, re-run the command, inspect the saved
  artifact.
- A failed or blocked command is evidence too. Record the command, its result and the
  evidence path; say what is therefore unverified and who owns it.
- Do not skip a check silently. Weakening an assertion or marking a row done to get green is
  not evidence.

## Report

State the exact command, its result, the artifact or log path, and what it covers. Report
only commands actually run. When a check could not run, name it and the missing evidence.

## What not to claim

- Do not say "tests pass" after a filtered run.
- Do not say the merge is safe because markers survive; the audit found text corruption that
  marker counts missed.
- Do not say the editor works because a verifier started an engine; say which path ran.
- Do not say a tool works because it returned JSON; check the deliverable.
