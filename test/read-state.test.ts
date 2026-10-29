import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/hub/store.ts';
import type { SessionInfo } from '../src/shared/protocol.ts';

const info = (over: Partial<SessionInfo> = {}): SessionInfo => ({ threadId: 't1', agentId: 'codex', title: '对话', cwd: null, updatedAt: 100,
  running: false, activeTurnId: null, preview: '你好', ...over });

test('only real replies are unread, and what was read is kept on the hub', () => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'read-')));
  // Seen the first time: nothing to read, and a pin from the agent's own app is not taken.
  let [s] = store.upsertSessions('d', 'codex', [info({ pinned: true })], false);
  assert.equal(s.replies, 0);
  assert.equal(s.pinned, false);

  // Renamed, or touched by the agent: the time moves but there is no reply.
  store.upsertSessions('d', 'codex', [info({ title: '新名字', updatedAt: 110 })], false);
  assert.equal(store.session(s.id)!.replies, 0);

  // A turn runs and finishes: one reply. A new latest message while nothing runs: another.
  store.upsertSessions('d', 'codex', [info({ updatedAt: 120, running: true, activeTurnId: 'x' })], false);
  store.upsertSessions('d', 'codex', [info({ updatedAt: 130, preview: '回复一' })], false);
  store.upsertSessions('d', 'codex', [info({ updatedAt: 140, preview: '回复二' })], false);
  s = store.session(s.id)!;
  assert.equal(s.replies, 2);
  assert.equal(s.readReplies, 0);

  assert.equal(store.markRead(s.id, 2)!.readReplies, 2);
  assert.equal(store.markRead(s.id, 1), undefined); // never goes back
  assert.equal(store.markRead(s.id, 99), undefined); // nor beyond the replies there are
  assert.equal(store.setFlag(s.id, 'pinned', true)!.pinned, true);
  assert.equal(store.isMuted(s.id), false);
  assert.equal(store.setFlag(s.id, 'muted', true)!.muted, true);
  assert.equal(store.isMuted(s.id), true);
  store.setFlag(s.id, 'muted', false);
  // Muting the agent mutes all its conversations; its picture and nickname are kept on the hub with it.
  store.db.exec("INSERT OR IGNORE INTO friends(device_id, agent_id, added) VALUES ('d', 'codex', 1)");
  assert.equal(store.setFriend('d', 'codex', { muted: true, avatar: 'a'.repeat(64), remark: '小助手' }), true);
  assert.equal(store.isMuted(s.id), true);
  assert.deepEqual(store.friends().map((f) => [f.remark, f.avatar, f.muted]), [['小助手', 'a'.repeat(64), true]]);
  // The agent's next report keeps the owner's pin.
  store.upsertSessions('d', 'codex', [info({ updatedAt: 150, preview: '回复三', pinned: false })], false);
  assert.equal(store.session(s.id)!.pinned, true);
});
