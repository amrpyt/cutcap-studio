param(
    [switch]$Quiet
)

$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'

$Root = [System.IO.Path]::GetFullPath($PSScriptRoot)
$ServerScript = [System.IO.Path]::GetFullPath((Join-Path $Root 'server.js'))
$KnownPorts = @(37891, 37902, 37903, 37904, 37905, 37906)
$Killed = New-Object System.Collections.Generic.HashSet[int]
$StalePids = New-Object System.Collections.Generic.HashSet[int]

function Write-Status([string]$Message) {
    if (-not $Quiet) { Write-Host $Message }
}

function Get-ProcessInfo([int]$ProcessId) {
    if ($ProcessId -le 0 -or $ProcessId -eq $PID) { return $null }
    return Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
}

function Test-LooksLikeGuiNode([int]$ProcessId) {
    $p = Get-ProcessInfo $ProcessId
    if (-not $p) { return $false }
    $name = [string]$p.Name
    $cmd = [string]$p.CommandLine
    $normalizedCmd = $cmd.Replace('/', '\')
    $escapedScript = [Regex]::Escape($ServerScript.Replace('/', '\'))
    return ($name -match '^(?i)node(?:\.exe)?$' -and $normalizedCmd -match $escapedScript)
}

function Stop-ProcessTreeSafe([int]$ProcessId, [string]$Reason) {
    if ($ProcessId -le 0 -or $ProcessId -eq $PID -or $Killed.Contains($ProcessId)) { return }
    if (-not (Test-LooksLikeGuiNode $ProcessId)) { return }

    Write-Status "Stopping old Auto-Editor GUI backend PID $ProcessId ($Reason)..."
    & taskkill.exe /PID $ProcessId /T /F *> $null
    Start-Sleep -Milliseconds 150
    [void]$Killed.Add($ProcessId)
}

function Try-StopGuiOnPort([int]$Port) {
    $base = "http://127.0.0.1:$Port"
    $identified = $false
    $owners = @()
    try {
        $owners = @(Get-NetTCPConnection -State Listen -LocalAddress 127.0.0.1 -LocalPort $Port -ErrorAction Stop |
                    Select-Object -ExpandProperty OwningProcess -Unique)
    } catch {}

    # Preferred path: identify the app through its own API before killing anything.
    try {
        $health = Invoke-RestMethod -Uri "$base/api/health" -Method Get -TimeoutSec 1
        $isGui = ($health.app -eq 'auto-editor-gui')
        if ($isGui -and $health.pid -and $owners -contains [int]$health.pid -and (Test-LooksLikeGuiNode ([int]$health.pid))) {
            Stop-ProcessTreeSafe ([int]$health.pid) "port $Port"
            $identified = $true
        }
    } catch {}

    if ($identified) { return }

    # Fallback for an old/unresponsive GUI build: only consider our historical ports,
    # and only kill a Node process whose command line is server.js.
    try {
        foreach ($ownerPid in $owners) {
            if (Test-LooksLikeGuiNode ([int]$ownerPid)) {
                Stop-ProcessTreeSafe ([int]$ownerPid) "stale listener on port $Port"
            }
        }
    } catch {}
}

Write-Status 'Cleaning old Auto-Editor GUI instances...'

# 1) Stop servers recorded by this folder, but validate that the PID is really Node server.js.
$pidFiles = @(
    (Join-Path $Root '.server.pid'),
    (Join-Path $Root '.server.json')
)

$legacyPidFile = Join-Path $Root '.server.pid'
if (Test-Path $legacyPidFile) {
    try {
        $legacyPid = [int]((Get-Content $legacyPidFile -Raw).Trim())
        [void]$StalePids.Add($legacyPid)
        Stop-ProcessTreeSafe $legacyPid 'PID file'
    } catch {}
}

$instanceFile = Join-Path $Root '.server.json'
if (Test-Path $instanceFile) {
    try {
        $instance = Get-Content $instanceFile -Raw | ConvertFrom-Json
        if ($instance.pid) {
            [void]$StalePids.Add([int]$instance.pid)
            Stop-ProcessTreeSafe ([int]$instance.pid) 'instance file'
        }
    } catch {}
}

# 2) Stop any previous V1-V6 backend still listening on one of the app's historical ports.
foreach ($port in $KnownPorts) { Try-StopGuiOnPort $port }

# Give Windows a short moment to release sockets and child handles.
Start-Sleep -Milliseconds 350

# 3) Remove stale local instance/launcher artifacts.
$localArtifacts = @(
    '.server.pid',
    '.server.json',
    '.launch.lock',
    '.startup.tmp'
)
foreach ($name in $localArtifacts) {
    Remove-Item -LiteralPath (Join-Path $Root $name) -Force -ErrorAction SilentlyContinue
}

# 4) Remove stale temp files created by this GUI. Recent files may belong to another running custom-port instance.
$temp = [System.IO.Path]::GetTempPath()
foreach ($stalePid in $StalePids) {
    Get-ChildItem -LiteralPath $temp -Filter "ae-preview-$stalePid-*.mp4" -File -ErrorAction SilentlyContinue |
        Remove-Item -Force -ErrorAction SilentlyContinue
}
$old = (Get-Date).AddDays(-1)
foreach ($filter in @('ae-cuts-*.v1', 'ae-gui-picker-*.txt', 'ae-preview-*.mp4')) {
    Get-ChildItem -LiteralPath $temp -Filter $filter -File -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime -lt $old } |
        Remove-Item -Force -ErrorAction SilentlyContinue
}

Write-Status "Cleanup complete. Stopped $($Killed.Count) old backend process(es)."
exit 0
