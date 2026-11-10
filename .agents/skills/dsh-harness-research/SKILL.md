---
name: dsh-harness-research
description: Use when a question is about how DeepSeek Harness works or whether a symbol, API or package exists at the pinned checkout, to answer from the docs tier and the pinned source with paths, not from memory.
---

# DSH upstream research

Upstream is `upstream/deepseek-harness` at `dsh@0.2.2-rc.1`, read-only. Durable map:
[deepseek-harness-map](../../../docs/deepseek-harness-map.md). Framework model:
[cordis-map](../../../docs/cordis-map.md).

## Method

1. **Fix the version.** The pinned checkout is the only authority. A doc page or a memory of
   a later version is not evidence.
2. **Read the owning tier.** `docs/architecture.md` for composition and seams,
   `docs/subsystems/<area>.md` for the reference, the package `README.md` for one package's
   contract. Do not start from source unless the docs are silent or wrong.
3. **Confirm in the pinned source.** Locate the symbol, export or route in
   `packages/<group>/<pkg>/src` with a targeted search, then read the surrounding code.
   A symbol mentioned in a doc but absent from source does not exist.
4. **Cite it.** Answer with the path and, where it decides the question, the line. Label the
   answer: VERIFIED (read in pinned source or executed), EXISTING (present, not exercised),
   INFERRED, UNVERIFIED. State what you did not check.
5. **Stop at the decision.** Read the page and the symbols that answer the question; do not
   read a whole tree or a whole package to feel certain.

## Routing

| Question | Open |
|---|---|
| Composition, seams, where behaviour goes | `docs/architecture.md` |
| A subsystem's types and semantics | `docs/subsystems/<area>.md` |
| How to add a tool, package or client component | `docs/cookbook/` |
| Rules enforced in review | `docs/defensive-patterns/` |
| Why a choice was made | `.agents/notes/implemented/` |
| One package's contract | `packages/<group>/<pkg>/README.md` |
| How the repo is gated and tested | `docs/testing.md`, `scripts/verify-*` |
| Client UI, slots, right dock | `docs/subsystems/slots.md`, `sidebar-right.md` |

## Traversal

Search a leaf path with an include filter. Do not glob the repository root; do not scan
`node_modules`, `resources` or the whole `upstream` tree; never read `app.asar`. Prefer the
maps in [docs/](../../../docs/README.md) before searching.

## What not to claim

- Do not claim a behaviour from a doc alone when the question needs the symbol to exist.
- Do not cite a path or line you did not read at this commit.
- Do not present a design intention as current behaviour.
- Do not claim a gate passing proves the behaviour; a check that cannot fail proves nothing.
