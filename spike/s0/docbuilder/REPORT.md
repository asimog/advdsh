# S0 Document Builder spike — PASS

Status: verified 2026-11-10.

## Verdict

The official sdkjs Word Document Builder runs headlessly and edits a DOCX. In a
hidden Electron window it opened `workspace-test/TRO - Motion.docx`, read every
paragraph, replaced one paragraph, inserted a numbered list item, added a table
row, serialized the document, and converted it back to a valid DOCX. All checks
in `out/verification.json` are true.

## Runtime

- Electron 44.7.0 / Chromium 152.0.7977.130 / Node 24.21.0.
- Hidden `BrowserWindow` (`show: false`); no window is shown and no modal dialog
  is used.
- Builder: `resources/euro-office/sdkjs/word/apiBuilder.js`, the official browser
  IIFE, loaded unchanged by the web-apps editor page through
  `resources/euro-office/sdkjs/develop/sdkjs/word/scripts.js`.
- Converter: `resources/euro-office-lite-src/src-tauri/binaries/x2t.exe`.
  DOCX → Editor.bin uses format `8192`; Editor.bin → DOCX uses format `65`.
- Input: `workspace-test/TRO - Motion.docx`.
- Output: `spike/s0/docbuilder/out/TRO-Motion-builder.docx` (31,682 bytes,
  22 zip entries; byte count varies slightly with timestamps).

## API used

Builder entry point: `AscBuilder.Word.Api` inside the editor iframe.

Document/paragraph methods:

- `Api.GetDocument`
- `ApiDocument.GetAllParagraphs`
- `ApiParagraph.GetText`
- `ApiParagraph.RemoveAllElements`
- `ApiParagraph.AddText`

List methods:

- `ApiDocument.CreateNumbering`
- `ApiNumbering.GetLevel`
- `Api.CreateParagraph`
- `ApiParagraph.SetNumbering`
- `ApiDocumentContent.Push`

Table methods:

- `ApiDocumentContent.GetAllTables`
- `ApiTable.AddRow`
- `ApiTableRow.GetCell`
- `ApiTableCell.GetContent`
- `ApiDocumentContent.GetElement`

Builder lifecycle hooks: `Asc.editor.canRunBuilderScript()` and
`Asc.editor.onEndBuilderScript(callback)` (both present and used).

Editor I/O: `Asc.editor.openDocument(OpenFileResult)` with `Editor.bin`, then
`Asc.editor.asc_nativeGetFile()` for serialization. The builder API itself does
not open or save files; those calls bracket the same API in the editor realm.

## Procedure

1. A local HTTP server served the spike page, `web-apps`, `sdkjs`, fonts and
   converted media from one origin. The Electron window was hidden.
2. x2t converted the source DOCX to `Editor.bin`.
3. The editor page mounted normally; after `onDocumentReady`, the builder script
   ran against `AscBuilder.Word.Api`.
4. The script edited the document, then `asc_nativeGetFile()` produced the
   serialized document and x2t converted it back to DOCX.
5. `verify.ps1` opened the output as a ZIP, decompressed every entry, and checked
   `word/document.xml`.

## Evidence

`out/verification.json` and `out/result.json`:

- `word/document.xml` exists and contains `DBSPIKE-REPLACED-PARAGRAPH`,
  `DBSPIKE-LIST-ITEM`, and `DBSPIKE-TABLE-ROW`.
- The original paragraph sentence is gone.
- The list item carries a `<w:numPr>` numbering reference.
- The table has 2 rows, up from 1, and the new row contains the marker.
- `[Content_Types].xml` is present; all 22 entries decompress without error.
- A separate x2t round-trip of the output preserved all three markers and the
  2-row table (`out/roundtrip.json`).

## Limitations

- This is Chromium-hosted, not Node-only. The builder depends on the editor DOM,
  canvas/layout code, and `Asc.editor`; the full web-apps UI is loaded even
  though the window is hidden.
- It uses the editor's native serializer plus x2t. DocumentServer's own builder
  service wrapper and its script/save protocol were not run.
- Replacing a paragraph with `RemoveAllElements` + `AddText` keeps paragraph
  properties but drops run-level formatting in that paragraph.
- The inserted list item creates a new bullet numbering definition; the new
  table row inherits the source table's style and column widths.
- Tracked changes, headers/footers, comments, footnotes, large documents, and a
  Word/LibreOffice open sweep were not tested.
- `run.ps1` force-kills any leftover spike Electron processes after the result
  file is written; the app itself now shuts down reliably.

## Recommendation

Use the Document Builder (D1) as the agent's deterministic DOCX engine and wrap
the hidden Electron host as a managed sidecar behind the workspace editor's
engine seam. Keep the own reduced model (D2) only as a fallback for operations
the builder cannot express; gate tracked changes and the Word open sweep before
depending on it for review workflows.

## Reproduce

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
pwsh -File spike\s0\docbuilder\run.ps1
```

The script exits 0 only when the builder run and `verify.ps1` both pass. Main
process crashes are written to `logs/crash.log` and exit non-zero; they never
open a dialog.
