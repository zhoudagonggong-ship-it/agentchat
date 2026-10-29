# Drives the Goose desktop window the way typing there would, so its window shows the turn as it happens:
# opens the conversation in the sidebar, fills the prompt box and presses Send (or presses Stop), all through
# Windows UI Automation patterns (no mouse or keyboard, no focus change). Goose stays the writer of its conversation.
#   -Payload  base64 of UTF-8 JSON {"action": "send"|"new"|"stop"|"probe", "title": "...", "text": "...", "marks": ["..."]}
#             marks: the conversation's recent typed messages, to confirm the right one is open.
#             new: presses 新对话 and sends `text` as its first message (a Goose conversation begins with one).
# Prints one JSON line: {"ok":true} or {"ok":false,"reason":"..."}.
param([string]$Payload = '')
$ErrorActionPreference = 'Stop'
# Usually on stdin: a long message would not fit in a command line (about 32,000 characters at most on Windows).
if (-not $Payload) { $Payload = [Console]::In.ReadToEnd().Trim() }
function Done([bool]$ok, [string]$reason = '') {
  [Console]::Out.WriteLine((@{ ok = $ok; reason = $reason } | ConvertTo-Json -Compress))
  exit 0
}
try {
  $req = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload)) | ConvertFrom-Json
  # A locked screen keeps the window reachable, but its prompt box no longer takes text.
  if (Get-Process LogonUI -ErrorAction SilentlyContinue) { Done $false 'locked' }

  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
  Add-Type -Namespace AllinOne -Name Input -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
[DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
[DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
[DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
public static uint IdleMs() { var i = new LASTINPUTINFO(); i.cbSize = (uint)Marshal.SizeOf(i); GetLastInputInfo(ref i); return (uint)Environment.TickCount - i.dwTime; }
public static bool Restore(IntPtr h) {
  uint pid; uint fg = GetWindowThreadProcessId(GetForegroundWindow(), out pid); uint me = GetCurrentThreadId();
  AttachThreadInput(me, fg, true); bool ok = SetForegroundWindow(h); AttachThreadInput(me, fg, false);
  return ok && GetForegroundWindow() == h;
}
'@
  $A = [System.Windows.Automation.AutomationElement]
  $T = [System.Windows.Automation.TreeScope]
  $P = [System.Windows.Automation.PropertyCondition]
  $CT = [System.Windows.Automation.ControlType]
  $Invoke = [System.Windows.Automation.InvokePattern]::Pattern
  $Value = [System.Windows.Automation.ValuePattern]::Pattern

  $w = Get-Process Goose -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if (-not $w) { Done $false 'no_window' }
  # Filling the prompt box brings Goose to the front for a moment: never while the owner is at the keyboard,
  # where their next keys would land in Goose. Stopping only presses a button and may go ahead.
  $minIdle = if ($null -ne $req.minIdleMs) { [int]$req.minIdleMs } else { 30000 }
  if ($req.action -in 'send', 'new' -and [AllinOne.Input]::IdleMs() -lt $minIdle) { Done $false 'in_use' }
  $previous = [AllinOne.Input]::GetForegroundWindow()
  # Goose may come to the front while we work in it: give the front back to whatever the owner had there.
  function Finish([bool]$ok, [string]$reason) {
    if ($previous -ne $w.MainWindowHandle -and [AllinOne.Input]::GetForegroundWindow() -eq $w.MainWindowHandle) {
      Start-Sleep -Milliseconds 300
      if (-not [AllinOne.Input]::Restore($previous)) { $reason = (@($reason, 'not_restored') | Where-Object { $_ }) -join ',' }
    }
    Done $ok $reason
  }
  $root = $A::FromHandle($w.MainWindowHandle)
  # Chromium builds its accessibility tree once a client asks for it.
  $null = $root.FindAll($T::Descendants, [System.Windows.Automation.Condition]::TrueCondition)

  function ByType($type) { @($root.FindAll($T::Descendants, (New-Object $P($A::ControlTypeProperty, $type)))) }
  function Box { $root.FindFirst($T::Descendants, (New-Object $P($A::AutomationIdProperty, 'dynamic-textarea'))) }
  # Send and Stop sit on the row under the prompt box.
  function RowButtons($box) {
    $r = $box.Current.BoundingRectangle
    @(ByType $CT::Button | Where-Object { $b = $_.Current.BoundingRectangle; $b.Y -ge $r.Bottom - 5 -and $b.Y -lt $r.Bottom + 80 -and $b.X -gt $r.Left + $r.Width / 2 })
  }
  $flat = { param($s) ([string]$s -replace '\s+', '') }

  if ($req.action -eq 'probe') {
    $box = Box
    $names = if ($box) { (RowButtons $box | ForEach-Object { "$($_.Current.Name)|$($_.Current.IsEnabled)" }) -join ';' } else { 'no box' }
    Done $true ("$names; foreground=" + ([AllinOne.Input]::GetForegroundWindow() -eq $w.MainWindowHandle) + "; idleMs=" + [AllinOne.Input]::IdleMs())
  }

  # Is the right conversation open? One of its recent typed messages shows in the window.
  $sidebarEdge = $root.Current.BoundingRectangle.X + 300
  function IsOpen {
    $texts = @(ByType $CT::Text | Where-Object { $_.Current.BoundingRectangle.X -ge $sidebarEdge } | ForEach-Object { & $flat $_.Current.Name })
    foreach ($m in @($req.marks)) {
      $want = & $flat $m
      if ($want.Length -gt 40) { $want = $want.Substring(0, 40) }
      if ($want -and ($texts | Where-Object { $_.StartsWith($want) })) { return $true }
    }
    $false
  }

  $box = Box
  if (-not $box) { Done $false 'no_prompt_box' }
  # Something typed and not sent yet: leave it alone.
  if ($req.action -in 'send', 'new' -and (& $flat $box.GetCurrentPattern($Value).Current.Value)) { Done $false 'draft' }

  if ($req.action -eq 'new') {
    # A new conversation shows no messages yet (each sent message carries an 「编辑消息」 button).
    $newChat = @(ByType $CT::Button | Where-Object { $_.Current.Name -in '新对话', 'New chat' -and $_.Current.BoundingRectangle.X -lt $sidebarEdge }) | Select-Object -First 1
    if (-not $newChat) { Done $false 'no_new_button' }
    $newChat.GetCurrentPattern($Invoke).Invoke()
    $empty = $false
    for ($i = 0; $i -lt 50 -and -not $empty; $i++) {
      Start-Sleep -Milliseconds 200
      $empty = (Box) -and -not @(ByType $CT::Button | Where-Object { $_.Current.Name -like '编辑消息*' -or $_.Current.Name -like 'Edit message*' }).Count
    }
    if (-not $empty) { Finish $false 'not_opened' }
    $box = Box
  } elseif (-not (IsOpen)) {
    # Sidebar entries are clickable groups holding the conversation's name.
    $entry = @(ByType $CT::Text | Where-Object { $_.Current.Name -eq $req.title -and $_.Current.BoundingRectangle.X -lt $sidebarEdge })
    if ($entry.Count -eq 0) { Done $false 'not_listed' }
    if ($entry.Count -gt 1) { Done $false 'ambiguous' }
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $item = $walker.GetParent($walker.GetParent($entry[0]))
    $item.GetCurrentPattern($Invoke).Invoke()
    $opened = $false
    for ($i = 0; $i -lt 50 -and -not $opened; $i++) { Start-Sleep -Milliseconds 200; $opened = IsOpen }
    if (-not $opened) { Finish $false 'not_opened' }
    $box = Box
    if (-not $box) { Finish $false 'no_prompt_box' }
  }

  $row = RowButtons $box
  $stop = $row | Where-Object { $_.Current.Name -match '停止|Stop' } | Select-Object -First 1
  if ($req.action -eq 'stop') {
    if (-not $stop) { Finish $false 'no_active_turn' }
    $stop.GetCurrentPattern($Invoke).Invoke()
    Finish $true ''
  }
  if ($stop) { Finish $false 'busy' }

  $vp = $box.GetCurrentPattern($Value)
  $vp.SetValue([string]$req.text)
  Start-Sleep -Milliseconds 300
  $want = & $flat $req.text
  if (-not (& $flat $vp.Current.Value).StartsWith($want.Substring(0, [Math]::Min(20, $want.Length)))) { $vp.SetValue(''); Finish $false 'not_filled' }
  $send = RowButtons $box | Where-Object { $_.Current.Name -eq '发送' -and $_.Current.IsEnabled } | Select-Object -First 1
  if (-not $send) { $vp.SetValue(''); Finish $false 'no_send_button' }
  $send.GetCurrentPattern($Invoke).Invoke()
  for ($i = 0; $i -lt 15; $i++) {
    Start-Sleep -Milliseconds 200
    if (-not (& $flat $vp.Current.Value)) { Finish $true '' }
  }
  Finish $false 'not_sent'
} catch {
  Done $false ('error: ' + $_.Exception.Message)
}
