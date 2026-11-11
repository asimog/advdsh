# NewDevHarness — build guide

Status: build definition. NewDevHarness is a **separate Desktop harness for general coding**,
not a test target. It has its own DSH home, its own profile, its own plugins and its own
window; it does not share the installed devharness profile or the testweb/localbuild profiles.

## 1. Shape

| Concern | Value |
|---|---|
| Home | `C:\dev\advodsh\.ndh-home` (gitignored) |
| Agents home | `C:\dev\advodsh\.ndh-agents` (gitignored) |
| Electron userData | `C:\dev\advodsh\.ndh-desktop` (gitignored) |
| Profile | `$DSH_HOME/profiles/desktop` — the Desktop carrier hardcodes this name |
| Carrier | pinned checkout `upstream/deepseek-harness`, dev Desktop launcher |
| Debug ports | renderer `9243`, host inspect `9251`, main inspect `9252` (separate from localbuild) |

The desktop application is a carrier around the same `dsh-web-app` surface. The profile
name inside a DSH home is always `desktop`; therefore “a NewDevHarness app” means **a new
DSH home whose `profiles/desktop` is the NewDevHarness composition**, launched with that
home. A true branded installer is a later carrier build, not a profile change.

## 2. Setup

```powershell
# profile only; no plugins yet
powershell -ExecutionPolicy Bypass -File scripts/newdev-setup.ps1 -Stage none

# recommended general-coding tooling
powershell -ExecutionPolicy Bypass -File scripts/newdev-setup.ps1 -Stage core

# everything requested, including the UI/product extras
powershell -ExecutionPolicy Bypass -File scripts/newdev-setup.ps1 -Stage full
```

Add `-DryRun` to print the install commands without running them. Add `-Force` to rebuild the
profile from the known-good desktop profile.

The script copies the working `desktop` profile from `.dsh-home`, removes the editor and OCR
plugins, and installs the staged package set with the pinned CLI:

```powershell
$env:DSH_HOME='C:\dev\advodsh\.ndh-home'
node --import tsx/esm apps/cli/src/bin.ts plugin --profile desktop add <package>
```

## 3. Launch

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start-newdev-desktop.ps1
```

The launcher sets the isolated home, agents home, Electron userData and debug ports, then runs
`pnpm run start:desktop` from the pinned checkout. The log is `spike/newdev-desktop.log`.

Credentials: the profile patch references `OPENROUTER_API_KEY`. The new home has no
credential store entry. Either add a key in Settings after the app opens, or create a
gitignored `.ndh-env.ps1` beside the scripts with `$env:OPENROUTER_API_KEY = '...'`; the
launcher dot-sources that file when present. Do not copy `.credentials.yaml` from another home.

## 4. What is installed today (verified 2026-11-11)

Devharness, from `plugin_manager list_plugins` (215 rows):

| Capability | State |
|---|---|
| Plugin manager + market (`dsh-plugin-market`, `dshmarket`) | installed |
| Experimental inspector + session inspector + client stats | installed |
| Persistent terminals (`dsh-terminal`, `dsh-tool-terminal`, pwsh backend) | installed |
| Browser tools (`dsh-browser`) + browser skill | installed |
| Agent Teams (server, tools, UI) | installed |
| Native directory picker | installed |
| MCP resources | installed |
| `mcp-client` | **not installed** |
| Browser-use provider | **not installed** |
| Computer-use provider | **not installed** |
| `dsh-as-mcp`, MCP Manager Plus | **not installed** |
| Office skill, workspace dependencies | **not installed** |
| Session-search bundle | **not installed** |
| LiveShare, webhook, forge, Ralph, speech/voice/translation, action cards, recommendations, badge, PTC-python | **not installed** |

Global tools:

| Tool | State |
|---|---|
| `agent-desktop` | installed (`%APPDATA%\npm`) |
| `claude` | installed |
| `dsh` CLI | installed, version `0.2.2-rc.1` |
| `node` / `npx` | installed |
| Playwright | **not installed** |
| `cua-driver` CLI | **not installed** (the skill catalog lists a CUA skill, but the CLI is absent) |

Test profiles for reference: `testweb` and `desktop` (localbuild) contain only
`workspace-editor` / `workspace-ocr` links; no testing plugins are installed there.

## 5. Package plan

### Core (recommended for general coding)

| Package | Why |
|---|---|
| `@deepseek-ai/dsh-experimental-inspector-profile` | Bundle: inspector, session log, Statistics tab |
| `@deepseek-ai/dsh-experimental-terminal-bundle` | Persistent shells across tool calls |
| `@deepseek-ai/dsh-experimental-session-search` | Search/read earlier sessions for reports |
| `@deepseek-ai/dsh-mcp-client` | Connect MCP servers as native tools |
| `@deepseek-ai/dsh-experimental-browser-use-runtime` | Shared per-session browser lifecycle |
| `@deepseek-ai/dsh-experimental-browser-use-playwright-mcp` | Playwright browser tools through the browser-use provider (one provider only) |
| `@deepseek-ai/dsh-skill-office` | Word/PPT/Excel workflows |
| `@deepseek-ai/dsh-tool-workspace-dependencies` | Bundled Python/Node/pnpm paths |
| `@deepseek-ai/dsh-subagent-acp` | ACP delegation |
| `@deepseek-ai/dsh-subagent-dsh-sdk` | SDK delegation |
| `dsh-as-mcp` | Expose NewDevHarness as an MCP server for Claude Code/other agents |
| `dsh-mcp-manager-plus` | MCP server configuration UI |
| `dsh-computer-use-win` | One Windows computer-use provider (exclusive seam) |

### Full extras (UI/product and requested packages)

| Package | Caveat |
|---|---|
| `@deepseek-ai/dsh-experimental-ralph-bundle` | Repeated fresh-agent loop; niche |
| `@deepseek-ai/dsh-experimental-speech-to-text` + `@deepseek-ai/dsh-experimental-api-speech-to-text` | Speech provider + authenticated API |
| `@deepseek-ai/dsh-experimental-voice-input-bundle` | Local SenseVoice voice input; runtime/download |
| `@deepseek-ai/dsh-experimental-translator` + `@deepseek-ai/dsh-experimental-cot-translation-bundle` | Translation; model-dependent |
| `@deepseek-ai/dsh-action-cards` + `@deepseek-ai/dsh-client-ui-action-cards` | Answer action cards |
| `@deepseek-ai/dsh-creation-recommendations` + client UI | Interface recommendations |
| `@deepseek-ai/dsh-plugin-recommendations` + client UI | Plugin suggestions |
| `@deepseek-ai/dsh-personalized-recommendations` | Personalized pages/plugins |
| `@deepseek-ai/dsh-experimental-badge-skill-bundle` | “Powered by dsh” badge skill |
| `@deepseek-ai/dsh-experimental-ptc-runtime-python` | CPython PTC runtime |
| `@deepseek-ai/dsh-experimental-liveshare` | Session sharing; needs a relay |
| `@deepseek-ai/dsh-webhook` + `@deepseek-ai/dsh-webhook-github` | External trigger → session; security-sensitive |
| `@deepseek-ai/dsh-hooks-claude-code` + `@deepseek-ai/dsh-hook-protocol` | Claude Code hook parity |
| `@deepseek-ai/dsh-experimental-agent-team-profile` | Agent Teams collaboration bundle |

### Explicitly not added

- `@deepseek-ai/dsh-experimental-webworker-runtime` / `webworker-packer` — browser-only harness packaging.
- `@deepseek-ai/dsh-experimental-forge*` — change-request UI.
- `@deepseek-ai/dsh-experimental-cua-macos` / `dsh-cua-bundle` — macOS-only.
- A second browser-use provider or a second computer-use provider — both seams are exclusive; adding two breaks registration.
- Workspace-editor, workspace-ocr, testweb/localbuild-only plugins — NewDevHarness is for general coding.

## 6. Verification checklist

1. `scripts/newdev-setup.ps1 -Stage none` creates `.ndh-home/profiles/desktop`.
2. `scripts/start-newdev-desktop.ps1` opens a window titled “DSH Local Build” using the new
   userData; it has separate settings/sessions from devharness.
3. Plugins page lists the installed bundle set; MCP Manager Plus has the expected entries.
4. `dsh-as-mcp` settings page shows port `8790` and a token under
   `.ndh-home/dsh-as-mcp/token`.
5. A new session can open a workspace and run a shell command.
6. Agent desktop: `agent-desktop status` passes; add its MCP server in MCP Manager Plus.
7. `@deepseek-ai/dsh-experimental-inspector-profile` exposes the inspector/session log tabs.
8. Missing packages or a failed install are reported by the setup script; re-run the same
   stage after fixing the registry/network. Packages are pinned to the `0.2.2-rc.1` line;
   do not mix `master`.

## 7. Packaging path

- **Now:** dev Desktop from the pinned checkout with an isolated home and userData. This is a
  working personal NewDevHarness, not a distributable product.
- **Branded installer:** the upstream desktop carrier hardcodes the `desktop` profile path and
  product identity. Shipping a separate `NewDevHarness.exe` means a downstream carrier build
  (copy, not edit, `apps/desktop`), changed product name, icons, profile, updater and signing.
  Keep upstream read-only.
- **Portable alternative:** a launcher that sets `DSH_HOME`, `DSH_AGENTS_HOME` and
  `DSH_DESKTOP_USER_DATA_DIR` and starts the installed Desktop executable. It gives a separate
  app instance but keeps the product’s name and update channel.

## 8. Boundaries

- Upstream DSH remains read-only; all customization lives in the new home, the profile and
  repo scripts.
- Do not copy credentials, `.credentials.yaml`, sessions or cookies between homes.
- Tokens and MCP endpoints stay loopback-only.
- Experimental packages can change between releases; pin the version line.
- NewDevHarness does not carry workspace-editor, testweb or localbuild responsibilities.
