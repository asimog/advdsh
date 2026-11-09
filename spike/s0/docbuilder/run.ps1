param(
  [string]$Docx = (Join-Path $PSScriptRoot '..\..\..\workspace-test\TRO - Motion.docx'),
  [string]$Out = (Join-Path $PSScriptRoot 'out\TRO-Motion-builder.docx'),
  [int]$TimeoutSeconds = 180
)

$ErrorActionPreference = 'Stop'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$spike = $PSScriptRoot
$outDir = Join-Path $spike 'out'
$logsDir = Join-Path $spike 'logs'
New-Item -ItemType Directory -Force -Path $outDir, $logsDir | Out-Null

function Stop-SpikeElectron {
  Get-CimInstance Win32_Process -Filter "Name = 'electron.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains('spike\s0\docbuilder') } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

Stop-SpikeElectron

$electron = Join-Path $spike 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $electron)) {
  $electron = Join-Path $spike '..\..\editor-host\node_modules\electron\dist\electron.exe'
}
if (-not (Test-Path $electron)) { throw "electron.exe not found; install Electron in $spike or keep spike/editor-host/node_modules" }

$resultPath = Join-Path $outDir 'result.json'
Remove-Item -LiteralPath $resultPath -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $Out -Force -ErrorAction SilentlyContinue
$started = Get-Date

Write-Host 'DocBuilder spike'
Write-Host "  docx: $Docx"
Write-Host "  out : $Out"
Write-Host "  run : $electron"

try {
  $process = Start-Process -FilePath $electron -ArgumentList @(
    "`"$spike`"",
    "`"--docx=$Docx`"",
    "`"--out=$Out`""
  ) -PassThru

  $deadline = $started.AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-Path -LiteralPath $resultPath) {
      $info = Get-Item -LiteralPath $resultPath
      if ($info.LastWriteTime -ge $started) { break }
    }
    if ($process.HasExited -and -not (Test-Path -LiteralPath $resultPath)) {
      throw "Electron exited before writing a result (exit $($process.ExitCode))"
    }
    Start-Sleep -Milliseconds 500
  }
  if (-not (Test-Path -LiteralPath $resultPath)) { throw "timed out waiting for $resultPath" }

  Start-Sleep -Seconds 1
} finally {
  Stop-SpikeElectron
}

$result = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
if (-not $result.ok) { throw "Document Builder spike failed: $($result.error)" }

& (Join-Path $spike 'verify.ps1') -Docx $Out -Json (Join-Path $outDir 'verification.json')
if ($LASTEXITCODE -ne 0) { throw "verification failed; see $(Join-Path $outDir 'verification.json')" }

$verification = Get-Content -LiteralPath (Join-Path $outDir 'verification.json') -Raw | ConvertFrom-Json
Write-Host ''
Write-Host "PASS  builder API: $($result.builder.api)"
Write-Host "      methods: $($result.builder.usedMethods.Count)"
Write-Host "      output : $Out ($($verification.bytes) bytes, $($verification.entries) zip entries)"
Write-Host "      markers: replaced=$($verification.markers.'DBSPIKE-REPLACED-PARAGRAPH') list=$($verification.markers.'DBSPIKE-LIST-ITEM') tableRow=$($verification.markers.'DBSPIKE-TABLE-ROW')"
Write-Host "      list is numbered: $($verification.checks.list_item_is_numbered); table rows: $($verification.table_rows)"
exit 0
