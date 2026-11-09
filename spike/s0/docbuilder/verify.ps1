param(
  [string]$Docx = (Join-Path $PSScriptRoot 'out\TRO-Motion-builder.docx'),
  [string]$Json = (Join-Path $PSScriptRoot 'out\verification.json')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

$checks = [ordered]@{}
$result = [ordered]@{
  ok = $false
  docx = (Resolve-Path -LiteralPath $Docx -ErrorAction SilentlyContinue).Path
  bytes = 0
  entries = 0
  documentXmlBytes = 0
  markers = [ordered]@{}
  checks = $checks
  error = $null
}

try {
  if (-not (Test-Path -LiteralPath $Docx -PathType Leaf)) { throw "output is missing: $Docx" }
  $result.bytes = (Get-Item -LiteralPath $Docx).Length
  if ($result.bytes -le 0) { throw 'output is zero bytes' }

  # OpenRead validates the central directory; reading every entry checks the
  # deflate streams and CRCs.
  $zip = [System.IO.Compression.ZipFile]::OpenRead($Docx)
  try {
    $result.entries = $zip.Entries.Count
    $checks['has_entries'] = $result.entries -gt 0
    $checks['has_content_types'] = $null -ne $zip.GetEntry('[Content_Types].xml')
    $entry = $zip.GetEntry('word/document.xml')
    $checks['has_document_xml'] = $null -ne $entry
    if ($null -eq $entry) { throw 'word/document.xml is missing' }

    $reader = New-Object System.IO.StreamReader($entry.Open())
    try { $xml = $reader.ReadToEnd() } finally { $reader.Close() }
    $result.documentXmlBytes = $xml.Length
    $checks['document_xml_nonempty'] = $xml.Length -gt 0

    foreach ($name in @('DBSPIKE-REPLACED-PARAGRAPH', 'DBSPIKE-LIST-ITEM', 'DBSPIKE-TABLE-ROW')) {
      $present = $xml.Contains($name)
      $result.markers[$name] = $present
      $checks["marker_$name"] = $present
    }

    $checks['original_sentence_removed'] = -not $xml.Contains('seeks entry of an ex parte')

    $listParagraph = [regex]::Matches($xml, '(?s)<w:p(?:\s[^>]*)?>.*?</w:p>') |
      Where-Object { $_.Value.Contains('DBSPIKE-LIST-ITEM') } |
      Select-Object -First 1
    $checks['list_item_is_numbered'] = ($null -ne $listParagraph) -and $listParagraph.Value.Contains('<w:numPr>')

    $tableRow = [regex]::Matches($xml, '(?s)<w:tr(?:\s[^>]*)?>.*?</w:tr>') |
      Where-Object { $_.Value.Contains('DBSPIKE-TABLE-ROW') } |
      Select-Object -First 1
    $checks['table_row_inserted'] = $null -ne $tableRow
    $result['table_rows'] = ([regex]::Matches($xml, '<w:tr(?:\s[^>]*)?>')).Count

    # Decompress every part so a corrupt entry cannot hide behind document.xml.
    foreach ($part in $zip.Entries) {
      $stream = $part.Open()
      try {
        $buffer = New-Object byte[] 81920
        while ($stream.Read($buffer, 0, $buffer.Length) -gt 0) { }
      } finally { $stream.Close() }
    }
    $checks['all_entries_readable'] = $true

    $result.ok = ($checks.Values -notcontains $false)
    if (-not $result.ok) { $result.error = 'one or more checks failed' }
  } finally { $zip.Dispose() }
} catch {
  $result.error = $_.Exception.Message
  $checks['exception'] = $false
}

$result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $Json -Encoding UTF8
$result | ConvertTo-Json -Depth 6
if ($result.ok) { exit 0 } else { exit 1 }
