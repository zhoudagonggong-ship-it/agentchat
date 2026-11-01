// Agents reaching each other through AgentChat (the tool's agents / send / wait / read / stop): finding the target,
// the owner's guard rails, the hand-off card in the sender's conversation, and the report back when the work ends.
// What a hand-off still owes its sender lives in the ledger; the hub lends this its devices, the phone's notices
// and its one way into a conversation (submit).
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AgentInfo, Attachment, Command, DeviceToHub, DeviceView, HubSettings, HubToDevice, Item, Origin, RequestView, SessionView, WorkRule } from '../shared/protocol.ts';
import { MAX_ATTACHMENTS, forwardMark, sessionKey, tag } from '../shared/protocol.ts';
import { log } from '../shared/util.ts';
import { activity } from '../activity.ts';
import type { Store } from './store.ts';
import type { Ledger } from './ledger.ts';
import type { Knowledge } from './knowledge.ts';

// Agents handing work to each other: at most this many hand-offs in a row (A→B→C→D), counting what was handed
// on in the last CHAIN_WINDOW_MS, and this many messages an hour from one agent.
const MAX_CHAIN = 3;
const CHAIN_WINDOW_MS = 30 * 60_000;
const MAX_SENDS_PER_HOUR = 60;
const SENDS_LEFT_NOTE = 10; // this few left in the hour: each send says so
/** Title start of the conversations agents keep only for passing work to each other (the phone hides them). */
const CHANNEL_TITLE = 'AgentChat 协作';
/** One of those, including the ones opened while AgentChat was still called AllinOne. */
export const isChannelTitle = (title: string): boolean => title.startsWith(CHANNEL_TITLE) || title.startsWith('AllinOne 协作');
/** How long a sender may still be waiting on its own before its report goes back into its conversation. */
const REPORT_DELAY_MS = 8000;
/** A message the agent's computer holds until the agent's window is free (its previous turn still running, say). */
const waitsForWindow = (r: { state: string; error: string | null }) => r.state === 'pending' && /waiting_for_window/.test(r.error ?? '');
const LATE_REPORT_MS = 30 * 60_000; // a report this long after the work ended says it comes late
const RESEND_WINDOW_MS = 10 * 60_000; // the same message from the same conversation within this is a repeat
/** Added to the first message another agent sends a conversation: what it is, and that the answer goes back by itself. */
const FIRST_CONTACT_NOTE = '\n\n（AgentChat 说明：这条是主人电脑上的另一个 Agent 经 AgentChat 转给你的。照常在这个对话里做事、回复就行，'
  + '做完后 AgentChat 会自动把你的回复带回给它，不用另外发。你也可以用 allinone 工具联系各台电脑上的其他 Agent；'
  + '如果你还没有这个工具，主人重新打开这个对话后就会有。请用中文回答。）';
const REPORT_MAX = 6000;
const READ_FULL_MAX = 200_000; // one message read in full (`read` with full)

/** The agents that keep the rules a hand-off sets for their conversation (their own permission checks). */
const RULE_AGENTS = new Set(['opencode']);
/** What the sender should know when its message went in through the agent's own app on the computer (Codex). */
function inApp(error: string | null): { inApp?: string } {
  if (/in_app_model_unchanged/.test(error ?? '')) return { inApp: '这个对话正开在电脑上的 Codex 软件里，消息交给软件跑，主人看得到；模型用软件里选好的，没有换。停止也在软件里点' };
  if (/\bin_app\b/.test(error ?? '')) return { inApp: '这个对话正开在电脑上的 Codex 软件里，消息交给软件跑，主人看得到；要停止请主人在软件里点' };
  return {};
}

/** The agents a message can tell which model and reasoning level to work with. */
const MODEL_AGENTS = new Set(['codex', 'opencode']);
/** The agents that take a word with an approval's answer (others get it as a message). */
const NOTE_AGENTS = new Set(['opencode']);
/** A 请示 the agent that handed the work over leaves unanswered this long comes to the owner. */
const ESCALATE_MS = 30 * 60_000;
const MAX_RULES = 30;

/** The rules an agent wrote with `send`, checked: [{ tool, match, effect }] (or action / resource). */
export function workRules(raw: unknown): WorkRule[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_RULES) throw new Error(`rules 要是一个列表，最多 ${MAX_RULES} 条`);
  return raw.map((r: any) => {
    const action = String(r?.tool ?? r?.action ?? '').trim();
    const resource = String(r?.match ?? r?.resource ?? '').trim();
    const effect = String(r?.effect ?? '').trim();
    if (!/^[a-z_]{2,30}$/.test(action) || !resource || resource.length > 300 || !['allow', 'deny', 'ask'].includes(effect)) {
      throw new Error(`规矩写得不对：${JSON.stringify(r).slice(0, 120)}。每条是 { tool: "edit" 或 "shell" 等, match: "匹配文件路径或命令的通配符", effect: "ask" 或 "deny" 或 "allow" }`);
    }
    return { action, resource, effect: effect as WorkRule['effect'] };
  });
}

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

/** The tags an agent sends back (「退回 #1a2b3c4d」: a message meant for another conversation reached it). */
export function returnedMarks(text: unknown): string[] {
  return [...String(text ?? '').matchAll(/退回\s*#([0-9a-f]{8})\b/g)].map((m) => m[1]!);
}

/** A computer's connection, as the hub keeps it. */
export interface Conn { send(msg: HubToDevice): void }

/** What the hub lends the relay. */
export interface RelayPort {
  readonly store: Store;
  readonly knowledge: Knowledge;
  readonly hubId: string;
  /** Connected computers, by id. */
  readonly devices: Map<string, Conn>;
  settings(): HubSettings;
  /** Takes a request into a conversation; returns why it was refused, as the owner reads it. */
  submit(sessionId: string, command: Command, origin?: Origin, delivered?: boolean, handoffFrom?: string): string | { view: RequestView; created: boolean };
  putItems(sessionId: string, items: Item[]): void;
  notice(n: { type: 'done' | 'approval' | 'agent'; sessionId: string; title: string; text: string }): void;
  /** Sends a stored request to its computer once more, as attempt `attempt`. */
  resend(requestId: string, attempt: number): void;
  /** Gives a request up as failed (the owner and, for a hand-off, its sender hear of it). */
  fail(requestId: string, error: string): void;
}

/** A message not found where it belongs goes again this many times before it is given up. */
const MAX_ATTEMPTS = 2;
const UNCONFIRMED_MS = 5 * 60_000;
// Messages typed into an app's window, which can miss (go into another conversation, or not go at all). Every other
// agent takes them through its own interface and says plainly whether it did.
const typedInWindow = (agentId: string) => agentId === 'claude-code';
/** A message put in that its computer never said it found (the computer restarted while looking, say) is looked into. */

export class Relay {
  private readonly port: RelayPort;
  private readonly store: Store;
  private readonly devices: Map<string, Conn>;
  private readonly hubId: string;
  /** New conversations asked of computers, waiting for `created`. */
  private readonly creates = new Map<number, (r: { threadId?: string; sent?: boolean; error?: string }) => void>();
  private createSeq = 0;
  private readonly floodNoticed = new Map<string, number>();
  /** Reports about to go (waiting REPORT_DELAY_MS for a sender that may still take the outcome itself). */
  private readonly reporting = new Set<string>();

  constructor(port: RelayPort) {
    this.port = port;
    this.store = port.store;
    this.devices = port.devices;
    this.hubId = port.hubId;
    // Approvals raised in handed-over work, and the conversation of the agent that answers them (see routeFor).
    this.store.db.exec(`CREATE TABLE IF NOT EXISTS approval_routes (approval_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, item_id TEXT NOT NULL,
      from_session TEXT NOT NULL, request_id TEXT NOT NULL, at INTEGER NOT NULL, escalated INTEGER NOT NULL DEFAULT 0)`);
    // `asked`: its 请示 went into the sender's conversation (one waits while an earlier one is unanswered: see askSender).
    if (!(this.store.db.prepare('PRAGMA table_info(approval_routes)').all() as { name: string }[]).some((c) => c.name === 'asked')) {
      this.store.db.exec('ALTER TABLE approval_routes ADD COLUMN asked INTEGER NOT NULL DEFAULT 1');
    }
  }

  // ---------- approvals in handed-over work: the agent that handed it over answers them ----------

  /**
   * The owner sets the work; the agent it was handed to answers to the agent that handed it over, as an employee to
   * the one who gave the job. So an approval or question raised in work an agent handed over goes to that agent's
   * conversation, as a 请示 it answers with `approve`; the owner is not asked. Unanswered for ESCALATE_MS, it comes
   * to the owner after all. Work the owner gave directly, and AgentChat's own cards, stay the owner's.
   * Returns whom the approval waits for (the sender's conversation), or null when it is the owner's.
   */
  routeFor(sessionId: string, item: Item): { to: string; escalated: boolean } | null {
    if (item.kind !== 'approval_request' || item.data.kind === 'delivery') return null;
    const approvalId = String(item.data.approvalId ?? '');
    if (!approvalId) return null;
    const known = this.store.db.prepare('SELECT from_session, escalated FROM approval_routes WHERE approval_id = ?').get(approvalId) as
      { from_session: string; escalated: number } | undefined;
    if (known) return { to: this.store.session(known.from_session)?.title ?? '派活方', escalated: Boolean(known.escalated) };
    if (item.data.state !== 'pending') return null;
    // A card the hub had already (brought again after a restart, say) was raised for earlier work: the owner's. The
    // computers' clocks differ, so its own time cannot tell.
    if (this.store.item(sessionId, item.itemId)) return null;
    // The latest hand-off into this conversation whose outcome its sender still waits for.
    const h = this.ledger.due(sessionId).at(-1);
    const sender = h && this.store.session(h.fromSession);
    if (!h || !sender || sender.archived) return null;
    this.store.db.prepare('INSERT INTO approval_routes(approval_id, session_id, item_id, from_session, request_id, at, asked) VALUES (?, ?, ?, ?, ?, ?, 0)')
      .run(approvalId, sessionId, item.itemId, h.fromSession, h.requestId, Date.now());
    setTimeout(() => this.askSender(sessionId, h.fromSession), 0); // once the card is kept
    return { to: sender.title, escalated: false };
  }

  /** What a card asks for, in a line. */
  private static what(d: Record<string, any>): string {
    return d.kind === 'question' ? '问你问题'
      : d.kind === 'file' ? `改文件：${d.reason ?? ''}`
        : d.kind === 'command' ? `执行命令：${d.command ?? ''}`
          : `${d.reason ?? d.command ?? '做一件要批准的事'}`;
  }

  /**
   * The 请示 of one conversation's work into its sender's conversation. While one sent there is still unanswered, the
   * next ones wait: once it is answered they go together, in one message, so an agent asking about every command
   * does not flood the sender with a message each.
   */
  private askSender(sessionId: string, fromSession: string): void {
    type Row = { approval_id: string; item_id: string; request_id: string; asked: number };
    const rows = (this.store.db.prepare('SELECT approval_id, item_id, request_id, asked FROM approval_routes WHERE session_id = ? AND from_session = ? AND escalated = 0 ORDER BY at')
      .all(sessionId, fromSession) as Row[]).filter((r) => this.store.item(sessionId, r.item_id)?.data.state === 'pending');
    if (!rows.length || rows.some((r) => r.asked)) return; // nothing new, or the sender still has one to answer
    const target = this.store.session(sessionId);
    const sender = this.store.session(fromSession);
    const payload = this.ledger.payload(rows.at(-1)!.request_id);
    if (!target || !sender || !payload?.origin) return;
    const device = this.store.device(target.deviceId);
    const agent = (JSON.parse(device?.agents ?? '[]') as AgentInfo[]).find((a) => a.id === target.agentId);
    const label = `${device?.name ?? ''} · ${agent?.label ?? target.agentId}`;
    const asked = String(payload.text ?? '').replace(/^\[来自 [^\]]*\]\s*/, '').split('\n')[0]!.slice(0, 60);
    const items = rows.map((r) => ({ id: r.approval_id, d: this.store.item(sessionId, r.item_id)!.data }));
    const one = items.length === 1;
    const lines = items.map(({ id, d }, i) => {
      const questions = d.kind === 'question' && Array.isArray(d.questions)
        ? '\n' + (d.questions as { key: string; question?: string; text?: string; title?: string; description?: string; options?: { label?: string; value?: string }[] }[]).map((q) =>
          `   - ${q.key}：${q.question ?? q.description ?? q.title ?? q.text ?? ''}${q.options?.length ? `（可选：${q.options.map((o) => o.value ?? o.label).join(' / ')}）` : ''}`).join('\n')
        : '';
      return `${one ? '' : `${i + 1}. `}[approval "${id}"] 它要${Relay.what(d).slice(0, one ? 1500 : 400)}${questions}`;
    });
    const how = `用 allinone 的 approve 逐条答复（approval 写上面的编号）：decision 写 allow（只批这一条）、allow_all（批这条，并且这一轮里同类的不再问）或 deny（不批）；`
      + 'message 里可以说明原因或下一步怎么做，它会收到。问问题的那条用 answers 按键回答。';
    const id = randomUUID().replaceAll('-', '');
    const text = `${forwardMark(`${label}「${target.title.slice(0, 40)}」的请示`, id, sender.title)} 你派的「${asked}」做到一半，`
      + `${one ? '有一件事' : `有 ${items.length} 件事`}停下来等你批：\n\n${lines.join('\n')}\n\n`
      + `${how}它会一直等你的答复；${Math.round(ESCALATE_MS / 60_000)} 分钟内你没答复，就交给老周处理。这期间它再有请示，会等你答完这些再一起发来。`;
    const origin: Origin = { deviceId: target.deviceId, agentId: target.agentId, label, sessionId: target.id, depth: Math.max(0, (payload.origin.depth ?? 1) - 1) };
    const result = this.port.submit(fromSession, { requestId: id, op: 'send', text, origin }, origin);
    if (typeof result === 'string') {
      // Nobody to ask over there: the owner answers them now.
      log('relay', `请示 to ${sender.title} not delivered: ${result}`);
      for (const r of rows) this.escalate(r.approval_id, `请示没能送到「${sender.title}」（${result}）`);
      return;
    }
    const mark = this.store.db.prepare('UPDATE approval_routes SET asked = 1 WHERE approval_id = ?');
    for (const r of rows) mark.run(r.approval_id);
    activity(`${label}「${target.title}」的 ${items.length} 条请示已转给派活方「${sender.title}」：${Relay.what(items[0]!.d).slice(0, 60)}`);
  }

  private route(approvalId: string): { approval_id: string; session_id: string; item_id: string; from_session: string; request_id: string; at: number; escalated: number } | undefined {
    return this.store.db.prepare('SELECT * FROM approval_routes WHERE approval_id = ?').get(approvalId) as never;
  }

  /** The owner answers it after all: the card comes to 待我处理, and the phone hears of it. */
  private escalate(approvalId: string, why: string): void {
    const route = this.route(approvalId);
    if (!route || route.escalated) return;
    this.store.db.prepare('UPDATE approval_routes SET escalated = 1 WHERE approval_id = ?').run(approvalId);
    const item = this.store.item(route.session_id, route.item_id);
    if (!item || item.data.state !== 'pending') return;
    const { routedTo, ...data } = item.data;
    this.port.putItems(route.session_id, [{ ...item, data: { ...data, escalatedFrom: routedTo ?? this.store.session(route.from_session)?.title ?? '派活方' } }]);
    const title = this.store.session(route.session_id)?.title ?? '对话';
    this.port.notice({ type: 'approval', sessionId: route.session_id, title, text: `${why}：${String(item.data.command ?? item.data.reason ?? '需要你确认')}` });
    activity(`「${title}」的请示交给老周处理：${why}`, 'warn');
  }

  /** The sender answers a 请示 sent to it (the AgentChat tool's `approve`). */
  private askApprove(origin: Origin, args: Record<string, unknown>): unknown {
    const approvalId = String(args.approval ?? '').trim();
    const route = this.route(approvalId);
    if (!route) throw new Error('没有这条请示：approval 写请示里给的编号');
    const sender = this.store.session(route.from_session);
    if (!sender || sender.deviceId !== origin.deviceId || sender.agentId !== origin.agentId) throw new Error('这条请示不是发给你的');
    const item = this.store.item(route.session_id, route.item_id);
    if (!item || item.data.state !== 'pending') return { state: 'settled', note: `这条请示已经处理过了（${item?.data.state ?? '对方那边已经没有了'}），不用再答` };
    const decision = args.decision === 'allow' ? 'accept' : args.decision === 'allow_all' ? 'acceptForSession' : args.decision === 'deny' ? 'decline' : null;
    if (!decision) throw new Error('decision 要写 allow、allow_all 或 deny');
    const answers = args.answers && typeof args.answers === 'object' ? Object.fromEntries(Object.entries(args.answers as object).map(([k, v]) => [k, String(v)])) : undefined;
    if (item.data.kind === 'question' && decision !== 'decline' && !answers) throw new Error('这是在问你问题：用 answers 回答，键见请示里列的');
    const note = typeof args.message === 'string' && args.message.trim() ? args.message.trim() : undefined;
    const result = this.port.submit(route.session_id, { requestId: randomUUID().replaceAll('-', ''), op: 'approve', approvalId, decision, ...(answers ? { answers } : {}),
      ...(note ? { note } : {}) }, origin);
    if (typeof result === 'string') throw new Error(result);
    const target = this.store.session(route.session_id)!;
    // An agent that cannot take a word with the answer gets it as a message (it joins its running turn).
    const kind = (JSON.parse(this.store.device(target.deviceId)?.agents ?? '[]') as AgentInfo[]).find((a) => a.id === target.agentId)?.kind;
    if (note && !NOTE_AGENTS.has(String(kind))) {
      const id = randomUUID().replaceAll('-', '');
      this.port.submit(route.session_id, { requestId: id, op: 'send', text: `${forwardMark(`${origin.label}「${sender.title.slice(0, 40)}」对你请示的答复`, id, target.title)} ${note}`, origin }, origin);
    }
    activity(`派活方「${sender.title}」${decision === 'decline' ? '没批准' : decision === 'acceptForSession' ? '批准（同类都批）' : '批准'}了「${target.title}」的请示${note ? `：${note.slice(0, 60)}` : ''}`);
    // Once it is answered, the 请示 that waited behind it go (together).
    setTimeout(() => {
      try {
        this.askSender(route.session_id, route.from_session);
      } catch (error) {
        log('relay', `waiting 请示 not sent: ${(error as Error).message}`); // the next minute's watch sends them
      }
    }, 4000).unref();
    return { state: 'sent', decision: args.decision };
  }

  private get ledger(): Ledger {
    return this.store.ledger;
  }

  /**
   * Picks up after the hub restarted: hand-offs still owed are followed from the ledger as before, and one whose work
   * ended meanwhile gets its report now (it says how late it is).
   */
  resume(): void {
    for (const sessionId of new Set(this.ledger.due().map((h) => h.sessionId))) this.refreshHandoffs(sessionId);
  }

  /** A computer made the conversation asked of it (or could not). */
  created(msg: Extract<DeviceToHub, { t: 'created' }>): void {
    this.creates.get(msg.id)?.(msg);
    this.creates.delete(msg.id);
  }

  // ---------- where a message really went ----------

  /**
   * A computer looked through its agent's records for a message it put in. In the conversation it was for: done. In
   * another one: that one is told to leave it, the owner hears of it, and once the looking is over it goes again where
   * it belongs. Not found at all: an agent that took it through its own interface (Codex, OpenCode) said so, and its
   * word stands; it may write it down only later, after a long command, and nothing goes a second time on a guess.
   * Only a message typed into a window (Claude Code) can be lost on the way, so only that one goes again.
   */
  landed(deviceId: string, msg: Extract<DeviceToHub, { t: 'landed' }>): void {
    const r = this.ledger.get(msg.requestId);
    const l = this.ledger.landing(msg.requestId);
    if (!r || !l || r.state === 'failed' || r.state === 'cancelled') return;
    if (msg.found === null) return this.ledger.setLanded(r.requestId, 'unknown');
    const where = msg.found.map((t) => sessionKey(deviceId, msg.agentId, t));
    for (const wrong of where.filter((s) => s !== r.sessionId)) this.misplaced(r, wrong);
    if (where.includes(r.sessionId)) return this.ledger.setLanded(r.requestId, 'here');
    if (!msg.done || msg.attempt !== l.attempt) return;
    if (where.length) this.retry(r, '送进了别的对话');
    else if (typedInWindow(msg.agentId)) this.retry(r, '没有出现在对话里');
  }

  /** Every minute: what was typed into a window but never reported found (its computer restarted while looking, say) is looked into again. */
  watch(): void {
    for (const r of this.ledger.unconfirmed(Date.now() - UNCONFIRMED_MS)) {
      const session = this.store.session(r.sessionId);
      if (session && typedInWindow(session.agentId) && this.devices.has(session.deviceId)) this.retry(r, '电脑没有确认送到');
    }
    // 请示 their senders left unanswered: the owner's now. Answered ones are forgotten after a day.
    this.store.db.prepare('DELETE FROM approval_routes WHERE at < ?').run(Date.now() - 86_400_000);
    const late = this.store.db.prepare('SELECT approval_id, session_id, item_id FROM approval_routes WHERE escalated = 0 AND at < ?')
      .all(Date.now() - ESCALATE_MS) as { approval_id: string; session_id: string; item_id: string }[];
    for (const r of late) {
      if (this.store.item(r.session_id, r.item_id)?.data.state === 'pending') this.escalate(r.approval_id, `派活方 ${Math.round(ESCALATE_MS / 60_000)} 分钟没有答复`);
    }
    // 请示 that waited behind one since answered (on the phone, say, or it was let go): they go now.
    const waiting = this.store.db.prepare('SELECT DISTINCT session_id, from_session FROM approval_routes WHERE asked = 0 AND escalated = 0').all() as { session_id: string; from_session: string }[];
    for (const w of waiting) this.askSender(w.session_id, w.from_session);
  }

  private retry(r: RequestView, why: string): void {
    const l = this.ledger.landing(r.requestId)!;
    const target = this.store.session(r.sessionId)?.title ?? '对话';
    const mark = `#${tag(r.requestId)}`;
    if (l.attempt >= MAX_ATTEMPTS) {
      this.ledger.setLanded(r.requestId, 'lost');
      activity(`消息 ${mark} 送了 ${l.attempt + 1} 次都没送进「${target}」（${why}），已放弃：${this.firstLine(r.requestId)}`, 'warn');
      return this.port.fail(r.requestId, `没送进对方的对话（${why}，试了 ${l.attempt + 1} 次）`);
    }
    const attempt = this.ledger.nextAttempt(r.requestId);
    log('relay', `${mark} ${why}: sending it to ${target} again (attempt ${attempt})`);
    this.port.resend(r.requestId, attempt);
  }

  /**
   * It went into another conversation by mistake: that conversation hears it is not for it (the mark names whom it is
   * for, too), and the owner hears what happened.
   */
  private misplaced(r: RequestView, wrong: string): void {
    if (!this.ledger.addMisplaced(r.requestId, wrong)) return;
    const mark = `#${tag(r.requestId)}`;
    const target = this.store.session(r.sessionId)?.title ?? '对话';
    const there = this.store.session(wrong)?.title ?? '另一个对话';
    // Put right by AgentChat itself: recorded, not reminded of (the owner hears of what needs them).
    activity(`消息 ${mark} 误送进了「${there}」（本该给「${target}」），已让它忽略，并重新送往「${target}」：${this.firstLine(r.requestId)}`, 'warn');
    this.port.submit(wrong, { requestId: randomUUID().replaceAll('-', ''), op: 'send',
      text: `[AgentChat 更正 ${mark}] 刚才那条带 ${mark} 的消息是误投，它是发给「${target}」的，不是给你的：请不要处理，也不用回复。` });
  }

  /**
   * A conversation sent a message back (「退回 #1a2b3c4d」): it got one meant for another. Dealt with as a mistake found
   * by looking, unless that was found already; it goes where it belongs if it is not there yet, however late.
   */
  returned(sessionId: string, mark: string): void {
    const r = this.ledger.byTagAnywhere(mark);
    if (!r) return;
    const there = this.store.session(sessionId)?.title ?? '一个对话';
    const target = this.store.session(r.sessionId)?.title ?? '对话';
    if (r.sessionId === sessionId) {
      if (this.ledger.addMisplaced(r.requestId, `returned-by-addressee:${sessionId}`)) {
        activity(`「${there}」把发给它自己的消息 #${mark} 退回了，没有重发，请看一下：${this.firstLine(r.requestId)}`, 'warn');
      }
      return;
    }
    if (!this.ledger.addMisplaced(r.requestId, sessionId)) return;
    const minutes = Math.round((Date.now() - r.createdAt) / 60_000);
    const l = this.ledger.landing(r.requestId)!;
    const arrived = l.landed === 'here' || r.state === 'delivered';
    activity(`消息 #${mark} 误送进了「${there}」，它在发出 ${minutes} 分钟后退回了${arrived ? `；「${target}」那边已经收到` : `，正在重新送往「${target}」`}：${this.firstLine(r.requestId)}`, 'warn');
    if (!arrived && r.state !== 'failed' && r.state !== 'cancelled') this.retry(r, `被「${there}」退回`);
  }

  private firstLine(requestId: string): string {
    return String(this.ledger.payload(requestId)?.text ?? '').replace(/^\[来自 [^\]]*\]\s*/, '').split('\n')[0]!.slice(0, 40);
  }

  async onAsk(conn: Conn, deviceId: string, msg: Extract<DeviceToHub, { t: 'ask' }>): Promise<void> {
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
              : msg.op === 'stop' ? await this.askStop(origin, msg.args)
                : msg.op === 'approve' ? this.askApprove(origin, msg.args)
                : msg.op === 'know' ? this.port.knowledge.know(msg.args)
                  : msg.op === 'learn' ? this.learned(origin, this.port.knowledge.learn(msg.args, origin.label), msg.args)
                    // The owner's handbook, put in by the Claude Code that keeps it for the owner (tools/knowledge-import.ts).
                    : msg.op === 'import' && agent.id === 'claude-code' ? this.learned(origin, this.port.knowledge.importRules(msg.args, origin.label), { title: '协作手册' }) : null;
      if (result === null) throw new Error('不支持的操作');
      conn.send({ t: 'answer', id: msg.id, result });
    } catch (error) {
      conn.send({ t: 'answer', id: msg.id, error: (error as Error).message });
    }
  }

  /** Recorded where the owner looks back, as everything agents do through AgentChat is. */
  private learned(origin: Origin, result: unknown, args: Record<string, unknown>): unknown {
    activity(`${origin.label} 在知识库里记下了「${String(args.title ?? '').slice(0, 40)}」`);
    return result;
  }

  /** Every computer's agents with their latest conversations, by the names the phone shows. */
  private askAgents(): unknown {
    const online = new Set(this.devices.keys());
    const remarks = new Map(this.store.friends().map((f) => [`${f.deviceId}|${f.agentId}`, f.remark]));
    return this.store.devices(online, this.hubId).filter((d) => d.approved).flatMap((d) => d.agents.map((a) => ({
      name: `${d.name} · ${a.label}`, remark: remarks.get(`${d.id}|${a.id}`) ?? null, online: d.online,
      conversations: this.store.recentSessions(d.id, a.id, 8).map((s) => ({ id: s.id, title: s.title, running: s.running, updatedAt: s.updatedAt,
        ...(s.model ? { model: s.model } : {}), ...(s.background ? { background: s.background } : {}) })),
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
    // Its name now; the name it had before a rename; part of a name, only when that names one conversation alone.
    const exact = sessions.find((s) => s.title === title || s.threadId === title) ?? this.store.formerlyNamed(d.id, a.id, title);
    if (exact) return exact.id;
    const part = sessions.filter((s) => s.title.includes(title));
    if (part.length === 1) return part[0]!.id;
    if (part.length > 1) throw new Error(`「${d.name} · ${a.label}」里有几个对话的名字含「${title}」：${part.slice(0, 5).map((s) => `「${s.title}」`).join('、')}，请写全名或用 conversationId`);
    throw new Error(`「${d.name} · ${a.label}」里没有叫「${title}」的对话，先用 agents 看看现在的名字`);
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
    // One of that name already, or one the owner renamed since: the work goes on there, not in a second one.
    const existing = this.store.recentSessions(d.id, a.id, 500).find((s) => s.title === title) ?? (named ? this.store.formerlyNamed(d.id, a.id, title) : undefined);
    if (existing) return { sessionId: existing.id, sent: false };
    const cwd = String(args.cwd ?? '').trim(); // empty: the agent's own default folder
    const conn = this.devices.get(d.id);
    if (!conn) throw new Error(`${d.name} 不在线，不能新建对话`);
    const id = ++this.createSeq;
    // The files go along, as with any message: an agent starting the conversation with `first` saves them first.
    const data = first.files?.map((f) => readFileSync(this.store.artifact(f.sha256)!.path).toString('base64'));
    // Goose types it into its window, Claude Code starts a run: either may take a while.
    const { threadId, sent } = await new Promise<{ threadId: string; sent: boolean }>((resolve, reject) => {
      const timer = setTimeout(() => (this.creates.delete(id), reject(new Error('对方电脑没有回应'))), 120_000);
      this.creates.set(id, (r) => (clearTimeout(timer), r.threadId ? resolve({ threadId: r.threadId, sent: Boolean(r.sent) }) : reject(new Error(createError(r.error)))));
      conn.send({ t: 'create', id, agentId: a.id, cwd, title, first, ...(data?.length ? { data } : {}) });
    });
    const sessionId = sessionKey(d.id, a.id, threadId);
    for (let i = 0; i < 40 && !this.store.session(sessionId); i++) await new Promise((r) => setTimeout(r, 250));
    if (!this.store.session(sessionId)) throw new Error('新对话已建好，但主电脑还没收到它，请稍后用 agents 查到后再发');
    if (named) activity(`${origin.label} 在「${d.name} · ${a.label}」新建了对话「${title}」`);
    return { sessionId, sent };
  }

  /**
   * The owner's guard rails, checked before an agent's message goes anywhere: agents may reach each other at all,
   * this one takes messages from agents, the chain of hand-offs is short, the sender is not flooding.
   * Returns the depth the new message takes in its chain.
   */
  private guard(origin: Origin, deviceId: string, agentId: string, targetSession?: string, newNamed = false): number {
    if (!this.port.settings().agentLinks) throw new Error('主人在手机上关闭了 Agent 互通');
    // The same agent may pass word to another of its own existing conversations (say, two Claude Code chats on
    // one computer), or start a new named one beside it; never to the conversation it is working in, nor to
    // "itself" without naming a conversation.
    if (deviceId === origin.deviceId && agentId === origin.agentId && !newNamed) {
      const own = this.workingConversation(origin);
      if (!targetSession || !own || own.id === targetSession) throw new Error('不能发给自己');
    }
    if (!this.store.acceptsAgents(deviceId, agentId)) throw new Error('主人设置了这个 Agent 不接收其他 Agent 的消息');
    // Counted along the conversation the sender works in: what the owner asked there starts a new chain. With no
    // working conversation to go by, the hand-offs it received lately stand in.
    const since = Date.now() - CHAIN_WINDOW_MS;
    const from = this.workingConversation(origin);
    const depth = (from ? this.ledger.turnDepth(from.id, since) : this.ledger.chainDepth(origin.deviceId, origin.agentId, since)) + 1;
    if (depth > MAX_CHAIN) throw new Error(`已经转了 ${depth - 1} 手，最多 ${MAX_CHAIN} 手：请把结果交回给发起的 Agent，不要再往下转`);
    if (this.ledger.agentSends(origin.deviceId, origin.agentId, Date.now() - 3_600_000) >= MAX_SENDS_PER_HOUR) {
      // Once an hour per sender: the owner hears of it, not of every refused message.
      const key = `${origin.deviceId}|${origin.agentId}`;
      if ((this.floodNoticed.get(key) ?? 0) < Date.now() - 3_600_000) {
        this.floodNoticed.set(key, Date.now());
        this.port.notice({ type: 'agent', sessionId: '', title: 'Agent 发消息太频繁', text: `${origin.label} 一小时内发了 ${MAX_SENDS_PER_HOUR} 条，之后的先拦下了` });
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
    const depth = to ? this.guard(origin, to.d.id, to.a.id, named, !args.newConversation && Boolean(String(args.title ?? '').trim())) : (() => {
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
    // Whom it is for, on the envelope: an agent it reaches by mistake can see it is not for it.
    const newTitle = String(args.title ?? '').trim();
    const toTitle = args.newConversation ? undefined : newTitle || this.store.session(this.findTarget(args))?.title;
    const command: Command = { requestId, op: 'send', text: `${forwardMark(mark, requestId, toTitle)} ${text}`, origin, ...(files.length ? { files } : {}) };
    // The same message sent again from the same conversation (a retry after no answer, say): one task, not two.
    if (!args.newConversation && !args.title) {
      const again = this.ledger.recentSends(this.findTarget(args), origin, Date.now() - RESEND_WINDOW_MS).find((r) => {
        const body = String((this.ledger.payload(r.requestId) as Command | undefined)?.text ?? '').replace(/^\[来自 [^\]]*\]\s*/, '');
        // (with the notes AgentChat added after it)
        return body === text || body.startsWith(`${text}\n\n（`);
      });
      if (again) {
        const target = this.store.session(again.sessionId)!;
        return { task: again.requestId, conversationId: again.sessionId, title: target.title, state: again.state,
          note: `这条和 ${Math.max(1, Math.round((Date.now() - again.createdAt) / 60_000))} 分钟内发过的一条相同，没有再发；进度用 read 看` };
      }
    }
    // What the shared knowledge says about the work, for the computer it is done on: the receiver starts out knowing it.
    const making = Boolean(args.newConversation || args.title);
    const there = making ? null : this.store.session(this.findTarget(args))!;
    // The rules the sender sets for the work, where the agent doing it can keep them.
    const rules = workRules(args.rules);
    const targetKind = making ? to!.a.kind : (JSON.parse(this.store.device(there!.deviceId)?.agents ?? '[]') as AgentInfo[]).find((a) => a.id === there!.agentId)?.kind;
    const rulesKept = rules.length > 0 && RULE_AGENTS.has(String(targetKind));
    if (rulesKept) command.rules = rules;
    // The model and reasoning level it should work with, where the agent can be told.
    const model = typeof args.model === 'string' && args.model.trim() ? args.model.trim() : undefined;
    const effort = typeof args.effort === 'string' && args.effort.trim() ? args.effort.trim() : undefined;
    for (const v of [model, effort]) if (v && !/^[\w./:@-]{1,100}$/.test(v)) throw new Error(`「${v}」不像模型名或推理强度：用 agents 看对方对话现在的模型写法`);
    const modelKept = Boolean(model || effort) && MODEL_AGENTS.has(String(targetKind));
    if (modelKept) Object.assign(command, model ? { model } : {}, effort ? { effort } : {});
    command.text += this.port.knowledge.related(text, making ? to!.d.name : this.store.device(there!.deviceId)?.name ?? '', there?.id ?? `new:${requestId}`);
    const created = making ? await this.createFor(origin, args, command) : null;
    const sessionId = created?.sessionId ?? this.findTarget(args);
    // A conversation that never had a message from another agent (one opened before AgentChat was there, say) learns
    // in a few lines what this is and that its answer goes back by itself.
    if (!created && !this.ledger.hasAgentMessages(sessionId)) command.text += FIRST_CONTACT_NOTE;
    const target = this.store.session(sessionId)!;
    // Follow the conversation in full, as opening it on the phone does: its turns and their end must reach the hub.
    if (!target.hydrated) {
      this.store.setHydrated(sessionId);
      this.devices.get(target.deviceId)?.send({ t: 'hydrate', agentId: target.agentId, threadId: target.threadId });
    }
    const result = this.port.submit(sessionId, command, origin, created?.sent, from?.id);
    if (typeof result === 'string') throw new Error(result);
    activity(`${origin.label} → ${target.title}：发了一条消息`);
    if (from) this.placeHandoff(from.id, requestId, target, text);
    // Every message should be known by its sender's conversation: one that is not is a fault, to look into at once.
    else activity(`认不出 ${origin.label} 是从哪个对话发的消息 #${tag(requestId)}（发往「${target.title}」），汇报没法自动送回：${text.split('\n')[0]!.slice(0, 40)}`, 'warn');
    // Near the hour's limit: the sender learns it before a message is refused.
    const left = MAX_SENDS_PER_HOUR - this.ledger.agentSends(origin.deviceId, origin.agentId, Date.now() - 3_600_000);
    const asked = String(args.newConversation ? '' : args.title || args.conversation || '').trim();
    const notes = [
      ...(asked && asked !== target.title && asked !== target.threadId && this.store.formerlyNamed(target.deviceId, target.agentId, asked)?.id === sessionId
        ? [`「${asked}」已改名为「${target.title}」，消息发到了改名后的这个对话；以后请用新名字或 conversationId`] : []),
      ...(from ? [] : ['没认出你是从自己的哪个对话发的（你同时开着几个），对方做完不会自动把汇报发回给你，请过一会儿用 read 查看结果']),
      ...(rulesKept ? [`已给对方的对话设上 ${rules.length} 条规矩；碰到「ask」的，它会停下来，请示会发到你这个对话，用 approve 答复`] : []),
      ...(rules.length && !rulesKept ? ['对方这种 Agent 还不支持派活规矩，规矩没有设上：要守的规矩请写在消息里'] : []),
      ...(modelKept ? [`已要求对方从这条消息起用 ${[model, effort].filter(Boolean).join(' · ')}；对方不认会报错，对话正开在 Codex 软件里时换不了（wait 会说明），以 read 或 agents 显示的为准`] : []),
      ...((model || effort) && !modelKept ? ['对方这种 Agent 还不支持经 AgentChat 换模型，模型没有换：请主人在对方软件里手动切换'] : []),
      // The Codex app reads its list of conversations when it starts: one made since shows after it restarts.
      ...(created && targetKind === 'codex' ? ['新对话已建好，正常工作；但电脑上的 Codex 软件要重启一次才会在列表里显示它（主人想在软件里看时，请告诉他）'] : []),
      ...(left <= SENDS_LEFT_NOTE ? [`这一小时还能发 ${Math.max(0, left)} 条（每小时最多 ${MAX_SENDS_PER_HOUR} 条），核对请多用 read`] : []),
    ];
    return { task: requestId, conversationId: sessionId, title: target.title, state: result.view.state, ...(notes.length ? { note: notes.join('；') } : {}) };
  }

  /**
   * The conversation the agent sends from, as its computer found it in the agent's own records (or its tool said).
   * Never guessed from what is running: a wrong guess sends the report into the wrong conversation.
   */
  private workingConversation(origin: Origin): SessionView | null {
    const own = origin.sessionId ? this.store.session(origin.sessionId) : undefined;
    return own && !own.archived ? own : null;
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
    this.port.putItems(sessionId, [item]);
  }

  /**
   * Brings the cards of the hand-offs whose work runs in `targetSessionId` up to date (its turns, approvals, delivery
   * changed), and once the work has ended, sends the sender its report.
   */
  refreshHandoffs(targetSessionId: string): void {
    const due = this.ledger.due(targetSessionId);
    // Messages a sender added while the other agent ran end with that one turn: one report covers them all.
    const reported = new Set<string>();
    for (const h of due) {
      const now = this.handoffState(h.requestId);
      if (!now) continue;
      const ended = ['done', 'failed', 'interrupted'].includes(now.state);
      const card = this.store.item(h.fromSession, `handoff:${h.requestId}`);
      if (card) {
        const data = { ...card.data, state: now.state, reply: now.reply ?? card.data.reply, error: now.error ?? null,
          endedAt: ended ? (card.data.endedAt ?? Date.now()) : null };
        if (JSON.stringify(data) !== JSON.stringify(card.data)) this.port.putItems(h.fromSession, [{ ...card, data }]);
      }
      // Still owed and the work over: the report goes, however late the end was learned (a restart in between, a
      // computer that told of it late). The ledger keeps it owed until it has gone.
      if (!ended || this.reporting.has(h.requestId)) continue;
      const turnId = this.ledger.get(h.requestId)?.turnId;
      const together = `${h.fromSession}|${turnId ?? h.requestId}`;
      if (reported.has(together)) {
        this.ledger.settle(h.requestId, 'sent');
        continue;
      }
      reported.add(together);
      const added = turnId ? due.filter((o) => o !== h && o.fromSession === h.fromSession && this.ledger.get(o.requestId)?.turnId === turnId).length : 0;
      // A sender still waiting takes the outcome itself within moments; otherwise it gets the report.
      this.reporting.add(h.requestId);
      setTimeout(() => {
        this.reporting.delete(h.requestId);
        this.reportBack(h.requestId, h.fromSession, h.sessionId, this.handoffState(h.requestId) ?? now, added);
      }, REPORT_DELAY_MS);
    }
  }

  /**
   * The work one agent handed another has ended and the sender did not wait for it: the report goes into the
   * sender's own conversation, as the owner typing it there would, so the sender carries on with it. It is a reply,
   * not a new hand-off: it keeps the sender's own place in the chain.
   */
  private reportBack(requestId: string, senderSessionId: string, targetSessionId: string, outcome: { state: string; reply?: string; error?: string | null }, added = 0): void {
    if (this.ledger.owed(requestId) !== 'due' || !this.port.settings().agentLinks || !this.port.settings().autoReport) return;
    const sender = this.store.session(senderSessionId);
    const target = this.store.session(targetSessionId);
    const payload = this.ledger.payload(requestId);
    if (!sender || sender.archived || !target || !payload?.origin) return;
    const reportId = randomUUID().replaceAll('-', '');
    if (!this.ledger.settle(requestId, 'sent', reportId)) return;
    const device = this.store.device(target.deviceId);
    const agent = (JSON.parse(device?.agents ?? '[]') as AgentInfo[]).find((a) => a.id === target.agentId);
    const label = `${device?.name ?? ''} · ${agent?.label ?? target.agentId}`;
    const asked = String(payload.text ?? '').replace(/^\[来自 [^\]]*\]\s*/, '').split('\n')[0]!.slice(0, 60);
    const turnEnd = payload && this.ledger.get(requestId)?.turnId;
    const endedAt = turnEnd ? this.store.turnTime(targetSessionId, turnEnd) : null;
    const late = endedAt && endedAt < Date.now() - LATE_REPORT_MS ? `（这一轮 ${Math.round((Date.now() - endedAt) / 60_000)} 分钟前就结束了，汇报晚到了）` : '';
    const how = (outcome.state === 'done' ? '做完了' : outcome.state === 'interrupted' ? '被停止了，没有做完' : `没有做成（${outcome.error ?? '执行失败'}）`) + late;
    let reply = (outcome.reply ?? '').trim();
    if (reply.length > REPORT_MAX) reply = reply.slice(0, REPORT_MAX) + `\n\n……（太长，后面省略了；完整内容用 AgentChat 的 read 查看：conversationId: ${target.id}，full: true，count: 1）`;
    const text = `${forwardMark(`${label}「${target.title.slice(0, 40)}」的汇报`, reportId, sender.title)} 你派的「${asked}」${added ? `（连同之后追加的 ${added} 条）` : ''}${how}。${reply ? `\n\n${reply}` : ''}`;
    const origin: Origin = { deviceId: target.deviceId, agentId: target.agentId, label, sessionId: target.id,
      depth: Math.max(0, (payload.origin.depth ?? 1) - 1) };
    // The files it made in that turn go along, to the sender's computer, as the owner's attachments would.
    const turnId = this.ledger.get(requestId)?.turnId;
    const files = turnId ? this.store.turnFiles(targetSessionId, turnId).slice(0, MAX_ATTACHMENTS) : [];
    const result = this.port.submit(senderSessionId, { requestId: reportId, op: 'send', text, origin, ...(files.length ? { files } : {}) }, origin);
    if (typeof result === 'string') {
      // The owner sees it too: the sender is left without the outcome it is waiting for.
      log('hub', `report back to ${sender.title} failed: ${result}`);
      return activity(`${label} → ${sender.title}：汇报没能发回去（${result}），可以在手机上打开对方对话查看结果`, 'warn');
    }
    activity(`${label} → ${sender.title}：把汇报发回去了`);
  }

  /** Where a hand-off stands, as `wait` reports it, without waiting. */
  private handoffState(requestId: string): { state: string; reply?: string; error?: string | null } | null {
    const r = this.ledger.get(requestId);
    if (!r) return null;
    if (r.state === 'failed' || r.state === 'cancelled') return { state: 'failed', error: r.error };
    const status = r.turnId ? this.store.turnStatus(r.sessionId, r.turnId) : null;
    if (status && status !== 'inProgress') {
      return { state: status === 'completed' ? 'done' : status, reply: this.store.turnReply(r.sessionId, r.turnId!), error: this.store.turnError(r.sessionId, r.turnId!) };
    }
    const asks = this.store.waitingApprovals(r.sessionId, r.createdAt);
    if (asks.length) return { state: asks.every((a) => a.routed) ? 'waiting_sender' : 'waiting_approval' };
    if (waitsForWindow(r)) return { state: 'waiting_window' };
    // Its turn went quiet with commands still running in the background: not done until they end and it carries on.
    if (r.turnId && this.store.turnBackground(r.sessionId, r.turnId) !== null) return { state: 'background' };
    return { state: r.state === 'queued' ? 'queued' : 'running' };
  }

  /** The latest of a conversation as the phone shows it: messages, commands run, files, what waits for the owner. */
  private askRead(args: Record<string, unknown>): unknown {
    const sessionId = this.findTarget(args);
    const session = this.store.session(sessionId)!;
    const count = Math.min(50, Math.max(1, Number(args.count ?? 10)));
    const cut = (s: unknown, n: number) => { const t = String(s ?? ''); return t.length > n ? t.slice(0, n) + '…' : t; };
    // `full`: messages as written (a long report the forwarding shortened), within what one answer can carry.
    const textMax = args.full === true ? READ_FULL_MAX : 2000;
    const items = this.store.latestItems(sessionId, 400).filter((i) => i.kind !== 'status').slice(-count).map((i) =>
      i.kind === 'message' ? { type: i.data.role === 'user' ? 'sent' : 'reply', text: cut(i.data.text, textMax) }
        : i.kind === 'tool_call' ? { type: 'tool', tool: i.data.tool, what: cut(i.data.summary, 300), status: i.data.status }
          : i.kind === 'artifact' ? { type: 'file', name: i.data.name }
            : { type: 'approval', kind: i.data.kind, what: cut(i.data.command ?? i.data.reason, 300), state: i.data.state });
    return { conversationId: sessionId, title: session.title, running: session.running, ...(session.model ? { model: session.model } : {}),
      ...(session.background ? { background: session.background } : {}), items,
      note: session.hydrated ? undefined : '这个对话主电脑还没有完整同步过，内容可能不全' };
  }

  /** Stops the turn an agent's own task started. */
  private async askStop(origin: Origin, args: Record<string, unknown>): Promise<unknown> {
    const requestId = String(args.task ?? '');
    const request = this.ledger.get(requestId);
    const payload = request && (this.ledger.payload(requestId) as Command);
    if (!request || payload?.origin?.deviceId !== origin.deviceId || payload.origin.agentId !== origin.agentId) throw new Error('没有这个任务');
    const result = this.port.submit(request.sessionId, { requestId: randomUUID().replaceAll('-', ''), op: 'interrupt' }, origin);
    if (typeof result === 'string') throw new Error(result);
    // What the computer did with it, within moments: "stopping" is said only when it is so.
    for (let i = 0; i < 40; i++) {
      const now = this.ledger.get(result.view.requestId);
      if (now?.state === 'failed') {
        const why = /in_app_cannot_stop/.test(now.error ?? '') ? '这一轮正在电脑上的 Codex 软件里跑，AgentChat 停不了：请主人在 Codex 软件里点停止'
          : /no_active_turn/.test(now.error ?? '') ? '对方这一轮已经结束了，不用停' : now.error ?? '没停下来';
        return { state: 'failed', error: why };
      }
      if (now?.state === 'accepted' || now?.state === 'delivered') return { state: 'stopping' };
      await new Promise((r) => setTimeout(r, 250));
    }
    return { state: 'stopping', note: '停止指令已发出，对方还没确认；稍后用 read 看是否停了' };
  }

  /** Waits (up to the minutes asked, at most 60) for the turn a task started to end; says where it stands. */
  private async askWait(origin: Origin, args: Record<string, unknown>): Promise<unknown> {
    const requestId = String(args.task ?? '');
    const request = this.ledger.get(requestId);
    const payload = request && (this.ledger.payload(requestId) as Command);
    if (!request || payload?.origin?.deviceId !== origin.deviceId || payload.origin.agentId !== origin.agentId) throw new Error('没有这个任务');
    const minutes = Math.min(60, Math.max(0, Number(args.minutes ?? 10)));
    const until = Date.now() + minutes * 60_000;
    let quietSince = 0; // when an "interrupted" turn with nothing said was first seen
    for (;;) {
      const r = this.ledger.get(requestId)!;
      const status = r.turnId ? this.store.turnStatus(r.sessionId, r.turnId) : null;
      const waiting = this.store.waitingApprovals(r.sessionId, r.createdAt);
      if (r.state === 'failed' || r.state === 'cancelled') {
        this.ledger.settle(requestId, 'waited');
        return { state: 'failed', error: r.error };
      }
      if (status && status !== 'inProgress') {
        const reply = this.store.turnReply(r.sessionId, r.turnId!);
        // An agent's own app running the turn can look interrupted from outside for a moment (Codex): give it time
        // to show its end before telling the sender there is no reply.
        const settled = status !== 'interrupted' || reply || (quietSince ||= Date.now()) < Date.now() - 45_000 || Date.now() >= until;
        if (settled) {
          this.ledger.settle(requestId, 'waited'); // the sender has it: no report into its conversation as well
          const error = status === 'failed' ? this.store.turnError(r.sessionId, r.turnId!) : null;
          return { state: status === 'completed' ? 'done' : status, reply, ...(error ? { error } : {}), ...inApp(r.error) };
        }
      } else {
        quietSince = 0;
      }
      if (waiting.length && waiting.every((w) => w.routed)) {
        return { state: 'waiting_sender', asks: waiting, note: '对方停下来等你批：用 approve 答复（approval 写上面 asks 里的 approval，decision 写 allow 或 deny），答复后再 wait。同样的请示也会发到你的对话里，答过一次就行' };
      }
      if (waiting.length) return { state: 'waiting_approval', asks: waiting, note: '对方在等主人审批或回答，主人在手机上处理后再 wait' };
      if (Date.now() >= until && waitsForWindow(r)) {
        return { state: 'waiting_window', note: '消息还没送进对方的对话：对方正在做上一轮，或主人正在用那台电脑；空出来后会自动送进去，稍后再用 wait 查' };
      }
      if (Date.now() >= until && r.turnId && this.store.turnBackground(r.sessionId, r.turnId) !== null) {
        return { state: 'background', note: '对方把耗时的命令放到后台跑了，这一轮还没完：命令结束后它会接着做，做完汇报会自动发回你的对话，不用一直等' };
      }
      if (Date.now() >= until) return { state: r.state === 'queued' ? 'queued' : 'running', note: '还没做完，稍后再用 wait 查', ...inApp(r.error) };
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }

  /** Tells the owner a message one agent sent another failed (not sent, or the turn it started failed). */
  handoffFailed(sessionId: string, requestId: string, why: string): void {
    const origin = (this.ledger.payload(requestId) as Command | undefined)?.origin;
    if (!origin) return;
    const title = this.store.session(sessionId)?.title ?? '对话';
    this.port.notice({ type: 'agent', sessionId, title: 'Agent 之间的任务失败', text: `${origin.label} → ${title}：${why}` });
  }
}
