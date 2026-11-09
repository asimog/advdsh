/**
 * `workspace-docx-tools` row: agent `doc_*` tools, runtime context and session lifecycle.
 *
 * Placeholder row. It registers no tool, runtime context or listener yet, so the
 * bundle patch can insert it and the module can load before the implementation
 * lands. The tool surface it will fill is the `doc_*` table in
 * `.agents/docs/legal-docx-workspace.md`.
 */

export const name = 'workspace-docx-tools'

/** No contribution yet: this row only proves the module resolves in the bundle patch. */
export function apply() {}
