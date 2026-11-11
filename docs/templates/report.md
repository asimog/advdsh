# Report template (audit, assessment, verification)

Use this for any report an agent writes. One report answers one question for one reader.
Target length: 150 lines. If it grows past that, split it. Do not add architecture opinion, comparisons or plans to an audit. Write those as separate documents.

```
# [Title: what was examined]

| | |
|---|---|
| Target | [path], commit [hash] |
| Date | [YYYY-MM-DD] |
| Method | [read-only source / executed on copies / live app] |
| Verdict | [one word: ADOPT / ADOPT WITH LIMITATIONS / REVISE / REJECT] |

## 1. Result (5 lines or fewer)
What is true now. What the reader must decide or do.

## 2. Findings
| ID | Severity | Statement | Evidence | Provenance |
|---|---|---|---|---|
| F-1 | Critical | One sentence of current behaviour. | file:line, command and output | E |

## 3. Controls confirmed sound
| ID | Control | Evidence |

## 4. Not verified
| Item | Why not | What would unblock it |

## 5. Commands run
| Command | Result (exit code, counts) |
```

## Rules

1. **Current facts only.** No corrections to earlier reports, no history of what you believed before, no first-person narrative. If an earlier claim was wrong, fix the claim and say nothing about it.
2. **Every finding has a provenance label.**
   - S: read from source at the named commit.
   - E: you executed it and you saw the output.
   - P: a delegate executed it and you checked the raw artifact.
   - U: not verified. U findings go in section 4, not section 2.
3. **One ID scheme per report set.** Never rename a finding. If you merge two findings, keep the lower ID and list the other as an alias.
4. **Severity rubric (state it in the report).**
   - Critical: an executed data-integrity failure, or a write that bypasses the controlled path.
   - High: defeats a stated safety invariant, or can hide or lose work.
   - Medium: a reliability, scope or visibility gap without immediate data loss.
   - Low: hygiene or documentation.
5. **State root causes only if executed.** If you only read the code, write "likely cause" and label it S.
6. **No absolute words without a test.** Do not write "none", "never", "exhaustively" or "irreversible" unless a command proves it. Name the command.
7. **Numbers must come from a command in section 5.** Do not copy a count from another report. Recompute it.
8. **No inference written as fact.** "An edit was accepted into the working copy" is a fact. "A commit would have written it" is inference. Label it or leave it out.
9. **Test only on copies.** Never run a write or destructive probe on a real client document, and never outside the workspace. Hash the originals before and after.
10. **Recommendations are separate.** If asked for fixes, put them in a second file that cites finding IDs. Do not mix them into the findings.
11. **Cross-check before the verdict.** A second reader with no context must be able to find every finding's evidence from the table alone.

## Spec versus report

A report describes what is. A spec describes what must be. Do not put a defect list inside a spec.
A spec holds only: scope, definitions, requirements (one `MUST` per ID, each with a given/when/then test), tool schemas, and error codes. It points at a defects register, which lives in its own file.
