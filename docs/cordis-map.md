# Cordis map — how the plugin framework works in DSH

Status: current for `dsh@0.2.2-rc.1` (vendored Cordis 4.1.0). Upstream paths are relative
to `upstream/deepseek-harness/`. Source is read-only; verify file:line against the pinned
checkout before relying on a detail.

## What Cordis is here

DeepSeek Harness is an all-plugin Cordis application. The agent loop, tools, sessions,
models, UI services and every product feature are Cordis plugins. DSH imports the
framework from `vendor/cordis` (rescoped as `@deepseek-ai/cordis`, `private: true`); the
plugin contract is documented in `docs/cordis-primer.md`, `docs/cordis-api/`,
`docs/cordis-tutorial/`, and in `packages/AGENTS.md` plus root `AGENTS.md`.

## Core model

| Concept | Meaning | Where |
|---|---|---|
| `Context` (`ctx`) | One shared, hierarchical service and event scope. A plugin mounts into it and registers contributions on it. | `docs/cordis-api/context.md`; `vendor/cordis/src/context.ts` |
| Plugin | A unit with `name`, optional `inject`, optional `Config`, and `apply(ctx)`. It may also be a service class (default export). | `docs/cordis-tutorial/01-first-plugin.md`; `packages/AGENTS.md` |
| Fiber | The per-plugin activation that owns registrations and disposes them in reverse order. "Registration is an effect." | `docs/cordis-api/fiber.md`; root `AGENTS.md` conventions |
| Service | A named capability registered on the context (`ctx.tools`, `ctx.webServer`, or a plugin-defined name). One provider per name. | `docs/cordis-api/service.md` |
| Injection | `inject` lists services that must exist before `apply` runs; activation waits for them. Load order follows injection, not file order. | `docs/cordis-tutorial/03-services.md` |
| Effect | `ctx.effect(() => disposer)` ties a resource to the fiber. `ctx.on` and registry `register()` calls are reversible in the same way. | `docs/cordis-tutorial/02-lifecycle-and-effects.md` |
| Event | A typed notification dispatched through the context; listeners are scoped and disposed with their fiber. | `docs/cordis-api/events.md` |

Rules that follow from the model:

- Every contribution goes through `ctx.effect()` or `ctx.on()`; a registration that is not
  an effect leaks when the plugin unloads.
- A plugin may both provide a service and listen to events; those are independent roles,
  not alternatives.
- Direct service calls are the default. Use an event only when the producer must not know
  the consumer (for example, the editor store publishing `editor-documents/saved` for the
  document model).

## Services

- Declare a required service in `inject`. Declare an optional one with the object form
  (`inject: { required: [...], optional: [...] }`) or read it lazily with `ctx.get(name)`.
- Use `ctx.get(name)` for optional services. Reading `ctx.<name>` through the property
  proxy is topology-sensitive and silently fails on an optional row; DSH records this in
  `docs/postmortem/0001-acp-default-export-drops-inject.md` and `packages/AGENTS.md`.
- Provide a service inside an effect: `ctx.effect(() => ctx.provide('name', value), 'label')`.
  This is also what makes a plugin replaceable: one provider, many consumers
  (`docs/capability-seams.md`).
- Do not invent a service event. The framework's generic "service appeared" notification
  (`internal/service`) is internal and has no plugin contract; use `inject` or a domain
  event such as `subagent/provider-added`.
- A service method with one internal caller is a smell: pass a private closure instead
  (`packages/AGENTS.md`).

## Events

DSH events are typed by declaration merging. Cordis dispatches them in five modes
(`docs/cordis-primer.md`):

| Mode | Behaviour |
|---|---|
| `emit` | Listeners observe in registration order; synchronous; no return value. |
| `waterfall` | Around-middleware: listeners receive `(...args, next)` and must call `next()` to delegate; returning without it short-circuits. |
| `parallel` | Run listeners concurrently and await all. |
| `serial` | Run listeners in order, awaiting each. |
| `bail` | Stop at the first listener that returns a value. |

- `ctx.on(name, listener)` is disposed with the fiber. A listener that throws inside `emit`
  is contained by the caller's own try/catch; the framework does not make it safe for you.
- A plugin-local event name is legal, but it is not a declared `SessionEventMap` member and
  is not durable. Anything model-visible must be reconstructable from the session log;
  plugin-local events between rows in one process are fine, model-visible facts are not.
- If an event changes model-visible input, prefer a declared session event plus projection
  and persistence-catalog entry over a hand-rolled Cordis event.

## Plugin forms and exports

- **Function plugin:** named exports `name`, `inject`, `Config`, `apply`; no default export.
- **Service package:** default-export the service class. Do not mix the two forms; the
  Loader discards a function plugin's namespace when a default export is present
  (`docs/postmortem/0001-acp-default-export-drops-inject.md`, `packages/AGENTS.md`).
- Config is validated at load. Deployment-varying choices are `Config` fields changeable
  from `cordis.yml`; a module constant or test hook is not configurability
  (root `AGENTS.md`). Misconfiguration must fail loud at load, never silently skip.
- A plugin that contributes to a registry must prove disposal in a test: dispose the fiber
  and observe removal (`docs/testing.md`).

## Loader and composition

- `cordis.yml` is the load manifest. Bundle patches live in `packages/bundle/*/cordis.patch.yml`;
  files use `insert`, `disabled` and plugin `config`.
- `cordis.yml` allows `!!js` (never `!js`) under plugin `config` and entry `disabled`;
  other metadata stays literal (`docs/cordis-primer.md`).
- Bare plugin names in a profile must appear in that profile's resolver manifest's
  `dependencies`; `verify-cordis-config` enforces it.
- A dev app composes a profile under `.dsh-home/profiles/<name>/` from bundle patches plus
  a patch that points at local packages. Row order follows injection, so the visible
  `insert` order is documentation, not scheduling.
- `cordis.patch.yml` in a plugin bundle inserts several rows that resolve through the
  package `exports` map (`workspace-editor`, `workspace-editor/engine`, ...). See
  [plugin-knowledge-base.md](plugin-knowledge-base.md) for the package contract.

## Lifecycle and unload

- Effects and listeners dispose in reverse registration order when the fiber stops.
- Registries (`ctx.tools`, `ctx.webServer`, `ctx.sidebarRightTabs`, ...) return disposers;
  a customer-facing registry must also be safe to reload.
- A plugin that owns a child process, server or background job must terminate it in its
  dispose path and await quiescence; the fiber only disposes what it was given.
- Client UI has no Cordis fiber. `lib/client.js` is a DSH client module, not a host plugin;
  its `inject`/`apply` run in the browser against client services. Do not assume a Cordis
  `ctx` in a React component.

## Reading order

1. `docs/cordis-primer.md` — the model and the waterfall rule.
2. `docs/cordis-tutorial/01-first-plugin.md` … `05-config.md`.
3. `docs/cordis-api/context.md`, `events.md`, `fiber.md`, `service.md`, `registry.md`.
4. `packages/AGENTS.md` and root `AGENTS.md` conventions — the DSH-specific rules.
5. `vendor/cordis/src/` — only when a behaviour is not documented (e.g. `reflect.ts` for
   `provide`, `events.ts` for dispatch internals).

## Local examples

- Six rows in one bundle: `plugins/workspace-editor/cordis.patch.yml`.
- Provide + effect + dispose: `plugins/workspace-editor/lib/model/index.js`.
- Optional service: `ctx.get('connection')` in `plugins/workspace-editor/lib/index.js`.
- Plugin-local event seam: `editor-documents/saved` between the editor row and the model row.
- Tool registration as an effect: `plugins/workspace-editor/lib/tools/index.js`.

## Caveats recorded by the mapping sessions

- `provide(name, value, check)` has a third argument in `vendor/cordis/src/reflect.ts`, but
  it is not on the typed `Context` surface; treat it as unverified for plugins.
- `internal/service` exists but is framework-internal. Do not build a plugin contract on it.
- The property proxy `ctx.<service>` is not an optional-service read. Use `ctx.get`.
