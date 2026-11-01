// The app's own pages in the phone's language: Chinese on a Chinese phone, English elsewhere (like the hub's page).
// Words in the page are swapped when it loads; words set later go through L().
(function () {
  var zh = /^zh/i.test(navigator.language);
  var EN = {
    '暂时连不上主电脑': "Can't reach the main computer", '请确认手机已打开 Tailscale，并且主电脑开着机。': 'Make sure Tailscale is on and the main computer is running.',
    '重试': 'Retry', '去设置 Tailscale 的电池': "Tailscale's battery setting", 'AgentChat 自己也要在后台运行，才能及时提醒你。': 'AgentChat also needs to run in the background to alert you in time.',
    '允许 AgentChat 在后台运行': 'Let AgentChat run in the background', '换了主电脑？重新扫码配对': 'New main computer? Pair again',
    '手机上还没有 Tailscale': 'Tailscale is not on this phone', 'AgentChat 通过 Tailscale 连接你的电脑。先安装它，并登录和电脑同一个账号。': 'AgentChat reaches your computers through Tailscale. Install it and sign in with the same account as the computers.',
    '安装 Tailscale': 'Install Tailscale', 'Tailscale 没有打开': 'Tailscale is off', '打开 Tailscale，点开关连上，再回到这里。': 'Open Tailscale, switch it on, then come back here.',
    '打开 Tailscale': 'Open Tailscale', 'Tailscale 已经连上了。主电脑可能关机、睡眠，或 AgentChat 没在运行。': 'Tailscale is on. The main computer may be off or asleep, or AgentChat is not running.',
    '关闭': 'Close', '对准电脑上的二维码': 'Point at the QR code on the computer', '在主电脑的「AgentChat」窗口点「添加手机 · 显示二维码」': 'On the main computer, open AgentChat and choose "Add phone · Show QR code"',
    '这不是 AgentChat 的配对码': 'Not an AgentChat pairing code', '已识别，正在配对…': 'Got it, pairing…', '无法打开相机': "Can't open the camera",
    '请在系统设置里允许「AgentChat」使用相机': 'Allow AgentChat to use the camera in system settings', '连接你的主电脑': 'Connect your main computer',
    '只需要扫一次码': 'You only scan once', '确认手机已打开 Tailscale': 'Make sure Tailscale is on', '在主电脑的托盘里打开「AgentChat」，点「添加手机 · 显示二维码」': 'On the main computer, open AgentChat from the tray and choose "Add phone · Show QR code"',
    '点下面的按钮，对准二维码': 'Tap the button below and point at the QR code', '扫码配对': 'Scan to pair',
  };
  // The battery hint has markup inside: as a whole.
  var HTML = { 'battery-text': 'Phones often close Tailscale to save battery. Open its app info, tap Battery and choose <b>Unrestricted</b>, and it stays on.' };
  window.L = function (s) { return zh ? s : EN[s] || s; };
  if (zh) return;
  document.documentElement.lang = 'en';
  var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (var n = walker.nextNode(); n; n = walker.nextNode()) {
    var key = n.nodeValue.trim();
    if (EN[key]) n.nodeValue = n.nodeValue.replace(key, EN[key]);
  }
  for (var id in HTML) if (document.getElementById(id)) document.getElementById(id).innerHTML = HTML[id];
  document.querySelectorAll('[aria-label]').forEach(function (el) { el.setAttribute('aria-label', window.L(el.getAttribute('aria-label'))); });
})();
