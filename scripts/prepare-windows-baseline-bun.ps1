param(
  [Parameter(Mandatory = $true)][string]$Version,
  [Parameter(Mandatory = $true)][string]$GitHubEnv
)

$ErrorActionPreference = "Stop"
$Asset = "bun-windows-x64-baseline.zip"
$ReleaseBase = "https://github.com/oven-sh/bun/releases/download/bun-v$Version"
$Stage = Join-Path $env:RUNNER_TEMP "codex-chatgpt-web-bun-baseline-$Version"
$Archive = Join-Path $Stage $Asset
$Checksums = Join-Path $Stage "SHASUMS256.txt"
$Extracted = Join-Path $Stage "extracted"

Remove-Item -LiteralPath $Stage -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $Stage | Out-Null
Invoke-WebRequest "$ReleaseBase/$Asset" -OutFile $Archive
Invoke-WebRequest "$ReleaseBase/SHASUMS256.txt" -OutFile $Checksums

$ExpectedLine = Get-Content -LiteralPath $Checksums | Where-Object { $_ -match "  bun-windows-x64-baseline\.zip$" }
if (@($ExpectedLine).Count -ne 1) { throw "Bun checksums did not contain exactly one $Asset entry" }
$Expected = ($ExpectedLine -split "\s+")[0].ToLowerInvariant()
$Actual = (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($Actual -ne $Expected) { throw "Bun baseline SHA-256 mismatch: expected $Expected, received $Actual" }

Expand-Archive -LiteralPath $Archive -DestinationPath $Extracted
$Executables = @(Get-ChildItem -LiteralPath $Extracted -Filter bun.exe -File -Recurse)
if ($Executables.Count -ne 1) { throw "Bun baseline archive contained $($Executables.Count) bun.exe files" }
$Bun = $Executables[0].FullName
$Reported = (& $Bun --version | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $Reported -ne $Version) {
  throw "Bun baseline version mismatch: expected $Version, received $Reported"
}

Add-Content -LiteralPath $GitHubEnv -Value "CODEX_CHATGPT_WEB_EMBEDDED_BUN=$Bun" -Encoding UTF8
