# Word-open sweep for one saved DOCX.
#
# Opens the file read-only through Word COM with alerts and macros disabled,
# asserts the document opens with the expected tracked revisions and marker text,
# then closes Word. It never waits on a dialog: a failure is written to the log
# and the script exits non-zero.
param(
  [Parameter(Mandatory = $true)][string]$Docx,
  [string]$Marker,
  [int]$MinRevisions = 1,
  [string]$LogPath = ''
)
$ErrorActionPreference = 'Stop'
if ($LogPath -eq '') { $LogPath = Join-Path $env:TEMP 'word-open-check.log' }
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $LogPath) | Out-Null
function Write-CheckLog([string]$Message) {
  $line = "$(Get-Date -Format o) $Message"
  Write-Output $line
  Add-Content -Path $LogPath -Value $line -Encoding utf8
}

$word = $null
$document = $null
try {
  Write-CheckLog "open docx=$Docx"
  $word = New-Object -ComObject Word.Application
  $word.Visible = $false
  $word.DisplayAlerts = 0
  $word.AutomationSecurity = 3
  $document = $word.Documents.Open($Docx, $false, $true)
  $revisions = $document.Revisions.Count
  $paragraphs = $document.Paragraphs.Count
  $text = $document.Range().Text
  Write-CheckLog "opened paragraphs=$paragraphs revisions=$revisions chars=$($text.Length)"
  if ($revisions -lt $MinRevisions) {
    Write-CheckLog "FAIL revisions=$revisions expected at least $MinRevisions"
    exit 1
  }
  if ($Marker -ne '' -and -not $text.Contains($Marker)) {
    Write-CheckLog "FAIL marker not found: $Marker"
    exit 1
  }
  Write-CheckLog 'PASS word opened the document with its tracked revisions'
  exit 0
} catch {
  Write-CheckLog "FAIL $($_.Exception.Message)"
  exit 1
} finally {
  if ($document -ne $null) { try { $document.Close(0) } catch { } }
  if ($word -ne $null) {
    try { $word.Quit(0) } catch { }
    try { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null } catch { }
  }
}
