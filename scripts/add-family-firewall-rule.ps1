# Beam Family 1.9: lets devices on your home network connect straight to Beam Family (fast links, big uploads at full
# Wi-Fi speed). It adds one Windows Firewall rule: incoming UDP on Beam Family's ports 41700-41799, for Node only,
# from home-network (private) addresses only, while the network is set as Private. Nothing else changes.
# Run it yourself: right-click this file → "Run with PowerShell" (Windows asks for permission: click Yes).
# To remove it later: Remove-NetFirewallRule -DisplayName "Beam Family direct connections (home network)"
$name = 'Beam Family direct connections (home network)'
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
  Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`""
  exit
}
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = 'C:\Program Files\nodejs\node.exe' }
if (Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue) {
  Write-Host "The rule is already there: $name"
} else {
  New-NetFirewallRule -DisplayName $name -Direction Inbound -Action Allow -Protocol UDP -LocalPort 41700-41799 -Program $node -Profile Private -RemoteAddress 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 | Out-Null
  Write-Host "Added: $name (UDP 41700-41799 for $node, from your home network)"
}
Read-Host 'Press Enter to close'
