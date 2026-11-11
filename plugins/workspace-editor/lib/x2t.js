/**
 * x2t conversion for the editor plugin: one conversion at a time, a cleared
 * temp folder per run, and the font cache PDF export needs.
 *
 * Windows layout (Stage 5, `scripts/stage5/setup-x2t.ps1`):
 *   %LOCALAPPDATA%\advodsh-eo\converter\   x2t.exe, DLLs, DoctRenderer.config, AllFonts.js
 *   resources\euro-office-de\editors\      sdkjs + web-apps the PDF renderer reads
 *   resources\euro-office\fonts\           bundled TTFs
 */
import { spawn } from 'node:child_process'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import taskQueue from './engine/task-queue.cjs'

const pluginDir = path.dirname(fileURLToPath(import.meta.url))
export const repoRoot = path.resolve(pluginDir, '..', '..', '..')

/** Converter home; override for a non-default Stage 5 setup. */
export const CONVERTER_DIR = process.env.WORKSPACE_EDITOR_X2T
  ?? path.join(process.env.LOCALAPPDATA ?? '', 'advodsh-eo', 'converter')
export const X2T = path.join(CONVERTER_DIR, 'x2t.exe')
export const FONTS_DIR = process.env.WORKSPACE_EDITOR_FONTS ?? path.join(CONVERTER_DIR, 'fonts')
export const ALLFONTS = path.join(CONVERTER_DIR, 'AllFonts.js')

export const FORMAT_DOCX = 65
export const FORMAT_PDF = 513
export const FORMAT_BIN = 8192

/** One x2t failure with the process output the editor log records. */
export class X2tError extends Error {
  /**
   * @param {string} message - operator-facing failure.
   * @param {{ code?: number, stderr?: string, stdout?: string }} [details] - process outcome.
   */
  constructor(message, details = {}) {
    super(message)
    this.name = 'X2tError'
    this.code = details.code ?? -1
    this.stderr = details.stderr ?? ''
    this.stdout = details.stdout ?? ''
  }
}

let queue = Promise.resolve()

/**
 * Run one conversion after every earlier one settles (x2t is a single-job process).
 * @param {{ from: string, to: string, format: number, tempDir: string, pdf?: boolean }} job - conversion request.
 * @returns {Promise<{ code: number, stdout: string, stderr: string, ms: number }>} process outcome; non-zero throws.
 */
export function convert(job) {
  const run = queue.then(() => runNow(job), () => runNow(job))
  queue = run.then(() => {}, () => {})
  return run
}

const OPTIONS = '<options>\n<allowPrivateIP>false</allowPrivateIP>\n<allowNetworkRequest>false</allowNetworkRequest>\n</options>\n'

function paramsXml(job) {
  const fontFields = job.pdf === true
    ? `<m_bEmbeddedFonts>true</m_bEmbeddedFonts>\n<m_sFontDir>${taskQueue.xmlEscape(taskQueue.slashes(FONTS_DIR))}</m_sFontDir>\n<m_sAllFontsPath>${taskQueue.xmlEscape(taskQueue.slashes(ALLFONTS))}</m_sAllFontsPath>\n`
    : ''
  return taskQueue.taskQueueXml({
    from: job.from,
    to: job.to,
    format: job.format,
    tempDir: job.tempDir,
    extra: fontFields + OPTIONS,
  })
}

/**
 * x2t writes into a temp folder it must own, and stale contents can return the
 * previous document, so every run gets an empty one.
 * @param {string} tempDir - per-run scratch folder.
 */
async function resetTemp(tempDir) {
  await rm(tempDir, { recursive: true, force: true })
  await mkdir(tempDir, { recursive: true })
}

async function runNow(job) {
  const info = await stat(X2T).catch(() => undefined)
  if (info === undefined) throw new X2tError(`x2t is missing at ${X2T}: run scripts/stage5/setup-x2t.ps1`)
  if (job.pdf === true) {
    const cache = await stat(ALLFONTS).catch(() => undefined)
    if (cache === undefined) throw new X2tError(`font cache is missing at ${ALLFONTS}: PDF export needs it`)
  }
  await resetTemp(job.tempDir)
  const paramsPath = path.join(job.tempDir, 'params.xml')
  await writeFile(paramsPath, paramsXml(job))
  const started = Date.now()
  const result = await new Promise((resolve) => {
    const child = spawn(X2T, [paramsPath], {
      cwd: CONVERTER_DIR,
      env: { ...process.env, APPLICATION_NAME: 'Advocate-Workspace' },
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => resolve({ code: -1, stdout, stderr: stderr + String(error) }))
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
  const ms = Date.now() - started
  if (result.code !== 0) {
    throw new X2tError(`x2t exited ${result.code} converting to format ${job.format}`, { ...result, })
  }
  return { ...result, ms }
}

