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
export const name = 'workspace-docx-tools'
export const inject = ['tools', 'docxModel', 'editorDocuments', 'systemPrompt']

/** Runtime-context order used by the design for `document-model:open`. */
const CONTEXT_ORDER = 130

/**
 * Register every tool, the runtime context and the lifecycle hooks.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the row's Cordis context.
 */
export function apply(ctx) {
  const model = ctx.docxModel
  const documents = ctx.editorDocuments
  const writeEnabled = process.env.WORKSPACE_DOCX_WRITE !== 'off'

  /**
   * Register one tool as an effect.
   * @param {object} definition - raw ToolDefinition.
   */
  const tool = (definition) => ctx.effect(() => ctx.tools.register(definition), `workspace-docx-tools.${definition.name}`)

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
          revision: { type: 'number' },
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
        required: ['handle', 'path', 'name', 'contentHash', 'revision', 'baseRevision', 'readMode', 'blocks', 'paragraphs', 'tables', 'tokens', 'outline'],
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: `opened ${value.name} (${value.blocks} blocks, ${value.paragraphs} paragraphs, read=${value.readMode})\n`
          + `doc=${value.handle} path=${value.path} revision=${value.revision} base=${value.baseRevision.slice(0, 12)}`,
      }],
    },
    async execute(args, exec) {
      const opened = await model.open(args.path, { author: authorOf(exec) })
      return opened
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
        mode: { type: 'string', enum: ['auto', 'full', 'outline', 'range', 'search', 'context'], description: 'Read mode; defaults to auto.' },
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
          revision: { type: 'number' },
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
                before: { type: 'string' },
                after: { type: 'string' },
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
        required: ['doc', 'path', 'changed', 'revision', 'baseRevision', 'changes', 'counts'],
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
        revision: diff.revision,
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
            revision: { type: 'string' },
            previousRevision: { type: 'string' },
            size: { type: 'number' },
            sha256: { type: 'string' },
          },
          required: ['doc', 'path', 'applied', 'changed', 'revision'],
          additionalProperties: false,
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.applied
            ? `committed ${value.path} ${value.size} bytes revision ${String(value.revision).slice(0, 12)}`
            : `no pending edits in ${value.path}`,
        }],
        presentationMeta: (_args, value) => ({ path: value.path, applied: value.applied, revision: value.revision, size: value.size }),
      },
      presentResult: (_args, result) => {
        const meta = result?.meta ?? {}
        return {
          card: 'generic',
          title: meta.applied ? `Committed ${meta.path ?? 'document'}` : 'No pending edits',
          content: meta.applied ? `revision ${String(meta.revision ?? '').slice(0, 12)}${Number.isFinite(meta.size) ? ` · ${meta.size} bytes` : ''}` : undefined,
        }
      },
      async execute(args) {
        const committed = await model.commit(args.doc, { force: args.force === true })
        return {
          doc: args.doc,
          path: committed.path,
          applied: committed.applied === true,
          changed: committed.changed === true,
          revision: String(committed.revision ?? ''),
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
            enum: ['replace_paragraph', 'insert_paragraph', 'delete_paragraph', 'insert_list_item', 'insert_table_row', 'delete_table_row'],
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
          rowIndex: { type: 'number', description: 'Row to delete for delete_table_row; defaults to the last.' },
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
            revision: { type: 'number' },
            op: { type: 'string' },
            tracked: { type: 'boolean' },
            changed: { type: 'number' },
            affected: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  index: { type: 'number' },
                  kind: { type: 'string' },
                  textBefore: { type: 'string' },
                  textAfter: { type: 'string' },
                },
                required: ['id', 'index', 'kind'],
                additionalProperties: true,
              },
            },
          },
          required: ['doc', 'path', 'revision', 'op', 'tracked', 'changed', 'affected'],
          additionalProperties: false,
        },
        render: (_args, value) => [{
          type: 'text',
          text: `${value.op} applied as revision ${value.revision} (tracked=${value.tracked}, ${value.changed} block(s) changed)\n`
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
        }
        const edited = await model.edit(args.doc, op, { signal: exec && exec.signal })
        const session = model.status().find((row) => row.handle === args.doc)
        return {
          doc: args.doc,
          path: session ? session.path : '',
          revision: edited.revision,
          op: edited.op,
          tracked: edited.tracked === true,
          changed: edited.changed,
          affected: edited.affected,
        }
      },
    })
  }

  // --- doc_state -------------------------------------------------------------
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
                revision: { type: 'number' },
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
    async execute(args) {
      if (args.action === 'status') {
        return { action: 'status', sessions: model.status() }
      }
      if (args.action === 'revisions') {
        return { action: 'revisions', doc: args.doc, revisions: await model.revisions(args.doc) }
      }
      if (args.action === 'reload') {
        const reloaded = await model.reload(args.doc)
        return { action: 'reload', doc: args.doc, reloaded: true, baseRevision: reloaded.baseRevision }
      }
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
      + 'review (send accept_all, reject_all, next_change, previous_change or markup/display modes).',
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
          ? `${(value.documents ?? []).length} open editor document(s); engine ${value.engine?.running ? 'running' : 'stopped'}${value.engine?.ready ? ' (ready)' : ''}`
          : value.action === 'export_pdf'
            ? `exported PDF ${value.pdf ?? ''}`
            : value.action === 'wait'
              ? `wait: ${value.changed ? 'revision changed' : 'timed out'} at ${value.revision ?? ''}`
              : `${value.action} ok (${value.command ?? value.path ?? value.doc ?? ''})`,
      }],
    },
    async execute(args) {
      if (args.action === 'status') {
        return { action: 'status', documents: documents.list(), engine: engineStatus(ctx) }
      }
      if (args.action === 'open') {
        return { action: 'open', document: await documents.open(args.path) }
      }
      if (args.action === 'wait') {
        const waited = await documents.wait(args.path, { since: args.since, timeoutMs: args.timeoutMs })
        return { action: 'wait', ...waited }
      }
      if (args.action === 'export_pdf') {
        const pdf = await documents.exportPdf(args.doc)
        return { action: 'export_pdf', pdf: pdf.path }
      }
      if (args.action === 'save') {
        const document = documents.list().find((entry) => entry.id === args.doc || entry.path === args.path)
        return { action: 'save', command: 'save', delivered: documents.command({ id: document ? document.id : undefined, path: args.path, command: 'save' }).delivered }
      }
      if (args.action === 'reload') {
        return { action: 'reload', command: 'reload', delivered: documents.command({ id: args.doc, path: args.path, command: 'reload' }).delivered }
      }
      if (args.action === 'review') {
        if (typeof args.command !== 'string' || args.command === '') {
          throw new Error('review needs a command (accept_all, reject_all, next_change, previous_change, markup, display_mode)')
        }
        return { action: 'review', command: args.command, delivered: documents.command({ id: args.doc, path: args.path, command: args.command, args: args.args }).delivered }
      }
      throw new Error(`unknown editor action: ${String(args.action)}`)
    },
  })

  // --- runtime context ------------------------------------------------------
  ctx.systemPrompt.context({
    name: 'document-model:open',
    order: CONTEXT_ORDER,
    interpolate: false,
    text: (context) => {
      try {
        const lines = model.statusLines(cwdOf(context))
        return lines.length === 0 ? '' : `Open agent documents (handle path rev base blocks read editor pending):\n${lines.join('\n')}`
      } catch (error) {
        return ''
      }
    },
  })

  // --- lifecycle ------------------------------------------------------------
  ctx.effect(() => () => model.dispose(), 'workspace-docx-tools.dispose')
}

/** @param {object} ctx - row context; the engine is optional outside the bundle. */
function engineStatus(ctx) {
  try {
    const engine = ctx.docxEngine
    return engine && typeof engine.status === 'function' ? engine.status() : { running: false, ready: false }
  } catch (error) {
    return { running: false, ready: false }
  }
}

/** @param {unknown} text - block text. @param {number} limit - cap. @returns {string} */
function clip(text, limit) {
  const value = typeof text === 'string' ? text : ''
  return value.length <= limit ? value : `${value.slice(0, limit)}…`
}
