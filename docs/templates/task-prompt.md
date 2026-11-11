# Task prompt template

Copy this block into a new session. Fill every field. Delete a field only if it truly does not apply.
Keep the whole prompt under 40 lines. Put large input in a file and name the file. Never paste it.

```
GOAL
One sentence: what must exist or be true when the task ends.

DONE WHEN (each line must be checkable by a command or a file)
- [command or check] -> [expected result]
- [file path] contains [specific content]

READ (only these)
- [path or section]

MAY EDIT (only these)
- [path]

DO NOT (the rules you have had to repeat)
- Do not use [X].
- Do not touch [path or folder], including the installed harness and %USERPROFILE%\.dsh.
- Do not commit, push, or delete anything on the remote unless this prompt says so.
- Run destructive or write tests on copies in [scratch folder] only.

STOP AND REPORT IF
- a file in READ is missing, or two instructions conflict;
- the task needs a file outside MAY EDIT.

REPORT FORMAT
- First line: done / partly done / blocked.
- Then: files changed, commands run with results, anything not verified.
- No narrative of your reasoning.

HANDOFF (long tasks only)
Write a successor prompt to [path] using this same template.
```

## Rules for filling it

1. One deliverable per session. Start a new session for the next one.
2. State non-goals in DO NOT on the first message, not later.
3. Write DONE WHEN as a test that can fail. "Works" and "verified" are not tests.
4. One ask per prompt. Put a second ask in the handoff.
5. Use capital letters for one rule at most.
6. Never paste keys, tokens or passwords. Name the environment variable.
7. Do not paste terminal output as the request. Write the goal and the done condition, then attach the output as a file.
8. If two prompt files exist for the same task, delete the older one.

## Example (filled in)

```
GOAL
Create the DSH bundle dsh-advo-orchestrator in C:\dev\advodsh\plugins\advo-orchestrator-preset with preset id "orchestrator", based on the shipped "standard" preset.

DONE WHEN
- The preset "orchestrator" is listed in the web profile preset roster.
- Its tool list includes subagent, workflow and tool-cordis, and excludes plugin-manager and plugin-market.
- A log and a successor prompt are written to C:\dev\AdvoOrchestrator\logs\.

READ (only these)
- C:\dev\AdvoOrchestrator\docs\repo-map.md
- C:\dev\AdvoOrchestrator\docs\session-modes.md
- C:\dev\AdvoOrchestrator\AGENTS.md

MAY EDIT (only these)
- C:\dev\advodsh\plugins\advo-orchestrator-preset\
- C:\dev\AdvoOrchestrator\.agents\skills\orchestrator-session\SKILL.md

DO NOT
- Do not edit upstream\deepseek-harness or the installed harness.
- Do not add secrets.

STOP AND REPORT IF
- a listed file is missing or the toolset rules conflict.

REPORT FORMAT
- Status line, files changed, commands and results, anything not verified.
```
