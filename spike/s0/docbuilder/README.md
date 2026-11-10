# S0 Document Builder spike

Runs the official sdkjs Word Document Builder
(`resources/euro-office/sdkjs/word/apiBuilder.js`) inside a hidden Electron
window: open a DOCX, read paragraphs, replace one, insert a numbered list item
and a table row, save through x2t, verify the DOCX, and write evidence under
`out/`.

Run from the repo root:

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
pwsh -File spike\s0\docbuilder\run.ps1
```

`run.ps1` launches Electron, waits for `out/result.json`, stops the spike
process, then runs `verify.ps1`. It exits 0 only when both the builder run and
the DOCX verification pass.

Direct launch:

```powershell
& <electron.exe> spike\s0\docbuilder --docx="workspace-test\TRO - Motion.docx" --out=spike\s0\docbuilder\out\TRO-Motion-builder.docx
```

Logs go to `logs/run-<id>.log`; main-process crashes go to `logs/crash.log` and
exit non-zero. The runner never shows a modal error dialog.

Result files: `out/TRO-Motion-builder.docx`, `out/result.json`,
`out/result-TRO-Motion-builder.json`, `out/verification.json`,
`out/roundtrip.json`, `logs/*.log`.
