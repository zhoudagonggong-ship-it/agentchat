# 安装 AllinOne：装到本用户的程序目录，建桌面和开始菜单图标，登记到「设置 → 应用」，开机自启，然后启动。
# 只用 Windows 自带的功能，不需要管理员权限。再次运行就是升级：程序换新，data（对话、设置）保留。
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
# ALLINONE_INSTALL_TEST：只在测试时用，装到它指定的目录，不碰注册表、不启动、不弹窗。
$test = $env:ALLINONE_INSTALL_TEST
function Say([string]$text, [string]$icon = 'Information') {
  if ($test) { Write-Output $text; return }
  [void][System.Windows.Forms.MessageBox]::Show($text, 'AllinOne', 'OK', $icon)
}

try {
  $src = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
  $dest = if ($test) { Join-Path $test 'Programs\AllinOne' } else { Join-Path $env:LOCALAPPDATA 'Programs\AllinOne' }
  $version = (Get-Content (Join-Path $src 'package.json') -Raw | ConvertFrom-Json).version

  # 已经装在这里：直接打开。
  if ((Resolve-Path $src).Path -eq $dest) { Start-Process wscript.exe "`"$dest\AllinOne.vbs`""; exit }

  # 正在运行的旧版本先停下（它的数据保留）。
  Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -like "*$dest*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 800

  # 程序文件整体换新；data 不动。robocopy 是 Windows 自带的复制工具。
  New-Item -ItemType Directory -Force $dest | Out-Null
  & robocopy.exe $src $dest /MIR /XD data /XF Setup.cmd /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "复制文件失败（robocopy $LASTEXITCODE）" }

  # 图标：和托盘一样的绿色圆点。
  $iconFile = Join-Path $dest 'AllinOne.ico'
  $bmp = New-Object System.Drawing.Bitmap 64, 64
  $gfx = [System.Drawing.Graphics]::FromImage($bmp)
  $gfx.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $gfx.Clear([System.Drawing.Color]::Transparent)
  $gfx.FillEllipse((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(7, 193, 96))), 8, 8, 48, 48)
  $gfx.Dispose()
  $stream = [System.IO.File]::Create($iconFile)
  [System.Drawing.Icon]::FromHandle($bmp.GetHicon()).Save($stream)
  $stream.Close()

  # 桌面和开始菜单的图标；开始菜单里还有「卸载 AllinOne」。
  $shell = New-Object -ComObject WScript.Shell
  function New-Link([string]$path, [string]$target, [string]$arguments, [string]$description) {
    $link = $shell.CreateShortcut($path)
    $link.TargetPath = $target
    $link.Arguments = $arguments
    $link.WorkingDirectory = $dest
    $link.Description = $description
    $link.IconLocation = $iconFile
    $link.Save()
  }
  $desktop = if ($test) { New-Item -ItemType Directory -Force (Join-Path $test 'Desktop') } else { [Environment]::GetFolderPath('Desktop') }
  $menu = Join-Path ($(if ($test) { Join-Path $test 'Start' } else { [Environment]::GetFolderPath('Programs') })) 'AllinOne'
  New-Item -ItemType Directory -Force $menu | Out-Null
  $open = "`"$dest\AllinOne.vbs`""
  $uninstall = "-NoProfile -ExecutionPolicy Bypass -STA -File `"$dest\src\setup\uninstall.ps1`""
  New-Link (Join-Path $desktop 'AllinOne.lnk') 'wscript.exe' $open '打开 AllinOne'
  New-Link (Join-Path $menu 'AllinOne.lnk') 'wscript.exe' $open '打开 AllinOne'
  New-Link (Join-Path $menu '卸载 AllinOne.lnk') 'powershell.exe' $uninstall '卸载 AllinOne'

  if ($test) { Say "installed to $dest"; exit }

  # 登记到「设置 → 应用」，在那里也能卸载。
  $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\AllinOne'
  New-Item -Path $key -Force | Out-Null
  $values = @{ DisplayName = 'AllinOne'; DisplayVersion = $version; Publisher = 'AllinOne'; InstallLocation = $dest; DisplayIcon = $iconFile
    UninstallString = "powershell.exe $uninstall"; NoModify = 1; NoRepair = 1 }
  foreach ($name in $values.Keys) { New-ItemProperty -Path $key -Name $name -Value $values[$name] -Force | Out-Null }

  # 开机自启（之后可以在 AllinOne 窗口的设置里关掉）。
  New-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'AllinOne' -Value "wscript.exe $open" -Force | Out-Null

  Start-Process wscript.exe $open
  Say "AllinOne 已安装好，桌面上有它的图标。`n`n马上会打开 AllinOne 的窗口，跟着窗口一步一步设置就行。"
} catch {
  Say "安装没有完成：$($_.Exception.Message)`n`n可以再双击一次 Setup.cmd 重试。" 'Error'
}
