# S0 Document Builder spike — PASS

Status: verified 2026-11-10.

## Runtime

- Electron 44.7.0 / Chromium 152 / Node 24.21, hidden `BrowserWindow`.
- Official sdkjs Word Document Builder: `resources/euro-office/sdkjs/word/apiBuilder.js`.
- Converter: x2t from `resources/euro-office-lite-src/src-tauri/binaries`.
- Input: `workspace-test/TRO - Motion.docx`; output: `out/TRO-Motion-builder.docx` (31,687 bytes, 22 entries).

## Evidence

`out/verification.json` (all true):

- `DBSPIKE-REPLACED-PARAGRAPH` present; the original sentence is gone.
- `DBSPIKE-LIST-ITEM` present and numbered.
- `DBSPIKE-TABLE-ROW` present; the table has 2 rows (was 1).
- all zip entries readable; `[Content_Types].xml` and `word/document.xml` present.

Builder API used: `AscBuilder.Word.Api` (`Api.GetDocument`, `ApiDocument.GetAllParagraphs`, `ApiParagraph.GetText/RemoveAllElements/AddText`, `ApiDocument.CreateNumbering`, `ApiNumbering.GetLevel`, `Api.CreateParagraph`, `ApiParagraph.SetNumbering`, `ApiDocumentContent.Push/GetAllTables/GetElement`, `ApiTable.AddRow`, `ApiTableRow.GetCell`, `ApiTableCell.GetContent`). Builder hooks were available (`canRunBuilderScript`, `onEndBuilderScript`).

## Runner policy

The runner never shows a modal error dialog. Uncaught main-process exceptions and unhandled rejections are written to `logs/crash.log` and exit 1; stdout EPIPE is swallowed because the parent pipe may close first. Logs: `logs/run-<id>.log`.

`ELECTRON_RUN_AS_NODE` must be unset before launching Electron, otherwise `require('electron')` resolves as plain Node and the app fails before the runner installs.

## Reproduce

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
pwsh -File spike\s0\docbuilder\run.ps1
pwsh -File spike\s0\docbuilder\verify.ps1
```

## Untested

Tracked-change creation/accept/reject through the builder, headers/footers, comments, footnotes, large documents, and a Word open sweep. These are S1 gates.

## Recommendation

Use the Document Builder (D1) as the deterministic engine: productionize the hidden-Electron builder as a managed sidecar behind `ctx.docxEngine`. Keep the own reduced model (D2) as the fallback for operations the builder cannot express.
