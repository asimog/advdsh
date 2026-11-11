/**
 * `workspace-docx-fanout` row: parallel editing over `ctx.subagents`.
 *
 * `doc_fanout` forks the parent session once per task, starts one child per fork
 * through `ctx.subagents.startActivation` with caller delivery, bounds how many
 * children run at once, isolates per-task failures, then merges the completed
 * forks into the parent by stable block id. Children never commit; the parent
 * commits once after the merge.
 */
export const name = 'workspace-docx-fanout'
export const inject = ['tools', 'docxModel', 'subagents', 'docxRoles']

/** Default number of children editing at once. */
const DEFAULT_CONCURRENCY = 3
/** Upper bound for one fan-out call. */
const MAX_TASKS = 8

/**
 * Register the `doc_fanout` tool and its teardown.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the row's Cordis context.
 */
export function apply(ctx) {
  const model = ctx.docxModel
  const subagents = ctx.subagents
  const roles = ctx.docxRoles
  const writeEnabled = process.env.WORKSPACE_DOCX_WRITE !== 'off'
  /** Live activations, disposed with the row or at the end of the call. */
  const activations = new Set()

  if (writeEnabled) {
    ctx.effect(() => ctx.tools.register({
      name: 'doc_fanout',
      description: 'Edit one document in parallel: fork the open session once per task, run each task in an isolated '
        + 'child agent, then merge the completed forks into the parent by stable block id. Children cannot commit; '
        + 'the parent commits once with doc_commit after reviewing the merge. Conflicting changes come back in '
        + '`conflicts` instead of overwriting.',
      parameters: {
        type: 'object',
        properties: {
          doc: { type: 'string', description: 'Parent session handle from doc_open.' },
          tasks: {
            type: 'array',
            description: `Tasks to run, 1 to ${MAX_TASKS}.`,
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', description: 'Short task label for the fork and its findings.' },
                prompt: { type: 'string', description: 'What the child must change in its fork.' },
                kind: { type: 'string', enum: ['apply', 'review'], description: 'Task kind; defaults to apply.' },
                blockIds: { type: 'array', items: { type: 'string' }, description: 'Block chunk of the task.' },
                changes: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Change proposals for an apply task.' },
              },
              required: ['label', 'prompt'],
              additionalProperties: false,
            },
          },
          concurrency: { type: 'number', description: `How many children run at once; default ${DEFAULT_CONCURRENCY}.` },
        },
        required: ['doc', 'tasks'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            doc: { type: 'string' },
            forks: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  handle: { type: 'string' },
                  label: { type: 'string' },
                  status: { type: 'string' },
                  summary: { type: 'string' },
                },
                required: ['handle', 'label', 'status'],
                additionalProperties: true,
              },
            },
            changes: {
              type: 'array',
              items: {
                type: 'object',
                properties: { id: { type: 'string' }, status: { type: 'string' } },
                required: ['id', 'status'],
                additionalProperties: false,
              },
            },
            merged: {
              type: 'object',
              properties: {
                applied: { type: 'number' },
                changed: { type: 'boolean' },
                revision: { type: 'number' },
                conflicts: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      base: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                      parent: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                      reason: { type: 'string' },
                      candidates: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            task: { type: 'string' },
                            text: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                          },
                          required: ['task'],
                          additionalProperties: true,
                        },
                      },
                    },
                    required: ['id', 'candidates'],
                    additionalProperties: true,
                  },
                },
                failed: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      index: { type: 'number' },
                      code: { type: 'string' },
                    },
                    required: ['code'],
                    additionalProperties: true,
                  },
                },
              },
              required: ['applied', 'changed', 'revision', 'conflicts', 'failed'],
              additionalProperties: false,
            },
          },
          required: ['doc', 'forks', 'changes', 'merged'],
          additionalProperties: false,
        },
        render: (_args, value) => [{
          type: 'text',
          text: `${value.forks.length} fork(s): ${value.forks.map((fork) => `${fork.label}=${fork.status}${fork.summary ? ` (${String(fork.summary).slice(0, 80)})` : ''}`).join(', ')}\n`
            + `merged ${value.merged.applied} change(s)${value.merged.conflicts.length > 0 ? `; ${value.merged.conflicts.length} conflict(s) on ${value.merged.conflicts.map((conflict) => conflict.id).join(', ')}` : ''}`
            + `${value.merged.failed.length > 0 ? `; ${value.merged.failed.length} merge failure(s)` : ''}`,
        }],
      },
      async execute(args, exec) {
        const tasks = normalizeTasks(args.tasks)
        if (args.allowOverlap !== true) {
          for (let left = 0; left < tasks.length; left++) {
            for (let right = left + 1; right < tasks.length; right++) {
              if (tasks[left].kind !== 'apply' || tasks[right].kind !== 'apply') continue
              const overlap = tasks[left].blockIds.filter((id) => tasks[right].blockIds.includes(id))
              if (overlap.length > 0) {
                throw Object.assign(new Error(`DOC_INVALID_ARGS: ${tasks[left].label} and ${tasks[right].label} share ${overlap.join(', ')}`), { code: 'DOC_INVALID_ARGS' })
              }
            }
          }
        }
        const concurrency = clampConcurrency(args.concurrency)
        const providerName = 'spawn'
        const provider = typeof subagents.getProvider === 'function' ? subagents.getProvider(providerName) : undefined
        if (provider === undefined) throw new Error(`subagent provider "${providerName}" is not registered`)
        const requestBase = childRequestBase(exec, provider, subagents)
        const forks = []
        /** @type {Array<{fork: object, task: object, status: string, summary?: string}>} */
        const runs = []
        try {
          for (const task of tasks) {
            const fork = await model.fork(args.doc, { label: task.label })
            forks.push(fork)
            runs.push({ fork, task, status: 'pending' })
          }
          await pool(runs, concurrency, async (run) => {
            if (exec.signal && exec.signal.aborted) {
              run.status = 'aborted'
              return
            }
            const prompt = buildPrompt(run.fork, run.task, args.constraints)
            let activation
            try {
              activation = await subagents.startActivation({
                provider: providerName,
                label: run.task.label,
                delivery: 'caller',
                signal: exec.signal,
                request: {
                  prompt: [{ type: 'text', text: prompt }],
                  parent: exec.agent,
                  ...requestBase,
                },
              })
            } catch (error) {
              run.status = 'failed'
              run.summary = error instanceof Error ? error.message : String(error)
              return
            }
            activations.add(activation)
            if (run.task.kind === 'apply') {
              roles.registerApplier(activation.childId, {
                blockIds: run.task.blockIds,
                changeIds: run.task.changes.map((change) => change.id),
              })
            }
            let aborted = false
            const onAbort = () => {
              aborted = true
              run.status = 'aborted'
              void activation.dispose().catch(() => {})
            }
            if (exec.signal) exec.signal.addEventListener('abort', onAbort, { once: true })
            try {
              const result = await activation.result
              if (aborted) return
              run.status = typeof result.stopReason === 'string' ? result.stopReason : 'completed'
              run.summary = outputText(result.output)
            } catch (error) {
              if (aborted) return
              run.status = 'failed'
              run.summary = error instanceof Error ? error.message : String(error)
            } finally {
              if (exec.signal) exec.signal.removeEventListener('abort', onAbort)
              roles.removeApplier(activation.childId)
              activations.delete(activation)
              await activation.dispose().catch(() => {})
            }
          })
          const completed = runs.filter((run) => run.status === 'completed').map((run) => run.fork.handle)
          let merged
          if (completed.length === 0) {
            merged = { applied: 0, changed: false, revision: 0, conflicts: [], failed: [], operations: [] }
          } else {
            merged = await model.merge(args.doc, completed)
          }
          const changes = []
          if (tasks.some((task) => task.kind === 'apply' && task.changes.length > 0)) {
            const live = await model.read(args.doc, { mode: 'full' })
            const byId = new Map((live.blocks ?? []).map((block) => [block.id, block.text]))
            for (const task of tasks) {
              if (task.kind !== 'apply') continue
              for (const change of task.changes) {
                changes.push({ id: change.id, status: byId.get(change.blockId) === change.newText ? 'applied' : 'not-applied' })
              }
            }
          }
          return {
            doc: args.doc,
            forks: runs.map((run) => ({
              handle: run.fork.handle,
              label: run.task.label,
              status: run.status,
              ...(typeof run.summary === 'string' && run.summary !== '' ? { summary: run.summary } : {}),
            })),
            changes,
            merged: {
              applied: merged.applied,
              changed: merged.changed === true,
              revision: merged.revision,
              conflicts: merged.conflicts,
              failed: merged.failed,
            },
          }
        } finally {
          for (const fork of forks) await model.close(fork.handle).catch(() => {})
        }
      },
    }), 'workspace-docx-fanout.tool')
  }

  ctx.effect(() => () => {
    for (const activation of activations) void activation.dispose().catch(() => {})
    activations.clear()
  }, 'workspace-docx-fanout.dispose')
}

/** @param {unknown} value - model-supplied tasks. @returns {Array<{label: string, prompt: string}>} */
function normalizeTasks(value) {
  if (!Array.isArray(value) || value.length === 0) throw new Error('doc_fanout needs at least one task')
  if (value.length > MAX_TASKS) throw new Error(`doc_fanout accepts at most ${MAX_TASKS} tasks`)
  return value.map((task, index) => {
    if (!task || typeof task !== 'object') throw new Error(`task ${index} must be an object`)
    const label = typeof task.label === 'string' && task.label.trim() !== '' ? task.label.trim() : `task-${index + 1}`
    const prompt = typeof task.prompt === 'string' ? task.prompt.trim() : ''
    if (prompt === '') throw new Error(`task ${index} needs a prompt`)
    const kind = task.kind === 'review' ? 'review' : 'apply'
    const changes = Array.isArray(task.changes)
      ? task.changes.filter((change) => change && typeof change === 'object'
        && typeof change.id === 'string' && typeof change.blockId === 'string'
        && typeof change.expectedText === 'string' && typeof change.newText === 'string')
      : []
    const blockIds = Array.isArray(task.blockIds)
      ? task.blockIds.filter((id) => typeof id === 'string')
      : [...new Set(changes.map((change) => change.blockId))]
    return { label, prompt, kind, changes, blockIds }
  })
}

/** @param {unknown} value - requested concurrency. @returns {number} bounded concurrency. */
function clampConcurrency(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_CONCURRENCY
  return Math.min(Math.floor(parsed), MAX_TASKS)
}

/**
 * Build the start-request fields shared by every child: cwd, and the depth cap
 * only when the provider supports one.
 * @param {object} exec - tool execution facts.
 * @param {{ capabilities?: { depthLimit?: boolean } }} provider - selected provider.
 * @param {object} subagents - subagent service.
 * @returns {{ cwd?: string, maxDepth?: number }} request fields.
 */
function childRequestBase(exec, provider, subagents) {
  const base = {}
  const cwd = exec && exec.agent && exec.agent.session && exec.agent.session.header
    ? exec.agent.session.header.cwd
    : undefined
  if (typeof cwd === 'string' && cwd !== '') base.cwd = cwd
  const delegationDepth = exec && exec.agent && exec.agent.session && exec.agent.session.header
    ? exec.agent.session.header.delegationDepth
    : undefined
  if (provider.capabilities && provider.capabilities.depthLimit === true && Number.isInteger(delegationDepth)) {
    const resolved = typeof subagents.resolveMaxDepth === 'function'
      ? subagents.resolveMaxDepth()
      : undefined
    if (Number.isInteger(resolved)) {
      if (delegationDepth >= resolved) {
        throw Object.assign(new Error(`DOC_FANOUT_DEPTH: delegation depth ${delegationDepth} reached the limit ${resolved}`), { code: 'DOC_FANOUT_DEPTH' })
      }
      base.maxDepth = resolved
    }
  }
  return base
}

/**
 * The child prompt: which fork to edit, what to change, and the hard rules.
 * @param {{ handle: string, name: string }} fork - fork summary.
 * @param {{ label: string, prompt: string, kind: string, blockIds: string[], changes: object[] }} task - task facts.
 * @param {string} [constraints] - shared constraint text.
 * @returns {string} child prompt.
 */
function buildPrompt(fork, task, constraints) {
  const changes = task.changes.length > 0 ? `\nProposals (JSON): ${JSON.stringify(task.changes)}` : ''
  const chunk = task.blockIds.length > 0 ? `\nAllowed block ids: ${task.blockIds.join(', ')}` : ''
  const rules = typeof constraints === 'string' && constraints.trim() !== '' ? `\nConstraints: ${constraints.trim()}` : ''
  return `You are editing an isolated fork of the Word document "${fork.name}".\n`
    + `Fork handle: ${fork.handle}.\n`
    + 'Use doc_read, doc_search, doc_edit and doc_diff on the fork handle only. '
    + 'Do not call doc_open, doc_commit, doc_fanout or editor. Make one tracked edit per doc_edit call and keep block ids stable.\n'
    + `Task (${task.label}): ${task.prompt}${changes}${chunk}${rules}\n`
    + 'Reply with one short paragraph naming the block ids you changed.'
}

/** @param {unknown} output - SubagentResult.output content blocks. @returns {string} */
function outputText(output) {
  if (!Array.isArray(output)) return ''
  return output
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/**
 * Run `worker` over `items` with at most `limit` in flight, preserving order in
 * the item array; a rejected worker never rejects the pool.
 * @param {Array<object>} items - work items.
 * @param {number} limit - concurrency.
 * @param {(item: object) => Promise<void>} worker - per-item work.
 * @returns {Promise<void>} settles when every item settled.
 */
async function pool(items, limit, worker) {
  let cursor = 0
  const runners = []
  const next = async () => {
    while (cursor < items.length) {
      const item = items[cursor]
      cursor += 1
      try {
        await worker(item)
      } catch (error) {
        // A worker failure is recorded on its item; it must not stop the pool.
      }
    }
  }
  for (let index = 0; index < Math.min(limit, items.length); index++) runners.push(next())
  await Promise.all(runners)
}
