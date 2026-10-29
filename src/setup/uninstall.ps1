# 卸载 AgentChat（以前叫 AllinOne）：停下程序，去掉它加进各家 Agent 的钩子和工具、开机自启、图标和「设置 → 应用」里的登记，删除程序文件。
# 对话记录和设置（data）问过之后才删。
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$dir = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
# ALLINONE_INSTALL_TEST：只在测试时用，和安装时同一个目录；不弹窗（ALLINONE_KEEP_DATA=1 时保留 data），不碰注册表和 Tailscale。
$test = $env:ALLINONE_INSTALL_TEST
function Ask([string]$text) {
  if ($test) { return $(if ($text -like '*保留*') { $env:ALLINONE_KEEP_DATA -eq '1' } else { $true }) }
  [System.Windows.Forms.MessageBox]::Show($text, 'AgentChat', 'YesNo', 'Question') -eq 'Yes'
}
function Say([string]$text, [string]$icon = 'Information') {
  if ($test) { Write-Output $text; return }
  [void][System.Windows.Forms.MessageBox]::Show($text, 'AgentChat', 'OK', $icon)
}

if (-not (Ask '要卸载 AgentChat 吗？')) { exit }
$keepData = Ask "要保留对话记录和设置吗？`n`n保留的话，以后重新安装可以接着用。"

try {
  Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -like "*$dir*" -and $_.ProcessId -ne $PID } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 800

  # 各家 Agent 里 AgentChat 加的东西（Claude 的钩子和工具、Codex、OpenCode、Goose 的工具）。
  $node = Join-Path $dir 'runtime\node\node.exe'
  if (Test-Path $node) { & $node --no-warnings (Join-Path $dir 'src\uninstall.ts') | Out-Null }
  $desktop = if ($test) { Join-Path $test 'Desktop' } else { [Environment]::GetFolderPath('Desktop') }
  $menu = if ($test) { Join-Path $test 'Start' } else { [Environment]::GetFolderPath('Programs') }
  if (-not $test) {
    # 主电脑在 Tailscale 上发布的网址。
    $ts = 'C:\Program Files\Tailscale\tailscale.exe'
    if (Test-Path $ts) { & $ts serve --https=18801 off 2>$null | Out-Null }
    Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'AllinOne' -ErrorAction SilentlyContinue
    Remove-Item -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\AllinOne' -Recurse -ErrorAction SilentlyContinue
  }
  # 新旧两个名字的图标都去掉。
  foreach ($name in 'AgentChat', 'AllinOne') {
    Remove-Item (Join-Path $desktop "$name.lnk") -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $menu $name) -Recurse -ErrorAction SilentlyContinue
  }

  # 程序文件在这个脚本退出后删（脚本自己也在里面）。
  $keep = if ($keepData) { 'data' } else { '' }
  $cleanup = "Start-Sleep 2; Get-ChildItem -LiteralPath '$dir' -Force | Where-Object { `$_.Name -ne '$keep' } | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue; if (-not '$keep') { Remove-Item -LiteralPath '$dir' -Recurse -Force -ErrorAction SilentlyContinue }"
  Start-Process powershell.exe -WindowStyle Hidden -ArgumentList '-NoProfile', '-Command', $cleanup
  Say 'AgentChat 已卸载。'
} catch {
  Say "卸载没有完成：$($_.Exception.Message)" 'Error'
}
