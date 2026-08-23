$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

if ($PSVersionTable.PSVersion.Major -lt 6) {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
}

function Invoke-WithRetry {
  param(
    [Parameter(Mandatory = $true)][scriptblock]$Operation,
    [Parameter(Mandatory = $true)][string]$Label
  )
  for ($Attempt = 1; $Attempt -le 3; $Attempt++) {
    try {
      return & $Operation
    } catch {
      if ($Attempt -eq 3) {
        throw "$Label failed after $Attempt attempts: $($_.Exception.Message)"
      }
      Start-Sleep -Seconds (2 * $Attempt)
    }
  }
}

$Repository = if ($env:CODEX_WEB_GPT_REPOSITORY) { $env:CODEX_WEB_GPT_REPOSITORY } else { "naakto14/codex-chatgpt-web" }
if ($Repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') {
  throw "Invalid GitHub repository: $Repository"
}
$Version = $env:CODEX_WEB_GPT_VERSION
if (-not $Version) {
  $Release = Invoke-WithRetry -Label "Resolving the latest release" -Operation {
    Invoke-RestMethod "https://api.github.com/repos/$Repository/releases/latest" -TimeoutSec 60
  }
  $Version = [string]$Release.tag_name
}
if ($Version -and $Version.StartsWith("v")) { $Version = $Version.Substring(1) }
if (-not $Version) { throw "Could not resolve the latest Codex Web GPT release" }
if ($Version -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { throw "Invalid release version: $Version" }

if (-not [Environment]::Is64BitOperatingSystem) {
  throw "The packaged Windows launcher requires 64-bit Windows"
}
$Arch = "x64"

$Asset = "codex-web-gpt-$Version-win-$Arch.exe"
$BaseUrl = "https://github.com/$Repository/releases/download/v$Version"
$Temp = Join-Path ([System.IO.Path]::GetTempPath()) "codex-web-gpt-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $Temp | Out-Null
try {
  if (Get-Process -Name "Codex Web GPT" -ErrorAction SilentlyContinue) {
    throw "Quit Codex Web GPT before updating it"
  }
  $Installer = Join-Path $Temp $Asset
  $Checksums = Join-Path $Temp "checksums.txt"
  $null = Invoke-WithRetry -Label "Downloading $Asset" -Operation {
    Remove-Item $Installer -Force -ErrorAction SilentlyContinue
    Invoke-WebRequest "$BaseUrl/$Asset" -OutFile $Installer -TimeoutSec 900 -UseBasicParsing
  }
  $null = Invoke-WithRetry -Label "Downloading checksums.txt" -Operation {
    Remove-Item $Checksums -Force -ErrorAction SilentlyContinue
    Invoke-WebRequest "$BaseUrl/checksums.txt" -OutFile $Checksums -TimeoutSec 60 -UseBasicParsing
  }
  $ExpectedLine = Get-Content $Checksums | Where-Object { $_ -match "\s$([regex]::Escape($Asset))$" } | Select-Object -First 1
  if (-not $ExpectedLine) { throw "checksums.txt has no entry for $Asset" }
  $Expected = ($ExpectedLine -split "\s+")[0].ToLowerInvariant()
  $Actual = (Get-FileHash -Algorithm SHA256 $Installer).Hash.ToLowerInvariant()
  if ($Actual -ne $Expected) { throw "SHA-256 verification failed for $Asset" }
  $Process = Start-Process -FilePath $Installer -ArgumentList "/S", "/currentuser" -Wait -PassThru
  if ($Process.ExitCode -ne 0) { throw "Installer exited with code $($Process.ExitCode)" }
  $InstallRegistry = "HKCU:\Software\d1a6026a-6210-588e-9a2b-da3936f94e02"
  $InstallLocation = [string](Get-ItemPropertyValue -LiteralPath $InstallRegistry -Name "InstallLocation")
  if (-not [System.IO.Path]::IsPathFullyQualified($InstallLocation)) {
    throw "Installer recorded an invalid InstallLocation: $InstallLocation"
  }
  $Executable = Join-Path $InstallLocation "Codex Web GPT.exe"
  if (-not (Test-Path $Executable)) { throw "Installed launcher was not found at $Executable" }
  Start-Process $Executable
  Write-Host "Installed $Executable"
} finally {
  Remove-Item -Recurse -Force $Temp -ErrorAction SilentlyContinue
}
