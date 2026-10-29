// Goose adapter (Goose desktop 1.x). Reads conversations read-only from Goose's own database
// (%APPDATA%\Block\goose\data\sessions\sessions.db), refreshed whenever it changes, so turns typed into
// the desktop app reach the phone too. Sending types into the Goose window itself (desktop-send.ps1)
// while the owner is away from the keyboard, so the window shows the turn as it runs. Otherwise it goes
// through `goose acp`, Goose's official interface for other programs, started only while needed: Goose
// records the turn in the same database, and the window shows it only after Goose restarts (its next
// turn still reads the conversation from the database and knows it; nothing is overwritten).
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, statSync, watch, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Adapter, AdapterSink } from '../device.ts';
import type { AgentInfo, Command, Item, SessionInfo } from '../../shared/protocol.ts';
import { withAttachments } from '../../shared/protocol.ts';
import { debounce, log } from '../../shared/util.ts';
import { normalizeRows, textItemId, type MessageRow, type OutputFile } from './normalize.ts';
import { TOOL_NAME, installHint, toolCommand } from '../tool.ts';

const HYDRATE_ROWS = 400;
const PREVIEW_ROWS = 12;
const ITEMS_PER_MESSAGE = 200;
const APPROVAL_TIMEOUT_MS = 10 * 60_000;
const IDLE_EXIT_MS = 10 * 60_000;
// A turn typed into the desktop app with nothing after it for this long is taken as abandoned, not running.
const RUNNING_WINDOW_MS = 10 * 60_000;
const DATA = join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Block', 'goose', 'data', 'sessions');
const DB_FILE = join(DATA, 'sessions.db');
const CONFIG_FILE = join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Block', 'goose', 'config', 'config.yaml');
/** Goose's global hints, read into every conversation. */
export const HINT_FILE = join(dirname(CONFIG_FILE), '.goosehints');
const EXE_TAIL = join('resources', 'bin', 'goose.exe');
const DESKTOP_SEND = join(import.meta.dirname, 'desktop-send.ps1');
// Only these leave the window out: Goose is not open, or the conversation is not in its sidebar. Nothing to bypass
// then; any other answer (in use, locked, a draft, a running turn) means waiting for the window, never going around it.
const BACKGROUND_OK = new Set(['no_window', 'not_listed']);
const WINDOW_WAIT_MS = 2 * 3_600_000;

function shorten(text: string | null): string | null {
  const s = text ? text.replace(/\s+/g, ' ').trim() : '';
  return s ? (s.length > 80 ? s.slice(0, 80) + '…' : s) : null;
}

/**
 * Adds the AllinOne tool to Goose's extensions (config.yaml), keeping every other line as it is; the first change
 * keeps a copy beside it (config.yaml.allinone-backup). Returns whether it changed the file.
 */
export function installGooseTool(file = CONFIG_FILE, tool = toolCommand('goose')): boolean {
  if (!existsSync(file)) return false;
  const text = readFileSync(file, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const q = (s: string) => `'${s.replaceAll("'", "''")}'`;
  const block = [`  ${TOOL_NAME}:`, '    enabled: true', '    type: stdio', `    name: ${TOOL_NAME}`,
    '    description: 通过 AllinOne 给其他电脑上的 Agent 发消息、等回复', '    display_name: AllinOne', `    cmd: ${q(tool.command)}`,
    '    args:', ...tool.args.map((a) => `    - ${q(a)}`), '    envs: {}', '    env_keys: []', '    timeout: 3600', '    bundled: null'];
  let at = lines.findIndex((l) => /^extensions:\s*$/.test(l));
  if (at < 0) {
    lines.push('extensions:');
    at = lines.length - 1;
  }
  // The extensions block runs while lines stay indented (or blank).
  let end = at + 1;
  while (end < lines.length && (lines[end] === '' || /^\s/.test(lines[end]!))) end++;
  const start = lines.findIndex((l, i) => i > at && i < end && l === `  ${TOOL_NAME}:`);
  if (start >= 0) {
    let stop = start + 1;
    while (stop < end && (lines[stop] === '' || /^ {4}/.test(lines[stop]!))) stop++;
    if (lines.slice(start, stop).join('\n') === block.join('\n')) return false;
    lines.splice(start, stop - start);
  }
  if (!existsSync(file + '.allinone-backup')) writeFileSync(file + '.allinone-backup', text);
  lines.splice(at + 1, 0, ...block);
  writeFileSync(file, lines.join(eol));
  return true;
}

/** Takes the AllinOne extension back out of config.yaml (uninstall); every other line stays. */
export function uninstallGooseTool(file = CONFIG_FILE): boolean {
  if (!existsSync(file)) return false;
  const text = readFileSync(file, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l === `  ${TOOL_NAME}:`);
  if (start < 0) return false;
  let stop = start + 1;
  while (stop < lines.length && (lines[stop] === '' || /^ {4}/.test(lines[stop]!))) stop++;
  lines.splice(start, stop - start);
  writeFileSync(file, lines.join(eol));
  return true;
}

/** Whether Goose has run on this computer. */
export function hasGoose(): boolean {
  return existsSync(DB_FILE);
}

/** Goose desktop runs from wherever it was unpacked: take goose.exe beside the running app, else the usual places. */
async function findGooseExe(remembered: string | null): Promise<string | null> {
  if (process.env.GOOSE_EXE) return existsSync(process.env.GOOSE_EXE) ? process.env.GOOSE_EXE : null;
  const running = await new Promise<string[]>((done) => execFile('powershell.exe', ['-NoProfile', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name = 'Goose.exe'\" | ForEach-Object { $_.ExecutablePath }"], { windowsHide: true, timeout: 20_000 },
  (_e, stdout) => done(String(stdout ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean))));
  const local = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
  const candidates = [...running.map((p) => join(dirname(p), EXE_TAIL)), remembered,
    join(local, 'Programs', 'Goose', EXE_TAIL), join(local, 'Goose', EXE_TAIL), join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Goose', EXE_TAIL)];
  return candidates.find((c): c is string => Boolean(c) && existsSync(c!)) ?? null;
}

interface Pending { resolve(v: any): void; reject(e: Error): void }
interface PendingApproval { threadId: string; item: Item; answer(optionKind: 'allow' | 'reject'): void }

export class GooseAdapter implements Adapter {
  readonly info: AgentInfo = { id: 'goose', kind: 'goose', label: 'Goose' };
  private sink!: AdapterSink;
  private exe: string | null = null;
  private readonly exeFile: string;
  private readonly known = new Map<string, SessionInfo>();
  private readonly hydrated = new Set<string>();
  private readonly previews = new Map<string, string>();
  private readonly turns = new Map<string, string>();
  private readonly outcomes = new Map<string, string>(); // turn -> how a phone run ended
  private readonly runs = new Map<string, { ended: string | null }>(); // turns we are running, by conversation
  private readonly loading = new Set<string>(); // conversations replaying history into our acp process
  private readonly openOnDesktop = new Set<string>(); // latest row waits for the agent: a turn may be running on the computer
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly uploaded = new Set<string>();
  private signature = new Map<string, string>(); // conversation -> updated_at + row count
  private acp: { child: ChildProcess; pending: Map<number, Pending>; next: number; ready: Promise<void> } | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private approvalSeq = 0;
  private uiQueue: Promise<unknown> = Promise.resolve();
  private readonly windowQueues = new Map<string, Promise<boolean>>(); // messages waiting for the window, by conversation
  private refreshing = false;
  private refreshAgain = false;
  private readonly scheduleRefresh = debounce(() => void this.refresh(), 700);

  constructor(dataDir: string) {
    this.exeFile = join(dataDir, 'goose-exe.txt');
  }

  async start(sink: AdapterSink): Promise<void> {
    this.sink = sink;
    if (!existsSync(DB_FILE)) throw new Error('没有 Goose 对话库');
    try {
      if (installGooseTool()) log('goose', 'AllinOne tool added to Goose (new conversations and a Goose restart pick it up)');
      if (installHint(HINT_FILE)) log('goose', 'AllinOne note added to Goose hints');
    } catch (error) {
      log('goose', `could not add the AllinOne tool: ${(error as Error).message}`);
    }
    await this.refresh(true);
    watch(DATA, (_e, name) => {
      if (name && String(name).startsWith('sessions.db')) this.scheduleRefresh();
    });
  }

  hydrate(threadId: string): void {
    if (this.hydrated.has(threadId)) return;
    this.hydrated.add(threadId);
    this.report(threadId);
  }

  async command(threadId: string, command: Command): Promise<void> {
    const { requestId } = command;
    switch (command.op) {
      case 'send': {
        if (this.runs.has(threadId)) return this.sink.receipt(requestId, 'failed', undefined, 'busy_on_computer');
        const cwd = this.known.get(threadId)?.cwd ?? homedir();
        const files = command.files ?? [];
        // In the window, as typing there would; files are named by their paths in the text.
        const title = this.known.get(threadId)?.title;
        if (title && (await this.sendInWindow(threadId, title, withAttachments(command.text ?? '', files), requestId))) return;
        // Every file is named by its path in the text; pictures also go in as images Goose can see.
        const prompt: Record<string, unknown>[] = [{ type: 'text', text: withAttachments(command.text ?? '', files) }];
        for (const f of files) {
          if (f.path && /^image\/(png|jpeg|gif|webp)$/.test(f.mime)) prompt.push({ type: 'image', mimeType: f.mime, data: (await readFile(f.path)).toString('base64') });
        }
        await this.ensureAcp();
        const run = { ended: null as string | null };
        this.runs.set(threadId, run);
        this.publish(threadId);
        try {
          // Load it fresh each time: the desktop app may have continued it since.
          this.loading.add(threadId);
          await this.call('session/load', { sessionId: threadId, cwd, mcpServers: [] });
        } catch (error) {
          this.runs.delete(threadId);
          this.publish(threadId);
          throw error;
        } finally {
          this.loading.delete(threadId);
        }
        // `goose_background`: the window shows this only after Goose restarts; the phone says so.
        this.sink.receipt(requestId, 'accepted', `run:${threadId}`, 'goose_background');
        void this.call('session/prompt', { sessionId: threadId, prompt }).then((r: { stopReason?: string }) => {
          run.ended = r?.stopReason === 'cancelled' ? 'interrupted' : r?.stopReason === 'end_turn' ? 'completed' : 'failed';
        }, (e: Error) => {
          log('goose', `turn failed ${threadId}: ${e.message}`);
          run.ended = 'failed';
        }).finally(() => {
          this.call('session/close', { sessionId: threadId }).catch(() => {});
          this.endRun(threadId);
        });
        return;
      }
      case 'interrupt': {
        if (this.runs.has(threadId) && this.acp) {
          this.notify('session/cancel', { sessionId: threadId });
          return this.sink.receipt(requestId, 'accepted', `run:${threadId}`);
        }
        // A turn running in the window: press its Stop button.
        const title = this.known.get(threadId)?.title;
        const ui = title ? await this.desktop({ action: 'stop', title, marks: this.marks(threadId) }) : { ok: false, reason: 'no_title' };
        if (ui.ok) return this.sink.receipt(requestId, 'accepted', `run:${threadId}`);
        return this.sink.receipt(requestId, 'failed', undefined, 'no_active_turn');
      }
      case 'approve': {
        const pending = command.approvalId ? this.approvals.get(command.approvalId) : undefined;
        if (!pending || pending.threadId !== threadId) return this.sink.receipt(requestId, 'failed', undefined, 'approval_not_found');
        pending.answer(command.decision === 'accept' ? 'allow' : 'reject');
        return this.sink.receipt(requestId, 'accepted', `run:${threadId}`);
      }
      default:
        return this.sink.receipt(requestId, 'failed', undefined, 'unsupported');
    }
  }

  /**
   * A new conversation, made in the Goose window as typing there would: 新对话, then its first message (a Goose
   * conversation only begins with one), so the window shows it like any other. Named `title` with Goose's own
   * `goose session rename`. Goose starts it in its default folder; `cwd` is not used.
   */
  async create(_cwd: string, title: string, first?: Command): Promise<{ threadId: string; sent: boolean }> {
    if (!first?.text) throw new Error('Goose 新建对话需要第一条消息');
    const before = new Set(this.conversationIds());
    const ui = await this.desktop({ action: 'new', text: withAttachments(first.text, first.files ?? []) });
    if (!ui.ok) throw new Error(ui.reason === 'in_use' ? 'goose_window_in_use' : ['no_window', 'locked', 'draft'].includes(ui.reason) ? `goose_${ui.reason}` : `Goose 窗口里没能新建（${ui.reason}）`);
    // Goose writes the conversation down as its first message goes out.
    let threadId: string | undefined;
    for (let i = 0; i < 80 && !threadId; i++) {
      await new Promise((r) => setTimeout(r, 250));
      threadId = this.conversationIds().find((id) => !before.has(id));
    }
    if (!threadId) throw new Error('Goose 窗口里已经发出，但没有找到新对话');
    this.sink.receipt(first.requestId, 'accepted', `run:${threadId}`);
    try {
      await this.rename(threadId, title);
    } catch (error) {
      log('goose', `naming ${threadId} failed: ${(error as Error).message}`);
    }
    this.signature.delete(threadId); // report it again, with its name
    await this.refresh();
    return { threadId, sent: true };
  }

  /**
   * Goose writes its database partly through memory-mapped files, whose changes the file watcher can miss (a new
   * conversation then stayed unseen until a rescan). On each tick: the database files' times; changed, read again.
   */
  poll(): void {
    const stamp = ['sessions.db', 'sessions.db-wal'].map((f) => {
      try {
        return statSync(join(DATA, f)).mtimeMs;
      } catch {
        return 0;
      }
    }).join('|');
    if (stamp !== this.lastStamp) {
      this.lastStamp = stamp;
      this.scheduleRefresh();
    }
    // A desktop turn that went quiet stops counting as running once its window passes; nothing else would say so.
    for (const s of this.known.values()) if (s.running && !this.withState(s).running) this.publish(s.threadId);
  }
  private lastStamp = '';

  /** A turn of ours in goose acp, an approval waiting on it, or a message waiting for the window. */
  busy(): boolean {
    return this.runs.size > 0 || this.approvals.size > 0 || this.windowQueues.size > 0;
  }

  /** Conversations as the desktop app lists them, by id. */
  private conversationIds(): string[] {
    const db = new DatabaseSync(DB_FILE, { readOnly: true });
    try {
      return (db.prepare("SELECT id FROM sessions WHERE session_type = 'user' AND parent_session_id IS NULL").all() as { id: string }[]).map((r) => r.id);
    } finally {
      db.close();
    }
  }

  /** Goose's own rename, which marks the name as the owner's: Goose no longer names it by itself. */
  private async rename(threadId: string, title: string): Promise<void> {
    if (!this.exe || !existsSync(this.exe)) this.exe = await findGooseExe(null);
    if (!this.exe) throw new Error('goose_not_found');
    await new Promise<void>((done, fail) => execFile(this.exe!, ['session', 'rename', '--session-id', threadId, '--new-name', title],
      { windowsHide: true, timeout: 30_000 }, (error, _out, err) => (error ? fail(new Error(String(err || error.message).slice(0, 200))) : done())));
  }

  // ---------- the Goose window ----------

  /**
   * Types the message into the Goose window, waiting (and trying again every 15 s, for up to two hours) while that
   * cannot be done right now. Messages for one conversation keep their order. Resolves false only when the window
   * cannot show this conversation at all (Goose not open, or not in its sidebar): the caller then goes through goose acp.
   */
  private sendInWindow(threadId: string, title: string, text: string, requestId: string): Promise<boolean> {
    const previous = this.windowQueues.get(threadId) ?? Promise.resolve(true);
    const run = previous.catch(() => true).then(async () => {
      const deadline = Date.now() + WINDOW_WAIT_MS;
      let told = false;
      for (;;) {
        const ui = await this.desktop({ action: 'send', title, text, marks: this.marks(threadId) });
        if (ui.ok) {
          this.sink.receipt(requestId, 'accepted', `run:${threadId}`);
          return true;
        }
        if (BACKGROUND_OK.has(ui.reason)) {
          log('goose', `window send not possible (${ui.reason}): ${title}; going through goose acp`);
          return false;
        }
        if (ui.reason === 'ambiguous') {
          this.sink.receipt(requestId, 'failed', undefined, 'ambiguous_title');
          return true;
        }
        if (!told) {
          told = true;
          log('goose', `window send waits (${ui.reason}): ${title}`);
          this.sink.receipt(requestId, 'pending', undefined, 'waiting_for_window');
        }
        if (Date.now() > deadline) {
          this.sink.receipt(requestId, 'failed', undefined, 'window_unavailable');
          return true;
        }
        await new Promise((r) => setTimeout(r, 15_000));
      }
    });
    this.windowQueues.set(threadId, run);
    void run.finally(() => {
      if (this.windowQueues.get(threadId) === run) this.windowQueues.delete(threadId);
    });
    return run;
  }

  /** One at a time: each call drives the same window. */
  private desktop(req: Record<string, unknown>): Promise<{ ok: boolean; reason: string }> {
    const run = this.uiQueue.then(() => new Promise<{ ok: boolean; reason: string }>((done) => {
      const payload = Buffer.from(JSON.stringify(req), 'utf8').toString('base64');
      // On stdin, not the command line: a long message would not fit there (spawn ENAMETOOLONG).
      const child = execFile('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', DESKTOP_SEND],
        { windowsHide: true, timeout: 60_000 }, (error, stdout) => {
          try {
            done(JSON.parse(String(stdout).trim().split('\n').pop() || ''));
          } catch {
            done({ ok: false, reason: error?.message.slice(0, 120) ?? 'no_answer' });
          }
        });
      child.stdin?.end(payload);
    }));
    this.uiQueue = run;
    return run;
  }

  /** Typed messages that show the conversation is the one open in the window: its first and latest few. */
  private marks(threadId: string): string[] {
    const texts = this.readRows(threadId, HYDRATE_ROWS, (rows) => normalizeRows(rows, new Map()).items
      .filter((i) => i.kind === 'message' && i.data.role === 'user').map((i) => String(i.data.text))) ?? [];
    return [...new Set([texts[0], ...texts.slice(-6)].filter((t): t is string => Boolean(t)))];
  }

  // ---------- goose acp ----------

  private async ensureAcp(): Promise<void> {
    this.touch();
    if (this.acp) return this.acp.ready;
    if (!this.exe || !existsSync(this.exe)) {
      let remembered: string | null = null;
      try {
        remembered = readFileSync(this.exeFile, 'utf8').trim() || null;
      } catch {
        // not found before
      }
      this.exe = await findGooseExe(remembered);
      if (!this.exe) throw new Error('goose_not_found');
      if (this.exe !== remembered) writeFileSync(this.exeFile, this.exe);
    }
    const child = spawn(this.exe, ['acp'], { cwd: homedir(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const acp = { child, pending: new Map<number, Pending>(), next: 1, ready: Promise.resolve() };
    this.acp = acp;
    let buf = '';
    child.stdout!.on('data', (d) => {
      buf += String(d);
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try {
          this.onAcp(JSON.parse(line));
        } catch (error) {
          log('goose', `bad acp message: ${(error as Error).message}`);
        }
      }
    });
    let err = '';
    child.stderr!.on('data', (d) => (err = (err + String(d)).slice(-600)));
    child.on('exit', (code) => {
      if (this.acp === acp) this.acp = null;
      for (const p of acp.pending.values()) p.reject(new Error(`goose acp exited (${code}): ${err.trim().split('\n').pop() ?? ''}`));
      acp.pending.clear();
    });
    child.on('error', (e) => log('goose', `goose acp failed to start: ${e.message}`));
    acp.ready = this.call('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } })
      .then(() => undefined);
    return acp.ready;
  }

  private call<T = any>(method: string, params: unknown): Promise<T> {
    const acp = this.acp;
    if (!acp) return Promise.reject(new Error('goose acp is not running'));
    const id = acp.next++;
    return new Promise<T>((resolvePromise, reject) => {
      acp.pending.set(id, { resolve: resolvePromise, reject });
      acp.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  private notify(method: string, params: unknown): void {
    this.acp?.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  private reply(id: number | string, body: { result?: unknown; error?: unknown }): void {
    this.acp?.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, ...body }) + '\n');
  }

  /** Closes goose acp after a while without turns; the next message from the phone starts it again. */
  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.runs.size) return this.touch();
      this.acp?.child.kill();
      this.acp = null;
    }, IDLE_EXIT_MS);
  }

  private onAcp(m: any): void {
    if (m.id !== undefined && !m.method) {
      const p = this.acp?.pending.get(m.id);
      if (!p) return;
      this.acp!.pending.delete(m.id);
      return m.error ? p.reject(new Error(m.error.message ?? JSON.stringify(m.error))) : p.resolve(m.result);
    }
    if (m.method === 'session/update') {
      const sid: string = m.params?.sessionId;
      const u = m.params?.update ?? {};
      if (this.loading.has(sid)) return; // the history being replayed
      if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text' && this.hydrated.has(sid) && u.messageId) {
        this.sink.delta(sid, textItemId(u.messageId), `run:${sid}`, u.content.text);
      }
      return;
    }
    if (m.method === 'session/request_permission') return this.onPermission(m.id, m.params ?? {});
    if (m.id !== undefined) this.reply(m.id, { error: { code: -32601, message: 'not supported' } });
  }

  private onPermission(rpcId: number | string, p: any): void {
    const options: { optionId: string; kind: string }[] = p.options ?? [];
    const allow = options.find((o) => o.kind === 'allow_once') ?? options.find((o) => o.kind?.startsWith('allow'));
    const reject = options.find((o) => o.kind === 'reject_once') ?? options.find((o) => o.kind?.startsWith('reject'));
    const tc = p.toolCall ?? {};
    const approvalId = `ap${Date.now().toString(36)}${(this.approvalSeq++).toString(36)}`;
    const fileAction = tc.kind === 'edit' || /write|edit/i.test(String(tc.title ?? ''));
    const item: Item = { itemId: `approval:${approvalId}`, turnId: this.turns.get(p.sessionId) ?? null, kind: 'approval_request', ts: Date.now(),
      data: { approvalId, kind: fileAction ? 'file' : 'command', command: tc.rawInput?.command ?? null, cwd: this.known.get(p.sessionId)?.cwd ?? null,
        reason: tc.title ?? null, state: 'pending' } };
    const finish = (kind: 'allow' | 'reject', state: string) => {
      if (!this.approvals.delete(approvalId)) return;
      clearTimeout(timer);
      const option = kind === 'allow' ? allow : reject;
      this.reply(rpcId, { result: { outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } } });
      item.data = { ...item.data, state };
      this.sink.items(p.sessionId, [item]);
    };
    // Nobody answered: deny, as agreed.
    const timer = setTimeout(() => finish('reject', 'expired'), APPROVAL_TIMEOUT_MS);
    this.approvals.set(approvalId, { threadId: p.sessionId, item, answer: (kind) => finish(kind, kind === 'allow' ? 'accepted' : 'declined') });
    log('goose', `approval requested: ${tc.title ?? ''}`);
    this.sink.items(p.sessionId, [item]);
  }

  private endRun(threadId: string): void {
    const run = this.runs.get(threadId);
    this.runs.delete(threadId);
    // Goose does not record a stopped turn: remember it for the turn just run.
    if (run?.ended && run.ended !== 'completed') {
      const turn = this.readRows(threadId, PREVIEW_ROWS, (rows) => normalizeRows(rows, this.outcomes).turnId);
      if (turn) this.outcomes.set(turn, run.ended);
    }
    for (const a of this.approvals.values()) if (a.threadId === threadId) a.answer('reject');
    this.touch();
    this.report(threadId);
    this.publish(threadId);
  }

  // ---------- reading (read-only) ----------

  private readRows<T>(threadId: string, limit: number, use: (rows: MessageRow[]) => T): T | null {
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(DB_FILE, { readOnly: true });
      const rows = db.prepare('SELECT id, message_id, role, content_json, created_timestamp, metadata_json FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?')
        .all(threadId, limit) as unknown as MessageRow[];
      return use(rows.reverse());
    } catch (error) {
      log('goose', `reading ${threadId} failed: ${(error as Error).message}`);
      return null;
    } finally {
      db?.close();
    }
  }

  /** Updates the turn and latest line and, for hydrated conversations, reports items. */
  private report(threadId: string): void {
    const full = this.hydrated.has(threadId);
    const n = this.readRows(threadId, full ? HYDRATE_ROWS : PREVIEW_ROWS, (rows) => normalizeRows(rows, this.outcomes));
    if (!n) return;
    if (n.open) this.openOnDesktop.add(threadId);
    else this.openOnDesktop.delete(threadId);
    if (n.turnId) this.turns.set(threadId, n.turnId);
    const line = shorten(n.preview);
    if (line) this.previews.set(threadId, line);
    if (!full) return;
    const items = n.items;
    for (const a of this.approvals.values()) if (a.threadId === threadId) items.push(a.item);
    for (let i = 0; i < items.length; i += ITEMS_PER_MESSAGE) this.sink.items(threadId, items.slice(i, i + ITEMS_PER_MESSAGE));
    this.uploadOutputs(threadId, n.files);
  }

  private uploadOutputs(threadId: string, files: OutputFile[]): void {
    const cwd = this.known.get(threadId)?.cwd;
    if (!cwd) return;
    const root = resolve(cwd).toLowerCase() + sep;
    for (const f of files) {
      if (this.uploaded.has(f.itemId)) continue;
      const path = resolve(isAbsolute(f.path) ? f.path : join(cwd, f.path));
      // Only files the agent wrote inside its own working folder.
      if (!path.toLowerCase().startsWith(root)) continue;
      this.uploaded.add(f.itemId);
      this.sink.artifact(threadId, f.itemId, f.turnId, path);
    }
  }

  private publish(threadId: string): void {
    const s = this.known.get(threadId);
    if (!s) return;
    const next = this.withState(s);
    this.known.set(threadId, next);
    this.sink.sessions([next], false);
  }

  private withState(s: SessionInfo): SessionInfo {
    const ours = this.runs.has(s.threadId);
    // A turn typed into the desktop app: still running while its latest row waits for the agent.
    const desktop = !ours && this.openOnDesktop.has(s.threadId) && Date.now() - s.updatedAt * 1000 < RUNNING_WINDOW_MS;
    const running = ours || desktop;
    return { ...s, running, activeTurnId: running ? `run:${s.threadId}` : null, preview: this.previews.get(s.threadId) ?? s.preview };
  }

  /** Lists conversations as the desktop app does (typed by the owner, not archived, not sub-tasks); reads changed ones. */
  private async refresh(initial = false): Promise<void> {
    if (this.refreshing) {
      this.refreshAgain = true;
      return;
    }
    this.refreshing = true;
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(DB_FILE, { readOnly: true });
      const rows = db.prepare(`SELECT s.id, s.name, s.working_dir, s.updated_at, (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS n
        FROM sessions s WHERE s.session_type = 'user' AND s.archived_at IS NULL AND s.parent_session_id IS NULL ORDER BY s.updated_at DESC`).all() as
        { id: string; name: string; working_dir: string; updated_at: string; n: number }[];
      db.close();
      db = null;
      const ids = new Set(rows.map((r) => r.id));
      const removed = [...this.known.keys()].some((id) => !ids.has(id));
      const changed: SessionInfo[] = [];
      for (const r of rows) {
        const sig = `${r.updated_at}|${r.n}`;
        if (this.signature.get(r.id) === sig && this.known.has(r.id)) continue;
        this.signature.set(r.id, sig);
        this.report(r.id);
        const updatedAt = Math.floor(Date.parse(r.updated_at.replace(' ', 'T') + 'Z') / 1000) || 0;
        const info = this.withState({ threadId: r.id, agentId: this.info.id, title: (r.name || this.previews.get(r.id) || '未命名对话').slice(0, 120),
          cwd: r.working_dir || null, updatedAt, running: false, activeTurnId: null, preview: null,
          projectId: r.working_dir ? `dir:${r.working_dir.toLowerCase()}` : null, projectName: r.working_dir ? r.working_dir.split(/[\\/]/).filter(Boolean).pop() ?? null : null, pinned: false });
        this.known.set(r.id, info);
        changed.push(info);
      }
      for (const id of [...this.known.keys()]) if (!ids.has(id)) this.known.delete(id);
      if (initial || removed || changed.length) this.sink.projects(this.projectList());
      if (initial || removed) this.sink.sessions([...this.known.values()], true);
      else if (changed.length) this.sink.sessions(changed, false);
    } catch (error) {
      log('goose', `refresh failed: ${(error as Error).message}`);
      if (initial) throw error;
    } finally {
      db?.close();
      this.refreshing = false;
      if (this.refreshAgain) {
        this.refreshAgain = false;
        this.scheduleRefresh();
      }
    }
  }

  /** Projects are working folders, most recently used first. */
  private projectList(): { id: string; name: string }[] {
    const byId = new Map<string, { name: string; at: number }>();
    for (const s of this.known.values()) {
      if (!s.projectId) continue;
      const p = byId.get(s.projectId);
      if (!p || p.at < s.updatedAt) byId.set(s.projectId, { name: s.projectName ?? '', at: s.updatedAt });
    }
    return [...byId.entries()].sort((a, b) => b[1].at - a[1].at).map(([id, p]) => ({ id, name: p.name }));
  }
}
