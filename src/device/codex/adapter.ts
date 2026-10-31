// Codex adapter. Writes (send / steer / stop / approve) go through a private `codex app-server`;
// reads are triggered by changes under ~/.codex and done with the official thread APIs, so turns
// started in the Codex desktop app and turns started from the phone show up the same way.
import { execFile } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync, watch, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import type { Adapter, AdapterSink } from '../device.ts';
import type { AgentInfo, Command, Item, ProjectInfo, SessionInfo } from '../../shared/protocol.ts';
import { carriesTag, recordsCall, withAttachments } from '../../shared/protocol.ts';
import { debounce, log } from '../../shared/util.ts';
import { CodexRpc } from './rpc.ts';
import { normalizeTurn, type OutputFile } from './normalize.ts';
import { TOOL_FILE, TOOL_NAME, installHint, toolCommand } from '../tool.ts';

const HYDRATE_TURNS = 20;
const REFRESH_TURNS = 3;
const ITEMS_PER_MESSAGE = 200;
const APPROVAL_TIMEOUT_MS = 10 * 60_000;
const run = promisify(execFile);
const STARTUP_PREVIEWS = 40;
// Our own section of config.toml: a call may wait for another agent's whole turn (Codex allows 60 s by default),
// and, as the owner decided, an agent hands work over without asking each time (the owner still answers every
// approval the receiving agent raises).
const TOOL_TIMEOUT = 'tool_timeout_sec = 3600\ndefault_tools_approval_mode = "approve"';

function shorten(text: unknown): string | null {
  const s = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
  return s ? (s.length > 80 ? s.slice(0, 80) + '…' : s) : null;
}
const ROLLOUT_ID =/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** The last `bytes` of a file, as text. */
function tailOf(file: string, bytes: number): string {
  const size = statSync(file).size;
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(Math.min(size, bytes));
    readSync(fd, buf, 0, buf.length, size - buf.length);
    return buf.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

interface PendingApproval { threadId: string; turnId: string | null; item: Item; resolve(decision: string, answers?: Record<string, string>): void }

/** A question on a phone card: its choices, or free text when `custom`. */
interface Question { key: string; title: string; description: string; options: { value: string; label: string; description: string }[]; custom: boolean; secret?: boolean }

/** What a card shows and how its answer goes back to Codex. */
interface Ask {
  data: Record<string, unknown>;
  /** The JSON-RPC result for an answer; `answers` only for question cards. */
  respond(decision: 'accept' | 'decline', answers?: Record<string, string>): unknown;
  /** Nobody answered in time. */
  expire: unknown;
}

export function describePermissions(p: any): string {
  const lines: string[] = [];
  if (p?.network?.enabled) lines.push('联网');
  const fs = p?.fileSystem ?? {};
  if (fs.read?.length) lines.push(`读取：${fs.read.join('、')}`);
  if (fs.write?.length) lines.push(`写入：${fs.write.join('、')}`);
  for (const e of fs.entries ?? []) {
    const where = e.path?.path ?? e.path?.pattern ?? e.path?.value?.path ?? e.path?.value?.kind ?? '';
    lines.push(`${{ read: '读取', write: '写入', deny: '禁止' }[e.access as string] ?? e.access}：${where}`);
  }
  return lines.join('\n') || '更多权限';
}

/** An MCP form's fields as phone questions (choices for enums and yes/no, free text otherwise). */
export function formQuestions(schema: any): Question[] {
  return Object.entries((schema?.properties ?? {}) as Record<string, any>).map(([key, s]) => {
    const titled = s.oneOf ?? s.anyOf ?? s.items?.anyOf;
    const plain = s.enum ?? s.items?.enum;
    const options = s.type === 'boolean' ? [{ value: 'true', label: '是', description: '' }, { value: 'false', label: '否', description: '' }]
      : Array.isArray(titled) ? titled.map((o: any) => ({ value: String(o.const), label: String(o.title ?? o.const), description: '' }))
        : Array.isArray(plain) ? plain.map((v: string, i: number) => ({ value: String(v), label: String(s.enumNames?.[i] ?? v), description: '' })) : [];
    return { key, title: String(s.title ?? key), description: String(s.description ?? ''), options, custom: options.length === 0 };
  });
}

/** Typed answers back to the MCP form's field types. */
export function formContent(schema: any, answers: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(answers)) {
    const s = schema?.properties?.[key] ?? {};
    out[key] = s.type === 'boolean' ? value === 'true' : s.type === 'number' || s.type === 'integer' ? Number(value) : s.type === 'array' ? [value] : value;
  }
  return out;
}

/** The CLI bundled with the desktop app lives in bin/<hash>/; the newest one is the one in use. */
export function findCodexExe(): string | null {
  if (process.env.CODEX_EXE) return existsSync(process.env.CODEX_EXE) ? process.env.CODEX_EXE : null;
  const bin = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'OpenAI', 'Codex', 'bin');
  if (!existsSync(bin)) return null;
  const candidates = readdirSync(bin).map((d) => join(bin, d, 'codex.exe')).filter((f) => existsSync(f));
  candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return candidates[0] ?? null;
}

export class CodexAdapter implements Adapter {
  readonly info: AgentInfo = { id: 'codex', kind: 'codex', label: 'Codex' };
  private readonly rpc: CodexRpc;
  private readonly exe: string;
  private readonly home: string;
  private sink!: AdapterSink;
  private readonly known = new Map<string, SessionInfo>();
  private readonly hydrated = new Set<string>();
  private readonly loaded = new Set<string>(); // resumed in our private app-server
  private readonly activeTurn = new Map<string, string>();
  private readonly uploaded = new Set<string>();
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly dirtyThreads = new Set<string>();
  /** Projects renamed, reordered or conversations moved in the desktop app: regroup every conversation. */
  private readonly scheduleProjects = debounce(() => {
    if (!this.readDesktopState()) return;
    this.sink.projects(this.desktop.projects);
    for (const [id, s] of this.known) this.known.set(id, this.withState(s));
    this.sink.sessions([...this.known.values()], true);
  }, 1500);
  private readonly previews = new Map<string, string>();
  private desktop = { mtime: 0, signature: '', projects: [] as ProjectInfo[], names: new Map<string, string>(), assignment: new Map<string, string>(), pinned: new Set<string>(), mainRoots: new Map<string, string>() };
  private refreshing = false;
  private refreshAgain = false;
  private approvalSeq = 0;
  private readonly scheduleRefresh = debounce(() => void this.refresh(), 800, 2000); // read even while a run writes on
  /** Nothing of ours running any more: close our app-server, which is what really hands conversations back. */
  private readonly recycleSoon = debounce(() => {
    if (this.activeTurn.size || this.approvals.size || !this.held) return;
    this.held = false;
    this.loaded.clear();
    this.rpc.recycle();
    log('codex', 'handed the conversations back to the Codex app (restarted our app-server)');
    this.scheduleRefresh(); // a read cut off by the restart is done again
  }, 5000);
  private held = false; // our app-server ran a turn since it started

  constructor(exe: string, pidFile: string | null = null, home = process.env.CODEX_HOME ?? join(homedir(), '.codex')) {
    this.exe = exe;
    this.home = home;
    this.rpc = new CodexRpc(exe, {
      notification: (method, params) => this.onNotification(method, params),
      request: (method, params, id) => this.onServerRequest(method, params, id),
      restarted: () => {
        this.loaded.clear();
        this.scheduleRefresh();
      },
    }, pidFile);
  }

  async start(sink: AdapterSink): Promise<void> {
    this.sink = sink;
    void this.installTool();
    await this.rpc.start();
    this.readDesktopState();
    sink.projects(this.desktop.projects);
    const all = await this.listAll();
    // Fill in the latest line of the most recent conversations before the first report.
    for (const s of all.slice(0, STARTUP_PREVIEWS)) await this.readTurns(s.threadId, 1).catch(() => {});
    for (const s of all) this.known.set(s.threadId, this.withState(s));
    sink.sessions([...this.known.values()], true);
    watch(this.home, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const name = String(filename);
      if (name === '.codex-global-state.json') return this.scheduleProjects();
      if (!/^(sessions|archived_sessions)[\\/]|^state_\d+\.sqlite/.test(name)) return;
      const id = ROLLOUT_ID.exec(name)?.[1];
      if (id) this.dirtyThreads.add(id);
      this.scheduleRefresh();
    });
  }

  hydrate(threadId: string): void {
    if (this.hydrated.has(threadId)) return;
    this.hydrated.add(threadId);
    void this.readTurns(threadId, HYDRATE_TURNS).catch((e: Error) => log('codex', `hydrate failed ${threadId}: ${e.message}`));
  }

  async command(threadId: string, command: Command): Promise<void> {
    const { requestId } = command;
    switch (command.op) {
      case 'send': {
        const files = command.files ?? [];
        // Codex is waiting on a one-question card: a typed reply answers it, as typing into the card would.
        const question = [...this.approvals.values()].find((a) => a.threadId === threadId && a.item.data.kind === 'question'
          && (a.item.data.questions as Question[]).length === 1 && (a.item.data.questions as Question[])[0]!.custom);
        if (question && !files.length && command.text?.trim()) {
          question.resolve('accept', { [(question.item.data.questions as Question[])[0]!.key]: command.text.trim() });
          return this.sink.receipt(requestId, 'accepted', question.turnId ?? undefined);
        }
        // Every file is named by its path in the text; pictures also go in as images Codex can see.
        const text = withAttachments(command.text ?? '', files);
        try {
          await this.ensureLoaded(threadId);
          const input: Record<string, unknown>[] = [{ type: 'text', text, text_elements: [] }];
          for (const f of files) if (f.path && /^image\/(png|jpeg|gif|webp)$/.test(f.mime)) input.push({ type: 'localImage', path: f.path });
          let running = this.activeTurn.get(threadId);
          if (running) {
            // A turn is in progress: guide it with the new message, as typing into a running turn does on the computer.
            try {
              const res = await this.rpc.call<{ turnId: string }>('turn/steer', { threadId, expectedTurnId: running, input, clientUserMessageId: requestId });
              this.sink.receipt(requestId, 'accepted', res.turnId);
            } catch (error) {
              // It ended without our hearing of it (cut off, say): the message starts a turn of its own.
              if (!/no active turn/i.test((error as Error).message)) throw error;
              log('codex', `turn ${running} had ended; starting a new one`);
              this.activeTurn.delete(threadId);
              running = undefined;
            }
          }
          if (!running) {
            const res = await this.rpc.call<{ turn: { id: string } }>('turn/start', { threadId, input, clientUserMessageId: requestId });
            this.activeTurn.set(threadId, res.turn.id);
            this.held = true;
            this.sink.receipt(requestId, 'accepted', res.turn.id);
          }
        } catch (error) {
          // The conversation is open in another Codex process (the desktop app): it owns writing.
          // Put the message in Codex's own queue for that process to pick up.
          if (!/active writer/i.test((error as Error).message)) {
            if (!this.activeTurn.has(threadId)) this.release(threadId); // no turn of ours to finish: do not keep it
            throw error;
          }
          this.loaded.delete(threadId);
          await this.queueMessage(threadId, text);
          this.sink.receipt(requestId, 'accepted');
        }
        this.dirtyThreads.add(threadId);
        this.scheduleRefresh();
        return;
      }
      case 'interrupt': {
        const turnId = this.activeTurn.get(threadId);
        if (!turnId) return this.sink.receipt(requestId, 'failed', undefined, 'no_active_turn');
        await this.ensureLoaded(threadId);
        await this.rpc.call('turn/interrupt', { threadId, turnId });
        return this.sink.receipt(requestId, 'accepted', turnId);
      }
      case 'approve': {
        const pending = command.approvalId ? this.approvals.get(command.approvalId) : undefined;
        if (!pending || pending.threadId !== threadId) return this.sink.receipt(requestId, 'failed', undefined, 'approval_not_found');
        pending.resolve(command.decision ?? 'decline', command.answers);
        return this.sink.receipt(requestId, 'accepted', pending.turnId ?? undefined);
      }
      default:
        return this.sink.receipt(requestId, 'failed', undefined, 'unsupported');
    }
  }

  /** Registers the AgentChat tool with Codex's own `codex mcp add` (config.toml), once or when this program moved. */
  private async installTool(): Promise<void> {
    const { command, args } = toolCommand(this.info.id);
    // Codex's global instructions (~/.codex/AGENTS.md): every new conversation knows the tool is there.
    try {
      if (installHint(join(this.home, 'AGENTS.md'))) log('codex', 'AgentChat note added to Codex instructions');
    } catch (error) {
      log('codex', `could not add the AgentChat note: ${(error as Error).message}`);
    }
    try {
      const config = readFileSync(join(this.home, 'config.toml'), 'utf8');
      // TOML may write the path with doubled backslashes: compare with them undone.
      const section = (config.split(/^\[/m).find((s) => s.startsWith(`mcp_servers.${TOOL_NAME}]`)) ?? '').replaceAll('\\\\', '\\');
      if (section.includes(TOOL_FILE) && section.includes(process.execPath) && TOOL_TIMEOUT.split('\n').every((l) => section.includes(l))) return;
    } catch {
      // no config.toml yet: codex mcp add makes it
    }
    try {
      await run(this.exe, ['mcp', 'remove', TOOL_NAME], { windowsHide: true, timeout: 60_000 }).catch(() => {});
      await run(this.exe, ['mcp', 'add', TOOL_NAME, '--', command, ...args], { windowsHide: true, timeout: 60_000 });
      // A tool call may wait for another agent's whole turn; Codex gives a tool 60 s unless its own section says more.
      const file = join(this.home, 'config.toml');
      const config = readFileSync(file, 'utf8');
      const head = `[mcp_servers.${TOOL_NAME}]`;
      const eol = config.includes('\r\n') ? '\r\n' : '\n';
      if (config.includes(head)) writeFileSync(file, config.replace(head, `${head}${eol}${TOOL_TIMEOUT.replaceAll('\n', eol)}`));
      log('codex', 'AgentChat tool added to Codex');
    } catch (error) {
      log('codex', `could not add the AgentChat tool: ${(error as Error).message.slice(0, 200)}`);
    }
  }

  /** Conversation records (~/.codex/sessions/<year>/<month>/<day>/rollout-…-<id>.jsonl) written since `since`, by id. */
  private recentRollouts(since: number): { id: string; file: string }[] {
    const root = join(this.home, 'sessions');
    const out: { id: string; file: string }[] = [];
    for (const back of [0, 1]) {
      const d = new Date(Date.now() - back * 86_400_000);
      const dir = join(root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) {
        const id = ROLLOUT_ID.exec(f)?.[1];
        if (id && statSync(join(dir, f)).mtimeMs >= since) out.push({ id, file: join(dir, f) });
      }
    }
    return out;
  }

  /**
   * The conversations whose record shows a call of the AgentChat tool carrying the message `key` stands for, in the
   * last two minutes. Codex does not tell its tools which conversation calls, but writes each call down as it is made.
   */
  caller(key: string): string[] {
    return this.recentRollouts(Date.now() - 120_000)
      .filter((r) => tailOf(r.file, 256 * 1024).split('\n').some((line) => recordsCall(line, key))).map((r) => r.id);
  }

  /**
   * The conversations holding a message with this tag: waiting in Codex's own queue for the desktop app to take
   * (~/.codex/queue_1.sqlite, gone from there once taken), or in a conversation's record written in the last half hour.
   */
  locate(tag: string): string[] {
    const out = new Set<string>();
    const queue = join(this.home, 'queue_1.sqlite');
    if (existsSync(queue)) {
      const db = new DatabaseSync(queue, { readOnly: true });
      try {
        const rows = db.prepare('SELECT thread_id, payload_json FROM queued_items WHERE payload_json LIKE ?').all(`%#${tag}]%`) as { thread_id: string; payload_json: string }[];
        for (const r of rows) if (carriesTag(r.payload_json, tag)) out.add(r.thread_id);
      } catch {
        // a Codex of another make: its queue is not looked into
      } finally {
        db.close();
      }
    }
    for (const r of this.recentRollouts(Date.now() - 30 * 60_000)) if (carriesTag(tailOf(r.file, 4 * 1024 * 1024), tag)) out.add(r.id);
    return [...out];
  }

  /** A turn running in our app-server, or an approval waiting on it: both end with it when this program restarts. */
  busy(): boolean {
    return this.approvals.size > 0 || (this.held && this.activeTurn.size > 0);
  }

  /** A new conversation for work another agent hands over; it shows in the Codex app like any other. */
  async create(cwd: string, title: string): Promise<{ threadId: string }> {
    cwd ||= homedir();
    const res = await this.rpc.call<{ thread: { id: string } }>('thread/start', { cwd });
    const threadId = res.thread.id;
    this.loaded.add(threadId);
    await this.rpc.call('thread/name/set', { threadId, name: title }).catch((e: Error) => log('codex', `naming ${threadId} failed: ${e.message}`));
    const info = this.withState({ threadId, agentId: this.info.id, title, cwd, updatedAt: Math.floor(Date.now() / 1000), running: false, activeTurnId: null, preview: null });
    this.known.set(threadId, info);
    this.sink.sessions([info], false);
    return { threadId };
  }

  // ---------- reading ----------

  private async listAll(): Promise<SessionInfo[]> {
    const out: SessionInfo[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 50; page++) {
      const res: { data: any[]; nextCursor: string | null } = await this.rpc.call('thread/list', { archived: false, limit: 100, cursor, sortKey: 'updated_at' });
      for (const t of res.data) {
        if (t.ephemeral) continue;
        out.push(this.withState({ threadId: t.id, agentId: this.info.id, title: (t.name || t.preview || '未命名对话').slice(0, 120), cwd: t.cwd ?? null,
          updatedAt: t.updatedAt, running: false, activeTurnId: null, preview: shorten(t.preview) }));
      }
      cursor = res.nextCursor;
      if (!cursor) break;
    }
    return [...out, ...this.unlisted(new Set(out.map((s) => s.threadId)))];
  }

  /**
   * thread/list leaves out conversations an agent created or forked (and a few others) that the desktop
   * sidebar shows. Read them from Codex's own thread table, read-only: desktop conversations, not archived.
   */
  private unlisted(listed: Set<string>): SessionInfo[] {
    let db: DatabaseSync | null = null;
    try {
      const file = readdirSync(this.home).filter((f) => /^state_\d+\.sqlite$/.test(f)).sort((a, b) => Number(/\d+/.exec(a)) - Number(/\d+/.exec(b))).pop();
      if (!file) return [];
      db = new DatabaseSync(join(this.home, file), { readOnly: true });
      const rows = db.prepare("SELECT id, name, title, preview, cwd, updated_at FROM threads WHERE archived = 0 AND source = 'vscode'").all() as
        { id: string; name: string | null; title: string | null; preview: string | null; cwd: string | null; updated_at: number }[];
      return rows.filter((r) => !listed.has(r.id)).map((r) => this.withState({ threadId: r.id, agentId: this.info.id,
        title: (r.name || r.title || r.preview || '未命名对话').slice(0, 120), cwd: r.cwd ? r.cwd.replace(/^\\\\\?\\/, '') : null,
        updatedAt: Number(r.updated_at), running: false, activeTurnId: null, preview: shorten(r.preview) }));
    } catch (error) {
      log('codex', `reading the thread table failed: ${(error as Error).message}`);
      return [];
    } finally {
      db?.close();
    }
  }

  private async refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshAgain = true;
      return;
    }
    this.refreshing = true;
    try {
      const all = await this.listAll();
      const ids = new Set(all.map((s) => s.threadId));
      const removed = [...this.known.keys()].some((id) => !ids.has(id));
      const changed = all.filter((s) => this.known.get(s.threadId)?.updatedAt !== s.updatedAt || this.dirtyThreads.has(s.threadId));
      this.dirtyThreads.clear();
      for (const s of changed) await this.readTurns(s.threadId, this.hydrated.has(s.threadId) ? REFRESH_TURNS : 1).catch(() => {});
      for (const s of all) this.known.set(s.threadId, this.withState(s));
      for (const id of [...this.known.keys()]) if (!ids.has(id)) this.known.delete(id);
      if (removed) this.sink.sessions([...this.known.values()], true);
      else if (changed.length) this.sink.sessions(changed.map((s) => this.known.get(s.threadId)!), false);
    } catch (error) {
      log('codex', `refresh failed: ${(error as Error).message}`);
    } finally {
      this.refreshing = false;
      if (this.refreshAgain) {
        this.refreshAgain = false;
        this.scheduleRefresh();
      }
    }
  }

  /** Running state, latest line and project as we currently know them. */
  private withState(s: SessionInfo): SessionInfo {
    const active = this.activeTurn.get(s.threadId) ?? null;
    const projectId = this.desktop.assignment.get(s.threadId) ?? this.projectByFolder(s.cwd);
    return { ...s, running: active !== null, activeTurnId: active, preview: this.previews.get(s.threadId) ?? s.preview,
      projectId, projectName: projectId ? this.desktop.names.get(projectId) ?? null : null, pinned: this.desktop.pinned.has(s.threadId) };
  }

  /**
   * A conversation with no recorded project goes, as in the desktop sidebar, to the project whose main folder
   * (its first root) holds the conversation's folder; other roots are shared between projects and decide nothing.
   */
  private projectByFolder(cwd: string | null): string | null {
    if (!cwd) return null;
    const dir = cwd.replace(/^\\\\\?\\/, '').replace(/[\\/]+$/, '').toLowerCase();
    let best: { id: string; len: number } | null = null;
    for (const [id, root] of this.desktop.mainRoots) {
      if ((dir === root || dir.startsWith(root + '\\')) && root.length > (best?.len ?? -1)) best = { id, len: root.length };
    }
    return best?.id ?? null;
  }

  /**
   * The Codex desktop app files conversations into projects and keeps that in ~/.codex/.codex-global-state.json.
   * Read it (only the project fields), and again only when the file changes.
   */
  private readDesktopState(): boolean {
    const file = join(this.home, '.codex-global-state.json');
    try {
      const info = statSync(file);
      if (info.mtimeMs === this.desktop.mtime || info.size > 32 * 1024 * 1024) return false;
      const data = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')) as Record<string, any>;
      const local = Object.values((data['local-projects'] ?? {}) as Record<string, { id: string; name: string; rootPaths?: unknown }>);
      const mainRoots = new Map<string, string>();
      for (const p of local) {
        const root = Array.isArray(p?.rootPaths) && typeof p.rootPaths[0] === 'string' ? p.rootPaths[0] : '';
        if (root) mainRoots.set(p.id, root.replace(/^\\\\\?\\/, '').replace(/[\\/]+$/, '').toLowerCase());
      }
      const order: string[] = Array.isArray(data['project-order']) ? data['project-order'] : [];
      const rank = (id: string) => (order.includes(id) ? order.indexOf(id) : order.length);
      const projects = local.filter((p) => p && typeof p.id === 'string' && typeof p.name === 'string')
        .sort((a, b) => rank(a.id) - rank(b.id)).map((p) => ({ id: p.id, name: p.name }));
      const assignment = new Map<string, string>();
      for (const [tid, a] of Object.entries((data['thread-project-assignments'] ?? {}) as Record<string, { projectId?: string }>)) {
        if (a && typeof a.projectId === 'string') assignment.set(tid, a.projectId);
      }
      const pinned = new Set<string>((data['pinned-thread-ids'] ?? []).filter((x: unknown) => typeof x === 'string'));
      // The desktop app rewrites this file for many reasons (window size, input history): only project changes count.
      const signature = JSON.stringify([projects, [...assignment], [...pinned], [...mainRoots]]);
      const changed = signature !== this.desktop.signature;
      this.desktop = { mtime: info.mtimeMs, signature, projects, names: new Map(projects.map((p) => [p.id, p.name])), assignment, pinned, mainRoots };
      return changed;
    } catch {
      return false; // no desktop app, or the file is being rewritten: keep what we had
    }
  }

  /** Reads the latest turns; updates the running state and latest line and, for hydrated threads, reports items. */
  private async readTurns(threadId: string, limit: number): Promise<void> {
    const full = this.hydrated.has(threadId);
    const res = await this.rpc.call<{ data: any[] }>('thread/turns/list', { threadId, limit, sortDirection: 'desc', itemsView: full ? 'full' : 'summary' });
    const turns = res.data.slice().reverse();
    const last = turns.at(-1);
    // A turn the desktop app is running reads as "interrupted" from our app-server until it ends there (no end time
    // yet); a turn really interrupted has one. Taken as interrupted, another agent waiting on it would get no reply.
    if (last?.status === 'interrupted' && !last.completedAt) last.status = 'inProgress';
    if (last?.status === 'inProgress') this.activeTurn.set(threadId, last.id);
    else this.activeTurn.delete(threadId);
    const line = [...(last?.items ?? [])].reverse().find((i: any) => i.type === 'agentMessage' || i.type === 'userMessage');
    if (line) this.previews.set(threadId, shorten(line.type === 'agentMessage' ? line.text : (line.content ?? []).map((c: any) => c.text ?? '').join(' ')));
    if (!full) return;
    const files: OutputFile[] = [];
    const items = turns.flatMap((turn) => normalizeTurn(turn, files));
    for (const a of this.approvals.values()) if (a.threadId === threadId) items.push(a.item);
    for (let i = 0; i < items.length; i += ITEMS_PER_MESSAGE) this.sink.items(threadId, items.slice(i, i + ITEMS_PER_MESSAGE));
    this.uploadOutputs(threadId, files);
  }

  private uploadOutputs(threadId: string, files: OutputFile[]): void {
    const cwd = this.known.get(threadId)?.cwd;
    const roots = [cwd, join(this.home, 'generated_images')].filter((r): r is string => Boolean(r)).map((r) => resolve(r).toLowerCase() + sep);
    for (const f of files) {
      if (this.uploaded.has(f.itemId)) continue;
      const path = resolve(isAbsolute(f.path) || !cwd ? f.path : join(cwd, f.path));
      // Only files the agent produced inside its own working folder (or Codex's image folder).
      if (!roots.some((root) => path.toLowerCase().startsWith(root))) continue;
      this.uploaded.add(f.itemId);
      this.sink.artifact(threadId, f.itemId, f.turnId, path);
    }
  }

  // ---------- writing ----------

  /** `codex queue`: Codex's own way to hand a message to the session that currently owns a thread. */
  private async queueMessage(threadId: string, text: string): Promise<void> {
    try {
      await run(this.exe, ['queue', '--thread', threadId, '--message', text], { windowsHide: true, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
    } catch (error) {
      const e = error as { stderr?: string; message: string };
      throw new Error(`排队失败：${(e.stderr || e.message).trim().split('\n').slice(-1)[0]}`);
    }
  }

  private async ensureLoaded(threadId: string): Promise<void> {
    if (this.loaded.has(threadId)) return;
    await this.rpc.call('thread/resume', { threadId, excludeTurns: true });
    this.loaded.add(threadId);
  }

  /**
   * Lets go of a conversation we opened to run a turn. While our app-server holds it, the desktop app
   * shows "已在另一个应用中打开" and cannot continue it; it is ours only for the turn the phone asked for.
   */
  private release(threadId: string): void {
    if (!this.loaded.delete(threadId)) return;
    this.rpc.call('thread/unsubscribe', { threadId }).catch((e: Error) => log('codex', `could not release ${threadId}: ${e.message}`));
    // Unsubscribing alone keeps it ours as long as the app-server runs: close that too once nothing is going on.
    this.recycleSoon();
  }

  private onNotification(method: string, p: any): void {
    switch (method) {
      case 'item/agentMessage/delta':
        if (this.hydrated.has(p.threadId)) this.sink.delta(p.threadId, p.itemId, p.turnId, p.delta);
        break;
      case 'turn/started':
        if (p.turn?.id) this.activeTurn.set(p.threadId, p.turn.id);
        this.held = true;
        this.markDirty(p.threadId);
        break;
      case 'turn/completed':
        this.activeTurn.delete(p.threadId);
        this.markDirty(p.threadId);
        this.release(p.threadId);
        break;
      case 'item/completed':
      case 'thread/status/changed':
      case 'thread/name/updated':
        this.markDirty(p.threadId);
        break;
      case 'thread/closed':
        this.loaded.delete(p.threadId);
        break;
    }
  }

  private markDirty(threadId: string | undefined): void {
    if (!threadId) return;
    this.dirtyThreads.add(threadId);
    this.scheduleRefresh();
  }

  /** What Codex asks the owner, as a phone card: approvals, questions, permission requests, MCP forms. */
  private ask(method: string, p: any): Ask | null {
    switch (method) {
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
        return { data: { kind: method.includes('fileChange') ? 'file' : 'command', command: p.command ?? null, cwd: p.cwd ?? null, reason: p.reason ?? null },
          respond: (d) => ({ decision: d }), expire: { decision: 'decline' } };
      case 'item/permissions/requestApproval':
        return { data: { kind: 'permission', command: describePermissions(p.permissions), cwd: p.cwd ?? null, reason: p.reason ?? null },
          // Granting gives exactly what was asked, for this turn only.
          respond: (d) => ({ permissions: d === 'accept' ? p.permissions : {}, scope: 'turn' }), expire: { permissions: {}, scope: 'turn' } };
      case 'item/tool/requestUserInput': {
        const questions: Question[] = (p.questions ?? []).map((q: any) => {
          const options = (q.options ?? []).map((o: any) => ({ value: String(o.label), label: String(o.label), description: String(o.description ?? '') }));
          return { key: String(q.id), title: String(q.header ?? ''), description: String(q.question ?? ''), options, custom: Boolean(q.isOther) || !options.length, secret: Boolean(q.isSecret) };
        });
        const reply = (answers: Record<string, string> = {}) => ({ answers: Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, { answers: [v] }])) });
        return { data: { kind: 'question', questions, command: null, cwd: null, reason: questions[0]?.description || null },
          respond: (d, answers) => reply(d === 'accept' ? answers : {}), expire: reply() };
      }
      case 'mcpServer/elicitation/request': {
        const source = `MCP 插件「${p.serverName ?? ''}」`;
        if (p.mode === 'url') {
          return { data: { kind: 'link', command: p.url ?? null, cwd: null, reason: `${source}：${p.message ?? ''}` },
            respond: (d) => ({ action: d }), expire: { action: 'cancel' } };
        }
        const questions = formQuestions(p.requestedSchema);
        // A form with nothing to fill is Codex asking whether a plugin's tool may run: allow or deny.
        if (!questions.length) {
          return { data: { kind: 'mcp', command: String(p.message ?? ''), cwd: null, reason: source },
            respond: (d) => (d === 'accept' ? { action: 'accept', content: {} } : { action: 'decline' }), expire: { action: 'decline' } };
        }
        return { data: { kind: 'question', questions, command: null, cwd: null, reason: `${source}：${p.message ?? ''}` },
          respond: (d, answers) => (d === 'accept' && answers ? { action: 'accept', content: formContent(p.requestedSchema, answers) } : { action: 'decline' }),
          expire: { action: 'cancel' } };
      }
      default:
        return null;
    }
  }

  private onServerRequest(method: string, p: any, rpcId: number | string): Promise<unknown> {
    const ask = this.ask(method, p);
    if (!ask) return Promise.reject(new Error(`not supported from the phone: ${method}`));
    const approvalId = `ap${Date.now().toString(36)}${(this.approvalSeq++).toString(36)}`;
    const item: Item = { itemId: `approval:${approvalId}`, turnId: p.turnId ?? null, kind: 'approval_request', ts: p.startedAtMs ?? Date.now(),
      data: { approvalId, ...ask.data, targetItemId: p.itemId ?? null, state: 'pending' } };
    return new Promise((resolveResult) => {
      const finish = (result: unknown, state: string, answer?: string) => {
        if (!this.approvals.delete(approvalId)) return;
        clearTimeout(timer);
        item.data = { ...item.data, state, ...(answer ? { answer } : {}) };
        this.sink.items(p.threadId, [item]);
        resolveResult(result);
      };
      // Nobody answered: deny (or leave unanswered), as agreed.
      const timer = setTimeout(() => finish(ask.expire, 'expired'), APPROVAL_TIMEOUT_MS);
      const question = ask.data.kind === 'question';
      this.approvals.set(approvalId, { threadId: p.threadId, turnId: p.turnId ?? null, item,
        resolve: (decision, answers) => {
          const accept = decision === 'accept';
          // The card shows the answers by their labels; a secret answer is never shown back.
          const qs = (ask.data.questions as Question[] | undefined) ?? [];
          const shown = answers && !qs.some((q) => q.secret) ? Object.entries(answers)
            .map(([k, v]) => qs.find((q) => q.key === k)?.options.find((o) => o.value === v)?.label ?? v).join('；') : undefined;
          finish(ask.respond(accept ? 'accept' : 'decline', answers), question ? (accept ? 'answered' : 'cancelled') : accept ? 'accepted' : 'declined', shown);
        } });
      log('codex', `${question ? 'question' : 'approval'} requested (${method}) rpc=${rpcId}`);
      this.sink.items(p.threadId, [item]);
    });
  }
}
