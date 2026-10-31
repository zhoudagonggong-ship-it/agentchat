# Voice input helper, started by the AgentChat program on each computer (in the owner's desktop session).
# It owns the hotkey Win+Alt+Space, held down while the owner speaks. On the microphone computer it records meanwhile
# (Windows' own recorder, winmm) and cuts the recording where the owner pauses, so the program has each piece
# recognized while they go on speaking. On the computer spoken to it shows how it goes in a small box by the cursor
# that never takes the focus, and pastes the text at the cursor.
# Talks to the program over stdin/stdout, one JSON object per line:
#   out: {"op":"key","fgProc","fgTitle"} {"op":"release"} {"op":"audio","path","last"} (a piece; path "": none)
#        {"op":"status","text","tone","done"} {"op":"cancel"} {"op":"log","text"}
#   in:  {"op":"listen"} {"op":"finish"} {"op":"show","text","tone","done"} {"op":"paste","text"}
# Only Windows' own .NET; nothing to install.
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[Console]::OutputEncoding = [Text.Encoding]::UTF8
[Console]::InputEncoding = [Text.Encoding]::UTF8

Add-Type -WarningAction SilentlyContinue -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

public class VoiceHelper : Form {
  [DllImport("user32.dll")] static extern bool RegisterHotKey(IntPtr h, int id, uint mod, uint vk);
  [DllImport("user32.dll")] static extern bool UnregisterHotKey(IntPtr h, int id);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);
  [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint thread, ref GUITHREADINFO info);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("winmm.dll")] static extern int waveInOpen(out IntPtr h, uint device, ref WAVEFORMATEX format, IntPtr callback, IntPtr instance, uint flags);
  [DllImport("winmm.dll")] static extern int waveInPrepareHeader(IntPtr h, IntPtr hdr, int size);
  [DllImport("winmm.dll")] static extern int waveInUnprepareHeader(IntPtr h, IntPtr hdr, int size);
  [DllImport("winmm.dll")] static extern int waveInAddBuffer(IntPtr h, IntPtr hdr, int size);
  [DllImport("winmm.dll")] static extern int waveInStart(IntPtr h);
  [DllImport("winmm.dll")] static extern int waveInReset(IntPtr h);
  [DllImport("winmm.dll")] static extern int waveInClose(IntPtr h);
  [DllImport("winmm.dll", CharSet = CharSet.Unicode)] static extern int waveInGetErrorText(int err, StringBuilder text, int len);

  [StructLayout(LayoutKind.Sequential)] struct WAVEFORMATEX {
    public ushort wFormatTag, nChannels; public uint nSamplesPerSec, nAvgBytesPerSec; public ushort nBlockAlign, wBitsPerSample, cbSize;
  }
  [StructLayout(LayoutKind.Sequential)] struct WAVEHDR {
    public IntPtr lpData; public uint dwBufferLength, dwBytesRecorded; public IntPtr dwUser; public uint dwFlags, dwLoops; public IntPtr lpNext, reserved;
  }
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] struct GUITHREADINFO {
    public int cbSize, flags;
    public IntPtr hwndActive, hwndFocus, hwndCapture, hwndMenuOwner, hwndMoveSize, hwndCaret;
    public RECT rcCaret;
  }

  const int WM_HOTKEY = 0x0312;
  const uint MOD_ALT = 1, MOD_WIN = 8, MOD_NOREPEAT = 0x4000;
  const byte VK_CONTROL = 0x11, VK_MENU = 0x12, VK_SPACE = 0x20, VK_LWIN = 0x5B, VK_RWIN = 0x5C, VK_V = 0x56;
  const uint KEYUP = 2;
  const int MAX_SECONDS = 600; // a recording nobody stops ends by itself
  const int MM_WIM_DATA = 0x3C0;
  const uint WAVE_MAPPER = 0xFFFFFFFF, CALLBACK_WINDOW = 0x10000;
  const int RATE = 16000, BUFFER_MS = 100, BUFFERS = 8;
  const int PAUSE_MS = 700;      // this long quiet after some speech: a piece ends there
  const int PIECE_MAX_MS = 25000; // a piece is cut here even without a pause
  const int SHORT_MS = 400;       // let go sooner: a slip of the fingers
  const int QUIET_MIN_MS = 1500;  // a recording with no speech heard in it goes to the recognizer only if this long

  readonly Label hint = new Label();
  readonly System.Windows.Forms.Timer limit = new System.Windows.Forms.Timer { Interval = MAX_SECONDS * 1000 };
  readonly System.Windows.Forms.Timer linger = new System.Windows.Forms.Timer { Interval = 2500 };
  readonly System.Windows.Forms.Timer held = new System.Windows.Forms.Timer { Interval = 20 };
  bool recording, shown, holding;
  Stopwatch clock = new Stopwatch();
  IntPtr wave = IntPtr.Zero;
  readonly IntPtr[] headers = new IntPtr[BUFFERS];
  MemoryStream piece = new MemoryStream(); // the piece being said now, 16 kHz mono 16-bit
  int pieceMs, quietMs, pieces;
  bool pieceHasSpeech;
  double noise = 300; // the room's level, learned as it goes

  public VoiceHelper() {
    FormBorderStyle = FormBorderStyle.None; TopMost = true; ShowInTaskbar = false; StartPosition = FormStartPosition.Manual;
    BackColor = Color.FromArgb(32, 32, 36); Size = new Size(360, 40); Opacity = 0.94;
    hint.Font = new Font("Microsoft YaHei UI", 10.5f); hint.TextAlign = ContentAlignment.MiddleLeft;
    hint.SetBounds(12, 0, 336, 40);
    Controls.Add(hint);
    limit.Tick += (s, e) => { limit.Stop(); if (recording) { Log("recording reached " + MAX_SECONDS + " s"); Finish(); } };
    linger.Tick += (s, e) => { linger.Stop(); Hide(); shown = false; };
    // Held while speaking: letting go of any of the three keys ends it.
    held.Tick += (s, e) => {
      if ((Down(VK_LWIN) || Down(VK_RWIN)) && Down(VK_MENU) && Down(VK_SPACE)) return;
      held.Stop(); holding = false; Send("{\"op\":\"release\"}");
    };
    var created = Handle; // hidden until called, but it must exist now to own the hotkey
    new Thread(ReadCommands) { IsBackground = true }.Start();
  }

  // The box shows what is going on but never takes the focus: the owner's window (a remote desktop, say) keeps it.
  protected override bool ShowWithoutActivation { get { return true; } }
  protected override CreateParams CreateParams {
    get { var p = base.CreateParams; p.ExStyle |= 0x08000000 /* NOACTIVATE */ | 0x80 /* TOOLWINDOW */ | 0x8 /* TOPMOST */; return p; }
  }
  protected override void SetVisibleCore(bool value) { base.SetVisibleCore(shown && value); }

  static Color ToneColor(string tone) {
    if (tone == "ok") return Color.FromArgb(160, 230, 160);
    if (tone == "bad") return Color.FromArgb(240, 120, 110);
    return Color.FromArgb(230, 200, 120);
  }

  void Say(string text, string tone, bool done) {
    hint.Text = text; hint.ForeColor = ToneColor(tone); linger.Stop();
    int w = Math.Max(200, Math.Min(640, TextRenderer.MeasureText(text, hint.Font).Width + 30));
    if (!shown) { Width = w; PlaceByCursor(); shown = true; Show(); }
    else if (w > Width) Width = w;
    hint.Width = Width - 24;
    if (done) linger.Start();
  }

  /** Just below the text cursor of the window in front, or the mouse pointer where a program does not tell. */
  void PlaceByCursor() {
    Point at = Cursor.Position;
    int below = 24; // under the pointer's arrow
    var fg = GetForegroundWindow();
    uint pid; uint thread = GetWindowThreadProcessId(fg, out pid);
    var info = new GUITHREADINFO(); info.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));
    if (thread != 0 && GetGUIThreadInfo(thread, ref info) && info.hwndCaret != IntPtr.Zero) {
      var p = new POINT { X = info.rcCaret.Left, Y = info.rcCaret.Bottom };
      if (ClientToScreen(info.hwndCaret, ref p)) { at = new Point(p.X, p.Y); below = 6; }
    }
    var area = Screen.FromPoint(at).WorkingArea;
    int x = Math.Max(area.Left, Math.Min(at.X, area.Right - Width));
    int y = at.Y + below;
    if (y + Height > area.Bottom) y = Math.Max(area.Top, at.Y - Height - 30); // no room below: above it
    Location = new Point(x, y);
  }

  static void Send(string json) { lock (typeof(VoiceHelper)) { Console.Out.WriteLine(json); Console.Out.Flush(); } }
  static string Q(string s) {
    var b = new StringBuilder("\"");
    foreach (char c in s ?? "") {
      if (c == '"' || c == '\\') b.Append('\\').Append(c);
      else if (c < ' ') b.Append("\\u").Append(((int)c).ToString("x4"));
      else b.Append(c);
    }
    return b.Append('"').ToString();
  }
  static void Log(string text) { Send("{\"op\":\"log\",\"text\":" + Q(text) + "}"); }
  /** How the recording goes, for the box on the computer spoken to (the program passes it on). */
  static void Status(string text, string tone, bool done) {
    Send("{\"op\":\"status\",\"text\":" + Q(text) + ",\"tone\":" + Q(tone) + ",\"done\":" + (done ? "true" : "false") + "}");
  }

  /** A string field of a one-line JSON command (the program only sends plain strings). */
  static string Field(string json, string name) {
    int i = json.IndexOf("\"" + name + "\""); if (i < 0) return "";
    i = json.IndexOf('"', json.IndexOf(':', i) + 1); if (i < 0) return "";
    var b = new StringBuilder();
    for (int k = i + 1; k < json.Length; k++) {
      char c = json[k];
      if (c == '"') break;
      if (c == '\\' && k + 1 < json.Length) {
        char n = json[++k];
        if (n == 'n') b.Append('\n'); else if (n == 'r') b.Append('\r'); else if (n == 't') b.Append('\t');
        else if (n == 'u' && k + 4 < json.Length) { b.Append((char)Convert.ToInt32(json.Substring(k + 1, 4), 16)); k += 4; }
        else b.Append(n);
      } else b.Append(c);
    }
    return b.ToString();
  }

  void ReadCommands() {
    string line;
    while ((line = Console.In.ReadLine()) != null) {
      string op = Field(line, "op"), l = line;
      try { BeginInvoke(new Action(() => Command(op, l))); } catch { }
    }
    try { BeginInvoke(new Action(Close)); } catch { } // the program went away
  }

  void Command(string op, string json) {
    if (op == "listen") Begin();
    else if (op == "finish") { if (recording) Finish(); }
    else if (op == "show") Say(Field(json, "text"), Field(json, "tone"), Field(json, "done").Length > 0);
    else if (op == "paste") Paste(Field(json, "text"));
  }

  protected override void OnHandleCreated(EventArgs e) {
    base.OnHandleCreated(e);
    bool ok = RegisterHotKey(Handle, 1, MOD_WIN | MOD_ALT | MOD_NOREPEAT, VK_SPACE);
    Log(ok ? "hotkey Win+Alt+Space ready" : "hotkey Win+Alt+Space is taken by another program");
  }

  protected override void OnFormClosed(FormClosedEventArgs e) { UnregisterHotKey(Handle, 1); CloseWave(); base.OnFormClosed(e); }

  protected override void WndProc(ref Message m) {
    if (m.Msg == MM_WIM_DATA) { Heard(m.LParam); return; }
    if (m.Msg == WM_HOTKEY) {
      if (!holding) {
        holding = true; held.Start();
        var fg = GetForegroundWindow();
        Send("{\"op\":\"key\",\"fgProc\":" + Q(ProcName(fg)) + ",\"fgTitle\":" + Q(Title(fg)) + "}");
      }
      return;
    }
    base.WndProc(ref m);
  }

  static string Title(IntPtr h) { var s = new StringBuilder(512); GetWindowText(h, s, 512); return s.ToString(); }
  static string ProcName(IntPtr h) { uint pid; GetWindowThreadProcessId(h, out pid); try { return Process.GetProcessById((int)pid).ProcessName; } catch { return ""; } }
  static bool Down(byte vk) { return (GetAsyncKeyState(vk) & 0x8000) != 0; }

  static string WaveError(int err) { var t = new StringBuilder(256); waveInGetErrorText(err, t, 256); return t.ToString(); }

  void Begin() {
    if (recording) return;
    CloseWave();
    var format = new WAVEFORMATEX { wFormatTag = 1, nChannels = 1, nSamplesPerSec = RATE, nAvgBytesPerSec = RATE * 2, nBlockAlign = 2, wBitsPerSample = 16 };
    int err = waveInOpen(out wave, WAVE_MAPPER, ref format, Handle, IntPtr.Zero, CALLBACK_WINDOW);
    if (err != 0) {
      wave = IntPtr.Zero; Log("cannot record: " + WaveError(err));
      Status("没法录音：" + WaveError(err), "bad", true);
      Send("{\"op\":\"cancel\"}"); return;
    }
    int size = Marshal.SizeOf(typeof(WAVEHDR)), bytes = RATE * 2 * BUFFER_MS / 1000;
    for (int i = 0; i < BUFFERS; i++) {
      headers[i] = Marshal.AllocHGlobal(size);
      Marshal.StructureToPtr(new WAVEHDR { lpData = Marshal.AllocHGlobal(bytes), dwBufferLength = (uint)bytes }, headers[i], false);
      waveInPrepareHeader(wave, headers[i], size); waveInAddBuffer(wave, headers[i], size);
    }
    piece = new MemoryStream(); pieceMs = 0; quietMs = 0; pieces = 0; pieceHasSpeech = false;
    waveInStart(wave);
    recording = true; clock.Restart(); limit.Start();
    Log("recording");
  }

  /** A buffer of sound came in: into the piece; a pause after some speech ends the piece. */
  void Heard(IntPtr hdr) {
    if (!recording || wave == IntPtr.Zero) return; // the last buffers, handed back (and freed) as recording stops
    var h = (WAVEHDR)Marshal.PtrToStructure(hdr, typeof(WAVEHDR));
    int n = (int)h.dwBytesRecorded;
    if (n > 0) {
      var data = new byte[n]; Marshal.Copy(h.lpData, data, 0, n);
      piece.Write(data, 0, n);
      double sum = 0; for (int i = 0; i + 1 < n; i += 2) { double s = (short)(data[i] | data[i + 1] << 8); sum += s * s; }
      double level = Math.Sqrt(sum / Math.Max(1, n / 2));
      int ms = n * 1000 / (RATE * 2);
      bool speech = level > Math.Max(400, noise * 2.5);
      if (speech) { pieceHasSpeech = true; quietMs = 0; } else { quietMs += ms; noise = level < noise ? level : noise + (level - noise) * 0.05; }
      pieceMs += ms;
      if (pieceHasSpeech && (quietMs >= PAUSE_MS || pieceMs >= PIECE_MAX_MS)) EndPiece(false);
    }
    waveInAddBuffer(wave, hdr, Marshal.SizeOf(typeof(WAVEHDR)));
  }

  /**
   * The piece said so far, to the program. The last one goes even if it seemed quiet when nothing went before it
   * (a soft voice, a quiet microphone); otherwise quiet is dropped.
   */
  void EndPiece(bool last) {
    string path = "";
    if (piece.Length > 0 && (pieceHasSpeech || (last && pieces == 0 && clock.ElapsedMilliseconds >= QUIET_MIN_MS))) {
      path = Path.Combine(Path.GetTempPath(), "agentchat-voice-" + DateTime.Now.ToString("HHmmssfff") + "-" + pieces + ".wav");
      try { WriteWav(path, piece.ToArray()); pieces++; } catch (Exception e) { Log("saving a piece failed: " + e.Message); path = ""; }
    }
    piece = new MemoryStream(); pieceMs = 0; quietMs = 0; pieceHasSpeech = false;
    if (path.Length > 0 || last) Send("{\"op\":\"audio\",\"path\":" + Q(path) + ",\"last\":" + (last ? "true" : "false") + "}");
  }

  static void WriteWav(string path, byte[] pcm) {
    using (var f = new BinaryWriter(File.Create(path))) {
      f.Write(Encoding.ASCII.GetBytes("RIFF")); f.Write(36 + pcm.Length); f.Write(Encoding.ASCII.GetBytes("WAVEfmt "));
      f.Write(16); f.Write((short)1); f.Write((short)1); f.Write(RATE); f.Write(RATE * 2); f.Write((short)2); f.Write((short)16);
      f.Write(Encoding.ASCII.GetBytes("data")); f.Write(pcm.Length); f.Write(pcm);
    }
  }

  void CloseWave() {
    if (wave == IntPtr.Zero) return;
    var w = wave; wave = IntPtr.Zero;
    waveInReset(w);
    int size = Marshal.SizeOf(typeof(WAVEHDR));
    for (int i = 0; i < BUFFERS; i++) {
      if (headers[i] == IntPtr.Zero) continue;
      waveInUnprepareHeader(w, headers[i], size);
      var h = (WAVEHDR)Marshal.PtrToStructure(headers[i], typeof(WAVEHDR));
      Marshal.FreeHGlobal(h.lpData); Marshal.FreeHGlobal(headers[i]); headers[i] = IntPtr.Zero;
    }
    waveInClose(w);
  }

  void Finish() {
    if (!recording) return;
    limit.Stop();
    long ms = clock.ElapsedMilliseconds;
    recording = false;
    CloseWave();
    if (ms < SHORT_MS) { piece = new MemoryStream(); Status("按得太短，没录到内容", "busy", true); Send("{\"op\":\"cancel\"}"); return; }
    Status("识别中…", "busy", false);
    Log("recorded " + ms + " ms in " + (pieces + (pieceHasSpeech ? 1 : 0)) + " pieces");
    EndPiece(true);
  }

  /** Into the window with the cursor: through the clipboard (any program takes Ctrl+V), which is then put back. */
  void Paste(string text) {
    if (text.Length == 0) return;
    // The hotkey's keys may still be down on this computer (the owner just let go of them).
    var sw = Stopwatch.StartNew();
    while (sw.ElapsedMilliseconds < 1500 && (Down(VK_LWIN) || Down(VK_RWIN) || Down(VK_MENU) || Down(VK_SPACE))) { Application.DoEvents(); Thread.Sleep(15); }
    string saved = null;
    try { if (Clipboard.ContainsText()) saved = Clipboard.GetText(); } catch { }
    try { Clipboard.SetText(text); } catch (Exception e) { Log("clipboard: " + e.Message); return; }
    Thread.Sleep(60);
    keybd_event(VK_CONTROL, 0, 0, UIntPtr.Zero); keybd_event(VK_V, 0, 0, UIntPtr.Zero);
    keybd_event(VK_V, 0, KEYUP, UIntPtr.Zero); keybd_event(VK_CONTROL, 0, KEYUP, UIntPtr.Zero);
    Log("pasted " + text.Length + " chars into [" + ProcName(GetForegroundWindow()) + "]");
    if (saved != null) {
      var t = new System.Windows.Forms.Timer { Interval = 1500 };
      t.Tick += (s, e) => { t.Stop(); t.Dispose(); try { Clipboard.SetText(saved); } catch { } };
      t.Start();
    }
  }
}
'@

if ($args -contains '-CompileOnly') { 'compiled ok'; return }
[System.Windows.Forms.Application]::Run((New-Object VoiceHelper))
