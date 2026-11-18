# Build the portable zip locally, bypassing electron-builder's 7za download.
#
# Why: `electron-builder --win` downloads 7za at the zip step and the local machine fails TLS
# verification (unable to get local issuer certificate), while `win-unpacked` is already complete.
# This does the same thing with the built-in Compress-Archive. The layout must match
# apps/desktop/scripts/portable-zip.cjs: one DevaPlus\ folder inside the zip, so extracting gives
# a clean DevaPlus\DevaPlus.exe instead of scattering files into the download folder.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File .deva/qa/make-portable.ps1

$ErrorActionPreference = 'Stop'

# Keep console output ASCII-only: this machine's console is GBK and non-ASCII gets mangled
# before PowerShell parses the script.

$desktop = Resolve-Path (Join-Path $PSScriptRoot '../../apps/desktop')
$unpacked = Join-Path $desktop 'dist/win-unpacked'
$pkg = Get-Content (Join-Path $desktop 'package.json') -Raw | ConvertFrom-Json
$version = $pkg.version
$out = Join-Path $desktop "dist/DevaPlus-$version-portable.zip"
$staged = Join-Path $desktop 'dist/DevaPlus'

if (-not (Test-Path $unpacked)) {
  throw "missing $unpacked - run pnpm build and electron-builder --win first (it fails at the zip step but still writes win-unpacked)"
}

if (Test-Path $staged) { Remove-Item $staged -Recurse -Force }
if (Test-Path $out) { Remove-Item $out -Force }

Write-Output '== stage =='
Move-Item $unpacked $staged
try {
  Write-Output '== compress =='
  Compress-Archive -Path $staged -DestinationPath $out -CompressionLevel Optimal
} finally {
  Move-Item $staged $unpacked
}

$size = (Get-Item $out).Length
$mb = [math]::Round($size / 1MB, 1)
Write-Output "== done: $out ($mb MB) =="

# Verify the zip really has DevaPlus/DevaPlus.exe rather than loose files at the root
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($out)
try {
  # Zip entry names use backslashes on Windows, forward slashes elsewhere — accept either
  $exeEntry = $zip.Entries | Where-Object { $_.FullName -match '[\\/]DevaPlus\.exe$' -and $_.FullName -match '^DevaPlus[\\/]' }
  if ($exeEntry) {
    Write-Output '== layout check: DevaPlus/DevaPlus.exe found PASS =='
  } else {
    Write-Output '== layout check FAILED: no DevaPlus/DevaPlus.exe =='
    $zip.Entries | Select-Object -First 5 | ForEach-Object { Write-Output ("   " + $_.FullName) }
    exit 1
  }
} finally {
  $zip.Dispose()
}
