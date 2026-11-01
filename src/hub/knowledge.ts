// The knowledge every agent shares, on every computer: what each computer has and where (facts), what was learned the
// hard way (lessons), and the owner's rules for working together (the 协作手册). Agents read it with the tool's `know`
// and add to it with `learn`: facts and lessons count at once, marked with who wrote them and when, and the owner can
// take any back on the phone. Rules come only from the owner's own handbook (`import`). A message one agent hands
// another carries the entries its words touch, so the receiver starts out knowing them.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export type KnowledgeKind = 'fact' | 'lesson' | 'rule';
export interface Entry {
  id: string; kind: KnowledgeKind; place: string; title: string; body: string; keys: string[];
  by: string; at: number; goneAt: number | null; goneBy: string | null;
}
interface Row { id: string; kind: string; place: string; title: string; body: string; keys: string; by: string; at: number; gone_at: number | null; gone_by: string | null }

const KIND_NAME: Record<KnowledgeKind, string> = { fact: '事实', lesson: '经验', rule: '规则' };
const MAX_TITLE = 80;
const MAX_BODY = 3000;
const MAX_KEYS = 12;
/** A message carries at most this many entries, each cut to this length (the rest with `know`). */
const ATTACH_MAX = 3;
const ATTACH_BODY = 600;
/** An entry a conversation was handed lately is not handed to it again. */
const ATTACHED_AGAIN_MS = 24 * 3_600_000;
/** Taken-back entries the phone still shows (to put one back). */
const GONE_SHOWN_MS = 7 * 24 * 3_600_000;

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, '');
const when = (ms: number) => new Date(ms + 8 * 3_600_000).toISOString().slice(0, 10); // Beijing date

export class Knowledge {
  private readonly db: DatabaseSync;
  /** sessionId → entry id → when it was handed there (kept in memory: after a restart an entry may come once more). */
  private readonly attached = new Map<string, Map<string, number>>();

  constructor(db: DatabaseSync) {
    this.db = db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS knowledge (id TEXT PRIMARY KEY, kind TEXT NOT NULL, place TEXT NOT NULL, title TEXT NOT NULL,
      body TEXT NOT NULL, keys TEXT NOT NULL, by TEXT NOT NULL, at INTEGER NOT NULL, gone_at INTEGER, gone_by TEXT)`);
  }

  private rows(where: string, ...args: (string | number)[]): Entry[] {
    return (this.db.prepare(`SELECT * FROM knowledge WHERE ${where} ORDER BY kind, place, at`).all(...args) as unknown as Row[]).map((r) => ({
      id: r.id, kind: r.kind as KnowledgeKind, place: r.place, title: r.title, body: r.body, keys: JSON.parse(r.keys) as string[],
      by: r.by, at: r.at, goneAt: r.gone_at, goneBy: r.gone_by }));
  }

  private live(): Entry[] {
    return this.rows('gone_at IS NULL');
  }

  entry(id: string): Entry | undefined {
    return this.rows('id = ?', id)[0];
  }

  private takeBack(id: string, by: string): void {
    this.db.prepare('UPDATE knowledge SET gone_at = ?, gone_by = ? WHERE id = ? AND gone_at IS NULL').run(Date.now(), by, id);
  }

  /**
   * An agent adds a fact or a lesson; it counts at once. One with the same title for the same computer, or the one it
   * names in `replaces`, is taken back in its favour (that is how a wrong entry is put right).
   */
  learn(args: Record<string, unknown>, by: string): unknown {
    const kind = String(args.kind ?? 'fact');
    if (kind !== 'fact' && kind !== 'lesson') throw new Error('kind 只能是 fact（事实：有什么、在哪、怎么用）或 lesson（经验：踩过的坑）；协作规则由主人自己定');
    const title = String(args.title ?? '').trim();
    const body = String(args.body ?? '').trim();
    const place = String(args.computer ?? '').trim();
    const keys = (Array.isArray(args.keys) ? args.keys : String(args.keys ?? '').split(/[,，、;；]/)).map((k) => String(k).trim()).filter(Boolean);
    if (!title || title.length > MAX_TITLE) throw new Error(`要有标题（最多 ${MAX_TITLE} 个字）`);
    if (!body || body.length > MAX_BODY) throw new Error(`要有内容（最多 ${MAX_BODY} 个字）`);
    if (!keys.length || keys.length > MAX_KEYS) throw new Error(`要给 1～${MAX_KEYS} 个关键词：别人的任务里出现这些词，这条就会自动附上`);
    if (/(api[_-]?key|token|password|密码|密钥)\s*[:=：]\s*\S{8,}/i.test(body)) throw new Error('内容里像是有密钥或密码：只写它配在哪里，不要写值');
    const replaced = [...(typeof args.replaces === 'string' && args.replaces ? [args.replaces] : []),
      ...this.live().filter((e) => e.kind !== 'rule' && e.title === title && norm(e.place) === norm(place)).map((e) => e.id)];
    for (const id of replaced) {
      const old = this.entry(id);
      if (!old || old.goneAt) throw new Error(`没有这条：${id}`);
      if (old.kind === 'rule') throw new Error('协作规则只能由主人改');
    }
    for (const id of replaced) this.takeBack(id, `${by} 改正`);
    const id = randomUUID().slice(0, 8);
    this.db.prepare('INSERT INTO knowledge(id, kind, place, title, body, keys, by, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, kind, place, title, body, JSON.stringify(keys.slice(0, MAX_KEYS)), by, Date.now());
    const similar = this.live().filter((e) => e.id !== id && e.kind !== 'rule' && norm(e.place) === norm(place)
      && e.keys.some((k) => keys.some((n) => norm(n) === norm(k))));
    return { id, saved: true, ...(replaced.length ? { replaced } : {}),
      ...(similar.length ? { note: `同一台电脑上还有关键词相同的条目，看看是否重复或矛盾，矛盾就用 replaces 改正：${similar.slice(0, 5).map((e) => `${e.id}「${e.title}」`).join('、')}` } : {}) };
  }

  /** The owner's handbook, section by section: it takes the place of the rules there were. */
  importRules(args: Record<string, unknown>, by: string): unknown {
    const rules = Array.isArray(args.rules) ? args.rules as Record<string, unknown>[] : [];
    if (!rules.length) throw new Error('没有规则');
    for (const e of this.live().filter((x) => x.kind === 'rule')) this.takeBack(e.id, `${by}（换成新版手册）`);
    const insert = this.db.prepare('INSERT INTO knowledge(id, kind, place, title, body, keys, by, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const r of rules) {
      insert.run(randomUUID().slice(0, 8), 'rule', String(r.computer ?? ''), String(r.title ?? '').slice(0, MAX_TITLE),
        String(r.body ?? ''), JSON.stringify(Array.isArray(r.keys) ? r.keys.map(String) : []), String(args.source ?? by), Date.now());
    }
    return { rules: rules.length };
  }

  /**
   * Without words: what there is, by title. With words: the entries that match them best, in full. `computer` keeps to
   * one computer's entries (and those for every computer).
   */
  know(args: Record<string, unknown>): unknown {
    const query = String(args.query ?? '').trim();
    const place = norm(String(args.computer ?? ''));
    const entries = this.live().filter((e) => !place || !e.place || norm(e.place) === place);
    const show = (e: Entry) => ({ id: e.id, type: KIND_NAME[e.kind], computer: e.place || '所有电脑', title: e.title, body: e.body, keys: e.keys, by: `${e.by}，${when(e.at)}` });
    if (!query) {
      return { note: '用 query 查具体内容；要读完整的协作手册，query 写「协作手册」。发现不对或有新事实，用 learn 记下来',
        index: entries.map((e) => `${e.id} [${KIND_NAME[e.kind]}·${e.place || '所有电脑'}] ${e.title}`) };
    }
    if (/^(协作)?手册$|^规则$/.test(query)) return { entries: entries.filter((e) => e.kind === 'rule').map(show) };
    const q = norm(query);
    const terms = [...new Set([q, ...query.toLowerCase().split(/[\s,，、;；。.!?！？]+/).map(norm).filter((t) => t.length >= 2)])];
    const scored = entries.map((e) => {
      const title = norm(e.title);
      const body = norm(e.body);
      let score = 0;
      for (const k of e.keys.map(norm)) if (k && (q.includes(k) || k.includes(q))) score += 3;
      for (const t of terms) score += (title.includes(t) ? 2 : 0) + (body.includes(t) ? 1 : 0);
      return { e, score };
    }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
    if (!scored.length) return { entries: [], note: '没有找到。换个说法再查，或不带 query 看全部标题；查清楚了请用 learn 记下来' };
    return { entries: scored.slice(0, 8).map((x) => show(x.e)) };
  }

  /**
   * The entries a message touches (one of their keywords is in it), for the computer it goes to: added to the message,
   * at most ATTACH_MAX, none the conversation was handed in the last day. Rules are not added (agents read them with `know`).
   */
  related(text: string, computer: string, sessionId: string): string {
    const t = norm(text);
    const seen = this.attached.get(sessionId) ?? new Map<string, number>();
    const since = Date.now() - ATTACHED_AGAIN_MS;
    const hits = this.live().filter((e) => e.kind !== 'rule' && (!e.place || norm(e.place) === norm(computer)) && !((seen.get(e.id) ?? 0) > since))
      .map((e) => ({ e, n: e.keys.filter((k) => norm(k) && t.includes(norm(k))).length }))
      .filter((x) => x.n > 0).sort((a, b) => b.n - a.n || (a.e.place ? -1 : 1)).slice(0, ATTACH_MAX);
    if (!hits.length) return '';
    for (const { e } of hits) seen.set(e.id, Date.now());
    this.attached.set(sessionId, seen);
    const lines = hits.map(({ e }) => {
      const body = e.body.length > ATTACH_BODY ? `${e.body.slice(0, ATTACH_BODY)}……（全文用 know 查 ${e.id}）` : e.body;
      return `- 【${e.place || '所有电脑'}·${e.title}】${body}（${e.by}，${when(e.at)}）`;
    });
    return `\n\n（AgentChat 知识库里和这件事有关的条目，开工前先看；和实际不符请用 allinone 的 learn 改正：\n${lines.join('\n')}）`;
  }

  /** The routes under /api/knowledge/ for the phone: the list, taking an entry back, putting it back. */
  handle(req: IncomingMessage, url: URL, res: ServerResponse, done: (what: string) => void): boolean {
    if (!url.pathname.startsWith('/api/knowledge/')) return false;
    const reply = (status: number, body: unknown) => void res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    const op = `${req.method} ${url.pathname.slice('/api/knowledge/'.length)}`;
    if (op === 'GET list') return reply(200, { entries: this.rows('gone_at IS NULL OR gone_at > ?', Date.now() - GONE_SHOWN_MS) }), true;
    const e = this.entry(url.searchParams.get('id') ?? '');
    if (!e) return reply(404, { error: '没有这一条' }), true;
    if (op === 'POST withdraw') {
      if (e.kind === 'rule') return reply(400, { error: '协作规则在手册里改' }), true;
      this.takeBack(e.id, '老周');
      done(`撤掉了知识库条目「${e.title}」`);
    } else if (op === 'POST restore') {
      this.db.prepare('UPDATE knowledge SET gone_at = NULL, gone_by = NULL WHERE id = ?').run(e.id);
      done(`恢复了知识库条目「${e.title}」`);
    } else return reply(405, { error: '不支持' }), true;
    return reply(200, { ok: true }), true;
  }
}
