// The message ledger: one row for every request that goes to a conversation (from the phone or from another agent):
// where it goes, how far it got, and, for work one agent handed another, where the sender works and whether the
// outcome went back to it. What a hand-off still owes its sender is kept here, not in the hub's memory, so a
// restart of the hub forgets nothing.
import type { DatabaseSync } from 'node:sqlite';
import type { Command, CommandOp, RequestState, RequestView } from '../shared/protocol.ts';
import { ATTACHMENT_MARK } from '../shared/protocol.ts';

/**
 * What a hand-off owes the agent that sent it: `due` (its outcome, once the work ends), `sent` (a report went into
 * the sender's conversation, or the work ended together with another hand-off whose report covers it), `waited` (the
 * sender took the outcome itself with `wait`), `late` (the end was learned too late to report: the sender carried on).
 */
export type Owed = 'due' | 'sent' | 'waited' | 'late';

interface Row { request_id: string; session_id: string; op: string; payload: string; text: string | null; state: string;
  turn_id: string | null; error: string | null; created_at: number; seq: number; from_session: string | null; owed: string | null; report_id: string | null }

export interface HandOff { requestId: string; sessionId: string; fromSession: string; turnId: string | null }

function view(r: Row): RequestView {
  const files = r.op === 'send' ? (JSON.parse(r.payload) as Command).files : undefined;
  return { requestId: r.request_id, sessionId: r.session_id, op: r.op as CommandOp, text: r.text, ...(files?.length ? { files } : {}), state: r.state as RequestState,
    turnId: r.turn_id, error: r.error, createdAt: r.created_at, seq: r.seq };
}

export class Ledger {
  private readonly db: DatabaseSync;
  private readonly nextSeq: () => number;

  constructor(db: DatabaseSync, nextSeq: () => number) {
    this.db = db;
    this.nextSeq = nextSeq;
    const columns = (db.prepare('PRAGMA table_info(requests)').all() as { name: string }[]).map((c) => c.name);
    if (!columns.includes('owed')) this.migrate();
    // Once, when reports stopped being let go for coming late: what was still owed from long before would all go out at
    // once, days late, into conversations long moved on. Those are let go as before.
    if (!db.prepare("SELECT 1 FROM meta WHERE key = 'ledger:old_due_let_go'").get()) {
      db.prepare("UPDATE requests SET owed = 'late' WHERE owed = 'due' AND created_at < ?").run(Date.now() - 12 * 3_600_000);
      db.exec("INSERT INTO meta(key, value) VALUES ('ledger:old_due_let_go', '1')");
    }
    // Where a message was found once put in (see `landed`); requests from before were never looked for.
    if (!columns.includes('attempt')) {
      db.exec(`ALTER TABLE requests ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0; ALTER TABLE requests ADD COLUMN attempt_at INTEGER;
        ALTER TABLE requests ADD COLUMN landed TEXT; ALTER TABLE requests ADD COLUMN misplaced TEXT;`);
    }
  }

  /**
   * Once, from before the ledger: hand-offs were followed in the hub's memory, from the cards in the senders'
   * conversations, and the ones settled were listed in `handbacks`. Their sender conversations and what is still owed
   * move onto the requests themselves.
   */
  private migrate(): void {
    this.db.exec(`ALTER TABLE requests ADD COLUMN from_session TEXT; ALTER TABLE requests ADD COLUMN owed TEXT; ALTER TABLE requests ADD COLUMN report_id TEXT;
      CREATE TABLE IF NOT EXISTS handbacks (request_id TEXT PRIMARY KEY, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS requests_owed ON requests(owed) WHERE owed = 'due';`);
    this.db.exec('BEGIN');
    try {
      const cards = this.db.prepare("SELECT session_id, json_extract(data, '$.task') AS task, json_extract(data, '$.endedAt') AS ended FROM items WHERE kind = 'handoff'").all() as
        { session_id: string; task: string | null; ended: number | null }[];
      const settled = this.db.prepare('SELECT 1 FROM handbacks WHERE request_id = ?');
      const set = this.db.prepare('UPDATE requests SET from_session = ?, owed = ? WHERE request_id = ?');
      // An open card never handed back is still owed; any other card's outcome went back, or was let go as too late.
      for (const c of cards) if (c.task) set.run(c.session_id, settled.get(c.task) ? 'sent' : c.ended === null ? 'due' : 'late', c.task);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  // ---------- requests ----------

  /** Records a request once; a repeated requestId returns the existing row unchanged. `from`: a hand-off's sender conversation. */
  create(requestId: string, sessionId: string, op: CommandOp, payload: unknown, text: string | null, state: RequestState, from?: string): { view: RequestView; created: boolean } {
    const existing = this.get(requestId);
    if (existing) return { view: existing, created: false };
    this.db.prepare(`INSERT INTO requests(request_id, session_id, op, payload, text, state, created_at, seq, from_session, owed, attempt_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(requestId, sessionId, op, JSON.stringify(payload), text, state, Date.now(), this.nextSeq(), from ?? null, from ? 'due' : null, Date.now());
    return { view: this.get(requestId)!, created: true };
  }

  update(requestId: string, state: RequestState, turnId?: string | null, error?: string | null): RequestView | undefined {
    const old = this.get(requestId);
    if (!old) return undefined;
    // A request never leaves a final state, and an identical update is not a change.
    if (['delivered', 'failed', 'cancelled'].includes(old.state)) return undefined;
    if (old.state === state && old.turnId === (turnId ?? old.turnId)) return undefined;
    // A note on a successful request (e.g. desktop_restart) stays once it reaches "delivered".
    this.db.prepare('UPDATE requests SET state = ?, turn_id = COALESCE(?, turn_id), error = COALESCE(?, error), seq = ? WHERE request_id = ?')
      .run(state, turnId ?? null, error ?? null, this.nextSeq(), requestId);
    return this.get(requestId);
  }

  /** The turn that takes a delivered message up, as the agent's records now say (it may say so later than delivery). */
  setTurn(requestId: string, turnId: string): void {
    this.db.prepare('UPDATE requests SET turn_id = ?, seq = ? WHERE request_id = ?').run(turnId, this.nextSeq(), requestId);
  }

  get(requestId: string): RequestView | undefined {
    const r = this.db.prepare('SELECT * FROM requests WHERE request_id = ?').get(requestId) as Row | undefined;
    return r ? view(r) : undefined;
  }

  payload(requestId: string): Command | undefined {
    const r = this.db.prepare('SELECT payload FROM requests WHERE request_id = ?').get(requestId) as { payload: string } | undefined;
    return r ? JSON.parse(r.payload) as Command : undefined;
  }

  /** Requests changed after `after`, and every one of the last `recentMs` (the phone keeps none across a reload). */
  after(after: number, recentMs = 0): RequestView[] {
    return (this.db.prepare('SELECT * FROM requests WHERE seq > ? OR created_at > ? ORDER BY seq').all(after, recentMs ? Date.now() - recentMs : Number.MAX_SAFE_INTEGER) as unknown as Row[])
      .map(view);
  }

  /** The request that started a turn, if one did. */
  forTurn(sessionId: string, turnId: string): string | null {
    return (this.db.prepare("SELECT request_id FROM requests WHERE session_id = ? AND turn_id = ? AND op = 'send' LIMIT 1").get(sessionId, turnId) as { request_id: string } | undefined)?.request_id ?? null;
  }

  /**
   * A recent, not yet delivered message with this text (messages queued through Codex, and Claude Code's, carry no request id).
   * A message with files reaches the conversation as its text followed by the attachment lines.
   */
  pendingByText(sessionId: string, text: string): RequestView | undefined {
    const rows = this.db.prepare(`SELECT * FROM requests WHERE session_id = ? AND op = 'send' AND state IN ('pending', 'accepted', 'unknown')
      AND created_at > ? ORDER BY created_at`).all(sessionId, Date.now() - 30 * 60_000) as unknown as Row[];
    // Typed into the desktop app, line breaks may come back changed: compare without whitespace.
    const flat = (s: string) => s.replace(/\s+/g, '');
    const got = flat(text);
    const r = rows.find((x) => x.text !== null && (got === flat(x.text)
      || (x.text === ATTACHMENT_MARK ? got.startsWith(ATTACHMENT_MARK) : got.startsWith(flat(x.text) + ATTACHMENT_MARK))));
    return r ? view(r) : undefined;
  }

  /** The message to this conversation whose mark carries `tag` (the start of its request id). */
  byTag(sessionId: string, tag: string): RequestView | undefined {
    const r = this.db.prepare("SELECT * FROM requests WHERE session_id = ? AND op = 'send' AND request_id LIKE ? ORDER BY created_at DESC LIMIT 1")
      .get(sessionId, `${tag}%`) as unknown as Row | undefined;
    return r ? view(r) : undefined;
  }

  /** The message carrying this tag, wherever it was sent (an agent sending one back names only the tag). */
  byTagAnywhere(tag: string): RequestView | undefined {
    const r = this.db.prepare("SELECT * FROM requests WHERE op = 'send' AND request_id LIKE ? ORDER BY created_at DESC LIMIT 1").get(`${tag}%`) as unknown as Row | undefined;
    return r ? view(r) : undefined;
  }

  /** What this sender (in this conversation of its own) sent to `sessionId` since `since`, newest first, failures aside. */
  recentSends(sessionId: string, from: { deviceId: string; agentId: string; sessionId?: string }, since: number): RequestView[] {
    return (this.db.prepare(`SELECT * FROM requests WHERE session_id = ? AND op = 'send' AND created_at > ? AND state NOT IN ('failed', 'cancelled')
      AND json_extract(payload, '$.origin.deviceId') = ? AND json_extract(payload, '$.origin.agentId') = ?
      AND COALESCE(json_extract(payload, '$.origin.sessionId'), '') = ? ORDER BY created_at DESC`)
      .all(sessionId, since, from.deviceId, from.agentId, from.sessionId ?? '') as unknown as Row[]).map(view);
  }

  /**
   * Messages to this computer's conversations not yet taken in, since `since`: held for the window to come free, or
   * with no word back at all (a receipt can be lost while the hub restarts). The computer knows which it has.
   */
  unsent(deviceId: string, since: number): RequestView[] {
    return (this.db.prepare(`SELECT * FROM requests WHERE session_id LIKE ? AND op = 'send' AND state = 'pending'
      AND created_at > ? ORDER BY created_at`).all(deviceId + ':%', since) as unknown as Row[]).map(view);
  }

  /** Messages waiting for their computer to come back. */
  queued(deviceId: string): RequestView[] {
    return (this.db.prepare("SELECT * FROM requests WHERE state = 'queued' AND session_id LIKE ? ORDER BY created_at").all(deviceId + ':%') as unknown as Row[]).map(view);
  }

  // ---------- agents' messages ----------

  /** How many messages an agent sent other agents since `since` (ms). */
  agentSends(deviceId: string, agentId: string, since: number): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM requests WHERE op = 'send' AND created_at > ?
      AND json_extract(payload, '$.origin.deviceId') = ? AND json_extract(payload, '$.origin.agentId') = ?`).get(since, deviceId, agentId) as { n: number }).n;
  }

  /** Whether another agent has ever sent this conversation anything through AgentChat. */
  hasAgentMessages(sessionId: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM requests WHERE session_id = ? AND op = 'send' AND json_extract(payload, '$.origin.deviceId') IS NOT NULL LIMIT 1`).get(sessionId));
  }

  /**
   * How far down a chain of hand-offs the work in this conversation is: what started its latest turn. The owner's own
   * message (from the phone, or typed on the computer) starts a new chain, 0; another agent's carries that one's depth.
   * Hand-offs older than `since` count as finished.
   */
  turnDepth(sessionId: string, since: number): number {
    const req = this.db.prepare(`SELECT created_at, json_extract(payload, '$.origin.depth') AS d, json_extract(payload, '$.origin.deviceId') AS o
      FROM requests WHERE session_id = ? AND op = 'send' AND state NOT IN ('failed', 'cancelled') ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(sessionId) as
      { created_at: number; d: number | null; o: string | null } | undefined;
    const typed = this.db.prepare(`SELECT ts, json_extract(data, '$.text') AS text FROM items WHERE session_id = ? AND kind = 'message'
      AND json_extract(data, '$.role') = 'user' ORDER BY ts DESC LIMIT 1`).get(sessionId) as { ts: number; text: string | null } | undefined;
    // Typed by the owner after the last request: the owner's chain. Forwarded messages carry the 「[来自 …」 mark.
    if (typed && !String(typed.text ?? '').startsWith('[来自 ') && (!req || typed.ts >= req.created_at)) return 0;
    if (!req?.o || req.created_at <= since) return 0;
    return req.d ?? 1;
  }

  /** The deepest hand-off this agent received since `since`: its place in a chain when no conversation tells. */
  chainDepth(deviceId: string, agentId: string, since: number): number {
    const r = this.db.prepare(`SELECT MAX(COALESCE(json_extract(r.payload, '$.origin.depth'), 1)) AS d FROM requests r JOIN sessions s ON s.id = r.session_id
      WHERE s.device_id = ? AND s.agent_id = ? AND r.op = 'send' AND r.created_at > ? AND r.state NOT IN ('failed', 'cancelled')
      AND json_extract(r.payload, '$.origin.deviceId') IS NOT NULL`).get(deviceId, agentId, since) as { d: number | null };
    return r.d ?? 0;
  }

  // ---------- where messages were found once put in ----------

  /**
   * What is known of where a message went: the attempt under way (0 the first time), whether it was found where it
   * belongs (`here`), was given up on, or cannot be looked for (`unknown`), and the conversations it went into by mistake.
   */
  landing(requestId: string): { attempt: number; landed: string | null; misplaced: string[] } | undefined {
    const r = this.db.prepare('SELECT attempt, landed, misplaced FROM requests WHERE request_id = ?').get(requestId) as
      { attempt: number; landed: string | null; misplaced: string | null } | undefined;
    return r && { attempt: r.attempt, landed: r.landed, misplaced: r.misplaced ? JSON.parse(r.misplaced) as string[] : [] };
  }

  setLanded(requestId: string, landed: 'here' | 'unknown' | 'lost'): void {
    this.db.prepare('UPDATE requests SET landed = ? WHERE request_id = ?').run(landed, requestId);
  }

  /** A conversation it went into by mistake, once (false when that one was dealt with already). */
  addMisplaced(requestId: string, sessionId: string): boolean {
    const l = this.landing(requestId);
    if (!l || l.misplaced.includes(sessionId)) return false;
    this.db.prepare('UPDATE requests SET misplaced = ? WHERE request_id = ?').run(JSON.stringify([...l.misplaced, sessionId]), requestId);
    return true;
  }

  /** It goes once more: the next attempt's number. */
  nextAttempt(requestId: string): number {
    this.db.prepare('UPDATE requests SET attempt = attempt + 1, attempt_at = ?, landed = NULL WHERE request_id = ?').run(Date.now(), requestId);
    return this.landing(requestId)!.attempt;
  }

  /** Messages put in (the computer said so) but not found anywhere yet, the latest attempt older than `before`. */
  unconfirmed(before: number): RequestView[] {
    return (this.db.prepare(`SELECT * FROM requests WHERE op = 'send' AND state = 'accepted' AND landed IS NULL
      AND attempt_at IS NOT NULL AND attempt_at < ? ORDER BY created_at`).all(before) as unknown as Row[]).map(view);
  }

  // ---------- what hand-offs owe their senders ----------

  /** Hand-offs whose outcome is still owed: all of them, or those whose work runs in `sessionId`. */
  due(sessionId?: string): HandOff[] {
    const rows = (sessionId
      ? this.db.prepare("SELECT request_id, session_id, from_session, turn_id FROM requests WHERE owed = 'due' AND session_id = ? ORDER BY created_at").all(sessionId)
      : this.db.prepare("SELECT request_id, session_id, from_session, turn_id FROM requests WHERE owed = 'due' ORDER BY created_at").all()) as
      { request_id: string; session_id: string; from_session: string; turn_id: string | null }[];
    return rows.map((r) => ({ requestId: r.request_id, sessionId: r.session_id, fromSession: r.from_session, turnId: r.turn_id }));
  }

  owed(requestId: string): Owed | null {
    return ((this.db.prepare('SELECT owed FROM requests WHERE request_id = ?').get(requestId) as { owed: string | null } | undefined)?.owed ?? null) as Owed | null;
  }

  /** Settles what a hand-off owes, once: false when it was settled already (a report and a `wait` racing, say). */
  settle(requestId: string, how: Exclude<Owed, 'due'>, reportId?: string): boolean {
    return this.db.prepare("UPDATE requests SET owed = ?, report_id = ? WHERE request_id = ? AND owed = 'due'").run(how, reportId ?? null, requestId).changes > 0;
  }
}
