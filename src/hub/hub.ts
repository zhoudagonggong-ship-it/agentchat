// The hub: serves the phone UI, keeps the shared record, and routes commands to devices.
// Listens on 127.0.0.1 only; `tailscale serve` publishes it to the tailnet with HTTPS.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { promisify } from 'node:util';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AgentInfo, AppToHub, Attachment, Command, DeviceToHub, DeviceView, HubRef, HubSettings, HubToApp, HubToDevice, Item, MemberSeed, Origin, RequestState, RequestView, SessionView } from '../shared/protocol.ts';
import { HUB_LOCAL_PORT, HUB_PORT, MAX_ATTACHMENTS, MAX_UPLOAD_BYTES, PROTOCOL_VERSION, markTag, requestText, sessionKey } from '../shared/protocol.ts';
import { log, parseJson, sha256 } from '../shared/util.ts';
import { activity } from '../activity.ts';
import { LocalTransport } from '../link.ts';
import { Store } from './store.ts';
import type { Ledger } from './ledger.ts';
import { Relay, isChannelTitle, returnedMarks } from './relay.ts';
import { Drive } from './drive.ts';
import { VoiceWords } from './voice-words.ts';
import { buildPackage } from '../update.ts';
import { fileSha256 } from '../handover.ts';
import { ReplicaSource } from './replica.ts';
import { lineOf, probe } from '../shift.ts';

const WEB_DIR = join(import.meta.dirname, '..', '..', 'web');
const APK = join(import.meta.dirname, '..', '..', 'build', 'android', 'AllinOne.apk');
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const TICK_MS = 30_000;
const MAX_TEXT = 20_000;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,80}$/;
const WINDOW_RESUME_MS = 3 * 3_600_000; // messages waiting for a window this long ago are taken up again on reconnect
/** Used a computer this recently (keyboard or mouse): the owner is taken to sit there. */
const PRESENT_MS = 3 * 60_000;
const VOICE_MAX_MS = 5 * 60_000; // a listening box left open longer than this is forgotten: the next press starts anew
const HANDOVER_WAIT_MS = 30 * 60_000; // how long the old hub waits for the new one to say it has all its data
const REPLICA_EVERY_MS = 2_000; // how often the record's changes go out to the other computers
const REPLICA_BATCH_BYTES = 4 * 1024 * 1024;
const FILES_EVERY_MS = 3 * 60_000; // how often a hub lacking files of its record asks the other computers for them
const CATCH_UP_MS = 15_000; // stepping down: how long the next hub gets to take in the last changes
/** A computer before this one in line, back and caught up for this long (and nothing running on either), takes the duty back. */
const RECLAIM_AFTER_MS = 5 * 60_000;
const run = promisify(execFile);

/** Changes whenever the page files change, so open phones know to reload. */
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
interface DeviceConn { send(msg: HubToDevice): void; close(): void; deviceId?: string; local: boolean; owner?: boolean; name?: string; code?: string; host?: string;
  /** Its copy of the record: which run and changeset it has, whether something is on its way to it, since when it is current. */
  rep?: { epoch: string; acked: number; busy: boolean; currentSince: number } }
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
  /** Where the owner was last active, by computer: from each tray's report of keyboard and mouse use. */
  private readonly presence = new Map<string, { activeAt: number; locked: boolean }>();
  private readonly earlyReceipts = new Map<string, { state: RequestState; turnId: string | null; error: string | null; at: number }>();
  private newVersion: string | null = null;
  /** Agents reaching each other (relay.ts). */
  private readonly relay: Relay;
  /** The owner asked (on the phone) to install the new release; the program around the hub does it. */
  onInstallUpdate: () => void = () => {};
  private readonly drive = new Drive();
  private readonly noticeWaiters = new Set<() => void>();

  private readonly dataDir: string;
  /** The record's changes, for the other computers' copies (replica.ts). */
  private readonly replica: ReplicaSource;
  /** This hub's time on duty (shift.ts): kept in the record, one more each time another computer takes over. */
  readonly term: number;
  /** Handing the duty on: the computers' messages are left unanswered, so they keep them for the next hub. */
  private leaving = false;

  /** `term`: taking over from a copy of the record, as this term. */
  constructor(dataDir: string, hubId: string, hubName: string, hubDns: string, ownerLogin: string, seeds: MemberSeed[] = [], term?: number) {
    this.dataDir = dataDir;
    this.store = new Store(dataDir);
    this.hubId = hubId;
    this.hubName = hubName;
    this.hubDns = hubDns;
    this.ownerLogin = ownerLogin;
    if (term) {
      this.store.setSetting('term', String(term));
      this.store.skipSeq(1_000_000);
    }
    this.term = Number(this.store.setting('term')) || 1;
    this.replica = new ReplicaSource(this.store.db, dataDir);
    if (seeds.length) this.store.seedMembers(seeds);
    this.relay = new Relay({ store: this.store, hubId, devices: this.devices, settings: () => this.settings(),
      submit: (...a) => this.submit(...a), putItems: (s, i) => this.putItems(s, i), notice: (n) => this.notice(n),
      resend: (id, attempt) => this.forward(id, null, attempt), fail: (id, error) => this.updateRequest(id, 'failed', null, error) });
    this.voiceWords = new VoiceWords(this.store, () => this.store.devices(new Set(this.devices.keys()), this.hubId)
      .flatMap((d) => [d.name, ...d.agents.map((a) => a.label)]).concat([...this.devices.values()].map((c) => c.host ?? '')).filter(Boolean));
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
        const sha256 = await fileSha256(zip);
        const fetched = new Promise<boolean>((resolve) => {
          this.handover = { token, zip, sha256, done: resolve };
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

  private handover: { token: string; zip: string; sha256: string; done: (ok: boolean) => void } | null = null;

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

  /**
   * The zip for the new hub, from where its download got to (an HTTP Range), with its sha256 to check it by. Only the
   * new hub saying it has it all (`done=1`) ends the handover: data written out here may still be on its way, and
   * stepping down then would cut it off.
   */
  private serveHandover(url: URL, req: IncomingMessage, res: ServerResponse): void {
    const h = this.handover;
    if (!h || url.searchParams.get('token') !== h.token || !existsSync(h.zip)) return void res.writeHead(404).end();
    if (url.searchParams.get('done') === '1') {
      log('handover', 'the new hub has all the data');
      h.done(true);
      return void res.writeHead(200).end('ok');
    }
    const size = statSync(h.zip).size;
    const from = Number(/^bytes=(\d+)-$/.exec(String(req.headers.range ?? ''))?.[1] ?? 0);
    if (from >= size && from > 0) return void res.writeHead(416, { 'Content-Range': `bytes */${size}`, 'X-Sha256': h.sha256 }).end();
    log('handover', `new hub ${from ? `resumed the download at ${(from / 1048576).toFixed(1)}` : 'started the download'} (${(size / 1048576).toFixed(1)} MB)`);
    res.writeHead(from ? 206 : 200, { 'Content-Type': 'application/zip', 'Content-Length': size - from, 'X-Sha256': h.sha256,
      ...(from ? { 'Content-Range': `bytes ${from}-${size - 1}/${size}` } : {}) });
    const stream = createReadStream(h.zip, { start: from });
    res.on('close', () => { if (!res.writableFinished) log('handover', `download broke off after ${((from + stream.bytesRead) / 1048576).toFixed(1)} MB`); });
    stream.pipe(res);
  }

  start(): void {
    this.resume();
    this.listen();
  }

  /** Picks up where the hub left off when it last stopped (kept apart from listening, so a test can restart a hub). */
  resume(): void {
    // The conversation list goes by latest messages: times kept from before that are caught up once.
    const moved = this.store.catchUpTimes();
    if (moved) log('hub', `${moved} conversations moved on to their latest message`);
    this.relay.resume();
    setInterval(() => this.relay.watch(), 60_000);
    setInterval(() => {
      if (this.leaving) return;
      this.replica.flush();
      for (const conn of this.devices.values()) this.feed(conn);
    }, REPLICA_EVERY_MS);
    setTimeout(() => this.askFiles(), 30_000); // the computers have connected again by then
    setInterval(() => this.askFiles(), FILES_EVERY_MS);
  }

  /**
   * Files the record names that are not here (this hub took over before its copy had them all): asked of the other
   * computers, which send the ones they keep (the old hub has them all).
   */
  private askFiles(): void {
    if (this.leaving) return;
    const have = new Set(readdirSync(this.store.artifactDir));
    const missing = (this.store.db.prepare('SELECT sha256 FROM artifacts').all() as { sha256: string }[]).map((r) => r.sha256).filter((s) => !have.has(s));
    if (!missing.length) return;
    log('replica', `${missing.length} files named in the record are not here; asking the other computers`);
    for (const conn of this.devices.values()) if (!conn.local) conn.send({ t: 'wantFiles', sha256: missing.slice(0, 1000) });
  }

  // ---------- shifts: the other computers' copies, and handing the duty on (shift.ts) ----------

  /** Sends a computer what its copy lacks: the changesets after it, or, too far behind, where to take a whole copy. */
  private feed(conn: DeviceConn): void {
    const rep = conn.rep;
    if (!rep || rep.busy || conn.local) return;
    if (rep.epoch === this.replica.epoch) {
      const next = this.replica.after(rep.acked);
      if (next && !next.length) {
        rep.currentSince ||= Date.now();
        return;
      }
      if (next) {
        const data: string[] = [];
        let bytes = 0;
        for (const c of next) {
          if (data.length && bytes + c.data.length > REPLICA_BATCH_BYTES) break;
          data.push(c.data.toString('base64'));
          bytes += c.data.length;
        }
        rep.busy = true;
        return conn.send({ t: 'replica', epoch: this.replica.epoch, n: rep.acked + 1, data });
      }
    }
    rep.busy = true;
    rep.currentSince = 0;
    this.replica.snapshot().then(
      (s) => conn.send({ t: 'replicaSnapshot', epoch: this.replica.epoch, n: s.n, url: `https://${this.hubDns}:${HUB_PORT}/api/replica?token=${s.token}` }),
      (e: Error) => {
        log('replica', `snapshot failed: ${e.message}`);
        rep.busy = false;
      });
  }

  private onReplicaAt(conn: DeviceConn, msg: Extract<DeviceToHub, { t: 'replicaAt' }>): void {
    const rep = (conn.rep ??= { epoch: '', acked: 0, busy: false, currentSince: 0 });
    if (msg.epoch !== this.replica.epoch || msg.n < this.replica.head - 2) rep.currentSince = 0;
    rep.epoch = msg.epoch;
    rep.acked = msg.n;
    rep.busy = false;
    if (!this.leaving) this.feed(conn);
  }

  /** The line, in order, as the computers reach each other. */
  line(): HubRef[] {
    const members = this.members().filter((d) => d.approved);
    const kept = parseJson<string[]>(this.store.setting('line') ?? '[]') ?? [];
    const suffix = this.hubDns.slice(this.hubDns.indexOf('.'));
    return lineOf(Array.isArray(kept) ? kept : [], members, this.hubId).map((id) => id === this.hubId
      ? { stableId: id, dnsName: this.hubDns, name: this.hubName }
      : { stableId: id, dnsName: (this.store.device(id)?.name ?? id) + suffix, name: this.store.device(id)?.name ?? id });
  }

  private tellShift(): void {
    const msg: HubToDevice = { t: 'shift', term: this.term, line: this.line() };
    for (const conn of this.devices.values()) conn.send(msg);
  }

  /** A computer whose copy is current, ready to take over now: the earliest in line (`only`: that one or none). */
  private successor(only?: string): HubRef | null {
    for (const ref of this.line()) {
      if (ref.stableId === this.hubId || (only && ref.stableId !== only)) continue;
      const rep = this.devices.get(ref.stableId)?.rep;
      if (rep && rep.epoch === this.replica.epoch && rep.acked >= this.replica.head - 2) return ref;
    }
    return null;
  }

  /**
   * A computer before this one in line has been back and current for a while: the duty goes back to it (the program
   * around the hub checks nothing runs here, as this computer restarts; the other one takes over without restarting).
   */
  reclaimTarget(): HubRef | null {
    const line = this.line();
    const why: string[] = [];
    for (const ref of line) {
      if (ref.stableId === this.hubId) break;
      const rep = this.devices.get(ref.stableId)?.rep;
      if (rep?.currentSince && Date.now() - rep.currentSince > RECLAIM_AFTER_MS && rep.epoch === this.replica.epoch) return ref;
      why.push(`${ref.name}: ${!rep ? 'not here' : rep.epoch !== this.replica.epoch ? 'copy of another run' : !rep.currentSince ? 'copy behind'
        : `current for ${Math.round((Date.now() - rep.currentSince) / 1000)} s`}`);
    }
    const said = why.join('; ');
    if (said && said.replace(/\d+ s/g, '') !== this.reclaimSaid) log('shift', `the duty stays here for now (${said})`);
    this.reclaimSaid = said.replace(/\d+ s/g, '');
    return null;
  }
  private reclaimSaid = '';

  /**
   * Hands the duty on (an update, shutting down, the duty going back, the owner's choice): to `to`, or the earliest in
   * line whose copy is current. From now on the computers' messages wait with them for the next hub; it takes in the
   * last changes, takes over as the next term, and everyone follows. Returns the next hub, or null when no computer
   * could take over (the duty stays here).
   */
  async stepDown(to?: string): Promise<HubRef | null> {
    const next = this.successor(to);
    if (!next) return null;
    const conn = this.devices.get(next.stableId)!;
    this.leaving = true;
    activity(`正在把主电脑的工作交给「${next.name}」`);
    // Its copy gets the last changes first.
    const until = Date.now() + CATCH_UP_MS;
    this.replica.flush();
    const head = this.replica.head;
    while (Date.now() < until && conn.rep && conn.rep.acked < head) {
      const rep = conn.rep;
      if (!rep.busy && rep.epoch === this.replica.epoch) {
        const next = this.replica.after(rep.acked) ?? [];
        if (next.length) {
          rep.busy = true;
          conn.send({ t: 'replica', epoch: this.replica.epoch, n: rep.acked + 1, data: next.map((c) => c.data.toString('base64')) });
        }
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    if ((conn.rep?.acked ?? 0) < head) log('shift', `${next.name} took over without the last ${head - (conn.rep?.acked ?? 0)} changesets`);
    const term = this.term + 1;
    conn.send({ t: 'hubMoved', hub: next, term, promote: true });
    // The others (and the phones) go over once it is there to take them.
    for (let i = 0; i < 30; i++) {
      const p = await probe(next.dnsName);
      if (p?.hub && p.term >= term) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    for (const [id, c] of this.devices) if (id !== next.stableId) c.send({ t: 'hubMoved', hub: next, term });
    this.broadcast({ t: 'hubMoved', url: `https://${next.dnsName}:${HUB_PORT}/` });
    activity(`主电脑的工作已交给「${next.name}」`);
    return next;
  }

  private get ledger(): Ledger {
    return this.store.ledger;
  }

  private listen(): void {
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
    if (this.drive.handle(req, url, res)) return;
    if (req.method !== 'GET') return void res.writeHead(405).end();
    if (url.pathname === '/api/info') {
      // Lets other computers find out which machine is the hub.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return void res.end(JSON.stringify({ app: 'allinone', hub: true, stableId: this.hubId, name: this.hubName, v: PROTOCOL_VERSION,
        url: `https://${this.hubDns}:${HUB_PORT}/`, members: this.memberHosts(), term: this.term }));
    }
    if (url.pathname === '/api/replica') return void this.replica.serve(url, req, res);
    if (url.pathname === '/api/pair') {
      const code = url.searchParams.get('code') ?? '';
      const expires = this.pairCodes.get(code);
      this.pairCodes.delete(code);
      if (!expires || expires < Date.now()) return void res.writeHead(410, { 'Content-Type': 'application/json' }).end('{"error":"二维码已失效，请在电脑上重新生成"}');
      activity('手机已完成配对');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return void res.end(JSON.stringify({ url: `https://${this.hubDns}:${HUB_PORT}/`, members: this.memberHosts() }));
    }
    if (url.pathname === '/api/handover') return void this.serveHandover(url, req, res);
    if (url.pathname === '/api/notify') return void this.serveNotices(Number(url.searchParams.get('after')) || 0, res);
    if (url.pathname.startsWith('/files/')) return void this.serveArtifact(url.pathname.slice(7), req, res);
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

  /** A file by its hash; a part of it when asked (a video player jumping ahead asks for the rest from there). */
  private serveArtifact(sha: string, req: IncomingMessage, res: ServerResponse): void {
    const art = /^[0-9a-f]{64}$/.test(sha) ? this.store.artifact(sha) : undefined;
    if (!art || !existsSync(art.path)) return void res.writeHead(404).end();
    const size = statSync(art.path).size;
    const head = { 'Content-Type': art.mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=31536000, immutable',
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(art.name)}` };
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start >= size || start > end) return void res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
      res.writeHead(206, { ...head, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${size}` });
      return void createReadStream(art.path, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...head, 'Content-Length': size });
    createReadStream(art.path).pipe(res);
  }

  // ---------- devices ----------

  /** The hub machine's own device, connected in-process. */
  connectLocalDevice(): LocalTransport {
    const conn: DeviceConn = { local: true, send: (msg) => transport.deliver(msg), close: () => {} };
    const transport = new LocalTransport((msg) => this.onDevice(conn, msg));
    return transport;
  }

  /** A computer connected over its WebSocket (public for the simulator, which links computers without a network). */
  attachRemoteDevice(ws: WebSocket, owner: boolean): void {
    let alive = true;
    const opened = Date.now();
    // Who ended it, for the log: no answer to our ping, a newer connection from the same computer, or the other side.
    let why = '';
    const conn: DeviceConn = { local: false, owner, send: (msg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg)),
      close: () => ((why ||= 'a newer connection from the same computer took its place'), ws.close()) };
    ws.on('pong', () => (alive = true));
    const ping = setInterval(() => {
      if (!alive) {
        why ||= `no answer to the hub's ping in ${TICK_MS / 1000} s`;
        return void ws.terminate();
      }
      alive = false;
      ws.ping();
    }, TICK_MS);
    ws.on('message', (raw) => {
      const msg = parseJson<DeviceToHub>(String(raw));
      if (msg) this.onDevice(conn, msg);
    });
    ws.on('close', (code: number) => {
      clearInterval(ping);
      if (conn.name) log('hub', `${conn.name} disconnected after ${Math.round((Date.now() - opened) / 1000)} s: ${why || `closed by the computer or the network (code ${code})`}`);
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
    // Every computer learns the line (one new to it changes the line for all).
    this.tellShift();
    for (const s of this.store.hydratedSessions(deviceId)) conn.send({ t: 'hydrate', ...s });
    for (const r of this.ledger.queued(deviceId)) this.forward(r.requestId, 'pending');
    // Messages it was holding for a window to come free: a restart over there dropped the wait, so they go again
    // (one already in goes in only once: the computer looks in the conversation first).
    for (const r of this.ledger.unsent(deviceId, Date.now() - WINDOW_RESUME_MS)) this.forward(r.requestId, null);
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
    if (msg.t === 'replicaAt') return this.onReplicaAt(conn, msg);
    if (this.leaving) return; // unanswered, so the computer keeps it for the next hub
    this.store.touchDevice(deviceId);
    switch (msg.t) {
      case 'ask':
        void this.relay.onAsk(conn, deviceId, msg);
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
      case 'voice':
        this.onVoice(deviceId, msg);
        break;
      case 'created':
        this.relay.created(msg);
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
        // A conversation's latest line comes for every conversation, followed in full or not: one that got a message
        // meant for another and sent it back says so there.
        for (const s of changed) for (const mark of returnedMarks(s.preview)) this.relay.returned(s.id, mark);
        break;
      }
      case 'items': {
        const id = sessionKey(deviceId, msg.agentId, msg.threadId);
        const changed = this.store.upsertItems(id, msg.items);
        conn.send({ t: 'ack', oid: msg.oid });
        if (changed.length) this.broadcast({ t: 'items', sessionId: id, items: changed });
        this.touchFrom(id, changed);
        for (const item of changed) {
          if (item.kind === 'message' && item.data.role === 'assistant') for (const mark of returnedMarks(item.data.text)) this.relay.returned(id, mark);
          if (item.kind === 'message' && item.data.role === 'user') {
            // Our request id when we started the turn; else the tag in a forwarded message's mark; else (the owner's
            // messages queued through Codex, which assigns its own id) match by text.
            const clientId = typeof item.data.clientId === 'string' ? item.data.clientId : '';
            const said = String(item.data.text ?? '').trim();
            const tag = markTag(said);
            const match = this.ledger.get(clientId) ?? (tag ? this.ledger.byTag(id, tag) : this.ledger.pendingByText(id, said));
            // Once there, a message stays delivered. Which turn takes it up follows the agent's latest word: a message
            // shown waiting before a turn took it, or a turn the adapter now reads as reaching further back.
            if (match) {
              if (match.state !== 'delivered') this.updateRequest(match.requestId, 'delivered', item.turnId);
              else if (item.turnId && item.turnId !== match.turnId) this.ledger.setTurn(match.requestId, item.turnId);
            } else if (!tag && !/^\s*\[AgentChat /.test(said)) {
              this.voiceWords.sent(deviceId, said); // typed in the window over there, maybe a recognition the owner corrected first
              this.store.cared(id);
            }
          }
          const title = this.store.session(id)?.title ?? '对话';
          // Agents passing work to each other finish turns all the time: the owner hears of turns answering their own
          // messages only (the others show quietly in the list).
          const done = item.kind === 'status' && item.data.status === 'completed' && typeof item.data.completedAt === 'number'
            && Date.now() / 1000 - item.data.completedAt < 120 && !isChannelTitle(title) && !this.store.fromAgent(id, item.turnId);
          if (done) {
            activity(`${this.store.device(deviceId)?.name} · ${title}：完成了一轮`);
            // 消息免打扰 (the conversation or its agent): no notice. Approvals still come: the agent waits for an answer.
            if (!this.store.isMuted(id)) this.notice({ type: 'done', sessionId: id, title, text: this.lastReply(id, item.turnId) });
          }
          if (item.kind === 'status' && item.data.status === 'failed' && item.turnId && typeof item.data.completedAt === 'number'
            && Date.now() / 1000 - item.data.completedAt < 120) {
            const requestId = this.ledger.forTurn(id, item.turnId);
            if (requestId) this.relay.handoffFailed(id, requestId, String(item.data.error ?? '这一轮执行失败'));
          }
          if (item.kind === 'approval_request' && item.data.state === 'pending') {
            this.notice({ type: 'approval', sessionId: id, title, text: String(item.data.command ?? item.data.reason ?? '需要你确认') });
          }
        }
        // After the messages were matched to their requests: a turn's end in the same batch then counts for them.
        if (changed.length) this.relay.refreshHandoffs(id);
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
      case 'landed':
        conn.send({ t: 'ack', oid: msg.oid });
        this.relay.landed(deviceId, msg);
        break;
      case 'receipt':
        if (!this.ledger.get(msg.requestId)) {
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
    conn.host = typeof msg.host === 'string' ? msg.host : undefined;
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
    if (this.leaving && msg.t !== 'hello') return this.sendApp(ws, { t: 'error', message: '主电脑正在交接工作，过几秒再试' });
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
        this.sendApp(ws, { t: 'requests', requests: this.ledger.after(after, 86_400_000) });
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
        if (msg.settings && 'voiceMic' in msg.settings) {
          // Only a computer that belongs here; null lets each computer listen with its own microphone.
          const id = msg.settings.voiceMic;
          if (id === null || (typeof id === 'string' && this.store.device(id)?.approved)) {
            this.store.setSetting('voiceMic', id ?? '');
            activity(id ? `语音输入用「${this.store.device(id)?.name}」的麦克风` : '语音输入用各台电脑自己的麦克风');
          }
        }
        if (Array.isArray(msg.settings?.line)) {
          const known = new Set(this.members().filter((d) => d.approved).map((d) => d.id));
          const line = msg.settings.line.filter((id): id is string => typeof id === 'string' && known.has(id));
          this.store.setSetting('line', JSON.stringify(line));
          activity(`接班顺序：${this.line().map((r) => r.name).join(' → ')}`);
          this.tellShift();
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
        const changed = msg.t === 'read' ? this.store.markRead(id, Number(msg.replies), Number(msg.quiet ?? 0))
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
    if (typeof result === 'string') return this.sendApp(ws, { t: 'error', message: result });
    if (!result.created) return this.sendApp(ws, { t: 'requests', requests: [result.view] });
    // The owner wrote to it: the conversation comes up the list, as the owner's own.
    if (command.op === 'send') {
      this.store.cared(sessionId);
      const s = this.store.session(sessionId);
      if (s) {
        const { hydrated: _h, archived: _a, ...view } = s;
        this.broadcast({ t: 'sessions', sessions: [view], archived: [], seq: this.store.currentSeq });
      }
    }
  }

  /**
   * Takes a request into a conversation, from the phone or (with `origin`) from an agent, and passes it on.
   * Returns why it was refused, as the owner reads it.
   */
  /** `delivered`: the device already has it (a conversation started with this message): recorded, not forwarded. */
  /** `handoffFrom`: work one agent hands another, from this conversation of the sender's: its outcome is owed back there. */
  private submit(sessionId: string, command: Command, origin?: Origin, delivered = false, handoffFrom?: string): string | { view: RequestView; created: boolean } {
    const session = this.store.session(sessionId);
    const fail = (message: string) => message;
    if (!session || session.archived) return fail('对话不存在');
    if (!command || typeof command.requestId !== 'string' || !REQUEST_ID.test(command.requestId)) return fail('请求编号无效');
    if (command.op === 'cancel') {
      const target = this.ledger.get(command.requestId);
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
    const { view, created } = this.ledger.create(command.requestId, sessionId, command.op, clean,
      command.op === 'send' ? requestText(text, files) : null, state, handoffFrom);
    if (!created) return { view, created };
    if (state === 'failed') this.ledger.update(view.requestId, 'failed', null, 'device_offline');
    this.broadcast({ t: 'requests', requests: [this.ledger.get(view.requestId)!] });
    // Sent now: the conversation goes to the top at once, before the computer shows the message.
    if (command.op === 'send') this.touchNow(sessionId, Date.now());
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
    return { view: this.ledger.get(view.requestId)!, created };
  }

  // ---------- agents using the AgentChat tool ----------

  private settings(): HubSettings {
    return { agentLinks: this.store.setting('agentLinks') !== '0', autoReport: this.store.setting('autoReport') !== '0',
      followMe: this.store.setting('followMe') !== '0', voiceMic: this.store.setting('voiceMic') || null,
      ...(this.newVersion ? { newVersion: this.newVersion } : {}), line: this.line().map((r) => r.stableId) };
  }

  // ---------- voice input ----------

  /**
   * Who listens now (the microphone computer), for which computer, and which one has the hotkey held down, while the
   * owner speaks.
   */
  private voice: { mic: string; target: string; key: string; at: number } | null = null;
  private voiceWords: VoiceWords;

  /**
   * The owner holds Win+Alt+Space somewhere while speaking, or the microphone computer heard something. The computer
   * that got the key press is the one spoken to: a remote-desktop window passes the keys on to it. When the microphone
   * computer gets it itself while a remote-desktop window is in front (the window kept the keys), its title names the
   * computer. The box saying how it goes shows on the computer spoken to: that is where the owner looks.
   */
  private onVoice(deviceId: string, msg: Extract<DeviceToHub, { t: 'voice' }>): void {
    const tell = (id: string, text: string) => this.devices.get(id)?.send({ t: 'alert', title: '语音输入', text, url: '' });
    const live = this.voice && Date.now() - this.voice.at < VOICE_MAX_MS ? this.voice : null;
    if (msg.op === 'key') {
      // Pressed while still listening (the letting go got lost): stop and send what there is.
      if (live) return void this.devices.get(live.mic)?.send({ t: 'voice', op: 'finish' });
      const mic = this.settings().voiceMic || deviceId;
      let target = deviceId;
      if (deviceId === mic && /awesun|sunlogin|向日葵/i.test(`${msg.fgProc} ${msg.fgTitle}`)) {
        const found = this.deviceInTitle(String(msg.fgTitle ?? ''));
        if (!found) return tell(mic, `认不出这个远程窗口连的是哪台电脑：「${String(msg.fgTitle ?? '').slice(0, 60)}」`);
        target = found;
      }
      if (!this.devices.has(mic)) return tell(deviceId, '麦克风那台电脑现在不在线');
      this.voice = { mic, target, key: deviceId, at: Date.now() };
      const context = this.voiceWords.context(target);
      this.devices.get(mic)!.send({ t: 'voice', op: 'listen', context });
      log('voice', `context: ${context.length} chars, ${context.split('\n')[0].slice(0, 300)}`);
      this.devices.get(target)?.send({ t: 'voice', op: 'show', text: '正在听…  说完松开 Win+Alt+空格', tone: 'ok' });
      log('voice', `${this.store.device(deviceId)?.name} pressed; ${this.store.device(mic)?.name} listens for ${this.store.device(target)?.name}`);
      return;
    }
    if (msg.op === 'release') {
      if (live?.key === deviceId) this.devices.get(live.mic)?.send({ t: 'voice', op: 'finish' });
      return;
    }
    if (!this.voice || this.voice.mic !== deviceId) return;
    if (msg.op === 'status') return void this.devices.get(this.voice.target)?.send({ t: 'voice', op: 'show', text: msg.text, tone: msg.tone, done: msg.done });
    const target = this.voice.target;
    this.voice = null;
    if (msg.op === 'text' && msg.text) {
      if (!this.devices.has(target)) return tell(deviceId, '要输入的那台电脑断开了，文字没有送过去');
      this.devices.get(target)!.send({ t: 'voice', op: 'paste', text: msg.text });
      this.voiceWords.pasted(target, msg.text);
    }
  }

  /** The member computer a window title names: by its name here or its Windows computer name, the longest match. */
  private deviceInTitle(title: string): string | null {
    const t = title.toLowerCase();
    let best: { id: string; len: number } | null = null;
    for (const [id, conn] of this.devices) {
      for (const name of [this.store.device(id)?.name, conn.host]) {
        const n = name?.toLowerCase();
        if (n && n.length >= 3 && t.includes(n) && n.length > (best?.len ?? 0)) best = { id, len: n.length };
      }
    }
    return best?.id ?? null;
  }

  /** A newer release is out: phones show it in settings (and hear of it once), where the owner can update. */
  offerVersion(version: string): void {
    if (this.newVersion === version) return;
    this.newVersion = version;
    this.broadcast({ t: 'settings', settings: this.settings() });
    this.notice({ type: 'agent', sessionId: '', title: 'AgentChat 有新版本', text: `新版本 ${version} 已发布，打开 App 的「设置」就能更新` });
  }

  // ---------- hand-off cards ----------

  private putItems(sessionId: string, items: Item[]): void {
    const changed = this.store.upsertItems(sessionId, items);
    if (changed.length) this.broadcast({ t: 'items', sessionId, items: changed });
    this.touchFrom(sessionId, changed);
  }

  /**
   * The conversation list goes by each conversation's latest message, as in a chat app: a message (anyone's) or a
   * file in it moves the conversation up, whatever time the agent itself reports for it.
   */
  private touchFrom(sessionId: string, items: Item[]): void {
    const latest = Math.max(0, ...items.filter((i) => i.kind === 'message' || i.kind === 'artifact' || i.kind === 'handoff').map((i) => i.ts));
    this.touchNow(sessionId, latest);
  }

  private touchNow(sessionId: string, ms: number): void {
    const view = ms ? this.store.touch(sessionId, Math.min(ms, Date.now())) : undefined;
    if (view) this.broadcast({ t: 'sessions', sessions: [view], archived: [], seq: this.store.currentSeq });
  }

  /** Sends a stored request to its device (`attempt`: once more, see relay.ts). */
  private forward(requestId: string, newState: RequestState | null, attempt = 0): void {
    const request = this.ledger.get(requestId);
    const session = request && this.store.session(request.sessionId);
    const conn = session && this.devices.get(session.deviceId);
    if (!request || !session || !conn) return;
    const command = { ...this.ledger.payload(requestId)!, ...(attempt ? { attempt } : {}) };
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
    const before = this.ledger.get(requestId)?.state;
    const view = this.ledger.update(requestId, state, turnId, error);
    if (view) this.broadcast({ t: 'requests', requests: [view] });
    // A hand-off between agents that could not be delivered: the owner hears of it (as agreed, failures and approvals only).
    if (view && state === 'failed' && before !== 'failed') this.relay.handoffFailed(view.sessionId, requestId, error ?? '没有送达');
    // The agent no longer waits for this answer (its program restarted, say): the card goes, instead of a button that
    // does nothing, and the owner hears why.
    if (view && view.op === 'approve' && error === 'approval_not_found') this.expireApproval(view.sessionId, requestId);
    if (view) this.relay.refreshHandoffs(view.sessionId);
  }

  private expireApproval(sessionId: string, requestId: string): void {
    const approvalId = (this.ledger.payload(requestId) as Command | undefined)?.approvalId;
    if (!approvalId) return;
    const item = this.store.itemsAfter(sessionId, 0, 400).find((i) => i.kind === 'approval_request' && i.data.approvalId === approvalId);
    if (!item || item.data.state !== 'pending') return;
    const { sessionId: _s, seq: _q, ...plain } = item;
    this.putItems(sessionId, [{ ...plain, data: { ...item.data, state: 'gone' } }]);
    activity(`一条审批已失效：${this.store.session(sessionId)?.title ?? '对话'}（电脑上的程序重启过，那一轮已经停了）`, 'warn');
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
