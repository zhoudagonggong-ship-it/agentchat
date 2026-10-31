import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/hub/store.ts';
import { callKey, carriesTag, forwardMark, markTag, recordsCall, sessionKey } from '../src/shared/protocol.ts';

const session = (agentId: string, threadId: string) => ({ threadId, agentId, title: threadId, cwd: null, updatedAt: 1, running: false, activeTurnId: null, preview: null });

function setup() {
  const store = new Store(mkdtempSync(join(tmpdir(), 'hub-')));
  store.registerDevice('pc', '5090', 's', []);
  store.upsertSessions('pc', 'opencode', [session('opencode', 'o1')], true);
  store.upsertSessions('pc', 'codex', [session('codex', 'c1')], true);
  return store;
}
const send = (store: Store, id: string, to: string, origin: object | null, state: any = 'pending') =>
  store.ledger.create(id, to, 'send', { requestId: id, op: 'send', text: 'x', ...(origin ? { origin } : {}) }, 'x', state);

test('counts an agent\'s sends and how deep it works in a chain', () => {
  const store = setup();
  const oc = sessionKey('pc', 'opencode', 'o1');
  const cx = sessionKey('pc', 'codex', 'c1');
  assert.equal(store.ledger.chainDepth('pc', 'codex', 0), 0);
  send(store, 'req00001', cx, { deviceId: 'n95', agentId: 'claude-code', label: 'N95 · Claude', depth: 1 }); // Claude → Codex
  send(store, 'req00002', oc, { deviceId: 'pc', agentId: 'codex', label: '5090 · Codex', depth: 2 }); // Codex → OpenCode
  send(store, 'req00003', oc, null); // the owner, from the phone: not an agent's send
  send(store, 'req00004', cx, { deviceId: 'n95', agentId: 'claude-code', label: 'N95 · Claude', depth: 1 }, 'failed');
  assert.equal(store.ledger.chainDepth('pc', 'codex', 0), 1); // the failed one does not count
  assert.equal(store.ledger.chainDepth('pc', 'opencode', 0), 2);
  assert.equal(store.ledger.agentSends('n95', 'claude-code', 0), 2);
  assert.equal(store.ledger.agentSends('pc', 'codex', 0), 1);
  assert.equal(store.ledger.agentSends('pc', 'codex', Date.now() + 1000), 0);

  // Counted along the conversation: Codex's latest turn there came from Claude (depth 1); OpenCode's from the owner.
  assert.equal(store.ledger.turnDepth(cx, 0), 1);
  assert.equal(store.ledger.turnDepth(oc, 0), 0);
  // The owner then types on the computer in Codex's conversation: a new chain starts there.
  store.upsertItems(cx, [{ itemId: 'u9', turnId: 't9', kind: 'message', ts: Date.now() + 10, data: { role: 'user', text: '帮我联系一下另一台电脑' } }]);
  assert.equal(store.ledger.turnDepth(cx, 0), 0);
  // A message another agent forwarded there does not.
  store.upsertItems(cx, [{ itemId: 'u10', turnId: 't10', kind: 'message', ts: Date.now() + 20, data: { role: 'user', text: '[来自 N95 · Claude，经 AllinOne 转发] 再做一件' } }]);
  send(store, 'req00005', cx, { deviceId: 'n95', agentId: 'claude-code', label: 'N95 · Claude', depth: 2 });
  assert.equal(store.ledger.turnDepth(cx, 0), 2);
  assert.equal(store.ledger.turnDepth(cx, Date.now() + 1000), 0); // too long ago: finished
});

test('a message sent is found in the sending agent\'s records of the call, however they quote it', () => {
  const text = '第 2 步已核对，通过：\n- 提示词 10/10 逐字一致';
  const key = callKey(text);
  assert.equal(key, '第2步已核对通过');
  // OpenCode running code that calls the tool; Codex's record of a function call (JSON in JSON); Goose's \u escapes.
  const opencode = JSON.stringify({ code: `await tools.allinone.send({ conversationId: "x", text: ${JSON.stringify(text)} })` });
  const codex = JSON.stringify({ type: 'function_call', name: 'mcp__allinone__send', arguments: JSON.stringify({ text }) });
  const goose = '{"toolRequest":{"name":"allinone__send","arguments":{"text":"\\u7b2c 2 \\u6b65\\u5df2\\u6838\\u5bf9\\uff0c\\u901a\\u8fc7\\uff1a\\n- x"}}}';
  for (const raw of [opencode, codex, goose]) assert.equal(recordsCall(raw, key), true, raw.slice(0, 60));
  // The same words, but not in a call of AgentChat's tool (the message delivered, quoted in a reply): not the sender.
  assert.equal(recordsCall(JSON.stringify({ role: 'assistant', text }), key), false);
  assert.equal(recordsCall(opencode, callKey('别的消息内容')), false);
});

test('a forwarded message carries its request\'s tag; a repeat from the same conversation is found', () => {
  const store = setup();
  const oc = sessionKey('pc', 'opencode', 'o1');
  const id = 'abcdef0123456789abcdef0123456789';
  const text = `${forwardMark('N95 · Claude「宣传片」', id)} 做个视频`;
  assert.equal(text, '[来自 N95 · Claude「宣传片」，经 AgentChat 转发 #abcdef01] 做个视频');
  assert.equal(markTag(text), 'abcdef01');
  assert.equal(markTag('[来自 N95 · Claude，经 AgentChat 转发] 没有编号的旧消息'), null);
  assert.equal(markTag('随手打的一句话 #abcdef01'), null);
  // With the addressee on the envelope, and found in an agent's raw records, escaped or not.
  const addressed = `${forwardMark('N95 · Claude「宣传片」', id, '小工具')} 做个视频`;
  assert.equal(addressed, '[来自 N95 · Claude「宣传片」，经 AgentChat 转发给「小工具」 #abcdef01] 做个视频');
  assert.equal(markTag(addressed), 'abcdef01');
  assert.equal(carriesTag(JSON.stringify({ content: addressed }), 'abcdef01'), true);
  assert.equal(carriesTag('{"text":"[\\u6765\\u81ea X\\uff0c\\u7ecf AgentChat \\u8f6c\\u53d1 #abcdef01] hi"}', 'abcdef01'), true);
  // AgentChat's own correction names the tag but is not the message.
  assert.equal(carriesTag('[AgentChat 更正 #abcdef01] 刚才那条带 #abcdef01 的消息是误投', 'abcdef01'), false);
  assert.equal(carriesTag('{"text":"[AgentChat \\u66f4\\u6b63 #abcdef01] x"}', 'abcdef01'), false);
  assert.equal(carriesTag(addressed, 'abcdef02'), false);
  const claude = { deviceId: 'n95', agentId: 'claude-code', label: 'N95 · Claude', depth: 1, sessionId: 'n95:claude-code:t1' };
  store.ledger.create(id, oc, 'send', { requestId: id, op: 'send', text, origin: claude }, text, 'pending');
  assert.equal(store.ledger.byTag(oc, 'abcdef01')?.requestId, id);
  assert.equal(store.ledger.byTag(oc, '99999999'), undefined);
  assert.deepEqual(store.ledger.recentSends(oc, claude, 0).map((r) => r.requestId), [id]);
  assert.deepEqual(store.ledger.recentSends(oc, { ...claude, sessionId: 'n95:claude-code:t2' }, 0), []); // another conversation of the sender
  assert.deepEqual(store.ledger.recentSends(oc, claude, Date.now() + 1000), []); // too long ago
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
