/**
 * Where the engine sidecar and its inputs live. Every path is an environment
 * override first, then a dev-workspace default, so the row loads even when the
 * binaries are missing: `ensureStarted` turns that into ENGINE_UNAVAILABLE with
 * the paths it tried, never a load-time throw.
 */
import { existsSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const engineDir = path.dirname(fileURLToPath(import.meta.url))

/** The plugin package root (`plugins/workspace-editor`). */
export const pluginRoot = path.resolve(engineDir, '..', '..')
/** The advdsh checkout root in a dev workspace; absent in an installed profile. */
export const repoRoot = path.resolve(pluginRoot, '..', '..')
/** Hidden-Electron app directory (main.js, host.html, bridge scripts). */
export const hostDir = path.join(engineDir, 'host')

function isFile(value) {
  try { return statSync(value).isFile() } catch (error) { return false }
}

function isDirectory(value) {
  try { return statSync(value).isDirectory() } catch (error) { return false }
}

const ELECTRON_NAMES = process.platform === 'win32' ? ['electron.exe'] : ['electron']

/** Accept an electron executable, a dist directory, or an app directory. */
function electronFrom(value) {
  if (typeof value !== 'string' || value === '') return undefined
  if (isFile(value)) return value
  if (!isDirectory(value)) return undefined
  for (const name of ELECTRON_NAMES) {
    const direct = path.join(value, name)
    if (isFile(direct)) return direct
    const dist = path.join(value, 'dist', name)
    if (isFile(dist)) return dist
  }
  return undefined
}

/** Accept an x2t executable or the converter directory that holds it. */
function x2tFrom(value) {
  if (typeof value !== 'string' || value === '') return undefined
  const exe = process.platform === 'win32' ? 'x2t.exe' : 'x2t'
  if (isFile(value)) return value
  if (!isDirectory(value)) return undefined
  const candidate = path.join(value, exe)
  return isFile(candidate) ? candidate : undefined
}

/** Accept a Euro-Office frontend root that contains the sdkjs builder. */
function eoRootFrom(value) {
  if (typeof value !== 'string' || value === '') return undefined
  const candidates = [value, path.join(value, 'editors')]
  for (const root of candidates) {
    if (isFile(path.join(root, 'sdkjs', 'word', 'apiBuilder.js'))) return path.resolve(root)
  }
  return undefined
}

function first(candidates) {
  for (const candidate of candidates) {
    const resolved = candidate.isValid(candidate.value)
    if (resolved !== undefined) return resolved
  }
  return undefined
}

function positiveInt(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

/**
 * Resolve engine paths and timeouts.
 * @param {{ electron?: string, eoRoot?: string, x2t?: string, tempRoot?: string, logDir?: string }} [overrides] - test overrides.
 * @returns {object} engine configuration with `missing` listing paths that are not present.
 */
export function resolveEngineConfig(overrides = {}) {
  const env = process.env
  const localAppData = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')

  const electron = first([
    // Inside the DSH desktop host, process.execPath is the host's own
    // electron.exe: reuse it instead of a dev-spike copy.
    { value: process.versions.electron ? process.execPath : undefined, isValid: electronFrom },
    { value: overrides.electron, isValid: electronFrom },
    { value: env.WORKSPACE_EDITOR_ENGINE_ELECTRON, isValid: electronFrom },
    // The DSH Desktop host is Electron: its own executable is the sidecar runtime.
    { value: process.versions.electron === undefined ? undefined : process.execPath, isValid: electronFrom },
    { value: path.join(pluginRoot, 'node_modules', 'electron', 'dist'), isValid: electronFrom },
    { value: path.join(repoRoot, 'spike', 'editor-host', 'node_modules', 'electron', 'dist'), isValid: electronFrom },
    { value: path.join(repoRoot, 'node_modules', 'electron', 'dist'), isValid: electronFrom },
  ])

  const eoRoot = first([
    { value: overrides.eoRoot, isValid: eoRootFrom },
    { value: env.WORKSPACE_EDITOR_ENGINE_EO_ROOT, isValid: eoRootFrom },
    { value: env.WORKSPACE_EDITOR_FRONTEND, isValid: eoRootFrom },
    { value: path.join(repoRoot, 'resources', 'euro-office'), isValid: eoRootFrom },
    { value: path.join(repoRoot, 'resources', 'euro-office-de', 'editors'), isValid: eoRootFrom },
    { value: path.join(pluginRoot, 'resources', 'euro-office'), isValid: eoRootFrom },
  ])

  const x2t = first([
    { value: overrides.x2t, isValid: x2tFrom },
    { value: env.WORKSPACE_EDITOR_ENGINE_X2T, isValid: x2tFrom },
    { value: env.WORKSPACE_EDITOR_X2T, isValid: x2tFrom },
    { value: path.join(localAppData, 'advodsh-eo', 'converter'), isValid: x2tFrom },
    { value: path.join(repoRoot, 'resources', 'euro-office-lite-src', 'src-tauri', 'binaries'), isValid: x2tFrom },
    { value: path.join(repoRoot, 'resources', 'euro-office-de', 'converter'), isValid: x2tFrom },
    { value: env.WORKSPACE_EDITOR_ENGINE_X2T_DIR, isValid: x2tFrom },
  ])

  const tempRoot = path.resolve(overrides.tempRoot
    ?? env.WORKSPACE_EDITOR_ENGINE_TEMP
    ?? path.join(os.tmpdir(), 'advodsh-docx-engine'))
  const logDir = path.resolve(overrides.logDir
    ?? env.WORKSPACE_EDITOR_ENGINE_LOGS
    ?? path.join(localAppData, 'advodsh-eo', 'engine', 'logs'))

  const electronValue = overrides.electron ?? env.WORKSPACE_EDITOR_ENGINE_ELECTRON
  const eoValue = overrides.eoRoot ?? env.WORKSPACE_EDITOR_ENGINE_EO_ROOT
  const x2tValue = overrides.x2t ?? env.WORKSPACE_EDITOR_ENGINE_X2T

  const missing = []
  if (electron === undefined) missing.push(`electron (tried ${electronValue ?? 'WORKSPACE_EDITOR_ENGINE_ELECTRON and dev locations'})`)
  if (eoRoot === undefined) missing.push(`Euro-Office frontend with sdkjs/word/apiBuilder.js (tried ${eoValue ?? 'resources/euro-office'})`)
  if (x2t === undefined) missing.push(`x2t converter (tried ${x2tValue ?? 'WORKSPACE_EDITOR_X2T and Stage 5 converter'})`)

  return {
    electron: electron,
    eoRoot: eoRoot,
    x2t: x2t,
    tempRoot: tempRoot,
    logDir: logDir,
    hostDir: hostDir,
    missing: missing,
    timeouts: {
      startupMs: positiveInt(env.WORKSPACE_EDITOR_ENGINE_STARTUP_TIMEOUT_MS, 90_000),
      requestMs: positiveInt(env.WORKSPACE_EDITOR_ENGINE_TIMEOUT_MS, 60_000),
      openMs: positiveInt(env.WORKSPACE_EDITOR_ENGINE_OPEN_TIMEOUT_MS, 180_000),
      saveMs: positiveInt(env.WORKSPACE_EDITOR_ENGINE_SAVE_TIMEOUT_MS, 180_000),
      shutdownMs: positiveInt(env.WORKSPACE_EDITOR_ENGINE_SHUTDOWN_TIMEOUT_MS, 20_000),
    },
    testHooks: overrides.testHooks ?? env.WORKSPACE_EDITOR_ENGINE_TEST_HOOKS === '1',
  }
}

/** Whether the host directory has the files the sidecar needs. */
export function hostFilesPresent(dir = hostDir) {
  return ['main.js', 'preload.js', 'host.html', 'host-bridge.js', 'frame-bridge.js'].every((name) => existsSync(path.join(dir, name)))
}
