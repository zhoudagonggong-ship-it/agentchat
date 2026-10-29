// The hub: serves the phone UI, keeps the shared record, and routes commands to devices.
// Listens on 127.0.0.1 only; `tailscale serve` publishes it to the tailnet with HTTPS.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { promisify } from 'node:util';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AgentInfo, AppToHub, Attachment, Command, DeviceToHub, DeviceView, HubRef, HubSettings, HubToApp, HubToDevice, Item, MemberSeed, Origin, RequestState, RequestView, SessionView } from '../shared/protocol.ts';
import { HUB_LOCAL_PORT, HUB_PORT, MAX_ATTACHMENTS, MAX_UPLOAD_BYTES, PROTOCOL_VERSION, requestText, sessionKey } from '../shared/protocol.ts';
import { log, parseJson, sha256 } from '../shared/util.ts';
import { activity } from '../activity.ts';
import { LocalTransport } from '../link.ts';
import { Store } from './store.ts';
import { buildPackage } from '../update.ts';

const WEB_DIR = join(import.meta.dirname, '..', '..', 'web');
const APK = join(import.meta.dirname, '..', '..', 'build', 'android', 'AllinOne.apk');
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const TICK_MS = 30_000;
const MAX_TEXT = 20_000;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,80}$/;
// Agents handing work to each other: at most this many hand-offs in a row (A→B→C→D), counting what was handed
// on in the last CHAIN_WINDOW_MS, and this many messages an hour from one agent.
const MAX_CHAIN = 3;
const CHAIN_WINDOW_MS = 30 * 60_000;
const MAX_SENDS_PER_HOUR = 30;
/** Title start of the conversations agents keep only for passing work to each other (the phone hides them). */
const CHANNEL_TITLE = 'AgentChat 协作';
/** One of those, including the ones opened while AgentChat was still called AllinOne. */
const isChannelTitle = (title: string): boolean => title.startsWith(CHANNEL_TITLE) || title.startsWith('AllinOne 协作');
/** How long a sender may still be waiting on its own before its report goes back into its conversation. */
const REPORT_DELAY_MS = 8000;
/** Added to the first message another agent sends a conversation: what it is, and that the answer goes back by itself. */
const FIRST_CONTACT_NOTE = '\n\n（AgentChat 说明：这条是主人电脑上的另一个 Agent 经 AgentChat 转给你的。照常在这个对话里做事、回复就行，'
  + '做完后 AgentChat 会自动把你的回复带回给它，不用另外发。你也可以用 allinone 工具联系各台电脑上的其他 Agent；'
  + '如果你还没有这个工具，主人重新打开这个对话后就会有。请用中文回答。）';
/** Used a computer this recently (keyboard or mouse): the owner is taken to sit there. */
const PRESENT_MS = 3 * 60_000;
const REPORT_MAX = 6000;
const HANDOVER_WAIT_MS = 10 * 60_000; // how long the old hub waits for the new one to take its data
const run = promisify(execFile);

/** Changes whenever the page files change, so open phones know to reload. */
/** Why a computer could not make the conversation, as the asking agent reads it. */
function createError(code: string | undefined): string {
  const known: Record<string, string> = {
    goose_window_in_use: 'Goose 那台电脑正有人在用键盘鼠标（AgentChat 只在 30 秒没人操作时才去 Goose 窗口里新建），请过几分钟再试',
    goose_no_window: 'Goose 没有打开：请主人在那台电脑上打开 Goose 后再试',
    goose_locked: 'Goose 那台电脑锁屏了，窗口里没法新建对话',
    goose_draft: 'Goose 窗口的输入框里有没发出去的文字，为了不弄丢，先不新建',
  };
  return (code && known[code]) || code || '新建对话失败';
}

function webVersion(): string {
  return sha256(['index.html', 'app.js', 'style.css'].map((f) => {
    try {
      return `${f}:${statSync(join(WEB_DIR, f)).mtimeMs}`;
    } catch {
      return f;
    }
  }).join('|')).slice(0, 12);
}

/** `owner`: came in through Tailscale signed in as the hub's own owner (another computer on the same account). */
interface DeviceConn { send(msg: HubToDevice): void; close(): void; deviceId?: string; local: boolean; owner?: boolean; name?: string; code?: string }
interface Notice { seq: number; at: number; type: 'done' | 'approval' | 'agent'; sessionId: string; title: string; text: string }

export class Hub {
  readonly store: Store;
  private readonly hubId: string;
  private readonly ownerLogin: string;
  private readonly devices = new Map<string, DeviceConn>(); // approved + connected
  private readonly pending = new Map<string, DeviceConn>(); // waiting for the owner to allow
  private readonly apps = new Set<WebSocket>();
  private readonly hubName: string;
  private readonly hubDns: string;
  /** Called whenever something the local control window shows has changed. */
  onChange: () => void = () => {};
  /** One-time codes shown as a QR code in the control window; scanning one pairs the phone app. */
  private readonly pairCodes = new Map<string, number>();
  /** Short notices for the phone app's background service (long-polled at /api/notify). */
  private readonly notices: Notice[] = [];
  // Starts from the clock so it is never 0 ("first call") and keeps growing across hub restarts.
  private noticeSeq = Date.now();
  /** New conversations asked of devices, waiting for `created`. */
  private readonly creates = new Map<number, (r: { threadId?: string; sent?: boolean; error?: string }) => void>();
  private createSeq = 0;
  /** Where the owner was last active, by computer: from each tray's report of keyboard and mouse use. */
  private readonly presence = new Map<string, { activeAt: number; locked: boolean }>();
  private readonly earlyReceipts = new Map<string, { state: RequestState; turnId: string | null; error: string | null; at: number }>();
  private readonly floodNoticed = new Map<string, number>();
  private newVersion: string | null = null;
  /** The owner asked (on the phone) to install the new release; the program around the hub does it. */
  onInstallUpdate: () => void = () => {};
  /** Hand-off cards still being kept current: request → where the card is and where the work runs. */
  private readonly handoffs = new Map<string, { sessionId: string; targetSessionId: string; item: Item }>();
  private readonly noticeWaiters = new Set<() => void>();

  private readonly dataDir: string;

  constructor(dataDir: string, hubId: string, hubName: string, hubDns: string, ownerLogin: string, seeds: MemberSeed[] = []) {
    this.dataDir = dataDir;
    this.store = new Store(dataDir);
    this.hubId = hubId;
    this.hubName = hubName;
    this.hubDns = hubDns;
    this.ownerLogin = ownerLogin;
    if (seeds.length) this.store.seedMembers(seeds);
  }

  // ---------- for the local control window ----------

  pendingJoins(): { id: string; name: string }[] {
    return [...this.pending.keys()].map((id) => ({ id, name: this.store.device(id)?.name ?? id }));
  }

  members(): DeviceView[] {
    return this.store.devices(new Set(this.devices.keys()), this.hubId);
  }

  allow(id: string): boolean {
    const device = this.store.device(id);
    if (!device) return false;
    this.store.approveDevice(id);
    const conn = this.pending.get(id);
    if (conn) {
      this.pending.delete(id);
      this.activate(conn, id);
    }
    activity(`已允许「${device.name}」加入`);
    this.onChange();
    return true;
  }

  /** Refuses a join request; the device may ask again later. */
  deny(id: string): void {
    const conn = this.pending.get(id);
    this.pending.delete(id);
    this.store.removeDevice(id);
    conn?.send({ t: 'rejected', reason: '主电脑拒绝了加入请求' });
    conn?.close();
    this.onChange();
  }

  /**
   * The pairing QR code: a web page on this hub, so the phone's own camera can open it whether or not the app is
   * installed yet (the page opens the app, or helps install it first). Valid for 30 minutes, time enough to install
   * the app; usable once.
   */
  createPairLink(): string {
    for (const [code, expires] of this.pairCodes) if (expires < Date.now()) this.pairCodes.delete(code);
    const code = randomBytes(12).toString('base64url');
    this.pairCodes.set(code, Date.now() + 30 * 60_000);
    return `https://${this.hubDns}:${HUB_PORT}/pair?code=${code}`;
  }

  /** Computers the phone can ask "who is the hub now?" when this one is gone. */
  private memberHosts(): string[] {
    const suffix = this.hubDns.slice(this.hubDns.indexOf('.'));
    return this.members().filter((d) => d.approved).map((d) => d.name + suffix);
  }

  /**
   * The computer the owner sits at: a key press or mouse move there within the last few minutes, not locked (the
   * latest of them, when several). null when the owner is away from all of them.
   */
  private ownerAt(): string | null {
    let best: string | null = null;
    let bestAt = Date.now() - PRESENT_MS;
    for (const [id, p] of this.presence) {
      if (!p.locked && p.activeAt > bestAt && this.devices.has(id)) {
        best = id;
        bestAt = p.activeAt;
      }
    }
    return best;
  }

  private notice(n: Omit<Notice, 'seq' | 'at'>): void {
    // Reminders follow the owner: at one of the computers, they show there and the phone stays quiet.
    const at = this.settings().followMe ? this.ownerAt() : null;
    if (at) {
      const url = `https://${this.hubDns}:${HUB_PORT}/${n.sessionId ? `#s=${encodeURIComponent(n.sessionId)}` : ''}`;
      this.devices.get(at)?.send({ t: 'alert', title: n.title, text: n.text, url });
      return;
    }
    this.notices.push({ ...n, seq: ++this.noticeSeq, at: Date.now() });
    if (this.notices.length > 200) this.notices.shift();
    for (const wake of this.noticeWaiters) wake();
    this.noticeWaiters.clear();
  }

  /** Long poll: answers at once when there is something after `after`, otherwise within ~45 s. */
  private serveNotices(after: number, res: ServerResponse): void {
    const reply = () => {
      const events = after > 0 ? this.notices.filter((n) => n.seq > after) : [];
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ seq: this.noticeSeq, events, members: this.memberHosts() }));
    };
    // Nothing new yet: wait. Any other position (first call, missed events, hub restarted) answers at once.
    if (after <= 0 || after !== this.noticeSeq) return reply();
    const timer = setTimeout(() => {
      this.noticeWaiters.delete(wake);
      reply();
    }, 45_000);
    const wake = () => {
      clearTimeout(timer);
      reply();
    };
    this.noticeWaiters.add(wake);
    res.on('close', () => {
      clearTimeout(timer);
      this.noticeWaiters.delete(wake);
    });
  }

  /**
   * Hands the hub role to another member. The new hub first takes a copy of everything kept here
   * (conversations, friends and remarks, files, unread state) from /api/handover; then the others follow it.
   */
  async moveTo(hub: HubRef): Promise<void> {
    const seeds = this.store.memberSeeds();
    const next = this.devices.get(hub.stableId);
    if (next && !next.local) {
      try {
        const zip = await this.prepareHandover();
        const token = randomBytes(18).toString('base64url');
        activity(`正在把主电脑的数据交给「${hub.name}」（${(statSync(zip).size / 1024 / 1024).toFixed(1)} MB）`);
        const fetched = new Promise<boolean>((resolve) => {
          this.handover = { token, zip, done: resolve };
          setTimeout(() => resolve(false), HANDOVER_WAIT_MS);
        });
        next.send({ t: 'hubMoved', hub, members: seeds, handover: `https://${this.hubDns}:${HUB_PORT}/api/handover?token=${token}` });
        activity((await fetched) ? `「${hub.name}」已取走主电脑的数据` : `「${hub.name}」没有取走数据，只带上了成员名单`, (await fetched) ? 'info' : 'warn');
      } catch (error) {
        log('hub', `handover copy failed: ${(error as Error).message}`);
        next.send({ t: 'hubMoved', hub, members: seeds });
      }
    }
    for (const [id, conn] of this.devices) if (id !== hub.stableId) conn.send({ t: 'hubMoved', hub });
    this.broadcast({ t: 'hubMoved', url: `https://${hub.dnsName}:${HUB_PORT}/` });
    activity(`主电脑移交给「${hub.name}」`);
  }

  private handover: { token: string; zip: string; done: (ok: boolean) => void } | null = null;

  /** A consistent copy of the database plus the files, zipped. */
  private async prepareHandover(): Promise<string> {
    const dir = join(this.dataDir, 'handover-out');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    this.store.db.exec(`VACUUM INTO '${join(dir, 'hub.sqlite').replace(/'/g, "''")}'`);
    const zip = join(this.dataDir, 'handover-out.zip');
    rmSync(zip, { force: true });
    const q = (p: string) => `'${p.replace(/'/g, "''")}'`;
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$ErrorActionPreference='Stop'; Copy-Item ${q(this.store.artifactDir)} ${q(join(dir, 'artifacts'))} -Recurse; Compress-Archive -Path ${q(join(dir, '*'))} -DestinationPath ${q(zip)}`],
      { windowsHide: true, timeout: 300_000 });
    rmSync(dir, { recursive: true, force: true });
    return zip;
  }

  private serveHandover(token: string, res: ServerResponse): void {
    const h = this.handover;
    if (!h || token !== h.token || !existsSync(h.zip)) return void res.writeHead(404).end();
    const size = statSync(h.zip).size;
    log('handover', `new hub started the download (${(size / 1048576).toFixed(1)} MB)`);
    res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': size });
    const stream = createReadStream(h.zip);
    res.on('finish', () => {
      log('handover', 'all data sent');
      h.done(true);
    });
    // A dropped download may be retried with the same token; only a finished one ends the wait.
    res.on('close', () => { if (!res.writableFinished) log('handover', `download broke off after ${(stream.bytesRead / 1048576).toFixed(1)} MB`); });
    stream.pipe(res);
  }

  start(): void {
    // Hand-offs still going when the hub last stopped: keep following them, so their reports still go back.
    for (const { sessionId, item } of this.store.openHandoffs()) {
      const task = String(item.data.task ?? '');
      if (!task || typeof item.data.targetSessionId !== 'string') continue;
      // Already over before we were back: its card is brought up to date, but no report goes after it so late
      // (the sender carried on without it meanwhile). Only an end seen as it happens is reported back.
      const now = this.handoffState(task);
      if (now && ['done', 'failed', 'interrupted'].includes(now.state)) {
        this.store.markHandedBack(task);
        this.putItems(sessionId, [{ ...item, data: { ...item.data, state: now.state, reply: now.reply ?? item.data.reply, error: now.error ?? null, endedAt: Date.now() } }]);
        continue;
      }
      this.handoffs.set(task, { sessionId, targetSessionId: item.data.targetSessionId, item });
    }
    const server = createServer((req, res) => this.http(req, res));
    const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
    server.on('upgrade', (req, socket, head) => {
      const path = (req.url ?? '').split('?')[0];
      if (!this.authorized(req) || (path !== '/ws/app' && path !== '/ws/device')) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      const owner = this.ownerLogin !== '' && req.headers['tailscale-user-login'] === this.ownerLogin;
      wss.handleUpgrade(req, socket, head, (ws) => (path === '/ws/app' ? this.attachApp(ws) : this.attachRemoteDevice(ws, owner)));
    });
    server.listen(HUB_LOCAL_PORT, '127.0.0.1', () => log('hub', `listening on 127.0.0.1:${HUB_LOCAL_PORT}`));

    setInterval(() => {
      for (const conn of [...this.devices.values(), ...this.pending.values()]) conn.send({ t: 'tick' });
      for (const ws of this.apps) this.sendApp(ws, { t: 'tick' });
    }, TICK_MS);
  }

  /** Requests through `tailscale serve` carry the owner's login; direct loopback requests are local. */
  private authorized(req: IncomingMessage): boolean {
    const login = req.headers['tailscale-user-login'];
    if (login === undefined) return true; // loopback only: this machine's own user
    return typeof login === 'string' && login === this.ownerLogin && this.ownerLogin !== '';
  }

  // ---------- HTTP ----------

  private http(req: IncomingMessage, res: ServerResponse): void {
    if (!this.authorized(req)) return void res.writeHead(403).end();
    const url = new URL(req.url ?? '/', 'http://hub');
    if (req.method === 'POST' && url.pathname === '/api/upload') return void this.upload(req, url, res);
    if (req.method !== 'GET') return void res.writeHead(405).end();
    if (url.pathname === '/api/info') {
      // Lets other computers find out which machine is the hub.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return void res.end(JSON.stringify({ app: 'allinone', hub: true, stableId: this.hubId, name: this.hubName, v: PROTOCOL_VERSION,
        url: `https://${this.hubDns}:${HUB_PORT}/`, members: this.memberHosts() }));
    }
    if (url.pathname === '/api/pair') {
      const code = url.searchParams.get('code') ?? '';
      const expires = this.pairCodes.get(code);
      this.pairCodes.delete(code);
      if (!expires || expires < Date.now()) return void res.writeHead(410, { 'Content-Type': 'application/json' }).end('{"error":"二维码已失效，请在电脑上重新生成"}');
      activity('手机已完成配对');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return void res.end(JSON.stringify({ url: `https://${this.hubDns}:${HUB_PORT}/`, members: this.memberHosts() }));
    }
    if (url.pathname === '/api/handover') return void this.serveHandover(url.searchParams.get('token') ?? '', res);
    if (url.pathname === '/api/notify') return void this.serveNotices(Number(url.searchParams.get('after')) || 0, res);
    if (url.pathname.startsWith('/files/')) return void this.serveArtifact(url.pathname.slice(7), res);
    if (url.pathname === '/app.apk') {
      // The phone app, built by tools/build-android.mjs; opened in the phone's browser to install.
      if (!existsSync(APK)) return void res.writeHead(404).end();
      res.writeHead(200, { 'Content-Type': 'application/vnd.android.package-archive', 'Content-Length': statSync(APK).size,
        'Content-Disposition': 'attachment; filename="AgentChat.apk"', 'Cache-Control': 'no-cache' });
      return void createReadStream(APK).pipe(res);
    }
    // /pair: where the pairing QR code leads in the phone's browser (opens the app, or helps install it first).
    const rel = url.pathname === '/' ? 'index.html' : url.pathname === '/pair' ? 'pair.html' : normalize(url.pathname).replace(/^[\\/]+/, '');
    const file = join(WEB_DIR, rel);
    if (!file.startsWith(WEB_DIR) || !existsSync(file) || !statSync(file).isFile()) return void res.writeHead(404).end();
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    createReadStream(file).pipe(res);
  }

  /** A file the phone is about to send: the raw body, kept by its hash like the agents' outputs. */
  private upload(req: IncomingMessage, url: URL, res: ServerResponse): void {
    const reply = (status: number, body: unknown) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    const name = (url.searchParams.get('name') ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 120) || 'file';
    const mime = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() || 'application/octet-stream';
    const declared = Number(req.headers['content-length']);
    if (declared > MAX_UPLOAD_BYTES) return void reply(413, { error: '文件太大（最大 25 MB）' });
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_UPLOAD_BYTES) {
        reply(413, { error: '文件太大（最大 25 MB）' });
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > MAX_UPLOAD_BYTES) return;
      if (!size) return void reply(400, { error: '空文件' });
      const data = Buffer.concat(chunks);
      const sha = sha256(data);
      this.store.saveArtifact(sha, name, size, mime, data);
      reply(200, { sha256: sha, name, size, mime } satisfies Attachment);
    });
  }

  private serveArtifact(sha: string, res: ServerResponse): void {
    const art = /^[0-9a-f]{64}$/.test(sha) ? this.store.artifact(sha) : undefined;
    if (!art || !existsSync(art.path)) return void res.writeHead(404).end();
    res.writeHead(200, { 'Content-Type': art.mime, 'Content-Length': art.size, 'Cache-Control': 'private, max-age=31536000, immutable',
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(art.name)}` });
    createReadStream(art.path).pipe(res);
  }

  // ---------- devices ----------

  /** The hub machine's own device, connected in-process. */
  connectLocalDevice(): LocalTransport {
    const conn: DeviceConn = { local: true, send: (msg) => transport.deliver(msg), close: () => {} };
    const transport = new LocalTransport((msg) => this.onDevice(conn, msg));
    return transport;
  }

  private attachRemoteDevice(ws: WebSocket, owner: boolean): void {
    let alive = true;
    const conn: DeviceConn = { local: false, owner, send: (msg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg)), close: () => ws.close() };
    ws.on('pong', () => (alive = true));
    const ping = setInterval(() => {
      if (!alive) return void ws.terminate();
      alive = false;
      ws.ping();
    }, TICK_MS);
    ws.on('message', (raw) => {
      const msg = parseJson<DeviceToHub>(String(raw));
      if (msg) this.onDevice(conn, msg);
    });
    ws.on('close', () => {
      clearInterval(ping);
      this.detach(conn);
    });
  }

  private detach(conn: DeviceConn): void {
    if (!conn.deviceId) return;
    if (this.devices.get(conn.deviceId) === conn) {
      this.devices.delete(conn.deviceId);
      activity(`「${this.store.device(conn.deviceId)?.name}」已离线`, 'warn');
      this.broadcastDevices();
    }
    if (this.pending.get(conn.deviceId) === conn) this.pending.delete(conn.deviceId);
    this.onChange();
  }

  private activate(conn: DeviceConn, deviceId: string): void {
    const previous = this.devices.get(deviceId);
    if (previous && previous !== conn) previous.close();
    this.devices.set(deviceId, conn);
    const device = this.store.device(deviceId);
    if (device) this.store.ensureFriends(deviceId, JSON.parse(device.agents));
    this.broadcast({ t: 'friends', friends: this.store.friends() });
    conn.send({ t: 'welcome' });
    for (const s of this.store.hydratedSessions(deviceId)) conn.send({ t: 'hydrate', ...s });
    for (const r of this.store.queuedRequests(deviceId)) this.forward(r.requestId, 'pending');
    activity(`「${this.store.device(deviceId)?.name}」已连接`);
    this.broadcastDevices();
    this.onChange();
    // Whether it was allowed long ago or just now: a computer running other code gets the hub's.
    if (!conn.local && conn.code) void this.offerUpdate(conn, conn.name ?? deviceId, conn.code);
  }

  private onDevice(conn: DeviceConn, msg: DeviceToHub): void {
    if (msg.t === 'hello') return this.onHello(conn, msg);
    const deviceId = conn.deviceId;
    if (!deviceId || this.devices.get(deviceId) !== conn) return; // not allowed (yet)
    this.store.touchDevice(deviceId);
    switch (msg.t) {
      case 'ask':
        void this.onAsk(conn, deviceId, msg);
        break;
      case 'file': {
        // Checked against its hash before it is kept: the message that names it relies on that.
        const data = Buffer.from(String(msg.data ?? ''), 'base64');
        if (data.length === msg.size && sha256(data) === msg.sha256 && data.length <= MAX_UPLOAD_BYTES) {
          this.store.saveArtifact(msg.sha256, String(msg.name).slice(0, 200), data.length, String(msg.mime), data);
        }
        break;
      }
      case 'presence':
        this.presence.set(deviceId, { activeAt: Date.now() - Math.max(0, Number(msg.idleMs) || 0), locked: Boolean(msg.locked) });
        break;
      case 'created':
        this.creates.get(msg.id)?.(msg);
        this.creates.delete(msg.id);
        break;
      case 'agents':
        this.announceAgents(conn.name ?? deviceId, this.store.setAgents(deviceId, msg.agents));
        this.broadcastDevices();
        break;
      case 'projects':
        if (this.store.setProjects(deviceId, msg.agentId, msg.projects)) this.broadcast({ t: 'projects', deviceId, agentId: msg.agentId, projects: msg.projects });
        break;
      case 'sessions': {
        const before = this.store.currentSeq;
        const changed = this.store.upsertSessions(deviceId, msg.agentId, msg.sessions, msg.complete);
        const archived = this.store.sessionsAfter(before).archived;
        if (changed.length || archived.length) this.broadcast({ t: 'sessions', sessions: changed, archived, seq: this.store.currentSeq });
        break;
      }
      case 'items': {
        const id = sessionKey(deviceId, msg.agentId, msg.threadId);
        const changed = this.store.upsertItems(id, msg.items);
        conn.send({ t: 'ack', oid: msg.oid });
        if (changed.length) this.broadcast({ t: 'items', sessionId: id, items: changed });
        if (changed.length) this.refreshHandoffs(id);
        for (const item of changed) {
          if (item.kind === 'message' && item.data.role === 'user') {
            // Our request id when we started the turn; otherwise (queued through Codex, which assigns its own id) match by text.
            const clientId = typeof item.data.clientId === 'string' ? item.data.clientId : '';
            const match = this.store.request(clientId)?.requestId ?? this.store.pendingSendByText(id, String(item.data.text ?? '').trim())?.requestId;
            if (match) this.updateRequest(match, 'delivered', item.turnId);
          }
          const title = this.store.session(id)?.title ?? '对话';
          // Agents passing work to each other finish turns all the time: the owner hears of their own conversations only.
          const done = item.kind === 'status' && item.data.status === 'completed' && typeof item.data.completedAt === 'number'
            && Date.now() / 1000 - item.data.completedAt < 120 && !isChannelTitle(title);
          if (done) {
            activity(`${this.store.device(deviceId)?.name} · ${title}：完成了一轮`);
            // 消息免打扰 (the conversation or its agent): no notice. Approvals still come: the agent waits for an answer.
            if (!this.store.isMuted(id)) this.notice({ type: 'done', sessionId: id, title, text: this.lastReply(id, item.turnId) });
          }
          if (item.kind === 'status' && item.data.status === 'failed' && item.turnId && typeof item.data.completedAt === 'number'
            && Date.now() / 1000 - item.data.completedAt < 120) {
            const requestId = this.store.requestForTurn(id, item.turnId);
            if (requestId) this.handoffFailed(id, requestId, String(item.data.error ?? '这一轮执行失败'));
          }
          if (item.kind === 'approval_request' && item.data.state === 'pending') {
            this.notice({ type: 'approval', sessionId: id, title, text: String(item.data.command ?? item.data.reason ?? '需要你确认') });
          }
        }
        break;
      }
      case 'artifact': {
        const data = Buffer.from(msg.data, 'base64');
        if (data.length !== msg.size || sha256(data) !== msg.sha256) {
          log('hub', `artifact rejected (size/hash mismatch): ${msg.name}`);
        } else {
          this.store.saveArtifact(msg.sha256, msg.name, msg.size, msg.mime, data);
          const id = sessionKey(deviceId, msg.agentId, msg.threadId);
          // With its own turn, not when it arrived: the owner's pictures beside the prompt, outputs after the turn.
          const ts = (msg.turnId && (msg.sent ? this.store.turnStart(id, msg.turnId) : this.store.turnTime(id, msg.turnId))) || Date.now();
          const changed = this.store.upsertItems(id, [{ itemId: msg.itemId, turnId: msg.turnId, kind: 'artifact', ts,
            data: { sha256: msg.sha256, name: msg.name, size: msg.size, mime: msg.mime, ...(msg.sent ? { sent: true } : {}) } }]);
          if (changed.length) this.broadcast({ t: 'items', sessionId: id, items: changed });
        }
        conn.send({ t: 'ack', oid: msg.oid });
        break;
      }
      case 'delta':
        this.broadcast({ t: 'delta', sessionId: sessionKey(deviceId, msg.agentId, msg.threadId), itemId: msg.itemId, turnId: msg.turnId, text: msg.text });
        break;
      case 'receipt':
        if (!this.store.request(msg.requestId)) {
          // The first message of a conversation still being made: kept until its request is recorded.
          for (const [k, v] of this.earlyReceipts) if (v.at < Date.now() - 300_000) this.earlyReceipts.delete(k);
          this.earlyReceipts.set(msg.requestId, { state: msg.state, turnId: msg.turnId ?? null, error: msg.error ?? null, at: Date.now() });
          break;
        }
        this.updateRequest(msg.requestId, msg.state, msg.turnId ?? null, msg.error ?? null);
        break;
    }
  }

  /** Every computer runs the hub's program: one that differs gets it. */
  private async offerUpdate(conn: DeviceConn, name: string, code: string): Promise<void> {
    try {
      const pkg = await buildPackage();
      if (code === pkg.version || this.devices.get(conn.deviceId ?? '') !== conn) return;
      activity(`「${name}」的程序版本与主电脑不同，正在发送更新`);
      conn.send({ t: 'update', version: pkg.version, data: pkg.data.toString('base64') });
    } catch (error) {
      log('hub', `could not build the update package: ${(error as Error).message}`);
    }
  }

  private onHello(conn: DeviceConn, msg: Extract<DeviceToHub, { t: 'hello' }>): void {
    if (msg.v !== PROTOCOL_VERSION) {
      conn.send({ t: 'rejected', reason: `协议版本不一致（主电脑 ${PROTOCOL_VERSION}，设备 ${msg.v}）` });
      return conn.close();
    }
    conn.deviceId = msg.deviceId;
    // An agent installed while the computer's program was off shows up with its hello.
    const known = this.store.device(msg.deviceId)?.approved ? this.store.setAgents(msg.deviceId, msg.agents) : [];
    // A computer on the owner's own Tailscale account is the owner's: it joins without being allowed by hand, and one
    // reinstalled (a new secret) takes its place again. Only another account's computer waits for the owner.
    let status = this.store.registerDevice(msg.deviceId, msg.name, msg.secret, msg.agents, Boolean(conn.owner));
    if (status === 'approved') this.announceAgents(msg.name, known);
    if (status === 'mismatch') {
      log('hub', `device rejected (secret mismatch): ${msg.name}`);
      conn.send({ t: 'rejected', reason: '设备凭据与登记不符' });
      return conn.close();
    }
    // The hub's own machine needs no approval.
    if (status === 'pending' && ((conn.local && msg.deviceId === this.hubId) || conn.owner)) {
      this.store.approveDevice(msg.deviceId);
      if (conn.owner) activity(`「${msg.name}」已加入（同一个 Tailscale 账号，自动允许）`);
      status = 'approved';
    }
    conn.name = msg.name;
    conn.code = msg.code;
    if (status === 'approved' || (conn.local && msg.deviceId === this.hubId)) return this.activate(conn, msg.deviceId);
    this.pending.set(msg.deviceId, conn);
    conn.send({ t: 'pending' });
    activity(`「${msg.name}」请求加入`, 'warn');
    this.onChange();
  }

  // ---------- apps ----------

  private attachApp(ws: WebSocket): void {
    this.apps.add(ws);
    ws.on('message', (raw) => {
      const msg = parseJson<AppToHub>(String(raw));
      if (msg) this.onApp(ws, msg);
    });
    ws.on('close', () => this.apps.delete(ws));
  }

  private onApp(ws: WebSocket, msg: AppToHub): void {
    switch (msg.t) {
      case 'hello': {
        const after = Number.isInteger(msg.after) && msg.after >= 0 && msg.after <= this.store.currentSeq ? msg.after : 0;
        this.sendApp(ws, { t: 'version', web: webVersion() });
        this.sendApp(ws, { t: 'devices', devices: this.store.devices(new Set(this.devices.keys()), this.hubId) });
        this.sendApp(ws, { t: 'friends', friends: this.store.friends() });
        this.sendApp(ws, { t: 'settings', settings: this.settings() });
        for (const p of this.store.allProjects()) this.sendApp(ws, { t: 'projects', ...p });
        const { live, archived } = this.store.sessionsAfter(after);
        this.sendApp(ws, { t: 'sessions', sessions: live, archived, seq: this.store.currentSeq });
        // The day's requests come along whatever the phone has: the workbench strings today's hand-offs together from them.
        this.sendApp(ws, { t: 'requests', requests: this.store.requestsAfter(after, 86_400_000) });
        this.sendApp(ws, { t: 'collection', name: 'approvals', items: this.store.pendingApprovals() });
        break;
      }
      case 'artifacts':
        this.sendApp(ws, { t: 'collection', name: 'artifacts', items: this.store.artifactItems() });
        break;
      case 'friend': {
        const remark = typeof msg.remark === 'string' ? msg.remark.trim().slice(0, 40) || null : msg.remark === null ? null : undefined;
        const added = typeof msg.added === 'boolean' ? msg.added : undefined;
        const acceptAgents = typeof msg.acceptAgents === 'boolean' ? msg.acceptAgents : undefined;
        const muted = typeof msg.muted === 'boolean' ? msg.muted : undefined;
        // A picture the phone uploaded first, by its hash; null puts the default back.
        let avatar: string | null | undefined;
        if (msg.avatar === null) avatar = null;
        else if (typeof msg.avatar === 'string') {
          if (!/^[0-9a-f]{64}$/.test(msg.avatar) || !this.store.artifact(msg.avatar)?.mime.startsWith('image/')) return this.sendApp(ws, { t: 'error', message: '头像图片无效，请重新选择' });
          avatar = msg.avatar;
        }
        if (!this.store.setFriend(String(msg.deviceId), String(msg.agentId), { added, remark, acceptAgents, avatar, muted })) return this.sendApp(ws, { t: 'error', message: '没有这位好友' });
        if (added) activity(`已添加好友：${this.store.device(String(msg.deviceId))?.name ?? msg.deviceId}`);
        this.broadcast({ t: 'friends', friends: this.store.friends() });
        break;
      }
      case 'installUpdate':
        if (this.newVersion) {
          activity(`手机上点了更新到 ${this.newVersion}`);
          this.onInstallUpdate();
        }
        break;
      case 'settings': {
        if (typeof msg.settings?.agentLinks === 'boolean') {
          this.store.setSetting('agentLinks', msg.settings.agentLinks ? '1' : '0');
          activity(msg.settings.agentLinks ? '已打开 Agent 互通' : '已关闭 Agent 互通');
        }
        if (typeof msg.settings?.followMe === 'boolean') {
          this.store.setSetting('followMe', msg.settings.followMe ? '1' : '0');
          activity(msg.settings.followMe ? '已打开：在电脑前时提醒弹在电脑上，手机不响' : '已关闭：提醒都发到手机');
        }
        if (typeof msg.settings?.autoReport === 'boolean') {
          this.store.setSetting('autoReport', msg.settings.autoReport ? '1' : '0');
          activity(msg.settings.autoReport ? '已打开：做完自动把汇报发回给派活的 Agent' : '已关闭：做完自动把汇报发回给派活的 Agent');
        }
        this.broadcast({ t: 'settings', settings: this.settings() });
        break;
      }
      case 'read':
      case 'pin':
      case 'mute': {
        const id = String(msg.sessionId);
        const changed = msg.t === 'read' ? this.store.markRead(id, Number(msg.replies))
          : msg.t === 'pin' ? this.store.setFlag(id, 'pinned', Boolean(msg.pinned)) : this.store.setFlag(id, 'muted', Boolean(msg.muted));
        if (!changed) break;
        // Every phone and browser follows: read on one, read on all.
        const { hydrated: _h, archived: _a, ...view } = changed as SessionView & { hydrated?: boolean; archived?: boolean };
        this.broadcast({ t: 'sessions', sessions: [view], archived: [], seq: this.store.currentSeq });
        break;
      }
      case 'open': {
        const session = this.store.session(msg.sessionId);
        if (!session) return this.sendApp(ws, { t: 'error', message: '对话不存在' });
        this.sendApp(ws, { t: 'items', sessionId: session.id, items: this.store.itemsAfter(session.id, Math.max(0, msg.after | 0)) });
        if (!session.hydrated) {
          this.store.setHydrated(session.id);
          this.devices.get(session.deviceId)?.send({ t: 'hydrate', agentId: session.agentId, threadId: session.threadId });
        }
        break;
      }
      case 'command':
        this.onCommand(ws, msg.sessionId, msg.command);
        break;
    }
  }

  private onCommand(ws: WebSocket, sessionId: string, command: Command): void {
    const result = this.submit(sessionId, command);
    if (typeof result === 'string') this.sendApp(ws, { t: 'error', message: result });
    else if (!result.created) this.sendApp(ws, { t: 'requests', requests: [result.view] });
  }

  /**
   * Takes a request into a conversation, from the phone or (with `origin`) from an agent, and passes it on.
   * Returns why it was refused, as the owner reads it.
   */
  /** `delivered`: the device already has it (a conversation started with this message): recorded, not forwarded. */
  private submit(sessionId: string, command: Command, origin?: Origin, delivered = false): string | { view: RequestView; created: boolean } {
    const session = this.store.session(sessionId);
    const fail = (message: string) => message;
    if (!session || session.archived) return fail('对话不存在');
    if (!command || typeof command.requestId !== 'string' || !REQUEST_ID.test(command.requestId)) return fail('请求编号无效');
    if (command.op === 'cancel') {
      const target = this.store.request(command.requestId);
      if (target?.state === 'queued') this.updateRequest(command.requestId, 'cancelled');
      return;
    }
    // Only files the hub holds, described by its own record rather than by the phone.
    const files: Attachment[] = [];
    if (command.op === 'send' && command.files !== undefined) {
      if (!Array.isArray(command.files) || command.files.length > MAX_ATTACHMENTS) return fail(`一次最多发送 ${MAX_ATTACHMENTS} 个文件`);
      for (const f of command.files) {
        const sha = typeof f?.sha256 === 'string' && /^[0-9a-f]{64}$/.test(f.sha256) ? f.sha256 : '';
        const art = sha ? this.store.artifact(sha) : undefined;
        if (!art || !existsSync(art.path)) return fail('附件已失效，请重新选择');
        files.push({ sha256: sha, name: typeof f.name === 'string' && f.name.trim() ? f.name.trim().slice(0, 120) : art.name, size: art.size, mime: art.mime });
      }
    }
    const text = typeof command.text === 'string' ? command.text : '';
    if (command.op === 'send' && ((!text.trim() && !files.length) || text.length > MAX_TEXT)) return fail('消息为空或过长');
    if (command.op === 'approve' && (typeof command.approvalId !== 'string' || !['accept', 'decline', 'cancel'].includes(command.decision ?? ''))) return fail('审批参数无效');
    let answers: Record<string, string> | undefined;
    if (command.op === 'approve' && command.answers !== undefined) {
      const entries = command.answers && typeof command.answers === 'object' ? Object.entries(command.answers) : [];
      if (!entries.length || entries.length > 20 || entries.some(([k, v]) => typeof v !== 'string' || k.length > 100 || v.length > MAX_TEXT)) return fail('回答内容无效');
      answers = Object.fromEntries(entries) as Record<string, string>;
    }
    if (!['send', 'interrupt', 'approve'].includes(command.op)) return fail('不支持的操作');

    const online = this.devices.has(session.deviceId);
    // Only messages wait for an offline device; stopping or approving later would act on a stale turn.
    const state: RequestState = online ? 'pending' : command.op === 'send' ? 'queued' : 'failed';
    const clean: Command = { requestId: command.requestId, op: command.op, text: command.op === 'send' ? text : undefined,
      files: files.length ? files : undefined, approvalId: command.approvalId, decision: command.decision, answers, origin };
    const { view, created } = this.store.createRequest(command.requestId, sessionId, command.op, clean,
      command.op === 'send' ? requestText(text, files) : null, state);
    if (!created) return { view, created };
    if (state === 'failed') this.store.updateRequest(view.requestId, 'failed', null, 'device_offline');
    this.broadcast({ t: 'requests', requests: [this.store.request(view.requestId)!] });
    if (files.length) {
      // What the owner sent belongs to the conversation's library too.
      const items = this.store.upsertItems(sessionId, files.map((f, i) => ({ itemId: `sent:${view.requestId}:${i}`, turnId: null, kind: 'artifact' as const,
        ts: Date.now(), data: { sha256: f.sha256, name: f.name, size: f.size, mime: f.mime, sent: true } })));
      if (items.length) this.broadcast({ t: 'items', sessionId, items });
    }
    if (delivered) {
      // Its receipt may have come in while the conversation was being made.
      const early = this.earlyReceipts.get(view.requestId);
      this.earlyReceipts.delete(view.requestId);
      if (early) this.updateRequest(view.requestId, early.state, early.turnId, early.error);
    } else if (online) this.forward(view.requestId, null);
    return { view: this.store.request(view.requestId)!, created };
  }

  // ---------- agents using the AgentChat tool ----------

  private async onAsk(conn: DeviceConn, deviceId: string, msg: Extract<DeviceToHub, { t: 'ask' }>): Promise<void> {
    try {
      const device = this.store.device(deviceId);
      const agent = (JSON.parse(device?.agents ?? '[]') as AgentInfo[]).find((a) => a.id === msg.agentId);
      if (!device || !agent) throw new Error('发起的 Agent 不在这台电脑上');
      // The conversation it asks from, when its tool knows it: then nothing has to be guessed about where it works.
      const own = typeof msg.thread === 'string' && msg.thread ? sessionKey(deviceId, agent.id, msg.thread) : '';
      const origin: Origin = { deviceId, agentId: agent.id, label: `${device.name} · ${agent.label}`, ...(own && this.store.session(own) ? { sessionId: own } : {}) };
      const result = msg.op === 'agents' ? this.askAgents()
        : msg.op === 'send' ? await this.askSend(origin, msg.args)
          : msg.op === 'wait' ? await this.askWait(origin, msg.args)
            : msg.op === 'read' ? this.askRead(msg.args)
              : msg.op === 'stop' ? this.askStop(origin, msg.args) : null;
      if (result === null) throw new Error('不支持的操作');
      conn.send({ t: 'answer', id: msg.id, result });
    } catch (error) {
      conn.send({ t: 'answer', id: msg.id, error: (error as Error).message });
    }
  }

  /** Every computer's agents with their latest conversations, by the names the phone shows. */
  private askAgents(): unknown {
    const online = new Set(this.devices.keys());
    const remarks = new Map(this.store.friends().map((f) => [`${f.deviceId}|${f.agentId}`, f.remark]));
    return this.store.devices(online, this.hubId).filter((d) => d.approved).flatMap((d) => d.agents.map((a) => ({
      name: `${d.name} · ${a.label}`, remark: remarks.get(`${d.id}|${a.id}`) ?? null, online: d.online,
      conversations: this.store.recentSessions(d.id, a.id, 8).map((s) => ({ id: s.id, title: s.title, running: s.running, updatedAt: s.updatedAt })),
    })));
  }

  /** The agent an agent names: "computer · agent", or the remark the owner gave that friend. */
  private findAgent(args: Record<string, unknown>): { d: DeviceView; a: AgentInfo } {
    const to = String(args.to ?? '').replace(/\s+/g, '').toLowerCase();
    if (!to) throw new Error('要写明发给谁（电脑 · Agent）');
    const remarks = new Map(this.store.friends().map((f) => [`${f.deviceId}|${f.agentId}`, f.remark]));
    const agents = this.store.devices(new Set(this.devices.keys()), this.hubId).filter((d) => d.approved)
      .flatMap((d) => d.agents.map((a) => ({ d, a, names: [`${d.name}·${a.label}`, `${d.name}·${a.id}`, remarks.get(`${d.id}|${a.id}`) ?? ''] })))
      .filter((x) => x.names.some((n) => n && n.replace(/\s+/g, '').toLowerCase() === to));
    if (!agents.length) throw new Error(`找不到「${args.to}」，先用 agents 看看有哪些`);
    return agents[0]!;
  }

  /** Finds the conversation an agent names: its id, or "computer · agent" (or the friend's remark) and a title. */
  private findTarget(args: Record<string, unknown>): string {
    const id = typeof args.conversationId === 'string' ? args.conversationId : '';
    if (id && this.store.session(id)) return id;
    const title = String(args.conversation ?? '').trim();
    const { d, a } = this.findAgent(args);
    const sessions = this.store.recentSessions(d.id, a.id, 200);
    if (!title) throw new Error(`要写明发到「${d.name} · ${a.label}」的哪个对话（标题或编号）`);
    const match = sessions.find((s) => s.title === title || s.threadId === title) ?? sessions.find((s) => s.title.includes(title));
    if (!match) throw new Error(`「${d.name} · ${a.label}」里没有叫「${title}」的对话`);
    return match.id;
  }

  /**
   * A new conversation for `first`. With a `title`: a work conversation of that name, which the owner sees and joins
   * like any other (one of that name already there is used instead of a second). Without: the one conversation an
   * agent keeps with another just for passing work back and forth, made the first time and reused after; the phone
   * never lists it. `sent`: the agent started it with `first` already (Goose's window, Claude Code).
   */
  private async createFor(origin: Origin, args: Record<string, unknown>, first: Command): Promise<{ sessionId: string; sent: boolean }> {
    const { d, a } = this.findAgent(args);
    const named = String(args.title ?? '').trim().slice(0, 80);
    const title = named || `${CHANNEL_TITLE} · 来自 ${origin.label}`;
    const existing = this.store.recentSessions(d.id, a.id, 500).find((s) => s.title === title);
    if (existing) return { sessionId: existing.id, sent: false };
    const cwd = String(args.cwd ?? '').trim(); // empty: the agent's own default folder
    const conn = this.devices.get(d.id);
    if (!conn) throw new Error(`${d.name} 不在线，不能新建对话`);
    const id = ++this.createSeq;
    // Goose types it into its window, Claude Code starts a run: either may take a while.
    const { threadId, sent } = await new Promise<{ threadId: string; sent: boolean }>((resolve, reject) => {
      const timer = setTimeout(() => (this.creates.delete(id), reject(new Error('对方电脑没有回应'))), 120_000);
      this.creates.set(id, (r) => (clearTimeout(timer), r.threadId ? resolve({ threadId: r.threadId, sent: Boolean(r.sent) }) : reject(new Error(createError(r.error)))));
      conn.send({ t: 'create', id, agentId: a.id, cwd, title, first });
    });
    const sessionId = sessionKey(d.id, a.id, threadId);
    for (let i = 0; i < 40 && !this.store.session(sessionId); i++) await new Promise((r) => setTimeout(r, 250));
    if (!this.store.session(sessionId)) throw new Error('新对话已建好，但主电脑还没收到它，请稍后用 agents 查到后再发');
    if (named) activity(`${origin.label} 在「${d.name} · ${a.label}」新建了对话「${title}」`);
    return { sessionId, sent };
  }

  private settings(): HubSettings {
    return { agentLinks: this.store.setting('agentLinks') !== '0', autoReport: this.store.setting('autoReport') !== '0',
      followMe: this.store.setting('followMe') !== '0',
      ...(this.newVersion ? { newVersion: this.newVersion } : {}) };
  }

  /** A newer release is out: phones show it in settings (and hear of it once), where the owner can update. */
  offerVersion(version: string): void {
    if (this.newVersion === version) return;
    this.newVersion = version;
    this.broadcast({ t: 'settings', settings: this.settings() });
    this.notice({ type: 'agent', sessionId: '', title: 'AgentChat 有新版本', text: `新版本 ${version} 已发布，打开 App 的「设置」就能更新` });
  }

  /**
   * The owner's guard rails, checked before an agent's message goes anywhere: agents may reach each other at all,
   * this one takes messages from agents, the chain of hand-offs is short, the sender is not flooding.
   * Returns the depth the new message takes in its chain.
   */
  private guard(origin: Origin, deviceId: string, agentId: string, targetSession?: string): number {
    if (!this.settings().agentLinks) throw new Error('主人在手机上关闭了 Agent 互通');
    // The same agent may pass word to another of its own existing conversations (say, two Claude Code chats on
    // one computer), never to the conversation it is working in, nor to "itself" without naming a conversation.
    if (deviceId === origin.deviceId && agentId === origin.agentId) {
      const own = this.workingConversation(origin);
      if (!targetSession || !own || own.id === targetSession) throw new Error('不能发给自己');
    }
    if (!this.store.acceptsAgents(deviceId, agentId)) throw new Error('主人设置了这个 Agent 不接收其他 Agent 的消息');
    // Counted along the conversation the sender works in: what the owner asked there starts a new chain. With no
    // working conversation to go by, the hand-offs it received lately stand in.
    const since = Date.now() - CHAIN_WINDOW_MS;
    const from = this.workingConversation(origin);
    const depth = (from ? this.store.turnDepth(from.id, since) : this.store.chainDepth(origin.deviceId, origin.agentId, since)) + 1;
    if (depth > MAX_CHAIN) throw new Error(`已经转了 ${depth - 1} 手，最多 ${MAX_CHAIN} 手：请把结果交回给发起的 Agent，不要再往下转`);
    if (this.store.agentSends(origin.deviceId, origin.agentId, Date.now() - 3_600_000) >= MAX_SENDS_PER_HOUR) {
      // Once an hour per sender: the owner hears of it, not of every refused message.
      const key = `${origin.deviceId}|${origin.agentId}`;
      if ((this.floodNoticed.get(key) ?? 0) < Date.now() - 3_600_000) {
        this.floodNoticed.set(key, Date.now());
        this.notice({ type: 'agent', sessionId: '', title: 'Agent 发消息太频繁', text: `${origin.label} 一小时内发了 ${MAX_SENDS_PER_HOUR} 条，之后的先拦下了` });
        activity(`${origin.label} 发消息太频繁，已暂时拦下`, 'warn');
      }
      throw new Error(`一小时内最多发 ${MAX_SENDS_PER_HOUR} 条，请稍后再发`);
    }
    return depth;
  }

  private async askSend(origin: Origin, args: Record<string, unknown>): Promise<unknown> {
    const text = String(args.text ?? '').trim();
    if (!text) throw new Error('消息是空的');
    const to = args.newConversation || args.title || !(typeof args.conversationId === 'string' && this.store.session(args.conversationId))
      ? this.findAgent(args) : null;
    // An existing conversation named by its title is as known as one given by its id: the guard can tell it apart
    // from the one the sender works in.
    const named = to && !args.newConversation && !args.title && args.conversation ? this.findTarget(args) : undefined;
    const depth = to ? this.guard(origin, to.d.id, to.a.id, named) : (() => {
      const s = this.store.session(String(args.conversationId))!;
      return this.guard(origin, s.deviceId, s.agentId, s.id);
    })();
    // The conversation the sender works in: its card goes there, and the receiver can follow the message back.
    const from = this.workingConversation(origin);
    origin = { ...origin, depth, ...(from ? { sessionId: from.id } : {}) };
    const requestId = randomUUID().replaceAll('-', '');
    // The receiving agent sees at a glance that this comes from another agent, not from the owner (and from which conversation).
    const mark = from && !isChannelTitle(from.title) ? `${origin.label}「${from.title.slice(0, 40)}」` : origin.label;
    // Files the sender handed along: its computer sent them ahead, the hub holds them by their hash.
    const files = Array.isArray(args.files) ? (args.files as Attachment[]).filter((f) => f && typeof f.sha256 === 'string') : [];
    for (const f of files) if (!this.store.artifact(f.sha256)) throw new Error(`文件「${f.name}」没有传到主电脑，请重发`);
    const command: Command = { requestId, op: 'send', text: `[来自 ${mark}，经 AgentChat 转发] ${text}`, origin, ...(files.length ? { files } : {}) };
    const created = args.newConversation || args.title ? await this.createFor(origin, args, command) : null;
    const sessionId = created?.sessionId ?? this.findTarget(args);
    // A conversation that never had a message from another agent (one opened before AgentChat was there, say) learns
    // in a few lines what this is and that its answer goes back by itself.
    if (!created && !this.store.hasAgentMessages(sessionId)) command.text += FIRST_CONTACT_NOTE;
    const target = this.store.session(sessionId)!;
    // Follow the conversation in full, as opening it on the phone does: its turns and their end must reach the hub.
    if (!target.hydrated) {
      this.store.setHydrated(sessionId);
      this.devices.get(target.deviceId)?.send({ t: 'hydrate', agentId: target.agentId, threadId: target.threadId });
    }
    const result = this.submit(sessionId, command, origin, created?.sent);
    if (typeof result === 'string') throw new Error(result);
    activity(`${origin.label} → ${target.title}：发了一条消息`);
    if (from) this.placeHandoff(from.id, requestId, target, text);
    return { task: requestId, conversationId: sessionId, title: target.title, state: result.view.state };
  }

  // ---------- hand-off cards ----------

  /**
   * Which conversation an agent works in right now: the one it is running a turn in (the latest, if several);
   * failing that, the one it was busy in during the last two minutes. The AgentChat tool cannot tell, so the hub looks.
   */
  private workingConversation(origin: Origin): SessionView | null {
    const own = origin.sessionId ? this.store.session(origin.sessionId) : undefined;
    if (own && !own.archived) return own;
    const sessions = this.store.recentSessions(origin.deviceId, origin.agentId, 50).filter((s) => !isChannelTitle(s.title));
    return sessions.find((s) => s.running) ?? sessions.find((s) => Date.now() / 1000 - s.updatedAt < 120) ?? null;
  }

  /** Puts the card for a hand-off into the sender's conversation, and keeps it current until the work ends. */
  private placeHandoff(sessionId: string, requestId: string, target: SessionView, text: string): void {
    const remark = this.store.friends().find((f) => f.deviceId === target.deviceId && f.agentId === target.agentId)?.remark;
    const device = this.store.device(target.deviceId);
    const agent = (JSON.parse(device?.agents ?? '[]') as AgentInfo[]).find((a) => a.id === target.agentId);
    const from = this.store.session(sessionId);
    // Follow the sender's conversation in full too: the card sits among its messages (the phone places it after the
    // owner's message that led to it).
    if (from && !from.hydrated) {
      this.store.setHydrated(sessionId);
      this.devices.get(from.deviceId)?.send({ t: 'hydrate', agentId: from.agentId, threadId: from.threadId });
    }
    const item: Item = { itemId: `handoff:${requestId}`, turnId: from?.activeTurnId ?? null, kind: 'handoff', ts: Date.now(), data: {
      task: requestId, to: remark || `${device?.name ?? ''} · ${agent?.label ?? target.agentId}`, targetSessionId: target.id,
      channel: isChannelTitle(target.title), text: text.split('\n')[0]!.slice(0, 120), state: 'running', reply: null, startedAt: Date.now(), endedAt: null } };
    this.handoffs.set(requestId, { sessionId, targetSessionId: target.id, item });
    this.putItems(sessionId, [item]);
  }

  /** Brings the cards whose work runs in `targetSessionId` up to date (its turns, approvals, delivery changed). */
  private refreshHandoffs(targetSessionId: string): void {
    for (const [requestId, h] of this.handoffs) {
      if (h.targetSessionId !== targetSessionId) continue;
      const now = this.handoffState(requestId);
      if (!now) continue;
      const data = { ...h.item.data, state: now.state, reply: now.reply ?? h.item.data.reply, error: now.error ?? null,
        endedAt: ['done', 'failed', 'interrupted'].includes(now.state) ? (h.item.data.endedAt ?? Date.now()) : null };
      if (JSON.stringify(data) === JSON.stringify(h.item.data)) continue;
      h.item = { ...h.item, data };
      this.putItems(h.sessionId, [h.item]);
      if (data.endedAt) {
        this.handoffs.delete(requestId);
        // A sender still waiting takes the outcome itself within moments; otherwise it gets the report.
        setTimeout(() => this.reportBack(requestId, h.sessionId, h.targetSessionId, now), REPORT_DELAY_MS);
      }
    }
  }

  /**
   * The work one agent handed another has ended and the sender did not wait for it: the report goes into the
   * sender's own conversation, as the owner typing it there would, so the sender carries on with it. It is a reply,
   * not a new hand-off: it keeps the sender's own place in the chain.
   */
  private reportBack(requestId: string, senderSessionId: string, targetSessionId: string, outcome: { state: string; reply?: string; error?: string | null }): void {
    if (this.store.handedBack(requestId) || !this.settings().agentLinks || !this.settings().autoReport) return;
    const sender = this.store.session(senderSessionId);
    const target = this.store.session(targetSessionId);
    const payload = this.store.requestPayload(requestId) as Command | undefined;
    if (!sender || sender.archived || !target || !payload?.origin) return;
    if (!this.store.markHandedBack(requestId)) return;
    const device = this.store.device(target.deviceId);
    const agent = (JSON.parse(device?.agents ?? '[]') as AgentInfo[]).find((a) => a.id === target.agentId);
    const label = `${device?.name ?? ''} · ${agent?.label ?? target.agentId}`;
    const asked = String(payload.text ?? '').replace(/^\[来自 [^\]]*\]\s*/, '').split('\n')[0]!.slice(0, 60);
    const how = outcome.state === 'done' ? '做完了' : outcome.state === 'interrupted' ? '被停止了，没有做完' : `没有做成（${outcome.error ?? '执行失败'}）`;
    let reply = (outcome.reply ?? '').trim();
    if (reply.length > REPORT_MAX) reply = reply.slice(0, REPORT_MAX) + `\n\n……（太长，后面省略了；完整内容用 AgentChat 的 read 查看，conversationId: ${target.id}）`;
    const text = `[来自 ${label}「${target.title.slice(0, 40)}」的汇报，经 AgentChat 转发] 你派的「${asked}」${how}。${reply ? `\n\n${reply}` : ''}`;
    const origin: Origin = { deviceId: target.deviceId, agentId: target.agentId, label, sessionId: target.id,
      depth: Math.max(0, (payload.origin.depth ?? 1) - 1) };
    // The files it made in that turn go along, to the sender's computer, as the owner's attachments would.
    const turnId = this.store.request(requestId)?.turnId;
    const files = turnId ? this.store.turnFiles(targetSessionId, turnId).slice(0, MAX_ATTACHMENTS) : [];
    const result = this.submit(senderSessionId, { requestId: randomUUID().replaceAll('-', ''), op: 'send', text, origin, ...(files.length ? { files } : {}) }, origin);
    if (typeof result === 'string') {
      // The owner sees it too: the sender is left without the outcome it is waiting for.
      log('hub', `report back to ${sender.title} failed: ${result}`);
      return activity(`${label} → ${sender.title}：汇报没能发回去（${result}），可以在手机上打开对方对话查看结果`, 'warn');
    }
    activity(`${label} → ${sender.title}：把汇报发回去了`);
  }

  /** Where a hand-off stands, as `wait` reports it, without waiting. */
  private handoffState(requestId: string): { state: string; reply?: string; error?: string | null } | null {
    const r = this.store.request(requestId);
    if (!r) return null;
    if (r.state === 'failed' || r.state === 'cancelled') return { state: 'failed', error: r.error };
    const status = r.turnId ? this.store.turnStatus(r.sessionId, r.turnId) : null;
    if (status && status !== 'inProgress') {
      return { state: status === 'completed' ? 'done' : status, reply: this.store.turnReply(r.sessionId, r.turnId!), error: this.store.turnError(r.sessionId, r.turnId!) };
    }
    if (this.store.waitingApprovals(r.sessionId, r.createdAt).length) return { state: 'waiting_approval' };
    return { state: r.state === 'queued' ? 'queued' : 'running' };
  }

  private putItems(sessionId: string, items: Item[]): void {
    const changed = this.store.upsertItems(sessionId, items);
    if (changed.length) this.broadcast({ t: 'items', sessionId, items: changed });
  }

  /** The latest of a conversation as the phone shows it: messages, commands run, files, what waits for the owner. */
  private askRead(args: Record<string, unknown>): unknown {
    const sessionId = this.findTarget(args);
    const session = this.store.session(sessionId)!;
    const count = Math.min(50, Math.max(1, Number(args.count ?? 10)));
    const cut = (s: unknown, n: number) => { const t = String(s ?? ''); return t.length > n ? t.slice(0, n) + '…' : t; };
    const items = this.store.itemsAfter(sessionId, 0, 400).filter((i) => i.kind !== 'status').slice(-count).map((i) =>
      i.kind === 'message' ? { type: i.data.role === 'user' ? 'sent' : 'reply', text: cut(i.data.text, 2000) }
        : i.kind === 'tool_call' ? { type: 'tool', tool: i.data.tool, what: cut(i.data.summary, 300), status: i.data.status }
          : i.kind === 'artifact' ? { type: 'file', name: i.data.name }
            : { type: 'approval', kind: i.data.kind, what: cut(i.data.command ?? i.data.reason, 300), state: i.data.state });
    return { conversationId: sessionId, title: session.title, running: session.running, items,
      note: session.hydrated ? undefined : '这个对话主电脑还没有完整同步过，内容可能不全' };
  }

  /** Stops the turn an agent's own task started. */
  private askStop(origin: Origin, args: Record<string, unknown>): unknown {
    const requestId = String(args.task ?? '');
    const request = this.store.request(requestId);
    const payload = request && (this.store.requestPayload(requestId) as Command);
    if (!request || payload?.origin?.deviceId !== origin.deviceId || payload.origin.agentId !== origin.agentId) throw new Error('没有这个任务');
    const result = this.submit(request.sessionId, { requestId: randomUUID().replaceAll('-', ''), op: 'interrupt' }, origin);
    if (typeof result === 'string') throw new Error(result);
    return { state: result.view.state === 'failed' ? 'failed' : 'stopping', error: result.view.error };
  }

  /** Waits (up to the minutes asked, at most 60) for the turn a task started to end; says where it stands. */
  private async askWait(origin: Origin, args: Record<string, unknown>): Promise<unknown> {
    const requestId = String(args.task ?? '');
    const request = this.store.request(requestId);
    const payload = request && (this.store.requestPayload(requestId) as Command);
    if (!request || payload?.origin?.deviceId !== origin.deviceId || payload.origin.agentId !== origin.agentId) throw new Error('没有这个任务');
    const minutes = Math.min(60, Math.max(0, Number(args.minutes ?? 10)));
    const until = Date.now() + minutes * 60_000;
    let quietSince = 0; // when an "interrupted" turn with nothing said was first seen
    for (;;) {
      const r = this.store.request(requestId)!;
      const status = r.turnId ? this.store.turnStatus(r.sessionId, r.turnId) : null;
      const waiting = this.store.waitingApprovals(r.sessionId, r.createdAt);
      if (r.state === 'failed' || r.state === 'cancelled') {
        this.store.markHandedBack(requestId);
        return { state: 'failed', error: r.error };
      }
      if (status && status !== 'inProgress') {
        const reply = this.store.turnReply(r.sessionId, r.turnId!);
        // An agent's own app running the turn can look interrupted from outside for a moment (Codex): give it time
        // to show its end before telling the sender there is no reply.
        const settled = status !== 'interrupted' || reply || (quietSince ||= Date.now()) < Date.now() - 45_000 || Date.now() >= until;
        if (settled) {
          this.store.markHandedBack(requestId); // the sender has it: no report into its conversation as well
          const error = status === 'failed' ? this.store.turnError(r.sessionId, r.turnId!) : null;
          return { state: status === 'completed' ? 'done' : status, reply, ...(error ? { error } : {}) };
        }
      } else {
        quietSince = 0;
      }
      if (waiting.length) return { state: 'waiting_approval', asks: waiting, note: '对方在等主人审批或回答，主人在手机上处理后再 wait' };
      if (Date.now() >= until) return { state: r.state === 'queued' ? 'queued' : 'running', note: '还没做完，稍后再用 wait 查' };
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }

  /** Sends a stored request to its device. */
  private forward(requestId: string, newState: RequestState | null): void {
    const request = this.store.request(requestId);
    const session = request && this.store.session(request.sessionId);
    const conn = session && this.devices.get(session.deviceId);
    if (!request || !session || !conn) return;
    const command = this.store.requestPayload(requestId) as Command;
    let data: string[] | undefined;
    try {
      data = command.files?.map((f) => readFileSync(this.store.artifact(f.sha256)!.path).toString('base64'));
    } catch {
      return this.updateRequest(requestId, 'failed', null, 'attachment_missing');
    }
    if (newState) this.updateRequest(requestId, newState);
    conn.send({ t: 'command', agentId: session.agentId, threadId: session.threadId, command, ...(data?.length ? { data } : {}) });
  }

  /** The final reply of a turn, shortened for a notification. */
  private lastReply(sessionId: string, turnId: string | null): string {
    const items = this.store.itemsAfter(sessionId, 0, 80).filter((i) => i.turnId === turnId && i.kind === 'message' && i.data.role === 'assistant');
    const text = String(items.at(-1)?.data.text ?? '完成了一轮');
    return text.length > 120 ? text.slice(0, 120) + '…' : text;
  }

  private updateRequest(requestId: string, state: RequestState, turnId: string | null = null, error: string | null = null): void {
    const before = this.store.request(requestId)?.state;
    const view = this.store.updateRequest(requestId, state, turnId, error);
    if (view) this.broadcast({ t: 'requests', requests: [view] });
    // A hand-off between agents that could not be delivered: the owner hears of it (as agreed, failures and approvals only).
    if (view && state === 'failed' && before !== 'failed') this.handoffFailed(view.sessionId, requestId, error ?? '没有送达');
    // The agent no longer waits for this answer (its program restarted, say): the card goes, instead of a button that
    // does nothing, and the owner hears why.
    if (view && view.op === 'approve' && error === 'approval_not_found') this.expireApproval(view.sessionId, requestId);
    if (view) this.refreshHandoffs(view.sessionId);
  }

  private expireApproval(sessionId: string, requestId: string): void {
    const approvalId = (this.store.requestPayload(requestId) as Command | undefined)?.approvalId;
    if (!approvalId) return;
    const item = this.store.itemsAfter(sessionId, 0, 400).find((i) => i.kind === 'approval_request' && i.data.approvalId === approvalId);
    if (!item || item.data.state !== 'pending') return;
    const { sessionId: _s, seq: _q, ...plain } = item;
    this.putItems(sessionId, [{ ...plain, data: { ...item.data, state: 'gone' } }]);
    activity(`一条审批已失效：${this.store.session(sessionId)?.title ?? '对话'}（电脑上的程序重启过，那一轮已经停了）`, 'warn');
  }

  /** Tells the owner a message one agent sent another failed (not sent, or the turn it started failed). */
  private handoffFailed(sessionId: string, requestId: string, why: string): void {
    const origin = (this.store.requestPayload(requestId) as Command | undefined)?.origin;
    if (!origin) return;
    const title = this.store.session(sessionId)?.title ?? '对话';
    this.notice({ type: 'agent', sessionId, title: 'Agent 之间的任务失败', text: `${origin.label} → ${title}：${why}` });
  }

  /** A computer has an agent the owner has not seen yet: say so on the phone, where it can be added as a friend. */
  private announceAgents(deviceName: string, added: AgentInfo[]): void {
    for (const a of added) {
      activity(`${deviceName} 发现了新的 Agent：${a.label}`);
      this.notice({ type: 'agent', sessionId: '', title: '发现新的 Agent', text: `${deviceName} 上发现了 ${a.label}，到「通讯录」的「新的朋友」里添加` });
    }
  }

  private broadcastDevices(): void {
    this.broadcast({ t: 'devices', devices: this.store.devices(new Set(this.devices.keys()), this.hubId) });
  }

  private broadcast(msg: HubToApp): void {
    const raw = JSON.stringify(msg);
    for (const ws of this.apps) if (ws.readyState === ws.OPEN) ws.send(raw);
  }

  private sendApp(ws: WebSocket, msg: HubToApp): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }
}
