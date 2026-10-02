<#
.SYNOPSIS
  Installs the Beam app on this PC and, with -Server, sets this PC up as the Beam host.

.DESCRIPTION
  On the PC that hosts Beam:   install-windows.ps1 -Server
    - runs the Beam server in the background (supervised: it restarts itself after a crash), now and whenever
      you sign in (needs Node.js); with -AtBoot, at startup even when nobody signs in (Windows Server)
    - shares it over Tailscale if Tailscale is installed and signed in
    - installs the Beam app (tray icon + messenger window), already signed in to this server

  Other Windows PCs don't need this script: download Beam.exe from "Add a device" in Beam and run it. It installs
  itself into the same place, adds a Start menu entry and starts with Windows.

  The app goes to %LOCALAPPDATA%\Programs\Beam\Beam.exe, gets a Start menu entry and starts with Windows.
  Shortcuts from the older script-based Beam (hotkeys, Send to, background receiver) are removed. Safe to run again:
  it restarts Beam instead of doubling it.

.PARAMETER Server
  This PC hosts Beam.
.PARAMETER AtBoot
  With -Server: start the server at boot as a scheduled task (runs as you, without signing in; needs an elevated
  PowerShell). For a Windows Server or a PC nobody signs in to. Replaces the Startup shortcut.
.PARAMETER Name
  What this PC is called in Beam, for a first install (default: the name it already has, or the computer name).
.PARAMETER NoLaunch
  Don't start the app at the end.
.PARAMETER RemoveServer
  Stop the Beam server on this PC and remove its startup entries, but keep the Beam app (for example after Beam
  moved to another machine). Your items stay in the data folder.
.PARAMETER Uninstall
  Stop Beam and remove the app, the server's startup entries, shortcuts and startup entries. Your items stay in the
  data folder, and the app's settings in %APPDATA%\Beam.
#>
param([switch]$Server, [switch]$AtBoot, [string]$Name, [switch]$NoLaunch, [switch]$RemoveServer, [switch]$Uninstall)
$ErrorActionPreference = 'Stop'

$root       = Split-Path -Parent $PSScriptRoot
$serverJs   = Join-Path $root 'server.js'
$hidden     = Join-Path $PSScriptRoot 'hidden.vbs'
$wscript    = Join-Path $env:WINDIR 'System32\wscript.exe'
$appSource  = Join-Path $root 'dist\Beam.exe'
$appDir     = Join-Path $env:LOCALAPPDATA 'Programs\Beam'
$appExe     = Join-Path $appDir 'Beam.exe'
$appConfig  = Join-Path $env:APPDATA 'Beam\config.json'
$cliConfig  = Join-Path $env:USERPROFILE '.beam.json'
$programs   = [Environment]::GetFolderPath('Programs')
$startup    = [Environment]::GetFolderPath('Startup')
$sendTo     = [Environment]::GetFolderPath('SendTo')
$runKey     = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$startLink  = Join-Path $programs 'Beam.lnk'
$serverLink = Join-Path $startup 'Beam server.lnk'
$taskName   = 'Beam server'

# Left behind by the earlier script-based version of Beam.
$legacy = @(
  (Join-Path $programs 'Beam'),               # Beam / Send clipboard (Ctrl+Alt+B) / Copy latest text (Ctrl+Alt+G)
  (Join-Path $sendTo 'Beam.lnk'),
  (Join-Path $startup 'Beam receiver.lnk'),
  'HKCU:\Software\Classes\beam',
  'HKCU:\Software\Classes\AppUserModelId\Beam'
)

# Settings from .env (the server reads the same file) and the environment; the environment wins.
$envFile = Join-Path $root '.env'
function Get-EnvSetting([string]$Key) {
  $value = [Environment]::GetEnvironmentVariable($Key)
  if ($value) { return $value }
  if (Test-Path $envFile) {
    $m = Select-String -Path $envFile -Pattern "^\s*$Key\s*=\s*(.*?)\s*$" | Select-Object -First 1
    if ($m) { return $m.Matches[0].Groups[1].Value.Trim('"', "'") }
  }
  return $null
}
$port = 8765
$portSetting = Get-EnvSetting 'BEAM_PORT'
if ($portSetting -match '^\d+$') { $port = [int]$portSetting }
$dataDir = Get-EnvSetting 'BEAM_DATA'
if (-not $dataDir) { $dataDir = Join-Path $root 'data' }
elseif (-not [IO.Path]::IsPathRooted($dataDir)) { $dataDir = Join-Path $root $dataDir }
$logDir = Join-Path $dataDir 'logs'

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  return (New-Object Security.Principal.WindowsPrincipal $id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-ServerProcesses {
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*$serverJs*" }
}

# Asks the server to shut down cleanly (`node server.js stop`: the supervisor exits too), then makes sure.
function Stop-Server {
  $running = @(Get-ServerProcesses)
  if (-not $running) { return }
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if ($node) {
    try { & $node $serverJs stop *> $null } catch {}
    for ($i = 0; $i -lt 20 -and @(Get-ServerProcesses).Count -gt 0; $i++) { Start-Sleep -Milliseconds 500 }
  }
  foreach ($p in @(Get-ServerProcesses)) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  'Stopped the Beam server'
}

function Remove-ServerStartup {
  if (Test-Path $serverLink) { Remove-Item $serverLink -Force; "Removed $serverLink" }
  if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    if (Test-Admin) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false; "Removed the scheduled task '$taskName'" }
    else { "The scheduled task '$taskName' needs an elevated PowerShell to remove: Unregister-ScheduledTask -TaskName '$taskName'" }
  }
}

function Stop-App {
  $running = Get-Process Beam -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($appDir, [StringComparison]::OrdinalIgnoreCase) }
  if (-not $running) { return }
  if (Test-Path $appExe) { Start-Process $appExe -ArgumentList '--quit' -ErrorAction SilentlyContinue }
  $running | ForEach-Object { if (-not $_.WaitForExit(8000)) { $_.Kill() } }
  'Stopped the Beam app'
}

function Remove-Legacy {
  foreach ($p in @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like "*$(Join-Path $root 'cli\beam.js')*listen*" })) {
    Stop-Process -Id $p.ProcessId -Force; 'Stopped the old background receiver'
  }
  foreach ($path in $legacy) { if (Test-Path $path) { Remove-Item $path -Recurse -Force; "Removed old $path" } }
}

function New-Shortcut([string]$Path, [string]$Target, [string]$Arguments, [string]$Description, [string]$Icon) {
  $link = (New-Object -ComObject WScript.Shell).CreateShortcut($Path)
  $link.TargetPath = $Target
  $link.Arguments = $Arguments
  $link.WorkingDirectory = Split-Path $Target
  $link.Description = $Description
  if ($Icon) { $link.IconLocation = $Icon }
  $link.Save()
}

# ------------------------------------------------------------ removing
if ($Uninstall) {
  Stop-App
  Stop-Server
  Remove-ServerStartup
  Remove-Legacy
  foreach ($path in $startLink, $appDir, (Join-Path $sendTo 'Beam')) { if (Test-Path $path) { Remove-Item $path -Recurse -Force; "Removed $path" } }
  Remove-ItemProperty -Path $runKey -Name Beam -ErrorAction SilentlyContinue
  'Beam is uninstalled. Your items are still in the data folder, and the app settings in %APPDATA%\Beam.'
  return
}

if ($RemoveServer) {
  Stop-Server
  Remove-ServerStartup
  'The Beam server is stopped and no longer starts with Windows. The Beam app stays installed.'
  "Its data is still in $dataDir."
  'Tailscale may still forward https://<this PC>.<tailnet>.ts.net to it; if nothing else uses that, run: tailscale serve reset'
  return
}

if (-not (Test-Path $appSource)) { throw "The Beam app hasn't been built. Run windows\build.cmd first." }
Remove-Legacy

# ------------------------------------------------------------ server (host PC only)
$sharedOverTailscale = $false
if ($AtBoot -and -not $Server) { throw '-AtBoot goes with -Server.' }
if ($Server) {
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $node) { throw 'Node.js was not found. Install it from https://nodejs.org and run this again.' }
  if ($AtBoot -and -not (Test-Admin)) { throw '-AtBoot sets up a scheduled task that starts Beam at boot: run this from an elevated PowerShell (Run as administrator).' }
  Stop-Server
  Remove-ServerStartup | Out-Null
  if ($AtBoot) {
    # Runs as this user without a sign-in (S4U), restarts after a failure, no 3-day time limit. Without admin rights
    # (1.7.3): the server needs none (its port is above 1024, its data folder is this user's), so a bug in it can't do
    # what an administrator could.
    $action = New-ScheduledTaskAction -Execute $node -Argument "`"$serverJs`" --supervise" -WorkingDirectory $root
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
      -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
    Start-ScheduledTask -TaskName $taskName
    if ([Environment]::GetEnvironmentVariable('BEAM_DATA', 'Process') -and -not [Environment]::GetEnvironmentVariable('BEAM_DATA', 'User') -and -not (Select-String -Path $envFile -Pattern '^\s*BEAM_DATA\s*=' -Quiet -ErrorAction SilentlyContinue)) {
      "Note: BEAM_DATA is only set in this window. Put it in $envFile so the server finds its data at boot."
    }
  } else {
    Start-Process $wscript -ArgumentList "`"$hidden`" `"$node`" `"$serverJs`" --supervise" -WorkingDirectory $root
    New-Shortcut $serverLink $wscript "`"$hidden`" `"$node`" `"$serverJs`" --supervise" 'Beam server' $null
  }
  $up = $false
  for ($i = 0; $i -lt 40 -and -not $up; $i++) {
    Start-Sleep -Milliseconds 500
    try { $null = Invoke-WebRequest "http://127.0.0.1:$port/api/hello" -UseBasicParsing -TimeoutSec 2; $up = $true } catch {}
  }
  if (-not $up) { throw "The Beam server didn't start. Run  node `"$serverJs`"  to see the error, and look in $logDir." }
  if ($AtBoot) { "Beam server is running on port $port and starts at boot (scheduled task '$taskName')." }
  else { "Beam server is running in the background on port $port, and starts when you sign in." }
  "Server logs: $(Join-Path $logDir 'server.log') and $(Join-Path $logDir 'supervisor.log')."

  # Share Beam over Tailscale (HTTPS, works away from home) when Tailscale is installed and signed in.
  $tailscale = @((Get-Command tailscale -ErrorAction SilentlyContinue).Source, "$env:ProgramFiles\Tailscale\tailscale.exe") |
    Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
  if (-not $tailscale) {
    'Tailscale is not installed, so Beam only works on your home network for now.'
  } else {
    & $tailscale status *> $null
    if ($LASTEXITCODE -ne 0) {
      'Tailscale is installed but not signed in. Sign in from the Tailscale icon in the taskbar, then run this script again.'
    } elseif ((& $tailscale serve status --json 2>$null | Out-String) -match "(127\.0\.0\.1|localhost):$port\b") {
      $sharedOverTailscale = $true
      'Beam is shared over Tailscale.'
    } else {
      $out = Join-Path $env:TEMP 'beam-tailscale-serve.txt'
      $proc = Start-Process $tailscale -ArgumentList "serve --bg $port" -NoNewWindow -PassThru -RedirectStandardOutput $out -RedirectStandardError "$out.err"
      $finished = $proc.WaitForExit(20000)
      $message = ((Get-Content $out, "$out.err" -ErrorAction SilentlyContinue) -join "`n").Trim()
      if (-not $finished) {
        $proc.Kill()
        "Tailscale needs HTTPS turned on for your account first:`n$message`nOpen that link, turn it on, then run this script again."
      } else {
        $sharedOverTailscale = $true
        "Shared Beam over Tailscale.`n$message"
      }
      Remove-Item $out, "$out.err" -ErrorAction SilentlyContinue
    }
  }

  # Sign the app in to this server. It keeps the identity the command-line tool had on this PC, so
  # conversations with this PC carry over. (It swaps the key for a device token of its own at its first start.)
  if (-not (Test-Path $appConfig)) {
    $keyFile = Join-Path $dataDir 'key'
    $key = Get-EnvSetting 'BEAM_KEY'
    if (-not $key) {
      if (-not (Test-Path $keyFile)) { throw "No key in $keyFile. Is BEAM_DATA right?" }
      $key = (Get-Content $keyFile -Raw).Trim()
    }
    $old = if (Test-Path $cliConfig) { Get-Content $cliConfig -Raw | ConvertFrom-Json } else { $null }
    $deviceId = if ($old -and $old.deviceId) { $old.deviceId } else { [guid]::NewGuid().ToString('N') }
    $deviceName = if ($Name) { $Name } elseif ($old -and $old.device) { $old.device } else { $env:COMPUTERNAME }
    $config = [ordered]@{ server = "http://localhost:$port"; key = $key; deviceId = $deviceId; deviceName = $deviceName; autostartInitialized = $true }
    New-Item -ItemType Directory -Force -Path (Split-Path $appConfig) | Out-Null
    [IO.File]::WriteAllText($appConfig, ($config | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))
    "Signed the Beam app in to this server as `"$deviceName`"."
    $firstInstall = $true
  }
}

# ------------------------------------------------------------ the app
# The same place, Start menu entry and startup entry the app sets up by itself when it's run from a download.
Stop-App
New-Item -ItemType Directory -Force -Path $appDir | Out-Null
for ($i = 0; ; $i++) {
  try { Copy-Item $appSource $appExe -Force; break }
  catch { if ($i -ge 20) { throw "Couldn't copy Beam.exe to $appDir (antivirus?): $($_.Exception.Message)" }; Start-Sleep -Milliseconds 500 }
}
Get-ChildItem $appDir -Filter 'Beam.new.exe*' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
New-Shortcut $startLink $appExe '--show' 'Beam: send text and files between your devices' "$appExe,0"
Set-ItemProperty -Path $runKey -Name Beam -Value "`"$appExe`" --background"
"Installed the Beam app to $appExe (Start menu entry added, starts with Windows)."

if ($Server -and -not $sharedOverTailscale -and -not (Get-NetFirewallPortFilter -Protocol TCP -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -eq "$port" })) {
  ''
  "Note: Windows Firewall blocks phones on your Wi-Fi from reaching Beam until you allow port $port, or use Tailscale."
}

if (-not $NoLaunch) {
  # After a first install, go straight to "Add a device" so the next device can join.
  Start-Process $appExe -ArgumentList $(if ($firstInstall) { '--show --add-device' } else { '--show' })
  'Started Beam. It lives in the system tray (the ^ area next to the clock); Ctrl+Alt+B sends your clipboard.'
  'To add a phone or another computer: Add a device (in Beam, or the tray menu). New devices on your tailnet usually sign in by themselves.'
}
