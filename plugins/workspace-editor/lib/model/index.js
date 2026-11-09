/**
 * `workspace-docx-model` row: sessions, stable block IDs, forks, merge, lease and commit.
 *
 * Placeholder row. It registers no service, tool or listener yet, so the bundle
 * patch can insert it and the module can load before the implementation lands.
 * The service contract it will fill is `ctx.docxModel` in
 * `.agents/docs/legal-docx-workspace.md`.
 */

export const name = 'workspace-docx-model'

/** No contribution yet: this row only proves the module resolves in the bundle patch. */
export function apply() {}
