# Rebuilds resources/euro-office from the pinned Euro-Office Lite source.
#
# The 216 MB frontend tree is not committed. This script fetches the pins in
# vendor/euro-office/manifest.json, builds the Lite frontend with the Lite
# checkout's own scripts/setup.ps1 and scripts/prepare-dist.ps1, mirrors
# src-dist/ into the staged tree, and verifies the result against the manifest.
#
# It is idempotent: when the staged tree already matches the manifest it exits 0
# without network access. A mismatch is reported and rebuilt. Any failed step
# exits 1 with the failing command and exit code.
#
# Usage:
#   pwsh -File scripts\vendor-euro-office.ps1                 # no-op if verified
#   pwsh -File scripts\vendor-euro-office.ps1 -Force          # always rebuild
#   pwsh -File scripts\vendor-euro-office.ps1 -VerifyOnly     # check only
#   pwsh -File scripts\vendor-euro-office.ps1 -WorkDir D:\eo   # reuse a checkout
#
# See .agents/docs/eurooffice-hosting-assessment.md.

param(
    [string]$WorkDir = (Join-Path $env:TEMP 'advodsh-euro-office-vendor'),
    [string]$Target = '',
    [switch]$Force,
    [switch]$VerifyOnly
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $repoRoot 'vendor\euro-office\manifest.json'

function Write-Step {
    param([string]$Message)
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Stop-Vendor {
    param([string]$Message)
    Write-Host "ERROR: $Message" -ForegroundColor Red
    exit 1
}

function Get-Sha256 {
    param([string]$Path)
    (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Invoke-Native {
    # Runs a native command with stderr routed to the host, so Windows
    # PowerShell does not turn git/x2t progress output into terminating errors.
    param([string]$FilePath, [string[]]$Arguments, [string]$Label)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $FilePath @Arguments 2>&1 | ForEach-Object { Write-Host "$_" }
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
    if ($code -ne 0) {
        Stop-Vendor "$Label failed (exit code $code)"
    }
}

function Get-NativeOutput {
    param([string]$FilePath, [string[]]$Arguments, [string]$Label)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $lines = @(& $FilePath @Arguments 2>&1)
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
    if ($code -ne 0) {
        Stop-Vendor "$Label failed (exit code $code): $($lines -join ' ')"
    }
    return @($lines | ForEach-Object { "$_" } | Where-Object { $_ -ne '' })
}

function Test-StagedTree {
    # Returns an array of problems; an empty array means the tree matches.
    param([string]$Path, $Manifest)
    $problems = @()

    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        return @("tree missing: $Path")
    }

    foreach ($entry in @($Manifest.output.requiredEntries)) {
        if ($entry -and -not (Test-Path -LiteralPath (Join-Path $Path $entry))) {
            $problems += "missing entry: $entry"
        }
    }

    $presence = $Manifest.output.presenceCheck
    $presencePath = Join-Path $Path $presence.path
    if (Test-Path -LiteralPath $presencePath -PathType Leaf) {
        $actual = Get-Sha256 $presencePath
        if ($actual -ne "$($presence.sha256)".ToLowerInvariant()) {
            $problems += "sha256 mismatch for $($presence.path): expected $($presence.sha256), actual $actual"
        }
        if ($null -ne $presence.bytes -and (Get-Item -LiteralPath $presencePath).Length -ne [int64]$presence.bytes) {
            $problems += "size mismatch for $($presence.path): expected $($presence.bytes), actual $((Get-Item -LiteralPath $presencePath).Length)"
        }
    } else {
        $problems += "missing presence file: $($presence.path)"
    }

    $generated = $Manifest.output.generatedFile
    if ($generated) {
        $generatedPath = Join-Path $Path $generated.path
        if (-not (Test-Path -LiteralPath $generatedPath -PathType Leaf)) {
            $problems += "missing generated file: $($generated.path) (setup.ps1 did not run)"
        } elseif ((Get-Content -LiteralPath $generatedPath -Raw) -notmatch [regex]::Escape($generated.contains)) {
            $problems += "generated file without marker '$($generated.contains)': $($generated.path)"
        }
    }

    $files = @(Get-ChildItem -LiteralPath $Path -Recurse -File -Force)
    $bytes = ($files | Measure-Object -Property Length -Sum).Sum
    if ($null -eq $bytes) { $bytes = 0 }
    if ($null -ne $Manifest.output.expectedFiles -and $files.Count -ne [int]$Manifest.output.expectedFiles) {
        $problems += "file count mismatch: expected $($Manifest.output.expectedFiles), actual $($files.Count)"
    }
    if ($null -ne $Manifest.output.expectedBytes -and $bytes -ne [int64]$Manifest.output.expectedBytes) {
        $problems += "byte count mismatch: expected $($Manifest.output.expectedBytes), actual $bytes"
    }

    return $problems
}

function Format-Problems {
    param([string[]]$Problems)
    ($Problems | ForEach-Object { "  - $_" }) -join [Environment]::NewLine
}

if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    Stop-Vendor "manifest not found: $manifestPath"
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$repoUrl = $manifest.source.repoUrl
$commit = $manifest.source.commit
$presenceSha = $manifest.output.presenceCheck.sha256

if (-not $repoUrl) { Stop-Vendor "manifest has no source.repoUrl" }
if ($commit -notmatch '^[0-9a-f]{40}$') { Stop-Vendor "manifest source.commit is not a 40-char sha: $commit" }
if (-not $manifest.output.path) { Stop-Vendor "manifest has no output.path" }
if (-not $presenceSha -or -not $manifest.output.presenceCheck.path) {
    Stop-Vendor "manifest has no output.presenceCheck path/sha256"
}
$submodulePins = @($manifest.source.submodules.PSObject.Properties)
if ($submodulePins.Count -eq 0) { Stop-Vendor "manifest has no source.submodules" }

$targetPath = if ($Target) { $Target } else { Join-Path $repoRoot $manifest.output.path }
$targetPath = [System.IO.Path]::GetFullPath($targetPath)

Write-Step "Manifest: $manifestPath"
Write-Step "Target:   $targetPath"

if ($VerifyOnly) {
    $problems = @(Test-StagedTree -Path $targetPath -Manifest $manifest)
    if ($problems.Count -gt 0) {
        Stop-Vendor "target does not match manifest:`n$(Format-Problems $problems)"
    }
    $files = @(Get-ChildItem -LiteralPath $targetPath -Recurse -File -Force)
    $bytes = ($files | Measure-Object -Property Length -Sum).Sum
    Write-Host "OK: verified $($files.Count) files, $([math]::Round($bytes / 1MB, 1)) MB, sha256 $presenceSha"
    exit 0
}

if (-not $Force) {
    $problems = @(Test-StagedTree -Path $targetPath -Manifest $manifest)
    if ($problems.Count -eq 0) {
        Write-Host "OK: already vendored and verified: $targetPath"
        exit 0
    }
    Write-Host "Staged tree does not match the manifest; rebuilding. Differences:" -ForegroundColor Yellow
    Write-Host (Format-Problems $problems)
}

foreach ($name in @('git', 'node', 'npm')) {
    if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
        Stop-Vendor "$name is not on PATH"
    }
}
$psCommand = Get-Command powershell.exe -ErrorAction SilentlyContinue
if ($psCommand) {
    $psExe = $psCommand.Source
} else {
    $psExe = (Get-Process -Id $PID).Path
}
if (-not $psExe -or -not (Test-Path -LiteralPath $psExe)) {
    Stop-Vendor "no PowerShell executable found to run the Lite build scripts"
}

Write-Step "Checkout: $WorkDir"
if (Test-Path -LiteralPath $WorkDir) {
    if (-not (Test-Path -LiteralPath (Join-Path $WorkDir '.git'))) {
        $existing = @(Get-ChildItem -LiteralPath $WorkDir -Force)
        if ($existing.Count -gt 0) {
            Stop-Vendor "work directory exists but is not a git checkout: $WorkDir (remove it or pass -WorkDir)"
        }
    }
} else {
    New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null
}

$gitDir = Join-Path $WorkDir '.git'
if (-not (Test-Path -LiteralPath $gitDir)) {
    Invoke-Native 'git' @('clone', '--no-checkout', $repoUrl, $WorkDir) "git clone $repoUrl"
} else {
    $origin = @(Get-NativeOutput 'git' @('-C', $WorkDir, 'remote', 'get-url', 'origin') 'git remote get-url origin')
    if ($origin.Count -gt 0 -and $origin[0].Trim() -ne $repoUrl) {
        Stop-Vendor "work directory origin is '$($origin[0])', manifest expects '$repoUrl' (remove it or pass -WorkDir)"
    }
}

Invoke-Native 'git' @('-C', $WorkDir, 'fetch', '--prune', '--tags', 'origin') "git fetch origin"
Invoke-Native 'git' @('-C', $WorkDir, 'checkout', '--detach', $commit) "git checkout $commit"
Invoke-Native 'git' @('-C', $WorkDir, 'reset', '--hard', $commit) "git reset --hard $commit"
Invoke-Native 'git' @('-C', $WorkDir, 'clean', '-ffdx') "git clean -ffdx"
Invoke-Native 'git' @('-C', $WorkDir, 'submodule', 'sync', '--recursive') "git submodule sync"
Invoke-Native 'git' @('-C', $WorkDir, 'submodule', 'update', '--init', '--recursive', '--force') "git submodule update"

$head = @(Get-NativeOutput 'git' @('-C', $WorkDir, 'rev-parse', 'HEAD') 'git rev-parse HEAD')
if ($head.Count -eq 0 -or $head[0].Trim() -ne $commit) {
    Stop-Vendor "checkout is at '$($head -join '')', manifest pins $commit"
}
foreach ($pin in $submodulePins) {
    $subPath = Join-Path $WorkDir ($pin.Name -replace '/', '\')
    if (-not (Test-Path -LiteralPath (Join-Path $subPath '.git'))) {
        Stop-Vendor "submodule $($pin.Name) was not initialized"
    }
    $subHead = @(Get-NativeOutput 'git' @('-C', $subPath, 'rev-parse', 'HEAD') "git rev-parse HEAD ($($pin.Name))")
    if ($subHead.Count -eq 0 -or $subHead[0].Trim() -ne $pin.Value.commit) {
        Stop-Vendor "submodule $($pin.Name) is at '$($subHead -join '')', manifest pins $($pin.Value.commit)"
    }
    Write-Host "    $($pin.Name) @ $($pin.Value.commit)"
}

$setupScript = Join-Path $WorkDir 'scripts\setup.ps1'
$prepareScript = Join-Path $WorkDir 'scripts\prepare-dist.ps1'
foreach ($script in @($setupScript, $prepareScript)) {
    if (-not (Test-Path -LiteralPath $script -PathType Leaf)) {
        Stop-Vendor "Lite build script missing: $script (manifest commit $commit)"
    }
}

Write-Step "Running setup.ps1 (npm ci, grunt develop, fonts)"
$previousEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
    & $psExe -NoProfile -ExecutionPolicy Bypass -File $setupScript
    $setupCode = $LASTEXITCODE
} finally {
    $ErrorActionPreference = $previousEap
}
if ($setupCode -ne 0) { Stop-Vendor "setup.ps1 failed (exit code $setupCode)" }

Write-Step "Running prepare-dist.ps1 (patches, src-dist staging)"
$ErrorActionPreference = 'Continue'
try {
    & $psExe -NoProfile -ExecutionPolicy Bypass -File $prepareScript
    $prepareCode = $LASTEXITCODE
} finally {
    $ErrorActionPreference = $previousEap
}
if ($prepareCode -ne 0) { Stop-Vendor "prepare-dist.ps1 failed (exit code $prepareCode)" }

$distPath = Join-Path $WorkDir $manifest.build.outputDir
$problems = @(Test-StagedTree -Path $distPath -Manifest $manifest)
if ($problems.Count -gt 0) {
    Stop-Vendor "built tree does not match manifest (pins or build changed):`n$(Format-Problems $problems)"
}
Write-Step "Staging $distPath -> $targetPath"
$targetParent = Split-Path -Parent $targetPath
if (-not (Test-Path -LiteralPath $targetParent)) {
    New-Item -ItemType Directory -Path $targetParent -Force | Out-Null
}
$previousEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
    & robocopy @($distPath, $targetPath, '/MIR', '/NJH', '/NJS', '/NP', '/NDL', '/NFL', '/R:0', '/W:0') | Out-Null
    $roboCode = $LASTEXITCODE
} finally {
    $ErrorActionPreference = $previousEap
}
# robocopy: 0-7 are success (1-7 mean files copied); 8+ is a failure.
if ($roboCode -ge 8) {
    Stop-Vendor "robocopy /MIR failed (exit code $roboCode)"
}

$problems = @(Test-StagedTree -Path $targetPath -Manifest $manifest)
if ($problems.Count -gt 0) {
    Stop-Vendor "staged tree does not match manifest:`n$(Format-Problems $problems)"
}

$files = @(Get-ChildItem -LiteralPath $targetPath -Recurse -File -Force)
$bytes = ($files | Measure-Object -Property Length -Sum).Sum
Write-Host "OK: vendored $($files.Count) files, $([math]::Round($bytes / 1MB, 1)) MB, sha256 $presenceSha" -ForegroundColor Green
Write-Host "Work directory kept at $WorkDir"
