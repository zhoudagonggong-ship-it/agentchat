// Local control window (127.0.0.1 only). Shows this computer's role, joins and activity.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
let state = null;
let picking = false;

async function post(path, body = {}) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-AllinOne': '1' }, body: JSON.stringify(body) });
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({}));
    alert(error || '操作失败');
  }
}

function connect() {
  const ws = new WebSocket(`ws://${location.host}/ws/control`);
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.t === 'state') {
      state = msg.state;
      render();
    }
  };
  // The program restarts when the role changes; reconnect quietly.
  ws.onclose = () => setTimeout(connect, 800);
}

const ROLE = { hub: '主电脑 · 负责连接手机和其他电脑', device: '设备', paused: '已暂停', none: '正在查找主电脑…' };
const LINK = { joined: '已连接主电脑', pending: '等待主电脑允许加入', connecting: '正在连接主电脑…', rejected: '被主电脑拒绝' };

// What the owner still has to do before AgentChat runs, one step at a time; each finishes by itself once done.
const SETUP = {
  install: ['第 1 步：安装 Tailscale', 'AgentChat 通过 Tailscale 把你的电脑和手机安全地连在一起，先装上它（免费）。', '装好并登录后，这里会自动继续。', '下载 Tailscale'],
  start: ['第 1 步：打开 Tailscale', 'Tailscale 已经装好，但现在没有运行。', '打开后，这里会自动继续。', '打开 Tailscale'],
  login: ['第 2 步：登录 Tailscale', '在打开的网页里登录。你所有的电脑和手机，都要登录同一个账号。', '登录后，这里会自动继续。', '去登录'],
  https: ['最后一步：在 Tailscale 里打开 HTTPS', '只需要做一次。点按钮打开网页，在网页里点「Enable」（启用）。', '打开后一分钟内，这里会自动继续。', '打开设置网页'],
};

function render() {
  const s = state;
  const step = s.setup && SETUP[s.setup.step];
  $('setup').hidden = !step;
  if (step) {
    [$('setup-title').textContent, $('setup-text').textContent, $('setup-sub').textContent, $('setup-do').textContent] = step;
    $('setup-do').dataset.step = s.setup.step;
  }
  // Without Tailscale there is nothing else to show yet.
  for (const id of ['picker', 'pending-box', 'members-box', 'phone-box']) if (step && s.setup.step !== 'https') $(id).hidden = true;
  $('name').textContent = s.self.name;
  let role = ROLE[s.role];
  if (s.role === 'device' && s.link) role = `${LINK[s.link.status]}「${s.hub?.name ?? ''}」${s.link.detail ? '：' + s.link.detail : ''}`;
  if (s.agents.length) role += ` · ${s.agents.map((a) => a.label).join('、')}`;
  $('role').textContent = step ? '还差几步就能用了' : role;
  const color = s.role === 'paused' ? '' : step || s.role === 'none' || s.pending.length || (s.link && s.link.status !== 'joined') ? 'orange' : 'green';
  $('badge').className = 'badge ' + color;

  // No 主电脑 anywhere yet: one question. Another computer that already is one is joined by itself.
  const first = !step && s.role === 'none' && !picking ? s.firstStart : null;
  $('first').hidden = !first;
  if (first === 'ask') {
    $('first-title').textContent = '这台电脑平时开着吗？';
    $('first-text').textContent = 'AgentChat 需要一台常开的电脑当「主电脑」，由它连接你的手机和其他电脑。没有找到已有的主电脑。';
    $('first-sub').textContent = '以后可以在「设置 → 主电脑」里更换。';
    $('first-yes').textContent = '是，用它当主电脑';
  } else if (first === 'waiting') {
    $('first-title').textContent = '正在等主电脑';
    $('first-text').textContent = '在你平时开着的那台电脑上安装 AgentChat，并让它当主电脑，这台会自动连上它。';
    $('first-sub').textContent = '';
    $('first-yes').textContent = '还是用这台当主电脑';
  }
  $('first-no').hidden = first !== 'ask';
  if (first === 'ask') $('role').textContent = '还差一步就能用了';

  // Picking the 主电脑 by hand: only when changing it (设置 → 主电脑 → 更换).
  const showPicker = picking && !(step && s.setup.step !== 'https');
  $('picker').hidden = !showPicker;
  $('picker-title').textContent = s.role === 'none' ? '选择主电脑' : '更换主电脑';
  $('rediscover').textContent = s.discovering ? '查找中…' : '重新查找';
  if (showPicker) {
    $('peers').innerHTML = s.peers.filter((p) => p.os !== 'android' && p.os !== 'iOS').map((p) => {
      const current = s.hub?.stableId === p.stableId;
      let action = '';
      if (current) action = '<span class="tag hub">当前主电脑</span>';
      else if (p.self) action = `<button class="btn" data-hub="${esc(p.stableId)}">设为主电脑</button>`;
      else if (p.isHub) action = `<button class="btn" data-hub="${esc(p.stableId)}">加入</button>`;
      else if (s.role === 'hub' && p.member === 'online') action = `<button class="btn plain" data-hub="${esc(p.stableId)}">移交给它</button>`;
      else action = `<span class="tag">${p.online ? '未运行 AgentChat' : '离线'}</span>`;
      return `<div class="row"><span class="dot ${p.online ? 'on' : ''}"></span><div class="grow">${esc(p.name)}${p.self ? '（本机）' : ''}
        ${p.isHub && !current ? '<div class="sub">正在作为主电脑运行</div>' : ''}</div>${action}</div>`;
    }).join('');
  }

  // Running, but nothing to connect: where to get an agent.
  $('no-agents').hidden = Boolean(step) || !(s.role === 'hub' || s.role === 'device') || s.agents.length > 0;

  $('pending-box').hidden = !s.pending.length;
  $('pending').innerHTML = s.pending.map((p) => `<div class="row"><div class="grow">${esc(p.name)}<div class="sub">请求加入这台主电脑</div></div>
    <button class="btn plain" data-deny="${esc(p.id)}">拒绝</button><button class="btn" data-allow="${esc(p.id)}">允许</button></div>`).join('');

  const members = s.role === 'hub' ? s.peers.filter((p) => p.member) : [];
  $('members-box').hidden = !members.length;
  const MEMBER = { online: ['在线', ''], offline: ['离线', ''], pending: ['等待允许', 'warn'] };
  $('members').innerHTML = members.map((p) => {
    const [label, cls] = MEMBER[p.member];
    return `<div class="row"><span class="dot ${p.member === 'online' ? 'on' : ''}"></span><div class="grow">${esc(p.name)}${p.self ? '（本机）' : ''}</div><span class="tag ${cls}">${label}</span></div>`;
  }).join('');

  // The phone cannot reach the hub before HTTPS is on.
  $('phone-box').hidden = !s.phoneUrl || Boolean(step);
  $('pair-row').hidden = s.role !== 'hub';
  if (s.role !== 'hub') $('pair-box').hidden = true;
  $('phone-url').textContent = s.phoneUrl || '';

  $('activity').innerHTML = s.activity.length
    ? s.activity.map((a) => `<div class="row"><span class="time">${new Date(a.at).toTimeString().slice(0, 5)}</span><span class="${a.level === 'warn' ? 'warn' : ''}">${esc(a.text)}</span></div>`).join('')
    : '<div class="row empty">暂无动态</div>';

  $('release-row').hidden = !s.release;
  if (s.release) $('release-version').textContent = s.release.version;
  $('hub-name').textContent = s.hub ? s.hub.name : '未选择';
  $('change-hub').textContent = s.role === 'none' ? '手动选择' : '更换';
  $('autostart').checked = s.autostart;
  $('paused').checked = s.role === 'paused';
}

document.addEventListener('click', (event) => {
  const t = event.target;
  if (t.dataset.hub) {
    const peer = state.peers.find((p) => p.stableId === t.dataset.hub);
    const ask = state.role === 'hub' ? `把主电脑移交给「${peer.name}」？其他电脑和手机会自动跟过去。` : peer.self ? '把本机设为主电脑？' : `加入「${peer.name}」这台主电脑？`;
    if (confirm(ask)) {
      picking = false;
      post('/api/hub', { stableId: t.dataset.hub });
    }
  }
  if (t.dataset.allow) post('/api/allow', { id: t.dataset.allow });
  if (t.dataset.deny) post('/api/deny', { id: t.dataset.deny });
});
$('first-yes').addEventListener('click', () => post('/api/first', { yes: true }));
$('first-no').addEventListener('click', () => post('/api/first', { yes: false }));
$('setup-do').addEventListener('click', (e) => post('/api/setup', { do: e.target.dataset.step }));
$('release-install').addEventListener('click', (e) => {
  e.target.disabled = true;
  e.target.textContent = '更新中…';
  post('/api/release-install');
});
$('rediscover').addEventListener('click', () => post('/api/discover'));
$('change-hub').addEventListener('click', () => {
  picking = true;
  post('/api/discover');
  render();
});
$('picker-cancel').addEventListener('click', () => {
  picking = false;
  render();
});
$('copy').addEventListener('click', () => navigator.clipboard.writeText(state.phoneUrl || ''));
$('pair').addEventListener('click', async () => {
  const res = await fetch('/api/pair-link', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-AllinOne': '1' }, body: '{}' });
  const { link, error } = await res.json();
  if (!link) return alert(error || '无法生成二维码');
  $('pair-box').hidden = false;
  $('pair-link').textContent = link;
  if (window.qrcode) {
    const qr = window.qrcode(0, 'M');
    qr.addData(link);
    qr.make();
    $('qr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  } else {
    $('qr').textContent = '二维码组件缺失';
  }
});
$('diagnostics').addEventListener('click', async (e) => {
  e.target.disabled = true;
  e.target.textContent = '导出中…';
  await post('/api/diagnostics');
  e.target.disabled = false;
  e.target.textContent = '导出诊断信息';
});
$('autostart').addEventListener('change', (e) => post('/api/autostart', { enabled: e.target.checked }));
$('paused').addEventListener('change', (e) => post('/api/pause', { paused: e.target.checked }));

connect();
