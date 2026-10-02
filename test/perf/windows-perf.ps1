<#
Beam for Windows: speed and idle-cost check. Prints a table; exits 1 if a budget fails.

  powershell -ExecutionPolicy Bypass -File test\perf\windows-perf.ps1 [-Exe <Beam.exe>] [-IdleSec 60] [-TransferMB 256]
      [-ReleaseSec 20] [-WebViewSettleSec 150] [-Netsim] [-NoBudgets] [-Keep] [-Json <file>]

About 7 minutes with the defaults and -Netsim (the release check; plan/speed-results-windows.md used -IdleSec 600).
WebView2 CPU: a fresh profile's own start-up (browser and network service processes) costs a few hundred ms/min for
its first 2-3 minutes, whatever the page does. So the open-window idle phase starts after -WebViewSettleSec, and the
renderer (the page itself) is also reported on its own; transfers report the renderer only.
Measures: start -> tray ready / connected, idle CPU and memory with the window never opened and open, the event
streams per PC, opening the window cold / warm / after release, uploads and downloads (direct and through netsim), and
on Beam 1.4 servers the native stream's heartbeat and how soon a received file is saved after the sender finished.
The app writes the timings itself ("Perf: ..." lines in beam.log). Budgets are at the end of this file.

Isolation (never the installed Beam or its profile):
- a scratch server (server.js from this checkout) on 127.0.0.1:8801-8809 with its own data folder;
- a copy of Beam.exe run with --config <temp>\config.json (its own single-instance lock and pipe, WebView2 profile,
  Send to/outbox/downloads folders; no Run key, no hotkeys), quiet (no tray icon, no notifications) and testOffscreen
  (windows open off-screen and never take the focus);
- the window is opened and hidden with command-line forwarding (--show / --hide), never with mouse or keyboard input;
- -Netsim adds a round trip through test/perf/netsim.mjs (25 ms, 400 Mbit/s) on 8851-8859 for the transfers.
#>
param(
  [string]$Exe = '',
  [int]$Port = 8801,
  [int]$NetsimPort = 8851,
  [int]$IdleSec = 60,
  [int]$TransferMB = 256,
  [int]$ReleaseSec = 20,   # the hidden window's web view is released after this (the app's default is 180)
  [int]$WebViewSettleSec = 150,   # after opening the window cold, before its idle phase (WebView2's own start-up)
  [switch]$Netsim,
  [switch]$NoBudgets,
  [switch]$Keep,
  [string]$Json = ''
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (-not $Exe) {
  $Exe = Join-Path $root 'windows\bin\Beam.exe'
  if (-not (Test-Path $Exe)) { $Exe = Join-Path $root 'dist\Beam.exe' }
}
if (-not (Test-Path $Exe)) { throw "No Beam.exe: build with windows\build.cmd or pass -Exe" }
if ($Port -lt 8801 -or $Port -gt 8809) { throw 'The Windows perf check uses ports 8801-8809' }
if ($NetsimPort -lt 8851 -or $NetsimPort -gt 8859) { throw 'netsim ports for Windows are 8851-8859' }
$node = (Get-Command node).Source
$tmp = Join-Path $env:TEMP ('beam-perf-win-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$cfgDir = Join-Path $tmp 'cfg'
$cfg = Join-Path $cfgDir 'config.json'
$log = Join-Path $cfgDir 'beam.log'
$profileDir = Join-Path $cfgDir 'WebView2'
New-Item -ItemType Directory -Force (Join-Path $tmp 'data'), (Join-Path $tmp 'dist'), $cfgDir, (Join-Path $tmp 'files'), (Join-Path $tmp 'app') | Out-Null
$appExe = Join-Path $tmp 'app\Beam.exe'
Copy-Item $Exe $appExe   # updates and self-install logic only ever see this copy
$results = [ordered]@{}
$script:startedAt = Get-Date
$procs = @()
$appPid = 0

function Say([string]$s) { Write-Host ("[{0:HH:mm:ss}] {1}" -f (Get-Date), $s) }

function Start-Node([string]$script, [string[]]$arguments, [hashtable]$envs, [string]$name) {
  $saved = @{}
  foreach ($k in $envs.Keys) { $saved[$k] = [Environment]::GetEnvironmentVariable($k); [Environment]::SetEnvironmentVariable($k, $envs[$k]) }
  try {
    $argList = @("`"$script`"") + $arguments
    $p = Start-Process -FilePath $node -ArgumentList $argList -WorkingDirectory $root -WindowStyle Hidden -PassThru `
      -RedirectStandardOutput (Join-Path $tmp "$name.out.log") -RedirectStandardError (Join-Path $tmp "$name.err.log")
  } finally {
    foreach ($k in $envs.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k]) }
  }
  $script:procs += $p
  return $p
}

function Wait-Http([string]$url, [int]$sec) {
  $until = (Get-Date).AddSeconds($sec)
  while ((Get-Date) -lt $until) {
    try { $r = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 2; if ($r.StatusCode -eq 200) { return } } catch { }
    Start-Sleep -Milliseconds 200
  }
  throw "Nothing answers at $url"
}

function Read-Shared([string]$path) {
  # The app appends meanwhile: open it shared, and don't let a moment's lock fail the run.
  for ($try = 0; $try -lt 5; $try++) {
    try {
      $fs = [IO.File]::Open($path, 'Open', 'Read', 'ReadWrite, Delete')
      try { $sr = New-Object IO.StreamReader($fs); return @($sr.ReadToEnd() -split "`r?`n" | Where-Object { $_ -ne '' }) } finally { $fs.Dispose() }
    } catch { Start-Sleep -Milliseconds 50 }
  }
  return @()
}

# beam.log's lines, counted from the start of the run: the app moves a log over 1 MB to beam.log.old and starts a new
# one, so the lines of the old one come first (a line index taken before the move stays valid).
$script:rotatedLines = @()
function Log-Lines() {
  $now = if (Test-Path $log) { Read-Shared $log } else { @() }
  $old = Join-Path $cfgDir 'beam.log.old'
  if ((Test-Path $old) -and ((Get-Item $old).LastWriteTime -gt $script:startedAt)) {
    $rot = Read-Shared $old
    if ($rot.Count -gt $script:rotatedLines.Count) { $script:rotatedLines = $rot }
  }
  return @($script:rotatedLines) + @($now)
}

# Waits for a beam.log line (after line index $from) matching $pattern; returns the regex match.
function Wait-Log([string]$pattern, [int]$from, [int]$sec) {
  $until = (Get-Date).AddSeconds($sec)
  while ((Get-Date) -lt $until) {
    $lines = Log-Lines
    for ($i = $from; $i -lt $lines.Count; $i++) {
      $m = [regex]::Match($lines[$i], $pattern)
      if ($m.Success) { return $m }
    }
    Start-Sleep -Milliseconds 150
  }
  # Evidence for an intermittent failure: what the app wrote since, and the server's last lines (the folder is kept).
  $lines = Log-Lines
  Say "beam.log since the wait began:"
  foreach ($l in $lines[[math]::Max(0, [math]::Min($from, $lines.Count))..([math]::Max(0, $lines.Count - 1))]) { if ($l) { Write-Host "    $l" } }
  $srv = Join-Path $tmp 'server.out.log'
  if (Test-Path $srv) { Say "server log, last 25 lines:"; foreach ($l in @(Read-Shared $srv | Select-Object -Last 25)) { Write-Host "    $l" } }
  throw "Timed out waiting for log line /$pattern/"
}

function Invoke-App([string[]]$more) {
  $a = @('--config', "`"$cfg`"") + $more
  Start-Process -FilePath $appExe -ArgumentList $a -Wait -WindowStyle Hidden
}

# Beam.exe plus this instance's WebView2 processes (their command lines carry the test profile folder).
# Beam.exe's CPU from its cycle count (QueryProcessCycleTime): Windows' thread times move in 15.6 ms ticks, too coarse
# for an idle app over a minute. Cycles are turned into ms with the processor's nominal clock.
Add-Type -Namespace BeamPerf -Name Cycles -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("kernel32.dll")] public static extern bool QueryProcessCycleTime(System.IntPtr process, out ulong cycles);
'@
$script:cpuMHz = [double](Get-ItemProperty 'HKLM:\HARDWARE\DESCRIPTION\System\CentralProcessor\0' -Name '~MHz').'~MHz'
function CpuMs($proc) {
  if (-not $proc) { return 0 }
  try {
    $cycles = [uint64]0
    if ([BeamPerf.Cycles]::QueryProcessCycleTime($proc.Handle, [ref]$cycles)) { return $cycles / ($script:cpuMHz * 1000.0) }
  } catch { }   # a process that can't be opened that far (e.g. a sandboxed renderer): thread times instead
  try { return $proc.TotalProcessorTime.TotalMilliseconds } catch { return 0 }
}

function Sample() {
  $app = Get-Process -Id $script:appPid -ErrorAction SilentlyContinue
  $wv = @()
  $wvCpu = 0.0; $wvPriv = 0.0; $wvRenderer = 0.0
  foreach ($c in @(Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'")) {
    if ($c.CommandLine -and $c.CommandLine.IndexOf($profileDir, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
      $p = Get-Process -Id $c.ProcessId -ErrorAction SilentlyContinue
      if ($p) {
        $wv += $p
        $ms = CpuMs $p
        $wvCpu += $ms
        $wvPriv += $p.PrivateMemorySize64
        if ($c.CommandLine -match '--type=renderer') { $wvRenderer += $ms }   # the page itself
      }
    }
  }
  [pscustomobject]@{
    At = Get-Date
    AppCpu = CpuMs $app
    AppPriv = if ($app) { $app.PrivateMemorySize64 / 1MB } else { 0 }
    AppWs = if ($app) { $app.WorkingSet64 / 1MB } else { 0 }
    WvCount = $wv.Count
    WvCpu = $wvCpu
    WvRendererCpu = $wvRenderer
    WvPriv = $wvPriv / 1MB
    WvPids = @($wv | ForEach-Object { $_.Id })
  }
}

# Long-lived connections to the server (after a quiet spell, keep-alive sockets are gone: these are event streams).
function Streams([int]$serverPort, $sample) {
  $conns = @(Get-NetTCPConnection -RemotePort $serverPort -State Established -ErrorAction SilentlyContinue)
  $app = @($conns | Where-Object { $_.OwningProcess -eq $script:appPid }).Count
  $web = @($conns | Where-Object { $sample.WvPids -contains $_.OwningProcess }).Count
  return "$app + $web"
}

function Idle([string]$name, [int]$sec) {
  $a = Sample
  Start-Sleep -Seconds $sec
  $b = Sample
  $mins = ($b.At - $a.At).TotalMinutes
  $results["$name Beam.exe CPU (ms/min)"] = [math]::Round(($b.AppCpu - $a.AppCpu) / $mins, 1)
  $results["$name Beam.exe private (MB)"] = [math]::Round($b.AppPriv, 1)
  $results["$name WebView2 processes"] = $b.WvCount
  $results["$name WebView2 CPU (ms/min)"] = if ($b.WvCount -gt 0 -and $a.WvCount -gt 0) { [math]::Round(($b.WvCpu - $a.WvCpu) / $mins, 1) } else { 0 }
  $results["$name WebView2 renderer CPU (ms/min)"] = if ($b.WvCount -gt 0 -and $a.WvCount -gt 0) { [math]::Round(($b.WvRendererCpu - $a.WvRendererCpu) / $mins, 1) } else { 0 }
  $results["$name WebView2 private (MB)"] = [math]::Round($b.WvPriv, 1)
  return $b
}

# Writes the server made to this app's native event stream so far (GET /api/metrics, Beam 1.4); -1 if unknown.
function StreamWrites() {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Uri "$base/api/metrics" -Headers @{ Authorization = "Bearer $script:key" } -TimeoutSec 5
    $m = $r.Content | ConvertFrom-Json
    $total = 0; $found = $false
    foreach ($st in @($m.streams)) { if ($st.device -eq $script:deviceId -and $st.kind -ne 'web') { $total += [long]$st.writes; $found = $true; $script:streamPing = [int]$st.ping } }
    if ($found) { return $total } else { return -1 }
  } catch { return -1 }
}
$script:streamPing = 0

function New-RandomFile([string]$path, [int]$mb) {
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  $buf = New-Object byte[] (4MB)
  $fs = [IO.File]::Create($path)
  try { for ($i = 0; $i -lt [math]::Ceiling($mb / 4); $i++) { $rng.GetBytes($buf); $fs.Write($buf, 0, $buf.Length) } } finally { $fs.Close() }
}

# Upload with the window open (as when sending from the chat), download with it hidden (receiving in the background).
function Transfers([string]$tag, [string]$peerBase) {
  $file = Join-Path $tmp "files\up-$tag.bin"
  New-RandomFile $file $TransferMB
  Invoke-App @('--show')
  Start-Sleep -Seconds 6
  $from = (Log-Lines).Count
  $a = Sample
  Invoke-App @('--send', '--to', 'perfphone0001perfphone0001', "`"$file`"")
  $m = Wait-Log 'Upload up:\S+ finished as item \S+ \(([\d.]+) MB in ([\d.]+) s, ([\d.]+) MB/s\)' $from (60 + $TransferMB)
  $b = Sample
  $results["upload $tag (MB/s)"] = [double]$m.Groups[3].Value
  $results["upload $tag Beam.exe CPU (ms/GB)"] = [math]::Round(($b.AppCpu - $a.AppCpu) / ($TransferMB / 1024.0))
  if ($a.WvCount -gt 0 -and $b.WvCount -gt 0) {
    # the open window drawing the progress (transfer events): the renderer only, as the web view was just recreated
    # and its other processes are still starting up
    $results["upload $tag WebView2 renderer CPU (ms/GB)"] = [math]::Round(($b.WvRendererCpu - $a.WvRendererCpu) / ($TransferMB / 1024.0))
  }
  Invoke-App @('--hide')
  Start-Sleep -Seconds 3
  $file2 = Join-Path $tmp "files\down-$tag.bin"
  New-RandomFile $file2 $TransferMB
  $from = (Log-Lines).Count
  $a = Sample   # before the peer starts: the app only sees upload events until the item arrives
  $peer = & $node (Join-Path $PSScriptRoot 'windows-peer.mjs') $peerBase $script:key upload $script:deviceId $file2 | ConvertFrom-Json
  $senderDone = Get-Date
  $results["reference: node upload $tag (MB/s)"] = $peer.mbps   # the same server without Beam.exe: what the server allows
  $mid = Sample
  $results["while the peer uploads $tag Beam.exe CPU (ms)"] = [math]::Round($mid.AppCpu - $a.AppCpu)
  $a = $mid
  $m = Wait-Log ('Saved down:' + $peer.id + ' to .+ \(([\d.]+) MB in ([\d.]+) s, ([\d.]+) MB/s\)') $from (60 + $TransferMB)
  $b = Sample
  $results["download $tag (MB/s)"] = [double]$m.Groups[3].Value
  $results["download $tag Beam.exe CPU (ms/GB)"] = [math]::Round(($b.AppCpu - $a.AppCpu) / ($TransferMB / 1024.0))
  # How long after the sender finished the file is on this PC (a download that starts while the file is still
  # arriving, P4, trails the upload closely).
  $savedLine = @(Log-Lines | Where-Object { $_ -like "*Saved down:$($peer.id) *" })[0]
  $savedAt = [datetime]::ParseExact($savedLine.Substring(0, 23), 'yyyy-MM-dd HH:mm:ss.fff', [Globalization.CultureInfo]::InvariantCulture)
  $results["download $tag saved after the sender finished (ms)"] = [math]::Max(0, [math]::Round(($savedAt - $senderDone).TotalMilliseconds))
  Remove-Item $file, $file2 -Force
  Get-ChildItem (Join-Path $tmp 'downloads') -File -ErrorAction SilentlyContinue | Remove-Item -Force
}

function Write-Config([string]$server) {
  $c = [ordered]@{
    server = $server; key = $script:key; deviceId = $script:deviceId; deviceName = 'Perf PC'
    quiet = $true; testOffscreen = $true; autoUpdate = $false; autostartInitialized = $true
    sendToMenu = $false; outbox = $false; autoCopy = $false; autoSave = $true; maxSaveMB = 8192
    saveFolder = (Join-Path $tmp 'downloads'); webViewReleaseSec = $ReleaseSec
  }
  [IO.File]::WriteAllText($cfg, ($c | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))
}

function Start-App([string]$server) {
  [Environment]::SetEnvironmentVariable('BEAM_LOCAL_URLS', $server)
  [Environment]::SetEnvironmentVariable('BEAM_TEST_PEERS', $server)
  $p = Start-Process -FilePath $appExe -ArgumentList @('--config', "`"$cfg`"", '--background') -PassThru
  $script:appPid = $p.Id
}

function Stop-App() {
  if (-not $script:appPid) { return }
  try { Invoke-App @('--quit') } catch { }
  $p = Get-Process -Id $script:appPid -ErrorAction SilentlyContinue
  if ($p) { if (-not $p.WaitForExit(15000)) { Stop-Process -Id $script:appPid -Force } }
  $script:appPid = 0
}

$base = "http://127.0.0.1:$Port"
$exitCode = 0
try {
  Say "Beam $((Get-Item $Exe).VersionInfo.ProductVersion) from $Exe; temp $tmp"
  Start-Node (Join-Path $root 'server.js') @() @{ BEAM_HOST = '127.0.0.1'; BEAM_PORT = "$Port"; BEAM_DATA = (Join-Path $tmp 'data'); BEAM_DIST = (Join-Path $tmp 'dist'); BEAM_TAILSCALE = 'off' } 'server' | Out-Null
  Wait-Http "$base/api/hello" 30
  $script:key = [IO.File]::ReadAllText((Join-Path $tmp 'data\key')).Trim()
  $script:deviceId = 'perfpc' + ([guid]::NewGuid().ToString('N').Substring(0, 18))
  & $node (Join-Path $PSScriptRoot 'windows-peer.mjs') $base $script:key register | Out-Null
  Write-Config $base

  # 1. Start: process start -> tray ready / event stream connected (from the app's own "Perf:" log lines).
  Start-App $base
  $m = Wait-Log 'Perf: tray ready (\d+) ms' 0 60
  $results['start -> tray ready (ms)'] = [int]$m.Groups[1].Value
  $m = Wait-Log 'Perf: connected (\d+) ms' 0 60
  $results['start -> connected (ms)'] = [int]$m.Groups[1].Value
  Start-Sleep -Seconds 30   # settle: first sync, status report, the 20 s health mark, collections

  # 2. Idle with the window never opened. Beam 1.4 servers also count what they write to this PC's stream (each
  # write wakes the PC's network stack): pings, held events.
  Say "idle, window never opened ($IdleSec s)"
  $w0 = StreamWrites
  $s = Idle 'hidden' $IdleSec
  $w1 = StreamWrites
  if ($w0 -ge 0 -and $w1 -ge 0) {
    $results['hidden: app stream heartbeat (s)'] = $script:streamPing   # 25 = foreground (1.3), 180 = background
    # a handful of writes per window: only meaningful over several heartbeats
    if ($IdleSec -ge 540) { $results['hidden: server writes to the app stream (per hour)'] = [math]::Round(($w1 - $w0) * 3600.0 / $IdleSec) }
  }
  $results['streams hidden (app + web)'] = Streams $Port $s

  # 3. Open the window: cold (first web view in this process).
  $from = (Log-Lines).Count
  Invoke-App @('--show')
  $m = Wait-Log 'Perf: open cold: bridge ready (\d+) ms' $from 90
  $results['open cold -> bridge ready (ms)'] = [int]$m.Groups[1].Value
  $lines = Log-Lines
  foreach ($l in $lines[$from..($lines.Count - 1)]) {
    $mm = [regex]::Match($l, 'Perf: open cold: (web view ready|page loaded) (\d+) ms')
    if ($mm.Success) { $results["open cold -> $($mm.Groups[1].Value) (ms)"] = [int]$mm.Groups[2].Value }
  }
  # settle: the page's start-up requests, and WebView2's own start-up in this fresh profile (its browser and network
  # service processes take a few hundred ms/min for the first 2-3 minutes, whatever the page does)
  Say "window open: settling $WebViewSettleSec s"
  Start-Sleep -Seconds $WebViewSettleSec
  Say "idle, window open ($IdleSec s)"
  $s = Idle 'shown' $IdleSec
  $results['streams shown (app + web)'] = Streams $Port $s

  # 4. Hide, then open again while the web view is kept (warm).
  Invoke-App @('--hide')
  Start-Sleep -Seconds 15
  $s = Sample
  $results['just hidden WebView2 private (MB)'] = [math]::Round($s.WvPriv, 1)
  $results['just hidden WebView2 processes'] = $s.WvCount
  if ($ReleaseSec -ge $IdleSec + 45) {
    Say "idle, window hidden with the web view kept ($IdleSec s)"
    Idle 'hidden, web view kept' $IdleSec | Out-Null
  }
  $from = (Log-Lines).Count
  Invoke-App @('--show')
  $m = Wait-Log 'Perf: open warm: (responsive|bridge ready) (\d+) ms' $from 60
  $results['open warm -> responsive (ms)'] = [int]$m.Groups[2].Value

  # 5. Hide until the web view is released, then open again.
  $from = (Log-Lines).Count
  Invoke-App @('--hide')
  Wait-Log 'Web window: released the web view' $from ($ReleaseSec + 60) | Out-Null
  Start-Sleep -Seconds 5
  $s = Sample
  $results['released WebView2 processes'] = $s.WvCount
  $results['released Beam.exe private (MB)'] = [math]::Round($s.AppPriv, 1)
  $from = (Log-Lines).Count
  Invoke-App @('--show')
  $m = Wait-Log 'Perf: open (recreated|cold): bridge ready (\d+) ms' $from 90
  $results['reopen after release -> bridge ready (ms)'] = [int]$m.Groups[2].Value
  Invoke-App @('--hide')
  Start-Sleep -Seconds 3

  # 6. Transfers, direct.
  Say "transfers direct ($TransferMB MB each way)"
  Transfers 'direct' $base

  # 7. Transfers through netsim (25 ms round trip).
  $netsimJs = Join-Path $PSScriptRoot 'netsim.mjs'
  if ($Netsim) {
    if (-not (Test-Path $netsimJs)) { Say 'netsim.mjs not found: skipping -Netsim' }
    else {
      # One link for this PC, one for the sending peer (both 25 ms, 400 Mbit/s), as when both are away from the server.
      Start-Node $netsimJs @('--listen', "$NetsimPort", '--to', "127.0.0.1:$Port", '--rtt', '25', '--mbps', '400', '--quiet') @{} 'netsim' | Out-Null
      Start-Node $netsimJs @('--listen', "$($NetsimPort + 1)", '--to', "127.0.0.1:$Port", '--rtt', '25', '--mbps', '400', '--quiet') @{} 'netsim-peer' | Out-Null
      Start-Sleep -Seconds 1
      Stop-App
      Write-Config "http://127.0.0.1:$NetsimPort"
      $from = (Log-Lines).Count
      Start-App "http://127.0.0.1:$NetsimPort"
      Wait-Log 'Perf: connected' $from 60 | Out-Null
      Start-Sleep -Seconds 3
      Say "transfers through netsim 25 ms ($TransferMB MB each way)"
      Transfers 'netsim25' "http://127.0.0.1:$($NetsimPort + 1)"
    }
  }
  # The most memory Beam.exe ever had committed (big uploads must stream from disk, not sit in memory).
  $p = Get-Process -Id $script:appPid -ErrorAction SilentlyContinue
  if ($p) { $results['Beam.exe peak private during the run (MB)'] = [math]::Round($p.PeakPagedMemorySize64 / 1MB, 1) }
} catch {
  Say "FAILED: $($_.Exception.Message)"
  $exitCode = 2
} finally {
  Stop-App
  foreach ($p in $procs) { try { if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force } } catch { } }
  [Environment]::SetEnvironmentVariable('BEAM_LOCAL_URLS', $null)
  [Environment]::SetEnvironmentVariable('BEAM_TEST_PEERS', $null)
}

# Budgets: generous enough not to flake on a busy PC, tight enough to catch a real regression (see
# plan/speed-results-windows.md for the measured numbers they come from).
$budgets = [ordered]@{
  'start -> tray ready (ms)'                     = @('<=', 1500)    # 1.4.0: ~260 (7-run median)
  'start -> connected (ms)'                      = @('<=', 3000)    # ~290
  'hidden Beam.exe CPU (ms/min)'                 = @('<=', 15)      # settled: 1.3.0 ~27 (20-min run); 1.4.0 ~5
  'hidden Beam.exe private (MB)'                 = @('<=', 60)      # ~29
  'hidden WebView2 processes'                    = @('<=', 0)       # never opened: no WebView at all
  'hidden: app stream heartbeat (s)'             = @('>=', 120)     # background mode (180) on a 1.4 server
  'shown Beam.exe CPU (ms/min)'                  = @('<=', 20)      # 1.3.0: ~50; 1.4.0: ~5
  'open cold -> bridge ready (ms)'               = @('<=', 3000)    # ~650-800
  'open warm -> responsive (ms)'                 = @('<=', 250)     # ~10
  'reopen after release -> bridge ready (ms)'    = @('<=', 3000)    # ~600
  'released WebView2 processes'                  = @('<=', 0)       # released means gone
  'upload direct (MB/s)'                         = @('>=', 90)      # 1.3.0: 66; 1.4.0: ~145-170 on this PC
  # Receiving: on a 1.4 server the download runs while the file is still arriving (P4), so its speed is the sender's
  # and what counts is how soon after the sender finished the file is saved here.
  'download direct saved after the sender finished (ms)'   = @('<=', 2000)  # ~0 with P4
  'upload netsim25 (MB/s)'                       = @('>=', 30)      # a 50 MB/s link with 25 ms round trips: ~46
  'download netsim25 saved after the sender finished (ms)' = @('<=', 3000)  # ~0 with P4; 1.3.0: several seconds
}

$failed = 0
$rows = foreach ($k in $results.Keys) {
  $v = $results[$k]
  $b = $null; $ok = ''
  if ($budgets.Contains($k)) {
    $b = $budgets[$k]
    $pass = if ($b[0] -eq '<=') { [double]$v -le $b[1] } else { [double]$v -ge $b[1] }
    $ok = if ($pass) { 'ok' } else { 'OVER' }
    if (-not $pass) { $failed++ }
  }
  [pscustomobject]@{ Metric = $k; Value = $v; Budget = if ($b) { "$($b[0]) $($b[1])" } else { '' }; Check = $ok }
}
$rows | Format-Table -AutoSize | Out-String -Width 160 | Write-Host
if ($Json) { $results | ConvertTo-Json | Set-Content -Path $Json -Encoding UTF8 }
# A run that fails keeps its folder (the app's beam.log, the server's log) for a look afterwards.
if (-not $Keep -and $exitCode -eq 0 -and ($NoBudgets -or $failed -eq 0)) { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue } else { Say "kept $tmp" }
if ($exitCode -ne 0) { exit $exitCode }
if (-not $NoBudgets -and $failed -gt 0) { Say "$failed budget(s) failed"; exit 1 }
exit 0
