import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/hub/store.ts';

test('a hand-off owes its outcome once: a report and a wait racing settle it only once', () => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'ledger-')));
  const l = store.ledger;
  l.create('r1', 'pc:codex:t1', 'send', { requestId: 'r1', op: 'send', text: 'x' }, 'x', 'pending', 'n95:claude-code:a');
  l.create('r2', 'pc:codex:t1', 'send', { requestId: 'r2', op: 'send', text: 'y' }, 'y', 'pending'); // from the phone: owes nothing
  assert.deepEqual(l.due().map((h) => [h.requestId, h.fromSession]), [['r1', 'n95:claude-code:a']]);
  assert.deepEqual(l.due('pc:codex:other'), []);
  assert.equal(l.owed('r2'), null);
  assert.equal(l.settle('r1', 'waited'), true);
  assert.equal(l.settle('r1', 'sent', 'rep'), false); // the wait came first
  assert.equal(l.owed('r1'), 'waited');
  assert.deepEqual(l.due(), []);
});

test('hand-offs followed before the ledger move onto their requests', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-old-'));
  // A hub database from before: requests without the ledger's columns, cards in the senders' conversations, handbacks.
  const old = new DatabaseSync(join(dir, 'hub.sqlite'));
  old.exec(`CREATE TABLE requests (request_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, op TEXT NOT NULL, payload TEXT NOT NULL, text TEXT,
      state TEXT NOT NULL, turn_id TEXT, error TEXT, created_at INTEGER NOT NULL, seq INTEGER NOT NULL);
    CREATE TABLE items (session_id TEXT NOT NULL, item_id TEXT NOT NULL, turn_id TEXT, kind TEXT NOT NULL, ts INTEGER NOT NULL,
      data TEXT NOT NULL, hash TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (session_id, item_id));
    CREATE TABLE handbacks (request_id TEXT PRIMARY KEY, at INTEGER NOT NULL);`);
  const req = old.prepare("INSERT INTO requests VALUES (?, 'pc:codex:t1', 'send', '{}', 'x', 'delivered', NULL, NULL, ?, 1)");
  const card = old.prepare("INSERT INTO items VALUES ('n95:claude-code:a', ?, NULL, 'handoff', 1, ?, 'h', 1)");
  // `stale`: still open, but from two days ago: let go rather than reported days late.
  for (const [id, ended, at] of [['open', null, Date.now()], ['reported', 5, Date.now()], ['dropped', 5, Date.now()], ['stale', null, Date.now() - 2 * 86_400_000]] as const) {
    req.run(id, at);
    card.run(`handoff:${id}`, JSON.stringify({ task: id, endedAt: ended }));
  }
  req.run('phone', Date.now());
  old.prepare("INSERT INTO handbacks VALUES ('reported', 1)").run();
  old.close();
  const l = new Store(dir).ledger;
  assert.deepEqual(['open', 'reported', 'dropped', 'stale', 'phone'].map((id) => l.owed(id)), ['due', 'sent', 'late', 'late', null]);
  assert.deepEqual(l.due().map((h) => [h.requestId, h.fromSession]), [['open', 'n95:claude-code:a']]);
});
