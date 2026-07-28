[CmdletBinding()]
param(
  [ValidateSet("Status", "Native", "Bridge")]
  [string]$Mode = "Status",
  [string]$BridgeHome = (Join-Path $env:USERPROFILE ".codex-chatgpt-web"),
  [string]$CodexHome = (Join-Path $env:USERPROFILE ".codex"),
  [switch]$StopBridge
)

$ErrorActionPreference = "Stop"
$managedComment = '# Managed by codex-chatgpt-web; `codex-chatgpt-web uninstall` restores prior values.'
$journalPath = Join-Path $BridgeHome "codex\integration-journal.json"
$statePath = Join-Path $BridgeHome "codex\manual-route-state.json"
$configPath = Join-Path $CodexHome "config.toml"
$managedKeys = @("openai_base_url", "model_provider", "model_catalog_json")

function Read-Journal {
  if (-not (Test-Path -LiteralPath $journalPath)) {
    throw "Bridge integration journal is missing: $journalPath"
  }
  $journal = Get-Content -Raw -LiteralPath $journalPath | ConvertFrom-Json
  if ($journal.version -ne 3 -or -not $journal.installed.openai_base_url) {
    throw "Unsupported or invalid bridge integration journal: $journalPath"
  }
  return $journal
}

function Get-FirstTableIndex {
  param([Collections.Generic.List[string]]$Lines)
  $firstTable = $Lines.Count
  for ($i = 0; $i -lt $Lines.Count; $i++) {
    if ($Lines[$i] -match '^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?$') {
      return $i
    }
  }
  return $firstTable
}

function Get-TopLevelAssignment {
  param(
    [Collections.Generic.List[string]]$Lines,
    [string]$Key
  )
  $firstTable = Get-FirstTableIndex -Lines $Lines
  $assignmentMatches = @()
  for ($i = 0; $i -lt $firstTable; $i++) {
    if ($Lines[$i] -match ('^\s*' + [regex]::Escape($Key) + '\s*=\s*(.+?)\s*$')) {
      $assignmentMatches += [pscustomobject]@{ Index = $i; Line = $Lines[$i] }
    }
  }
  if ($assignmentMatches.Count -gt 1) { throw "Codex config contains multiple top-level $Key assignments" }
  return $assignmentMatches | Select-Object -First 1
}

function Remove-ManagedAssignments {
  param([Collections.Generic.List[string]]$Lines)
  $locations = foreach ($key in $managedKeys) {
    Get-TopLevelAssignment -Lines $Lines -Key $key
  }
  $locations | Where-Object { $_ } | Sort-Object Index -Descending | ForEach-Object {
    $Lines.RemoveAt($_.Index)
  }
}

function Assert-BridgeState {
  param(
    [Collections.Generic.List[string]]$Lines,
    [object]$Journal
  )
  $baseUrl = Get-TopLevelAssignment -Lines $Lines -Key "openai_base_url"
  $expected = 'openai_base_url = "' + $Journal.installed.openai_base_url + '"'
  if (-not $baseUrl -or $baseUrl.Line.Trim() -ne $expected) {
    throw "Codex openai_base_url changed after setup; refusing to overwrite it"
  }
  foreach ($key in @("model_provider", "model_catalog_json")) {
    if (Get-TopLevelAssignment -Lines $Lines -Key $key) {
      throw "Codex $key changed after setup; refusing to overwrite it"
    }
  }
  if (-not $Lines.Contains($managedComment)) {
    throw "Managed Codex route marker changed after setup; refusing to overwrite it"
  }
}

function Assert-PreviousState {
  param(
    [Collections.Generic.List[string]]$Lines,
    [object]$Journal
  )
  if ($Lines.Contains($managedComment)) {
    throw "Managed Codex route marker is still present while the bridge is disabled"
  }
  foreach ($key in $managedKeys) {
    $current = Get-TopLevelAssignment -Lines $Lines -Key $key
    $previous = $Journal.previous.PSObject.Properties[$key].Value
    if ($previous.present) {
      if (-not $previous.rawLine -or -not $current -or $current.Line.Trim() -ne ([string]$previous.rawLine).Trim()) {
        throw "Codex $key changed while the bridge was disabled; refusing to overwrite it"
      }
    } elseif ($current) {
      throw "Codex $key changed while the bridge was disabled; refusing to overwrite it"
    }
  }
}

function Restore-PreviousAssignments {
  param(
    [Collections.Generic.List[string]]$Lines,
    [object]$Journal
  )
  Remove-ManagedAssignments -Lines $Lines
  $restored = foreach ($key in $managedKeys) {
    $previous = $Journal.previous.PSObject.Properties[$key].Value
    if ($previous.present) {
      if (-not $previous.rawLine) { throw "Bridge integration journal is missing the prior $key line" }
      [pscustomobject]@{
        Index = if ($null -ne $previous.index) { [int]$previous.index } else { [int]::MaxValue }
        Line = [string]$previous.rawLine
      }
    }
  }
  $restored | Sort-Object Index | ForEach-Object {
    $index = [Math]::Min($_.Index, (Get-FirstTableIndex -Lines $Lines))
    $Lines.Insert($index, $_.Line)
  }
  $Lines.Remove($managedComment) | Out-Null
}

function Write-ConfigSafely {
  param([string[]]$Lines)
  $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $backup = "$configPath.web-bridge-backup-$timestamp"
  Copy-Item -LiteralPath $configPath -Destination $backup
  $temp = "$configPath.web-bridge-temp-$PID"
  $text = ($Lines -join "`r`n").TrimEnd() + "`r`n"
  [IO.File]::WriteAllText($temp, $text, [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temp -Destination $configPath -Force
  Write-Output "Backup: $backup"
}

function Stop-BridgeTask {
  $task = Get-ScheduledTask -TaskName "CodexChatGPTWebBridge" -ErrorAction SilentlyContinue
  if ($task -and $task.State -eq "Running") {
    Stop-ScheduledTask -TaskName "CodexChatGPTWebBridge"
    Write-Output "Stopped scheduled task: CodexChatGPTWebBridge"
  }
}

if ($Mode -eq "Status") {
  $journal = Read-Journal
  if (-not (Test-Path -LiteralPath $configPath)) { throw "Codex config is missing: $configPath" }
  $lines = [Collections.Generic.List[string]]::new()
  (Get-Content -LiteralPath $configPath).ForEach({ $lines.Add($_) })
  $detectedMode = "Custom"
  try {
    Assert-BridgeState -Lines $lines -Journal $journal
    $detectedMode = "Bridge"
  } catch {
    try {
      Assert-PreviousState -Lines $lines -Journal $journal
      $detectedMode = "Native"
    } catch {}
  }
  [pscustomobject]@{
    Mode = $detectedMode
    ConfigPath = $configPath
    BridgeUrl = $journal.installed.openai_base_url
    RecoveryState = Test-Path -LiteralPath $statePath
  }
  exit 0
}

$journal = Read-Journal
if (-not (Test-Path -LiteralPath $configPath)) { throw "Codex config is missing: $configPath" }
$lines = [Collections.Generic.List[string]]::new()
(Get-Content -LiteralPath $configPath).ForEach({ $lines.Add($_) })

if ($Mode -eq "Native") {
  $bridgeActive = $true
  try {
    Assert-BridgeState -Lines $lines -Journal $journal
  } catch {
    $bridgeStateError = $_.Exception.Message
    $bridgeActive = $false
    try {
      Assert-PreviousState -Lines $lines -Journal $journal
    } catch {
      throw "$bridgeStateError; $($_.Exception.Message)"
    }
  }
  if ($bridgeActive) {
    Restore-PreviousAssignments -Lines $lines -Journal $journal
    Write-ConfigSafely -Lines $lines
  }
  $stateDir = Split-Path -Parent $statePath
  New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
  [pscustomobject]@{
    version = 1
    disabledAt = (Get-Date).ToUniversalTime().ToString("o")
    configPath = $configPath
    bridgeUrl = $journal.installed.openai_base_url
  } | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8
  if ($StopBridge) { Stop-BridgeTask }
  Write-Output "Codex route: Native"
  Write-Output "Restart Codex Desktop before starting a new task."
  exit 0
}

Assert-PreviousState -Lines $lines -Journal $journal
Remove-ManagedAssignments -Lines $lines
$installedLine = 'openai_base_url = "' + $journal.installed.openai_base_url + '"'
$lines.Insert((Get-FirstTableIndex -Lines $lines), $installedLine)
$route = Get-TopLevelAssignment -Lines $lines -Key "openai_base_url"
$lines.Insert($route.Index + 1, $managedComment)
Write-ConfigSafely -Lines $lines
Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
Write-Output "Codex route: Bridge"
Write-Output "Restart Codex Desktop before starting a new task."
