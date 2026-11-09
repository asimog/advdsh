# S0 Document Builder headless spike — PASS

Status: verified 2026-11-10. Independent of the sibling run in
`spike/s0/docbuilder/` (which also reports PASS on an Electron runtime). This
run uses a different runtime — headless Chromium driven through the DSH
`dsh-browser` browser tools against a plain Node static server — and adds an
identity check of the builder API object plus a reopen of the saved DOCX in the
EuroOffice Lite editor.

## Verdict

**PASS.** The official sdkjs Word Document Builder (`AscBuilder.Word.Api`, the
same object `Asc.editor.getJsApi()` returns) ran in a headless Chromium page,
opened `workspace-test/TRO - Motion.docx`, edited one paragraph, inserted a
numbered list item, inserted a table row, serialized the document to
`Editor.bin`, and x2t wrote a DOCX whose `word/document.xml` contains all three
edit markers. The saved DOCX was then converted back to `Editor.bin` and opened
by the EuroOffice Lite editor with no repair and no error.

## Runtime

- Headless Chromium from the workspace `dsh-browser` tool; page 1280x800, no
  visible window, no user interaction, no modal dialog. Logs: `evidence/run-log.txt`.
- Static server: Node v24.13.1, `server.mjs`, `http://127.0.0.1:8791`; it serves
  the frontend, the host page, the font bridge and the two x2t conversions.
- Frontend: `resources/euro-office` (EuroOfficeLite develop tree), web-apps
  document editor. `apiBuilder.js` is loaded unchanged as part of the build by
  `sdkjs/develop/sdkjs/word/scripts.js` (entry at line 436); the spike does not
  patch or re-bundle it.
- Editor I/O: `Asc.editor.openDocument(OpenFileResult)` with `Editor.bin`, and
  `Asc.editor.asc_nativeGetFile()` to serialize. The builder API itself does not
  open or save files.
- Converter: `%LOCALAPPDATA%\advodsh-eo\converter\x2t.exe`. DOCX → `Editor.bin`
  uses format `8192`; `Editor.bin` → DOCX uses format `65`.
- Host shell: copies of the plugin's `shim.js` (AscDesktopEditor desktop shim,
  font loader bridged to HTTP) and `boot.js` (document open). Generated
  `AllFonts.js` is served from `%LOCALAPPDATA%\advodsh-eo\fontdata`.

## Exact API methods exercised

Entry point, in the editor frame:

- `AscBuilder.Word.Api` (verified `=== Asc.editor.getJsApi()`)
- `Api.GetDocument()`

Paragraph edit (append a run to the first substantive paragraph):

- `ApiDocument.GetAllParagraphs()`
- `ApiParagraph.GetText()`
- `ApiParagraph.AddText(" [BUILDER-HEADLESS-EDIT]")` — new run inherited the
  paragraph's Times New Roman run formatting in the saved XML.

Numbered list item:

- `ApiDocument.CreateNumbering("ArabicPeriod")`
- `ApiNumbering.GetLevel(0)`
- `Api.CreateParagraph()`
- `ApiParagraph.AddText(...)`
- `ApiParagraph.SetNumbering(ApiNumberingLevel)`
- `ApiParagraph.GetNumbering()`
- `ApiDocumentContent.Push(ApiParagraph)`

Table row:

- `ApiDocumentContent.GetAllTables()`
- `ApiTable.GetRowsCount()`
- `ApiTable.AddRow()`
- `ApiTableRow.GetCell(0)`
- `ApiTableCell.GetContent()`
- `ApiDocumentContent.GetElement(0)`
- `ApiParagraph.AddText(...)`

Save:

- `Asc.editor.asc_nativeGetFile()` — returns the `Editor.bin` as a string
  (file header + base64 body, 374,879 chars), posted to the spike server.
- `Api.Save()` exists but only returns `true`; it does not serialize.
- `Asc.editor.canRunBuilderScript()` / `_onEndBuilderScript()` exist and are
  available, but were not required for direct API calls against an open document.

## Measured runtime (headless Chromium, this machine)

| Phase | Time from page load |
|---|---|
| DOCX → Editor.bin (x2t) | 117 ms |
| Builder API available | 1,786 ms |
| Document content stable | 2,402 ms |
| Paragraph edit / list item / table row | 2,403–2,409 ms |
| `asc_nativeGetFile()` | 2,442 ms (374,879-byte string) |
| Editor.bin → DOCX (x2t) | 129 ms → 31,877-byte DOCX |
| **Total, page open to saved DOCX** | **2,582 ms** |
| Reopen saved DOCX: x2t → Editor.bin | 160 ms (257,964 bytes) |
| Reopen: editor loads and fires `onDocumentReady` | yes |

The edit plus three document operations plus serialization cost about 180 ms;
boot and conversion dominate.

## Output verification

`out/TRO - Motion.builder.docx` (31,877 bytes) opened as a zip; all entries
decompressed and `word/document.xml` parsed as XML:

- `word/document.xml`: well-formed; 18 body paragraphs (17 + list item), 1 table,
  2 table rows (1 + inserted row).
- `BUILDER-HEADLESS-EDIT`: 1 occurrence — appended run in the
  "Plaintiff MAH Advising, PLLC, seeks entry…" paragraph.
- `BUILDER-HEADLESS-LIST-ITEM`: 1 occurrence, in a paragraph carrying
  `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr>`.
- `BUILDER-HEADLESS-TABLE-ROW`: 1 occurrence, inside the table's second row.
- `word/numbering.xml`: 2 `w:num` definitions (original + builder-created).

Full check text: `evidence/verification.txt`. Reopen check: `evidence/run-log.txt`.
Screenshot of the headless page after the run: `evidence/headless-editor.png`.

## Limitations

- **Not a standalone Node module.** `apiBuilder.js` is a browser IIFE inside the
  editor build: it needs the editor engine realm (`AscCommon`/`AscWord`), the
  `AscBuilder` initialization done by the editor, and a document opened from
  `Editor.bin`. A Node-only or UI-less path was not found or proven; this spike
  needs a headless Chromium/Electron process.
- **sdkjs does not open DOCX directly.** x2t must bracket every open and save
  (two extra processes per edit round trip; 117–160 ms each here).
- **The full web-apps editor page boots even though no UI is used.** ~1.8 s to
  builder availability in this Lite develop build (runtime LESS compile). The
  release frontend is not version-matched to this builder and was not tried.
- **Fonts must be bridged.** The desktop font protocol is rewritten to HTTP and
  the generated `AllFonts.js` cache is served; without that, real documents open
  incompletely.
- **Tracked changes not exercised.** `ApiDocument.SetTrackRevisions` and the
  revision APIs exist but the tracked-change commit path is untested; that
  remains S1 work.
- **MS Word open was not tested** (outside this task); validity is established by
  XML checks, x2t round trip and EuroOffice Lite reopen.
- **Readiness is asynchronous.** Automation must poll for a loaded document
  before calling the API; there is no blocking open call in this setup.
- Editor exit timing: the headless page holds the engine in memory; a long-lived
  agent process would need explicit editor teardown.

## Evidence

- `result.json` — machine result, `status: PASS`, per-step timings.
- `evidence/verification.txt` — `word/document.xml` extraction checks.
- `evidence/run-log.txt` — main run and reopen run console output.
- `evidence/headless-editor.png` — headless page after the run.
- `out/TRO - Motion.builder.docx` — the saved DOCX.
- `spike/s0/docbuilder/REPORT.md` — independent Electron-runtime PASS.

## Reproduce

```
node spike/s0/builder-headless/server.mjs        # serves 127.0.0.1:8791
# open http://127.0.0.1:8791/start in headless Chromium
# reopen the output: SPIKE_DOCX=out/TRO - Motion.builder.docx PORT=8792, open /start?page=reopen
```

## Recommendation

PASS — adopt the official Document Builder as the agent's deterministic engine
(method D1) in a headless Chromium/Electron page with x2t around it, rather than
building the own reduced model; carry tracked-changes coverage into S1.
