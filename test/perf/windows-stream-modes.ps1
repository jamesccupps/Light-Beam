<#
Beam for Windows: event stream mode switches (Beam 1.4 servers, P1). Exits 1 on failure.

  powershell -ExecutionPolicy Bypass -File test\perf\windows-stream-modes.ps1 [-Exe <Beam.exe>] [-HoldSec 100]

Checks, on an isolated test instance (--config in a temp folder, quiet, off-screen; scratch server on 8802):
- the native stream opens in background mode (ping 180 s);
- a poke (as after waking up or a network change) keeps the same stream;
- foreground (as while the tray menu or picker is open) and back to background keep the same stream;
- after switching back to background, the stream stays up with no reconnect for longer than a foreground dead-stream
  limit (2 × 25 + 20 = 70 s): the client's watchdog must not still be on the short limit.
#>
param([string]$Exe = '', [int]$Port = 8802, [int]$HoldSec = 100)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (-not $Exe) { $Exe = Join-Path $root 'windows\bin\Beam.exe'; if (-not (Test-Path $Exe)) { $Exe = Join-Path $root 'dist\Beam.exe' } }
if ($Port -lt 8801 -or $Port -gt 8809) { throw 'The Windows checks use ports 8801-8809' }
$node = (Get-Command node).Source
$tmp = Join-Path $env:TEMP ('beam-modes-win-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Force (Join-Path $tmp 'data'), (Join-Path $tmp 'dist'), (Join-Path $tmp 'cfg'), (Join-Path $tmp 'app') | Out-Null
$appExe = Join-Path $tmp 'app\Beam.exe'
Copy-Item $Exe $appExe
$cfg = Join-Path $tmp 'cfg\config.json'
$log = Join-Path $tmp 'cfg\beam.log'
$base = "http://127.0.0.1:$Port"
$failures = @()
$server = $null
$appPid = 0

function Fwd([string[]]$more) { Start-Process -FilePath $appExe -ArgumentList (@('--config', "`"$cfg`"") + $more) -Wait -WindowStyle Hidden }
function Streams() {
  $m = (Invoke-WebRequest -UseBasicParsing -Uri "$base/api/metrics" -Headers @{ Authorization = "Bearer $script:key" } -TimeoutSec 5).Content | ConvertFrom-Json
  @($m.streams | Where-Object { $_.device -eq $script:me -and $_.kind -ne 'web' })
}
function Connects() { @([IO.File]::ReadAllLines($log) | Where-Object { $_ -like '*Events: connected*' }).Count }
function Check([bool]$ok, [string]$what) {
  Write-Host ("{0,-4} {1}" -f $(if ($ok) { 'ok' } else { 'FAIL' }), $what)
  if (-not $ok) { $script:failures += $what }
}

try {
  foreach ($k in @('BEAM_HOST', 'BEAM_PORT', 'BEAM_DATA', 'BEAM_DIST', 'BEAM_TAILSCALE')) { [Environment]::SetEnvironmentVariable($k, $null) }
  $env:BEAM_HOST = '127.0.0.1'; $env:BEAM_PORT = "$Port"; $env:BEAM_DATA = (Join-Path $tmp 'data'); $env:BEAM_DIST = (Join-Path $tmp 'dist'); $env:BEAM_TAILSCALE = 'off'
  $server = Start-Process -FilePath $node -ArgumentList "`"$(Join-Path $root 'server.js')`"" -WorkingDirectory $root -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $tmp 'server.out.log') -RedirectStandardError (Join-Path $tmp 'server.err.log')
  foreach ($k in @('BEAM_HOST', 'BEAM_PORT', 'BEAM_DATA', 'BEAM_DIST', 'BEAM_TAILSCALE')) { [Environment]::SetEnvironmentVariable($k, $null) }
  $until = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $until) { try { Invoke-WebRequest -UseBasicParsing -Uri "$base/api/hello" -TimeoutSec 2 | Out-Null; break } catch { Start-Sleep -Milliseconds 200 } }
  $script:key = [IO.File]::ReadAllText((Join-Path $tmp 'data\key')).Trim()
  $script:me = 'modespc' + ([guid]::NewGuid().ToString('N').Substring(0, 17))
  $c = [ordered]@{ server = $base; key = $script:key; deviceId = $script:me; deviceName = 'Modes PC'; quiet = $true; testOffscreen = $true
    autoUpdate = $false; autostartInitialized = $true; sendToMenu = $false }
  [IO.File]::WriteAllText($cfg, ($c | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))
  $env:BEAM_LOCAL_URLS = $base; $env:BEAM_TEST_PEERS = $base
  $appPid = (Start-Process -FilePath $appExe -ArgumentList @('--config', "`"$cfg`"", '--background') -PassThru).Id
  Start-Sleep -Seconds 5

  $s = @(Streams)
  Check ($s.Count -eq 1 -and $s[0].mode -eq 'background' -and [int]$s[0].ping -eq 180) "opens in background mode with a 180 s ping ($($s.mode) $($s.ping))"
  Fwd @('--test-poke'); Start-Sleep -Seconds 2
  Check ((Select-String -Path $log -Pattern 'Events: the stream is fine after a test poke' -Quiet) -and (Connects) -eq 1) 'a poke keeps the stream'
  Fwd @('--test-mode', 'foreground'); Start-Sleep -Seconds 2
  $s = @(Streams)
  Check ($s.Count -eq 1 -and $s[0].mode -eq 'foreground' -and [int]$s[0].ping -eq 25) "switches to foreground (ping 25 s) on the same stream ($($s.mode) $($s.ping))"
  Start-Sleep -Seconds 30
  Fwd @('--test-mode', 'background'); Start-Sleep -Seconds 2
  $s = @(Streams)
  Check ($s.Count -eq 1 -and $s[0].mode -eq 'background' -and [int]$s[0].ping -eq 180) "back to background (ping 180 s) on the same stream ($($s.mode) $($s.ping))"
  Write-Host "     waiting $HoldSec s with no data expected on the stream..."
  Start-Sleep -Seconds $HoldSec
  $s = @(Streams)
  Check ((Connects) -eq 1 -and $s.Count -eq 1) "no reconnect $HoldSec s after switching back (connections: $(Connects))"
  Check (-not (Select-String -Path $log -Pattern 'nothing received for' -Quiet)) 'the watchdog never fired'
} catch {
  $failures += $_.Exception.Message
  Write-Host "FAIL $($_.Exception.Message)"
} finally {
  try { Fwd @('--quit') } catch { }
  if ($appPid) { $p = Get-Process -Id $appPid -ErrorAction SilentlyContinue; if ($p -and -not $p.WaitForExit(15000)) { Stop-Process -Id $appPid -Force } }
  if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force }
  $env:BEAM_LOCAL_URLS = $null; $env:BEAM_TEST_PEERS = $null
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
if ($failures.Count -gt 0) { Write-Host "$($failures.Count) check(s) failed"; exit 1 }
Write-Host 'all stream mode checks passed'
exit 0
