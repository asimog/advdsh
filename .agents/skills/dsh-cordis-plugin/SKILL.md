---
name: dsh-cordis-plugin
description: Use when adding, changing or reviewing a DSH plugin bundle, Cordis row, agent tool, prompt context or right-dock client surface in this repo, to keep the composition loadable and the extension points real.
---

# DSH Cordis plugin work

A plugin here is one bundle package whose `cordis.patch.yml` inserts several Cordis rows.
Durable reference: [cordis-map](../../../docs/cordis-map.md),
[plugin-knowledge-base](../../../docs/plugin-knowledge-base.md),
[repo-map](../../../docs/repo-map.md).

## Procedure

1. **Find the owner.** Name the row that owns the behaviour. A new behaviour goes in the
   existing row that already owns that service or surface; a new row is justified only by a
   separate service or lifecycle. Add its `name` to the package `exports` map and to
   `cordis.patch.yml` when you add a row.
2. **Check the row contract.** Function plugin: named `name`/`inject`/`apply`, no default
   export. Required services in `inject`; optional services through `ctx.get(name)`.
   Provide a service inside `ctx.effect(() => ctx.provide(...), label)`; give every owned
   resource a dispose effect. Registrations that are not effects leak on unload.
3. **Pick the extension point.** Tools (`ctx.tools.register`), prompt context
   (`ctx.systemPrompt.context`), routes and SSE (`ctx.webServer.register`), child processes
   (`ctx.subprocess`), sub-agents (`ctx.subagents.startActivation`), files (`ctx.fs`),
   durable state (`ctx.storage`). The table and symbols are in
   [plugin-knowledge-base](../../../docs/plugin-knowledge-base.md).
3. **Design the model-facing surface first.** Name, description, parameters and output
   schema state the operation and its result, not the host or Cordis behind it. Bound the
   output; return ids, paths and previews, never whole documents. Give every deferred
   resource a retrieval path (a tool call or an id).
4. **Client surfaces.** A client module ships through `dsh.client` as
   `window.__ModuleLoader__.load({ id, factory })` with `inject`/`apply`. For a right-dock
   tab: register the type, the keyed `sidebar.right.pane.tab` body, the title seat and a
   close handler that takes `(sessionId, tab)`. Context menus go through
   `ctx.contextMenus.register`; composer staging uses the tab's `inputActions`.
5. **Compose and run.** Add the bundle to the dev profile's `package.json` and
   `cordis.patch.yml`, then launch with the isolated homes and a separate port. Row order
   follows `inject`; insert order only documents intent.
6. **Verify.** Unit tests for logic, the owning verifier for engine/model paths, and a real
   profile run for anything user-visible. Prove disposal: dispose the fiber and observe the
   contribution removed. See [dsh-evidence](../dsh-evidence/SKILL.md).

## Invariants that have been violated here

- **One persistent write authority.** A second tool or route that writes the document
  directly bypasses the lease, the dirty check and tracked changes. Do not add one.
- **Confine paths at one seam.** Tools and routes that accept absolute paths have no
  workspace boundary unless the code adds it.
- **Scope state to the DSH session or workspace.** A store or registry per plugin activation
  leaks handles and document identities across sessions.
- **Model-visible facts are logged.** Prompt contexts and tool results come from the session
  log; do not create model-visible state that cannot be replayed.
- **Plugin routes are unauthenticated by default.** Call
  `ctx.get('connection')?.requestRejection(req)`; prefer the remote/typert seam when the
  gateway owns principal and access.
- **An iframe `contextmenu` never reaches the parent.** Read the selection inside the frame
  and relay it with origin and source validation; that bridge is an application pattern.

## What not to claim

- Do not claim a row is registered because the file exists; load it and confirm the row.
- Do not claim a tool works because it returns; check its structured result and the page's
  acknowledgement.
- Do not claim a Cordis behaviour from memory; confirm the symbol in the pinned source.
