/**
 * `workspace-legal-review` row: legal analyzers, playbook and runtime skill.
 *
 * Placeholder row. It registers no `doc_analyze` tool and no skill yet, so the
 * bundle patch can insert it and the module can load before the implementation
 * lands. The contract it will fill is described under "Legal reasoning" in
 * `.agents/docs/legal-docx-workspace.md`.
 */

export const name = 'workspace-legal-review'

/** No contribution yet: this row only proves the module resolves in the bundle patch. */
export function apply() {}
