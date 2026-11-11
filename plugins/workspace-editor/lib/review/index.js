/**
 * `workspace-legal-review` row: legal analyzers on `ctx.docxModel`, the
 * `doc_analyze` tool and the `legal-document-review` runtime skill.
 *
 * Analyzers are pure functions over described blocks (`lib/review/analyzers.js`)
 * and register through `ctx.docxModel.addAnalyzer`, so `doc_check` and
 * `doc_analyze` share one finding set. The skill is registered only when the
 * host has a skills service; the row itself still loads without one.
 */
import { ANALYZER_CODES, createLegalAnalyzers, LEGAL_ANALYZER_CODES } from './analyzers.js'

export const name = 'workspace-legal-review'
export const inject = ['docxModel', 'tools']

/** Stable review playbook the skill and the tool description share. */
const PLAYBOOK = `# Legal document review playbook

Use this playbook with a Word document (.docx) opened through doc_open.

1. Map the document: doc_state status, then doc_read with mode=outline for headings. Use mode=context or mode=range around the blocks you will edit.
2. Run doc_analyze to collect stable findings. Each finding has a code, a severity, a message and the affected block ids.
3. Investigate one finding at a time: doc_search or doc_read mode=context on its block ids. Do not assume text that is not in the document.
4. Fix one defect per doc_edit call. Target a block id, pass the replacement text, and let the expected-text check refuse a stale target (DOC_STALE_TARGET). Every edit is a tracked change with the agent author.
5. Review the working change set with doc_diff and doc_check, then commit once with doc_commit. A stale base (DOC_STALE_BASE) or an editor with unsaved work (DOC_EDITOR_DIRTY) writes nothing: reload or ask the editor to save, then retry.
6. Report the finding codes fixed, the findings left open and the block ids you changed. Cite document blocks by id; never invent authorities or quotation text.
`

/**
 * Register the analyzers, the tool and the skill.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the row's Cordis context.
 */
export function apply(ctx) {
  const model = ctx.docxModel
  const analyzers = createLegalAnalyzers()

  for (const analyzer of analyzers) {
    ctx.effect(() => model.addAnalyzer(analyzer), 'workspace-legal-review.analyzer')
  }

  ctx.effect(() => ctx.tools.register({
    name: 'doc_analyze',
    description: 'Analyze the open document for legal defects and return stable finding codes with block ids: '
      + 'heading outline and level skips, table-of-contents mismatches, list level jumps, defined-term order, '
      + 'undefined abbreviations, internal cross-reference targets, citation shapes, placeholder text, '
      + 'empty-paragraph runs and missing table headers. Fix findings with doc_edit, then doc_diff/doc_check/doc_commit.',
    parameters: {
      type: 'object',
      properties: {
        doc: { type: 'string', description: 'Session handle from doc_open.' },
        checks: {
          type: 'array',
          items: { type: 'string', enum: LEGAL_ANALYZER_CODES },
          description: 'Limit the run to these finding codes; omitted runs every analyzer.',
        },
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
                blocks: { type: 'array', items: { type: 'string' } },
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
          ? 'no legal findings'
          : `${value.findings.length} legal finding(s):\n`
            + value.findings.map((finding) => `${finding.severity.toUpperCase()} ${finding.code}: ${finding.message}${Array.isArray(finding.blocks) && finding.blocks.length > 0 ? ` [${finding.blocks.join(', ')}]` : ''}`).join('\n'),
      }],
    },
    async execute(args) {
      const checked = await model.check(args.doc, { checks: args.checks })
      const findings = checked.findings
        .filter((finding) => finding.code !== 'PENDING_REVISIONS')
        .map((finding) => ({
          code: String(finding.code),
          severity: String(finding.severity ?? 'info'),
          message: String(finding.message ?? ''),
          ...(Array.isArray(finding.blocks) ? { blocks: finding.blocks.filter((block) => typeof block === 'string') } : {}),
        }))
      return {
        doc: checked.handle,
        ok: findings.length === 0,
        codes: [...new Set(findings.map((finding) => finding.code))],
        findings,
      }
    },
  }), 'workspace-legal-review.tool')

  // The skills service is optional: a headless composition may not mount it.
  ctx.inject(['skills'], (scoped) => {
    scoped.effect(() => scoped.skills.register({
      name: 'legal-document-review',
      description: 'Analyze and edit a legal Word document (.docx) safely: read modes, stable finding codes, one tracked edit per call, lease-checked commit.',
      content: PLAYBOOK,
      source: 'runtime',
      invocation: { modelInvocable: true, userInvocable: true },
      provider: 'workspace-legal-review',
      metadata: { codes: LEGAL_ANALYZER_CODES },
    }), 'workspace-legal-review.skill')
  })

  // Exposed for the row README and tests: the stable code set this row can emit.
}

export { ANALYZER_CODES }
