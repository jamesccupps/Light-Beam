<#
Beam for Windows: what a revoked sign-in clears, and what a network outage keeps. Exits 1 on failure.

  powershell -ExecutionPolicy Bypass -File test\perf\windows-revoked.ps1 [-Exe <Beam.exe>]

Isolated test instance (--config in a temp folder, quiet, off-screen) against a scratch server on 8803, reached through
test/perf/netsim.mjs on 8853 at 8 Mbit/s so an upload is still running when things happen:
1. network outage (the link goes away, then comes back): the token, the device list's Send to entries and the pending
   upload all stay;
2. the device is removed on the server (its token revoked): the next 401 from this same Beam clears the token, the
   Send to entries, the pending upload and recent targets; the user's own file stays. The chat window was opened and
   hidden before (its web view suspended): its cookies, storage and HTTP disk cache are cleared too (the page doesn't
   call /api/clear-cache in the app; the app clears the WebView2 profile itself).
#>
param([string]$Exe = '', [int]$Port = 8803, [int]$SimPort = 8853)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (-not $Exe) { $Exe = Join-Path $root 'windows\bin\Beam.exe'; if (-not (Test-Path $Exe)) { $Exe = Join-Path $root 'dist\Beam.exe' } }
if ($Port -lt 8801 -or $Port -gt 8809 -or $SimPort -lt 8851 -or $SimPort -gt 8859) { throw 'Windows test ports: 8801-8809, netsim 8851-8859' }
$node = (Get-Command node).Source
$tmp = Join-Path $env:TEMP ('beam-revoked-win-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$cfgDir = Join-Path $tmp 'cfg'
New-Item -ItemType Directory -Force (Join-Path $tmp 'data'), (Join-Path $tmp 'dist'), $cfgDir, (Join-Path $tmp 'app'), (Join-Path $tmp 'files') | Out-Null
$appExe = Join-Path $tmp 'app\Beam.exe'
Copy-Item $Exe $appExe
$cfg = Join-Path $cfgDir 'config.json'
$log = Join-Path $cfgDir 'beam.log'
$base = "http://127.0.0.1:$Port"
$sim = "http://127.0.0.1:$SimPort"
$failures = @()
$procs = @()
$appPid = 0

function Start-Node([string[]]$a, [hashtable]$envs, [string]$name) {
  foreach ($k in $envs.Keys) { [Environment]::SetEnvironmentVariable($k, $envs[$k]) }
  $p = Start-Process -FilePath $node -ArgumentList $a -WorkingDirectory $root -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $tmp "$name.out.log") -RedirectStandardError (Join-Path $tmp "$name.err.log")
  foreach ($k in $envs.Keys) { [Environment]::SetEnvironmentVariable($k, $null) }
  $script:procs += $p
  return $p
}
function Start-Sim() { Start-Node @("`"$(Join-Path $PSScriptRoot 'netsim.mjs')`"", '--listen', "$SimPort", '--to', "127.0.0.1:$Port", '--rtt', '10', '--mbps', '8', '--quiet') @{} 'netsim' }
function Fwd([string[]]$more) { Start-Process -FilePath $appExe -ArgumentList (@('--config', "`"$cfg`"") + $more) -Wait -WindowStyle Hidden }
function Lines() { if (Test-Path $log) { @([IO.File]::ReadAllLines($log)).Count } else { 0 } }
function WaitLog([string]$pattern, [int]$from, [int]$sec) {
  $until = (Get-Date).AddSeconds($sec)
  while ((Get-Date) -lt $until) {
    if (Test-Path $log) {
      $l = @([IO.File]::ReadAllLines($log)); for ($i = $from; $i -lt $l.Count; $i++) { if ($l[$i] -match $pattern) { return $true } }
    }
    Start-Sleep -Milliseconds 250
  }
  return $false
}
function Config() { [IO.File]::ReadAllText($cfg) | ConvertFrom-Json }
function StateUploads() { $s = [IO.File]::ReadAllText((Join-Path $cfgDir 'state.json')) | ConvertFrom-Json; @($s.uploads).Count }
function SendToEntries() { $d = Join-Path $cfgDir 'SendTo\Beam'; if (Test-Path $d) { @(Get-ChildItem $d -Filter '*.lnk').Count } else { 0 } }
# The chat window's HTTP disk cache (WebView2 profile of this test instance): its entry files and their bytes.
function CacheInfo() {
  $d = Join-Path $cfgDir 'WebView2\Profile\EBWebView\Default\Cache\Cache_Data'
  if (-not (Test-Path $d)) { return [pscustomobject]@{ Entries = 0; Bytes = 0 } }
  $f = @(Get-ChildItem $d -File)
  [pscustomobject]@{ Entries = @($f | Where-Object { $_.Name -like 'f_*' }).Count; Bytes = [long](($f | Measure-Object Length -Sum).Sum) }
}
function Check([bool]$ok, [string]$what) {
  Write-Host ("{0,-4} {1}" -f $(if ($ok) { 'ok' } else { 'FAIL' }), $what)
  if (-not $ok) { $script:failures += $what }
}

try {
  Start-Node @("`"$(Join-Path $root 'server.js')`"") @{ BEAM_HOST = '127.0.0.1'; BEAM_PORT = "$Port"; BEAM_DATA = (Join-Path $tmp 'data'); BEAM_DIST = (Join-Path $tmp 'dist'); BEAM_TAILSCALE = 'off' } 'server' | Out-Null
  $until = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $until) { try { Invoke-WebRequest -UseBasicParsing -Uri "$base/api/hello" -TimeoutSec 2 | Out-Null; break } catch { Start-Sleep -Milliseconds 200 } }
  $sim1 = Start-Sim
  $key = [IO.File]::ReadAllText((Join-Path $tmp 'data\key')).Trim()
  & $node (Join-Path $PSScriptRoot 'windows-peer.mjs') $base $key register | Out-Null
  $me = 'revokepc' + ([guid]::NewGuid().ToString('N').Substring(0, 16))
  $c = [ordered]@{ server = $sim; key = $key; deviceId = $me; deviceName = 'Revoke PC'; quiet = $true; testOffscreen = $true; autoUpdate = $false
    autostartInitialized = $true; sendToMenu = $true; autoSave = $true; saveFolder = (Join-Path $tmp 'down') }
  [IO.File]::WriteAllText($cfg, ($c | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))
  $env:BEAM_LOCAL_URLS = $sim; $env:BEAM_TEST_PEERS = $sim
  $appPid = (Start-Process -FilePath $appExe -ArgumentList @('--config', "`"$cfg`"", '--background') -PassThru).Id
  if (-not (WaitLog 'Perf: connected' 0 30)) { throw 'the app never connected' }
  if (-not (WaitLog 'Send to shortcuts updated' 0 20)) { throw 'no Send to entries were made' }
  $file = Join-Path $tmp 'files\mine.bin'
  $b = New-Object byte[] (40MB); (New-Object Random 7).NextBytes($b); [IO.File]::WriteAllBytes($file, $b)
  $from = Lines
  Fwd @('--send', '--to', 'perfphone0001perfphone0001', "`"$file`"")
  if (-not (WaitLog 'Upload up:\S+ \(\d+ bytes, send to\) started' $from 30)) { throw 'the upload never started' }
  Start-Sleep -Seconds 2
  $tokenBefore = (Config).keyProtected   # the sign-in, DPAPI-protected in config.json (Beam 1.6)

  # 1. The link goes away and comes back: everything stays.
  Stop-Process -Id $sim1.Id -Force
  Start-Sleep -Seconds 8
  $cfgNow = Config
  Check ($tokenBefore -and $cfgNow.keyProtected -and -not $cfgNow.key) 'network outage: the token stays'
  Check ((StateUploads) -eq 1) 'network outage: the pending upload stays'
  Check ((SendToEntries) -gt 0) 'network outage: the Send to entries stay'
  Check (-not (Select-String -Path $log -Pattern 'Sign-in revoked' -Quiet)) 'network outage: nothing was cleared'
  $from = Lines
  Start-Sim | Out-Null
  Check (WaitLog 'Events: connected' $from 45) 'the link comes back: reconnected'

  # The chat window opens (its page fills the HTTP cache), then hides until its web view is suspended (5 s).
  $from = Lines
  Fwd @('--show')
  Check (WaitLog 'Perf: open cold: bridge ready' $from 60) 'the chat window opens and its page loads'
  Start-Sleep -Seconds 3
  Fwd @('--hide')
  Start-Sleep -Seconds 9
  $cacheBefore = CacheInfo
  Check ($cacheBefore.Entries -gt 0) "the page's files are in the window's HTTP cache ($($cacheBefore.Entries) entry files, $($cacheBefore.Bytes) bytes)"

  # 2. The device is removed on the server: its sign-in is revoked.
  $r = Invoke-WebRequest -UseBasicParsing -Method Delete -Uri "$base/api/devices/$me" -Headers @{ Authorization = "Bearer $key" }
  Check (WaitLog 'Sign-in revoked' $from 45) 'revoked: noticed (a 401 from this same Beam)'
  Start-Sleep -Seconds 2
  $cfgNow = Config
  Check (-not $cfgNow.key -and -not $cfgNow.keyProtected) 'revoked: the token is gone'
  Check ($cfgNow.server -eq $sim -and $cfgNow.deviceId -eq $me) 'revoked: the server address and this PC''s id stay (sign in again is one step)'
  Check (@($cfgNow.lastTargets).Count -eq 0) 'revoked: recent targets are gone'
  Check ((StateUploads) -eq 0) 'revoked: the pending upload is gone'
  Check ((SendToEntries) -eq 0) 'revoked: the Send to entries naming devices are gone'
  Check (Test-Path $file) 'revoked: the user''s own file stays'
  Check (WaitLog 'Cleared the chat window''s data \(cookies, storage, HTTP cache\)' $from 30) 'revoked: the hidden (suspended) chat window''s cookies, storage and HTTP cache are cleared'
  Start-Sleep -Seconds 2
  $cacheAfter = CacheInfo
  Check ($cacheAfter.Entries -eq 0 -and $cacheAfter.Bytes -lt $cacheBefore.Bytes) "revoked: the HTTP cache is emptied ($($cacheAfter.Entries) entry files, $($cacheAfter.Bytes) bytes left)"
} catch {
  $failures += $_.Exception.Message
  Write-Host "FAIL $($_.Exception.Message)"
} finally {
  try { Fwd @('--quit') } catch { }
  if ($appPid) { $p = Get-Process -Id $appPid -ErrorAction SilentlyContinue; if ($p -and -not $p.WaitForExit(15000)) { Stop-Process -Id $appPid -Force } }
  foreach ($p in $procs) { try { if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force } } catch { } }
  $env:BEAM_LOCAL_URLS = $null; $env:BEAM_TEST_PEERS = $null
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
if ($failures.Count -gt 0) { Write-Host "$($failures.Count) check(s) failed"; exit 1 }
Write-Host 'all revoked sign-in checks passed'
exit 0
