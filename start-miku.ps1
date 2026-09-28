<#
.SYNOPSIS
    One-click startup for the AI companion: face first, then the brain.

.DESCRIPTION
    Starts the Electron face in the background, waits for its WebSocket bridge
    to actually accept connections on 127.0.0.1:8765, resolves the microphone
    by name rather than by index, and only then opens a visible terminal for
    brain.py so her replies and the REPL are visible and typeable.

    Two decisions worth stating, because both depart from a literal reading of
    the original request:

    1. Microphone matching is NOT restricted to the MME host API. The Rockerz
       headset is not exposed on MME at all - MME only lists 'Microsoft Sound
       Mapper - Input' and 'Microphone (Realtek(R) Audio)'. The headset appears
       on WDM-KS, named by the driver as
       'Headset (@System32\drivers\bthhfenum.sys,#2;%1 Hands-Free%0;(Rockerz 425 ))'.
       A strict MME-only search finds nothing and falls back to the system
       default, which is the empty motherboard jack - the exact failure this
       whole mechanism exists to prevent. MME is still tried first when it
       does expose the device; the search simply falls through to the other
       host APIs instead of giving up.

    2. The matched substring is 'Rockerz 425', not 'Headset (Rockerz 425'.
       The Bluetooth driver rewrites the friendly device name and inserts its
       own prefix, so 'Headset (Rockerz 425' is not a substring of any
       enumerated name and matches nothing. The distinctive part of the name
       is the reliable token.

.NOTES
    Paths are always quoted: the project directory contains a space.
#>

[CmdletBinding()]
param(
    # Device names are matched in this order; first hit wins.
    [string[]] $MicNeedle = @('Rockerz 425', 'Rockerz'),

    # How long to wait for the face's bridge to start listening.
    [int] $BridgeTimeoutSeconds = 60,

    # Skip launching the face if something is already serving the bridge port.
    [switch] $NoFace
)

$ErrorActionPreference = 'Stop'

$BridgeHost = '127.0.0.1'
$BridgePort = 8765

# Resolve paths relative to this script so the launch location does not matter.
$Root      = Split-Path -Parent $MyInvocation.MyCommand.Path
$FaceDir   = Join-Path $Root 'face'
$BrainDir  = Join-Path $Root 'brain'
$BrainPy   = Join-Path $BrainDir '.venv\Scripts\python.exe'
$LogsDir   = Join-Path $Root 'brain'

function Write-Stage {
    param([string] $Message)
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Warn2 {
    param([string] $Message)
    Write-Host "!!  $Message" -ForegroundColor Yellow
}

function Write-Fail {
    param([string] $Message)
    Write-Host "XX  $Message" -ForegroundColor Red
}

function Test-BridgePort {
    <#
        True when something accepts a TCP connection on the bridge port.
        A connect attempt, not a sleep: the previous approach of waiting a
        fixed interval either wastes time or gives up before Electron is ready.
    #>
    param([string] $Address, [int] $Port, [int] $TimeoutMs = 400)

    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $async = $client.BeginConnect($Address, $Port, $null, $null)
        if (-not $async.AsyncWaitHandle.WaitOne($TimeoutMs, $false)) {
            return $false
        }
        $client.EndConnect($async)
        return $true
    }
    catch {
        return $false
    }
    finally {
        $client.Close()
    }
}

# ── Preflight ───────────────────────────────────────────────────────────
Write-Stage "checking the project layout"

foreach ($required in @($FaceDir, $BrainDir)) {
    if (-not (Test-Path -LiteralPath $required)) {
        Write-Fail "missing directory: $required"
        exit 1
    }
}
if (-not (Test-Path -LiteralPath $BrainPy)) {
    Write-Fail "brain virtualenv not found: $BrainPy"
    Write-Host "    create it with:  python -m venv .venv   (inside brain\)"
    Write-Host "    then:            .\.venv\Scripts\python.exe -m pip install -r requirements.txt"
    exit 1
}
Write-Host "    project : $Root"
Write-Host "    brain   : $($BrainPy -replace [regex]::Escape($Root), '<project>')"

# ── Face ────────────────────────────────────────────────────────────────
if (Test-BridgePort -Address $BridgeHost -Port $BridgePort) {
    Write-Stage "bridge already listening on ${BridgeHost}:$BridgePort - not starting a second face"
}
elseif ($NoFace) {
    Write-Fail "-NoFace was given but no face is serving ${BridgeHost}:$BridgePort"
    exit 1
}
else {
    Write-Stage "starting the face (npm start in face\), this takes a moment"

    if (Get-Command npm.cmd -ErrorAction SilentlyContinue) {
        $npm = 'npm.cmd'
    }
    elseif (Get-Command npm -ErrorAction SilentlyContinue) {
        $npm = 'npm'
    }
    else {
        Write-Fail "npm was not found on PATH. Install Node.js 18+ and reopen this window."
        exit 1
    }

    # Two separate files: Start-Process refuses to redirect stdout and stderr
    # to one path, and a shared handle would interleave the two streams
    # unreliably anyway.
    $OutLog = Join-Path $BrainDir 'start-miku.out.log'
    $ErrLog = Join-Path $BrainDir 'start-miku.err.log'
    $StartLog = $OutLog

    try {
        $face = Start-Process -FilePath $npm `
                               -ArgumentList 'start' `
                               -WorkingDirectory $FaceDir `
                               -WindowStyle Minimized `
                               -PassThru `
                               -RedirectStandardOutput $OutLog `
                               -RedirectStandardError  $ErrLog
    }
    catch {
        Write-Fail "could not launch npm: $($_.Exception.Message)"
        exit 1
    }

    Write-Host "    npm pid $($face.Id), log: $StartLog"

    Write-Stage "waiting for the bridge on ${BridgeHost}:$BridgePort (up to ${BridgeTimeoutSeconds}s)"
    $deadline = (Get-Date).AddSeconds($BridgeTimeoutSeconds)
    $ready = $false
    $lastTick = Get-Date

    while ((Get-Date) -lt $deadline) {
        if (Test-BridgePort -Address $BridgeHost -Port $BridgePort) {
            $ready = $true
            break
        }
        $tail = @()
        foreach ($candidate in @($OutLog, $ErrLog)) {
            if (Test-Path -LiteralPath $candidate) {
                $tail += Get-Content -LiteralPath $candidate -Tail 20 -ErrorAction SilentlyContinue
            }
        }
        $text = $tail -join "`n"
        if ($text -match 'Failed to load|error TS\d+|Cannot find module|ERR_MODULE_NOT_FOUND') {
            Write-Fail "the face reported a build or load error:"
            Write-Host ($tail | Select-Object -Last 12) -ForegroundColor Red
            Write-Host "    logs: $OutLog , $ErrLog"
            exit 1
        }
        if (((Get-Date) - $lastTick).TotalSeconds -ge 5) {
            $left = [int]($deadline - (Get-Date)).TotalSeconds
            Write-Host "    ...still waiting (${left}s left)"
            $lastTick = Get-Date
        }
        Start-Sleep -Milliseconds 250
    }

    if (-not $ready) {
        Write-Fail "the bridge never opened ${BridgeHost}:$BridgePort within ${BridgeTimeoutSeconds}s"
        foreach ($candidate in @($OutLog, $ErrLog)) {
            if (Test-Path -LiteralPath $candidate) {
                Write-Host "    $(Split-Path -Leaf $candidate) :" -ForegroundColor DarkGray
                Write-Host ((Get-Content -LiteralPath $candidate -Tail 10)) -ForegroundColor DarkGray
            }
        }
        Write-Host "    try starting the face by hand:  cd `"$FaceDir`"; npm start"
        exit 1
    }
    Write-Host "    bridge is up."
}

# ── Microphone, resolved by name ────────────────────────────────────────
Write-Stage "looking for the microphone by name"

# sounddevice enumeration, with the host API reported so the choice is
# explainable. Written to a temp script rather than passed with -c so that
# quoting survives both PowerShell and the venv's python.
$probe = Join-Path $env:TEMP 'miku-mic-probe.py'
@'
import sys
import time
import sounddevice as sd

needles = sys.argv[1:]
devices = sd.query_devices()
inputs = [
    (i, d["name"], d["hostapi"], int(d["default_samplerate"]))
    for i, d in enumerate(devices)
    if d["max_input_channels"] >= 1
]
try:
    apis = [a["name"] for a in sd.query_hostapis()]
except Exception:
    apis = []


def clean(text):
    # The Bluetooth driver embeds CR/LF and percent escapes in the device name
    # ('Headset (@System32\\drivers\\bthhfenum.sys,#2;%1 Hands-Free%0\\r\\n;...)').
    # Left alone those newlines break the tab-separated output: the name field
    # spills onto following lines and every later field shifts out of position.
    return " ".join(str(text).split())


def can_open(index, rate):
    """
    A device can be listed and still be unusable.

    When the headset drops off Bluetooth, Windows leaves ghost entries behind on
    WDM-KS that still match on name but fail to open ('WdmSyncIoctl: DeviceIoControl
    GLE = 0x0000048F' / 'Blocking API not supported yet'). Selecting one of those
    looks like a successful match and then breaks recording at startup, so a
    candidate is only accepted if a stream actually opens. This is the same call
    brain/voice_input.py makes, so the probe cannot pass a device the brain
    cannot use.
    """
    try:
        stream = sd.RawInputStream(
            samplerate=rate, blocksize=0, device=index,
            channels=1, dtype="int16",
            callback=lambda a, b, c, e: None,
        )
        stream.start()
        time.sleep(0.15)
        stream.stop()
        stream.close()
        return True
    except Exception:
        return False


def rank(row):
    # MME first, then the rest, then lowest index: a stable order.
    return (0 if row[2] == 0 else 1, row[0])


for needle in needles:
    low = needle.lower()
    hits = sorted([r for r in inputs if low in r[1].lower()], key=rank)
    # Prefer a candidate that can actually be opened. If none of the name
    # matches work, keep looking rather than returning a dead device.
    for idx, name, hostapi, rate in hits:
        if not can_open(idx, rate):
            continue
        api_name = apis[hostapi] if 0 <= hostapi < len(apis) else str(hostapi)
        print("OK\t{}\t{}\t{}\t{}".format(
            clean(idx), clean(name), clean(api_name), clean(rate)))
        sys.exit(0)

# Named devices exist but none of them can be opened. Distinguished from a
# total miss, because the fix is "reconnect the headset", not "pick another mic".
if any(needle.lower() in r[1].lower() for needle in needles for r in inputs):
    print("DEAD\t\t\t\t")
    sys.exit(2)

print("NONE\t\t\t\t")
sys.exit(1)
'@ | Set-Content -LiteralPath $probe -Encoding UTF8

$micIndex = $null
$micName  = ''
$micApi   = ''
$micRate  = ''

$probeOutput = & $BrainPy $probe @MicNeedle 2>&1
$probeExit = $LASTEXITCODE
$firstLine = ($probeOutput | Select-Object -First 1)
if ($firstLine) { $firstLine = "$firstLine".Trim() }

if ($probeExit -eq 0 -and $firstLine -like 'OK*') {
    $parts = $firstLine -split "`t"
    $micIndex = $parts[1].Trim()
    $micName  = $parts[2].Trim()
    $micApi   = $parts[3].Trim()
    $micRate  = $parts[4].Trim()
    Write-Host "    found: index $micIndex - $micName"
    Write-Host "    host API: $micApi, ${micRate} Hz"
}
elseif ($probeExit -eq 2) {
    # Matched by name, but the device would not open. Almost always a Bluetooth
    # headset that has dropped off, leaving a stale WDM-KS entry behind.
    Write-Warn2 "found a device named like the headset, but Windows would not open it."
    Write-Warn2 "that is what a disconnected Bluetooth headset looks like: the name"
    Write-Warn2 "survives, the device does not."
    Write-Warn2 "reconnect the headset, then run this again."
    Write-Warn2 "starting anyway on the SYSTEM DEFAULT microphone - she will not hear you."
}
else {
    Write-Warn2 "no input device matched any of: $($MicNeedle -join ', ')"
    Write-Warn2 "falling back to the SYSTEM DEFAULT microphone."
    Write-Warn2 "if she cannot hear you, run  !mic  in her window for current device names."
}

Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue

# ── Brain, in a visible window ──────────────────────────────────────────
Write-Stage "starting the brain in a new window"

# A resolved index is passed as a number; without a match, BRAIN_MIC is left
# unset so brain.py applies its own default path and prints its own warning.
if ($micIndex) { $env:BRAIN_MIC = $micIndex }

# Voice needs the key; text does not, so a missing key is a warning, not a stop.
if (-not $env:FISH_AUDIO_API_KEY) {
    Write-Warn2 "FISH_AUDIO_API_KEY is not set in this environment - she will be text-only."
    Write-Warn2 "set it for the user profile:  [Environment]::SetEnvironmentVariable('FISH_AUDIO_API_KEY', '<key>', 'User')"
}

$brainCommand = "Set-Location -LiteralPath '$BrainDir'; & '$BrainPy' 'brain.py'"

$brain = Start-Process -FilePath 'powershell.exe' `
                       -ArgumentList '-NoExit', '-Command', $brainCommand `
                       -WorkingDirectory $BrainDir `
                       -PassThru

Start-Sleep -Milliseconds 600
if ($brain.HasExited) {
    Write-Fail "the brain window closed immediately."
    Write-Host "    run it by hand to see the error:"
    Write-Host "    Set-Location -LiteralPath '$BrainDir'; & '$BrainPy' 'brain.py'"
    exit 1
}

Write-Host "    brain pid $($brain.Id)"
Write-Host ""
Write-Host "Ready. Her replies are in the new window; Ctrl+C or 'exit' closes it." -ForegroundColor Green
Write-Host "To stop everything:  .\stop-miku.bat" -ForegroundColor Green
exit 0
