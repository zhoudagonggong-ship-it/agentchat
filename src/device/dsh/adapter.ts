// DeepSeek Harness adapter (DSH desktop 0.2). Reads conversations read-only from DSH's own files: its summary cache
// (~/.dsh/storages/session_projcache: title, folder, whether a turn is open) for the list, and the conversation's
// append-only log (~/.dsh/sessions/<folder>/session-<id>/session.v4.jsonl.zstd) for its content, decompressing only
// the latest or newly added frames. Listed are the conversations the DSH sidebar shows: those of its workspaces
// (storages/workspace.json), not archived.
// Sending goes through AgentChat's DSH plugin (plugin/agentchat-bridge.mjs) when the DSH desktop runs it: the plugin
// asks here for the next message and hands it to DSH's own session controller, as the window's Send does, so the
// window shows the turn at once. DSH not running it (not open, or not restarted since the plugin went in): DSH's own
// command line, `dsh --profile headless --json --session-id <id>`, which continues the same conversation file.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, watch, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import type { Adapter, AdapterSink } from '../device.ts';
import type { AgentInfo, Command, Item, SessionInfo } from '../../shared/protocol.ts';
import { CONTROL_PORT, withAttachments } from '../../shared/protocol.ts';
import { debounce, log } from '../../shared/util.ts';
import { readFrom, readHeader, readLatest } from './log.ts';
import { normalizeEvents, type DshEvent } from './normalize.ts';

const HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const SESSIONS = join(HOME, 'sessions');
const CACHE = join(HOME, 'storages', 'session_projcache', 'sessions');
const WORKSPACE = join(HOME, 'storages', 'workspace.json');
const APP = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Programs', 'DeepSeek Harness');
const EXE = join(APP, 'DeepSeek Harness.exe');
const CLI = join(APP, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
const LOG = 'session.v4.jsonl.zstd';
const HYDRATE_EVENTS = 1500;
const PREVIEW_EVENTS = 80;
const PREVIEW_DAYS = 30;
const KEEP_EVENTS = 4000;
const ITEMS_PER_MESSAGE = 200;

/** The plugin, loaded by DSH from the desktop profile; it finds AgentChat through the connection file. */
const PLUGIN = join(import.meta.dirname, 'plugin', 'agentchat-bridge.mjs');
const CONNECTION = join(HOME, 'agentchat-bridge.json');
const PROFILE_PATCH = join(HOME, 'profiles', 'desktop', 'cordis.patch.yml');
const MARK_START = '# AgentChat: start (AgentChat 自动添加，卸载时会去掉)';
const MARK_END = '# AgentChat: end';
// The plugin asks every 25 s at most; not asked for this long, DSH is not running it.
const PLUGIN_ALIVE_MS = 60_000;
const DELIVERY_WAIT_MS = 90_000;

/** Whether DeepSeek Harness is installed and has been used here. */
export function hasDsh(): boolean {
  return existsSync(SESSIONS) && existsSync(EXE);
}

/**
 * Puts AgentChat's plugin into the DSH desktop profile's own patch layer (between markers, at its end), the way the
 * owner adds their own plugins there: an insert entry naming the plugin file by its absolute path. Everything else
 * in the file stays as it is; the first change keeps a copy beside it. DSH loads it at its next start.
 */
export function installDshPlugin(file = PROFILE_PATCH, plugin = PLUGIN, connection = CONNECTION): boolean {
  if (!existsSync(file)) return false;
  const before = readFileSync(file, 'utf8');
  const eol = before.includes('\r\n') ? '\r\n' : '\n';
  const q = (s: string) => `'${s.replaceAll("'", "''")}'`;
  const block = [MARK_START, '- insert:', '    - id: agentchat-bridge', `      name: ${q(plugin)}`, '      config:', `        connectionFile: ${q(connection)}`, MARK_END].join(eol);
  const at = before.indexOf(MARK_START);
  const end = before.indexOf(MARK_END);
  const after = at >= 0 && end > at
    ? before.slice(0, at) + block + before.slice(end + MARK_END.length)
    : before.trimEnd() + eol + eol + block + eol;
  if (after === before) return false;
  if (!existsSync(file + '.allinone-backup')) writeFileSync(file + '.allinone-backup', before);
  writeFileSync(file, after);
  return true;
}

/** Takes the plugin back out of the profile (uninstall); everything else stays. */
export function uninstallDshPlugin(file = PROFILE_PATCH): boolean {
  if (!existsSync(file)) return false;
  const before = readFileSync(file, 'utf8');
  const at = before.indexOf(MARK_START);
  const end = before.indexOf(MARK_END);
  if (at < 0 || end < at) return false;
  writeFileSync(file, (before.slice(0, at).trimEnd() + before.slice(end + MARK_END.length).replace(/^[\r\n]+/, '\n')).trimEnd() + '\n');
  return true;
}

interface Delivery { id: string; sessionId: string; text: string; done(ok: boolean, error?: string): void }

function shorten(text: string | null): string | null {
  const s = text ? text.replace(/\s+/g, ' ').trim() : '';
  return s ? (s.length > 80 ? s.slice(0, 80) + '…' : s) : null;
}

interface Found { file: string; size: number; mtime: number }
interface Cached { title: string | null; cwd: string | null; open: boolean }

export class DshAdapter implements Adapter {
  readonly info: AgentInfo = { id: 'dsh', kind: 'dsh', label: 'DSH' };
  private sink!: AdapterSink;
  private readonly files = new Map<string, Found>(); // conversation id -> its log
  private readonly known = new Map<string, SessionInfo>();
  private readonly signature = new Map<string, string>();
  private readonly subAgent = new Map<string, boolean>(); // sub-agent conversations are not listed
  private readonly hydrated = new Map<string, { events: DshEvent[]; offset: number }>();
  private readonly previews = new Map<string, string>();
  private readonly runs = new Map<string, ChildProcess>(); // command-line turns we run, by conversation
  private readonly uploaded = new Set<string>();
  private readonly outbox: Delivery[] = []; // messages waiting for the plugin to take
  private readonly taken = new Map<string, Delivery>(); // taken by the plugin, its answer not in yet
  private readonly askers: ((d: Delivery | null) => void)[] = []; // the plugin waiting here for the next one
  private pluginSeen = 0;
  private token = '';
  private workspaces: { id: string; name: string }[] = [];
  private refreshing = false;
  private refreshAgain = false;
  private readonly scheduleRefresh = debounce(() => void this.refresh(), 700);

  async start(sink: AdapterSink): Promise<void> {
    this.sink = sink;
    if (!hasDsh()) throw new Error('没有 DSH 对话');
    // Where the plugin finds us: this computer only, and a token only DSH and AgentChat know.
    this.token = randomBytes(24).toString('hex');
    try {
      writeFileSync(CONNECTION, JSON.stringify({ url: `http://127.0.0.1:${CONTROL_PORT}`, token: this.token }));
      if (installDshPlugin()) log('dsh', 'AgentChat plugin added to the DSH desktop profile (DSH picks it up at its next start)');
    } catch (error) {
      log('dsh', `could not add the AgentChat plugin to DSH: ${(error as Error).message}`);
    }
    await this.refresh(true);
    try {
      watch(SESSIONS, { recursive: true }, () => this.scheduleRefresh());
    } catch (error) {
      log('dsh', `cannot watch ${SESSIONS}: ${(error as Error).message}; checking on each tick instead`);
    }
  }

  hydrate(threadId: string): void {
    if (this.hydrated.has(threadId)) return;
    const f = this.files.get(threadId);
    if (!f) return;
    try {
      this.hydrated.set(threadId, readLatest(f.file, HYDRATE_EVENTS));
    } catch (error) {
      return log('dsh', `reading ${threadId} failed: ${(error as Error).message}`);
    }
    this.report(threadId);
  }

  async command(threadId: string, command: Command): Promise<void> {
    const { requestId } = command;
    switch (command.op) {
      case 'send': {
        if (this.runs.has(threadId)) return this.sink.receipt(requestId, 'failed', undefined, 'busy_on_computer');
        const text = withAttachments(command.text ?? '', command.files ?? []);
        // The DSH desktop runs the plugin: it sends it as the window's Send would (queued after a running turn).
        if (this.pluginRunning()) {
          const outcome = await this.viaPlugin(threadId, text);
          if (outcome.ok) return this.sink.receipt(requestId, 'accepted', `run:${threadId}`);
          if (outcome.error !== 'not_taken') return this.sink.receipt(requestId, 'failed', undefined, `dsh_failed: ${outcome.error}`.slice(0, 200));
          log('dsh', `the DSH plugin did not take a message for ${threadId}; using the command line`);
        }
        // DSH not running the plugin: its own command line continues the conversation; a turn still running is not
        // interrupted from behind it.
        if (this.known.get(threadId)?.running) return this.sink.receipt(requestId, 'failed', undefined, 'busy_on_computer');
        return this.runCli(threadId, text, requestId);
      }
      case 'interrupt': {
        const child = this.runs.get(threadId);
        if (child) {
          child.kill();
          return this.sink.receipt(requestId, 'accepted');
        }
        return this.sink.receipt(requestId, 'failed', undefined, 'no_active_turn');
      }
      case 'approve':
        // DSH asks its own window (or, from the command line, nobody: it then refuses by itself).
        return this.sink.receipt(requestId, 'failed', undefined, 'dsh_answer_on_computer');
      default:
        return this.sink.receipt(requestId, 'failed', undefined, 'unsupported');
    }
  }

  /** Its folder changes are watched; on each tick too, in case a change went unseen. */
  poll(): void {
    this.scheduleRefresh();
  }

  /** A command-line turn of ours, or a message on its way through the plugin. */
  busy(): boolean {
    return this.runs.size > 0 || this.outbox.length > 0 || this.taken.size > 0;
  }

  // ---------- the DSH plugin ----------

  /** Whether the DSH desktop runs AgentChat's plugin: it asked here lately. */
  pluginRunning(): boolean {
    return this.askers.length > 0 || Date.now() - this.pluginSeen < PLUGIN_ALIVE_MS;
  }

  /**
   * The plugin's calls (POST /api/dsh-bridge on this computer's control server): `next` waits up to `wait` seconds
   * for a message to send; `done` says how sending it went. Anything without the token is refused.
   */
  bridge(body: Record<string, unknown>): Promise<{ status: number; value: unknown }> {
    if (typeof body.token !== 'string' || body.token !== this.token) return Promise.resolve({ status: 403, value: { error: 'bad token' } });
    this.pluginSeen = Date.now();
    if (body.op === 'done') {
      const d = this.taken.get(String(body.id));
      if (d) d.done(body.ok === true, typeof body.error === 'string' ? body.error : undefined);
      return Promise.resolve({ status: 200, value: { ok: true } });
    }
    if (body.op !== 'next') return Promise.resolve({ status: 400, value: { error: 'unknown op' } });
    const give = (d: Delivery | null) => (d ? (this.taken.set(d.id, d), { status: 200, value: { id: d.id, sessionId: d.sessionId, text: d.text } }) : { status: 200, value: {} });
    const ready = this.outbox.shift();
    if (ready) return Promise.resolve(give(ready));
    const waitMs = Math.min(30, Math.max(1, Number(body.wait) || 25)) * 1000;
    return new Promise((answer) => {
      const asker = (d: Delivery | null) => {
        clearTimeout(timer);
        answer(give(d));
      };
      const timer = setTimeout(() => {
        const i = this.askers.indexOf(asker);
        if (i >= 0) this.askers.splice(i, 1);
        this.pluginSeen = Date.now();
        answer(give(null));
      }, waitMs);
      this.askers.push(asker);
    });
  }

  /** Hands one message to the plugin and waits for how it went; one it never takes comes back as `not_taken`. */
  private viaPlugin(sessionId: string, text: string): Promise<{ ok: boolean; error?: string }> {
    return new Promise((resolveOutcome) => {
      const id = randomUUID();
      let settled = false;
      const finish = (ok: boolean, error?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.taken.delete(id);
        const i = this.outbox.indexOf(d);
        if (i >= 0) this.outbox.splice(i, 1);
        resolveOutcome(ok ? { ok } : { ok, error: error ?? 'failed' });
      };
      const d: Delivery = { id, sessionId, text, done: finish };
      // Taken but no answer, or never taken (DSH closed meanwhile): as not taken, so the command line can carry it
      // only when the plugin never had it.
      const timer = setTimeout(() => finish(false, this.taken.has(id) ? 'no answer from DSH' : 'not_taken'), DELIVERY_WAIT_MS);
      const asker = this.askers.shift();
      if (asker) asker(d);
      else this.outbox.push(d);
    });
  }

  // ---------- sending ----------

  /** One turn through DSH's command line, in the conversation's own folder; the message goes in on stdin. */
  private runCli(threadId: string, text: string, requestId: string): void {
    const cwd = this.known.get(threadId)?.cwd;
    const child = spawn(EXE, ['--expose-internals', CLI, '--profile', 'headless', '--json', '--session-id', threadId, '-'],
      { cwd: cwd && existsSync(cwd) ? cwd : homedir(), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.runs.set(threadId, child);
    this.publish(threadId);
    let told = false;
    let buf = '';
    let err = '';
    child.stdout!.on('data', (d) => {
      buf += String(d);
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        let e: any;
        try {
          e = JSON.parse(line);
        } catch {
          continue;
        }
        // DSH took the message once it reports the conversation it continues.
        if (e.type === 'session' && !told) {
          told = true;
          this.sink.receipt(requestId, 'accepted', `run:${threadId}`);
        }
      }
    });
    child.stderr!.on('data', (d) => (err = (err + String(d)).slice(-600)));
    child.on('error', (e) => log('dsh', `dsh failed to start: ${e.message}`));
    child.on('exit', (code) => {
      this.runs.delete(threadId);
      if (!told) this.sink.receipt(requestId, 'failed', undefined, `dsh_failed: ${err.trim().split('\n').pop() ?? code}`.slice(0, 200));
      else if (code) log('dsh', `turn in ${threadId} ended with ${code}: ${err.trim().split('\n').pop() ?? ''}`);
      this.scheduleRefresh();
      this.publish(threadId);
    });
    child.stdin!.end(text, 'utf8');
  }

  // ---------- reading (read-only) ----------

  /** The conversation's content since last time, for a hydrated one; its latest line and state. */
  private report(threadId: string): void {
    const f = this.files.get(threadId);
    if (!f) return;
    const h = this.hydrated.get(threadId);
    let events: DshEvent[];
    try {
      if (h) {
        const next = readFrom(f.file, h.offset);
        h.events = h.events.concat(next.events).slice(-KEEP_EVENTS);
        h.offset = next.offset;
        events = h.events;
      } else {
        events = readLatest(f.file, PREVIEW_EVENTS).events;
      }
    } catch (error) {
      return log('dsh', `reading ${threadId} failed: ${(error as Error).message}`);
    }
    const n = normalizeEvents(events);
    const line = shorten(n.preview);
    if (line) this.previews.set(threadId, line);
    if (!h) return;
    const items: Item[] = n.items;
    for (let i = 0; i < items.length; i += ITEMS_PER_MESSAGE) this.sink.items(threadId, items.slice(i, i + ITEMS_PER_MESSAGE));
    this.uploadOutputs(threadId, n.files);
  }

  private uploadOutputs(threadId: string, files: { itemId: string; turnId: string | null; path: string }[]): void {
    const cwd = this.known.get(threadId)?.cwd;
    for (const f of files) {
      if (this.uploaded.has(f.itemId)) continue;
      const path = resolve(isAbsolute(f.path) || !cwd ? f.path : join(cwd, f.path));
      // Only files inside the conversation's own folder, as for the other agents.
      if (!cwd || !path.toLowerCase().startsWith(resolve(cwd).toLowerCase() + sep) || !existsSync(path)) continue;
      this.uploaded.add(f.itemId);
      this.sink.artifact(threadId, f.itemId, f.turnId, path);
    }
  }

  private publish(threadId: string): void {
    const s = this.known.get(threadId);
    if (!s) return;
    const next = { ...s, ...this.state(threadId, s.running) };
    this.known.set(threadId, next);
    this.sink.sessions([next], false);
  }

  private state(threadId: string, open: boolean): Pick<SessionInfo, 'running' | 'activeTurnId' | 'preview'> {
    const running = this.runs.has(threadId) || open;
    return { running, activeTurnId: running ? `run:${threadId}` : null, preview: this.previews.get(threadId) ?? null };
  }

  private cached(id: string): Cached {
    try {
      const rows = JSON.parse(readFileSync(join(CACHE, `${id}.json`), 'utf8')).record?.rows ?? {};
      return { title: rows.title?.val ? String(rows.title.val) : null, cwd: rows.workingDirectory?.val ? String(rows.workingDirectory.val) : null,
        open: rows.turnBoundary?.val?.openTurnStartSeq != null };
    } catch {
      return { title: null, cwd: null, open: false };
    }
  }

  /**
   * What the DSH sidebar shows: its workspaces in their order, each listing its conversations. A conversation in
   * no workspace (one started from DSH's command line in some other folder, say) is not in the window at all, so
   * it is not listed here either; nor are archived ones.
   */
  private sidebar(): { workspaces: { id: string; name: string }[]; byConversation: Map<string, string> } {
    const byConversation = new Map<string, string>();
    try {
      const ws = JSON.parse(readFileSync(WORKSPACE, 'utf8'));
      const archived = new Set<string>(ws.global?.archivedSessionIds ?? []);
      const table: Record<string, { title?: string; path?: string; sessionIds?: string[] }> = ws.tables?.workspaces ?? {};
      const order: string[] = ws.global?.workspaceIds ?? Object.keys(table);
      const workspaces = order.filter((id) => table[id]).map((id) => ({ id: `ws:${id}`, name: String(table[id]!.title ?? table[id]!.path ?? '') }));
      for (const [id, w] of Object.entries(table)) for (const s of w.sessionIds ?? []) if (!archived.has(s)) byConversation.set(s, `ws:${id}`);
      return { workspaces, byConversation };
    } catch {
      return { workspaces: [], byConversation };
    }
  }

  /** Every conversation's log, by id. */
  private scan(): Map<string, Found> {
    const found = new Map<string, Found>();
    for (const folder of readdirSync(SESSIONS)) {
      let entries: string[];
      try {
        entries = readdirSync(join(SESSIONS, folder));
      } catch {
        continue;
      }
      for (const id of entries) {
        if (!id.startsWith('session-')) continue;
        const file = join(SESSIONS, folder, id, LOG);
        try {
          const st = statSync(file);
          found.set(id, { file, size: st.size, mtime: st.mtimeMs });
        } catch {
          // no log yet
        }
      }
    }
    return found;
  }

  /** Lists conversations as DSH does (not archived, not sub-agents'); reads the changed ones. */
  private async refresh(initial = false): Promise<void> {
    if (this.refreshing) {
      this.refreshAgain = true;
      return;
    }
    this.refreshing = true;
    try {
      const found = this.scan();
      const { workspaces, byConversation } = this.sidebar();
      this.workspaces = workspaces;
      const changed: SessionInfo[] = [];
      const listed = new Set<string>();
      for (const [id, f] of found) {
        const workspace = byConversation.get(id);
        if (!workspace) continue;
        if (!this.subAgent.has(id)) {
          try {
            this.subAgent.set(id, Number(readHeader(f.file)?.delegationDepth ?? 0) > 0);
          } catch {
            this.subAgent.set(id, false);
          }
        }
        if (this.subAgent.get(id)) continue;
        listed.add(id);
        this.files.set(id, f);
        const c = this.cached(id);
        const sig = `${f.size}|${f.mtime}|${c.title}|${c.open}|${this.runs.has(id)}|${workspace}`;
        if (this.signature.get(id) === sig && this.known.has(id)) continue;
        this.signature.set(id, sig);
        // The latest line costs a read: only for conversations used lately (there may be hundreds of old ones).
        if (this.hydrated.has(id) || Date.now() - f.mtime < PREVIEW_DAYS * 86_400_000) this.report(id);
        const cwd = c.cwd;
        const info: SessionInfo = { threadId: id, agentId: this.info.id, title: (c.title || this.previews.get(id) || '未命名会话').slice(0, 120), cwd,
          updatedAt: Math.floor(f.mtime / 1000), ...this.state(id, c.open), projectId: workspace,
          projectName: this.workspaces.find((w) => w.id === workspace)?.name ?? null, pinned: false };
        this.known.set(id, info);
        changed.push(info);
      }
      const removed = [...this.known.keys()].filter((id) => !listed.has(id));
      for (const id of removed) {
        this.known.delete(id);
        this.files.delete(id);
      }
      if (initial || removed.length || changed.length) this.sink.projects(this.projectList());
      if (initial || removed.length) this.sink.sessions([...this.known.values()], true);
      else if (changed.length) this.sink.sessions(changed, false);
    } catch (error) {
      log('dsh', `refresh failed: ${(error as Error).message}`);
      if (initial) throw error;
    } finally {
      this.refreshing = false;
      if (this.refreshAgain) {
        this.refreshAgain = false;
        this.scheduleRefresh();
      }
    }
  }

  /** Projects are DSH's workspaces, in its sidebar's order. */
  private projectList(): { id: string; name: string }[] {
    return this.workspaces;
  }
}
