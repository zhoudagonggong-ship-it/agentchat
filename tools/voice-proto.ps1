# 语音输入小样（只在这台电脑上，不连中枢）：按 Ctrl+Alt+空格 开始听，再按一次结束，文字粘贴回原来的窗口。
# 识别用 Windows 自带的语音输入（Win+H）。只用 Windows 自带的 .NET，不装任何东西。
# 每一步记到桌面的 voice-proto-log.txt，方便远程查看。
param([switch]$CompileOnly)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$log = Join-Path ([Environment]::GetFolderPath('Desktop')) 'voice-proto-log.txt'

Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

public class VoiceProto : Form {
  [DllImport("user32.dll")] static extern bool RegisterHotKey(IntPtr h, int id, uint mod, uint vk);
  [DllImport("user32.dll")] static extern bool UnregisterHotKey(IntPtr h, int id);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);

  const int WM_HOTKEY = 0x0312;
  const uint MOD_ALT = 1, MOD_CONTROL = 2, MOD_NOREPEAT = 0x4000;
  const byte VK_CONTROL = 0x11, VK_MENU = 0x12, VK_SPACE = 0x20, VK_LWIN = 0x5B, VK_H = 0x48, VK_V = 0x56;
  const uint KEYUP = 2;

  readonly string logPath;
  readonly TextBox box = new TextBox();
  readonly Label hint = new Label();
  readonly NotifyIcon tray = new NotifyIcon();
  IntPtr prev = IntPtr.Zero;
  string prevTitle = "", prevProc = "";
  bool listening;
  Stopwatch clock = new Stopwatch();

  public VoiceProto(string logPath) {
    this.logPath = logPath;
    FormBorderStyle = FormBorderStyle.None; TopMost = true; ShowInTaskbar = false; StartPosition = FormStartPosition.Manual;
    BackColor = Color.FromArgb(32, 32, 36); Size = new Size(560, 130); Opacity = 0.96;
    var area = Screen.PrimaryScreen.WorkingArea;
    Location = new Point(area.Left + (area.Width - Width) / 2, area.Bottom - Height - 40);
    hint.Text = "正在听…  说完再按 Ctrl+Alt+空格，Esc 取消"; hint.ForeColor = Color.FromArgb(160, 230, 160);
    hint.Font = new Font("Microsoft YaHei UI", 10); hint.SetBounds(14, 10, 530, 22);
    box.Multiline = true; box.Font = new Font("Microsoft YaHei UI", 13); box.BorderStyle = BorderStyle.None;
    box.BackColor = Color.FromArgb(48, 48, 54); box.ForeColor = Color.White; box.SetBounds(14, 38, 530, 80);
    box.KeyDown += (s, e) => { if (e.KeyCode == Keys.Escape) { e.SuppressKeyPress = true; Cancel(); } };
    Controls.Add(hint); Controls.Add(box);
    tray.Icon = SystemIcons.Information; tray.Text = "语音输入测试（Ctrl+Alt+空格）"; tray.Visible = true;
    var menu = new ContextMenuStrip(); menu.Items.Add("退出", null, (s, e) => Close()); tray.ContextMenuStrip = menu;
    Log("started; hotkey Ctrl+Alt+Space");
    var created = Handle; // the window stays hidden until called, but must exist now to own the hotkey
  }

  void Log(string line) {
    try { File.AppendAllText(logPath, DateTime.Now.ToString("HH:mm:ss.fff") + "  " + line + Environment.NewLine, Encoding.UTF8); } catch { }
  }

  protected override void SetVisibleCore(bool value) { base.SetVisibleCore(listening && value); }

  protected override void OnHandleCreated(EventArgs e) {
    base.OnHandleCreated(e);
    bool ok = RegisterHotKey(Handle, 1, MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, VK_SPACE);
    Log(ok ? "hotkey registered" : "hotkey NOT registered (another program owns Ctrl+Alt+Space)");
    if (!ok) tray.ShowBalloonTip(5000, "语音输入测试", "Ctrl+Alt+空格 被别的程序占用了", ToolTipIcon.Warning);
  }

  protected override void OnFormClosed(FormClosedEventArgs e) { UnregisterHotKey(Handle, 1); tray.Visible = false; Log("exit"); base.OnFormClosed(e); }

  protected override void WndProc(ref Message m) {
    if (m.Msg == WM_HOTKEY) { if (listening) Finish(); else Begin(); return; }
    base.WndProc(ref m);
  }

  static string Title(IntPtr h) { var s = new StringBuilder(512); GetWindowText(h, s, 512); return s.ToString(); }
  static string ProcName(IntPtr h) { uint pid; GetWindowThreadProcessId(h, out pid); try { return Process.GetProcessById((int)pid).ProcessName; } catch { return "?"; } }

  void WaitKeysUp() {
    var sw = Stopwatch.StartNew();
    while (sw.ElapsedMilliseconds < 2000 && ((GetAsyncKeyState(VK_CONTROL) & 0x8000) != 0 || (GetAsyncKeyState(VK_MENU) & 0x8000) != 0 || (GetAsyncKeyState(VK_SPACE) & 0x8000) != 0)) {
      Application.DoEvents(); System.Threading.Thread.Sleep(15);
    }
  }

  void Focus(IntPtr target) {
    uint pid; uint fg = GetWindowThreadProcessId(GetForegroundWindow(), out pid); uint me = GetCurrentThreadId();
    AttachThreadInput(me, fg, true); SetForegroundWindow(target); AttachThreadInput(me, fg, false);
  }

  void Begin() {
    clock.Restart();
    prev = GetForegroundWindow(); prevTitle = Title(prev); prevProc = ProcName(prev);
    Log("BEGIN target window: [" + prevProc + "] " + prevTitle);
    listening = true; box.Text = ""; Show(); WaitKeysUp();
    Focus(Handle); Activate(); box.Focus();
    Log("own window in front: " + (GetForegroundWindow() == Handle) + " after " + clock.ElapsedMilliseconds + " ms");
    keybd_event(VK_LWIN, 0, 0, UIntPtr.Zero); keybd_event(VK_H, 0, 0, UIntPtr.Zero);
    keybd_event(VK_H, 0, KEYUP, UIntPtr.Zero); keybd_event(VK_LWIN, 0, KEYUP, UIntPtr.Zero);
    Log("Win+H sent");
  }

  void Cancel() { listening = false; Hide(); Focus(prev); Log("cancelled"); }

  void Finish() {
    var said = clock.ElapsedMilliseconds;
    WaitKeysUp();
    // The last words are committed a moment after speaking stops.
    var wait = Stopwatch.StartNew(); string last = box.Text;
    while (wait.ElapsedMilliseconds < 1500) { Application.DoEvents(); System.Threading.Thread.Sleep(50); if (box.Text != last) { last = box.Text; wait.Restart(); } else if (wait.ElapsedMilliseconds > 500) break; }
    string text = box.Text.Trim();
    listening = false; Hide();
    Log("FINISH after " + said + " ms of listening; text (" + text.Length + " chars): " + text);
    Focus(prev);
    System.Threading.Thread.Sleep(150);
    Log("back in front: " + (GetForegroundWindow() == prev) + " [" + ProcName(GetForegroundWindow()) + "]");
    if (text.Length == 0) return;
    Clipboard.SetText(text);
    // A remote-desktop window passes the clipboard on to the other computer; give it a moment.
    System.Threading.Thread.Sleep(prevProc.ToLower().Contains("awesun") ? 600 : 100);
    keybd_event(VK_CONTROL, 0, 0, UIntPtr.Zero); keybd_event(VK_V, 0, 0, UIntPtr.Zero);
    keybd_event(VK_V, 0, KEYUP, UIntPtr.Zero); keybd_event(VK_CONTROL, 0, KEYUP, UIntPtr.Zero);
    Log("pasted with Ctrl+V into [" + prevProc + "] " + prevTitle + "; total " + clock.ElapsedMilliseconds + " ms");
  }
}
'@

if ($CompileOnly) { 'compiled ok'; return }
$form = New-Object VoiceProto $log
[System.Windows.Forms.Application]::Run($form)
