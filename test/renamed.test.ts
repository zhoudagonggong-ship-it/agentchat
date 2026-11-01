import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/hub/store.ts';
import { Relay } from '../src/hub/relay.ts';
import { sessionKey } from '../src/shared/protocol.ts';

const conv = (threadId: string, title: string) => ({ threadId, agentId: 'codex', title, cwd: null, updatedAt: 1, running: false, activeTurnId: null, preview: null });

test('a conversation the owner renamed is still found by its old name; part of a name finds only one alone', async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'hub-')));
  store.registerDevice('pc', '5090', 's', [{ id: 'codex', kind: 'codex', label: 'Codex' }]);
  store.approveDevice('pc');
  store.upsertSessions('pc', 'codex', [conv('c1', '语言分级开发'), conv('c2', '语言分级开发 第二期')], true);
  const relay = new Relay({ store, devices: new Map(), hubId: 'hub' } as any) as any;
  const to = '5090 · Codex';
  const c1 = sessionKey('pc', 'codex', 'c1');
  const c2 = sessionKey('pc', 'codex', 'c2');
  assert.equal(relay.findTarget({ to, conversation: '语言分级开发' }), c1);

  // The owner renames the first one.
  store.upsertSessions('pc', 'codex', [conv('c1', '分级词表'), conv('c2', '语言分级开发 第二期')], true);
  assert.equal(relay.findTarget({ to, conversation: '语言分级开发' }), c1, 'by its old name, not the other one that contains it');
  assert.equal(relay.findTarget({ to, conversation: '分级词表' }), c1);
  assert.equal(relay.findTarget({ to, conversation: '第二期' }), c2);
  // An agent opening "a work conversation" by the old name goes on in the renamed one, not in a new second one.
  const made = await relay.createFor({ deviceId: 'n95', agentId: 'claude-code', label: 'N95 · Claude' }, { to, title: '语言分级开发' }, { requestId: 'r1', op: 'send', text: 'x' });
  assert.deepEqual(made, { sessionId: c1, sent: false });

  // Part of a name that two conversations share is not guessed.
  store.upsertSessions('pc', 'codex', [conv('c1', '分级词表 一期'), conv('c2', '分级词表 二期')], true);
  assert.throws(() => relay.findTarget({ to, conversation: '期' }), /几个对话的名字含/);
  assert.equal(relay.findTarget({ to, conversation: '分级词表' }), c1, 'a name it had before goes before part of a name');
  assert.equal(relay.findTarget({ to, conversation: '语言分级开发' }), c1, 'renamed twice: the first name still finds it');
  assert.throws(() => relay.findTarget({ to, conversation: '没有这个' }), /没有叫/);
  store.db.close();
});
