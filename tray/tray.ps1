# AgentChat 托盘：显示状态图标，并照看主程序。
# 主程序的退出码：75 = 请求重启（切换角色、更新程序）；76 = 更新后托盘自己的文件也变了，托盘重新启动自己。
# 只用 Windows 自带的 .NET WinForms，不需要安装任何东西。由 AllinOne.vbs 隐藏启动。
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$ErrorActionPreference = 'Stop'

$AppDir = Split-Path -Parent $PSScriptRoot
$ControlUrl = 'http://127.0.0.1:18812/'
$Node = Join-Path $AppDir 'runtime\node\node.exe'
if (-not (Test-Path $Node)) { $Node = 'node.exe' }

function Open-Window {
  try { Start-Process 'msedge.exe' -ArgumentList "--app=$ControlUrl", '--window-size=480,820' }
  catch { Start-Process $ControlUrl }
}

# 只运行一个托盘；再次启动时直接打开窗口。
$created = $false
$mutex = New-Object System.Threading.Mutex($true, 'Local\AllinOneTray', [ref]$created)
if (-not $created) { Open-Window; exit }

function New-DotIcon([int]$r, [int]$g, [int]$b) {
  $bmp = New-Object System.Drawing.Bitmap 32, 32
  $gfx = [System.Drawing.Graphics]::FromImage($bmp)
  $gfx.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $gfx.Clear([System.Drawing.Color]::Transparent)
  $gfx.FillEllipse((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb($r, $g, $b))), 5, 5, 22, 22)
  $gfx.Dispose()
  [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
}
$Icons = @{ green = New-DotIcon 7 193 96; gray = New-DotIcon 142 142 147; orange = New-DotIcon 255 149 0 }

$Tray = New-Object System.Windows.Forms.NotifyIcon
$Tray.Icon = $Icons.gray
$Tray.Text = 'AgentChat · 启动中'
$Tray.Visible = $true
$Menu = New-Object System.Windows.Forms.ContextMenuStrip
$OpenItem = $Menu.Items.Add('打开 AgentChat')
$PauseItem = $Menu.Items.Add('暂停')
$RescanItem = $Menu.Items.Add('重新检测 Agent')
$DiagItem = $Menu.Items.Add('导出诊断信息')
[void]$Menu.Items.Add('-')
$QuitItem = $Menu.Items.Add('退出')
$Tray.ContextMenuStrip = $Menu

$script:Proc = $null
$script:ReadTask = $null
$script:ErrTask = $null
$script:Quitting = $false
$script:RestartAt = $null
$script:Paused = $false
$script:LastTip = ''
$script:OpenedOnce = $false

function Start-Worker {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $Node
  $psi.Arguments = 'src/main.ts'
  $psi.WorkingDirectory = $AppDir
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
  $psi.EnvironmentVariables['ALLINONE_TRAY'] = '1'
  $script:Proc = [System.Diagnostics.Process]::Start($psi)
  $script:Proc.StandardInput.AutoFlush = $true
  $script:ReadTask = $script:Proc.StandardOutput.ReadLineAsync()
  $script:ErrTask = $script:Proc.StandardError.ReadToEndAsync()
}

function Send-Worker([string]$line) {
  try { if ($script:Proc -and -not $script:Proc.HasExited) { $script:Proc.StandardInput.WriteLine($line) } } catch {}
}

function Update-Tray($state) {
  $icon = $Icons[$state.color]
  if ($icon) { $Tray.Icon = $icon }
  $tip = [string]$state.tip
  $Tray.Text = if ($tip.Length -gt 63) { $tip.Substring(0, 63) } else { $tip }
  $script:Paused = $tip.Contains('已暂停')
  $PauseItem.Text = if ($script:Paused) { '继续' } else { '暂停' }
  if ($tip -ne $script:LastTip -and $tip.Contains('请求加入')) {
    $Tray.ShowBalloonTip(5000, 'AgentChat', '有电脑请求加入，点开 AgentChat 允许', [System.Windows.Forms.ToolTipIcon]::Info)
  }
  # 第一次运行还没选主电脑：自动打开窗口。
  if (-not $script:OpenedOnce -and ($tip.Contains('请选择主电脑') -or $tip.Contains('需要设置'))) { $script:OpenedOnce = $true; Open-Window }
  $script:LastTip = $tip
}

$OpenItem.add_Click({ Open-Window })
$Tray.add_MouseClick({ param($s, $e) if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Open-Window } })
$PauseItem.add_Click({ if ($script:Paused) { Send-Worker 'resume' } else { Send-Worker 'pause' } })
$RescanItem.add_Click({ Send-Worker 'rescan' })
$DiagItem.add_Click({ Send-Worker 'diagnostics' })
$QuitItem.add_Click({
  $script:Quitting = $true
  Send-Worker 'quit'
  if ($script:Proc -and -not $script:Proc.WaitForExit(3000)) { try { $script:Proc.Kill() } catch {} }
  $Tray.Visible = $false
  $Tray.Dispose()
  [System.Windows.Forms.Application]::Exit()
})

# 主人是不是正坐在这台电脑前：离上次按键或动鼠标多久、是否锁屏。主人在电脑前时，提醒弹在这里，手机不响。
Add-Type -Namespace AllinOne -Name Presence -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)] public struct L { public uint cbSize; public uint dwTime; }
[DllImport("user32.dll")] static extern bool GetLastInputInfo(ref L l);
public static uint IdleMs() { var l = new L(); l.cbSize = (uint)Marshal.SizeOf(l); GetLastInputInfo(ref l); return (uint)Environment.TickCount - l.dwTime; }
'@
$script:PresenceAt = [DateTime]::MinValue
$script:AlertUrl = $null
# 点提醒气泡：打开那个对话。
$Tray.add_BalloonTipClicked({ if ($script:AlertUrl) { Start-Process $script:AlertUrl } })

$Timer = New-Object System.Windows.Forms.Timer
$Timer.Interval = 250
$Timer.add_Tick({
  if ($script:Proc) {
    while ($script:ReadTask -and $script:ReadTask.IsCompleted) {
      $line = $script:ReadTask.Result
      if ($null -eq $line) { $script:ReadTask = $null; break }
      if ($line.StartsWith('@@tray ')) { try { Update-Tray ($line.Substring(7) | ConvertFrom-Json) } catch {} }
      if ($line.StartsWith('@@alert ')) {
        try {
          $a = $line.Substring(8) | ConvertFrom-Json
          $script:AlertUrl = $a.url
          $Tray.ShowBalloonTip(8000, [string]$a.title, [string]$a.text, [System.Windows.Forms.ToolTipIcon]::Info)
        } catch {}
      }
      $script:ReadTask = $script:Proc.StandardOutput.ReadLineAsync()
    }
    if (([DateTime]::Now - $script:PresenceAt).TotalSeconds -ge 15) {
      $script:PresenceAt = [DateTime]::Now
      $locked = if (Get-Process LogonUI -ErrorAction SilentlyContinue) { 1 } else { 0 }
      Send-Worker "presence $([AllinOne.Presence]::IdleMs()) $locked"
    }
    if ($script:Proc.HasExited) {
      $code = $script:Proc.ExitCode
      $script:Proc = $null
      if ($code -eq 76 -and -not $script:Quitting) {
        # 76 = 程序更新后托盘自己的文件也变了：放开单实例锁，启动新的托盘，自己退出。
        $Timer.Stop()
        $Tray.Visible = $false
        $Tray.Dispose()
        $mutex.ReleaseMutex()
        $mutex.Dispose()
        Start-Process 'wscript.exe' -ArgumentList "`"$(Join-Path $AppDir 'AllinOne.vbs')`""
        [System.Windows.Forms.Application]::Exit()
        return
      }
      if (-not $script:Quitting) {
        $Tray.Icon = $Icons.gray
        # 75 = 主程序为了切换角色或更新而重启；其他退出视为意外，5 秒后再启动。
        $script:RestartAt = if ($code -eq 75) { [DateTime]::Now } else { [DateTime]::Now.AddSeconds(5) }
      }
    }
  } elseif ($script:RestartAt -and [DateTime]::Now -ge $script:RestartAt) {
    $script:RestartAt = $null
    Start-Worker
  }
})

Start-Worker
$Timer.Start()
[System.Windows.Forms.Application]::Run()
try { $mutex.ReleaseMutex() } catch {} # already released when handing over to a new tray
