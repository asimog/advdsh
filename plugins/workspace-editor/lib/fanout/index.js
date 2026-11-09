/**
 * `workspace-docx-fanout` row: parallel editing over isolated forks.
 *
 * Placeholder row. It registers no `doc_fanout` tool and starts no subagent yet,
 * so the bundle patch can insert it and the module can load before the
 * implementation lands. The contract it will fill is described under "Parallel
 * editing" in `.agents/docs/legal-docx-workspace.md`.
 */

export const name = 'workspace-docx-fanout'

/** No contribution yet: this row only proves the module resolves in the bundle patch. */
export function apply() {}
