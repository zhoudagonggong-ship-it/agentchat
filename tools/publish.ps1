# 把这份开发代码发布到主电脑；其他电脑连上主电脑时会自动更新到同一版本。
#   powershell -File tools\publish.ps1 -Target 用户名@主电脑.xxxx.ts.net [-Key ~\.ssh\id_ed25519]
# 不带参数时用 data\publish.json 里记下的 {"target": "...", "key": "..."}（data 不进仓库，每台开发电脑自己的）。
# 主电脑用和设备自动更新相同的方式换上新程序（核对指纹、旧版本留作备份、启动失败自动回退），然后重启。
param(
  [string]$Target,
  [string]$Key,
  [string]$RemoteDir = 'AllinOne'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$saved = Join-Path $root 'data\publish.json'
if ((-not $Target -or -not $Key) -and (Test-Path $saved)) {
  $s = Get-Content $saved -Raw -Encoding UTF8 | ConvertFrom-Json
  if (-not $Target) { $Target = $s.target }
  if (-not $Key) { $Key = $s.key }
}
if (-not $Target) { throw '请用 -Target 指定主电脑（用户名@机器名），或写在 data\publish.json 里' }
if (-not $Key) { $Key = Join-Path $env:USERPROFILE '.ssh\id_ed25519' }
$node = Join-Path $root 'runtime\node\node.exe'
$zip = Join-Path $env:TEMP 'allinone-publish.zip'

# 1. 打包：和中枢发给设备的程序包完全一样。
$version = & $node -e "import('file:///$($root -replace '\\','/')/src/update.ts').then(async m => { const p = await m.buildPackage(); require('fs').writeFileSync(process.argv[1], p.data); console.log(p.version) })" $zip
if ($LASTEXITCODE -ne 0) { throw '打包失败' }
"版本 $version，$([Math]::Round((Get-Item $zip).Length / 1KB)) KB"

# 2. 传过去。
scp -q -i $Key -o BatchMode=yes $zip "${Target}:AppData/Local/Temp/allinone-publish.zip"
if ($LASTEXITCODE -ne 0) { throw '传输失败' }

# 3. 在中枢上换上新程序，再重启（托盘会把主程序拉起来；托盘自己的文件变了，就连托盘一起重启）。
$remote = @"
`$ErrorActionPreference = 'Stop'
`$dir = Join-Path `$env:USERPROFILE '$RemoteDir'
`$node = Join-Path `$dir 'runtime\node\node.exe'
`$zip = Join-Path `$env:TEMP 'allinone-publish.zip'
`$mod = "import(require('url').pathToFileURL(require('path').join(process.argv[1], 'src', 'update.ts')).href)"
`$before = & `$node -e "`$mod.then(m => console.log(m.codeVersion()))" `$dir
if (`$before -eq '$version') { 'already at $version'; exit 0 }
`$code = & `$node -e "`$mod.then(async m => console.log(await m.applyPackage('$version', require('fs').readFileSync(process.argv[2]))))" `$dir `$zip
Remove-Item `$zip
"applied: `$before -> $version (exit `$code)"
`$procs = Get-CimInstance Win32_Process | Where-Object { `$_.CommandLine -and `$_.CommandLine -like "*`$dir*" -or (`$_.Name -eq 'node.exe' -and `$_.CommandLine -like '*src/main.ts*') }
if (`$code -eq '76') {
  # 托盘也换了：停掉旧托盘和主程序，在桌面会话里启动新托盘。
  `$procs | Where-Object { `$_.Name -eq 'node.exe' -or `$_.CommandLine -like '*tray.ps1*' } | ForEach-Object { Stop-Process -Id `$_.ProcessId -Force }
  `$vbs = Join-Path `$dir 'AllinOne.vbs'
  schtasks.exe /create /tn AllinOneStartOnce /tr "wscript.exe ```"`$vbs```"" /sc once /st 23:59 /it /f | Out-Null
  schtasks.exe /run /tn AllinOneStartOnce | Out-Null
  Start-Sleep 5
  schtasks.exe /delete /tn AllinOneStartOnce /f | Out-Null
  'tray restarted'
} else {
  `$procs | Where-Object { `$_.Name -eq 'node.exe' } | ForEach-Object { Stop-Process -Id `$_.ProcessId -Force }
  'program restarted by the tray'
}
"@
$enc = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($remote))
ssh -i $Key -o BatchMode=yes $Target "powershell -NoProfile -EncodedCommand $enc" 2>$null | Select-String -NotMatch 'CLIXML|<Objs'
Remove-Item $zip
