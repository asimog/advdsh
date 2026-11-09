# S0 Document Builder spike

Runs the official sdkjs Word Document Builder (`resources/euro-office/sdkjs/word/apiBuilder.js`)
inside a hidden Electron window: open a DOCX, replace a paragraph, insert a list
item and a table row, save through x2t, and write the result under `out/`.

Run from the repo root with an Electron binary:

```powershell
& <electron.exe> spike\s0\docbuilder --docx="workspace-test\TRO - Motion.docx" --out=spike\s0\docbuilder\out\result.docx
```

Logs go to `logs/run-<id>.log`; crashes go to `logs/crash.log`. The runner never
shows a modal error dialog: an uncaught exception is written to `crash.log` and
the app exits non-zero. Read the log, fix, rerun.

Result files: `out/result.json`, `out/*.docx`, `logs/*.log`.
