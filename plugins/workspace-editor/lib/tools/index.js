/**
 * `workspace-docx-tools` row: the agent-facing `doc_*` tools, the
 * `document-model:open` runtime context and the read/write env gate.
 *
 * Tools are raw ToolDefinitions (this bundle has no `@deepseek-ai/dsh-tools`
 * dependency): canonical `output.schema` plus `render`, optional replayable
 * `presentCall`/`presentResult` cards for the document tools. Every registration
 * is a `ctx.effect`, so unloading the row removes the tools and the context.
 *
 * Write tools are only registered when `WORKSPACE_DOCX_WRITE` is not `off`; the
 * model also enforces the gate, so a gated write fails with `DOC_WRITE_DISABLED`
 * instead of disappearing from one surface only.
 */
import path from 'node:path'
import { ERROR_CODES, WorkspaceError, formatToolError } from '../errors.js'
import { createRoleRegistry } from '../roles.js'

export const name = 'workspace-docx-tools'
export const inject = ['tools', 'docxModel', 'editorDocuments', 'systemPrompt']

/** Runtime-context order used by the design for `document-model:open`. */
const CONTEXT_ORDER = 130

/** Review commands that change tracked text and therefore need the write gate. */
const WRITE_REVIEW_COMMANDS = new Set(['acceptAll', 'rejectAll', 'acceptSelection', 'rejectSelection'])
const REVIEW_COMMANDS = new Set([...WRITE_REVIEW_COMMANDS, 'nextChange', 'prevChange', 'displayMode', 'trackChanges'])

/**
 * Register every tool, the runtime context and the lifecycle hooks.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the row's Cordis context.
 */
export function apply(ctx) {
  const roles = createRoleRegistry()
  ctx.effect(() => {
    ctx.provide('docxRoles', roles)
    return () => roles.clear()
  }, 'workspace-docx-tools.roles')
  const model = ctx.docxModel
  const documents = ctx.editorDocuments
  const writeEnabled = process.env.WORKSPACE_DOCX_WRITE !== 'off'

  /** Refuse an edit or markup read by a caller that is not an applier child. */
  const requireApplier = (exec, args, markupOnly = false) => {
    if (!roles.isEnforced()) return
    const caller = sessionIdOf(exec)
    if (!roles.isApplier(caller)) {
      throw new WorkspaceError(ERROR_CODES.APPLIER_ONLY, 'only an applier child may use this operation')
    }
    if (markupOnly) return
    const chunk = roles.chunk(caller)
    const target = args.blockId ?? args.tableBlockId
    if (chunk !== undefined && typeof target === 'string' && !chunk.has(target)) {
      throw new WorkspaceError(ERROR_CODES.OUTSIDE_CHUNK, `block ${target} is outside the task chunk`)
    }
  }

  /**
   * Register one tool as an effect. The wrapper gives every rejection the
   * specification form `Error: <CODE>: <message>` while preserving `code`.
   * @param {object} definition - raw ToolDefinition.
   */
  const tool = (definition) => ctx.effect(() => ctx.tools.register({
    ...definition,
    execute: async (args, exec) => {
      try {
        if (definition.name === 'doc_edit') requireApplier(exec, args)
        if (definition.name === 'doc_read' && args.mode === 'markup') requireApplier(exec, args, true)
        if (definition.name.startsWith('doc_') && definition.name !== 'doc_open' && typeof args.doc === 'string') {
          const contract = model.contract(args.doc)
          const caller = sessionIdOf(exec)
          if (caller !== undefined && contract.ownerSessionId !== '' && contract.ownerSessionId !== caller) {
            throw new WorkspaceError(ERROR_CODES.SESSION_NOT_FOUND, 'the document handle belongs to another session')
          }
        }
        return await definition.execute(args, exec)
      } catch (error) {
        throw formatToolError(error)
      }
    },
  }), `workspace-docx-tools.${definition.name}`)

  /** The tracked-change author for this agent session. @param {object} exec - tool execution facts. */
  const authorOf = (exec) => {
    try {
      const sessionId = exec && exec.agent && exec.agent.session && exec.agent.session.header
        ? exec.agent.session.header.id
        : undefined
      return typeof sessionId === 'string' && sessionId !== '' ? `agent:${sessionId}` : undefined
    } catch (error) {
      return undefined
    }
  }

  /** The agent's working directory, used to scope the runtime context. @param {object} context - assembly context. */
  const cwdOf = (context) => {
    try {
      const cwd = context && context.agent && context.agent.session && context.agent.session.header
        ? context.agent.session.header.cwd
        : undefined
      return typeof cwd === 'string' ? cwd : undefined
    } catch (error) {
      return undefined
    }
  }

  /** The DSH session ID of the calling agent. @param {object} exec - tool execution facts. */
  const sessionIdOf = (exec) => {
    try {
      const id = exec && exec.agent && exec.agent.session && exec.agent.session.header
        ? exec.agent.session.header.id
        : undefined
      return typeof id === 'string' && id !== '' ? id : undefined
    } catch (error) {
      return undefined
    }
  }

  /** Configured allowed roots for path confinement. @returns {string[]} roots. */
  const rootsOf = () => (process.env.WORKSPACE_DOCX_ALLOWED_ROOTS ?? '').split(path.delimiter).filter(Boolean)

  // --- doc_open --------------------------------------------------------------
  tool({
    name: 'doc_open',
    description: 'Open a Word document (.docx) for reasoning and editing. Returns a session handle, '
      + 'the content hash, revision and read mode, plus the outline and token count. '
      + 'Call this before doc_read/doc_edit/doc_diff/doc_commit. A large document is returned in outline mode.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the .docx file.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          handle: { type: 'string' },
          path: { type: 'string' },
          name: { type: 'string' },
          contentHash: { type: 'string' },
          pendingOps: { type: 'number' },
          baseRevision: { type: 'string' },
          readMode: { type: 'string' },
          blocks: { type: 'number' },
          paragraphs: { type: 'number' },
          tables: { type: 'number' },
          tokens: { type: 'number' },
          outline: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                index: { type: 'number' },
                level: { type: 'number' },
                text: { type: 'string' },
              },
              required: ['id', 'index', 'level', 'text'],
              additionalProperties: false,
            },
          },
        },
        required: ['handle', 'path', 'name', 'contentHash', 'pendingOps', 'baseRevision', 'readMode', 'blocks', 'paragraphs', 'tables', 'tokens', 'outline'],
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: `opened ${value.name} (${value.blocks} blocks, ${value.paragraphs} paragraphs, read=${value.readMode})\n`
          + `doc=${value.handle} path=${value.path} pending=${value.pendingOps} base=${value.baseRevision.slice(0, 12)}`,
      }],
    },
    async execute(args, exec) {
      const opened = await model.open(args.path, {
        author: authorOf(exec),
        sessionId: sessionIdOf(exec),
        cwd: cwdOf(exec),
        roots: rootsOf(),
      })
      return {
        handle: opened.handle,
        path: opened.path,
        name: opened.name,
        contentHash: opened.contentHash,
        pendingOps: 0,
        baseRevision: opened.baseRevision,
        readMode: opened.readMode,
        blocks: opened.blocks,
        paragraphs: opened.paragraphs,
        tables: opened.tables,
        tokens: opened.tokens,
        outline: opened.outline,
      }
    },
  })

  // --- doc_read --------------------------------------------------------------
  tool({
    name: 'doc_read',
    description: 'Read a document session in one mode. `auto` uses the full text for small documents and the '
      + 'outline for large ones; `full` fails with DOC_TOO_LARGE above the token budget; `range` takes from/to or ids; '
      + '`search` takes a query; `context` takes blockId or index plus before/after. '
      + 'Blocks are annotated as `[blockId] text`.',
    parameters: {
      type: 'object',
      properties: {
        doc: { type: 'string', description: 'Session handle from doc_open.' },
        mode: { type: 'string', enum: ['auto', 'full', 'outline', 'range', 'search', 'context', 'markup'], description: 'Read mode; defaults to auto.' },
        from: { type: 'number', description: 'First block index for range.' },
        to: { type: 'number', description: 'Last block index for range.' },
        ids: { type: 'array', items: { type: 'string' }, description: 'Block ids for range.' },
        query: { type: 'string', description: 'Text to find for search.' },
        limit: { type: 'number', description: 'Maximum matches for search.' },
        caseSensitive: { type: 'boolean', description: 'Case-sensitive search.' },
        blockId: { type: 'string', description: 'Focus block for context.' },
        index: { type: 'number', description: 'Focus block index for context.' },
        before: { type: 'number', description: 'Blocks before the focus for context.' },
        after: { type: 'number', description: 'Blocks after the focus for context.' },
        limitNodes: { type: 'number', description: 'Maximum markup nodes.' },
        limitTokens: { type: 'number', description: 'Maximum markup tokens.' },
      },
      required: ['doc'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          doc: { type: 'string' },
          path: { type: 'string' },
          revision: { type: 'number' },
          contentHash: { type: 'string' },
          mode: { type: 'string' },
          totalBlocks: { type: 'number' },
          tokens: { type: 'number' },
          text: { type: 'string' },
          truncated: { type: 'boolean' },
          blocks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                index: { type: 'number' },
                kind: { type: 'string' },
                text: { type: 'string' },
                style: { type: 'string' },
                level: { type: 'number' },
                rows: { type: 'number' },
              },
              required: ['id', 'index', 'kind', 'text'],
              additionalProperties: true,
            },
          },
          matches: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                index: { type: 'number' },
                kind: { type: 'string' },
                snippet: { type: 'string' },
              },
              required: ['id', 'index', 'kind', 'snippet'],
              additionalProperties: false,
            },
          },
          nodes: { type: 'array', items: { type: 'object', additionalProperties: true } },
          next: { oneOf: [{ type: 'number' }, { type: 'null' }] },
          outline: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                index: { type: 'number' },
                level: { type: 'number' },
                text: { type: 'string' },
              },
              required: ['id', 'index', 'level', 'text'],
              additionalProperties: false,
            },
          },
        },
        required: ['doc', 'path', 'revision', 'contentHash', 'mode', 'totalBlocks', 'tokens', 'text', 'truncated', 'blocks', 'matches', 'outline'],
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.text === '' ? `no content (mode=${value.mode}, ${value.totalBlocks} blocks)` : value.text,
      }],
    },
    async execute(args) {
      const read = await model.read(args.doc, {
        mode: args.mode,
        from: args.from,
        to: args.to,
        ids: args.ids,
        query: args.query,
        limit: args.limit,
        caseSensitive: args.caseSensitive,
        blockId: args.blockId,
        index: args.index,
        before: args.before,
        after: args.after,
        limitNodes: args.limitNodes,
        limitTokens: args.limitTokens,
      })
      return {
        doc: read.handle,
        path: read.path,
        revision: read.revision,
        contentHash: read.contentHash,
        mode: read.mode,
        totalBlocks: read.totalBlocks,
        tokens: read.tokens,
        text: typeof read.text === 'string' ? read.text : '',
        truncated: read.truncated === true,
        blocks: read.blocks ?? [],
        matches: read.matches ?? [],
        outline: read.outline ?? [],
        nodes: read.nodes ?? [],
        next: read.next ?? null,
      }
    },
  })

  // --- doc_search ------------------------------------------------------------
  tool({
    name: 'doc_search',
    description: 'Search the open document for a phrase and return matching block ids, indexes and snippets. '
      + 'Use the ids with doc_read context or doc_edit.',
    parameters: {
      type: 'object',
      properties: {
        doc: { type: 'string', description: 'Session handle from doc_open.' },
        query: { type: 'string', description: 'Phrase to find.' },
        limit: { type: 'number', description: 'Maximum matches; defaults to 40.' },
        caseSensitive: { type: 'boolean', description: 'Case-sensitive search.' },
      },
      required: ['doc', 'query'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          doc: { type: 'string' },
          path: { type: 'string' },
          query: { type: 'string' },
          truncated: { type: 'boolean' },
          matches: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                index: { type: 'number' },
                kind: { type: 'string' },
                snippet: { type: 'string' },
              },
              required: ['id', 'index', 'kind', 'snippet'],
              additionalProperties: false,
            },
          },
        },
        required: ['doc', 'path', 'query', 'truncated', 'matches'],
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.matches.length === 0
          ? `no matches for ${JSON.stringify(value.query)}`
          : value.matches.map((match) => `[${match.id}] ${match.snippet}`).join('\n'),
      }],
    },
    async execute(args) {
      const read = await model.read(args.doc, {
        mode: 'search',
        query: args.query,
        limit: args.limit,
        caseSensitive: args.caseSensitive,
      })
      return {
        doc: read.handle,
        path: read.path,
        query: args.query,
        truncated: read.truncated === true,
        matches: read.matches ?? [],
      }
    },
  })

  // --- doc_diff --------------------------------------------------------------
  tool({
    name: 'doc_diff',
    description: 'Show the working document against the revision it was opened or last committed at: '
      + 'added, removed and changed blocks with their ids.',
    parameters: {
      type: 'object',
      properties: {
        doc: { type: 'string', description: 'Session handle from doc_open.' },
      },
      required: ['doc'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          doc: { type: 'string' },
          path: { type: 'string' },
          changed: { type: 'boolean' },
          pendingOps: { type: 'number' },
          blocksChanged: { type: 'number' },
          blocksTotal: { type: 'number' },
          baseRevision: { type: 'string' },
          changes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string' },
                id: { type: 'string' },
                index: { type: 'number' },
                kind: { type: 'string' },
                before: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                after: { oneOf: [{ type: 'string' }, { type: 'null' }] },
              },
              required: ['type', 'id', 'index', 'kind'],
              additionalProperties: true,
            },
          },
          counts: {
            type: 'object',
            properties: {
              added: { type: 'number' },
              removed: { type: 'number' },
              changed: { type: 'number' },
              total: { type: 'number' },
            },
            required: ['added', 'removed', 'changed', 'total'],
            additionalProperties: false,
          },
        },
        required: ['doc', 'path', 'changed', 'pendingOps', 'blocksChanged', 'blocksTotal', 'baseRevision', 'changes', 'counts'],
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.changed
          ? `${value.counts.total} change(s): +${value.counts.added} -${value.counts.removed} ~${value.counts.changed}\n`
            + value.changes.map((change) => `${change.type} [${change.id}] ${change.before === null ? '' : `- ${clip(change.before, 120)} `}${change.after === null ? '' : `+ ${clip(change.after, 120)}`}`).join('\n')
          : 'no uncommitted changes',
      }],
      presentationMeta: (_args, value) => ({ path: value.path, changes: value.changes }),
    },
    presentResult: (_args, result) => {
      const meta = result?.meta ?? {}
      const oldText = (meta.changes ?? []).map((change) => change.before ?? '').join('\n')
      const newText = (meta.changes ?? []).map((change) => change.after ?? '').join('\n')
      return { card: 'diff', title: `Changes in ${meta.path ?? 'document'}`, diffs: [{ path: meta.path, oldText, newText }] }
    },
    async execute(args) {
      const diff = await model.diff(args.doc)
      return {
        doc: diff.handle,
        path: diff.path,
        changed: diff.changed,
        pendingOps: diff.pendingOps,
        blocksChanged: diff.blocksChanged,
        blocksTotal: diff.blocksTotal,
        baseRevision: diff.baseRevision,
        changes: diff.changes,
        counts: diff.counts,
      }
    },
  })

  // --- doc_check -------------------------------------------------------------
  tool({
    name: 'doc_check',
    description: 'Check the working document: uncommitted changes plus any registered document analyzers. '
      + 'Returns stable finding codes, severities and affected block ids. Run it before doc_commit.',
    parameters: {
      type: 'object',
      properties: {
        doc: { type: 'string', description: 'Session handle from doc_open.' },
        checks: { type: 'array', items: { type: 'string' }, description: 'Analyzer codes to run; omitted runs all.' },
      },
      required: ['doc'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          doc: { type: 'string' },
          ok: { type: 'boolean' },
          codes: { type: 'array', items: { type: 'string' } },
          findings: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                code: { type: 'string' },
                severity: { type: 'string' },
                message: { type: 'string' },
              },
              required: ['code', 'severity', 'message'],
              additionalProperties: true,
            },
          },
        },
        required: ['doc', 'ok', 'codes', 'findings'],
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.findings.length === 0
          ? 'no findings'
          : value.findings.map((finding) => `${finding.severity.toUpperCase()} ${finding.code}: ${finding.message}`).join('\n'),
      }],
    },
    async execute(args) {
      const checked = await model.check(args.doc, { checks: args.checks })
      return {
        doc: checked.handle,
        ok: checked.ok,
        codes: checked.codes,
        findings: checked.findings.map((finding) => ({
          code: String(finding.code),
          severity: String(finding.severity ?? 'info'),
          message: String(finding.message ?? ''),
          ...(Array.isArray(finding.blocks) ? { blocks: finding.blocks.filter((block) => typeof block === 'string') } : {}),
        })),
      }
    },
  })

  // --- doc_commit ------------------------------------------------------------
  if (writeEnabled) {
    tool({
      name: 'doc_commit',
      description: 'Serialize the working document and write it through the shared document store. '
        + 'The write carries the base revision and the lease: a stale base or an editor with unsaved changes is refused '
        + 'with DOC_STALE_BASE / DOC_EDITOR_DIRTY and nothing is written. Run doc_diff/doc_check first.',
      parameters: {
        type: 'object',
        properties: {
          doc: { type: 'string', description: 'Session handle from doc_open.' },
          force: { type: 'boolean', description: 'Write even when there are no pending edits.' },
        },
        required: ['doc'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            doc: { type: 'string' },
            path: { type: 'string' },
            applied: { type: 'boolean' },
            changed: { type: 'boolean' },
            storeRevision: { type: 'string' },
            previousRevision: { type: 'string' },
            size: { type: 'number' },
            sha256: { type: 'string' },
          },
          required: ['doc', 'path', 'applied', 'changed', 'storeRevision'],
          additionalProperties: false,
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.applied
            ? `committed ${value.path} ${value.size} bytes storeRevision ${String(value.storeRevision).slice(0, 12)}`
            : `no pending edits in ${value.path}`,
        }],
        presentationMeta: (_args, value) => ({ path: value.path, applied: value.applied, storeRevision: value.storeRevision, size: value.size }),
      },
      presentResult: (_args, result) => {
        const meta = result?.meta ?? {}
        return {
          card: 'generic',
          title: meta.applied ? `Committed ${meta.path ?? 'document'}` : 'No pending edits',
          content: meta.applied ? `revision ${String(meta.revision ?? '').slice(0, 12)}${Number.isFinite(meta.size) ? ` Â· ${meta.size} bytes` : ''}` : undefined,
        }
      },
      async execute(args) {
        const committed = await model.commit(args.doc, { force: args.force === true })
        return {
          doc: args.doc,
          path: committed.path,
          applied: committed.applied === true,
          changed: committed.changed === true,
          storeRevision: String(committed.revision ?? ''),
          ...(typeof committed.previousRevision === 'string' ? { previousRevision: committed.previousRevision } : {}),
          ...(Number.isFinite(committed.size) ? { size: committed.size } : {}),
          ...(typeof committed.sha256 === 'string' ? { sha256: committed.sha256 } : {}),
        }
      },
    })

    // --- doc_edit ------------------------------------------------------------
    tool({
      name: 'doc_edit',
      description: 'Apply one atomic, tracked edit to the working document. Supported ops: replace_paragraph, '
        + 'insert_paragraph, delete_paragraph, insert_list_item, insert_table_row, delete_table_row. '
        + 'Target a block by blockId (preferred) or index; the edit carries the expected text and fails with '
        + 'DOC_STALE_TARGET when the block changed. One op per call; call doc_diff and doc_check before doc_commit.',
      parameters: {
        type: 'object',
        properties: {
          doc: { type: 'string', description: 'Session handle from doc_open.' },
          type: {
            type: 'string',
            enum: ['replace_paragraph', 'insert_paragraph', 'delete_paragraph', 'insert_list_item', 'insert_table_row', 'delete_table_row', 'set_run_props', 'set_run_text', 'split_run', 'merge_runs', 'set_paragraph_props', 'set_cell_text', 'insert_table_column', 'delete_table_column', 'set_section_props', 'replace_text'],
            description: 'Operation type.',
          },
          blockId: { type: 'string', description: 'Target block id.' },
          index: { type: 'number', description: 'Target block index (insertion point for insert ops).' },
          text: { type: 'string', description: 'New paragraph/list text.' },
          expectedText: { type: 'string', description: 'Text the target must still have; usually omitted.' },
          numbering: { type: 'string', description: 'List numbering kind for insert_list_item.' },
          level: { type: 'number', description: 'List level for insert_list_item.' },
          tableBlockId: { type: 'string', description: 'Table block id for insert_table_row.' },
          tableIndex: { type: 'number', description: 'Table block index for insert_table_row.' },
          cells: { type: 'array', items: { type: 'string' }, description: 'Cell texts for insert_table_row.' },
          create: { type: 'boolean', description: 'Create a table when none exists for insert_table_row.' },
          rowIndex: { type: 'number', description: 'Row index for table row/cell operations.' },
          columnIndex: { type: 'number', description: 'Column index for table cell/column operations.' },
          runIndex: { type: 'number', description: 'Run index for run operations.' },
          offset: { type: 'number', description: 'Split offset for split_run.' },
          props: { type: 'object', additionalProperties: true, description: 'Formatting properties.' },
          find: { type: 'string', description: 'Text to replace for replace_text.' },
          replace: { type: 'string', description: 'Replacement text for replace_text.' },
          style: { type: 'string', description: 'Paragraph style for insert_paragraph.' },
          sectionIndex: { type: 'number', description: 'Section index for set_section_props.' },
        },
        required: ['doc', 'type'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            doc: { type: 'string' },
            path: { type: 'string' },
            pendingOps: { type: 'number' },
            op: { type: 'string' },
            tracked: { type: 'boolean' },
            changed: { type: 'number' },
            blocksChanged: { type: 'number' },
            blocksTotal: { type: 'number' },
            affected: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  index: { type: 'number' },
                  kind: { type: 'string' },
                  textBefore: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                  textAfter: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                },
                required: ['id', 'index', 'kind'],
                additionalProperties: true,
              },
            },
          },
          required: ['doc', 'path', 'pendingOps', 'op', 'tracked', 'changed', 'blocksChanged', 'blocksTotal', 'affected'],
          additionalProperties: false,
        },
        render: (_args, value) => [{
          type: 'text',
          text: `${value.op} applied (pending ${value.pendingOps}; tracked=${value.tracked}, ${value.changed} block(s) changed)\n`
            + value.affected.map((entry) => `[${entry.id}] ${entry.textBefore === undefined ? '' : `- ${clip(entry.textBefore, 120)} `}${entry.textAfter === undefined ? '' : `+ ${clip(entry.textAfter, 120)}`}`).join('\n'),
        }],
        presentationMeta: (_args, value) => ({ path: value.path, affected: value.affected }),
      },
      presentResult: (_args, result) => {
        const meta = result?.meta ?? {}
        const affected = Array.isArray(meta.affected) ? meta.affected : []
        return {
          card: 'diff',
          title: `Edited ${meta.path ?? 'document'}`,
          diffs: [{
            path: meta.path,
            oldText: affected.map((entry) => entry.textBefore ?? '').join('\n'),
            newText: affected.map((entry) => entry.textAfter ?? '').join('\n'),
          }],
        }
      },
      async execute(args, exec) {
        const op = {
          type: args.type,
          ...(args.blockId === undefined ? {} : { blockId: args.blockId }),
          ...(args.index === undefined ? {} : { index: args.index }),
          ...(args.text === undefined ? {} : { text: args.text }),
          ...(args.expectedText === undefined ? {} : { expectedText: args.expectedText }),
          ...(args.numbering === undefined ? {} : { numbering: args.numbering }),
          ...(args.level === undefined ? {} : { level: args.level }),
          ...(args.tableBlockId === undefined ? {} : { tableBlockId: args.tableBlockId }),
          ...(args.tableIndex === undefined ? {} : { tableIndex: args.tableIndex }),
          ...(args.cells === undefined ? {} : { cells: args.cells }),
          ...(args.create === undefined ? {} : { create: args.create }),
          ...(args.rowIndex === undefined ? {} : { rowIndex: args.rowIndex }),
          ...(args.columnIndex === undefined ? {} : { columnIndex: args.columnIndex }),
          ...(args.runIndex === undefined ? {} : { runIndex: args.runIndex }),
          ...(args.offset === undefined ? {} : { offset: args.offset }),
          ...(args.props === undefined ? {} : { props: args.props }),
          ...(args.find === undefined ? {} : { find: args.find }),
          ...(args.replace === undefined ? {} : { replace: args.replace }),
          ...(args.style === undefined ? {} : { style: args.style }),
          ...(args.sectionIndex === undefined ? {} : { sectionIndex: args.sectionIndex }),
        }
        const edited = await model.edit(args.doc, op, { signal: exec && exec.signal })
        const session = model.contract(args.doc)
        return {
          doc: args.doc,
          path: session ? session.path : '',
          pendingOps: model.contract(edited.handle).pendingOps,
          op: edited.op,
          tracked: edited.tracked === true,
          changed: edited.changed,
          blocksChanged: edited.blocksChanged,
          blocksTotal: edited.blocksTotal,
          affected: edited.affected,
        }
      },
    })

    // --- doc_undo -------------------------------------------------------------
    tool({
      name: 'doc_undo',
      description: 'Revert the last reversible edit in the working document. The inverse op is untracked; '
        + 'tracked revisions already serialized in the working copy are not removed.',
      parameters: {
        type: 'object',
        properties: { doc: { type: 'string', description: 'Session handle from doc_open.' } },
        required: ['doc'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            doc: { type: 'string' },
            undone: { type: 'string' },
            pendingOps: { type: 'number' },
            affected: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  index: { type: 'number' },
                  kind: { type: 'string' },
                  textBefore: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                  textAfter: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                },
                required: ['id', 'index', 'kind'],
                additionalProperties: true,
              },
            },
          },
          required: ['doc', 'undone', 'pendingOps', 'affected'],
          additionalProperties: false,
        },
        render: (_args, value) => [{
          type: 'text',
          text: `undid ${value.undone}; ${value.pendingOps} pending op(s) remain`,
        }],
      },
      async execute(args) {
        const undone = await model.undo(args.doc)
        return {
          doc: args.doc,
          undone: undone.undone,
          pendingOps: undone.remaining,
          affected: undone.affected,
        }
      },
    })
  }
  tool({
    name: 'doc_state',
    description: 'Inspect or manage open document sessions. Actions: status (sessions and lease facts), '
      + 'revisions (pending changes and commit history), reload (re-read the file after a human save or conflict), '
      + 'close (drop one session).',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'revisions', 'reload', 'close'], description: 'State action.' },
        doc: { type: 'string', description: 'Session handle; required for revisions/reload/close.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          action: { type: 'string' },
          sessions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                handle: { type: 'string' },
                path: { type: 'string' },
            pendingOps: { type: 'number' },
                baseRevision: { type: 'string' },
                readMode: { type: 'string' },
                stale: { type: 'boolean' },
                pendingOps: { type: 'number' },
                editorDirty: { type: 'boolean' },
              },
              required: ['handle', 'path', 'revision', 'baseRevision', 'readMode', 'stale', 'pendingOps', 'editorDirty'],
              additionalProperties: true,
            },
          },
          doc: { type: 'string' },
          closed: { type: 'boolean' },
          revisions: { type: 'object', additionalProperties: true },
          reloaded: { type: 'boolean' },
          baseRevision: { type: 'string' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.action === 'status'
          ? (value.sessions ?? []).length === 0
            ? 'no open documents'
            : value.sessions.map((row) => `${row.handle} ${row.path} rev=${row.revision} pending=${row.pendingOps} editor=${row.editorDirty ? 'dirty' : 'clean'}${row.stale ? ' STALE' : ''}`).join('\n')
          : value.action === 'revisions'
            ? `pending ${value.revisions?.pending?.ops ?? 0} op(s); ${(value.revisions?.commits ?? []).length} commit(s)`
            : value.action === 'reload'
              ? `reloaded ${value.doc ?? ''} at base ${String(value.baseRevision ?? '').slice(0, 12)}`
              : `closed ${value.doc ?? ''}`,
      }],
    },
    async execute(args, exec) {
      if (args.action === 'status') {
        return { action: 'status', sessions: model.status(undefined, sessionIdOf(exec)) }
      }
      if (args.action === 'revisions') {
        return { action: 'revisions', doc: args.doc, revisions: await model.revisions(args.doc) }
      }
      if (args.action === 'reload') {
        const reloaded = await model.reload(args.doc)
        return { action: 'reload', doc: args.doc, reloaded: true, baseRevision: reloaded.baseRevision }
      }
      model.contract(args.doc)
      const closed = await model.close(args.doc)
      return { action: 'close', doc: args.doc, closed: closed.closed === true }
    },
  })

  // --- editor ---------------------------------------------------------------
  tool({
    name: 'editor',
    description: 'Control the human editor session for a document without editing its text. Actions: status '
      + '(open editor documents and engine state), open (open a document in the right-dock editor), '
      + 'save (ask the editor to save its unsaved work), reload (ask the editor to reload from disk), '
      + 'export_pdf (convert the document to PDF), wait (wait for a file revision), '
      + 'review (send acceptAll, rejectAll, acceptSelection, rejectSelection, nextChange, prevChange, displayMode or trackChanges).',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'open', 'save', 'reload', 'export_pdf', 'wait', 'review'], description: 'Action.' },
        path: { type: 'string', description: 'Document path for open/wait.' },
        doc: { type: 'string', description: 'Document id for save/reload/export_pdf/review.' },
        command: { type: 'string', description: 'Review command for the review action.' },
        args: { type: 'object', additionalProperties: true, description: 'Review command arguments.' },
        since: { type: 'string', description: 'Baseline revision for wait.' },
        timeoutMs: { type: 'number', description: 'Timeout for wait, in milliseconds.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          action: { type: 'string' },
          documents: { type: 'array', items: { type: 'object', additionalProperties: true } },
          engine: { type: 'object', additionalProperties: true },
          document: { type: 'object', additionalProperties: true },
          delivered: { type: 'number' },
          executed: { type: 'boolean' },
          changeCount: { type: 'number' },
          userInstruction: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          command: { type: 'string' },
          path: { type: 'string' },
          revision: { type: 'string' },
          changed: { type: 'boolean' },
          timedOut: { type: 'boolean' },
          pdf: { type: 'string' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.action === 'status'
          ? `${(value.documents ?? []).length} open editor document(s); engine ${value.engine?.state ?? (value.engine?.ready ? 'ready' : 'not-started')}`
          : value.action === 'export_pdf'
            ? `exported PDF ${value.pdf ?? ''}`
            : value.action === 'wait'
              ? `wait: ${value.changed ? 'revision changed' : 'timed out'} at ${value.revision ?? ''}`
              : `${value.action} ok (${value.command ?? value.path ?? value.doc ?? ''})`,
      }],
    },
    async execute(args, exec) {
      const hasDoc = typeof args.doc === 'string' && args.doc !== ''
      const hasPath = typeof args.path === 'string' && args.path !== ''
      if (args.action === 'open' && !hasPath) {
        throw new WorkspaceError(ERROR_CODES.INVALID_ARGS, 'open needs a path')
      }
      if ((args.action === 'save' || args.action === 'reload' || args.action === 'review') && !hasDoc && !hasPath) {
        throw new WorkspaceError(ERROR_CODES.INVALID_ARGS, `${args.action} needs doc or path`)
      }
      if (args.action === 'status') {
        return { action: 'status', documents: documents.list(), engine: engineStatus(ctx) }
      }
      if (args.action === 'open') {
        const document = await documents.open(args.path, { cwd: cwdOf(exec), sessionId: sessionIdOf(exec) })
        if (typeof documents.requestOpen === 'function') documents.requestOpen(sessionIdOf(exec), document.path)
        return { action: 'open', document }
      }
      if (args.action === 'wait') {
        const waited = await documents.wait(args.path, { since: args.since, timeoutMs: args.timeoutMs })
        return { action: 'wait', ...waited }
      }
      if (args.action === 'export_pdf') {
        if (!hasDoc && !hasPath) throw new WorkspaceError(ERROR_CODES.INVALID_ARGS, 'export_pdf needs doc or path')
        const pdf = await documents.exportPdf(args.doc)
        return { action: 'export_pdf', pdf: pdf.path }
      }
      if (args.action === 'save') {
        if (!writeEnabled) throw new WorkspaceError(ERROR_CODES.WRITE_DISABLED, 'document writes are disabled (WORKSPACE_DOCX_WRITE=off)')
        const document = documents.list().find((entry) => entry.id === args.doc || entry.path === args.path)
        return { action: 'save', command: 'save', delivered: documents.command({ id: document ? document.id : undefined, path: args.path, command: 'save' }).delivered }
      }
      if (args.action === 'reload') {
        return { action: 'reload', command: 'reload', delivered: documents.command({ id: args.doc, path: args.path, command: 'reload' }).delivered }
      }
      if (args.action === 'review') {
        if (typeof args.command !== 'string' || !REVIEW_COMMANDS.has(args.command)) {
          throw new WorkspaceError(ERROR_CODES.INVALID_ARGS, `unknown review command ${String(args.command ?? '')}`.trim())
        }
        if (!writeEnabled && WRITE_REVIEW_COMMANDS.has(args.command)) {
          throw new WorkspaceError(ERROR_CODES.WRITE_DISABLED, 'document writes are disabled (WORKSPACE_DOCX_WRITE=off)')
        }
        if (WRITE_REVIEW_COMMANDS.has(args.command) && (typeof args.userInstruction !== 'string' || args.userInstruction.trim() === '')) {
          throw new WorkspaceError(ERROR_CODES.REVIEW_NOT_AUTHORIZED, 'a review command that changes the document needs userInstruction')
        }
        const sent = await documents.command({ id: args.doc, path: args.path, command: args.command, args: args.args, awaitAck: true })
        return {
          action: 'review',
          command: args.command,
          executed: sent.executed === true,
          changeCount: Number.isInteger(sent.changeCount) ? sent.changeCount : 0,
          userInstruction: args.userInstruction ?? null,
          delivered: sent.delivered,
        }
      }
      throw new WorkspaceError(ERROR_CODES.INVALID_ARGS, `unknown editor action: ${String(args.action)}`)
    },
  })

  // --- runtime context ------------------------------------------------------
  ctx.systemPrompt.context({
    name: 'document-model:open',
    order: CONTEXT_ORDER,
    interpolate: false,
    text: (context) => {
      try {
        const lines = model.statusLines(cwdOf(context), sessionIdOf(context))
        return lines.length === 0 ? '' : `Open agent documents (handle path rev base blocks read editor pending):\n${lines.join('\n')}`
      } catch (error) {
        return ''
      }
    },
  })

  // --- lifecycle ------------------------------------------------------------
}

/** @param {object} ctx - row context; the engine is optional outside the bundle. */
function engineStatus(ctx) {
  try {
    const engine = ctx.docxEngine
    const status = engine && typeof engine.status === 'function' ? engine.status() : { running: false, ready: false }
    const state = status.broken === true ? 'broken' : status.ready === true ? 'ready' : status.running === true ? 'restarting' : 'not-started'
    return { ...status, state }
  } catch (error) {
    return { running: false, ready: false, state: 'broken' }
  }
}

/** @param {unknown} text - block text. @param {number} limit - cap. @returns {string} */
function clip(text, limit) {
  const value = typeof text === 'string' ? text : ''
  return value.length <= limit ? value : `${value.slice(0, limit)}â€¦`
}


