// The simulator's agents. An AgentApp is the agent's own program: its conversations live on whatever AgentChat does
// (a restart of AgentChat loses the adapter, never the app). A SimAdapter is AgentChat's side of it, made anew with
// each Device, and holds only what a real adapter would hold in memory.
import type { Adapter, AdapterSink } from '../../src/device/device.ts';
import type { AgentInfo, Command, Item, SessionInfo } from '../../src/shared/protocol.ts';
import { markTag, recordsCall } from '../../src/shared/protocol.ts';
import type { Rng } from './rng.ts';

/** How an app takes a message sent while a turn runs: into that turn (OpenCode), or as the next turn (Claude Code). */
export type Style = 'join' | 'queue';
/** How the adapter puts a message in: typing into the app's window (can go wrong), or the app's own interface. */
export type Road = 'window' | 'api';
/** How the sending conversation is known: the tool says (Claude Code), or the agent's records of the call show it. */
export type Caller = 'tool' | 'records';

/** `unsearchable`: AgentChat cannot look through this agent's records (no `locate`): only a returned message tells. */
export interface Kind { info: AgentInfo; style: Style; road: Road; caller: Caller; unsearchable?: boolean;
  /** Shows a message waiting for the next turn at once, in no turn yet, and in its turn once that takes it up. */
  showsWaiting?: boolean }

export const KINDS = {
  claude: { info: { id: 'claude-code', kind: 'claude-code', label: 'Claude Code' }, style: 'queue', road: 'window', caller: 'tool' },
  codex: { info: { id: 'codex', kind: 'codex', label: 'Codex' }, style: 'queue', road: 'api', caller: 'records' },
  opencode: { info: { id: 'opencode', kind: 'opencode', label: 'OpenCode' }, style: 'join', road: 'api', caller: 'records' },
} satisfies Record<string, Kind>;

/** What happens to a message typed into a window (the simulator's mischief; all zero = a perfect window). */
export interface WindowChaos { busy: number; busyMs: [number, number]; elsewhere: number; unsent: number; lagMs: [number, number] }
export const CALM: WindowChaos = { busy: 0, busyMs: [0, 0], elsewhere: 0, unsent: 0, lagMs: [0, 0] };

export interface Msg { id: string; at: number; role: 'user' | 'assistant'; text: string; turn: string }
export interface Turn { id: string; start: number; end: number | null; messages: string[] }
/** `taken`: the tags of the messages this conversation has worked on (each once). */
export interface Conv { threadId: string; title: string; msgs: Msg[]; turns: Turn[]; queue: string[]; tools: Item[]; taken: Set<string> }

/** One message landing in a conversation, as the simulator's record of what really happened. */
export interface Landing { at: number; app: string; threadId: string; text: string }

let seq = 0;
const nextId = (p: string) => `${p}${(++seq).toString(36).padStart(6, '0')}`;

export class AgentApp {
  readonly convs = new Map<string, Conv>();
  readonly landings: Landing[] = [];
  /** Called on every change, as an app's files or events announce it. */
  onChange: (threadId: string) => void = () => {};
  readonly name: string;
  readonly kind: Kind;
  private readonly rng: Rng;
  private readonly workMs: [number, number];

  constructor(name: string, kind: Kind, rng: Rng, titles: string[], workMs: [number, number] = [20_000, 180_000]) {
    this.name = name;
    this.kind = kind;
    this.rng = rng;
    this.workMs = workMs;
    for (const title of titles) {
      const threadId = nextId('t');
      this.convs.set(threadId, { threadId, title, msgs: [], turns: [], queue: [], tools: [], taken: new Set() });
    }
  }

  running(c: Conv): Turn | undefined {
    const last = c.turns.at(-1);
    return last && last.end === null ? last : undefined;
  }

  /** A message lands in the conversation: it starts a turn, joins the running one, or waits for the next. */
  land(threadId: string, text: string): void {
    const c = this.convs.get(threadId)!;
    this.landings.push({ at: Date.now(), app: this.name, threadId, text });
    const msg: Msg = { id: nextId('m'), at: Date.now(), role: 'user', text, turn: '' };
    c.msgs.push(msg);
    const turn = this.running(c);
    if (turn && this.kind.style === 'join') {
      msg.turn = turn.id;
      turn.messages.push(msg.id);
    } else if (turn) {
      c.queue.push(msg.id);
    } else this.begin(c, msg);
    this.onChange(threadId);
  }

  private begin(c: Conv, msg: Msg): void {
    const turn: Turn = { id: msg.id, start: Date.now(), end: null, messages: [msg.id] };
    msg.turn = turn.id;
    c.turns.push(turn);
    // A report back only needs reading; a task takes a while.
    const work = msg.text.includes('的汇报') ? 3_000 : this.rng.between(...this.workMs);
    setTimeout(() => this.finish(c, turn), work);
  }

  private finish(c: Conv, turn: Turn): void {
    // As the handbook asks: a message whose envelope names another conversation goes back, one seen before is let be.
    const texts = turn.messages.map((id) => c.msgs.find((m) => m.id === id)!.text);
    const back: string[] = [];
    const take: string[] = [];
    for (const text of texts) {
      const env = /转发给「([^」]*)」 #([0-9a-f]{8})\]/.exec(text);
      if (env && env[1] !== c.title.slice(0, 40)) back.push(env[2]!);
      else if (env && c.taken.has(env[2]!)) continue;
      else {
        if (env) c.taken.add(env[2]!);
        take.push(text);
      }
    }
    const tasks = take.flatMap((t) => [...t.matchAll(/TASK-\d+/g)].map((m) => m[0]));
    turn.end = Date.now();
    const said = [tasks.length ? `做完了：${[...new Set(tasks)].join('、')}` : '收到', ...back.map((t) => `退回 #${t}`)].join('\n');
    c.msgs.push({ id: nextId('m'), at: Date.now(), role: 'assistant', text: said, turn: turn.id });
    const next = c.queue.shift();
    if (next) this.begin(c, c.msgs.find((m) => m.id === next)!);
    this.onChange(c.threadId);
  }

  /**
   * The conversation calls AgentChat's send: the app writes the call down, input and all, a moment later (as agents'
   * apps do), and shows it while it runs.
   */
  calling(threadId: string, input: Record<string, unknown>): () => void {
    const c = this.convs.get(threadId)!;
    const item: Item = { itemId: nextId('call'), turnId: this.running(c)?.id ?? null, kind: 'tool_call', ts: Date.now(),
      data: { tool: 'allinone_send', summary: JSON.stringify(input).slice(0, 200), input, status: 'inProgress', output: '', error: null } };
    setTimeout(() => {
      c.tools.push(item);
      this.onChange(threadId);
    }, this.rng.between(0, 1_500));
    return () => {
      item.data = { ...item.data, status: 'completed' };
      this.onChange(threadId);
    };
  }

  /** The conversation as AgentChat reads it. */
  items(threadId: string): Item[] {
    const c = this.convs.get(threadId)!;
    // A message waiting for the next turn shows only once that turn takes it up (as Claude Code's and Codex's records do).
    const out: Item[] = c.msgs.filter((m) => m.turn || this.kind.showsWaiting)
      .map((m) => ({ itemId: m.id, turnId: m.turn || null, kind: 'message', ts: m.at, data: { role: m.role, text: m.text, clientId: null } }));
    for (const t of c.turns) {
      out.push({ itemId: `turn:${t.id}`, turnId: t.id, kind: 'status', ts: t.end ?? t.start,
        data: { status: t.end === null ? 'inProgress' : 'completed', startedAt: Math.floor(t.start / 1000), completedAt: t.end === null ? null : Math.floor(t.end / 1000), error: null } });
    }
    return out.concat(c.tools);
  }

  session(c: Conv): SessionInfo {
    const turn = this.running(c);
    return { threadId: c.threadId, agentId: this.kind.info.id, title: c.title, cwd: null, updatedAt: Math.floor((c.msgs.at(-1)?.at ?? 0) / 1000),
      running: Boolean(turn), activeTurnId: turn?.id ?? null, preview: c.msgs.at(-1)?.text.slice(0, 80) ?? null } as SessionInfo;
  }
}

/**
 * AgentChat's adapter for a simulated app. Messages for a window wait while the window is busy, and only this copy
 * of the program remembers that they wait (as the real adapters do).
 */
export class SimAdapter implements Adapter {
  readonly info: AgentInfo;
  private sink: AdapterSink | null = null;
  private readonly hydrated = new Set<string>();
  private dead = false;
  private readonly app: AgentApp;
  private readonly rng: Rng;
  private readonly chaos: WindowChaos;

  constructor(app: AgentApp, rng: Rng, chaos: WindowChaos) {
    this.app = app;
    this.rng = rng;
    this.chaos = chaos;
    this.info = app.kind.info;
    if (app.kind.unsearchable) (this as { locate?: unknown }).locate = undefined;
  }

  /** This copy of AgentChat has stopped: what it was doing goes with it. */
  kill(): void {
    this.dead = true;
  }

  async start(sink: AdapterSink): Promise<void> {
    this.sink = sink;
    this.app.onChange = (threadId) => this.changed(threadId);
    sink.sessions([...this.app.convs.values()].map((c) => this.app.session(c)), true);
  }

  private changed(threadId: string): void {
    if (this.dead || !this.sink) return;
    this.sink.sessions([...this.app.convs.values()].map((c) => this.app.session(c)), true);
    if (this.hydrated.has(threadId)) this.sink.items(threadId, this.app.items(threadId));
  }

  hydrate(threadId: string): void {
    if (this.hydrated.has(threadId) || !this.app.convs.has(threadId)) return;
    this.hydrated.add(threadId);
    this.sink?.items(threadId, this.app.items(threadId));
  }

  /** Where messages with this tag are, from the app's own records (queued ones too), as a real adapter reads them. */
  locate(tag: string): string[] {
    return [...this.app.convs.values()].filter((c) => c.msgs.some((m) => m.role === 'user' && markTag(m.text) === tag)).map((c) => c.threadId);
  }

  /** The conversations whose records show, in the last two minutes, a call of AgentChat's tool carrying this message. */
  caller(key: string): string[] {
    return [...this.app.convs.values()]
      .filter((c) => c.tools.some((t) => t.ts > Date.now() - 120_000 && recordsCall(JSON.stringify(t.data), key))).map((c) => c.threadId);
  }

  async command(threadId: string, command: Command): Promise<void> {
    const sink = this.sink!;
    if (command.op !== 'send') return sink.receipt(command.requestId, 'failed', undefined, 'unsupported');
    const text = command.text ?? '';
    if (this.app.kind.road === 'api') {
      this.app.land(threadId, text);
      return sink.receipt(command.requestId, 'accepted');
    }
    // The window: maybe busy for a while (the owner at the keyboard, a turn running), then typed, which can go wrong.
    const c = this.chaos;
    const wait = this.rng.chance(c.busy) ? this.rng.between(...c.busyMs) : 0;
    if (wait) sink.receipt(command.requestId, 'pending', undefined, 'waiting_for_window');
    setTimeout(() => {
      if (this.dead) return;
      const others = [...this.app.convs.keys()].filter((t) => t !== threadId);
      const where = others.length && this.rng.chance(c.elsewhere) ? this.rng.pick(others) : threadId;
      // Typed but never sent (the box kept it), the adapter none the wiser: as a window can fail.
      if (!this.rng.chance(c.unsent)) setTimeout(() => this.app.land(where, text), this.rng.between(...c.lagMs));
      sink.receipt(command.requestId, 'accepted');
    }, wait);
  }
}
