# Signs the command-line Claude Code (bundled with the Claude desktop app) in to your account, once.
# The hub uses it to continue Claude Code conversations from the phone.
$roots = @(
  (Join-Path $env:APPDATA 'Claude\claude-code'),
  (Join-Path $env:USERPROFILE 'AppData\Roaming\Claude\claude-code')
)
$roots += Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Packages') -Directory -Filter 'Claude_*' -ErrorAction SilentlyContinue |
  ForEach-Object { Join-Path $_.FullName 'LocalCache\Roaming\Claude\claude-code' }
$exe = $roots | Where-Object { Test-Path $_ } | ForEach-Object { Get-ChildItem $_ -Recurse -Filter claude.exe -ErrorAction SilentlyContinue } |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
if (-not $exe) { Write-Host '没有找到 Claude 桌面版自带的 claude.exe，查找过：'; $roots | ForEach-Object { Write-Host "  $_" }; exit 1 }
Write-Host "使用：$exe"
Write-Host '浏览器会打开 Claude 的登录页面，请在那里登录并授权。完成后回到这里。'
& $exe auth login
Write-Host ''
& $exe auth status
