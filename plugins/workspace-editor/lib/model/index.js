/**
 * `workspace-docx-model` row: register `ctx.docxModel`, the per-activation
 * document session service the agent tools consume.
 *
 * The row owns nothing itself: the model holds process-local sessions and
 * disposes them with the fiber. Lease facts arrive from the editor host's
 * `editor-documents/*` events, so a human save marks agent sessions stale
 * before the next commit can race it.
 */
import { createDocxModel } from './model.js'

export const name = 'workspace-docx-model'
export const inject = ['docxEngine', 'editorDocuments']

/**
 * Provide the document model and keep its sessions tied to the plugin fiber.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the row's Cordis context.
 */
export function apply(ctx) {
  const writeEnabled = process.env.WORKSPACE_DOCX_WRITE !== 'off'
  const model = createDocxModel({
    engine: ctx.docxEngine,
    documents: ctx.editorDocuments,
    writeEnabled: writeEnabled,
    log: (level, message, data) => {
      console.error(`[workspace-docx-model] ${message}${data === undefined ? '' : ` ${safeJson(data)}`}`)
      void level
    },
  })

  ctx.effect(() => ctx.provide('docxModel', model), 'workspace-docx-model.service')
  ctx.effect(() => () => model.dispose(), 'workspace-docx-model.dispose')

  ctx.on('editor-documents/saved', (payload) => {
    if (payload && typeof payload.path === 'string' && typeof payload.revision === 'string') {
      model.noteSaved(payload.path, payload.revision)
    }
  })
  ctx.on('session/disposed', (session) => {
    if (session && typeof session.id === 'string') void model.disposeOwner(session.id)
  })
  ctx.on('editor-documents/conflict', (payload) => {
    if (payload && typeof payload.path === 'string') model.noteConflict(payload.path, payload.code)
  })
}

/** @param {unknown} value - log payload. @returns {string} */
function safeJson(value) {
  try {
    return JSON.stringify(value)
  } catch (error) {
    return String(value)
  }
}
