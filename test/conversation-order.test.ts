import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/hub/store.ts';
import type { SessionInfo } from '../src/shared/protocol.ts';

const info = (over: Partial<SessionInfo> = {}): SessionInfo => ({ threadId: 't1', agentId: 'codex', title: '对话', cwd: null, updatedAt: 100,
  running: false, activeTurnId: null, preview: null, ...over });

test('a conversation goes by its latest message, as in a chat app, whatever older time its agent reports', () => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'order-')));
  const [s] = store.upsertSessions('d', 'codex', [info()], false);
  // A message today moves it on.
  assert.equal(store.touch(s.id, 500_000)?.updatedAt, 500);
  // An earlier message (an old conversation read the first time) does not move it back.
  assert.equal(store.touch(s.id, 300_000), undefined);
  // The agent still reports its own, older time (Codex until it touches the thread again): nothing changes.
  assert.deepEqual(store.upsertSessions('d', 'codex', [info({ updatedAt: 120 })], false), []);
  assert.equal(store.session(s.id)?.updatedAt, 500);
  // A later time from the agent is taken.
  assert.equal(store.upsertSessions('d', 'codex', [info({ updatedAt: 900 })], false)[0]?.updatedAt, 900);
});

test('conversations kept with a time older than their latest message are caught up', () => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'order-')));
  const [s] = store.upsertSessions('d', 'codex', [info({ updatedAt: 100 })], false);
  store.upsertItems(s.id, [{ itemId: 'm1', turnId: 't', kind: 'message', ts: 700_000, data: { role: 'assistant', text: '好' } }]);
  assert.equal(store.catchUpTimes(), 1);
  assert.equal(store.session(s.id)?.updatedAt, 700);
  assert.equal(store.catchUpTimes(), 0);
});
