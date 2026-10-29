// The device side: connects local agents to the hub. Runs on every machine, including the hub itself.
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { AgentInfo, AskOp, Attachment, Command, DeviceToHub, HubRef, HubToDevice, Item, MemberSeed, ProjectInfo, RequestState, SessionInfo } from '../shared/protocol.ts';
import { PROTOCOL_VERSION } from '../shared/protocol.ts';
import { log, sha256 } from '../shared/util.ts';
import { activity } from '../activity.ts';
import type { Transport } from '../link.ts';

const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;
/** At most this much of the outbox on the way, unacknowledged, at a time. */
const OUTBOX_WINDOW = 8 * 1024 * 1024;
const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json', '.csv': 'text/csv; charset=utf-8', '.html': 'text/html; charset=utf-8', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg' };

/** What an agent adapter reports to the device. */
export interface AdapterSink {
  sessions(sessions: SessionInfo[], complete: boolean): void;
  projects(projects: ProjectInfo[]): void;
  items(threadId: string, items: Item[]): void;
  artifact(threadId: string, itemId: string, turnId: string | null, path: string): void;
  /** A file held in memory (e.g. a picture pasted into a prompt); `sent`: it came from the owner, not the agent. */
  artifactData(threadId: string, itemId: string, turnId: string | null, name: string, mime: string, data: Buffer, sent?: boolean): void;
  delta(threadId: string, itemId: string, turnId: string, text: string): void;
  receipt(requestId: string, state: RequestState, turnId?: string, error?: string): void;
}

export interface Adapter {
  readonly info: AgentInfo;
  start(sink: AdapterSink): Promise<void>;
  /** The hub wants this conversation's history and live updates. */
  hydrate(threadId: string): void;
  command(threadId: string, command: Command): Promise<void>;
  /**
   * Starts a new conversation named `title` in `cwd` (empty: the agent's default) and reports it; returns its id.
   * An agent whose conversations only come into being with a message (Goose's window, Claude Code) starts it with
   * `first` and says so (`sent`), receipts and all; the others leave `first` to be sent as usual.
   */
  create?(cwd: string, title: string, first?: Command): Promise<{ threadId: string; sent?: boolean }>;
  /** The conversation calling the AllinOne tool right now, when the agent's tools are not told (Codex). */
  callerThread?(): string | null;
  /** Work of ours under way here (a turn we run, an approval waiting): restarting this program now would cut it off. */
  busy?(): boolean;
  /** A cheap look for changes the agent's files did not announce (every hub tick, 30 s); most adapters need none. */
  poll?(): void;
}

type Outgoing = Extract<DeviceToHub, { oid: number }>;
type OutgoingBody = Outgoing extends infer M ? (M extends Outgoing ? Omit<M, 'oid'> : never) : never;

export type LinkStatus = 'connecting' | 'pending' | 'joined' | 'rejected';

export class Device {
  status: LinkStatus = 'connecting';
  statusDetail = '';
  onStatus: () => void = () => {};
  onHubMoved: (hub: HubRef, members?: MemberSeed[], handover?: string) => void = () => {};
  /** The program's fingerprint, sent with hello; null: this copy does not take updates. */
  code: string | null = null;
  onUpdate: (version: string, data: Buffer) => void = () => {};
  onJoined: () => void = () => {};
  /** The hub's keep-alive (every 30 s): a free clock for rare chores. */
  onTick: () => void = () => {};
  /** A reminder for the owner, who sits at this computer (the tray shows it). */
  onAlert: (alert: { title: string; text: string; url: string }) => void = () => {};

  /** Whether an agent here is in the middle of something this program carries (see Adapter.busy). */
  busy(): boolean {
    // An agent here waiting on the hub (a long `wait` for another agent's reply) would lose it too.
    if (this.asks.size) return true;
    return [...this.adapters.values()].some((a) => {
      try {
        return a.busy?.() ?? false;
      } catch {
        return false;
      }
    });
  }

  /** Whether the owner is at this computer, as the tray sees it: reported to the hub, which sends reminders here then. */
  presence(idleMs: number, locked: boolean): void {
    if (this.active) this.transport.send({ t: 'presence', idleMs, locked });
  }
  private readonly db: DatabaseSync;
  private readonly adapters = new Map<string, Adapter>();
  private readonly lastSessions = new Map<string, SessionInfo[]>();
  private readonly lastProjects = new Map<string, ProjectInfo[]>();
  private active = false;
  private readonly inflight = new Map<number, number>(); // outbox rows sent on this connection, not acknowledged yet: oid -> bytes
  private sentUpTo = 0;
  private started = false;
  private readonly asks = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  private askSeq = 0;
  private readonly id: string;
  private readonly name: string;
  private readonly secret: string;
  private readonly transport: Transport;
  private readonly inbox: string;

  constructor(dataDir: string, id: string, name: string, secret: string, transport: Transport) {
    this.id = id;
    this.name = name;
    this.secret = secret;
    this.transport = transport;
    this.inbox = join(dataDir, 'inbox');
    this.db = new DatabaseSync(join(dataDir, 'device.sqlite'));
    this.db.exec(`PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS outbox (oid INTEGER PRIMARY KEY AUTOINCREMENT, msg TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts (request_id TEXT PRIMARY KEY, state TEXT NOT NULL, turn_id TEXT, error TEXT, at INTEGER NOT NULL);`);
  }

  /** An agent found later, while running, starts at once and the hub hears of it. */
  add(adapter: Adapter): void {
    if (this.adapters.has(adapter.info.id)) return;
    this.adapters.set(adapter.info.id, adapter);
    if (!this.started) return;
    void this.startAdapter(adapter, 15_000);
    if (this.active) this.transport.send({ t: 'agents', agents: this.agents });
  }

  adapter(id: string): Adapter | undefined {
    return this.adapters.get(id);
  }

  get agents(): AgentInfo[] {
    return [...this.adapters.values()].map((a) => a.info);
  }

  private setStatus(status: LinkStatus, detail = ''): void {
    if (this.status === status && this.statusDetail === detail) return;
    this.status = status;
    this.statusDetail = detail;
    this.onStatus();
  }

  async start(): Promise<void> {
    this.transport.handlers = {
      connected: () => this.transport.send({ t: 'hello', v: PROTOCOL_VERSION, deviceId: this.id, name: this.name, secret: this.secret,
        agents: [...this.adapters.values()].map((a) => a.info), ...(this.code ? { code: this.code } : {}) }),
      disconnected: (reason) => {
        this.active = false;
        if (this.status !== 'rejected') this.setStatus('connecting', reason ?? '');
      },
      message: (msg) => this.onHub(msg),
    };
    this.transport.start();
    this.started = true;
    for (const adapter of this.adapters.values()) void this.startAdapter(adapter, 15_000);
  }

  /** Starts an agent; a busy or restarting computer gets more tries, further apart. */
  private async startAdapter(adapter: Adapter, wait: number): Promise<void> {
    try {
      await adapter.start(this.sinkFor(adapter.info.id));
      log('device', `agent ready: ${adapter.info.label}`);
      activity(`${adapter.info.label} 已就绪`);
    } catch (error) {
      log('device', `agent failed to start: ${adapter.info.label}`, (error as Error).message);
      activity(`${adapter.info.label} 启动失败，${Math.round(wait / 1000)} 秒后重试`, 'warn');
      setTimeout(() => void this.startAdapter(adapter, Math.min(wait * 2, 300_000)), wait);
    }
  }

  private onHub(msg: HubToDevice): void {
    switch (msg.t) {
      case 'welcome':
        this.active = true;
        log('device', 'joined the hub');
        this.setStatus('joined');
        this.onJoined();
        for (const [agentId, projects] of this.lastProjects) this.transport.send({ t: 'projects', agentId, projects });
        for (const [agentId, sessions] of this.lastSessions) this.transport.send({ t: 'sessions', agentId, sessions, complete: true });
        // What waited while away goes out a little at a time (see pump), not all at once.
        this.inflight.clear();
        this.sentUpTo = 0;
        this.pump();
        for (const r of this.db.prepare('SELECT * FROM receipts WHERE at > ?').all(Date.now() - 86_400_000) as { request_id: string; state: RequestState; turn_id: string | null; error: string | null }[]) {
          this.transport.send({ t: 'receipt', requestId: r.request_id, state: r.state, turnId: r.turn_id ?? undefined, error: r.error ?? undefined });
        }
        break;
      case 'pending':
        log('device', 'waiting for the hub to allow this device');
        this.setStatus('pending');
        break;
      case 'rejected':
        activity(`主电脑拒绝了本设备：${msg.reason}`, 'warn');
        this.setStatus('rejected', msg.reason);
        break;
      case 'hubMoved':
        this.onHubMoved(msg.hub, msg.members, msg.handover);
        break;
      case 'update':
        if (this.code) this.onUpdate(msg.version, Buffer.from(msg.data, 'base64'));
        break;
      case 'ack':
        this.db.prepare('DELETE FROM outbox WHERE oid = ?').run(msg.oid);
        this.inflight.delete(msg.oid);
        this.pump();
        break;
      case 'hydrate':
        this.adapters.get(msg.agentId)?.hydrate(msg.threadId);
        break;
      case 'command':
        void this.onCommand(msg.agentId, msg.threadId, msg.command, msg.data);
        break;
      case 'tick':
        for (const a of this.adapters.values()) {
          try {
            a.poll?.();
          } catch {
            // a look that failed is taken again next tick
          }
        }
        this.onTick();
        break;
      case 'alert':
        this.onAlert({ title: msg.title, text: msg.text, url: msg.url });
        break;
      case 'create': {
        const adapter = this.adapters.get(msg.agentId);
        if (!adapter?.create) {
          this.transport.send({ t: 'created', id: msg.id, error: `${adapter?.info.label ?? '这个 Agent'}还不支持新建对话，请发到它已有的对话` });
          break;
        }
        adapter.create(msg.cwd, msg.title, msg.first).then(({ threadId, sent }) => {
          // A first message the adapter sent itself has run, like any command: never run it a second time.
          if (sent && msg.first) this.db.prepare('INSERT OR IGNORE INTO receipts(request_id, state, at) VALUES (?, ?, ?)').run(msg.first.requestId, 'accepted', Date.now());
          this.transport.send({ t: 'created', id: msg.id, threadId, sent });
        }, (e: Error) => this.transport.send({ t: 'created', id: msg.id, error: e.message.slice(0, 300) }));
        break;
      }
      case 'answer': {
        const waiting = this.asks.get(msg.id);
        this.asks.delete(msg.id);
        if (msg.error) waiting?.reject(new Error(msg.error));
        else waiting?.resolve(msg.result);
        break;
      }
    }
  }

  /** An agent here uses the AllinOne tool: the hub answers (lists agents, sends on its behalf, waits for a reply). */
  ask(op: AskOp, agentId: string, args: Record<string, unknown>, timeoutMs: number, thread?: string): Promise<unknown> {
    if (!this.active) return Promise.reject(new Error('本机还没有连上主电脑'));
    // Files the agent hands along (paths on this computer): to the hub first, then named in the message by their hash.
    if (op === 'send' && Array.isArray(args.files) && args.files.some((f) => typeof f === 'string')) {
      return this.handFiles(args.files).then((files) => this.ask(op, agentId, { ...args, files }, timeoutMs, thread));
    }
    // Not told by the tool: the agent may know where the call comes from (its records show it as it is made).
    if (!thread) {
      try {
        thread = this.adapters.get(agentId)?.callerThread?.() ?? undefined;
      } catch {
        thread = undefined; // records being written: the hub falls back to what is running
      }
    }
    const id = ++this.askSeq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.asks.delete(id);
        reject(new Error('主电脑没有回应'));
      }, timeoutMs);
      this.asks.set(id, { resolve: (v) => (clearTimeout(timer), resolve(v)), reject: (e) => (clearTimeout(timer), reject(e)) });
      this.transport.send({ t: 'ask', id, op, agentId, args, ...(thread ? { thread } : {}) });
    });
  }

  private async onCommand(agentId: string, threadId: string, command: Command, data?: string[]): Promise<void> {
    // Each request runs at most once; a repeat only repeats its receipt.
    const seen = this.db.prepare('SELECT state, turn_id, error FROM receipts WHERE request_id = ?').get(command.requestId) as { state: RequestState; turn_id: string | null; error: string | null } | undefined;
    if (seen) return this.transport.send({ t: 'receipt', requestId: command.requestId, state: seen.state, turnId: seen.turn_id ?? undefined, error: seen.error ?? undefined });
    const adapter = this.adapters.get(agentId);
    const sink = this.sinkFor(agentId);
    if (!adapter) return sink.receipt(command.requestId, 'failed', undefined, 'agent_unavailable');
    // Recorded before acting: a crash in between leaves "unknown", never a silent second run.
    this.db.prepare('INSERT INTO receipts(request_id, state, at) VALUES (?, ?, ?)').run(command.requestId, 'unknown', Date.now());
    const label = { send: '收到手机发来的消息', interrupt: '收到停止指令', approve: '收到审批结果', cancel: '' }[command.op];
    if (label) activity(`${label}（${adapter.info.label}）`);
    try {
      if (command.files?.length) command = { ...command, files: await this.saveAttachments(command.files, data ?? []) };
      await adapter.command(threadId, command);
    } catch (error) {
      sink.receipt(command.requestId, 'failed', undefined, (error as Error).message.slice(0, 300));
    }
  }

  /** Files sent from the phone land in data/inbox/<sha256>/<name>, where the agent can open them. */
  private async saveAttachments(files: Attachment[], data: string[]): Promise<Attachment[]> {
    return Promise.all(files.map(async (f, i) => {
      const bytes = Buffer.from(data[i] ?? '', 'base64');
      if (bytes.length !== f.size || sha256(bytes) !== f.sha256) throw new Error(`attachment_corrupt: ${f.name}`);
      const dir = join(this.inbox, f.sha256);
      const path = join(dir, basename(f.name.replace(/[\\/:*?"<>|]/g, '_')) || 'file');
      await mkdir(dir, { recursive: true });
      await writeFile(path, bytes);
      return { ...f, path };
    }));
  }

  private enqueue(body: OutgoingBody): void {
    this.db.prepare('INSERT INTO outbox(msg) VALUES (?)').run(JSON.stringify(body));
    this.pump();
  }

  /**
   * Sends the outbox in order, keeping at most OUTBOX_WINDOW bytes on the way that the hub has not acknowledged.
   * Pouring out everything at once (hundreds of files after a while away) clogged the connection until the hub took it
   * for dead and dropped it, and the next connection poured it all out again.
   */
  private pump(): void {
    if (!this.active) return;
    let onTheWay = [...this.inflight.values()].reduce((a, b) => a + b, 0);
    const rows = this.db.prepare('SELECT oid, msg FROM outbox WHERE oid > ? ORDER BY oid LIMIT 50').all(this.sentUpTo) as { oid: number; msg: string }[];
    for (const row of rows) {
      if (this.inflight.size && onTheWay + row.msg.length > OUTBOX_WINDOW) break;
      this.transport.send({ ...JSON.parse(row.msg), oid: row.oid } as DeviceToHub);
      this.inflight.set(row.oid, row.msg.length);
      this.sentUpTo = row.oid;
      onTheWay += row.msg.length;
    }
  }

  private sinkFor(agentId: string): AdapterSink {
    return {
      sessions: (sessions, complete) => {
        if (complete) this.lastSessions.set(agentId, sessions);
        else {
          const merged = new Map((this.lastSessions.get(agentId) ?? []).map((s) => [s.threadId, s]));
          for (const s of sessions) merged.set(s.threadId, s);
          this.lastSessions.set(agentId, [...merged.values()]);
        }
        if (this.active) this.transport.send({ t: 'sessions', agentId, sessions, complete });
      },
      projects: (projects) => {
        this.lastProjects.set(agentId, projects);
        if (this.active) this.transport.send({ t: 'projects', agentId, projects });
      },
      items: (threadId, items) => {
        if (items.length) this.enqueue({ t: 'items', agentId, threadId, items });
      },
      artifact: (threadId, itemId, turnId, path) => void this.uploadArtifact(agentId, threadId, itemId, turnId, path),
      artifactData: (threadId, itemId, turnId, name, mime, data, sent) => {
        if (data.length > MAX_ARTIFACT_BYTES) return;
        this.enqueue({ t: 'artifact', agentId, threadId, itemId, turnId, name, size: data.length, sha256: sha256(data), mime,
          data: data.toString('base64'), ...(sent ? { sent: true } : {}) });
      },
      delta: (threadId, itemId, turnId, text) => {
        if (this.active) this.transport.send({ t: 'delta', agentId, threadId, itemId, turnId, text });
      },
      receipt: (requestId, state, turnId, error) => {
        this.db.prepare(`INSERT INTO receipts(request_id, state, turn_id, error, at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(request_id) DO UPDATE SET state = excluded.state, turn_id = COALESCE(excluded.turn_id, turn_id), error = excluded.error, at = excluded.at`)
          .run(requestId, state, turnId ?? null, error ?? null, Date.now());
        this.transport.send({ t: 'receipt', requestId, state, turnId, error });
      },
    };
  }

  /**
   * Sends the files an agent hands another agent to the hub (each as `file`, before the message that names them) and
   * describes them as attachments. Paths already turned into attachments pass through unchanged.
   */
  private async handFiles(paths: unknown[]): Promise<Attachment[]> {
    if (paths.length > 9) throw new Error('一次最多带 9 个文件');
    const out: Attachment[] = [];
    for (const p of paths) {
      if (p && typeof p === 'object' && typeof (p as Attachment).sha256 === 'string') {
        out.push(p as Attachment);
        continue;
      }
      const path = String(p);
      const info = await stat(path).catch(() => null);
      if (!info?.isFile()) throw new Error(`找不到文件：${path}`);
      if (info.size > MAX_ARTIFACT_BYTES) throw new Error(`文件太大（最多 25 MB）：${path}`);
      const data = await readFile(path);
      const name = basename(path);
      const file: Attachment = { sha256: sha256(data), name, size: data.length, mime: MIME[extname(name).toLowerCase()] ?? 'application/octet-stream' };
      this.transport.send({ t: 'file', ...file, data: data.toString('base64') });
      out.push(file);
    }
    return out;
  }

  private async uploadArtifact(agentId: string, threadId: string, itemId: string, turnId: string | null, path: string): Promise<void> {
    try {
      const info = await stat(path);
      if (!info.isFile() || info.size > MAX_ARTIFACT_BYTES) return;
      const data = await readFile(path);
      const name = basename(path);
      this.enqueue({ t: 'artifact', agentId, threadId, itemId, turnId, name, size: data.length, sha256: sha256(data),
        mime: MIME[extname(name).toLowerCase()] ?? 'application/octet-stream', data: data.toString('base64') });
    } catch {
      // The file may already be gone; the conversation still shows it as a tool call.
    }
  }
}
