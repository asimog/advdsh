# DeepSeek Harness — upstream repository map

Status: current for the pinned checkout `upstream/deepseek-harness` at `dsh@0.2.2-rc.1`
(November 2026). Read-only. Paths are relative to that directory. Verify file:line at the
pinned commit before citing it; the framework is pre-stable.

## Scale and starting facts

The pinned snapshot has roughly 372 workspace packages in 52 groups, about 2,520
TypeScript source files under `packages/*/*/src`, 30 `AGENTS.md` instruction files, 304
English documentation pages, and 80 `verify-*` gate scripts. Treat these as orientation,
not as constants.

Start order for any DSH question:

1. `docs/architecture.md` — the ordered map of composition, core packages, the loop and
   the extension points.
2. `docs/subsystems/<area>.md` — the reference page for the subsystem you touch.
3. `packages/<group>/<pkg>/README.md` — that package's contract.
4. Source, only for the file that answers the question.

## Top level

| Path | What |
|---|---|
| `AGENTS.md` | Standing orders for the repository; read before changing `packages/`. |
| `docs/` | Architecture, subsystem references, cookbooks, defensive patterns, postmortems, user guides, generated catalogs, Agent Notes. |
| `packages/` | Workspace packages at `packages/<group>/<pkg>/`; the product source. |
| `apps/` | `web` and `desktop` application shells that boot the harness. |
| `vendor/` | Pinned vendored Cordis (`vendor/cordis`, rescoped `@deepseek-ai/cordis`, `private: true`). |
| `.agents/` | Skills, Agent Notes (implemented/archived), workflows and review rules. |
| `scripts/` | Gates, generators, `verify-*` scripts. |
| `snapshots/` | Keyless recorded-session snapshots, replayed through shipped profiles. |
| `python/`, `native/`, `benchmarks/`, `website/` | Python SDK/runtime, native add-ons, performance gates, VitePress documentation site. |
| `.github/` | CI routing and workflow rules. |

## Package groups

| Group | Holds |
|---|---|
| `core/` | Agent and session API, system prompt, tools, providers, guards, context, compaction, goal, plan, todo, schedule, skills, subagents, workflow, jobs, feedback |
| `api/` | Remote BFF, API gateway, remote access, session controller, workspace files |
| `typert/` | Type graph, remote namespace generation |
| `llm/` | Model providers and adapters |
| `shell/`, `subprocess/`, `ssh/`, `terminal/` | Command execution and child-process management |
| `sandbox/` | Process confinement backends |
| `fs/`, `lsp/`, `storage/`, `workspace/` | Filesystem, language servers, non-session storage, workspace entities |
| `web/`, `computer-use/`, `browser-use/`, `skill/` | Search/fetch, UI automation, browser interaction, skill loading |
| `session/`, `session-query/` | Durable sessions, browsing/search/export |
| `bundle/`, `preset/`, `boot/` | Profile bundles, agent presets, application boot |
| `host/`, `client/` | GUI host services and the web client (see below) |
| `sdk/`, `acp/`, `interaction/`, `identity/`, `settings/`, `credentials/` | SDKs, automation, human interaction, identity, settings, secrets |
| `deliverables/`, `attachment/`, `spill/`, `extensions/`, `experimental/`, `test-support/`, `util/` | Turn deliverables, attachments, output spill, runtime self-modification, evaluated capabilities, test infrastructure, zero-dependency helpers |

Package groups with their own rules: `packages/AGENTS.md` (plugin export forms, optional
services, lifecycle, testing), `packages/client/AGENTS.md` (client components and slots).

## Documentation tiers (one home per fact)

| Tier | Contains | Must not contain |
|---|---|---|
| Root `AGENTS.md` | Standing orders an agent needs every session | Stories, procedures, restated detail |
| `docs/architecture.md` | Ordered map, composition, seams, extension points | Type definitions, per-package detail, rationale |
| `docs/subsystems/` | One reference page per subsystem: types, semantics, generated Cordis surface | Behaviour narration |
| `docs/cookbook/` | Step-by-step how-tos with verify steps | Design rationale |
| `docs/defensive-patterns/` | Rules enforced in review, by artifact | Type definitions and semantics |
| `docs/postmortem/` | Incident stories | — |
| `.agents/notes/implemented/` | Active decision records: why, what was given up, required verification | Migration plans, acceptance checklists |
| Package `README.md` | That package's contract: config, semantics, limitations, Model Experience | JSDoc restatement, other packages' concerns |
| `docs/user/` | Product-facing guides published by the docs website | Contributor procedures |
| Generated catalogs under `docs/` | `tool-catalog.md`, `config-catalog.md`, `persistence-catalog.md`, `module-graph.md`, `cli-help.md`, `cordis-surface` regions | Hand edits |

`docs/AGENTS.md` owns the writing rules and word budgets.

## Composition and launch

- A profile is `cordis.yml` plus resolver manifest. It is assembled from bundle patches:
  `packages/bundle/base/cordis.patch.yml` (host services and loop),
  `packages/bundle/web-app/*` (web client and server), desktop-specific patches in
  `apps/desktop`, and any local patch that links a plugin package.
- `insert` entries name packages; `config` validates against each plugin's `Config`;
  `disabled` can be conditional; `!!js` is allowed only under plugin `config` and entry
  `disabled` (`docs/cordis-primer.md`).
- `dsh web` / `dsh desktop` boot the harness. `pnpm run dev:web` and `pnpm run dev:desktop`
  build artifacts first and then launch; `start:web` / `start:desktop` skip the build.
- The dev app in this workspace runs from `C:\dev\advodsh` with isolated homes and a
  separate port; the installed harness is never touched.

## Runtime areas and their homes

| Area | Read |
|---|---|
| Agent loop, turn and step lifecycle | `docs/architecture.md`, `docs/agent-lifecycle.md`, `packages/core/agent` |
| Sessions, events, projections, persistence | `docs/subsystems/session.md`, `docs/subsystems/conversation.md`, `packages/session/*` |
| Tools | `docs/subsystems/tools.md`, `docs/cookbook/adding-a-tool.md`, `packages/core/tools` |
| System prompt and prompt contexts | `docs/subsystems/system-prompt.md`, `packages/core/system-prompt` |
| Sub-agents and Agent Teams | `docs/subsystems/subagent.md`, `packages/subagent/*` |
| Skills | `docs/subsystems/skills.md`, `packages/skill/*` |
| Workflow fan-out | `docs/subsystems/workflow.md`, `packages/workflow/*` |
| Web server, routes, SSE | `docs/subsystems/web-server.md`, `packages/host/webserver` |
| Connection, auth, Origin fence | `packages/client/connection`, `docs/subsystems/connection.md` |
| Filesystem and storage | `docs/subsystems/fs.md`, `docs/subsystems/storage.md` |
| Subprocesses and sandboxing | `docs/subsystems/subprocess.md`, `docs/subsystems/sandbox.md` |
| Remote and Typert | `docs/subsystems/remote-and-api.md`, `docs/typert.md`, `packages/typert/*` |
| Bundles, presets, boot | `docs/subsystems/bundles.md`, `docs/subsystems/presets.md`, `packages/bundle/*`, `packages/preset/*` |
| Testing and evidence policy | `docs/testing.md`, `packages/test-support/*`, `snapshots/` |

## Client packages

| Package | Role |
|---|---|
| `client/ui-sidebar-right` | Right dock: tab-type registry, navigation service, close handlers |
| `client/ui-dockkit` | Internal layout engine (not a stable interface) |
| `client/ui-conversation` | Conversation, composer, `inputActions`, session slots |
| `client/ui-context-menu` | Shared context-menu service and `getTriggerProps` |
| `client/resources` | `ctx.resources`, `useResource`, resource protocol map |
| `client/modules` | Client-module contract (`dsh.client`, `window.__ModuleLoader__`) |
| `client/ui-sidebar-documentpreview`, `ui-sidebar-files`, `ui-sidebar-browser` | Shipped tab types |
| `client/hmr` | Client HMR, and the established plugin-owned SSE pattern |

Client plugin code ships through `dsh.client` and is served at `/plugins/??<pkg>/client.js`.
An iframe page can instead be plain HTML from a plugin route and needs no `dsh.client`.

## Where to look, by question

| Question | Open |
|---|---|
| How do I add a tool? | `docs/subsystems/tools.md`; `docs/cookbook/adding-a-tool.md` |
| How do I add a package/plugin? | `docs/cookbook/adding-a-package.md`; `docs/cookbook/adding-a-plugin-preview.md`; `packages/AGENTS.md` |
| How do I put a tab in the right dock? | `docs/subsystems/sidebar-right.md`; `packages/client/ui-sidebar-right` |
| How do I add a client component or slot? | `docs/subsystems/slots.md`; `packages/client/AGENTS.md` |
| How do I add a context-menu entry? | `packages/client/ui-context-menu/README.md`; `docs/upgrade-guide/` |
| How do I stage text in the composer? | `docs/subsystems/slots.md`; `docs/subsystems/conversation.md` |
| How do I serve a route or SSE stream? | `docs/subsystems/web-server.md`; `packages/client/connection` |
| How do I spawn a sub-agent from a tool? | `docs/subsystems/subagent.md`; `packages/subagent` |
| How do I register a prompt context? | `docs/subsystems/system-prompt.md` |
| How do I store durable plugin state? | `docs/subsystems/storage.md` |
| How do I test and gate a change? | `docs/testing.md`; `docs/defensive-patterns/`; `scripts/verify-*` |
| How is a profile assembled? | `packages/bundle/*/cordis.patch.yml`; `docs/architecture.md`; `docs/cordis-primer.md` |

## Gates and evidence

- `pnpm run test` (unit), `pnpm run test:coverage` (CI gate, per-file 100% on
  `packages/*/*/src`), `pnpm run test:snapshot` (keyless recorded sessions),
  `pnpm run test:e2e` (real API, skips without a key), `pnpm run typecheck`, `pnpm run lint`,
  `pnpm run build`, `pnpm run doc-sync`, `pnpm run hygiene`.
- `docs/testing.md` owns the evidence policy: match the proof to the surface, do not default
  to the full suite, report the commands actually run. A passing gate run is not a claim
  that the behaviour is correct if the assertion cannot fail.
- New model-visible or product-visible behaviour needs a snapshot; registry contributions
  need a dispose-and-observe test; capability seams need a real-composition test, not only a
  hand-built `ctx.plugin` fixture.

## How the two mapping sessions used this map

- Session `e9e34917` mapped the extension points before writing code: it read the subsystem
  references, then the pinned package sources, and produced a "DSH plugin-family API map"
  covering the right dock, context menus, composer staging, tools, prompt contexts,
  sub-agents, routes/SSE, files, lifecycle and client modules. It also produced a
  reconciled architecture for the dual-nature editor plugin and a conflict review.
- Session `0585c165` implemented against that map and verified the seams in the pinned
  checkout while building `plugins/workspace-editor`: one bundle with six Cordis rows,
  engine/model/tools/fanout/review services, and the visible editor.
- Takeaway for a new session: map the seam from `docs/subsystems/` first, confirm the exact
  symbols in the pinned package source, then implement; verify with a real profile or a
  real-engine probe, and record the commands. Documentation alone is not evidence that a
  symbol exists at this commit.
