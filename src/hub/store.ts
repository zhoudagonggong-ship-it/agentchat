// Hub storage: one SQLite file plus content-addressed artifact files.
// Every change bumps a global sequence number so apps can catch up with "everything after seq N".
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentInfo, Attachment, Command, CommandOp, DeviceView, FriendView, Item, ItemView, MemberSeed, ProjectInfo, RequestState, RequestView, SessionInfo, SessionView } from '../shared/protocol.ts';
import { ATTACHMENT_MARK, sessionKey } from '../shared/protocol.ts';
import { sha256 } from '../shared/util.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, secret_hash TEXT NOT NULL,
  approved INTEGER NOT NULL DEFAULT 0, agents TEXT NOT NULL DEFAULT '[]', last_seen INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL, agent_id TEXT NOT NULL, thread_id TEXT NOT NULL,
  title TEXT NOT NULL, cwd TEXT, updated_at INTEGER NOT NULL, running INTEGER NOT NULL, active_turn_id TEXT,
  archived INTEGER NOT NULL DEFAULT 0, hydrated INTEGER NOT NULL DEFAULT 0, seq INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS sessions_seq ON sessions(seq);
CREATE TABLE IF NOT EXISTS items (
  session_id TEXT NOT NULL, item_id TEXT NOT NULL, turn_id TEXT, kind TEXT NOT NULL, ts INTEGER NOT NULL,
  data TEXT NOT NULL, hash TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (session_id, item_id));
CREATE INDEX IF NOT EXISTS items_session_seq ON items(session_id, seq);
CREATE TABLE IF NOT EXISTS requests (
  request_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, op TEXT NOT NULL, payload TEXT NOT NULL, text TEXT,
  state TEXT NOT NULL, turn_id TEXT, error TEXT, created_at INTEGER NOT NULL, seq INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS requests_seq ON requests(seq);
CREATE TABLE IF NOT EXISTS artifacts (
  sha256 TEXT PRIMARY KEY, name TEXT NOT NULL, size INTEGER NOT NULL, mime TEXT NOT NULL, created_at INTEGER NOT NULL);
`;

interface SessionRow { id: string; device_id: string; agent_id: string; thread_id: string; title: string; cwd: string | null;
  updated_at: number; running: number; active_turn_id: string | null; preview: string | null; hydrated: number; seq: number;
  project_id: string | null; project_name: string | null; pinned: number; muted: number; replies: number; read_replies: number }
interface ItemRow { session_id: string; item_id: string; turn_id: string | null; kind: string; ts: number; data: string; seq: number }
interface RequestRow { request_id: string; session_id: string; op: string; payload: string; text: string | null; state: string;
  turn_id: string | null; error: string | null; created_at: number; seq: number }
interface DeviceRow { id: string; name: string; secret_hash: string; approved: number; agents: string; last_seen: number }

export class Store {
  readonly db: DatabaseSync;
  readonly artifactDir: string;
  private seq: number;

  constructor(dir: string) {
    this.artifactDir = join(dir, 'artifacts');
    mkdirSync(this.artifactDir, { recursive: true });
    this.db = new DatabaseSync(join(dir, 'hub.sqlite'));
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.db.exec(SCHEMA);
    // Columns added after the first release.
    const columns = (this.db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map((c) => c.name);
    if (!columns.includes('preview')) this.db.exec('ALTER TABLE sessions ADD COLUMN preview TEXT');
    if (!columns.includes('replies')) this.db.exec('ALTER TABLE sessions ADD COLUMN replies INTEGER NOT NULL DEFAULT 0');
    if (!columns.includes('project_id'))this.db.exec('ALTER TABLE sessions ADD COLUMN project_id TEXT; ALTER TABLE sessions ADD COLUMN project_name TEXT; ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0');
    if (!columns.includes('read_replies')) {
      // Read state moved here from each phone: start with everything read, and drop the pins copied from Codex's own app
      // (`pinned` is the owner's own choice in the app from now on).
      this.db.exec('ALTER TABLE sessions ADD COLUMN read_replies INTEGER NOT NULL DEFAULT 0; UPDATE sessions SET read_replies = replies, pinned = 0');
    }
    const hadFriends = Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'friends'").get());
    this.db.exec(`CREATE TABLE IF NOT EXISTS friends (device_id TEXT NOT NULL, agent_id TEXT NOT NULL, added INTEGER NOT NULL DEFAULT 0, remark TEXT,
        PRIMARY KEY (device_id, agent_id));
      CREATE TABLE IF NOT EXISTS agent_projects (device_id TEXT NOT NULL, agent_id TEXT NOT NULL, projects TEXT NOT NULL, PRIMARY KEY (device_id, agent_id));`);
    // Upgrading from before friends existed: agents already in use count as added.
    if (!hadFriends) this.db.exec('INSERT OR IGNORE INTO friends(device_id, agent_id, added) SELECT DISTINCT device_id, agent_id, 1 FROM sessions');
    const friendColumns = (this.db.prepare('PRAGMA table_info(friends)').all() as { name: string }[]).map((c) => c.name);
    if (!friendColumns.includes('accept_agents')) this.db.exec('ALTER TABLE friends ADD COLUMN accept_agents INTEGER NOT NULL DEFAULT 1');
    // The owner's own picture for a friend (a file the hub keeps, by its sha256) and its 消息免打扰.
    if (!friendColumns.includes('avatar')) this.db.exec('ALTER TABLE friends ADD COLUMN avatar TEXT; ALTER TABLE friends ADD COLUMN muted INTEGER NOT NULL DEFAULT 0');
    if (!(this.db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).some((c) => c.name === 'muted')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN muted INTEGER NOT NULL DEFAULT 0');
    }
    // Hand-offs whose outcome reached the agent that sent them (by `wait`, or a report into its conversation).
    this.db.exec('CREATE TABLE IF NOT EXISTS handbacks (request_id TEXT PRIMARY KEY, at INTEGER NOT NULL)');
    const row =this.db.prepare("SELECT value FROM meta WHERE key = 'seq'").get() as { value: string } | undefined;
    this.seq = row ? Number(row.value) : 0;
    this.placeArtifacts();
  }

  get currentSeq(): number {
    return this.seq;
  }

  private nextSeq(): number {
    this.seq += 1;
    this.db.prepare("INSERT INTO meta(key, value) VALUES ('seq', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(this.seq));
    return this.seq;
  }

  // ---------- devices ----------

  device(id: string): DeviceRow | undefined {
    return this.db.prepare('SELECT * FROM devices WHERE id = ?').get(id) as DeviceRow | undefined;
  }

  /**
   * Records a join request; returns whether the device is allowed and its secret matches. `owner`: the owner's own
   * computer, which may come back with a new secret (reinstalled).
   */
  registerDevice(id: string, name: string, secret: string, agents: AgentInfo[], owner = false): 'approved' | 'pending' | 'mismatch' {
    const hash = sha256(secret);
    const existing = this.device(id);
    if (!existing) {
      this.db.prepare('INSERT INTO devices(id, name, secret_hash, agents, last_seen) VALUES (?, ?, ?, ?, ?)').run(id, name, hash, JSON.stringify(agents), Date.now());
      return 'pending';
    }
    if (existing.secret_hash !== hash && owner) this.db.prepare('UPDATE devices SET secret_hash = ? WHERE id = ?').run(hash, id);
    else if (existing.secret_hash !== hash) return 'mismatch';
    this.db.prepare('UPDATE devices SET name = ?, agents = ?, last_seen = ? WHERE id = ?').run(name, JSON.stringify(agents), Date.now(), id);
    return existing.approved ? 'approved' : 'pending';
  }

  /** Records a device's agents; returns the ones it did not have before (none for a device seen for the first time). */
  setAgents(id: string, agents: AgentInfo[]): AgentInfo[] {
    const row = this.device(id);
    if (!row) return [];
    const before = new Set((JSON.parse(row.agents || '[]') as AgentInfo[]).map((a) => a.id));
    this.db.prepare('UPDATE devices SET agents = ? WHERE id = ?').run(JSON.stringify(agents), id);
    return agents.filter((a) => !before.has(a.id));
  }

  approveDevice(id: string, approved = true): void {
    this.db.prepare('UPDATE devices SET approved = ? WHERE id = ?').run(approved ? 1 : 0, id);
  }

  /** Forget a device so it can join again with a new secret (e.g. after reinstalling). */
  removeDevice(id: string): void {
    this.db.prepare('DELETE FROM devices WHERE id = ?').run(id);
  }

  /** Allowed devices with their secret hashes, handed to the next hub when the hub moves. */
  memberSeeds(): MemberSeed[] {
    return (this.db.prepare('SELECT id, name, secret_hash FROM devices WHERE approved = 1').all() as { id: string; name: string; secret_hash: string }[])
      .map((r) => ({ id: r.id, name: r.name, secretHash: r.secret_hash }));
  }

  /** Takes over the members of the previous hub; an existing entry keeps its own secret. */
  seedMembers(seeds: MemberSeed[]): void {
    const insert = this.db.prepare('INSERT OR IGNORE INTO devices(id, name, secret_hash, approved, last_seen) VALUES (?, ?, ?, 1, 0)');
    for (const s of seeds) insert.run(s.id, s.name, s.secretHash);
  }

  touchDevice(id: string): void {
    this.db.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').run(Date.now(), id);
  }

  devices(online: Set<string>, hubId: string): DeviceView[] {
    const rows = this.db.prepare('SELECT * FROM devices ORDER BY name').all() as unknown as DeviceRow[];
    return rows.map((r) => ({ id: r.id, name: r.name, online: online.has(r.id), approved: Boolean(r.approved), isHub: r.id === hubId,
      agents: JSON.parse(r.agents) as AgentInfo[], lastSeen: r.last_seen }));
  }

  // ---------- friends and projects ----------

  /** Every agent a device reported gets a row; new ones wait in "new friends" until the owner adds them. */
  ensureFriends(deviceId: string, agents: AgentInfo[]): void {
    const insert = this.db.prepare('INSERT OR IGNORE INTO friends(device_id, agent_id, added) VALUES (?, ?, 0)');
    for (const a of agents) insert.run(deviceId, a.id);
  }

  friends(): FriendView[] {
    return (this.db.prepare('SELECT * FROM friends').all() as { device_id: string; agent_id: string; added: number; remark: string | null; accept_agents: number;
      avatar: string | null; muted: number }[])
      .map((r) => ({ deviceId: r.device_id, agentId: r.agent_id, added: Boolean(r.added), remark: r.remark, acceptAgents: r.accept_agents !== 0,
        avatar: r.avatar, muted: Boolean(r.muted) }));
  }

  setFriend(deviceId: string, agentId: string, change: { added?: boolean; remark?: string | null; acceptAgents?: boolean; avatar?: string | null; muted?: boolean }): boolean {
    const row = this.db.prepare('SELECT 1 FROM friends WHERE device_id = ? AND agent_id = ?').get(deviceId, agentId);
    if (!row) return false;
    const set = (column: string, value: unknown) => this.db.prepare(`UPDATE friends SET ${column} = ? WHERE device_id = ? AND agent_id = ?`).run(value as never, deviceId, agentId);
    if (change.added !== undefined) set('added', change.added ? 1 : 0);
    if (change.remark !== undefined) set('remark', change.remark);
    if (change.acceptAgents !== undefined) set('accept_agents', change.acceptAgents ? 1 : 0);
    if (change.avatar !== undefined) set('avatar', change.avatar);
    if (change.muted !== undefined) set('muted', change.muted ? 1 : 0);
    return true;
  }

  /** 消息免打扰: the conversation itself, or every conversation of its friend. */
  isMuted(sessionId: string): boolean {
    const r = this.db.prepare(`SELECT s.muted AS s, COALESCE(f.muted, 0) AS f FROM sessions s
      LEFT JOIN friends f ON f.device_id = s.device_id AND f.agent_id = s.agent_id WHERE s.id = ?`).get(sessionId) as { s: number; f: number } | undefined;
    return Boolean(r && (r.s || r.f));
  }

  /** Whether this agent takes messages from other agents (the owner can turn it off per friend; on by default). */
  acceptsAgents(deviceId: string, agentId: string): boolean {
    const r = this.db.prepare('SELECT accept_agents FROM friends WHERE device_id = ? AND agent_id = ?').get(deviceId, agentId) as { accept_agents: number } | undefined;
    return r ? Boolean(r.accept_agents) : true;
  }

  /** An owner's setting kept by the hub (e.g. whether agents may reach each other at all). */
  setting(key: string): string | null {
    return (this.db.prepare('SELECT value FROM meta WHERE key = ?').get(`setting:${key}`) as { value: string } | undefined)?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(`setting:${key}`, value);
  }

  /** The request that started a turn, if one did. */
  requestForTurn(sessionId: string, turnId: string): string | null {
    return (this.db.prepare("SELECT request_id FROM requests WHERE session_id = ? AND turn_id = ? AND op = 'send' LIMIT 1").get(sessionId, turnId) as { request_id: string } | undefined)?.request_id ?? null;
  }

  /** How many messages an agent sent other agents since `since` (ms). */
  agentSends(deviceId: string, agentId: string, since: number): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM requests WHERE op = 'send' AND created_at > ?
      AND json_extract(payload, '$.origin.deviceId') = ? AND json_extract(payload, '$.origin.agentId') = ?`).get(since, deviceId, agentId) as { n: number }).n;
  }

  /**
   * How deep in a chain of hand-offs this agent works now: the deepest recent message another agent sent it
   * (0 when nobody did). A sends B (1), B sends C (2)…
   */
  /** Whether another agent has ever sent this conversation anything through AllinOne. */
  hasAgentMessages(sessionId: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM requests WHERE session_id = ? AND op = 'send' AND json_extract(payload, '$.origin.deviceId') IS NOT NULL LIMIT 1`).get(sessionId));
  }

  /** The sender of a hand-off has its outcome: `wait` brought it back, or the report was sent to its conversation. */
  markHandedBack(requestId: string): boolean {
    return this.db.prepare('INSERT OR IGNORE INTO handbacks(request_id, at) VALUES (?, ?)').run(requestId, Date.now()).changes > 0;
  }

  handedBack(requestId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM handbacks WHERE request_id = ?').get(requestId));
  }

  /** Hand-off cards still open (their work not ended), to follow again after the hub restarts. */
  openHandoffs(): { sessionId: string; item: Item }[] {
    return (this.db.prepare("SELECT * FROM items WHERE kind = 'handoff' AND json_extract(data, '$.endedAt') IS NULL").all() as unknown as ItemRow[])
      .map((r) => ({ sessionId: r.session_id, item: { itemId: r.item_id, turnId: r.turn_id, kind: 'handoff', ts: r.ts, data: JSON.parse(r.data) } }));
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

  chainDepth(deviceId: string, agentId: string, since: number): number {
    const r = this.db.prepare(`SELECT MAX(COALESCE(json_extract(r.payload, '$.origin.depth'), 1)) AS d FROM requests r JOIN sessions s ON s.id = r.session_id
      WHERE s.device_id = ? AND s.agent_id = ? AND r.op = 'send' AND r.created_at > ? AND r.state NOT IN ('failed', 'cancelled')
      AND json_extract(r.payload, '$.origin.deviceId') IS NOT NULL`).get(deviceId, agentId, since) as { d: number | null };
    return r.d ?? 0;
  }

  setProjects(deviceId: string, agentId: string, projects: ProjectInfo[]): boolean {
    const json = JSON.stringify(projects);
    const old = this.db.prepare('SELECT projects FROM agent_projects WHERE device_id = ? AND agent_id = ?').get(deviceId, agentId) as { projects: string } | undefined;
    if (old?.projects === json) return false;
    this.db.prepare('INSERT INTO agent_projects(device_id, agent_id, projects) VALUES (?, ?, ?) ON CONFLICT(device_id, agent_id) DO UPDATE SET projects = excluded.projects')
      .run(deviceId, agentId, json);
    return true;
  }

  allProjects(): { deviceId: string; agentId: string; projects: ProjectInfo[] }[] {
    return (this.db.prepare('SELECT * FROM agent_projects').all() as { device_id: string; agent_id: string; projects: string }[])
      .map((r) => ({ deviceId: r.device_id, agentId: r.agent_id, projects: JSON.parse(r.projects) as ProjectInfo[] }));
  }

  // ---------- sessions ----------

  /** Upserts sessions; with `complete`, every other session of that agent is marked archived. Returns changed views. */
  upsertSessions(deviceId: string, agentId: string, sessions: SessionInfo[], complete: boolean): SessionView[] {
    const changed: SessionView[] = [];
    const seen = new Set<string>();
    const select = this.db.prepare('SELECT * FROM sessions WHERE id = ?');
    const upsert = this.db.prepare(`INSERT INTO sessions(id, device_id, agent_id, thread_id, title, cwd, updated_at, running, active_turn_id, preview,
        project_id, project_name, replies, archived, seq)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)
      ON CONFLICT(id) DO UPDATE SET title = excluded.title, cwd = excluded.cwd, updated_at = excluded.updated_at,
        running = excluded.running, active_turn_id = excluded.active_turn_id, preview = COALESCE(excluded.preview, preview),
        project_id = excluded.project_id, project_name = excluded.project_name, archived = 0, seq = excluded.seq,
        replies = sessions.replies + ?`);
    this.db.exec('BEGIN');
    try {
      for (const s of sessions) {
        const id = sessionKey(deviceId, agentId, s.threadId);
        seen.add(id);
        const old = select.get(id) as (SessionRow & { archived: number }) | undefined;
        const preview = s.preview ?? null;
        const projectId = s.projectId ?? null;
        const projectName = s.projectName ?? null;
        if (old && !old.archived && old.title === s.title && old.cwd === s.cwd && old.updated_at === s.updatedAt
          && Boolean(old.running) === s.running && old.active_turn_id === s.activeTurnId && (preview === null || old.preview === preview)
          && old.project_id === projectId && old.project_name === projectName) continue;
        const seq = this.nextSeq();
        // One more reply to read: a turn finished, or the latest message changed while nothing runs. A rename, or the
        // agent touching its own records, moves the time too but is no reply. A conversation seen the first time has none.
        const reply = old && !s.running && (old.running || (s.updatedAt > old.updated_at && preview !== null && preview !== old.preview)) ? 1 : 0;
        upsert.run(id, deviceId, agentId, s.threadId, s.title, s.cwd, s.updatedAt, s.running ? 1 : 0, s.activeTurnId, preview, projectId, projectName, seq, reply);
        changed.push({ ...s, preview: preview ?? old?.preview ?? null, projectId, projectName, pinned: Boolean(old?.pinned), muted: Boolean(old?.muted), id, deviceId, seq,
          replies: (old?.replies ?? 0) + reply, readReplies: old?.read_replies ?? 0 });
      }
      if (complete) {
        const live = this.db.prepare('SELECT id FROM sessions WHERE device_id = ? AND agent_id = ? AND archived = 0').all(deviceId, agentId) as { id: string }[];
        for (const { id } of live) {
          if (seen.has(id)) continue;
          this.db.prepare('UPDATE sessions SET archived = 1, seq = ? WHERE id = ?').run(this.nextSeq(), id);
        }
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return changed;
  }

  /** The owner read the conversation up to `replies`; the changed view, or undefined when nothing changed. */
  markRead(id: string, replies: number): SessionView | undefined {
    const r = this.db.prepare('SELECT replies, read_replies FROM sessions WHERE id = ?').get(id) as { replies: number; read_replies: number } | undefined;
    const upTo = Math.min(Math.max(0, Math.floor(replies) || 0), r?.replies ?? 0);
    if (!r || upTo <= r.read_replies) return undefined;
    this.db.prepare('UPDATE sessions SET read_replies = ?, seq = ? WHERE id = ?').run(upTo, this.nextSeq(), id);
    return this.session(id);
  }

  /** The owner's own marks on a conversation: 置顶 (`pinned`) or 消息免打扰 (`muted`). */
  setFlag(id: string, flag: 'pinned' | 'muted', on: boolean): SessionView | undefined {
    const r = this.db.prepare(`SELECT ${flag} AS v FROM sessions WHERE id = ?`).get(id) as { v: number } | undefined;
    if (!r || Boolean(r.v) === on) return undefined;
    this.db.prepare(`UPDATE sessions SET ${flag} = ?, seq = ? WHERE id = ?`).run(on ? 1 : 0, this.nextSeq(), id);
    return this.session(id);
  }

  session(id: string): (SessionView & { hydrated: boolean; archived: boolean }) | undefined {
    const r = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as (SessionRow & { archived: number }) | undefined;
    return r ? { ...toSessionView(r), hydrated: Boolean(r.hydrated), archived: Boolean(r.archived) } : undefined;
  }

  /** Live sessions changed after `after`, plus ids of sessions archived after it. */
  sessionsAfter(after: number): { live: SessionView[]; archived: string[] } {
    const rows = this.db.prepare('SELECT * FROM sessions WHERE seq > ? ORDER BY updated_at DESC').all(after) as unknown as (SessionRow & { archived: number })[];
    return { live: rows.filter((r) => !r.archived).map(toSessionView), archived: rows.filter((r) => r.archived).map((r) => r.id) };
  }

  /** One agent's live conversations, latest first. */
  recentSessions(deviceId: string, agentId: string, limit: number): SessionView[] {
    return (this.db.prepare('SELECT * FROM sessions WHERE device_id = ? AND agent_id = ? AND archived = 0 ORDER BY updated_at DESC LIMIT ?')
      .all(deviceId, agentId, limit) as unknown as SessionRow[]).map(toSessionView);
  }

  /** How a turn stands by its status item: inProgress, completed, failed, interrupted; null before it has one. */
  turnStatus(sessionId: string, turnId: string): string | null {
    const r = this.db.prepare("SELECT json_extract(data, '$.status') AS s FROM items WHERE session_id = ? AND turn_id = ? AND kind = 'status' ORDER BY ts DESC LIMIT 1")
      .get(sessionId, turnId) as { s: string | null } | undefined;
    return r?.s ?? null;
  }

  /** Why a turn failed, as the agent reported it (null when it did not say). */
  turnError(sessionId: string, turnId: string): string | null {
    const r = this.db.prepare("SELECT json_extract(data, '$.error') AS e FROM items WHERE session_id = ? AND turn_id = ? AND kind = 'status' ORDER BY ts DESC LIMIT 1")
      .get(sessionId, turnId) as { e: string | null } | undefined;
    return r?.e ?? null;
  }

  /** The files an agent made in a turn (not ones it was sent), as attachments for another computer. */
  turnFiles(sessionId: string, turnId: string): Attachment[] {
    const files = (this.db.prepare(`SELECT json_extract(data, '$.sha256') AS sha256, json_extract(data, '$.name') AS name, json_extract(data, '$.size') AS size,
      json_extract(data, '$.mime') AS mime FROM items WHERE session_id = ? AND turn_id = ? AND kind = 'artifact' AND json_extract(data, '$.sent') IS NULL ORDER BY ts`)
      .all(sessionId, turnId) as unknown as Attachment[]).filter((f) => f.sha256 && this.artifact(f.sha256));
    // A file written several times in one turn: only its last version.
    return [...new Map(files.map((f) => [f.name, f])).values()];
  }

  /** Everything the agent said in a turn, in order. */
  turnReply(sessionId: string, turnId: string): string {
    return (this.db.prepare("SELECT json_extract(data, '$.text') AS t FROM items WHERE session_id = ? AND turn_id = ? AND kind = 'message' AND json_extract(data, '$.role') = 'assistant' ORDER BY ts")
      .all(sessionId, turnId) as { t: string | null }[]).map((r) => r.t ?? '').filter(Boolean).join('\n\n');
  }

  /** Approvals and questions in one conversation still waiting for the owner, raised since `since` (ms). */
  waitingApprovals(sessionId: string, since: number): { kind: string; what: string }[] {
    return (this.db.prepare("SELECT json_extract(data, '$.kind') AS k, json_extract(data, '$.command') AS c, json_extract(data, '$.reason') AS r FROM items WHERE session_id = ? AND kind = 'approval_request' AND json_extract(data, '$.state') = 'pending' AND ts >= ?")
      .all(sessionId, since - 60_000) as { k: string; c: string | null; r: string | null }[]).map((x) => ({ kind: x.k, what: x.c ?? x.r ?? '' }));
  }

  setHydrated(id: string): void {
    this.db.prepare('UPDATE sessions SET hydrated = 1 WHERE id = ?').run(id);
  }

  hydratedSessions(deviceId: string): { agentId: string; threadId: string }[] {
    return (this.db.prepare('SELECT agent_id, thread_id FROM sessions WHERE device_id = ? AND hydrated = 1 AND archived = 0').all(deviceId) as { agent_id: string; thread_id: string }[])
      .map((r) => ({ agentId: r.agent_id, threadId: r.thread_id }));
  }

  // ---------- items ----------

  /** Upserts items, skipping ones whose content did not change. Returns the changed ones. */
  upsertItems(sessionId: string, items: Item[]): ItemView[] {
    const changed: ItemView[] = [];
    const select = this.db.prepare('SELECT hash FROM items WHERE session_id = ? AND item_id = ?');
    const upsert = this.db.prepare(`INSERT INTO items(session_id, item_id, turn_id, kind, ts, data, hash, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, item_id) DO UPDATE SET turn_id = excluded.turn_id, kind = excluded.kind, ts = excluded.ts,
        data = excluded.data, hash = excluded.hash, seq = excluded.seq`);
    this.db.exec('BEGIN');
    try {
      for (const item of items) {
        const data = JSON.stringify(item.data);
        const hash = sha256(`${item.kind}|${item.turnId}|${item.ts}|${data}`);
        const old = select.get(sessionId, item.itemId) as { hash: string } | undefined;
        if (old?.hash === hash) continue;
        const seq = this.nextSeq();
        upsert.run(sessionId, item.itemId, item.turnId, item.kind, item.ts, data, hash, seq);
        changed.push({ ...item, sessionId, seq });
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return changed;
  }

  /**
   * When an output file belongs in the conversation: right after the rest of its turn. Files of earlier
   * turns can arrive much later (a computer reading an old conversation for the first time).
   */
  turnTime(sessionId: string, turnId: string): number | null {
    const r = this.db.prepare("SELECT MAX(ts) AS ts FROM items WHERE session_id = ? AND turn_id = ? AND kind != 'artifact'").get(sessionId, turnId) as { ts: number | null };
    return r.ts === null ? null : r.ts + 1;
  }

  /** When a turn began: its first message (the prompt). */
  turnStart(sessionId: string, turnId: string): number | null {
    const r = this.db.prepare("SELECT MIN(ts) AS ts FROM items WHERE session_id = ? AND turn_id = ? AND kind = 'message'").get(sessionId, turnId) as { ts: number | null };
    return r.ts;
  }

  /** Once: files that were stamped with their arrival time move back to their own turn. */
  private placeArtifacts(): void {
    if (this.db.prepare("SELECT 1 FROM meta WHERE key = 'artifacts_placed'").get()) return;
    const rows = this.db.prepare("SELECT session_id, item_id, turn_id, ts FROM items WHERE kind = 'artifact' AND turn_id IS NOT NULL").all() as
      { session_id: string; item_id: string; turn_id: string; ts: number }[];
    const update = this.db.prepare('UPDATE items SET ts = ?, seq = ? WHERE session_id = ? AND item_id = ?');
    this.db.exec('BEGIN');
    for (const r of rows) {
      const ts = this.turnTime(r.session_id, r.turn_id);
      if (ts !== null && ts !== r.ts) update.run(ts, this.nextSeq(), r.session_id, r.item_id);
    }
    this.db.exec("INSERT INTO meta(key, value) VALUES ('artifacts_placed', '1'); COMMIT");
  }

  /** Items of one session after `after`, oldest first, capped to the most recent `limit`. */
  itemsAfter(sessionId: string, after: number, limit = 600): ItemView[] {
    const rows = this.db.prepare('SELECT * FROM items WHERE session_id = ? AND seq > ? ORDER BY seq DESC LIMIT ?').all(sessionId, after, limit) as unknown as ItemRow[];
    return rows.reverse().map(toItemView);
  }

  /** Approvals still waiting for an answer, across all live conversations. */
  pendingApprovals(): ItemView[] {
    return (this.db.prepare(`SELECT i.* FROM items i JOIN sessions s ON s.id = i.session_id
      WHERE i.kind = 'approval_request' AND json_extract(i.data, '$.state') = 'pending' AND s.archived = 0 ORDER BY i.ts DESC LIMIT 50`).all() as unknown as ItemRow[]).map(toItemView);
  }

  /** Output files across all live conversations, newest first. */
  artifactItems(limit = 300): ItemView[] {
    return (this.db.prepare(`SELECT i.* FROM items i JOIN sessions s ON s.id = i.session_id
      WHERE i.kind = 'artifact' AND s.archived = 0 ORDER BY i.ts DESC LIMIT ?`).all(limit) as unknown as ItemRow[]).map(toItemView);
  }

  // ---------- requests ----------

  /** Creates a request once; a repeated requestId returns the existing row unchanged. */
  createRequest(requestId: string, sessionId: string, op: CommandOp, payload: unknown, text: string | null, state: RequestState): { view: RequestView; created: boolean } {
    const existing = this.request(requestId);
    if (existing) return { view: existing, created: false };
    const seq = this.nextSeq();
    this.db.prepare('INSERT INTO requests(request_id, session_id, op, payload, text, state, created_at, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(requestId, sessionId, op, JSON.stringify(payload), text, state, Date.now(), seq);
    return { view: this.request(requestId)!, created: true };
  }

  updateRequest(requestId: string, state: RequestState, turnId?: string | null, error?: string | null): RequestView | undefined {
    const old = this.request(requestId);
    if (!old) return undefined;
    // A request never leaves a final state, and an identical update is not a change.
    if (['delivered', 'failed', 'cancelled'].includes(old.state)) return undefined;
    if (old.state === state && old.turnId === (turnId ?? old.turnId)) return undefined;
    // A note on a successful request (e.g. desktop_restart) stays once it reaches "delivered".
    this.db.prepare('UPDATE requests SET state = ?, turn_id = COALESCE(?, turn_id), error = COALESCE(?, error), seq = ? WHERE request_id = ?')
      .run(state, turnId ?? null, error ?? null, this.nextSeq(), requestId);
    return this.request(requestId);
  }

  request(requestId: string): RequestView | undefined {
    const r = this.db.prepare('SELECT * FROM requests WHERE request_id = ?').get(requestId) as RequestRow | undefined;
    return r ? toRequestView(r) : undefined;
  }

  requestPayload(requestId: string): unknown {
    const r = this.db.prepare('SELECT payload FROM requests WHERE request_id = ?').get(requestId) as { payload: string } | undefined;
    return r ? JSON.parse(r.payload) : undefined;
  }

  /** Requests changed after `after`, and every one of the last `recentMs` (the phone keeps none across a reload). */
  requestsAfter(after: number, recentMs = 0): RequestView[] {
    return (this.db.prepare('SELECT * FROM requests WHERE seq > ? OR created_at > ? ORDER BY seq').all(after, recentMs ? Date.now() - recentMs : Number.MAX_SAFE_INTEGER) as unknown as RequestRow[])
      .map(toRequestView);
  }

  /**
   * A recent, not yet delivered message with this text (messages queued through Codex, and Claude Code's, carry no request id).
   * A message with files reaches the conversation as its text followed by the attachment lines.
   */
  pendingSendByText(sessionId: string, text: string): RequestView | undefined {
    const rows = this.db.prepare(`SELECT * FROM requests WHERE session_id = ? AND op = 'send' AND state IN ('pending', 'accepted', 'unknown')
      AND created_at > ? ORDER BY created_at`).all(sessionId, Date.now() - 30 * 60_000) as unknown as RequestRow[];
    // Typed into the desktop app, line breaks may come back changed: compare without whitespace.
    const flat = (s: string) => s.replace(/\s+/g, '');
    const got = flat(text);
    const r = rows.find((x) => x.text !== null && (got === flat(x.text)
      || (x.text === ATTACHMENT_MARK ? got.startsWith(ATTACHMENT_MARK) : got.startsWith(flat(x.text) + ATTACHMENT_MARK))));
    return r ? toRequestView(r) : undefined;
  }

  queuedRequests(deviceId: string): RequestView[] {
    return (this.db.prepare("SELECT * FROM requests WHERE state = 'queued' AND session_id LIKE ? ORDER BY created_at").all(deviceId + ':%') as unknown as RequestRow[]).map(toRequestView);
  }

  // ---------- artifacts ----------

  saveArtifact(sha: string, name: string, size: number, mime: string, data: Buffer): void {
    const file = join(this.artifactDir, sha);
    if (!existsSync(file)) {
      writeFileSync(file + '.tmp', data);
      renameSync(file + '.tmp', file);
    }
    this.db.prepare('INSERT OR IGNORE INTO artifacts(sha256, name, size, mime, created_at) VALUES (?, ?, ?, ?, ?)').run(sha, name, size, mime, Date.now());
  }

  artifact(sha: string): { name: string; size: number; mime: string; path: string } | undefined {
    const r = this.db.prepare('SELECT name, size, mime FROM artifacts WHERE sha256 = ?').get(sha) as { name: string; size: number; mime: string } | undefined;
    return r ? { ...r, path: join(this.artifactDir, sha) } : undefined;
  }
}

function toSessionView(r: SessionRow): SessionView {
  return { id: r.id, deviceId: r.device_id, agentId: r.agent_id, threadId: r.thread_id, title: r.title, cwd: r.cwd,
    updatedAt: r.updated_at, running: Boolean(r.running), activeTurnId: r.active_turn_id, preview: r.preview,
    projectId: r.project_id, projectName: r.project_name, pinned: Boolean(r.pinned), muted: Boolean(r.muted), replies: r.replies, readReplies: r.read_replies, seq: r.seq };
}

function toItemView(r: ItemRow): ItemView {
  return { itemId: r.item_id, turnId: r.turn_id, kind: r.kind as Item['kind'], ts: r.ts,
    data: JSON.parse(r.data) as Record<string, unknown>, sessionId: r.session_id, seq: r.seq };
}

function toRequestView(r: RequestRow): RequestView {
  const files = r.op === 'send' ? (JSON.parse(r.payload) as Command).files : undefined;
  return { requestId: r.request_id, sessionId: r.session_id, op: r.op as CommandOp, text: r.text, ...(files?.length ? { files } : {}), state: r.state as RequestState,
    turnId: r.turn_id, error: r.error, createdAt: r.created_at, seq: r.seq };
}
