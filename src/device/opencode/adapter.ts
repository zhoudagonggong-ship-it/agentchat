// OpenCode adapter (OpenCode 2.x desktop app). The app runs a local server, `opencode-cli serve --service`, and
// writes where it listens and its password to ~/.local/state/opencode/service.json. Everything goes through
// that server's /api, the same one the desktop app uses, so the app shows the phone's messages as they happen:
// conversations and messages are read with it, /api/event streams every change.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Adapter, AdapterSink } from '../device.ts';
import type { AgentInfo, Command, Item, ProjectInfo, SessionInfo, WorkRule } from '../../shared/protocol.ts';
import { carriesTag, recordsCall, withAttachments } from '../../shared/protocol.ts';
import { debounce, log } from '../../shared/util.ts';
import { normalizeMessages, textItemId, type OutputFile, type Run } from './normalize.ts';
import { TOOL_NAME, installHint, toolCommand } from '../tool.ts';

const HYDRATE_MESSAGES = 200;
const REFRESH_MESSAGES = 40;
const PREVIEW_MESSAGES = 8;
const STARTUP_PREVIEWS = 40;
const ITEMS_PER_MESSAGE = 200;
const RECONNECT_MS = 5000;
/** How often the commands conversations left running in the background are looked at. */
const BACKGROUND_CHECK_MS = 30_000;
/** The project folders looked at: those of conversations used within this (seconds). */
const BACKGROUND_FOLDERS_S = 2 * 86_400;
/** A command no longer running whose end OpenCode was not told of within this: it will not resume by itself. */
const BACKGROUND_GRACE_MS = 3 * 60_000;
const STATE_FILE = join(homedir(), '.local', 'state', 'opencode', 'service.json');

function shorten(text: string | null): string | null {
  const s = text ? text.replace(/\s+/g, ' ').trim() : '';
  return s ? (s.length > 80 ? s.slice(0, 80) + '…' : s) : null;
}

const CONFIG_FILE = join(homedir(), '.config', 'opencode', 'opencode.json');
export const HINT_FILE = join(homedir(), '.config', 'opencode', 'AGENTS.md');

function openCodeToolCommand(): string[] {
  const { command, args } = toolCommand('opencode');
  return [command, ...args];
}

/** Puts the tool under `mcp` in OpenCode's global config; returns whether the file changed. */
export function installOpenCodeTool(file = CONFIG_FILE, command = openCodeToolCommand()): boolean {
  let config: Record<string, any> = {};
  if (existsSync(file)) {
    try {
      config = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      return false; // comments or something unreadable: never rewrite the owner's file
    }
  }
  const want = { type: 'local', command, enabled: true, timeout: 3_600_000 };
  if (JSON.stringify(config.mcp?.[TOOL_NAME]) === JSON.stringify(want)) return false;
  config.mcp = { ...(config.mcp ?? {}), [TOOL_NAME]: want };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  return true;
}

/** Takes the tool back out of OpenCode's global config (uninstall); the rest of the file stays. */
export function uninstallOpenCodeTool(file = CONFIG_FILE): boolean {
  let config: Record<string, any>;
  try {
    config = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
  if (!config.mcp?.[TOOL_NAME]) return false;
  delete config.mcp[TOOL_NAME];
  if (!Object.keys(config.mcp).length) delete config.mcp;
  writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  return true;
}

/** Whether the OpenCode desktop app is installed (it has run at least once). */
export function hasOpenCode(): boolean {
  return existsSync(STATE_FILE);
}

interface Server { url: string; auth: string }

function readServer(): Server | null {
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    if (typeof s.url !== 'string' || typeof s.password !== 'string') return null;
    return { url: s.url.replace(/\/+$/, ''), auth: 'Basic ' + Buffer.from(`opencode:${s.password}`).toString('base64') };
  } catch {
    return null;
  }
}

interface PendingApproval { threadId: string; item: Item }

export class OpenCodeAdapter implements Adapter {
  readonly info: AgentInfo = { id: 'opencode', kind: 'opencode', label: 'OpenCode' };
  private sink!: AdapterSink;
  private server: Server | null = null;
  private readonly known = new Map<string, SessionInfo>();
  private readonly hydrated = new Set<string>();
  private readonly runs = new Map<string, Run>(); // the run each conversation's last read ended in
  private readonly active = new Set<string>();
  private readonly turns = new Map<string, string>(); // session -> current turn (its latest user message)
  private readonly previews = new Map<string, string>();
  private readonly clientIds = new Map<string, string>(); // OpenCode message id -> phone request id
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly uploaded = new Set<string>();
  private readonly dirty = new Set<string>();
  /** Background commands (shell IDs) seen no longer running while their conversation still waits on them: since when. */
  private readonly stopped = new Map<string, number>();
  /** Conversations whose background work ended without OpenCode resuming them: why, as the owner reads it. */
  private readonly stranded = new Map<string, { shells: string[]; why: string; at: number }>();
  /** Permission requests not found in OpenCode at the last look (see forgetDroppedApprovals). */
  private readonly missing = new Set<string>();
  /** Conversations with commands running in the background: how many. */
  private readonly background = new Map<string, number>();
  private projects = new Map<string, { name: string; at: number }>();
  private relistNeeded = false;
  private refreshing = false;
  private refreshAgain = false;
  private readonly scheduleRefresh = debounce(() => void this.refresh(), 500, 2000); // read even while a run writes on

  async start(sink: AdapterSink): Promise<void> {
    this.sink = sink;
    this.server = readServer();
    if (!this.server) throw new Error('没有找到 OpenCode 的服务信息');
    const all = await this.listAll(); // throws while the desktop app is closed: the device retries
    for (const s of all.slice(0, STARTUP_PREVIEWS)) await this.readThread(s.threadId, PREVIEW_MESSAGES).catch(() => {});
    for (const s of all) this.known.set(s.threadId, this.withState(s));
    await this.readApprovals();
    sink.projects(this.projectList());
    sink.sessions([...this.known.values()], true);
    void this.listen();
    void this.installTool();
    setInterval(() => void this.watchBackground().catch((e) => log('opencode', `background check failed: ${(e as Error).message}`)), BACKGROUND_CHECK_MS).unref();
  }

  /**
   * OpenCode resumes a conversation when a command it moved to the background ends, while OpenCode itself keeps
   * running. Should the command vanish (OpenCode restarted, the process was killed) or end without it resuming, the
   * conversation would wait for ever and nobody would know: its turn is then given up as failed, with the reason, so
   * the owner and the agent that handed the work over hear of it.
   */
  private async watchBackground(): Promise<void> {
    // OpenCode keeps one list of background commands per project folder: the folders of conversations used lately.
    const since = Date.now() / 1000 - BACKGROUND_FOLDERS_S;
    const folders = new Set([...this.known.values()].filter((s) => s.cwd && (s.updatedAt >= since || this.runs.get(s.threadId)?.waiting?.length))
      .map((s) => s.cwd!));
    const jobs = new Map<string, string>(); // shell ID -> status
    const counts = new Map<string, number>(); // conversation -> commands running in its background
    for (const cwd of folders) {
      const res = await this.api<{ data: { id: string; status: string; metadata?: { sessionID?: string } }[] }>('GET', '/api/shell', undefined, true,
        { 'x-opencode-directory': encodeURIComponent(cwd) });
      for (const j of res.data) {
        jobs.set(j.id, j.status);
        const sid = j.metadata?.sessionID;
        if (j.status === 'running' && sid) counts.set(sid, (counts.get(sid) ?? 0) + 1);
      }
    }
    // The owner sees which conversations have work going on in the background.
    const changed: SessionInfo[] = [];
    for (const [id, s] of this.known) {
      const n = counts.get(id) ?? 0;
      if ((this.background.get(id) ?? 0) === n) continue;
      if (n) this.background.set(id, n);
      else this.background.delete(id);
      const next = this.withState(s);
      this.known.set(id, next);
      changed.push(next);
    }
    if (changed.length) this.sink.sessions(changed, false);
    await this.forgetDroppedApprovals();
    for (const [threadId, run] of this.runs) {
      if (!run.waiting?.length || run.running || this.active.has(threadId) || this.stranded.has(threadId)) continue;
      const gone: string[] = [];
      for (const id of run.waiting) {
        if (jobs.get(id) === 'running') {
          this.stopped.delete(id);
          continue;
        }
        const since = this.stopped.get(id) ?? Date.now();
        this.stopped.set(id, since);
        if (Date.now() - since >= BACKGROUND_GRACE_MS) gone.push(id);
        else this.markDirty(threadId); // its end may be in the conversation already: read it again
      }
      if (!gone.length) continue;
      const ended = gone.filter((id) => jobs.has(id));
      const why = ended.length
        ? `后台任务已经结束（${ended.map((id) => jobs.get(id)).join('、')}），但 OpenCode 没有被叫醒接着做`
        : '后台任务不见了，OpenCode 也没有收到它结束的通知（可能是 OpenCode 重启过，或任务被杀掉了）';
      log('opencode', `${threadId}: background ${gone.join(', ')} stranded: ${why}`);
      this.stranded.set(threadId, { shells: gone, why, at: Date.now() });
      this.markDirty(threadId);
    }
  }

  /** An approval or question waiting for the phone: after a restart we would no longer know it is there. */
  busy(): boolean {
    return this.approvals.size > 0;
  }

  /** A new conversation for work another agent hands over; the desktop app shows it at once. */
  async create(cwd: string, title: string): Promise<{ threadId: string }> {
    cwd ||= homedir();
    // OpenCode reads its config file only when it starts: give this folder the tool now, so the new conversation has it.
    await this.addToolAt(cwd).catch((e: Error) => log('opencode', `tool not added at ${cwd}: ${e.message.slice(0, 120)}`));
    const res = await this.api<{ data: any }>('POST', '/api/session', { title, location: { directory: cwd } });
    const info = this.withState(this.describe(res.data));
    this.known.set(info.threadId, info);
    this.sink.sessions([info], false);
    return { threadId: info.threadId };
  }

  /**
   * Adds the AgentChat tool to OpenCode's global config (~/.config/opencode/opencode.json, merged, never replacing
   * what is there; a file that is not plain JSON is left alone), which every conversation has once OpenCode restarts;
   * and, through its API, to the folder it runs in now.
   */
  private async installTool(): Promise<void> {
    // OpenCode's global rules (~/.config/opencode/AGENTS.md): every new conversation knows the tool is there.
    try {
      if (installHint(HINT_FILE)) log('opencode', 'AgentChat note added to OpenCode rules');
    } catch (error) {
      log('opencode', `could not add the AgentChat note: ${(error as Error).message}`);
    }
    try {
      if (installOpenCodeTool()) log('opencode', 'AgentChat tool added to OpenCode settings (all conversations have it after OpenCode restarts)');
    } catch (error) {
      log('opencode', `could not add the AgentChat tool to settings: ${(error as Error).message.slice(0, 200)}`);
    }
    await this.addToolAt(null).catch((e: Error) => log('opencode', `could not add the AgentChat tool: ${e.message.slice(0, 200)}`));
  }

  /** The tool for conversations in one folder (null: where OpenCode runs), unless that folder has it already. */
  private async addToolAt(directory: string | null): Promise<void> {
    const where = directory ? `?location[directory]=${encodeURIComponent(directory)}` : '';
    const res = await this.api<{ data: any[] }>('GET', `/api/mcp${where}`);
    if ((res.data ?? []).some((m) => m?.name === TOOL_NAME)) return;
    // Tool calls may wait for another agent's whole turn: allow up to an hour.
    await this.api('PUT', `/api/experimental/mcp/${TOOL_NAME}${where}`, { config: { type: 'local', command: openCodeToolCommand(), timeout: { execution: 3_600_000 } } });
  }

  /**
   * Adds rules to a conversation's own (OpenCode checks them on every tool call): one for the same kind of tool and
   * pattern takes the place of the one there; the others stay.
   */
  private async applyRules(threadId: string, rules: WorkRule[]): Promise<void> {
    const res = await this.api<{ data: { permissions?: WorkRule[] } }>('GET', `/api/session/${encodeURIComponent(threadId)}`);
    const key = (r: WorkRule) => `${r.action}\u0000${r.resource}`;
    const fresh = new Set(rules.map(key));
    const permissions = [...(res.data.permissions ?? []).filter((r) => !fresh.has(key(r))), ...rules];
    await this.api('PATCH', `/api/session/${encodeURIComponent(threadId)}`, { permissions });
    log('opencode', `${threadId}: rules now ${permissions.length}`);
  }

  /**
   * Switches the conversation's model ("provider/model", or a model of its present provider) and its variant (the
   * reasoning level, `effort`); either may be left out to keep what it has. A model or variant OpenCode does not offer
   * fails the message, with the ones it does offer.
   */
  private async switchModel(threadId: string, model?: string, effort?: string): Promise<void> {
    const res = await this.api<{ data: { model?: { id: string; providerID: string; variant?: string } } }>('GET', `/api/session/${encodeURIComponent(threadId)}`);
    const now = res.data.model;
    const [providerID, id] = model?.includes('/') ? [model.slice(0, model.indexOf('/')), model.slice(model.indexOf('/') + 1)] : [now?.providerID, model ?? now?.id];
    if (!providerID || !id) throw new Error('模型要写成「提供方/模型名」，比如 deepseek/deepseek-v4-pro');
    const list = await this.api<any[] | { data: any[] }>('GET', '/api/model');
    const offered = (Array.isArray(list) ? list : list.data ?? []).find((m) => (m.providerID ?? m.provider?.id) === providerID && m.id === id);
    if (!offered) throw new Error(`OpenCode 里没有模型 ${providerID}/${id}`);
    const variants = (offered.variants ?? []).map((v: any) => String(v?.id ?? v));
    if (effort && !variants.includes(effort)) throw new Error(`${providerID}/${id} 没有「${effort}」这一档，可选：${variants.join(' / ') || '（无）'}`);
    const variant = effort ?? (model ? undefined : now?.variant);
    await this.api('POST', `/api/session/${encodeURIComponent(threadId)}/model`, { model: { id, providerID, ...(variant ? { variant } : {}) } });
    log('opencode', `${threadId}: model now ${providerID}/${id}${variant ? ` · ${variant}` : ''}`);
    this.relistNeeded = true; // the list shows it
    this.scheduleRefresh();
  }

  hydrate(threadId: string): void {
    if (this.hydrated.has(threadId)) return;
    this.hydrated.add(threadId);
    void this.readThread(threadId, HYDRATE_MESSAGES).catch((e: Error) => log('opencode', `hydrate failed ${threadId}: ${e.message}`));
  }

  async command(threadId: string, command: Command): Promise<void> {
    const { requestId } = command;
    switch (command.op) {
      case 'send': {
        const files = command.files ?? [];
        // OpenCode is waiting on its one-question card: a typed reply answers it, as typing into the card would.
        const question = [...this.approvals.values()].find((a) => a.threadId === threadId && a.item.data.kind === 'question'
          && (a.item.data.questions as unknown[]).length === 1);
        if (question && !files.length && command.text?.trim()) {
          const key = (question.item.data.questions as { key: string }[])[0]!.key;
          await this.answerQuestion(threadId, String(question.item.data.approvalId), { [key]: command.text.trim() });
          return this.sink.receipt(requestId, 'accepted', question.item.turnId ?? undefined);
        }
        // The rules the agent handing the work over set: the conversation's own, before it reads the message.
        if (command.rules?.length) await this.applyRules(threadId, command.rules);
        // The model it should work with from this message on.
        if (command.model || command.effort) await this.switchModel(threadId, command.model, command.effort);
        // Every file is named by its path in the text; pictures also go in as attachments OpenCode can see.
        const text = withAttachments(command.text ?? '', files);
        const pictures = files.filter((f) => f.path && /^image\//.test(f.mime)).map((f) => ({ uri: pathToFileURL(f.path!).href, name: f.name }));
        // While a turn runs OpenCode steers it with the new message, as typing into a running conversation does.
        const res = await this.api<{ data: { id: string } }>('POST', `/api/session/${encodeURIComponent(threadId)}/prompt`,
          { text, ...(pictures.length ? { files: pictures } : {}) });
        this.clientIds.set(res.data.id, requestId);
        this.sink.receipt(requestId, 'accepted', res.data.id);
        return this.markDirty(threadId);
      }
      case 'interrupt': {
        if (!this.active.has(threadId)) return this.sink.receipt(requestId, 'failed', undefined, 'no_active_turn');
        await this.api('POST', `/api/session/${encodeURIComponent(threadId)}/interrupt`);
        // Stopping the turn drops what it was waiting for: so do its cards.
        for (const [id, a] of [...this.approvals]) if (a.threadId === threadId) this.settleApproval(id, 'cancelled');
        return this.sink.receipt(requestId, 'accepted', this.turns.get(threadId));
      }
      case 'approve': {
        const pending = command.approvalId ? this.approvals.get(command.approvalId) : undefined;
        if (!pending || pending.threadId !== threadId) return this.sink.receipt(requestId, 'failed', undefined, 'approval_not_found');
        const accept = command.decision === 'accept' || command.decision === 'acceptForSession';
        if (pending.item.data.kind === 'question') {
          if (accept && command.answers) await this.answerQuestion(threadId, command.approvalId!, command.answers);
          else {
            await this.api('DELETE', `/api/session/${encodeURIComponent(threadId)}/form/${encodeURIComponent(command.approvalId!)}`);
            this.settleApproval(command.approvalId!, 'cancelled');
          }
          return this.sink.receipt(requestId, 'accepted', pending.item.turnId ?? undefined);
        }
        try {
          await this.api('POST', `/api/session/${encodeURIComponent(threadId)}/permission/${encodeURIComponent(command.approvalId!)}/reply`,
            // Granted for the like of it: OpenCode keeps it as an allowed permission and asks no more.
            { decision: command.decision === 'acceptForSession' ? 'always' : accept ? 'once' : 'reject', ...(command.note ? { message: command.note } : {}) });
        } catch (error) {
          if (!/NotFound/.test((error as Error).message)) throw error;
          // OpenCode let it go already (its turn was stopped, say): the card goes too.
          this.settleApproval(command.approvalId!, 'expired');
          return this.sink.receipt(requestId, 'failed', undefined, 'approval_not_found');
        }
        this.settleApproval(command.approvalId!, accept ? 'accepted' : 'declined');
        return this.sink.receipt(requestId, 'accepted', pending.item.turnId ?? undefined);
      }
      default:
        return this.sink.receipt(requestId, 'failed', undefined, 'unsupported');
    }
  }

  // ---------- server ----------

  /** One call to the local server. The desktop app may have restarted on another port: look it up again once. */
  private async api<T = unknown>(method: string, path: string, body?: unknown, retry = true, headers: Record<string, string> = {}): Promise<T> {
    const server = this.server ?? readServer();
    if (!server) throw new Error('opencode_not_running');
    let res: Response;
    try {
      res = await fetch(server.url + path, { method, headers: { authorization: server.auth, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000) });
    } catch {
      this.server = readServer();
      if (retry && this.server && this.server.url !== server.url) return this.api(method, path, body, false, headers);
      throw new Error('opencode_not_running');
    }
    if (res.status === 401 && retry) {
      this.server = readServer();
      return this.api(method, path, body, false, headers);
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`OpenCode ${res.status}: ${text.slice(0, 200)}`);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** Follows /api/event for as long as the program runs; reconnects (and catches up) whenever the app restarts. */
  private async listen(): Promise<void> {
    let connected = false;
    for (;;) {
      try {
        const server = this.server ?? readServer();
        if (!server) throw new Error('no server');
        const res = await fetch(server.url + '/api/event', { headers: { authorization: server.auth, accept: 'text/event-stream' } });
        if (!res.ok || !res.body) throw new Error(`event stream ${res.status}`);
        if (!connected) log('opencode', 'following events');
        connected = true;
        this.relistNeeded = true; // anything may have changed while we were away
        this.scheduleRefresh();
        const decoder = new TextDecoder();
        let buf = '';
        for await (const chunk of res.body) {
          buf += decoder.decode(chunk as Uint8Array, { stream: true }).replace(/\r\n/g, '\n');
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const data = buf.slice(0, i).split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
            buf = buf.slice(i + 2);
            if (!data) continue;
            try {
              this.onEvent(JSON.parse(data));
            } catch (error) {
              log('opencode', `bad event: ${(error as Error).message}`);
            }
          }
        }
        throw new Error('event stream ended');
      } catch (error) {
        if (connected) log('opencode', `lost the event stream: ${(error as Error).message}`);
        connected = false;
        await new Promise((r) => setTimeout(r, RECONNECT_MS));
        this.server = readServer() ?? this.server;
      }
    }
  }

  private onEvent(e: { type: string; data?: any }): void {
    const d = e.data ?? {};
    const sid: string | undefined = d.sessionID;
    switch (e.type) {
      case 'session.text.delta':
        if (sid && this.hydrated.has(sid) && typeof d.delta === 'string') {
          this.sink.delta(sid, textItemId(d.assistantMessageID, Number(d.ordinal) || 0), this.turns.get(sid) ?? `run:${sid}`, d.delta);
        }
        return;
      case 'session.created':
      case 'session.deleted':
      case 'session.archived':
      case 'session.unarchived':
      case 'session.moved':
        this.relistNeeded = true;
        return this.scheduleRefresh();
      case 'session.execution.started':
        if (sid) this.active.add(sid);
        return this.markDirty(sid);
      case 'session.execution.succeeded':
      case 'session.execution.failed':
      case 'session.execution.interrupted':
        if (sid) this.active.delete(sid);
        return this.markDirty(sid);
      case 'session.renamed':
      case 'session.inbox.delivered':
      case 'session.text.ended':
      case 'session.tool.called':
      case 'session.tool.success':
      case 'session.tool.failed':
      case 'session.step.ended':
      case 'session.idle':
        return this.markDirty(sid);
      case 'permission.asked':
        return this.addApproval(d);
      case 'permission.replied':
        // Answered on the computer (or by us): the phone's card is no longer pending.
        return this.settleApproval(d.requestID ?? d.id, d.decision === 'reject' ? 'declined' : 'accepted');
      case 'form.created':
        return this.addQuestion(d.form ?? d);
      case 'form.replied':
        return this.settleApproval(d.formID ?? d.id, 'answered');
      case 'form.cancelled':
        return this.settleApproval(d.formID ?? d.id, 'cancelled');
      default:
        return; // reasoning and tool input streams, usage, catalog updates
    }
  }

  // ---------- reading ----------

  private async listAll(): Promise<SessionInfo[]> {
    const raw: any[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 50; page++) {
      const q: string = `limit=100&order=desc&archived=false&parentID=null${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res: { data: any[]; cursor?: { next?: string | null } } = await this.api('GET', `/api/session?${q}`);
      raw.push(...res.data);
      cursor = res.cursor?.next ?? null;
      if (!cursor || !res.data.length) break;
    }
    try {
      const projects = await this.api<any[] | { data: any[] }>('GET', '/api/project');
      const list = Array.isArray(projects) ? projects : projects.data;
      this.projects = new Map(list.map((p) => [String(p.id), { name: p.name || basename(String(p.canonical ?? '')) || '项目', at: Number(p.time?.active) || 0 }]));
    } catch (error) {
      log('opencode', `reading projects failed: ${(error as Error).message}`);
    }
    try {
      const res = await this.api<{ data: Record<string, unknown> }>('GET', '/api/session/active');
      this.active.clear();
      for (const id of Object.keys(res.data)) this.active.add(id);
    } catch {
      // keep what the events told us
    }
    return raw.filter((s) => !s.parentID && !s.time?.archived).map((s) => this.describe(s));
  }

  private describe(s: any): SessionInfo {
    const cwd: string | null = s.location?.directory ?? null;
    // "deepseek/deepseek-v4-pro · high": the same words switch it (send's model and effort).
    const m = s.model;
    const model = m?.id ? `${m.providerID ? `${m.providerID}/` : ''}${m.id}${m.variant && m.variant !== 'default' ? ` · ${m.variant}` : ''}` : null;
    return { threadId: s.id, agentId: this.info.id, title: (s.title || this.previews.get(s.id) || '未命名对话').slice(0, 120), cwd, model,
      updatedAt: Math.floor((Number(s.time?.updated) || 0) / 1000), running: false, activeTurnId: null, preview: null,
      projectId: s.projectID ?? null, projectName: null, pinned: false };
  }

  /** Running state, latest line and project name as we currently know them. */
  private withState(s: SessionInfo): SessionInfo {
    const running = this.active.has(s.threadId);
    const project = s.projectId ? this.projects.get(s.projectId) : undefined;
    return { ...s, running, background: this.background.get(s.threadId) ?? 0, activeTurnId: running ? this.turns.get(s.threadId) ?? `run:${s.threadId}` : null,
      preview: this.previews.get(s.threadId) ?? s.preview, projectName: project?.name ?? (s.cwd ? basename(s.cwd) : null) };
  }

  /** Projects that hold conversations, most recently used first. */
  private projectList(): ProjectInfo[] {
    const used = new Set([...this.known.values()].map((s) => s.projectId).filter(Boolean));
    return [...this.projects.entries()].filter(([id]) => used.has(id)).sort((a, b) => b[1].at - a[1].at).map(([id, p]) => ({ id, name: p.name }));
  }

  /** The conversations holding a message with this tag, among those active in the last half hour (their latest messages). */
  async locate(tag: string): Promise<string[]> {
    const since = Date.now() / 1000 - 1800;
    const recent = [...this.known.values()].filter((s) => s.updatedAt >= since || s.running);
    const found = await Promise.all(recent.map(async (s) => {
      const res = await this.api<{ data: any[] }>('GET', `/api/session/${encodeURIComponent(s.threadId)}/message?limit=40&order=desc`).catch(() => ({ data: [] }));
      return res.data.some((m) => m?.type === 'user' && carriesTag(String(m.text ?? m.payload?.text ?? ''), tag)) ? s.threadId : null;
    }));
    return found.filter((t): t is string => t !== null);
  }

  /**
   * The conversations whose latest messages show a call of the AgentChat tool carrying the message `key` stands for
   * (as a tool of its own, or in code OpenCode runs): OpenCode does not tell its tools which conversation calls.
   */
  async caller(key: string): Promise<string[]> {
    const since = Date.now() / 1000 - 120;
    const recent = [...this.known.values()].filter((s) => s.updatedAt >= since || s.running);
    const found = await Promise.all(recent.map(async (s) => {
      const res = await this.api<{ data: any[] }>('GET', `/api/session/${encodeURIComponent(s.threadId)}/message?limit=10&order=desc`).catch(() => ({ data: [] }));
      return res.data.some((m) => m?.type === 'assistant' && recordsCall(JSON.stringify(m.content ?? ''), key)) ? s.threadId : null;
    }));
    return found.filter((t): t is string => t !== null);
  }

  /** Reads the latest messages; updates the turn and latest line and, for hydrated conversations, reports items. */
  private async readThread(threadId: string, limit: number): Promise<void> {
    const full = this.hydrated.has(threadId);
    const res = await this.api<{ data: any[] }>('GET', `/api/session/${encodeURIComponent(threadId)}/message?limit=${full ? limit : PREVIEW_MESSAGES}&order=desc`);
    const { items, files, turnId, run, preview } = normalizeMessages(res.data.slice().reverse(), this.clientIds, this.runs.get(threadId));
    if (turnId) this.turns.set(threadId, turnId);
    if (run) this.runs.set(threadId, run);
    // Background work that ended without OpenCode resuming the turn: the turn is given up, with the reason.
    const stuck = this.stranded.get(threadId);
    if (stuck && !run?.waiting?.some((id) => stuck.shells.includes(id))) {
      this.stranded.delete(threadId); // it was resumed after all
      for (const id of stuck.shells) this.stopped.delete(id);
    } else if (stuck) {
      for (const it of items) {
        if (it.kind !== 'status' || it.itemId !== `turn:${run!.turn}` || !it.data.background) continue;
        it.ts = stuck.at;
        it.data = { ...it.data, status: 'failed', completedAt: Math.floor(stuck.at / 1000), error: stuck.why };
      }
    }
    const line = shorten(preview);
    if (line) this.previews.set(threadId, line);
    if (!full) return;
    for (const a of this.approvals.values()) if (a.threadId === threadId) items.push(a.item);
    for (let i = 0; i < items.length; i += ITEMS_PER_MESSAGE) this.sink.items(threadId, items.slice(i, i + ITEMS_PER_MESSAGE));
    this.uploadOutputs(threadId, files);
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

  private markDirty(threadId: string | undefined): void {
    if (!threadId) return;
    this.dirty.add(threadId);
    this.scheduleRefresh();
  }

  private async refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshAgain = true;
      return;
    }
    this.refreshing = true;
    try {
      if (this.relistNeeded) {
        this.relistNeeded = false;
        const all = await this.listAll();
        const ids = new Set(all.map((s) => s.threadId));
        const changed = all.filter((s) => this.known.get(s.threadId)?.updatedAt !== s.updatedAt || this.dirty.has(s.threadId));
        this.dirty.clear();
        for (const s of changed) await this.readThread(s.threadId, REFRESH_MESSAGES).catch(() => {});
        for (const s of all) this.known.set(s.threadId, this.withState(s));
        for (const id of [...this.known.keys()]) if (!ids.has(id)) this.known.delete(id);
        await this.readApprovals();
        this.sink.projects(this.projectList());
        this.sink.sessions([...this.known.values()], true);
        return;
      }
      const ids = [...this.dirty];
      this.dirty.clear();
      const changed: SessionInfo[] = [];
      for (const id of ids) {
        let s: any;
        try {
          s = (await this.api<{ data: any }>('GET', `/api/session/${encodeURIComponent(id)}`)).data;
        } catch {
          continue; // deleted meanwhile; the next relist drops it
        }
        if (s.parentID) continue; // a subagent's own conversation
        await this.readThread(id, REFRESH_MESSAGES).catch(() => {});
        const info = this.withState(this.describe(s));
        this.known.set(id, info);
        changed.push(info);
      }
      if (changed.length) this.sink.sessions(changed, false);
    } catch (error) {
      log('opencode', `refresh failed: ${(error as Error).message}`);
    } finally {
      this.refreshing = false;
      if (this.refreshAgain) {
        this.refreshAgain = false;
        this.scheduleRefresh();
      }
    }
  }

  // ---------- approvals ----------

  /** Requests and questions already waiting when we start or reconnect. */
  private async readApprovals(): Promise<void> {
    try {
      const res = await this.api<any[] | { data: any[] }>('GET', '/api/permission/request');
      for (const p of Array.isArray(res) ? res : res.data ?? []) this.addApproval(p);
      // Questions are listed per conversation; only a running one can be waiting on one.
      for (const id of this.active) {
        const forms = await this.api<{ data: any[] }>('GET', `/api/session/${encodeURIComponent(id)}/form`);
        for (const f of forms.data ?? []) this.addQuestion(f);
      }
    } catch (error) {
      log('opencode', `reading approvals failed: ${(error as Error).message}`);
    }
  }

  /** OpenCode asks the owner (its question tool): a card with the choices it offers, answered from the phone. */
  private addQuestion(f: any): void {
    if (!f?.id || !f.sessionID || this.approvals.has(f.id)) return;
    const questions = (Array.isArray(f.fields) ? f.fields : []).map((q: any) => ({ key: String(q.key), title: String(q.title ?? ''),
      description: String(q.description ?? ''), custom: q.custom !== false,
      options: (Array.isArray(q.options) ? q.options : []).map((o: any) => ({ value: String(o.value ?? o.label), label: String(o.label ?? o.value),
        description: String(o.description ?? '') })) }));
    if (!questions.length) return;
    const item: Item = { itemId: `approval:${f.id}`, turnId: this.turns.get(f.sessionID) ?? null, kind: 'approval_request', ts: Date.now(),
      data: { approvalId: f.id, kind: 'question', questions, command: null, cwd: this.known.get(f.sessionID)?.cwd ?? null,
        reason: questions[0].description || questions[0].title || f.title || null, state: 'pending' } };
    this.approvals.set(f.id, { threadId: f.sessionID, item });
    log('opencode', 'question asked');
    this.sink.items(f.sessionID, [item]);
  }

  private async answerQuestion(threadId: string, formId: string, answers: Record<string, string>): Promise<void> {
    await this.api('POST', `/api/session/${encodeURIComponent(threadId)}/form/${encodeURIComponent(formId)}/reply`, { answer: answers });
    this.settleApproval(formId, 'answered', Object.values(answers).join('；'));
  }

  private addApproval(p: any): void {
    if (!p?.id || !p.sessionID || this.approvals.has(p.id)) return;
    const resources: string[] = Array.isArray(p.resources) ? p.resources : [];
    const fileAction = /edit|write|patch/i.test(String(p.action));
    const item: Item = { itemId: `approval:${p.id}`, turnId: this.turns.get(p.sessionID) ?? null, kind: 'approval_request', ts: Date.now(),
      data: { approvalId: p.id, kind: fileAction ? 'file' : 'command', command: fileAction ? null : resources.join('\n') || null,
        cwd: this.known.get(p.sessionID)?.cwd ?? null, reason: p.message ?? (fileAction ? resources.join('\n') : p.action) ?? null, state: 'pending' } };
    this.approvals.set(p.id, { threadId: p.sessionID, item });
    log('opencode', `approval requested (${p.action})`);
    this.sink.items(p.sessionID, [item]);
  }

  /**
   * Permission requests OpenCode no longer has (stopped on the computer, OpenCode restarted): their cards would wait
   * for ever, and keep this computer from taking an update. Seen gone twice in a row, they go.
   */
  private async forgetDroppedApprovals(): Promise<void> {
    const asks = [...this.approvals].filter(([, a]) => a.item.data.kind !== 'question');
    if (!asks.length) return this.missing.clear();
    const res = await this.api<any[] | { data: any[] }>('GET', '/api/permission/request');
    const open = new Set((Array.isArray(res) ? res : res.data ?? []).map((p) => String(p?.id)));
    for (const [id] of asks) {
      if (open.has(id)) this.missing.delete(id);
      else if (this.missing.has(id)) {
        this.missing.delete(id);
        log('opencode', `approval ${id} is gone in OpenCode: card closed`);
        this.settleApproval(id, 'expired');
      } else this.missing.add(id);
    }
  }

  private settleApproval(id: string | undefined, state: string, answer?: string): void {
    const pending = id ? this.approvals.get(id) : undefined;
    if (!pending) return;
    this.approvals.delete(id!);
    pending.item.data = { ...pending.item.data, state, ...(answer ? { answer } : {}) };
    this.sink.items(pending.threadId, [pending.item]);
  }
}
