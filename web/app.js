// Phone / browser client for the hub. Plain ES module, no build step.
// Five tabs: 项目 (agent > project > conversation), 聊天 (conversations by time), 通讯录 (friends = device · agent),
// 工作台 and 资料库. Only agents the owner added in 通讯录 show up elsewhere.
const $ = (id) => document.getElementById(id);
const CACHE_KEY = 'allinone.cache.v3';
const CACHE_SESSIONS = 6; // conversations whose messages are kept for instant start
const CACHE_ITEMS = 150;
const SILENCE_LIMIT_MS = 75_000;
const native = window.AllinOneNative;

const state = {
  seq: 0,
  devices: new Map(),
  sessions: new Map(),
  items: new Map(), // sessionId -> Map(itemId -> item)
  itemSeq: new Map(), // sessionId -> highest item seq seen
  requests: new Map(),
  deltas: new Map(), // itemId -> { sessionId, turnId, text }
  approvals: new Map(), // sessionId|itemId -> pending approval item (all conversations)
  artifacts: new Map(), // sessionId|itemId -> artifact item (all conversations)
  friends: new Map(), // device|agent -> { deviceId, agentId, added, remark }
  projects: new Map(), // device|agent -> [{ id, name }] in the agent's own order
  expanded: [], // open nodes of the project tree: "f:<friend>" and "p:<friend>|<project>"
  treeInit: false, // the tree was shown once (its first friend opened by default)
  outbox: [], // commands typed while disconnected; requestIds make resending safe
  friendLast: {}, // friend key -> last opened sessionId
  recent: [], // recently opened sessions, newest first
  tab: 'chat',
  current: null,
  limit: 300,
  right: { mode: 'files', filter: 'all', item: null, from: 'chat' },
  filesFilter: 'all',
  filesQuery: '',
  ws: null,
  connected: false,
  lastHeard: 0,
  helloAfter: 0,
  backoff: 1000,
};

// ---------- helpers ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const base = (p) => (p ? String(p).split(/[\\/]/).filter(Boolean).pop() : '');
const newId = () => crypto.randomUUID().replaceAll('-', '');
const wide = () => matchMedia('(min-width: 720px)').matches;
// The tri-fold opened is about 1080 CSS px wide; keep in step with style.css.
const trifold = () => matchMedia('(min-width: 1000px)').matches;

function when(seconds) {
  const d = new Date(seconds * 1000);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toTimeString().slice(0, 5);
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return '昨天';
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function stamp(ms) {
  const d = new Date(ms);
  const day = when(ms / 1000);
  const hm = d.toTimeString().slice(0, 5);
  return day.includes(':') ? hm : `${day} ${hm}`;
}

function size(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Small, safe markdown: code blocks, inline code, bold, links, headings. */
function md(text) {
  return String(text ?? '').split(/```[^\n]*\n?/).map((part, i) => {
    if (i % 2) return `<pre><code>${esc(part.replace(/\n$/, ''))}</code></pre>`;
    return esc(part)
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
      .replace(/^#{1,6} (.+)$/gm, '<b>$1</b>')
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  }).join('');
}

function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), 2600);
}

function sortedItems(sessionId) {
  return [...(state.items.get(sessionId)?.values() || [])].sort((a, b) => a.ts - b.ts || a.seq - b.seq);
}

// ---------- friends: one per device · agent ----------

const friendKey = (s) => `${s.deviceId}|${s.agentId}`;
const deviceName = (id) => state.devices.get(id)?.name || '未知设备';
const agentLabel = (deviceId, agentId) => state.devices.get(deviceId)?.agents.find((a) => a.id === agentId)?.label || agentId;

/** The remark the owner gave, else the computer's name (plus the agent when the computer has several). */
function friendName(deviceId, agentId) {
  const remark = state.friends.get(`${deviceId}|${agentId}`)?.remark;
  if (remark) return remark;
  const agents = state.devices.get(deviceId)?.agents || [];
  return agents.length > 1 ? `${deviceName(deviceId)} · ${agentLabel(deviceId, agentId)}` : deviceName(deviceId);
}

const isFriend = (s) => state.friends.get(friendKey(s))?.added === true;
// Lists show the last month; older conversations stay reachable through search.
const RECENT_S = 30 * 86_400;
const isRecent = (s) => s.pinned || s.running || s.id === state.current || Date.now() / 1000 - s.updatedAt < RECENT_S || isUnread(s);
/** A conversation agents keep only for passing work to each other: never listed (its approvals still reach the owner). */
const isChannel = (s) => /^(AgentChat|AllinOne) 协作/.test(s.title); // AllinOne: the old name
const visibleSessions = () => [...state.sessions.values()].filter((s) => isFriend(s) && isRecent(s) && !isChannel(s));

/**
 * The friend's picture (the owner's own, kept on the hub) or its first letter. `count`: unread replies, a red number;
 * `quiet` (消息免打扰): a grey dot instead. `profile`: tapping it opens the friend's page.
 */
function avatar(deviceId, agentId, small = false, count = 0, quiet = false, profile = false) {
  let h = 0;
  for (const c of deviceId) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const online = state.devices.get(deviceId)?.online;
  const f = state.friends.get(`${deviceId}|${agentId}`);
  const face = f?.avatar ? `<img src="/files/${esc(f.avatar)}" alt="">` : esc([...friendName(deviceId, agentId)][0]?.toUpperCase() || '?');
  const mark = !count ? '' : quiet ? '<span class="count quiet"></span>' : `<span class="count">${count > 99 ? '99+' : count}</span>`;
  return `<span class="avatar${small ? ' sm' : ''} c${(h % 4) + 1}${f?.avatar ? ' pic' : ''}${online === false ? ' off' : ''}"${profile ? ` data-profile="${esc(`${deviceId}|${agentId}`)}"` : ''}>${face}${mark}</span>`;
}

/** 消息免打扰: set on the conversation, or on its agent for all of them. */
const isMuted = (s) => Boolean(s.muted || state.friends.get(friendKey(s))?.muted);

/** New replies since the conversation was last read. The hub counts the replies and keeps what was read, for every phone. */
function unreadCount(s) {
  if (s.id === state.current) return 0;
  return Math.max(0, (s.replies ?? 0) - (s.readReplies ?? s.replies ?? 0));
}
const isUnread = (s) => unreadCount(s) > 0;

function markRead(s) {
  if (!s) return;
  if ((s.readReplies ?? 0) < (s.replies ?? 0)) {
    s.readReplies = s.replies;
    send({ t: 'read', sessionId: s.id, replies: s.replies });
  }
  native?.markRead?.(s.id); // clears its notification, and with it the app-icon count
}

/** Added friends with their conversations; `all` also includes ones waiting in "new friends". */
function friends(all = false) {
  const list = [];
  for (const f of state.friends.values()) {
    if (!all && !f.added) continue;
    if (!state.devices.get(f.deviceId)?.approved) continue;
    const key = `${f.deviceId}|${f.agentId}`;
    const everything = [...state.sessions.values()].filter((s) => friendKey(s) === key && !isChannel(s)).sort((a, b) => b.updatedAt - a.updatedAt);
    const sessions = everything.filter(isRecent);
    list.push({ ...f, key, sessions, everything, latest: sessions[0] || null, unread: sessions.filter((s) => isUnread(s) && !isMuted(s)).length, running: sessions.some((s) => s.running) });
  }
  return list.sort((a, b) => friendName(a.deviceId, a.agentId).localeCompare(friendName(b.deviceId, b.agentId)));
}

/** A friend's conversations grouped the way the agent's own app groups them. */
function projectGroups(key, sessions) {
  const order = state.projects.get(key) || [];
  const groups = order.map((p) => ({ id: p.id, name: p.name, sessions: [] }));
  const byId = new Map(groups.map((g) => [g.id, g]));
  const other = { id: '', name: '未归入项目', sessions: [] };
  for (const s of sessions) {
    const g = (s.projectId && byId.get(s.projectId)) || (s.projectId ? null : other);
    if (g) g.sessions.push(s);
    else {
      // A project the list does not know yet (renamed or just created): show it under its own name.
      const fresh = { id: s.projectId, name: s.projectName || '项目', sessions: [s] };
      byId.set(s.projectId, fresh);
      groups.push(fresh);
    }
  }
  if (other.sessions.length) groups.push(other);
  for (const g of groups) g.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  return groups;
}

const projectLabel = (s) => s.projectName || '未归入项目';

// ---------- cache: show the last known state immediately ----------

function loadCache() {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    if (!c) return;
    state.seq = c.seq || 0;
    for (const d of c.devices || []) state.devices.set(d.id, d);
    for (const s of c.sessions || []) state.sessions.set(s.id, s);
    for (const [sid, list] of Object.entries(c.items || {})) state.items.set(sid, new Map(list.map((i) => [i.itemId, i])));
    for (const [sid, seq] of Object.entries(c.itemSeq || {})) state.itemSeq.set(sid, seq);
    state.recent = c.recent || [];
    state.outbox = c.outbox || [];
    state.friendLast = c.friendLast || {};
    state.tab = c.tab || 'chat';
    state.expanded = c.expanded || [];
    state.treeInit = c.treeInit ?? state.expanded.length > 0;
    for (const f of c.friends || []) state.friends.set(`${f.deviceId}|${f.agentId}`, f);
    for (const [k, v] of Object.entries(c.projects || {})) state.projects.set(k, v);
  } catch {
    localStorage.removeItem(CACHE_KEY);
  }
}

let saveTimer = null;
function saveCache() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const keep = state.recent.slice(0, CACHE_SESSIONS);
    const items = {};
    const itemSeq = {};
    for (const sid of keep) {
      const list = sortedItems(sid).slice(-CACHE_ITEMS);
      if (!list.length) continue;
      items[sid] = list;
      // Only claim what was kept, so reopening fetches anything older that was dropped.
      itemSeq[sid] = Math.min(state.itemSeq.get(sid) || 0, Math.max(...list.map((i) => i.seq)));
    }
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ seq: state.seq, devices: [...state.devices.values()], sessions: [...state.sessions.values()],
        items, itemSeq, recent: state.recent, outbox: state.outbox, friendLast: state.friendLast, tab: state.tab,
        expanded: state.expanded, treeInit: state.treeInit, friends: [...state.friends.values()], projects: Object.fromEntries(state.projects) }));
    } catch {
      // storage full: keep running from memory
    }
  }, 500);
}

// ---------- connection ----------

function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/app`);
  state.ws = ws;
  ws.onopen = () => {
    state.connected = true;
    state.backoff = 1000;
    state.lastHeard = Date.now();
    state.helloAfter = state.seq;
    send({ t: 'hello', v: 1, after: state.seq });
    if (state.current) send({ t: 'open', sessionId: state.current, after: state.itemSeq.get(state.current) || 0 });
    if (state.tab === 'library') send({ t: 'artifacts' });
    for (const m of state.outbox.splice(0)) send(m);
    renderConn();
  };
  ws.onmessage = (event) => {
    state.lastHeard = Date.now();
    try {
      handle(JSON.parse(event.data));
    } catch (error) {
      console.error(error);
    }
  };
  ws.onclose = () => {
    if (state.ws !== ws) return;
    state.connected = false;
    renderConn();
    setTimeout(connect, state.backoff);
    state.backoff = Math.min(state.backoff * 2, 15_000);
  };
}

setInterval(() => {
  if (state.connected && Date.now() - state.lastHeard > SILENCE_LIMIT_MS) state.ws.close();
}, 10_000);
document.addEventListener('visibilitychange', () => {
  // Phones drop sockets in the background; come back fast instead of waiting for the backoff.
  if (document.visibilityState === 'visible' && !state.connected) {
    state.backoff = 1000;
    if (state.ws && state.ws.readyState !== WebSocket.CONNECTING) state.ws.close();
  }
});

function send(msg) {
  if (state.connected) state.ws.send(JSON.stringify(msg));
}

function command(sessionId, cmd) {
  const msg = { t: 'command', sessionId, command: cmd };
  if (state.connected) send(msg);
  else {
    state.outbox.push(msg);
    saveCache();
  }
}

function track(item) {
  const key = `${item.sessionId}|${item.itemId}`;
  if (item.kind === 'approval_request') {
    if (item.data.state === 'pending') state.approvals.set(key, item);
    else state.approvals.delete(key);
  } else if (item.kind === 'artifact') {
    state.artifacts.set(key, item);
  }
}

function handle(msg) {
  switch (msg.t) {
    case 'version':
      // The hub has a newer page than the one on screen (an app left open across an update): reload it.
      if (state.web && state.web !== msg.web) return location.reload();
      state.web = msg.web;
      return;
    case 'devices':
      state.devices = new Map(msg.devices.map((d) => [d.id, d]));
      break;
    case 'friends':
      state.friends = new Map(msg.friends.map((f) => [`${f.deviceId}|${f.agentId}`, f]));
      break;
    case 'settings':
      state.hubSettings = msg.settings;
      break;
    case 'projects':
      state.projects.set(`${msg.deviceId}|${msg.agentId}`, msg.projects);
      break;
    case 'sessions':
      if (msg.seq < state.helloAfter) {
        // The hub was reset: forget everything cached from before.
        state.sessions.clear();
        state.items.clear();
        state.itemSeq.clear();
        state.requests.clear();
      }
      state.helloAfter = 0;
      for (const s of msg.sessions) state.sessions.set(s.id, s);
      for (const id of msg.archived) state.sessions.delete(id);
      state.seq = Math.max(state.seq, msg.seq);
      markRead(state.sessions.get(state.current));
      if (!state.current) openFromHash();
      break;
    case 'items': {
      let map = state.items.get(msg.sessionId);
      if (!map) state.items.set(msg.sessionId, (map = new Map()));
      for (const item of msg.items) {
        map.set(item.itemId, item);
        state.deltas.delete(item.itemId);
        state.itemSeq.set(msg.sessionId, Math.max(state.itemSeq.get(msg.sessionId) || 0, item.seq));
        track(item);
      }
      break;
    }
    case 'collection':
      if (msg.name === 'approvals') state.approvals.clear();
      for (const item of msg.items) track(item);
      break;
    case 'requests':
      for (const r of msg.requests) state.requests.set(r.requestId, r);
      break;
    case 'delta': {
      const d = state.deltas.get(msg.itemId) || { sessionId: msg.sessionId, turnId: msg.turnId, text: '' };
      d.text += msg.text;
      state.deltas.set(msg.itemId, d);
      break;
    }
    case 'error':
      toast(msg.message);
      break;
    case 'hubMoved':
      // The owner moved the hub to another computer: follow it.
      toast('主电脑已更换，正在跳转…');
      localStorage.removeItem(CACHE_KEY);
      setTimeout(() => location.replace(msg.url), 1500);
      return;
    case 'tick':
      return;
  }
  schedule(msg.t === 'items' || msg.t === 'delta' || msg.t === 'requests' ? msg.sessionId ?? null : null);
  saveCache();
}

// Re-render on the next frame (or soon, if the page is in the background).
let pending = false;
function schedule() {
  if (pending) return;
  pending = true;
  const run = () => {
    if (!pending) return;
    pending = false;
    renderAll(false);
  };
  requestAnimationFrame(run);
  setTimeout(run, 250);
}

// ---------- rendering ----------

function renderAll(jump) {
  renderConn();
  renderNav();
  if (state.tab === 'project') renderProjects();
  if (state.tab === 'chat') renderChats();
  if (state.tab === 'contacts') renderContacts();
  if (state.tab === 'work') renderWork();
  if (state.tab === 'library') renderFilesTab();
  renderHeader();
  renderMessages(jump);
  renderRight();
  if (!$('sheet').hidden) renderSheet();
}

function renderConn() {
  $('conn').className = 'conn' + (state.connected ? ' ok' : '');
  $('conn').title = state.connected ? '已连接主电脑' : '正在连接主电脑…';
}

function renderNav() {
  for (const b of $('nav').querySelectorAll('button')) b.classList.toggle('on', b.dataset.tab === state.tab);
  // Muted conversations show their own grey dot but stay out of the count, as in WeChat.
  const unread = visibleSessions().filter((s) => !isMuted(s)).reduce((n, s) => n + unreadCount(s), 0);
  const fresh =friends(true).filter((f) => !f.added).length;
  const badge = (id, n) => {
    $(id).hidden = !n;
    $(id).textContent = n > 99 ? '99+' : n;
  };
  badge('badge-chat', unread);
  badge('badge-contacts', fresh);
  badge('badge-work', state.approvals.size);
}

function setTab(tab) {
  state.tab = tab;
  $('app').dataset.tab = tab;
  setView('side');
  if (tab === 'library') send({ t: 'artifacts' });
  // With three columns the right pane follows the page: a friend's profile in 通讯录, the conversation elsewhere.
  if (trifold()) {
    const first = friends()[0];
    if (tab === 'contacts' && state.right.mode !== 'profile' && first) state.right = { ...state.right, mode: 'profile', key: first.key, from: 'side' };
    else if (tab !== 'contacts' && (state.right.mode === 'profile' || state.right.mode === 'settings')) state.right = { ...state.right, mode: 'files' };
    if (tab === 'library' && state.right.mode !== 'preview') state.right = { ...state.right, mode: 'files', item: null };
  }
  renderAll(false);
  saveCache();
}

function setView(view) {
  $('app').dataset.view = view;
  syncBrowser();
}

// ---------- 项目: agent > project > conversation ----------

const isOpen = (node) => state.expanded.includes(node);
function toggle(node) {
  state.expanded = isOpen(node) ? state.expanded.filter((n) => n !== node) : [...state.expanded, node];
  saveCache();
}

// The project tree marks news by colour alone (system blue, a touch bolder), never red badges.
const fresh = (on) => (on ? ' unread' : '');

function threadRow(s, sub) {
  return `<button class="tree-thread${s.id === state.current ? ' active' : ''}" data-open="${esc(s.id)}">${s.running ? '<span class="dot run"></span>' : ''}
    <span class="t"><b class="${fresh(isUnread(s))}">${esc(s.title)}</b><span>${esc(sub ?? (s.running ? '运行中' : `${when(s.updatedAt)}${s.preview ? ' · ' + s.preview : ''}`))}</span></span></button>`;
}

function renderProjects() {
  const list = friends();
  if (!list.length) return void ($('projects').innerHTML = '<div class="empty-note">还没有好友。到「通讯录」里添加电脑上的 Agent 后，它的项目和对话会出现在这里。</div>');
  // First visit only: open the first friend so the tree is not all closed. After that the owner's folding stands.
  if (!state.treeInit && list[0]) {
    state.treeInit = true;
    state.expanded = [`f:${list[0].key}`];
  }
  let html = `<div class="section">你的助手 · ${list.length}</div>`;
  for (const f of list) {
    // Conversations quiet for a month are left out unless the owner asks for them (the note at the bottom).
    const onode = `o:${f.key}`;
    const sessions = isOpen(onode) ? f.everything : f.sessions;
    const fnode = `f:${f.key}`;
    const open = isOpen(fnode);
    const device = state.devices.get(f.deviceId);
    const status = !device?.online ? '设备离线' : f.running ? '有任务正在运行' : `${f.sessions.length} 个对话`;
    html += `<button class="tree-agent${open ? ' open' : ''}" data-toggle="${esc(fnode)}">${avatar(f.deviceId, f.agentId, false, 0, false, true)}
      <span class="t"><b class="${fresh(f.unread)}">${esc(friendName(f.deviceId, f.agentId))}</b><span>${esc(status)}</span></span><span class="chev">›</span></button>`;
    if (!open) continue;
    html += '<div class="tree-body">';
    const pinned = sessions.filter((s) => s.pinned);
    if (pinned.length) html += `<div class="section">置顶对话</div><div class="pinned-box">${pinned.map((s) => threadRow(s)).join('')}</div>`;
    for (const g of projectGroups(f.key, sessions)) {
      const pnode = `p:${f.key}|${g.id}`;
      const popen = isOpen(pnode);
      const unread = g.sessions.filter(isUnread).length;
      html += `<button class="tree-folder${popen ? ' open' : ''}${g.sessions.length ? '' : ' empty-folder'}" data-toggle="${esc(pnode)}">
        <span class="fold"></span><span class="t${fresh(unread)}">${esc(g.name)}</span><span class="n">${g.sessions.length}</span><span class="chev self">›</span></button>`;
      if (popen && g.sessions.length) html += `<div class="tree-threads">${g.sessions.map((s) => threadRow(s)).join('')}</div>`;
    }
    const older = f.everything.length - f.sessions.length;
    if (older > 0) html += `<button class="older-note link" data-toggle="${esc(onode)}">${isOpen(onode) ? '收起一个月内没有活动的对话' : `显示另外 ${older} 个一个月内没有活动的对话`}</button>`;
    html += '</div>';
  }
  $('projects').innerHTML = html;
}

$('projects').addEventListener('click', (e) => {
  // The agent's picture opens its page; the rest of the row folds it open or shut.
  const face = e.target.closest('[data-profile]');
  if (face) return showRight({ mode: 'profile', key: face.dataset.profile, from: 'side' });
  const t = e.target.closest('[data-toggle]');
  if (!t) return;
  toggle(t.dataset.toggle);
  renderProjects();
});

// ---------- 聊天: every conversation, most recent first ----------

const CHAT_ROWS = 200;

function renderChats() {
  const list = visibleSessions().sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt).slice(0, CHAT_ROWS);
  $('chats').innerHTML = list.map((s) => {
    const unread = unreadCount(s);
    const quiet = isMuted(s);
    return `<button class="friend${s.id === state.current ? ' active' : ''}${s.id === state.landed ? ' landed' : ''}" data-open="${esc(s.id)}" role="listitem">
      ${avatar(s.deviceId, s.agentId, false, unread, quiet)}
      <span class="body"><div class="name">${esc(s.title)}</div>
        <div class="preview">${s.running ? '<span class="dot run"></span>' : ''}<span>${esc(friendName(s.deviceId, s.agentId))} · ${esc(projectLabel(s))}</span></div></span>
      <span class="time">${s.pinned ? '<div class="fmeta">置顶</div>' : ''}${when(s.updatedAt)}${quiet ? '<div class="muted-mark" title="消息免打扰">🔕</div>' : ''}</span></button>`;
  }).join('') || '<div class="empty-note">还没有对话。到「通讯录」里添加电脑上的 Agent 后，它的对话会按时间出现在这里。</div>';
}

// ---------- 置顶: long-press a conversation (right-click on a computer) ----------

let pinMenu = null;
function closePinMenu() {
  pinMenu?.remove();
  pinMenu = null;
}
document.addEventListener('contextmenu', (e) => {
  const row = e.target.closest('[data-open]');
  const s = row && state.sessions.get(row.dataset.open);
  if (!s) return;
  e.preventDefault();
  closePinMenu();
  pinMenu = document.createElement('div');
  pinMenu.className = 'pin-menu';
  pinMenu.innerHTML = `<button data-pin="${esc(s.id)}">${s.pinned ? '取消置顶' : '置顶'}</button>
    <button data-mute="${esc(s.id)}">${s.muted ? '取消消息免打扰' : '消息免打扰'}</button>`;
  document.body.append(pinMenu);
  const r = row.getBoundingClientRect();
  const x = Math.min(e.clientX || r.left + 24, innerWidth - pinMenu.offsetWidth - 8);
  const y = Math.min(e.clientY || r.top + r.height / 2, innerHeight - pinMenu.offsetHeight - 8);
  pinMenu.style.left = `${Math.max(8, x)}px`;
  pinMenu.style.top = `${Math.max(8, y)}px`;
});
// Any tap closes the menu; a tap on it also pins or mutes (or undoes it), on every phone through the hub.
document.addEventListener('click', (e) => {
  if (!pinMenu) return;
  const pin = e.target.closest('[data-pin]');
  const mute = e.target.closest('[data-mute]');
  const s = state.sessions.get(pin?.dataset.pin ?? mute?.dataset.mute ?? '');
  closePinMenu();
  e.preventDefault();
  e.stopPropagation();
  if (!s) return;
  if (pin) {
    s.pinned = !s.pinned;
    send({ t: 'pin', sessionId: s.id, pinned: s.pinned });
  } else {
    s.muted = !s.muted;
    send({ t: 'mute', sessionId: s.id, muted: s.muted });
    toast(s.muted ? '已设为消息免打扰：不再提醒「完成了一轮」，审批仍会提醒' : '已取消消息免打扰');
  }
  renderAll(false);
  saveCache();
}, true);

// ---------- 通讯录: friends, and agents waiting to be added ----------

function renderContacts() {
  const all = friends(true);
  const fresh = all.filter((f) => !f.added);
  const added = all.filter((f) => f.added);
  let html = '';
  if (fresh.length) {
    html += '<div class="section">新的朋友</div>' + fresh.map((f) => `<div class="contact">${avatar(f.deviceId, f.agentId)}
      <span class="t"><b>${esc(friendName(f.deviceId, f.agentId))}</b><span>${esc(deviceName(f.deviceId))} 上的 ${esc(agentLabel(f.deviceId, f.agentId))} · ${f.sessions.length} 个对话</span></span>
      <button class="btn" data-add="${esc(f.key)}">添加</button></div>`).join('');
  }
  html += `<div class="section">好友 · ${added.length}</div>`;
  html += added.map((f) => {
    const device = state.devices.get(f.deviceId);
    return `<button class="contact" data-profile="${esc(f.key)}">${avatar(f.deviceId, f.agentId)}<span class="t"><b>${esc(friendName(f.deviceId, f.agentId))}</b>
      <span>${device?.online ? '在线' : '离线'} · ${esc(agentLabel(f.deviceId, f.agentId))} · ${f.sessions.length} 个对话</span></span></button>`;
  }).join('') || '<div class="empty-note">还没有好友。电脑加入主电脑后，它上面的 Agent 会出现在「新的朋友」里。</div>';
  $('contacts').innerHTML = html;
}

function sendFriend(key, change) {
  const [deviceId, agentId] = key.split('|');
  send({ t: 'friend', deviceId, agentId, ...change });
}

$('contacts').addEventListener('click', (e) => {
  const add = e.target.closest('[data-add]');
  if (add) return sendFriend(add.dataset.add, { added: true });
  const p = e.target.closest('[data-profile]');
  if (p) showRight({ mode: 'profile', key: p.dataset.profile, from: 'side' });
});
$('more-menu').addEventListener('click', () => showRight({ mode: 'settings', from: 'side' }));

/** Shows something in the right pane (the whole screen on a folded phone). */
function showRight(r) {
  state.right = { ...state.right, item: null, ...r };
  delete $('right-body').dataset.sha;
  delete $('right-body').dataset.mode;
  if (trifold()) layout.show('right');
  setView(trifold() ? ($('app').dataset.view === 'right' ? 'chat' : $('app').dataset.view) : 'right');
  renderRight();
}

function open(sessionId) {
  const s = state.sessions.get(sessionId);
  if (!s) return;
  if (state.current !== sessionId || state.right.mode === 'profile' || state.right.mode === 'settings') {
    if (state.current !== sessionId) state.limit = 300;
    state.current = sessionId;
    state.right = { mode: 'files', filter: 'all', q: '', item: null, from: 'chat' };
  }
  state.friendLast[friendKey(s)] = sessionId;
  state.recent = [sessionId, ...state.recent.filter((id) => id !== sessionId)].slice(0, 20);
  markRead(s);
  $('sheet').hidden = true;
  setView('chat');
  send({ t: 'open', sessionId, after: state.itemSeq.get(sessionId) || 0 });
  renderAll(true);
  renderTray();
  saveCache();
}

// ---------- chat page ----------

function renderHeader() {
  const s = state.sessions.get(state.current);
  $('chat').classList.toggle('blank', !s);
  if (!s) return;
  const device = state.devices.get(s.deviceId);
  $('chat-friend').textContent = friendName(s.deviceId, s.agentId);
  $('chat-thread-name').textContent = s.title + (device && !device.online ? ' · 设备离线' : s.running ? ' · 运行中' : '');
  $('stop').hidden = !s.running;
  const files = sortedItems(s.id).filter((i) => i.kind === 'artifact').length;
  $('files-btn').textContent = files ? `文件 ${files}` : '文件';
  updateSend();
}

const TOOL_NAMES = { shell: '命令', edit: '修改文件', web: '搜索', image: '生成图片' };
const TOOL_STATE = { inProgress: '进行中', completed: '', failed: '失败', declined: '已拒绝' };
const REQ_STATE = { pending: '发送中', queued: '待送达', accepted: '已发送', unknown: '状态未知', failed: '发送失败', cancelled: '已取消' };
const REQ_ERRORS = [[/waiting_for_window/, '等电脑上的窗口空出来（锁屏、有没发出的草稿或正在使用），会自动发进去'], [/window_unavailable/, '电脑上的窗口两小时都没空出来，没有发送'],
  [/ambiguous_title/, '电脑上有两个同名对话，请先给其中一个改名'], [/desktop_restart/, '电脑上没有打开 Claude，已用后台方式发送'], [/active writer/i, '对话正被电脑占用'], [/busy_on_computer/, '电脑上正在运行，等这一轮结束再发'], [/claude_not_found/, '电脑上没有找到 Claude Code'], [/opencode_not_running/, '电脑上的 OpenCode 没有打开'], [/goose_not_found/, '电脑上没有找到 Goose，请先打开一次 Goose'], [/goose_background/, '电脑上没有打开 Goose，已用后台方式发送，打开 Goose 就能看到'],[/device_offline/, '设备离线'], [/no_active_turn/, '没有正在运行的任务'], [/approval_not_found/, '审批已失效']];
/** A failure in words: ours explained, the agent's own (a model refusing, say) as it gave it. */
const reqError = (error) => REQ_ERRORS.find(([re]) => re.test(error))?.[1] ?? String(error).slice(0, 200);
const GAP_MS = 5 * 60_000;

function renderMessages(jump) {
  const sid = state.current;
  const box = $('messages');
  const s = state.sessions.get(sid);
  if (!s) return void (box.innerHTML = '');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  const all = placeHandoffs(sortedItems(sid));
  const items = all.slice(-state.limit);
  const known = new Set(all.map((i) => i.itemId));
  const delivered = new Set(all.filter((i) => i.kind === 'message' && i.data.clientId).map((i) => i.data.clientId));
  const them = avatar(s.deviceId, s.agentId, true, 0, false, true);

  let html = all.length > items.length ? '<div class="time-sep"><button class="link" id="more">显示更早的消息</button></div>' : '';
  // Messages sent from here that are not in the conversation yet, placed at the time they were sent.
  const mine = [...state.requests.values()].filter((r) => r.sessionId === sid && r.op === 'send' && r.state !== 'delivered' && !delivered.has(r.requestId))
    .sort((a, b) => a.createdAt - b.createdAt);
  let next = mine.findIndex((r) => r.createdAt >= (items[0]?.ts ?? 0));
  if (next < 0) next = mine.length;
  let lastTs = 0;
  const sep = (ts) => {
    if (ts - lastTs >= GAP_MS) html += `<div class="time-sep">${stamp(ts)}</div>`;
    lastTs = ts;
  };
  const place = (before) => {
    while (next < mine.length && mine[next].createdAt <= before) {
      sep(mine[next].createdAt);
      html += requestHtml(mine[next++]);
    }
  };
  let tools = [];
  const flush = () => {
    if (!tools.length) return;
    const running = tools.some((t) => t.data.status === 'inProgress');
    const failed = tools.filter((t) => t.data.status === 'failed').length;
    html += `<details class="tools"><summary>${running ? '进行中' : '<span class="ok">✓</span> 已完成'} · 查看执行记录 ${tools.length} 项${failed ? ` · ${failed} 项失败` : ''}</summary>
      ${tools.map(toolHtml).join('')}</details>`;
    tools = [];
  };
  for (const item of items) {
    if (item.kind === 'tool_call') {
      tools.push(item);
      continue;
    }
    flush();
    place(item.ts);
    if (item.kind === 'message') {
      sep(item.ts);
      if (item.data.role === 'user') {
        const text = ownText(item.data.text);
        const from = agentOrigin(text);
        // Sent by another agent through AgentChat: shown as that agent's, not as the owner's.
        if (from) {
          const who = `${esc(from.who)} 派来${from.conv ? ` ·「${esc(from.conv)}」` : ''}`;
          html += `<div class="row from-agent"><div class="who">${from.from ? `<button class="link" data-open="${esc(from.from)}">${who} ›</button>` : who}</div><div class="bubble">${esc(from.body)}</div></div>`;
        }
        else if (text) html += `<div class="row mine"><div class="bubble">${esc(text)}</div></div>`;
      } else html += `<div class="row">${them}<div class="bubble">${md(item.data.text)}</div></div>`;
    } else if (item.kind === 'artifact') {
      html += item.data.sent ? `<div class="row mine">${fileCard(item)}</div>` : `<div class="row">${them}${fileCard(item)}</div>`;
    } else if (item.kind === 'approval_request') {
      html += `<div class="row">${them}${approvalHtml(item)}</div>`;
    } else if (item.kind === 'handoff') {
      html += `<div class="row">${them}${handoffHtml(item)}</div>`;
    } else if (item.kind === 'status' && ['failed', 'interrupted'].includes(item.data.status)) {
      html += `<div class="notice">${item.data.status === 'failed' ? '这一轮执行失败' : '这一轮已停止'}${item.data.error ? '：' + esc(item.data.error) : ''}</div>`;
    }
  }
  flush();
  place(Infinity);
  // Sent while the computer was locked: the desktop app shows these only after it restarts.
  if ([...state.requests.values()].some((r) => r.sessionId === sid && r.error === 'desktop_restart' && Date.now() - r.createdAt < 7 * 86_400_000)) {
    html += '<div class="notice soft">电脑锁屏时发的消息走了后台方式。回到电脑后，请先重启 Claude 桌面端，再继续这个对话，否则电脑上看不到这些内容。</div>';
  }
  // Sent in the background (someone was using the computer): Goose shows these only after it restarts.
  if ([...state.requests.values()].some((r) => r.sessionId === sid && r.error === 'goose_background' && Date.now() - r.createdAt < 7 * 86_400_000)) {
    html += '<div class="notice soft">从手机发的消息，电脑上的 Goose 窗口要关掉重新打开才显示出来。在电脑上直接接着聊也没问题，Goose 记得手机上聊过的内容。</div>';
  }
  for (const [itemId, d] of state.deltas) {
    if (d.sessionId === sid && !known.has(itemId)) html += `<div class="row">${them}<div class="bubble streaming">${md(d.text)}</div></div>`;
  }
  box.innerHTML = html;
  if (jump || nearBottom) box.scrollTop = box.scrollHeight;
}

/** "[来自 X「对话」，经 AgentChat 转发] …": a message one agent sent another (the hub adds the mark). */
function agentOrigin(text) {
  // 「[来自 X「对话」，经 AgentChat 转发]」 hands work over; 「[来自 X「对话」的汇报，…]」 brings its outcome back.
  // AllinOne: what AgentChat was called before; older messages carry that name.
  const m = /^\[来自 (.+?)(?:「(.+?)」)?(的汇报)?，经 (?:AgentChat|AllinOne) 转发\] ?([\s\S]*)$/.exec(text || '');
  if (!m) return null;
  // The sender's conversation, to jump back to: same title, same computer · agent.
  const from = m[2] ? [...state.sessions.values()].find((s) => s.title.startsWith(m[2]) && `${deviceName(s.deviceId)} · ${agentLabel(s.deviceId, s.agentId)}` === m[1]) : null;
  return { who: m[3] ? `${m[1]} 的汇报` : m[1], conv: m[2] || null, from: from?.id || null, body: m[4], report: Boolean(m[3]) };
}

const HANDOFF_STATE = { running: ['进行中', ''], queued: ['等对方上线', ''], waiting_approval: ['等你审批', 'warn'], done: ['已完成', 'ok'],
  failed: ['失败', 'bad'], interrupted: ['已停止', 'bad'] };

/**
 * Hand-off cards go right after the owner's message that led to them, ahead of the agent's account of the turn:
 * agents date their messages differently (some write a whole turn, report included, as one message dated first).
 */
function placeHandoffs(items) {
  const cards = items.filter((i) => i.kind === 'handoff');
  if (!cards.length) return items;
  const out = items.filter((i) => i.kind !== 'handoff');
  for (const card of cards) {
    let at = -1;
    out.forEach((i, n) => { if (i.kind === 'message' && i.data.role === 'user' && i.ts <= card.ts) at = n; });
    // After that message and any cards already placed behind it. That message not loaded (only the latest of a long
    // conversation is): by time, never at the end, where it would sit under every later message.
    let n = at + 1;
    if (at < 0) n = out.findIndex((i) => i.ts > card.ts);
    if (n < 0) n = out.length;
    while (n < out.length && out[n].kind === 'handoff') n++;
    out.splice(n, 0, card);
  }
  return out;
}

/** The card for work the agent in this conversation handed another agent. */
function handoffHtml(item) {
  const d = item.data;
  const [label, tone] = HANDOFF_STATE[d.state] || [d.state, ''];
  const took = d.endedAt ? ` · ${Math.max(1, Math.round((d.endedAt - d.startedAt) / 60000))} 分钟` : '';
  // Waiting for the owner: the receiving conversation's own approval cards, right here.
  const asks = d.state === 'waiting_approval' ? [...state.approvals.values()].filter((a) => a.sessionId === d.targetSessionId)
    .map((a) => `<div class="ask"><div>${approvalTitle(a.data)}</div>${a.data.command ? `<code>${esc(a.data.command)}</code>` : ''}${approveButtons(a)}</div>`).join('') : '';
  const reply = d.reply ? `<details class="reply"><summary>${esc(d.reply.replace(/\s+/g, ' ').slice(0, 90))}${d.reply.length > 90 ? '…' : ''}</summary><div>${md(d.reply)}</div></details>` : '';
  const go = !d.channel && state.sessions.has(d.targetSessionId) ? `<button class="link" data-open="${esc(d.targetSessionId)}">打开对方对话 ›</button>` : '';
  const why = d.error && ['failed', 'interrupted'].includes(d.state) ? `<div class="why">原因：${esc(reqError(d.error))}</div>` : '';
  return `<div class="handoff"><div class="top"><span>→ 派给 <b>${esc(d.to)}</b></span><span class="chip ${tone}">${label}${took}</span></div>
    <div class="what">${esc(d.text)}</div>${why}${asks}${reply}${go}</div>`;
}

function requestHtml(r) {
  const from = agentOrigin(r.text);
  if (from) {
    return `<div class="row from-agent"><div class="who">${esc(from.who)}</div><div class="bubble">${esc(from.body)}</div>
      <div class="state">${REQ_STATE[r.state] || r.state}</div></div>`;
  }
  const bad = r.state === 'failed' || r.state === 'unknown';
  const reason = r.error ? (REQ_ERRORS.find(([re]) => re.test(r.error))?.[1] ?? '出错了') : '';
  const extra = r.state === 'queued' ? ` · <button class="link" data-cancel="${esc(r.requestId)}">取消</button>` : '';
  const text = r.text === MARK ? '' : r.text;
  // Once the hub has them, the files show as the conversation's own items; until then, from the request.
  const files = (r.files || []).filter((f, i) => !state.items.get(r.sessionId)?.has(`sent:${r.requestId}:${i}`));
  return `<div class="row mine req">${files.length ? sentFilesHtml(files) : ''}${text ? `<div class="bubble">${esc(text)}</div>` : ''}
    <div class="state${bad ? ' bad' : ''}" title="${esc(r.error || '')}">${REQ_STATE[r.state] || r.state}${reason ? ' · ' + esc(reason) : ''}${extra}</div></div>`;
}

function toolHtml(t) {
  const name = TOOL_NAMES[t.data.tool] || t.data.tool;
  const st = TOOL_STATE[t.data.status] ?? '';
  const exit = t.data.exitCode !== null && t.data.exitCode !== undefined && t.data.exitCode !== 0 ? ` · 退出码 ${t.data.exitCode}` : '';
  return `<div class="tool"><div class="head"><span class="label">${esc(name)}</span><span class="sum">${esc(t.data.summary)}</span></div>
    ${st || exit ? `<div class="${t.data.status === 'failed' ? 'bad' : 'label'}">${esc(st)}${esc(exit)}</div>` : ''}
    ${t.data.output ? `<pre>${esc(t.data.output)}</pre>` : ''}</div>`;
}

function fileKind(mime, name) {
  if (mime.startsWith('image/')) return 'img';
  if (mime === 'application/pdf') return 'pdf';
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (['doc', 'docx', 'md', 'txt', 'rtf', 'ppt', 'pptx', 'xls', 'xlsx', 'csv'].includes(ext)) return 'doc';
  if (['js', 'ts', 'py', 'ps1', 'cmd', 'bat', 'json', 'java', 'cs', 'go', 'rs', 'html', 'css', 'sh', 'sql', 'toml', 'yaml', 'yml'].includes(ext)) return 'code';
  return 'other';
}

function ficon(item) {
  const { mime, name } = item.data;
  const kind = fileKind(mime, name);
  const label = kind === 'pdf' ? 'PDF' : (name.split('.').pop() || 'FILE').slice(0, 4).toUpperCase();
  return `<span class="ficon ${kind}">${esc(label)}</span>`;
}

function fileCard(item) {
  const { sha256, name, size: bytes, mime } = item.data;
  if (fileKind(mime, name) === 'img') return `<button class="card" style="padding:4px" data-file="${esc(item.sessionId)}|${esc(item.itemId)}"><img class="thumb" src="/files/${sha256}" alt="${esc(name)}" loading="lazy"></button>`;
  return `<button class="card" data-file="${esc(item.sessionId)}|${esc(item.itemId)}">${ficon(item)}<span><div class="fname">${esc(name)}</div><div class="fmeta">${size(bytes)}</div></span></button>`;
}

function approvalTitle(d) {
  return { question: '需要你回答', file: '请求修改文件', permission: '申请更多权限', link: '需要你打开链接', mcp: '请求使用插件工具' }[d.kind] || '请求执行命令';
}

// What a command will do, in plain words, for the owner deciding on it: the actions it takes (risky ones first) and
// the files it touches. Not a full reading of the command: the original stays one tap away.
const COMMAND_ACTS = [
  [/\b(Remove-Item|rm|del|rmdir|rd|erase)\b|::Delete\(/i, '删除文件', true],
  [/\b(npm|pnpm|yarn|pip3?|winget|choco|scoop)\s+(i|install|add)\b|Install-Package|Install-Module/i, '安装软件', true],
  [/\b(Invoke-WebRequest|Invoke-RestMethod|iwr|irm|curl|wget)\b|https?:\/\//i, '访问网络', true],
  [/\bgit\s+(push|reset|clean|checkout\s+--|rebase)\b/i, '改动代码仓库（git）', true],
  [/\b(Stop-Process|taskkill|kill)\b/i, '结束正在运行的程序', true],
  [/\b(reg\s+(add|delete)|Set-ItemProperty|New-ItemProperty)\b/i, '修改系统设置', true],
  [/\b(Set-Content|Add-Content|Out-File|New-Item|WriteAll(Text|Bytes|Lines))\b|FileMode\]::Create|>\s*['"]?[\w.:\\/]/i, '写入或新建文件', false],
  [/\b(Copy-Item|cp|copy|xcopy|robocopy)\b/i, '复制文件', false],
  [/\b(Move-Item|mv|move|Rename-Item|ren)\b/i, '移动或重命名文件', false],
  [/\b(Get-Content|cat|type|Select-String|findstr|ReadAll(Text|Bytes|Lines))\b/i, '读取文件', false],
  [/\b(Get-ChildItem|ls|dir|tree)\b/i, '查看文件夹', false],
  [/\bgit\s+(status|log|diff|show)\b/i, '查看代码仓库', false],
  [/\bgit\s+(add|commit)\b/i, '提交代码', false],
  [/\b(node|python3?|py|npm\s+run|npx|pytest|dotnet|go\s+run|cargo)\b/i, '运行程序或脚本', false],
  [/\bStart-Process\b/i, '启动程序', false],
];
function explainCommand(cmd) {
  const acts = COMMAND_ACTS.filter(([re]) => re.test(cmd));
  // File names in quotes or after a drive letter, shown by their last part.
  const files = [...new Set([...cmd.matchAll(/[A-Za-z]:\\[^'"\n|;]*?([^\\'"\n|;]+\.[A-Za-z0-9]{1,6})(?=['"\s;|)]|$)/g)].map((m) => m[1]))]
    .filter((f) => !/^(powershell|pwsh|cmd|bash|sh|node|python3?|git)\.exe$/i.test(f)).slice(0, 4); // the program running it is no file
  if (!acts.length) return null;
  const risky = acts.some(([, , r]) => r);
  // Risky ones first; the rest in the order the command does them.
  const at = (re) => cmd.search(re);
  const what = acts.sort((a, b) => Number(b[2]) - Number(a[2]) || at(a[0]) - at(b[0])).map(([, w]) => w).join('、');
  return { text: `它要${what}${files.length ? `：${files.map((f) => `「${f}」`).join('、')}` : ''}`, risky };
}

function approvalHtml(item) {
  const d = item.data;
  // Commands are explained in plain words first; the command itself folds away behind 「查看原始命令」.
  const plain = (d.kind === 'command' || d.kind === 'file') && d.command ? explainCommand(String(d.command)) : null;
  const raw = (c) => plain || d.kind === 'command' ? `<details class="raw"><summary>查看原始命令</summary><code>${esc(c)}</code></details>` : `<code>${esc(c)}</code>`;
  const lead = plain ? `<div class="plain${plain.risky ? ' risky' : ''}">${esc(plain.text)}${plain.risky ? '（这类操作请看清再允许）' : ''}</div>` : '';
  const why = d.reason && d.kind !== 'mcp' && d.kind !== 'permission' ? `<div class="why">理由：${esc(d.reason)}</div>` : '';
  // A question card shows its questions with the choices; others show what is asked for.
  const body = d.kind === 'question' && d.state === 'pending' ? (d.reason && d.reason !== d.questions?.[0]?.description ? `<div>${esc(d.reason)}</div>` : '')
    : d.kind === 'link' && d.command ? `<div>${esc(d.reason || '')}</div><a class="where" href="${esc(d.command)}" target="_blank" rel="noopener">${esc(d.command)}</a>`
    : d.command ? `${(d.kind === 'permission' || d.kind === 'mcp') && d.reason ? `<div>${esc(d.reason)}</div>` : ''}${lead}${why}${raw(d.command)}` : d.reason ? `<div>${esc(d.reason)}</div>` : '';
  const done = { accepted: '已允许', declined: '已拒绝', expired: '无人回应，已自动拒绝', cancelled: '已取消', elsewhere: '已交给电脑处理',
    gone: '已失效：电脑上的程序重启过，这一轮已经停了，需要的话让它重新做一次',
    answered: '已回答' + (d.answer ? '：' + d.answer : '') }[d.state];
  return `<div class="approval"><div class="q">${approvalTitle(d)}</div>${body}${d.cwd && d.kind !== 'question' ? `<div class="where">${esc(d.cwd)}</div>` : ''}
    ${d.state === 'pending' ? approveButtons(item) : `<div class="done">${esc(done || '')}</div>`}</div>`;
}

function approveButtons(item) {
  const a = `data-session="${esc(item.sessionId)}" data-approve="${esc(item.data.approvalId)}"`;
  if (item.data.kind === 'question') {
    const qs = item.data.questions || [];
    const single = qs.length === 1;
    const typed = qs.some((q) => q.custom);
    // One question: a choice answers it. Otherwise choose or type an answer for each, then submit.
    return `<div class="questions">${qs.map((q) => `<div class="question"><b>${esc(q.title)}</b>${q.description ? `<div>${esc(q.description)}</div>` : ''}
      ${q.options?.length ? `<div class="options">${q.options.map((o) => `<button class="option" ${a} data-qkey="${esc(q.key)}" data-qvalue="${esc(o.value)}"${single ? ' data-single="1"' : ''}>${esc(o.label)}${o.description ? `<small>${esc(o.description)}</small>` : ''}</button>`).join('')}</div>` : ''}
      ${q.custom ? `<input class="qinput" data-qtext="${esc(q.key)}" type="${q.secret ? 'password' : 'text'}" placeholder="${q.options?.length ? '或者自己写' : '在这里填写'}" autocomplete="off">` : ''}</div>`).join('')}
      <div class="actions"><button class="pill no" ${a} data-decision="decline">不回答</button>${!single || typed ? `<button class="pill ok" ${a} data-qsubmit="1">提交</button>` : ''}</div></div>`;
  }
  const [no, ok] = item.data.kind === 'link' ? ['取消', '已完成'] : ['拒绝', '允许'];
  return `<div class="actions"><button class="pill no" ${a} data-decision="decline">${no}</button><button class="pill ok" ${a} data-decision="accept">${ok}</button></div>`;
}

function answerQuestion(el, answers) {
  command(el.dataset.session, { requestId: newId(), op: 'approve', approvalId: el.dataset.approve, decision: 'accept', answers });
  el.closest('.questions').outerHTML = '<div class="done">已提交</div>';
}

function itemByKey(key) {
  const cut = key.indexOf('|');
  const sid = key.slice(0, cut);
  const itemId = key.slice(cut + 1);
  return state.items.get(sid)?.get(itemId) || state.artifacts.get(key) || state.approvals.get(key);
}

// Clicks inside messages, the workbench and the file pages share these handlers.
document.addEventListener('click', (e) => {
  const t = e.target;
  if (t.id === 'more') {
    state.limit += 300;
    return renderMessages(false);
  }
  const file = t.closest('[data-file]');
  if (file) return openFile(itemByKey(file.dataset.file), $('side').contains(file) ? 'side' : 'chat');
  const option = t.closest('[data-qkey]');
  if (option) {
    if (option.dataset.single) return answerQuestion(option, { [option.dataset.qkey]: option.dataset.qvalue });
    for (const b of option.closest('.questions').querySelectorAll('[data-qkey]')) if (b.dataset.qkey === option.dataset.qkey) b.classList.toggle('on', b === option);
    return;
  }
  if (t.dataset.qsubmit) {
    const card = t.closest('.questions');
    const answers = Object.fromEntries([...card.querySelectorAll('.option.on')].map((b) => [b.dataset.qkey, b.dataset.qvalue]));
    // What is typed wins over a choice for the same question.
    for (const input of card.querySelectorAll('[data-qtext]')) if (input.value.trim()) answers[input.dataset.qtext] = input.value.trim();
    const keys = new Set([...card.querySelectorAll('[data-qkey], [data-qtext]')].map((b) => b.dataset.qkey || b.dataset.qtext));
    if (Object.keys(answers).length < keys.size) return toast('每个问题都回答了再提交');
    return answerQuestion(t, answers);
  }
  if (t.dataset.approve) {
    command(t.dataset.session, { requestId: newId(), op: 'approve', approvalId: t.dataset.approve, decision: t.dataset.decision });
    (t.closest('.questions') || t.closest('.actions')).outerHTML = '<div class="done">已提交</div>';
    return;
  }
  if (t.dataset.cancel) return command(state.current, { requestId: t.dataset.cancel, op: 'cancel' });
  const go = t.closest('[data-open]');
  if (go) open(go.dataset.open);
});

// ---------- switch-conversation sheet ----------

function renderSheet() {
  const s = state.sessions.get(state.current);
  if (!s) return;
  const key = friendKey(s);
  const all = [...state.sessions.values()].filter((x) => friendKey(x) === key && !isChannel(x)).sort((a, b) => b.updatedAt - a.updatedAt);
  const q = $('sheet-q').value.trim().toLowerCase();
  $('sheet-q').hidden = all.length <= 12;
  const match = (x) => (q || isRecent(x)) && (!q || x.title.toLowerCase().includes(q) || (x.preview || '').toLowerCase().includes(q) || base(x.cwd).toLowerCase().includes(q));
  const row = (x) => `<button class="thread-row" data-open="${esc(x.id)}">${x.running ? '<span class="dot run"></span>' : ''}<span class="t"><b>${esc(x.title)}</b>
    <span>${x.running ? '运行中' : when(x.updatedAt)}${x.preview ? ' · ' + esc(x.preview) : ''}</span></span>${x.id === s.id ? '<span class="check">✓</span>' : ''}</button>`;
  let html = '';
  const recent = state.recent.map((id) => state.sessions.get(id)).filter((x) => x && friendKey(x) === key && match(x)).slice(0, 5);
  if (recent.length && !q) html += '<div class="section">最近</div>' + recent.map(row).join('');
  for (const g of projectGroups(key, all.filter(match))) {
    if (g.sessions.length) html += `<div class="section">${esc(g.name)}</div>` + g.sessions.map(row).join('');
  }
  $('sheet-list').innerHTML = html || '<div class="empty-note">没有匹配的对话</div>';
}

function openSheet() {
  $('sheet-q').value = '';
  $('sheet').hidden = false;
  renderSheet();
}
$('switch').addEventListener('click', openSheet);
$('chat-thread').addEventListener('click', openSheet);
$('sheet').addEventListener('click', (e) => {
  if (e.target.id === 'sheet') $('sheet').hidden = true;
});
$('sheet-q').addEventListener('input', renderSheet);

// ---------- composer ----------

const input = $('input');
const MAX_UPLOAD = 25 * 1024 * 1024;
const MAX_FILES = 9;
const MARK = '[附件]';

// Files picked for the next message, per conversation. Each uploads to the hub at once,
// so sending is instant; the message carries only their hashes.
state.attach = new Map();
const picked = () => state.attach.get(state.current) || [];

function updateSend() {
  const files = picked();
  const ready = files.every((a) => a.meta);
  $('send').disabled = !state.current || (!input.value.trim() && !files.length) || !ready;
}

function addFiles(list) {
  if (!state.current) return;
  const files = picked();
  for (const file of list) {
    if (files.length >= MAX_FILES) {
      toast(`一次最多发送 ${MAX_FILES} 个文件`);
      break;
    }
    if (file.size > MAX_UPLOAD) {
      toast(`「${file.name}」超过 25 MB`);
      continue;
    }
    if (!file.size) continue;
    const a = { id: newId(), file, name: file.name || (file.type.startsWith('image/') ? `图片-${Date.now()}.${(file.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}` : 'file'),
      mime: file.type || 'application/octet-stream', size: file.size, progress: 0, meta: null, failed: false,
      preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : null };
    files.push(a);
    upload(a);
  }
  state.attach.set(state.current, files);
  renderTray();
}

function upload(a) {
  a.failed = false;
  a.progress = 0;
  const xhr = new XMLHttpRequest(); // fetch has no upload progress
  xhr.open('POST', `/api/upload?name=${encodeURIComponent(a.name)}`);
  xhr.setRequestHeader('Content-Type', a.mime);
  xhr.upload.onprogress = (e) => {
    if (!e.lengthComputable) return;
    a.progress = e.loaded / e.total;
    const bar = document.querySelector(`[data-att="${a.id}"] .bar-p i`);
    if (bar) bar.style.width = `${Math.round(a.progress * 100)}%`;
  };
  xhr.onload = () => {
    try {
      const body = JSON.parse(xhr.responseText);
      if (xhr.status !== 200) throw new Error(body.error || `HTTP ${xhr.status}`);
      a.meta = body;
    } catch (e) {
      a.failed = true;
      toast(`「${a.name}」上传失败：${e.message}`);
    }
    renderTray();
  };
  xhr.onerror = () => {
    a.failed = true;
    toast(`「${a.name}」上传失败，点它重试`);
    renderTray();
  };
  xhr.send(a.file);
}

function renderTray() {
  const files = picked();
  const tray = $('attach-tray');
  tray.hidden = !files.length;
  tray.innerHTML = files.map((a) => {
    const kind = fileKind(a.mime, a.name);
    const label = kind === 'pdf' ? 'PDF' : (a.name.split('.').pop() || 'FILE').slice(0, 4).toUpperCase();
    const veil = a.failed ? '<span class="veil">重试</span>' : !a.meta ? `<span class="veil"><span class="bar-p"><i style="width:${Math.round(a.progress * 100)}%"></i></span></span>` : '';
    return `<div class="att${a.failed ? ' failed' : ''}" data-att="${a.id}" title="${esc(a.name)} · ${size(a.size)}">
      ${a.preview ? `<img src="${a.preview}" alt="">` : `<span class="ficon ${kind}">${esc(label)}</span><span class="an">${esc(a.name)}</span>`}
      ${veil}<button class="x" data-unpick="${a.id}" aria-label="移除">×</button></div>`;
  }).join('');
  updateSend();
}

$('attach').addEventListener('click', () => $('attach-input').click());
$('attach-input').addEventListener('change', (e) => {
  addFiles([...e.target.files]);
  e.target.value = '';
});
$('attach-tray').addEventListener('click', (e) => {
  const x = e.target.closest('[data-unpick]');
  const files = picked();
  if (x) {
    const a = files.find((f) => f.id === x.dataset.unpick);
    if (a?.preview) URL.revokeObjectURL(a.preview);
    state.attach.set(state.current, files.filter((f) => f !== a));
    return renderTray();
  }
  const a = files.find((f) => f.id === e.target.closest('[data-att]')?.dataset.att);
  if (a?.failed) {
    upload(a);
    renderTray();
  }
});
// Pasting a screenshot, or dropping files on the conversation, attaches them too.
input.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (!files.length) return;
  e.preventDefault();
  addFiles(files);
});
$('chat').addEventListener('dragover', (e) => {
  if (!state.current || ![...e.dataTransfer.types].includes('Files')) return;
  e.preventDefault();
  $('chat').classList.add('dropping');
});
$('chat').addEventListener('dragleave', (e) => {
  if (!$('chat').contains(e.relatedTarget)) $('chat').classList.remove('dropping');
});
$('chat').addEventListener('drop', (e) => {
  $('chat').classList.remove('dropping');
  if (!e.dataTransfer.files.length) return;
  e.preventDefault();
  addFiles([...e.dataTransfer.files]);
});
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 156) + 'px';
  updateSend();
});
input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && wide()) {
    event.preventDefault();
    sendMessage();
  }
});
$('send').addEventListener('click', sendMessage);

function sendMessage() {
  const text = input.value.trim();
  const attached = picked();
  if ((!text && !attached.length) || !state.current || attached.some((a) => !a.meta)) return;
  const files = attached.map((a) => a.meta);
  const requestId = newId();
  // Shown at once; the hub's record replaces this as the request moves along.
  state.requests.set(requestId, { requestId, sessionId: state.current, op: 'send', text: text || MARK, files, state: 'pending', createdAt: Date.now() });
  command(state.current, { requestId, op: 'send', text, ...(files.length ? { files } : {}) });
  for (const a of attached) if (a.preview) URL.revokeObjectURL(a.preview);
  state.attach.delete(state.current);
  input.value = '';
  input.style.height = 'auto';
  renderTray();
  renderMessages(true);
}

/** A message as typed: the attachment lines the agent was given are shown as the files themselves. */
function ownText(text) {
  const s = String(text ?? '');
  if (!s.includes(MARK) && !s.includes('[图片]')) return s;
  // The pictures themselves show beside the message (sent from the phone, or pasted on the computer).
  return s.split('\n').filter((l) => !l.startsWith(MARK) && l.trim() !== '[图片]').join('\n').trim();
}

function sentFilesHtml(files) {
  return `<div class="sent-files">${files.map((f) => fileKind(f.mime, f.name) === 'img'
    ? `<span class="card" style="padding:4px"><img class="thumb" src="/files/${esc(f.sha256)}" alt="${esc(f.name)}" loading="lazy"></span>`
    : `<span class="card"><span class="ficon ${fileKind(f.mime, f.name)}">${esc((f.name.split('.').pop() || 'FILE').slice(0, 4).toUpperCase())}</span><span><div class="fname">${esc(f.name)}</div><div class="fmeta">${size(f.size)}</div></span></span>`).join('')}</div>`;
}

$('stop').addEventListener('click', () => {
  if (state.current) command(state.current, { requestId: newId(), op: 'interrupt' });
  toast('已请求停止');
});
$('back').addEventListener('click', () => setView('side'));

// ---------- workbench ----------

/**
 * Today's work agents passed to each other, one card per task: the owner's conversation it grew from, then each
 * hand-off in order (work passed on again sits under the step that passed it), with where it stands.
 */
function collaborationsHtml(today) {
  const all = [...state.requests.values()].filter((r) => r.op === 'send' && new Date(r.createdAt).toDateString() === today)
    .map((r) => ({ r, o: agentOrigin(r.text), to: state.sessions.get(r.sessionId) })).filter((x) => x.o && x.to && x.o.from);
  const steps = all.filter((x) => !x.o.report).sort((a, b) => a.r.createdAt - b.r.createdAt);
  if (!steps.length) return '';
  const reports = all.filter((x) => x.o.report);
  // A step passes on work its sender was handed shortly before (the latest such, within half an hour); with none, it
  // starts a task of its own, in the conversation the owner works in.
  const parentOf = new Map(steps.map((x) => [x, steps.filter((y) => y.to.id === x.o.from && y.r.createdAt < x.r.createdAt
    && x.r.createdAt - y.r.createdAt < 30 * 60_000).at(-1) ?? null]));
  const status = (x) => {
    if (x.r.state === 'failed') return ['失败', 'bad'];
    if (reports.some((y) => y.to.id === x.o.from && y.o.from === x.to.id && y.r.createdAt >= x.r.createdAt)) return ['已汇报', 'ok'];
    if (x.to.running) return ['进行中', ''];
    return ['已送达', ''];
  };
  const row = (x, depth) => {
    const [label, cls] = status(x);
    return `<button class="step" style="margin-left:${depth * 14}px" data-open="${esc(x.to.id)}">${avatar(x.to.deviceId, x.to.agentId, true)}
      <span class="t"><b>→ ${esc(x.to.title)}</b><span>${esc(friendName(x.to.deviceId, x.to.agentId))} · ${esc(x.o.body.split('\n')[0].slice(0, 60))}</span></span>
      <span class="tag ${cls}">${label}</span></button>`;
  };
  // Each step, then the work passed on from it (a step has one parent at most, earlier than itself: no loops).
  const tree = (x, depth) => row(x, depth) + steps.filter((y) => parentOf.get(y) === x).map((y) => tree(y, depth + 1)).join('');
  const tasks = new Map(); // the owner's conversation -> the steps that start its tasks
  for (const x of steps) if (!parentOf.get(x) && state.sessions.has(x.o.from)) tasks.set(x.o.from, [...(tasks.get(x.o.from) ?? []), x]);
  const cards = [...tasks].map(([id, firsts]) => {
    const s = state.sessions.get(id);
    const last = Math.max(...firsts.map((x) => x.r.createdAt));
    return { last, html: `<div class="wcard task"><button class="task-head" data-open="${esc(id)}">${avatar(s.deviceId, s.agentId, true)}
      <span class="t"><b>${esc(s.title)}</b><span>${esc(friendName(s.deviceId, s.agentId))} · 最近派活 ${when(Math.floor(last / 1000))}</span></span></button>
      ${firsts.map((x) => tree(x, 0)).join('')}</div>` };
  }).sort((a, b) => b.last - a.last);
  return cards.length ? '<div class="section">协作任务</div>' + cards.slice(0, 10).map((c) => c.html).join('') : '';
}

function renderWork() {
  const sessions = visibleSessions();
  const approvals = [...state.approvals.values()].filter((a) => state.sessions.has(a.sessionId) && isFriend(state.sessions.get(a.sessionId))).sort((a, b) => b.ts - a.ts);
  const running = sessions.filter((s) => s.running).sort((a, b) => b.updatedAt - a.updatedAt);
  const today = new Date().toDateString();
  const done = sessions.filter((s) => !s.running && new Date(s.updatedAt * 1000).toDateString() === today).sort((a, b) => b.updatedAt - a.updatedAt);
  const sessionRow = (s, side) => `<button class="item" data-open="${esc(s.id)}">${avatar(s.deviceId, s.agentId, true)}<span class="t"><b>${esc(s.title)}</b>
    <span>${esc(friendName(s.deviceId, s.agentId))} · ${esc(projectLabel(s))}${s.preview ? ' · ' + esc(s.preview) : ''}</span></span><span class="side">${side}</span></button>`;
  let html = `<div class="stats"><div class="stat${approvals.length ? ' warn' : ''}"><span>待我处理</span><b>${approvals.length}</b></div>
    <div class="stat"><span>进行中</span><b>${running.length}</b></div><div class="stat"><span>今天完成</span><b>${done.length}</b></div></div>`;
  if (approvals.length) {
    html += '<div class="section">待我处理</div>';
    for (const a of approvals) {
      const s = state.sessions.get(a.sessionId);
      const plain = a.data.command && (a.data.kind === 'command' || a.data.kind === 'file') ? explainCommand(String(a.data.command)) : null;
      const what = a.data.kind === 'question' ? '' : a.data.command
        ? `${plain ? `<div class="plain${plain.risky ? ' risky' : ''}">${esc(plain.text)}</div>` : ''}<details class="raw"${plain ? '' : ' open'}><summary>查看原始命令</summary><code>${esc(a.data.command)}</code></details>`
        : a.data.reason ? `<div>${esc(a.data.reason)}</div>` : '';
      html += `<div class="wcard"><b>${approvalTitle(a.data)}</b>${what}
        <button class="link" data-open="${esc(a.sessionId)}">${esc(s ? `${friendName(s.deviceId, s.agentId)} · ${s.title}` : '打开对话')}</button>${approveButtons(a)}</div>`;
    }
  }
  html += collaborationsHtml(today);
  html += '<div class="section">进行中</div>' + (running.map((s) => sessionRow(s, '<span class="dot run"></span>')).join('') || '<div class="empty-note">没有正在运行的任务</div>');
  html += '<div class="section">最近完成</div>' + (done.slice(0, 20).map((s) => sessionRow(s, when(s.updatedAt))).join('') || '<div class="empty-note">今天还没有完成的任务</div>');
  $('work').innerHTML = html;
}

// ---------- results (all output files) ----------

const FILTERS = [['all', '全部'], ['img', '图片'], ['doc', '文档'], ['pdf', 'PDF'], ['code', '代码'], ['other', '其他']];

/**
 * One library view, used by the 资料库 page (all conversations) and by each conversation's own library.
 * `withSource` adds which conversation a file came from (not needed inside a single conversation).
 */
function libraryHtml(files, filter, query, withSource) {
  const q = query.toLowerCase();
  const counts = Object.fromEntries(FILTERS.map(([k]) => [k, 0]));
  for (const a of files) {
    counts.all++;
    counts[fileKind(a.data.mime, a.data.name)]++;
  }
  const chips = FILTERS.filter(([k]) => k === 'all' || counts[k]).map(([k, label]) =>
    `<button data-filter="${k}" class="${filter === k ? 'on' : ''}">${label}${counts[k] ? ` ${counts[k]}` : ''}</button>`).join('');
  const list = files.filter((a) => {
    if (filter !== 'all' && fileKind(a.data.mime, a.data.name) !== filter) return false;
    return !q || a.data.name.toLowerCase().includes(q) || (withSource && (state.sessions.get(a.sessionId)?.title || '').toLowerCase().includes(q));
  }).sort((a, b) => b.ts - a.ts);
  const where = (a) => {
    const s = state.sessions.get(a.sessionId);
    return withSource && s ? `${friendName(s.deviceId, s.agentId)} · ${when(a.ts / 1000)}` : stamp(a.ts);
  };
  const images = list.filter((a) => fileKind(a.data.mime, a.data.name) === 'img');
  const others = list.filter((a) => fileKind(a.data.mime, a.data.name) !== 'img');
  let html = '';
  if (images.length) html += `<div class="section">图片</div><div class="grid">${images.map((a) => `<button class="tile" data-file="${esc(a.sessionId)}|${esc(a.itemId)}">
    <img src="/files/${a.data.sha256}" alt="" loading="lazy"><div class="meta"><b>${esc(a.data.name)}</b><span>${esc(where(a))}</span></div></button>`).join('')}</div>`;
  if (others.length) html += '<div class="section">文件</div>' + others.map((a) => `<button class="item" data-file="${esc(a.sessionId)}|${esc(a.itemId)}">${ficon(a)}
    <span class="t"><b>${esc(a.data.name)}</b><span>${withSource ? esc(state.sessions.get(a.sessionId)?.title ?? '') + ' · ' : ''}${size(a.data.size)}</span></span><span class="side">${esc(where(a))}</span></button>`).join('');
  return { chips, html, empty: !files.length, none: !list.length };
}

function renderFilesTab() {
  const files = [...state.artifacts.values()].filter((a) => state.sessions.has(a.sessionId) && isFriend(state.sessions.get(a.sessionId)));
  const lib = libraryHtml(files, state.filesFilter, state.filesQuery, true);
  $('files-filter').innerHTML = lib.chips;
  $('files-all').innerHTML = lib.empty ? '<div class="empty-note">这里会汇总各个对话里 Agent 生成的文件。打开过的对话里的文件会出现在这里。</div>'
    : lib.none ? '<div class="empty-note">没有符合条件的文件</div>' : lib.html;
}

$('files-filter').addEventListener('click', (e) => {
  const b = e.target.closest('[data-filter]');
  if (!b) return;
  state.filesFilter = b.dataset.filter;
  renderFilesTab();
});
$('files-q').addEventListener('input', (e) => {
  state.filesQuery = e.target.value.trim();
  renderFilesTab();
});

// ---------- friend profile and settings (shown in the right pane) ----------

function renderProfile(key) {
  const f = friends(true).find((x) => x.key === key);
  if (!f) return '<div class="empty-note">这位好友已不存在</div>';
  const device = state.devices.get(f.deviceId);
  const groups = projectGroups(key, f.sessions).filter((g) => g.id);
  return `<div class="profile"><div class="head"><button class="face" id="avatar-pick" title="换头像">${avatar(f.deviceId, f.agentId)}<span class="edit">换头像</span></button>
      <div><b>${esc(friendName(f.deviceId, f.agentId))}</b>
      <span>${esc(deviceName(f.deviceId))} 上的 ${esc(agentLabel(f.deviceId, f.agentId))}</span>
      ${f.avatar ? '<button class="link" id="avatar-reset">恢复默认头像</button>' : ''}</div></div>
    <input type="file" id="avatar-file" accept="image/*" hidden>
    <div class="field"><span class="k">昵称</span><input id="remark" maxlength="40" placeholder="${esc(deviceName(f.deviceId))}" value="${esc(f.remark || '')}"><button class="btn plain" id="remark-save">保存</button></div>
    <div class="field"><span class="k">状态</span><span>${device?.online ? '在线' : `离线${device?.lastSeen ? ' · 最后在线 ' + when(device.lastSeen / 1000) : ''}`}${device?.isHub ? ' · 主电脑' : ''}</span></div>
    <div class="field"><span class="k">项目</span><span>${groups.length} 个${groups.length ? '：' + esc(groups.slice(0, 4).map((g) => g.name).join('、')) + (groups.length > 4 ? ' 等' : '') : ''}</span></div>
    <div class="field"><span class="k">对话</span><span>${f.sessions.length} 个${f.running ? ' · 有任务正在运行' : ''}</span></div>
    <label class="setting"><span class="t">消息免打扰<div class="fmeta">它的对话做完时不再提醒，未读只显示灰点；审批仍会提醒，因为它在等你回答</div></span>
      <input type="checkbox" class="switch" data-mute-friend="${esc(key)}" ${f.muted ? 'checked' : ''}></label>
    <label class="setting"><span class="t">接收其他 Agent 的消息<div class="fmeta">关掉后，其他 Agent 不能经 AgentChat 给它派活</div></span>
      <input type="checkbox" class="switch" data-accept="${esc(key)}" ${state.friends.get(key)?.acceptAgents !== false ? 'checked' : ''}></label>
    <div class="buttons">${f.added ? `<button class="btn" data-message="${esc(key)}">发消息</button><button class="btn danger" data-remove="${esc(key)}">删除好友</button>`
      : `<button class="btn" data-add="${esc(key)}">添加到通讯录</button>`}</div></div>`;
}

/**
 * A new picture for a friend: cut to a square, shrunk to 256 px, uploaded to the hub like any file, then named as its
 * avatar. The hub keeps it, so every phone shows it and it outlives updates and reinstalls.
 */
async function setAvatar(key, file) {
  if (!file || !file.type.startsWith('image/')) return;
  try {
    const img = await createImageBitmap(file);
    const side = Math.min(img.width, img.height);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 256;
    canvas.getContext('2d').drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, 256, 256);
    const blob = await new Promise((done) => canvas.toBlob(done, 'image/jpeg', 0.88));
    const res = await fetch('/api/upload?name=avatar.jpg', { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
    const body = await res.json();
    if (!res.ok || !body.sha256) throw new Error(body.error || `HTTP ${res.status}`);
    sendFriend(key, { avatar: body.sha256 });
    toast('头像已更换');
  } catch (e) {
    toast(`换头像没有成功：${e.message}`);
  }
}

function renderSettings() {
  const devices = [...state.devices.values()].filter((d) => d.approved).sort((a, b) => Number(b.isHub) - Number(a.isHub) || Number(b.online) - Number(a.online));
  let html = '<div class="section">电脑</div>' + (devices.map((d) => {
    const running = [...state.sessions.values()].filter((s) => s.deviceId === d.id && s.running && !isChannel(s)).length;
    const sub = d.online ? [d.agents.map((a) => a.label).join('、') || '没有 Agent', running ? `${running} 个运行中` : ''].filter(Boolean).join(' · ')
      : `离线${d.lastSeen ? ' · 最后在线 ' + when(d.lastSeen / 1000) : ''}`;
    return `<div class="item"><span class="dot ${d.online ? 'on' : ''}"></span><span class="t"><b>${esc(d.name)}</b><span>${esc(sub)}</span></span>${d.isHub ? '<span class="tag hub">主电脑</span>' : ''}</div>`;
  }).join('') || '<div class="empty-note">还没有电脑</div>');
  if (state.hubSettings?.newVersion) {
    html += `<div class="section">更新</div><div class="setting"><span class="t">有新版本 ${esc(state.hubSettings.newVersion)}<div class="fmeta">主电脑会先更新，其他电脑自动跟上</div></span>
      <button class="btn" id="install-update">更新</button></div>`;
  }
  html += `<div class="section">Agent 互通</div>
    <label class="setting"><span class="t">允许 Agent 之间互相派活<div class="fmeta">关掉后，所有 Agent 经 AgentChat 发给其他 Agent 的消息都会被拦下</div></span>
      <input type="checkbox" class="switch" data-hub-set="agentLinks" ${state.hubSettings?.agentLinks !== false ? 'checked' : ''}></label>
    <label class="setting"><span class="t">做完自动汇报<div class="fmeta">派出去的活做完后，对方的汇报自动发回派活的那个对话，它会接着往下做</div></span>
      <input type="checkbox" class="switch" data-hub-set="autoReport" ${state.hubSettings?.autoReport !== false ? 'checked' : ''}></label>`;
  if (native) {
    let s = {};
    try {
      s = JSON.parse(native.getSettings());
    } catch {
      // older app without settings
    }
    html += `<div class="section">这部手机</div>
      <label class="setting"><span class="t">在电脑前时，不提醒手机<div class="fmeta">你正在用哪台电脑，提醒就弹在那台电脑的右下角；离开几分钟后再发到手机</div></span>
        <input type="checkbox" class="switch" data-hub-set="followMe" ${state.hubSettings?.followMe !== false ? 'checked' : ''}></label>
      <label class="setting"><span class="t">完成与审批提醒</span><input type="checkbox" class="switch" data-set="notify" ${s.notify !== false ? 'checked' : ''}></label>
      <label class="setting"><span class="t">免打扰时段<div class="fmeta">期间提醒静音，仍会出现在通知栏</div></span><input type="checkbox" class="switch" data-set="quiet" ${s.quiet ? 'checked' : ''}></label>
      <div class="setting" ${s.quiet ? '' : 'hidden'}><span class="t">时段</span><input type="time" data-set="quietFrom" value="${esc(s.quietFrom || '23:00')}"> — <input type="time" data-set="quietTo" value="${esc(s.quietTo || '08:00')}"></div>
      <button class="setting" id="rescan" style="width:100%;text-align:left"><span class="t">重新扫码配对</span><span class="link">›</span></button>
      <div class="setting"><span class="t">版本</span><span class="fmeta">${esc(s.version || '')}</span></div>`;
  } else {
    html += `<div class="section">这部手机</div><div class="empty-note">在浏览器里使用时没有后台提醒。${/Android/i.test(navigator.userAgent) ? '<br><a class="link" href="/app.apk">安装 App</a>' : ''}</div>`;
  }
  return html;
}

$('right-body').addEventListener('change', (e) => {
  // Settings the hub keeps (for every phone), and a friend's own switch.
  if (e.target.dataset.hubSet) return send({ t: 'settings', settings: { [e.target.dataset.hubSet]: e.target.checked } });
  if (e.target.dataset.accept) return sendFriend(e.target.dataset.accept, { acceptAgents: e.target.checked });
  if (e.target.dataset.muteFriend) return sendFriend(e.target.dataset.muteFriend, { muted: e.target.checked });
  if (e.target.id === 'avatar-file') return void setAvatar(state.right.key, e.target.files?.[0]);
  if (!native || !e.target.dataset.set) return;
  const s = JSON.parse(native.getSettings());
  s[e.target.dataset.set] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
  native.setSettings(JSON.stringify(s));
  delete $('right-body').dataset.mode;
  renderRight();
});
$('right-body').addEventListener('click', (e) => {
  const t = e.target;
  if (t.closest('#rescan') && native) return native.scan();
  if (t.id === 'install-update') {
    send({ t: 'installUpdate' });
    t.disabled = true;
    t.textContent = '更新中…';
    return toast('正在更新，几分钟后自动重新连接');
  }
  if (t.closest('#avatar-pick')) return $('avatar-file').click();
  if (t.id === 'avatar-reset') return sendFriend(state.right.key, { avatar: null });
  if (t.id === 'remark-save') {
    sendFriend(state.right.key, { remark: $('remark').value.trim() || null });
    toast('备注已保存');
    return;
  }
  if (t.dataset.add) return sendFriend(t.dataset.add, { added: true });
  if (t.dataset.remove && confirm('删除这位好友？它的对话会从项目和聊天里隐藏，可以随时在「新的朋友」里重新添加。')) {
    sendFriend(t.dataset.remove, { added: false });
    return $('right-back').click();
  }
  if (t.dataset.message) {
    const f = friends().find((x) => x.key === t.dataset.message);
    const target = state.sessions.get(state.friendLast[f?.key]) || f?.latest;
    if (target) open(target.id);
    else toast('这位好友还没有对话');
  }
});

// ---------- right pane: files of the conversation, or a preview ----------

/** Views without the library's search and kinds. sub='1': a page inside the library, so ‹ shows even in the trifold. */
function clearTabs(sub) {
  const tabs = $('right-tabs');
  tabs.innerHTML = '';
  tabs.hidden = true;
  delete tabs.dataset.session;
  $('right').dataset.sub = sub;
}

function renderRight() {
  const r = state.right;
  const s = state.sessions.get(state.current);
  if (r.mode !== 'browser') native?.browserHide?.(); // other content takes the pane: the browser steps aside
  if (r.mode === 'profile' || r.mode === 'settings') {
    const body = $('right-body');
    $('right-title').textContent = r.mode === 'profile' ? '详细资料' : '设置';
    clearTabs('');
    $('right-open').hidden = true;
    // Do not redraw under the user's fingers while they type a remark.
    if (body.dataset.mode === r.mode + r.key && body.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
    body.dataset.mode = r.mode + r.key;
    body.innerHTML = r.mode === 'profile' ? renderProfile(r.key) : renderSettings();
    return;
  }
  if (r.mode === 'browser') return renderBrowser(s);
  delete $('right-body').dataset.mode;
  if (r.mode === 'preview' && r.item) {
    const a = r.item;
    $('right-title').textContent = a.data.name;
    clearTabs(r.from === 'chat' && state.current ? '1' : '');
    $('right-open').hidden = r.from !== 'side' || a.sessionId === state.current;
    $('right-open').dataset.open = a.sessionId;
    const body = $('right-body');
    if (body.dataset.sha === a.data.sha256) return;
    body.dataset.sha = a.data.sha256;
    const url = `/files/${a.data.sha256}`;
    const kind = fileKind(a.data.mime, a.data.name);
    if (kind === 'img') body.innerHTML = `<div class="pview"><img src="${url}" alt="${esc(a.data.name)}"></div>`;
    else if (kind === 'pdf' || a.data.mime.startsWith('text/') || a.data.mime === 'application/json') body.innerHTML = `<div class="pview"><iframe src="${url}" title="${esc(a.data.name)}"></iframe></div>`;
    else body.innerHTML = `<div class="pview"><div class="hint">无法直接预览<br><a class="link" href="${url}" download="${esc(a.data.name)}">下载 ${esc(a.data.name)}（${size(a.data.size)}）</a></div></div>`;
    return;
  }
  delete $('right-body').dataset.sha;
  $('right-open').hidden = true;
  $('right').dataset.sub = '';
  if (!s || (state.tab === 'library' && trifold())) {
    $('right-title').textContent = state.tab === 'library' ? '预览' : '资料库';
    clearTabs('');
    $('right-body').innerHTML = state.tab === 'library'
      ? calm('files', '选择一个文件', '在左边点任意文件，这里直接预览')
      : calm('files', '选择一个对话', '对话里 Agent 生成的图片和文件会汇总在这里');
    return;
  }
  // A conversation: its own library, with the same kinds as the 资料库 page.
  const files = sortedItems(s.id).filter((i) => i.kind === 'artifact');
  const lib = libraryHtml(files, r.filter || 'all', r.q || '', false);
  $('right-title').textContent = files.length ? `资料库 · ${files.length}` : '资料库';
  // Keep the search box (and the keyboard) while the list below refreshes.
  if ($('right-tabs').dataset.session !== s.id || !$('right-q')) {
    $('right-tabs').dataset.session = s.id;
    $('right-tabs').innerHTML = `<div class="search" style="padding-top:8px"><input id="right-q" type="search" placeholder="搜索这个对话的文件"></div><div id="right-chips" class="chips"></div>`;
    $('right-q').value = r.q || '';
  }
  $('right-chips').innerHTML = lib.chips;
  $('right-tabs').hidden = lib.empty;
  $('right-body').innerHTML = lib.empty ? calm('files', '还没有文件', 'Agent 在这个对话里生成的图片和文件会汇总在这里')
    : lib.none ? '<div class="empty-note">没有符合条件的文件</div>' : lib.html;
  syncBrowser();
}

// ---------- the right pane's browser ----------
// In the app a real browser view floats over #browser-slot (any site opens and keeps its sign-in);
// in a plain browser the slot holds an iframe, which some sites refuse.

state.browser = { url: '', title: '', canBack: false, canForward: false, loading: false };

/** Links that appeared in the conversation, newest first: the browser's start page. */
function conversationLinks(s) {
  const seen = new Set();
  const out = [];
  for (const i of sortedItems(s?.id).reverse()) {
    if (i.kind !== 'message') continue;
    for (const m of String(i.data.text || '').matchAll(/https?:\/\/[^\s<>()"'`，。）]+/g)) {
      const url = m[0].replace(/[.,;:!?]+$/, '');
      if (seen.has(url) || url.startsWith(location.origin)) continue;
      seen.add(url);
      out.push(url);
      if (out.length >= 20) return out;
    }
  }
  return out;
}

function renderBrowser(s) {
  const body = $('right-body');
  const b = state.browser;
  $('right-title').textContent = '浏览器';
  $('right-open').hidden = true;
  delete body.dataset.sha;
  clearTabs(state.current ? '1' : ''); // opened from the conversation: ‹ returns to its library
  if (body.dataset.mode !== 'browser') {
    body.dataset.mode = 'browser';
    body.innerHTML = `<div class="browser">
      <div class="browser-bar">
        <button class="bnav" data-bnav="back" aria-label="后退">‹</button>
        <button class="bnav" data-bnav="forward" aria-label="前进">›</button>
        <form id="browser-form" novalidate><input id="browser-url" type="url" inputmode="url" enterkeyhint="go" placeholder="输入网址" autocomplete="off"></form>
        <button class="bnav" data-bnav="reload" aria-label="刷新">↻</button>
      </div>
      <div id="browser-slot" class="browser-slot"></div>
    </div>`;
  }
  const slot = $('browser-slot');
  if (!b.url) {
    const links = conversationLinks(s);
    slot.innerHTML = `<div class="browser-start">${links.length ? '<div class="section">这个对话里的链接</div>' + links.map((u) => `<button class="item" data-go="${esc(u)}"><span class="t"><b>${esc(u.replace(/^https?:\/\//, '').split('/')[0])}</b><span>${esc(u)}</span></span></button>`).join('')
      : calm('chat', '打开一个网页', '在上面输入网址，或点对话里的链接。登录过的网站会记住登录状态。')}</div>`;
  } else if (!native && !slot.querySelector('iframe')) {
    slot.innerHTML = `<iframe src="${esc(b.url)}" referrerpolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-forms allow-popups"></iframe>
      <a class="browser-out link" href="${esc(b.url)}" target="_blank" rel="noopener">在新窗口打开 ›</a>`;
  }
  const input = $('browser-url');
  if (document.activeElement !== input) input.value = b.url;
  for (const btn of body.querySelectorAll('[data-bnav]')) {
    const a = btn.dataset.bnav;
    btn.disabled = native ? (a === 'back' && !b.canBack) || (a === 'forward' && !b.canForward) || (a === 'reload' && !b.url) : a !== 'reload' || !b.url;
  }
  body.querySelector('[data-bnav="reload"]').textContent = b.loading ? '×' : '↻';
  syncBrowser();
}

function openInBrowser(url) {
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  state.browser = { ...state.browser, url };
  state.right = { ...state.right, mode: 'browser', item: null };
  if (native) native.browserOpen(url);
  else delete $('right-body').dataset.mode; // rebuild so the iframe loads the new address
  if (trifold()) layout.show('right');
  else setView('right');
  renderRight();
}

/** Keeps the native browser exactly over its slot, or hidden when the slot is not on screen. */
function syncBrowser() {
  if (!native?.browserPlace) return;
  const slot = $('browser-slot');
  const view = $('app').dataset.view;
  const paneShown = trifold() ? !$('app').classList.contains('right-hidden') : view === 'right';
  const visible = state.right.mode === 'browser' && state.browser.url && slot && paneShown && slot.offsetParent !== null && $('sheet').hidden;
  if (!visible) return native.browserHide();
  const r = slot.getBoundingClientRect();
  if (r.width < 40 || r.height < 40) return native.browserHide();
  native.browserPlace(r.left, r.top, r.width, r.height);
}

/** While columns glide to new widths, keep the browser glued to its slot. */
function followBrowser(ms = 480) {
  if (!native?.browserPlace) return;
  const end = performance.now() + ms;
  const step = () => {
    syncBrowser();
    if (performance.now() < end) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

window.onBrowserState = (s) => {
  state.browser = { ...state.browser, ...s };
  if (state.right.mode === 'browser') renderBrowser(state.sessions.get(state.current));
};

$('right-body').addEventListener('submit', (e) => {
  if (e.target.id !== 'browser-form') return;
  e.preventDefault();
  const v = $('browser-url').value.trim();
  if (v) openInBrowser(/\s/.test(v) || !/\./.test(v) ? `https://www.bing.com/search?q=${encodeURIComponent(v)}` : v);
  $('browser-url').blur();
});
$('right-body').addEventListener('click', (e) => {
  const go = e.target.closest('[data-go]');
  if (go) return openInBrowser(go.dataset.go);
  const nav = e.target.closest('[data-bnav]');
  if (!nav) return;
  if (native) native.browserNav(nav.dataset.bnav === 'reload' && state.browser.loading ? 'stop' : nav.dataset.bnav);
  else if (nav.dataset.bnav === 'reload') {
    delete $('right-body').dataset.mode;
    renderRight();
  }
});

// Links inside conversations open in the right pane, as on the computer.
// The agent's picture beside its replies, and its name at the top, open its page.
$('chat-friend').addEventListener('click', () => {
  const s = state.sessions.get(state.current);
  if (s) showRight({ mode: 'profile', key: friendKey(s), from: 'chat' });
});
$('messages').addEventListener('click', (e) => {
  const face = e.target.closest('[data-profile]');
  if (face) return showRight({ mode: 'profile', key: face.dataset.profile, from: 'chat' });
  const a = e.target.closest('a[href^="http"]');
  if (!a) return;
  e.preventDefault();
  openInBrowser(a.href);
});
addEventListener('resize', () => syncBrowser());
new ResizeObserver(() => syncBrowser()).observe($('right'));

const GLYPHS = {
  chat: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='1.5' stroke-linejoin='round'%3E%3Cpath d='M4 5h16v11H9l-5 4z'/%3E%3C/svg%3E\")",
  files: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='1.5' stroke-linejoin='round'%3E%3Cpath d='M6 3h8l4 4v14H6z'/%3E%3Cpath d='M14 3v4h4'/%3E%3C/svg%3E\")",
};
const calm = (glyph, title, sub) => `<div class="calm"><span class="glyph" style="--i:${GLYPHS[glyph]}"></span><b>${esc(title)}</b><span>${esc(sub)}</span></div>`;

/** PDFs and files the WebView cannot show are handed to the phone's own viewer. */
function openNatively(item) {
  if (!native) return false;
  const kind = fileKind(item.data.mime, item.data.name);
  if (kind === 'img' || item.data.mime.startsWith('text/')) return false;
  native.openFile(`${location.origin}/files/${item.data.sha256}`, item.data.name, item.data.mime);
  return true;
}

function openFile(item, from) {
  if (!item) return;
  if (openNatively(item)) return;
  state.right = { ...state.right, mode: 'preview', item, from };
  if (trifold()) layout.show('right');
  setView(trifold() ? $('app').dataset.view : 'right');
  renderRight();
}

// The conversation library's kind chips and search box.
$('right').addEventListener('click', (e) => {
  const chip = e.target.closest('#right-chips [data-filter]');
  if (!chip) return;
  state.right.filter = chip.dataset.filter;
  renderRight();
});
$('right').addEventListener('input', (e) => {
  if (e.target.id !== 'right-q') return;
  state.right.q = e.target.value.trim();
  renderRight();
});
$('files-btn').addEventListener('click', () => {
  state.right = { ...state.right, mode: 'files', item: null, from: 'chat' };
  if (trifold()) layout.show('right');
  else setView('right');
  renderRight();
});
$('right-open').addEventListener('click', () => open($('right-open').dataset.open));
$('right-back').addEventListener('click', () => {
  const r = state.right;
  if ((r.mode === 'preview' || r.mode === 'browser') && r.from === 'chat' && state.current) {
    state.right = { ...r, mode: 'files', item: null };
    delete $('right-body').dataset.sha;
    renderRight();
    return;
  }
  setView(r.from === 'side' || !state.current ? 'side' : 'chat');
});

$('nav').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab]');
  if (!b) return;
  // As in WeChat: tapping 聊天 twice brings the next conversation with unread messages to the top.
  const again = b.dataset.tab === 'chat' && state.tab === 'chat' && e.timeStamp - (state.chatTapAt ?? -1e9) < 450;
  state.chatTapAt = b.dataset.tab === 'chat' ? e.timeStamp : null;
  if (again) return nextUnread();
  setTab(b.dataset.tab);
});

/** Scrolls the chat list so the next unread conversation below the top is first; wraps around. */
function nextUnread() {
  const list = $('chats');
  const rows = [...list.querySelectorAll('.friend')].filter((r) => {
    const s = state.sessions.get(r.dataset.open);
    return s && isUnread(s);
  });
  if (!rows.length) return toast('没有未读消息');
  const offset = (r) => r.getBoundingClientRect().top - list.getBoundingClientRect().top; // from the list's visible top
  const next = rows.find((r) => offset(r) > 4) ?? rows[0];
  list.scrollTo({ top: list.scrollTop + offset(next), behavior: 'smooth' });
  // Kept through redraws (the list redraws whenever a message arrives) until the flash is over.
  state.landed = next.dataset.open;
  clearTimeout(nextUnread.t);
  nextUnread.t = setTimeout(() => (state.landed = null), 1000);
  next.classList.remove('landed');
  void next.offsetWidth; // restart the flash
  next.classList.add('landed');
}

// ---------- inside the Android app (window.AllinOneNative is injected by the app) ----------

// In a phone browser (not the app), offer the app.
if (!native && /Android/i.test(navigator.userAgent)) $('install').hidden = false;
// Voice input is the phone keyboard's own microphone key; the app adds no button of its own.
if (native) {
  window.onNativeBack = () => {
    if (!$('sheet').hidden) return ($('sheet').hidden = true), true;
    const view = $('app').dataset.view;
    if (view === 'right') return $('right-back').click(), true;
    if (view === 'chat' && !wide()) return setView('side'), true;
    if (state.tab !== 'chat') return setTab('chat'), true;
    return false;
  };
}

// A notification opens the app at #s=<sessionId>.
function openFromHash() {
  const id = decodeURIComponent((location.hash.match(/^#s=(.+)$/) || [])[1] || '');
  if (id && state.sessions.has(id)) {
    history.replaceState(null, '', location.pathname);
    open(id);
  }
}
window.addEventListener('hashchange', openFromHash);

// ---------- resizable columns (unfolded phone / trifold) ----------
// Drag a divider: the column follows the finger, then settles with an iOS-like ease onto a resting width.
// Pull a side column past its edge and it tucks away; the chat header then offers a button to bring it back.
// Double-tap a divider to restore the default widths. Widths are remembered.

const layout = (() => {
  const KEY = 'allinone.layout.v1';
  const DEFAULT = { side: 340, right: 380, sideHidden: false, rightHidden: false };
  const SIDE = { min: 260, max: 460, stops: [300, 340, 400], hideBelow: 190 };
  const RIGHT = { min: 300, max: 640, stops: [340, 380, 460], hideBelow: 220 };
  const CHAT_MIN = 380;
  const SNAP = 22; // px within a resting width that pulls onto it
  const LONG_PRESS = 280; // ms a finger rests on a divider before it can move it
  let v = { ...DEFAULT };
  try {
    v = { ...DEFAULT, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    // keep defaults
  }
  const app = $('app');
  const save = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(v));
    } catch {
      // not essential
    }
  };
  const room = () => app.clientWidth;
  /** Widths that leave the conversation at least CHAT_MIN wide. */
  function fit() {
    const three = trifold();
    const side = v.sideHidden ? 0 : v.side;
    const right = three && !v.rightHidden ? v.right : 0;
    let over = side + right + CHAT_MIN - room();
    if (over > 0 && right) {
      const give = Math.min(over, v.right - RIGHT.min);
      v.right -= give;
      over -= give;
    }
    if (over > 0 && side) v.side = Math.max(SIDE.min, v.side - over);
  }
  function apply() {
    fit();
    app.style.setProperty('--side-w', `${v.sideHidden ? 0 : v.side}px`);
    app.style.setProperty('--right-w', `${v.rightHidden ? 0 : v.right}px`);
    app.classList.toggle('side-hidden', v.sideHidden);
    app.classList.toggle('right-hidden', v.rightHidden);
    $('show-side').hidden = !v.sideHidden;
    followBrowser();
  }
  const buzz = () => navigator.vibrate?.(8);
  function settle(which, width) {
    const spec = which === 'side' ? SIDE : RIGHT;
    const hideKey = which === 'side' ? 'sideHidden' : 'rightHidden';
    if (width < spec.hideBelow) {
      v[hideKey] = true;
      buzz();
    } else {
      v[hideKey] = false;
      let w = Math.min(spec.max, Math.max(spec.min, width));
      const near = spec.stops.find((s) => Math.abs(s - w) <= SNAP);
      if (near !== undefined) {
        w = near;
        buzz();
      }
      v[which] = w;
    }
    apply();
    save();
  }
  function drag(divider, which) {
    divider.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      try {
        divider.setPointerCapture(e.pointerId); // keep receiving moves even when the finger leaves the thin line
      } catch {
        // pointer already gone; the drag simply ends on the next event
      }
      const startX = e.clientX;
      const hidden = which === 'side' ? v.sideHidden : v.rightHidden;
      const start = hidden ? 0 : v[which];
      let width = start;
      let moved = false;
      // A finger must rest on the line a moment before it grabs it, so a passing swipe never resizes;
      // the line answers at once (arming) and again, with a tick, when it takes hold (active).
      let held = e.pointerType !== 'touch';
      let timer = 0;
      const grab = () => {
        held = true;
        divider.classList.remove('arming');
        divider.classList.add('active');
        app.classList.add('resizing');
        navigator.vibrate?.(12);
      };
      if (held) grab();
      else {
        divider.classList.add('arming');
        timer = setTimeout(grab, LONG_PRESS);
      }
      const move = (ev) => {
        const dx = ev.clientX - startX;
        if (!held) {
          if (Math.abs(dx) > 8 || Math.abs(ev.clientY - e.clientY) > 8) up(); // moved too soon: not a press
          return;
        }
        if (Math.abs(dx) > 3) moved = true;
        width = which === 'side' ? start + dx : start - dx;
        const spec = which === 'side' ? SIDE : RIGHT;
        // Past the edges the column resists (rubber band) instead of stopping dead.
        const shown = width > spec.max ? spec.max + (width - spec.max) * 0.25 : Math.max(0, width);
        app.style.setProperty(which === 'side' ? '--side-w' : '--right-w', `${Math.round(shown)}px`);
        app.classList.toggle(which === 'side' ? 'side-hidden' : 'right-hidden', false);
        syncBrowser();
      };
      const up = () => {
        divider.removeEventListener('pointermove', move);
        divider.removeEventListener('pointerup', up);
        divider.removeEventListener('pointercancel', up);
        clearTimeout(timer);
        app.classList.remove('resizing');
        divider.classList.remove('active', 'arming');
        if (!held || !moved) return apply();
        settle(which, width);
        divider.classList.add('snap');
        setTimeout(() => divider.classList.remove('snap'), 300);
      };
      divider.addEventListener('pointermove', move);
      divider.addEventListener('pointerup', up);
      divider.addEventListener('pointercancel', up);
    });
    divider.addEventListener('dblclick', () => {
      v = { ...DEFAULT };
      apply();
      save();
    });
    divider.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 48 : 16;
      const sign = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
      if (!sign) return;
      e.preventDefault();
      const delta = which === 'side' ? sign * step : -sign * step;
      settle(which, ((which === 'side' ? v.sideHidden : v.rightHidden) ? 0 : v[which]) + delta);
    });
  }
  drag($('div-left'), 'side');
  drag($('div-right'), 'right');
  $('show-side').addEventListener('click', () => show('side'));
  addEventListener('resize', apply);
  function show(which) {
    v[which === 'side' ? 'sideHidden' : 'rightHidden'] = false;
    apply();
    save();
  }
  apply();
  return { show, apply };
})();

// ---------- start ----------

loadCache();
$('app').dataset.tab = state.tab;
renderAll(true);
openFromHash();
connect();
