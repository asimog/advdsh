# EuroOffice / EuroOfficeLite hosting assessment

Status: current. Date: 2026-11-10.

## Question

Which official EuroOffice or EuroOfficeLite method should the DSH workspace editor vendor for (a) the human editor in the right dock and (b) the agent's deterministic document model? GenOffice, WordCraft and PDFCraft are excluded by the owner.

## Evidence

| Item | Evidence | Label |
|---|---|---|
| Existing plugin already hosts EuroOffice | `plugins/workspace-editor/lib/index.js` serves a release frontend from `resources/euro-office-de/editors` with `resources/euro-office` as fallback; x2t for DOCX↔Editor.bin and PDF; host page/shim | VERIFIED |
| Release editor performance | Stage 6 notes in `plugins/workspace-editor/README.md` and `spike/stage6/PERFORMANCE.md`: release frontend removes runtime LESS compile, ~1.9 s boot | VERIFIED |
| EuroOfficeLite architecture | Local checkout `resources/euro-office-lite-src`: `README.md` describes Tauri webview ↔ sdkjs/web-apps ↔ `bridge.js` ↔ Rust backend ↔ x2t; `src/bridge.js` (176 KB) implements `AscDesktopEditor`; `src/editor-patches.js`, `src/font-patches.js`, `src/index.html` | VERIFIED |
| EuroOfficeLite build | `scripts/setup.ps1` runs `grunt develop --desktop=true`, patches `word/scripts.js`, prepares fonts; `scripts/prepare-dist.ps1` stages a slim `src-dist/`; `scripts/get-x2t.ps1` fetches x2t | VERIFIED |
| EuroOfficeLite patches | `patches/sdkjs/` 3 patches, `patches/web-apps/` 6 patches, `patches/doctrenderer-sdkjs/` 1 patch | VERIFIED |
| Official EuroOffice components | Org repos: `core` (x2t), `sdkjs` (engine/editor JS), `web-apps` (UI), `server`/`DocumentServer` (backend incl. conversion and document builder) | VERIFIED |
| Document Builder exists in the Lite build | `resources/euro-office/sdkjs/word/apiBuilder.js`, 1.14 MB browser IIFE; the release tree `resources/euro-office-de` does not ship it | VERIFIED |
| Document Builder headless support | Not proven. It is a browser IIFE and needs a DOM; whether it runs unmodified in Electron/Node or only under the DocumentServer builder service is unknown | UNTESTED |
| Tauri/Rust backend | Not usable inside DSH; only its `bridge.js`, patches and x2t workflow transfer | VERIFIED |

## Methods

| Method | What is vendored | Strengths | Costs |
|---|---|---|---|
| A. Official release frontend + host page + x2t (current plugin) | `resources/euro-office-de/editors/{web-apps,sdkjs}` + x2t | Already verified in this repo; precompiled CSS; fastest boot; official EuroOffice | No Document Builder; large tree; release and Lite sdkjs versions must not be mixed |
| B. EuroOfficeLite frontend + bridge + x2t (vendor like Lite) | Lite `sdkjs`/`web-apps` submodules at the pinned commit, Lite `bridge.js`/patches, slim `src-dist`, x2t | One coherent offline stack designed for local document editing; includes Document Builder; slim distributable; updates follow Lite | Build step (`grunt develop`, font prep, patches); develop build compiles LESS at runtime unless the release build is used |
| C. DocumentServer vendored | `server`, `core`, `web-apps`, `sdkjs`, document builder service | Official backend; conversion and builder as services | Multiple processes and a server API; overkill for a single-user local editor |
| D1. Agent edits via sdkjs Document Builder | `apiBuilder.js` from the vendored sdkjs, run headless | Official EuroOffice engine; full OOXML support owned by sdkjs; no custom XML engine | Headless DOM/canvas dependency; API coverage for tracked changes must be proven |
| D2. Agent edits via own reduced model + x2t | Own parser/mutator in the plugin | Full control; deterministic; no third-party engine; matches the reduced-representation requirement | Own OOXML long tail: runs, numbering, tables, styles, tracked changes |
| D3. Agent edits through the live editor `asc_*` API | Open editor instance | Official engine and live state | Requires an open editor; not headless; couples agent latency to the UI |

## Criteria

Editor fidelity and Word-open behavior (verified in Stage 6), DOCX feature coverage for legal text (paragraphs, runs, lists, tables, styles, tracked changes), agent edit latency, offline/local operation, number of processes, fit with DSH packaging (`dsh.bundle.patch`, `dsh.client`, `files`), and reproducibility of the vendored build.

## Verdict

**Vendor EuroOfficeLite's frontend stack (method B) as the editor surface**, and take the agent's deterministic engine from the same pinned sdkjs through the **Document Builder (D1)** if a headless spike passes. Keep the release frontend as a performance override only when its sdkjs version matches the vendored builder; do not mix versions.

Reasons:

- It is the only method the owner named that is a complete offline editor stack with a local bridge and converter, and it already implements the `AscDesktopEditor` surface the plugin shim needs.
- It gives one pinned sdkjs version for both the editor and the Document Builder, which removes the version-skew risk of combining the release frontend with a Lite builder.
- It keeps DocumentServer (method C) out of v1: no extra server process or API for a single-user editor.
- D3 cannot satisfy the "agent edits while the user reads" workflow because it needs an open editor.

**Document Builder is gated, not assumed.** S0 must prove, headlessly: open a DOCX, edit a paragraph, insert a list item and a table row, save, reopen in EuroOffice and in Word without repair. If it fails, the fallback is D2 (own reduced model + x2t), implemented inside the same plugin seam.

## Accepted limitations

- The Lite develop build compiles LESS at runtime; the first open is slower than the release build. The release frontend remains available as an override after a version-match check.
- The Tauri/Rust backend is not used; window, printing, dictionary and file-dialog behavior from Lite is reimplemented or omitted.
- Document Builder API coverage for tracked changes is unproven; the tracked-change commit may need an OOXML serializer or the editor's review commands.
- The vendored Lite tree is large; it is committed as assets, not source code edited in place.
