# Restarts AgentChat on this (development) computer once it is idle: no Claude Code run that AgentChat started is
# still going (restarting would cut it off, approvals and all). Waits at most -MaxMinutes, then restarts anyway only
# with -Force; otherwise gives up and says so. When this computer is the hub, it first hands the duty on to the next
# in line (see src/shift.ts), so nothing waits on it while it is down.
#   powershell -File tools\restart-when-idle.ps1 [-MaxMinutes 60] [-Force]
param([int]$MaxMinutes = 60, [switch]$Force)
$root = Split-Path $PSScriptRoot -Parent
$until = (Get-Date).AddMinutes($MaxMinutes)
function Worker { Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'src[\\/]main\.ts' -and $_.CommandLine -match [regex]::Escape($root) } }
function Runs {
  $w = Worker
  if (-not $w) { return @() }
  $ids = @($w | ForEach-Object { $_.ProcessId })
  @(Get-CimInstance Win32_Process | Where-Object { $ids -contains $_.ParentProcessId -and $_.Name -match '^claude' })
}
while ((Runs).Count -gt 0) {
  if ((Get-Date) -ge $until) {
    if (-not $Force) { "still busy after $MaxMinutes minutes: not restarting"; exit 1 }
    break
  }
  "busy: $((Runs).Count) run(s) of AgentChat's own going; looking again in 30 s"
  Start-Sleep 30
}
try {
  $r = Invoke-WebRequest -UseBasicParsing -Method Post -Uri 'http://127.0.0.1:18812/api/stepdown' -Headers @{ 'X-AllinOne' = '1' } -Body '{}' -ContentType 'application/json' -TimeoutSec 90
  "handed on: $($r.Content)"
} catch {
  "not handed on: $($_.Exception.Message)"
}
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'tray\.ps1|src[\\/]main\.ts' -and $_.CommandLine -match [regex]::Escape($root) } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -Confirm:$false }
Start-Sleep 2
wscript (Join-Path $root 'AllinOne.vbs')
"restarted $(Get-Date -Format HH:mm:ss)"
