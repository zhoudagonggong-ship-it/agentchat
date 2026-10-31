# Sends a message into a conversation open in the Claude desktop app, the way typing it there would:
# opens the conversation in the sidebar, fills the prompt box and presses Send, all through Windows UI
# Automation patterns (no mouse or keyboard). The desktop app stays the only writer of its conversation.
#   -Payload  base64 of UTF-8 JSON {"title": "...", "text": "...", "sendNames": ["..."]}
#             sendNames: names the send button was found to have in a newer app (learned, see the adapter).
# Prints one JSON line: {"ok":true} or {"ok":false,"reason":"...","row":[...]}; `row`: the buttons on the box's row
# when none of them looked like send, so the adapter can find out which one is.
param([string]$Payload = '')
$ErrorActionPreference = 'Stop'
# Usually on stdin: a long message would not fit in a command line (about 32,000 characters at most on Windows).
if (-not $Payload) { $Payload = [Console]::In.ReadToEnd().Trim() }
[Console]::OutputEncoding = [Text.Encoding]::UTF8 # the answer may name buttons in Chinese
$script:RowNames = $null
function Done([bool]$ok, [string]$reason = '') {
  $out = @{ ok = $ok; reason = $reason }
  # Its own name: PowerShell names ignore case, and $row below holds the row's UI elements themselves.
  if ($script:RowNames) { $out.row = $script:RowNames }
  [Console]::Out.WriteLine(($out | ConvertTo-Json -Compress -Depth 4))
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
public static uint IdleMs() { var i = new LASTINPUTINFO(); i.cbSize = (uint)Marshal.SizeOf(i); GetLastInputInfo(ref i); return (uint)Environment.TickCount - i.dwTime; }
'@
  $A = [System.Windows.Automation.AutomationElement]
  $T = [System.Windows.Automation.TreeScope]
  $P = [System.Windows.Automation.PropertyCondition]
  $CT = [System.Windows.Automation.ControlType]
  $Invoke = [System.Windows.Automation.InvokePattern]::Pattern
  $Value = [System.Windows.Automation.ValuePattern]::Pattern

  $w = Get-Process claude -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if (-not $w) { Done $false 'no_window' }
  $root = $A::FromHandle($w.MainWindowHandle)
  # Chromium builds its accessibility tree once a client asks for it.
  $null = $root.FindAll($T::Descendants, [System.Windows.Automation.Condition]::TrueCondition)

  function Buttons([string]$name) {
    @($root.FindAll($T::Descendants, (New-Object System.Windows.Automation.AndCondition(
      (New-Object $P($A::ControlTypeProperty, $CT::Button)), (New-Object $P($A::NameProperty, $name))))))
  }
  # The title bar's rename button names the conversation that is open.
  $suffix = '，重命名会话'
  function IsOpen { (Buttons "$($req.title)$suffix").Count -gt 0 }
  function OpenTitle {
    $b = @($root.FindAll($T::Descendants, (New-Object $P($A::ControlTypeProperty, $CT::Button))) | Where-Object { $_.Current.Name.EndsWith($suffix) }) | Select-Object -First 1
    if ($b) { $b.Current.Name.Substring(0, $b.Current.Name.Length - $suffix.Length) } else { $null }
  }
  function OpenEntry([string]$title) {
    $entry = @(Buttons $title | Where-Object { $_.Current.BoundingRectangle.X -lt 400 })
    if ($entry.Count -ne 1) { return $entry.Count }
    $entry[0].GetCurrentPattern($Invoke).Invoke()
    return 1
  }

  # Another conversation is open: switching away from it is the owner's to do while they work here. Only when they
  # have left the keyboard and mouse alone for a while does it switch, send, and switch back to what they had open.
  $back = $null
  if (-not (IsOpen)) {
    if (-not $req.now -and [AllinOne.Input]::IdleMs() -lt 30000) { Done $false 'in_use' }
    $back = OpenTitle
    $n = OpenEntry $req.title
    if ($n -eq 0) { Done $false 'not_listed' }
    if ($n -gt 1) { Done $false 'ambiguous' }
    $opened = $false
    for ($i = 0; $i -lt 50 -and -not $opened; $i++) { Start-Sleep -Milliseconds 200; $opened = IsOpen }
    if (-not $opened) { Done $false 'not_opened' }
    # The title bar changes before the rest of the pane: for a moment the prompt box is still the previous
    # conversation's, and a message typed there lands in it. Let the pane settle.
    Start-Sleep -Milliseconds 1500
  }
  # Leaves the window on the conversation the owner had open, then answers.
  function Finish([bool]$ok, [string]$reason = '') {
    if ($back -and $back -ne $req.title) { $null = OpenEntry $back }
    Done $ok $reason
  }

  # The conversation's own prompt box: with several conversations side by side (split view) each pane has one, and
  # the first in the window may well be another conversation's. Its pane is the one under its title bar.
  # Up from the title bar to the first container holding a prompt box: that pane's box if it holds just one; none
  # rather than a guess when it holds several (better the message waits than lands in another conversation).
  $promptBox = New-Object System.Windows.Automation.AndCondition(
    (New-Object $P($A::ControlTypeProperty, $CT::Edit)), (New-Object $P($A::NameProperty, '提示词')))
  function PaneBox {
    $head = @(Buttons "$($req.title)$suffix")
    if ($head.Count -ne 1) { return $null }
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    for ($up = $walker.GetParent($head[0]); $up; $up = $walker.GetParent($up)) {
      $found = @($up.FindAll($T::Descendants, $promptBox))
      if ($found.Count -eq 1) { return $found[0] }
      if ($found.Count -gt 1) { return $null }
    }
    return $null
  }
  $box = $null
  for ($i = 0; $i -lt 25 -and -not $box; $i++) {
    $box = PaneBox
    if (-not $box) { Start-Sleep -Milliseconds 200 }
  }
  if (-not $box) { Finish $false 'no_prompt_box' }
  $vp = $box.GetCurrentPattern($Value)
  $flat = { param($s) ([string]$s -replace '\s+', '') }
  # Something the owner typed and has not sent: never overwrite it; try again later.
  if (& $flat $vp.Current.Value) { Finish $false 'draft' }
  # An empty box holds one line break; setting '' does not clear it, setting that line break does.
  $clear = { $vp.SetValue("`n") }
  # A turn is running (Stop shows on the box's row): do not touch the box at all, so the owner sees nothing typed
  # and cleared again; the message waits and goes in once the turn has ended.
  # The buttons on the box's own bottom row (add, send or stop, voice). The box grows upward with a long message, so
  # its bottom edge places the row, and only buttons within its width count (the window has other panes beside it).
  # The voice button always sits on that row, right of send, however tall a long message makes the box (which may even
  # scroll inside): its height places the row. Without it, the box's bottom edge does.
  function RowButtons {
    $r = $box.Current.BoundingRectangle
    $all = @($root.FindAll($T::Descendants, (New-Object $P($A::ControlTypeProperty, $CT::Button))) | Where-Object {
      $b = $_.Current.BoundingRectangle; -not [double]::IsInfinity($b.Y) -and -not $b.IsEmpty -and $b.X -ge $r.Left - 80 -and $b.X -le $r.Right + 160 })
    $mic = $all | Where-Object { $_.Current.Name -match '录音|语音|Voice|Dictat' } | Sort-Object { $_.Current.BoundingRectangle.Y } | Select-Object -Last 1
    $y = if ($mic) { $mic.Current.BoundingRectangle.Y + $mic.Current.BoundingRectangle.Height / 2 } else { $r.Bottom - 14 }
    @($all | Where-Object { $b = $_.Current.BoundingRectangle; [Math]::Abs(($b.Y + $b.Height / 2) - $y) -lt 20 })
  }
  # Unless the owner said to send it now: the app then queues it for after the turn, as pressing Enter there does.
  if (-not $req.now -and @(RowButtons | Where-Object { $_.Current.Name -eq '停止' }).Count) { Finish $false 'busy' }
  $vp.SetValue([string]$req.text)
  # The box takes a moment to show what was set, longer while the window is busy.
  $want = & $flat $req.text
  $want = $want.Substring(0, [Math]::Min(20, $want.Length))
  $filled = $false
  for ($i = 0; $i -lt 10 -and -not $filled; $i++) { Start-Sleep -Milliseconds 200; $filled = (& $flat $vp.Current.Value).StartsWith($want) }
  if (-not $filled) { & $clear; Finish $false 'not_filled' }

  # Send sits on the prompt box's row. While a turn runs the row shows Stop; once there is text it shows Send again,
  # which queues the message for after the turn, as pressing Enter there does. It may take a moment to change.
  $send = $null
  for ($i = 0; $i -lt 15 -and -not $send; $i++) {
    $row = RowButtons
    # 「发送」, or while a turn is finishing the queue button (↵), which queues it as Enter would.
    $learned = @($req.sendNames | Where-Object { $_ })
    $send = $row | Where-Object { ($_.Current.Name -match '^(发送|排队|加入队列|提交|Send|Queue|Submit)' -or $learned -contains $_.Current.Name) -and $_.Current.IsEnabled } | Select-Object -First 1
    if (-not $send) { Start-Sleep -Milliseconds 200 }
  }
  if (-not $send) {
    & $clear # leave the box as it was
    # The row's buttons, so the adapter can find out (once) which one sends in this version of the app.
    $script:RowNames = @($row | ForEach-Object { @{ name = $_.Current.Name; x = [int]$_.Current.BoundingRectangle.X; enabled = $_.Current.IsEnabled } })
    Finish $false ('no_send_button: ' + (($row | ForEach-Object { $_.Current.Name }) -join '|'))
  }
  # Last look before it goes: still this conversation, still this box.
  $now = PaneBox
  if (-not (IsOpen) -or -not $now -or -not [System.Windows.Automation.Automation]::Compare($now, $box)) { & $clear; Finish $false 'switched' }
  $send.GetCurrentPattern($Invoke).Invoke()
  for ($i = 0; $i -lt 15; $i++) {
    Start-Sleep -Milliseconds 200
    if (-not (& $flat $vp.Current.Value)) { Finish $true }
  }
  & $clear
  Finish $false 'not_sent'
} catch {
  Done $false ('error: ' + $_.Exception.Message)
}
