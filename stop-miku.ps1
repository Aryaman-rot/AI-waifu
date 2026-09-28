<#
.SYNOPSIS
    Stop the AI companion: the face (Electron) and the brain (Python).

.DESCRIPTION
    Kills both halves by process identity rather than by image name alone.
    'Stop-Process -Name electron' would also close every other Electron app
    the user happens to be running (VS Code is Electron, Discord is Electron),
    so processes are matched on their command line or executable path against
    this project directory.

    The brain is matched on its venv python and its script path, for the same
    reason: a bare 'python' would take out unrelated interpreters.

.NOTES
    Refuses to act if this script is not being run from the project directory,
    as a guard against the path matching being wrong.
#>

[CmdletBinding()]
param(
    [switch] $Quiet
)

$ErrorActionPreference = 'Continue'

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$FaceDir = Join-Path $Root 'face'
$BrainDir = Join-Path $Root 'brain'
$BrainPy = Join-Path $BrainDir '.venv\Scripts\python.exe'

if (-not (Test-Path -LiteralPath $FaceDir) -or -not (Test-Path -LiteralPath $BrainDir)) {
    Write-Host "XX  this script must live in the project root (found neither face\ nor brain\ next to it)." -ForegroundColor Red
    exit 1
}

function Say {
    param([string] $Message, [string] $Color = 'Gray')
    if (-not $Quiet) { Write-Host $Message -ForegroundColor $Color }
}

# CIM gives CommandLine, which Get-Process does not expose. Win32_Process is
# used instead of Get-CimInstance for the same reason on older Windows.
$all = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue
if (-not $all) {
    Write-Host "XX  could not enumerate processes." -ForegroundColor Red
    exit 1
}

$stoppedFace = 0
$stoppedBrain = 0
$stoppedConsole = 0

foreach ($proc in $all) {
    $name = $proc.Name
    $cmd = [string] $proc.CommandLine
    $pidToKill = $proc.ProcessId

    if ($pidToKill -eq $PID) { continue }

    # ── the face: electron running from this project's node_modules ──
    if ($name -ieq 'electron.exe' -and $cmd -like "*$FaceDir*") {
        if ($cmd -match '--type=') { continue }   # let the parent kill its renderers
        Say "  face    pid $pidToKill"
        try { Stop-Process -Id $pidToKill -Force -ErrorAction Stop; $stoppedFace++ } catch { }
        continue
    }

    # ── the brain ──
    # Matched on CommandLine, not ExecutablePath, and deliberately so. A venv's
    # python.exe is a launcher shim: it spawns the *real* interpreter (here
    # C:\Program Files\Python314\python.exe) as a child process, and that child
    # is the one actually reading the microphone. Matching on ExecutablePath
    # would kill the shim, leave the child running, and leave the mic held open.
    # Both processes carry the same venv path and 'brain.py' in their command
    # line, so one test catches both.
    if ($name -ieq 'python.exe' -and $cmd -like '*brain.py*' -and $cmd -like "*$BrainDir*") {
        Say "  brain   pid $pidToKill"
        try { Stop-Process -Id $pidToKill -Force -ErrorAction Stop; $stoppedBrain++ } catch { }
        continue
    }

    # ── the console window the launcher opened for the brain ──
    if ($name -ieq 'powershell.exe' -and $cmd -like "*$BrainPy*" -and $cmd -like '*brain.py*') {
        Say "  console pid $pidToKill"
        try { Stop-Process -Id $pidToKill -Force -ErrorAction Stop; $stoppedConsole++ } catch { }
        continue
    }
}

# Electron renderers and GPU processes are children of the main process and
# normally exit with it; any stragglers are swept up after a short grace.
Start-Sleep -Milliseconds 800
$stragglers = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -ieq 'electron.exe' -and $_.CommandLine -like "*$FaceDir*" }
foreach ($proc in $stragglers) {
    try { Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop; $stoppedFace++ } catch { }
}

if ($stoppedFace -eq 0 -and $stoppedBrain -eq 0 -and $stoppedConsole -eq 0) {
    Say "nothing was running."
    exit 0
}

Say ""
Say "stopped: $stoppedFace face, $stoppedBrain brain, $stoppedConsole console" 'Green'
exit 0
