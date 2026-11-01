import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/hub/store.ts';
import { Relay, workRules } from '../src/hub/relay.ts';
import { sessionKey } from '../src/shared/protocol.ts';

const conv = (threadId: string, agentId: string, title: string) => ({ threadId, agentId, title, cwd: null, updatedAt: 1, running: false, activeTurnId: null, preview: null });

/** Claude Code on laptop handed work to OpenCode on office-pc; OpenCode stops at a rule and asks. */
function setup() {
  const store = new Store(mkdtempSync(join(tmpdir(), 'hub-')));
  store.registerDevice('n95', 'laptop', 's', [{ id: 'claude-code', kind: 'claude-code', label: 'Claude Code' }]);
  store.registerDevice('pc', 'office-pc', 's', [{ id: 'opencode', kind: 'opencode', label: 'OpenCode' }]);
  store.upsertSessions('n95', 'claude-code', [conv('c1', 'claude-code', '工厂控制台开发')], true);
  store.upsertSessions('pc', 'opencode', [conv('o1', 'opencode', '影视工厂开发')], true);
  const boss = sessionKey('n95', 'claude-code', 'c1');
  const worker = sessionKey('pc', 'opencode', 'o1');
  const origin = { deviceId: 'n95', agentId: 'claude-code', label: 'laptop · Claude Code', sessionId: boss, depth: 1 };
  store.ledger.create('job1', worker, 'send', { requestId: 'job1', op: 'send', text: '[来自 laptop · Claude Code「工厂控制台开发」，经 AgentChat 转发] 跑《波希米亚丑闻》', origin },
    '跑《波希米亚丑闻》', 'delivered', boss);
  const submitted: { sessionId: string; command: any }[] = [];
  const notices: any[] = [];
  const port: any = { store, hubId: 'n95', devices: new Map(), settings: () => ({ agentLinks: true, autoReport: true }),
    submit: (sessionId: string, command: any) => (submitted.push({ sessionId, command }), { view: { state: 'pending' }, created: true }),
    putItems: (sessionId: string, items: any[]) => store.upsertItems(sessionId, items), notice: (n: any) => notices.push(n) };
  const relay = new Relay(port) as any;
  return { store, relay, boss, worker, origin, submitted, notices };
}

const ask = (id: string, data: Record<string, unknown>) => ({ itemId: `approval:${id}`, turnId: 't1', kind: 'approval_request' as const, ts: Date.now(),
  data: { approvalId: id, state: 'pending', ...data } });

test('an approval in handed-over work goes to the agent that handed it over, which answers it', async () => {
  const { store, relay, boss, worker, origin, submitted, notices } = setup();
  const item = ask('per_1', { kind: 'file', reason: 'D:/work/test/checks.test.mjs' });
  const route = relay.routeFor(worker, item);
  assert.deepEqual(route, { to: '工厂控制台开发', escalated: false });
  store.upsertItems(worker, [{ ...item, data: { ...item.data, routedTo: route.to } }]);
  await new Promise((r) => setTimeout(r, 10));
  // The 请示 goes into the sender's conversation, with what it wants and how to answer.
  const asked = submitted.find((s) => s.sessionId === boss)!;
  assert.match(asked.command.text, /^\[来自 office-pc · OpenCode「影视工厂开发」的请示，经 AgentChat 转发给「工厂控制台开发」/);
  assert.match(asked.command.text, /\[approval "per_1"\] 它要改文件：D:\/work\/test\/checks\.test\.mjs/);
  assert.match(asked.command.text, /allow_all/);
  assert.equal(notices.length, 0, 'the owner is not asked');
  assert.equal(store.pendingApprovals().length, 0, 'nor is it in 待我处理');
  assert.equal(relay.handoffState('job1').state, 'waiting_sender');

  // Only the agent it went to may answer it.
  assert.throws(() => relay.askApprove({ deviceId: 'pc', agentId: 'opencode', label: 'x' }, { approval: 'per_1', decision: 'allow' }), /不是发给你的/);
  const answer = relay.askApprove(origin, { approval: 'per_1', decision: 'deny', message: '测试断言不能删，改实现' });
  assert.deepEqual(answer, { state: 'sent', decision: 'deny' });
  const sent = submitted.at(-1)!;
  assert.equal(sent.sessionId, worker);
  assert.deepEqual([sent.command.op, sent.command.approvalId, sent.command.decision, sent.command.note], ['approve', 'per_1', 'decline', '测试断言不能删，改实现']);
  store.db.close();
});

test('while one 请示 is unanswered the next ones wait, then go together in one message; allow_all grants the like of it', async () => {
  const { store, relay, boss, worker, origin, submitted } = setup();
  const raise = async (id: string, command: string) => {
    const item = ask(id, { kind: 'command', command });
    const route = relay.routeFor(worker, item);
    store.upsertItems(worker, [{ ...item, data: { ...item.data, routedTo: route.to } }]);
    await new Promise((r) => setTimeout(r, 10));
  };
  await raise('c1', 'Get-ChildItem D:\\a');
  await raise('c2', 'Get-ChildItem D:\\b');
  await raise('c3', 'Copy-Item x y');
  const toBoss = () => submitted.filter((s) => s.sessionId === boss);
  assert.equal(toBoss().length, 1, 'one 请示 out; the others wait for its answer');

  relay.askApprove(origin, { approval: 'c1', decision: 'allow_all' });
  assert.equal(submitted.at(-1)!.command.decision, 'acceptForSession');
  store.upsertItems(worker, [{ ...ask('c1', {}), data: { approvalId: 'c1', state: 'accepted', routedTo: '工厂控制台开发' } }]); // the agent took it
  relay.watch();
  assert.equal(toBoss().length, 2);
  const together = toBoss().at(-1)!.command.text;
  assert.match(together, /有 2 件事停下来等你批/);
  assert.match(together, /1\. \[approval "c2"\][\s\S]*2\. \[approval "c3"\]/);
  relay.watch();
  assert.equal(toBoss().length, 2, 'not again while those wait for their answers');
  store.db.close();
});

test('a 请示 left unanswered for half an hour comes to the owner; work the owner gave stays the owner’s', async () => {
  const { store, relay, worker, notices } = setup();
  const item = ask('per_2', { kind: 'command', command: 'node rerun.mjs' });
  const route = relay.routeFor(worker, item);
  store.upsertItems(worker, [{ ...item, data: { ...item.data, routedTo: route.to } }]);
  await new Promise((r) => setTimeout(r, 10));
  store.db.prepare('UPDATE approval_routes SET at = ?').run(Date.now() - 31 * 60_000);
  relay.watch();
  assert.equal(notices.length, 1);
  assert.match(notices[0].text, /派活方 30 分钟没有答复：node rerun\.mjs/);
  assert.equal(store.pendingApprovals().length, 1, 'now in 待我处理');
  assert.equal(store.item(worker, 'approval:per_2')!.data.escalatedFrom, '工厂控制台开发');
  assert.deepEqual(relay.routeFor(worker, item), { to: '工厂控制台开发', escalated: true }, 'stays the owner’s when the card comes again');

  // A card the hub had already, unrouted (brought again after a restart), belongs to earlier work: the owner's, whatever
  // time its computer's clock gave it.
  const old = { ...ask('per_old', { kind: 'file' }), ts: Date.now() + 60_000 };
  store.upsertItems(worker, [old]);
  assert.equal(relay.routeFor(worker, old), null);
  // No hand-off owed in a conversation: the owner's own work, the owner's approval.
  store.ledger.settle('job1', 'sent');
  assert.equal(relay.routeFor(worker, ask('per_3', { kind: 'file' })), null);
  assert.equal(relay.routeFor(worker, ask('per_4', { kind: 'delivery' })), null, 'AgentChat’s own cards stay the owner’s');
  store.db.close();
});

test('OpenCode gets the rules into the conversation before the message, keeping the ones already there', async () => {
  const { OpenCodeAdapter } = await import('../src/device/opencode/adapter.ts');
  const a = new OpenCodeAdapter() as any;
  const calls: [string, string, any][] = [];
  let rules = [{ action: 'browser', resource: '*', effect: 'allow' }, { action: 'edit', resource: '*/test/*', effect: 'deny' }];
  a.api = async (method: string, path: string, body: any) => {
    calls.push([method, path, body]);
    if (method === 'GET') return { data: { permissions: rules } };
    if (method === 'PATCH') rules = body.permissions;
    return { data: { id: 'msg_1' } };
  };
  a.sink = { receipt: () => {} };
  a.markDirty = () => {};
  await a.command('ses_1', { requestId: 'r1', op: 'send', text: '开工', rules: [{ action: 'edit', resource: '*/test/*', effect: 'ask' }] });
  assert.deepEqual(calls.map((c) => c[0]), ['GET', 'PATCH', 'POST'], 'rules first, then the message');
  assert.deepEqual(rules, [{ action: 'browser', resource: '*', effect: 'allow' }, { action: 'edit', resource: '*/test/*', effect: 'ask' }]);

  a.approvals.set('per_9', { threadId: 'ses_1', item: { turnId: 't', data: { kind: 'file' } } });
  const settled: string[] = [];
  a.settleApproval = (id: string, state: string) => settled.push(`${id}:${state}`);
  await a.command('ses_1', { requestId: 'r2', op: 'approve', approvalId: 'per_9', decision: 'decline', note: '不许删测试' });
  assert.deepEqual(calls.at(-1)![2], { decision: 'reject', message: '不许删测试' }, 'the sender’s word reaches it with the answer');

  // One OpenCode let go already: the card closes, and the hub hears it was not found.
  const receipts: string[] = [];
  a.sink = { receipt: (_r: string, state: string, _t?: string, why?: string) => receipts.push(`${state}:${why}`) };
  a.api = async () => { throw new Error('OpenCode 404: {"_tag":"PermissionNotFoundError"}'); };
  await a.command('ses_1', { requestId: 'r3', op: 'approve', approvalId: 'per_9', decision: 'decline' });
  assert.deepEqual([settled.at(-1), receipts.at(-1)], ['per_9:expired', 'failed:approval_not_found']);
});

test('approvals OpenCode no longer has are closed, after two looks', async () => {
  const { OpenCodeAdapter } = await import('../src/device/opencode/adapter.ts');
  const a = new OpenCodeAdapter() as any;
  const sent: any[] = [];
  a.sink = { items: (_t: string, items: any[]) => sent.push(...items), sessions: () => {} };
  a.approvals.set('per_gone', { threadId: 'ses_1', item: { itemId: 'approval:per_gone', data: { kind: 'file', state: 'pending' } } });
  a.approvals.set('per_live', { threadId: 'ses_1', item: { itemId: 'approval:per_live', data: { kind: 'file', state: 'pending' } } });
  a.api = async (_m: string, path: string) => path === '/api/permission/request' ? { data: [{ id: 'per_live' }] } : { data: [] };
  await a.watchBackground();
  assert.equal(sent.length, 0, 'not at the first look');
  await a.watchBackground();
  assert.deepEqual(sent.map((i) => [i.itemId, i.data.state]), [['approval:per_gone', 'expired']]);
  assert.ok(a.approvals.has('per_live'));
});

test('rules the sender writes are checked before anything is sent', () => {
  assert.deepEqual(workRules([{ tool: 'edit', match: '*/test/*', effect: 'ask' }, { action: 'shell', resource: '*rerun*', effect: 'deny' }]),
    [{ action: 'edit', resource: '*/test/*', effect: 'ask' }, { action: 'shell', resource: '*rerun*', effect: 'deny' }]);
  assert.deepEqual(workRules(undefined), []);
  assert.throws(() => workRules([{ tool: 'edit', match: '*', effect: 'maybe' }]), /规矩写得不对/);
  assert.throws(() => workRules('edit'), /列表/);
});
