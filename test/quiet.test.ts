import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/hub/store.ts';
import { forwardMark } from '../src/shared/protocol.ts';
import type { SessionInfo } from '../src/shared/protocol.ts';

const conv = (updatedAt: number, running: boolean, preview: string): SessionInfo =>
  ({ threadId: 't1', title: '工厂控制台开发', cwd: null, updatedAt, running, activeTurnId: running ? 'turn' : null, preview } as SessionInfo);

test("replies to the owner's messages count for the owner; replies to agents' messages count quietly and keep the list's order", () => {
  const dir = mkdtempSync(join(tmpdir(), 'quiet-'));
  const store = new Store(dir);
  const id = 'pc:codex:t1';
  store.upsertSessions('pc', 'codex', [conv(1000, false, 'hi')], true);
  // The owner sends from the phone: the reply is theirs.
  store.ledger.create('req-owner-0001', id, 'send', { op: 'send', text: '帮我看看' }, '帮我看看', 'delivered');
  store.upsertSessions('pc', 'codex', [conv(1100, true, '帮我看看')], true);
  let [s] = store.upsertSessions('pc', 'codex', [conv(1200, false, '看好了')], true);
  assert.equal(s.replies, 1);
  assert.equal(s.quiet, 0);
  assert.equal(s.caredAt, 1200);
  // Another agent sends (AgentChat's mark): the reply is the agents' own.
  const text = `${forwardMark('5090 · OpenCode「影视工厂」', 'abcdef0123456789')} 进度如何？`;
  store.ledger.create('abcdef0123456789', id, 'send', { op: 'send', text }, text, 'delivered');
  store.upsertSessions('pc', 'codex', [conv(1300, true, text)], true);
  [s] = store.upsertSessions('pc', 'codex', [conv(1400, false, '还在做')], true);
  assert.equal(s.replies, 1);
  assert.equal(s.quiet, 1);
  assert.equal(s.caredAt, 1200, 'the agents talking does not move the conversation up');
  assert.equal(s.updatedAt, 1400);
  // Read on the phone: both kinds.
  const read = store.markRead(id, 1, 1)!;
  assert.equal(read.readReplies, 1);
  assert.equal(read.readQuiet, 1);
  // The owner writes to it again: it comes up.
  store.cared(id);
  assert.ok(store.session(id)!.caredAt! > 1400);
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a turn answering an agent's message is told from the turn's own message when the hub follows the conversation", () => {
  const dir = mkdtempSync(join(tmpdir(), 'quiet-'));
  const store = new Store(dir);
  const id = 'pc:claude:t1';
  store.upsertSessions('pc', 'claude', [conv(1000, false, 'hi')], true);
  const report = '[来自 laptop · Claude Code「试验」的汇报，经 AgentChat 转发给「Workbuddy 桥接」 #b1986d81] 做完了';
  store.upsertItems(id, [
    { itemId: 'u1', turnId: 'A', kind: 'message', ts: 5000, data: { role: 'user', text: '我自己打的字' } },
    { itemId: 'u2', turnId: 'B', kind: 'message', ts: 6000, data: { role: 'user', text: report } },
  ]);
  assert.equal(store.fromAgent(id, 'A'), false);
  assert.equal(store.fromAgent(id, 'B'), true);
  assert.equal(store.fromAgent(id), true); // the latest
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});
