# 语音输入诊断版（只在本机，不连中枢，不影响正在运行的 AgentChat）：按 Ctrl+Alt+空格 开始，再按一次结束。
# 记录 Win+H 语音输入条每一刻的样子、框里什么时候出字、结束时和结束后的文字，写到桌面 voice-diag-log.txt。
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$log = Join-Path ([Environment]::GetFolderPath('Desktop')) 'voice-diag-log.txt'
Add-Type -WarningAction SilentlyContinue -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

public class VoiceDiag : Form {
  [DllImport("user32.dll")] static extern bool RegisterHotKey(IntPtr h, int id, uint mod, uint vk);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);

  readonly string logPath; readonly TextBox box = new TextBox(); readonly Label hint = new Label(); readonly NotifyIcon tray = new NotifyIcon();
  readonly System.Windows.Forms.Timer watch = new System.Windows.Forms.Timer { Interval = 100 };
  IntPtr prev; bool listening; int round; Stopwatch clock = new Stopwatch(); long firstText = -1; string lastSeen = ""; string lastPanel = "";

  public VoiceDiag(string logPath) {
    this.logPath = logPath;
    FormBorderStyle = FormBorderStyle.None; TopMost = true; ShowInTaskbar = false; StartPosition = FormStartPosition.Manual;
    BackColor = Color.FromArgb(32, 32, 36); Size = new Size(560, 130);
    var a = Screen.PrimaryScreen.WorkingArea; Location = new Point(a.Left + (a.Width - Width) / 2, a.Bottom - Height - 40);
    hint.Text = "诊断版：正在听…  说完再按 Ctrl+Alt+空格"; hint.ForeColor = Color.FromArgb(230, 200, 120); hint.Font = new Font("Microsoft YaHei UI", 10); hint.SetBounds(14, 10, 530, 22);
    box.Multiline = true; box.Font = new Font("Microsoft YaHei UI", 13); box.BorderStyle = BorderStyle.None; box.BackColor = Color.FromArgb(48, 48, 54); box.ForeColor = Color.White; box.SetBounds(14, 38, 530, 80);
    Controls.Add(hint); Controls.Add(box);
    tray.Icon = SystemIcons.Warning; tray.Text = "语音诊断（Ctrl+Alt+空格）"; tray.Visible = true;
    var menu = new ContextMenuStrip(); menu.Items.Add("退出", null, (s, e) => Close()); tray.ContextMenuStrip = menu;
    watch.Tick += (s, e) => Watch();
    var created = Handle;
    Log("started; " + Panels());
  }

  void Log(string line) { try { File.AppendAllText(logPath, DateTime.Now.ToString("HH:mm:ss.fff") + "  " + line + Environment.NewLine, Encoding.UTF8); } catch { } }
  protected override void SetVisibleCore(bool v) { base.SetVisibleCore(listening && v); }
  protected override void OnHandleCreated(EventArgs e) { base.OnHandleCreated(e); Log("hotkey " + (RegisterHotKey(Handle, 1, 2 | 1 | 0x4000, 0x20) ? "ok" : "TAKEN")); }
  protected override void OnFormClosed(FormClosedEventArgs e) { tray.Visible = false; base.OnFormClosed(e); }
  protected override void WndProc(ref Message m) { if (m.Msg == 0x0312) { if (listening) Finish(); else Begin(); return; } base.WndProc(ref m); }

  static string Proc(IntPtr h) { uint pid; GetWindowThreadProcessId(h, out pid); try { return Process.GetProcessById((int)pid).ProcessName; } catch { return "?"; } }

  /** The visible windows of the input processes (voice typing lives in TextInputHost) and where they are. */
  static string Panels() {
    var found = new List<string>();
    EnumWindows((h, p) => {
      if (!IsWindowVisible(h)) return true;
      string proc = Proc(h);
      if (proc.IndexOf("TextInput", StringComparison.OrdinalIgnoreCase) < 0 && proc.IndexOf("ctfmon", StringComparison.OrdinalIgnoreCase) < 0) return true;
      var t = new StringBuilder(256); GetWindowText(h, t, 256); var c = new StringBuilder(256); GetClassName(h, c, 256); RECT r; GetWindowRect(h, out r);
      if (r.R - r.L < 2 || r.B - r.T < 2) return true;
      found.Add(proc + "/" + c + "/'" + t + "' " + (r.R - r.L) + "x" + (r.B - r.T));
      return true;
    }, IntPtr.Zero);
    return found.Count == 0 ? "no input panel visible" : "panels: " + string.Join(" | ", found.ToArray());
  }

  static bool Down(byte vk) { return (GetAsyncKeyState(vk) & 0x8000) != 0; }
  static void KeysUp() { var sw = Stopwatch.StartNew(); while (sw.ElapsedMilliseconds < 1500 && (Down(0x11) || Down(0x12) || Down(0x20) || Down(0x5B))) { Application.DoEvents(); Thread.Sleep(15); } }
  void Bring(IntPtr t) { uint pid; uint fg = GetWindowThreadProcessId(GetForegroundWindow(), out pid); uint me = GetCurrentThreadId(); AttachThreadInput(me, fg, true); SetForegroundWindow(t); AttachThreadInput(me, fg, false); }

  void Watch() {
    if (box.Text != lastSeen) { lastSeen = box.Text; if (firstText < 0) firstText = clock.ElapsedMilliseconds; Log("  +" + clock.ElapsedMilliseconds + "ms text now (" + box.Text.Length + "): " + box.Text); }
    string p = Panels(); if (p != lastPanel) { lastPanel = p; Log("  +" + clock.ElapsedMilliseconds + "ms " + p); }
  }

  void Begin() {
    round++; clock.Restart(); firstText = -1; lastSeen = ""; lastPanel = "";
    prev = GetForegroundWindow();
    Log("=== round " + round + " BEGIN; before Win+H: " + Panels());
    listening = true; box.Text = ""; Show(); KeysUp();
    Bring(Handle); Activate(); box.Focus();
    Log("  +" + clock.ElapsedMilliseconds + "ms box in front: " + (GetForegroundWindow() == Handle) + "; sending Win+H");
    keybd_event(0x5B, 0, 0, UIntPtr.Zero); keybd_event(0x48, 0, 0, UIntPtr.Zero); keybd_event(0x48, 0, 2, UIntPtr.Zero); keybd_event(0x5B, 0, 2, UIntPtr.Zero);
    watch.Start();
  }

  void Finish() {
    long at = clock.ElapsedMilliseconds;
    Log("  +" + at + "ms FINISH pressed; text so far (" + box.Text.Length + "): " + box.Text + "; " + Panels());
    KeysUp();
    // How long until late words arrive, if they do: keep the box in front for up to 4 s.
    var wait = Stopwatch.StartNew(); string had = box.Text;
    while (wait.ElapsedMilliseconds < 4000) { Application.DoEvents(); Thread.Sleep(50); if (box.Text != had) { Log("  +" + clock.ElapsedMilliseconds + "ms late text (" + box.Text.Length + "): " + box.Text); had = box.Text; } }
    watch.Stop();
    Log("  END; final (" + box.Text.Length + "): " + box.Text + "; first text at " + firstText + "ms; " + Panels());
    listening = false; Hide(); Bring(prev);
    var after = new System.Windows.Forms.Timer { Interval = 1500 };
    after.Tick += (s, e) => { after.Stop(); Log("  1.5s after closing: " + Panels()); };
    after.Start();
  }
}
'@
if ($args -contains '-CompileOnly') { 'compiled ok'; return }
[System.Windows.Forms.Application]::Run((New-Object VoiceDiag $log))
