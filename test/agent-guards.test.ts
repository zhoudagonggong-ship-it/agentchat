import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/hub/store.ts';
import { sessionKey } from '../src/shared/protocol.ts';

const session = (agentId: string, threadId: string) => ({ threadId, agentId, title: threadId, cwd: null, updatedAt: 1, running: false, activeTurnId: null, preview: null });

function setup() {
  const store = new Store(mkdtempSync(join(tmpdir(), 'hub-')));
  store.registerDevice('pc', '5090', 's', []);
  store.upsertSessions('pc', 'opencode', [session('opencode', 'o1')], true);
  store.upsertSessions('pc', 'codex', [session('codex', 'c1')], true);
  return store;
}
const send = (store: Store, id: string, to: string, origin: object | null, state: any = 'pending') =>
  store.createRequest(id, to, 'send', { requestId: id, op: 'send', text: 'x', ...(origin ? { origin } : {}) }, 'x', state);

test('counts an agent\'s sends and how deep it works in a chain', () => {
  const store = setup();
  const oc = sessionKey('pc', 'opencode', 'o1');
  const cx = sessionKey('pc', 'codex', 'c1');
  assert.equal(store.chainDepth('pc', 'codex', 0), 0);
  send(store, 'req00001', cx, { deviceId: 'n95', agentId: 'claude-code', label: 'N95 · Claude', depth: 1 }); // Claude → Codex
  send(store, 'req00002', oc, { deviceId: 'pc', agentId: 'codex', label: '5090 · Codex', depth: 2 }); // Codex → OpenCode
  send(store, 'req00003', oc, null); // the owner, from the phone: not an agent's send
  send(store, 'req00004', cx, { deviceId: 'n95', agentId: 'claude-code', label: 'N95 · Claude', depth: 1 }, 'failed');
  assert.equal(store.chainDepth('pc', 'codex', 0), 1); // the failed one does not count
  assert.equal(store.chainDepth('pc', 'opencode', 0), 2);
  assert.equal(store.agentSends('n95', 'claude-code', 0), 2);
  assert.equal(store.agentSends('pc', 'codex', 0), 1);
  assert.equal(store.agentSends('pc', 'codex', Date.now() + 1000), 0);

  // Counted along the conversation: Codex's latest turn there came from Claude (depth 1); OpenCode's from the owner.
  assert.equal(store.turnDepth(cx, 0), 1);
  assert.equal(store.turnDepth(oc, 0), 0);
  // The owner then types on the computer in Codex's conversation: a new chain starts there.
  store.upsertItems(cx, [{ itemId: 'u9', turnId: 't9', kind: 'message', ts: Date.now() + 10, data: { role: 'user', text: '帮我联系一下另一台电脑' } }]);
  assert.equal(store.turnDepth(cx, 0), 0);
  // A message another agent forwarded there does not.
  store.upsertItems(cx, [{ itemId: 'u10', turnId: 't10', kind: 'message', ts: Date.now() + 20, data: { role: 'user', text: '[来自 N95 · Claude，经 AllinOne 转发] 再做一件' } }]);
  send(store, 'req00005', cx, { deviceId: 'n95', agentId: 'claude-code', label: 'N95 · Claude', depth: 2 });
  assert.equal(store.turnDepth(cx, 0), 2);
  assert.equal(store.turnDepth(cx, Date.now() + 1000), 0); // too long ago: finished
});

test('friends take agents\' messages unless the owner turned it off; settings are kept', () => {
  const store = setup();
  assert.equal(store.acceptsAgents('pc', 'opencode'), true);
  assert.equal(store.acceptsAgents('nowhere', 'x'), true);
  if (store.setFriend('pc', 'opencode', { acceptAgents: false })) assert.equal(store.acceptsAgents('pc', 'opencode'), false);
  assert.equal(store.setting('agentLinks'), null);
  store.setSetting('agentLinks', '0');
  assert.equal(store.setting('agentLinks'), '0');
});
