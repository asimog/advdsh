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
| Pinned-fetch vendoring | `vendor/euro-office/manifest.json` + `scripts/vendor-euro-office.ps1`; `-VerifyOnly` on `resources/euro-office`: 5,907 files, 216.8 MB, `index.html` sha256 matches the manifest | VERIFIED |
| Official EuroOffice components | Org repos: `core` (x2t), `sdkjs` (engine/editor JS), `web-apps` (UI), `server`/`DocumentServer` (backend incl. conversion and document builder) | VERIFIED |
| Document Builder exists in the Lite build | `resources/euro-office/sdkjs/word/apiBuilder.js`, 1.14 MB browser IIFE; the release tree `resources/euro-office-de` does not ship it | VERIFIED |
| Document Builder headless support | Proven in `spike/s0/docbuilder` (Electron 44.7.0) and independently in `spike/s0/builder-headless` (headless Chromium via `dsh-browser`, same `AscBuilder.Word.Api` object as `Asc.editor.getJsApi()`): open, edit, insert numbered list item and table row, x2t save, all markers verified; the Chromium run reopened the DOCX in the Lite editor (2.58 s total) | VERIFIED |
| Document Builder track changes | `apiBuilder.js` exposes `ApiDocument.SetTrackRevisions(isTrack)`; a saved DOCX carrying agent-authored revisions is not yet exercised | UNTESTED |
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

**Vendor EuroOfficeLite's frontend stack (method B) as the editor surface**, and take the agent's deterministic engine from the same pinned sdkjs through the **Document Builder (D1)**, which now has a passing headless spike. Keep the release frontend as a performance override only when its sdkjs version matches the vendored builder; do not mix versions.

Reasons:

- It is the only method the owner named that is a complete offline editor stack with a local bridge and converter, and it already implements the `AscDesktopEditor` surface the plugin shim needs.
- It gives one pinned sdkjs version for both the editor and the Document Builder, which removes the version-skew risk of combining the release frontend with a Lite builder.
- It keeps DocumentServer (method C) out of v1: no extra server process or API for a single-user editor.
- D3 cannot satisfy the "agent edits while the user reads" workflow because it needs an open editor.

**The Document Builder is proven, not assumed.** S0 ran it headlessly: open a DOCX, replace a paragraph, insert a list item and a table row, save through x2t, verify the markers (`spike/s0/docbuilder/REPORT.md`). Productionize it as the engine sidecar; the D2 own reduced model remains the fallback for operations the builder cannot express (for example tracked-change serialization, if the builder API does not cover it).

## Vendoring (method B, pinned fetch)

Method B is fetched, not committed. `resources/` is gitignored, so the 216.8 MB / 5,907-file frontend is reproduced from pins instead of stored in the repo. `vendor/euro-office/manifest.json` (~1 KB, committed) records the exact commit and submodule SHAs; `scripts/vendor-euro-office.ps1` fetches, builds, stages and checks.

| Field | Value |
|---|---|
| Repo | `https://github.com/delmarguillen/euro-office-lite` |
| Commit | `8f397256a1c3781d25723d286c42107ccfe586ab` (`v0.17.46-alpha-82-g8f39725`) |
| `src/sdkjs` | `https://github.com/Euro-Office/sdkjs.git` @ `ab0a5cf561f54291d03cb867707edd50ec7c71a5` (`v9.3.2-rc.1`) |
| `src/web-apps` | `https://github.com/Euro-Office/web-apps.git` @ `53dd1a19a7a9a7dc670545e6a04443b7b8a31ea1` (`v9.3.2-rc.1`) |
| Manifest | `vendor/euro-office/manifest.json` |
| Fetch/build script | `scripts/vendor-euro-office.ps1` |
| Staged output | `resources/euro-office`, a mirror of the checkout's `src-dist/` (`robocopy /MIR`) |

Manual equivalent of the script:

```powershell
git clone https://github.com/delmarguillen/euro-office-lite <work>
git -C <work> checkout --detach 8f397256a1c3781d25723d286c42107ccfe586ab
git -C <work> submodule update --init --recursive
powershell -ExecutionPolicy Bypass -File <work>\scripts\setup.ps1
powershell -ExecutionPolicy Bypass -File <work>\scripts\prepare-dist.ps1
```

`setup.ps1` runs `npm ci` in `src/sdkjs/build`, `npx grunt develop --desktop=true`, patches `src/sdkjs/develop/sdkjs/word/scripts.js`, and runs `scripts/prepare-fonts.ps1` (downloads the pinned fonts, writes `src/fonts/` and `src/sdkjs/common/AllFonts.js`). `prepare-dist.ps1` applies `patches/sdkjs` and `patches/web-apps`, copies the runtime subset from `src/` into `src-dist/`, then reverts the patches. Generated paths: `src/sdkjs/develop/sdkjs/{word,cell,slide}/scripts.js`, `src/fonts/`, `src/sdkjs/common/AllFonts.js`, and `src-dist/{index.html,bridge.js,button-hint-patch.js,editor-patches.js,font-patches.js,fonts,sdkjs,web-apps}`.

Script behaviour:

- **Idempotent.** A matching staged tree verifies and exits 0 without network. `-Force` always rebuilds; `-VerifyOnly` only checks; `-WorkDir`/`-Target` run the same flow against another checkout and stage path.
- **Fetch.** Clone or reuse a checkout, `git fetch`, detach at the pinned commit, then `git submodule update --init --recursive`. The script stops if HEAD or either submodule is not the pinned SHA.
- **Build.** Runs the Lite scripts unchanged, then mirrors `src-dist/` into the target.
- **Presence check.** Before staging and after mirroring the target, the script verifies the staged tree against the manifest: `index.html` sha256 `427a6eb90acfd7d14b0f9e4073632cf1799f3e3b556275cd96a3bd8b32e4b304` (11,819 bytes), the generated `sdkjs/develop/sdkjs/word/scripts.js`, the eight required top-level entries, and the file and byte counts (5,907 / 227,375,696 = 216.8 MiB). It exits 1 with the failing step or the differences otherwise. Run against the existing stage: `OK: verified 5907 files, 216.8 MB, sha256 427a6eb9...` (exit 0).
- **Boundary.** Only the frontend is staged. x2t is not in this tree: the Lite `scripts/get-x2t.ps1` writes `src-tauri/binaries/`, and the plugin converter is installed by the plugin's Stage 5 setup (`scripts/stage5/setup-x2t.ps1`), outside these pins.

## Accepted limitations

- The Lite develop build compiles LESS at runtime; the first open is slower than the release build. The release frontend remains available as an override after a version-match check.
- The Tauri/Rust backend is not used; window, printing, dictionary and file-dialog behavior from Lite is reimplemented or omitted.
- Document Builder tracked changes are exposed (`SetTrackRevisions`) but not yet proven in a saved DOCX; S1 verifies revisions and agent authorship. The fallback is the D2 OOXML serializer.
- The Lite tree is large (216.8 MB); it is fetched by `scripts/vendor-euro-office.ps1` from the pins in `vendor/euro-office/manifest.json` and never committed. Rebuilding needs network access for the clone, `npm ci` and the font downloads.
