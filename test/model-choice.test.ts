import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/hub/store.ts';

test('a conversation’s model is kept, and kept when its agent does not say', () => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'hub-')));
  const conv = (extra: Record<string, unknown>) => ({ threadId: 't1', agentId: 'codex', title: '221B 白膜全景实验', cwd: null, updatedAt: 1, running: false,
    activeTurnId: null, preview: null, ...extra });
  store.upsertSessions('pc', 'codex', [conv({ model: 'gpt-6.1-sol · low' })], true);
  assert.equal(store.session('pc:codex:t1')!.model, 'gpt-6.1-sol · low');
  assert.equal(store.upsertSessions('pc', 'codex', [conv({ model: 'gpt-6.1-terra · high' })], true)[0]!.model, 'gpt-6.1-terra · high', 'a change the phone and agents hear of');
  store.upsertSessions('pc', 'codex', [conv({ updatedAt: 2 })], true);
  assert.equal(store.session('pc:codex:t1')!.model, 'gpt-6.1-terra · high');
  store.db.close();
});

test('with no conversation named, an agent makes its own Codex conversation', async () => {
  const { Relay } = await import('../src/hub/relay.ts');
  const store = new Store(mkdtempSync(join(tmpdir(), 'hub-')));
  store.registerDevice('n95', 'laptop', 's', [{ id: 'claude-code', kind: 'claude-code', label: 'Claude Code' }]);
  store.registerDevice('pc', 'office-pc', 's', [{ id: 'codex', kind: 'codex', label: 'Codex' }]);
  store.approveDevice('n95');
  store.approveDevice('pc');
  store.upsertSessions('pc', 'codex', [{ threadId: 'old', agentId: 'codex', title: '已有的对话', cwd: null, updatedAt: 1, running: false, activeTurnId: null, preview: null }], true);
  const created: string[] = [];
  const relay = new Relay({ store, knowledge: { related: () => '' }, hubId: 'n95', devices: new Map([['pc', { send: () => {} }]]), settings: () => ({ agentLinks: true, autoReport: true }),
    submit: () => ({ view: { state: 'pending' }, created: true }), putItems: () => {}, notice: () => {} } as any) as any;
  relay.createFor = async (_o: unknown, args: any) => (created.push(args.title), { sessionId: 'pc:codex:old', sent: false });
  const origin = { deviceId: 'n95', agentId: 'claude-code', label: 'laptop · Claude Code' };
  await relay.askSend(origin, { to: 'office-pc · Codex', title: '221B 白膜全景实验', text: '开工' });
  await relay.askSend(origin, { to: 'office-pc · Codex', title: '已有的对话', text: '接着做' });
  assert.deepEqual(created, ['221B 白膜全景实验', '已有的对话']);
  store.db.close();
});

test('OpenCode switches the model before the message, and says which ones it has when asked for one it lacks', async () => {
  const { OpenCodeAdapter } = await import('../src/device/opencode/adapter.ts');
  const a = new OpenCodeAdapter() as any;
  const calls: [string, string, any][] = [];
  a.api = async (method: string, path: string, body: any) => {
    calls.push([method, path, body]);
    if (path === '/api/model') return { data: [{ providerID: 'deepseek', id: 'deepseek-v4-pro', variants: [{ id: 'none' }, { id: 'low' }, { id: 'high' }, { id: 'max' }] }] };
    if (method === 'GET') return { data: { model: { id: 'deepseek-flash', providerID: 'deepseek', variant: 'default' } } };
    return { data: { id: 'msg_1' } };
  };
  a.sink = { receipt: () => {} };
  a.markDirty = () => {};
  a.scheduleRefresh = () => {};
  await a.command('ses_1', { requestId: 'r1', op: 'send', text: '开工', model: 'deepseek-v4-pro', effort: 'high' });
  const set = calls.find((c) => c[1].endsWith('/model') && c[0] === 'POST')!;
  assert.deepEqual(set[2], { model: { id: 'deepseek-v4-pro', providerID: 'deepseek', variant: 'high' } }, 'its present provider when none is named');
  assert.ok(calls.findIndex((c) => c === set) < calls.findIndex((c) => c[1].endsWith('/prompt')), 'before the message');
  await assert.rejects(a.command('ses_1', { requestId: 'r2', op: 'send', text: 'x', model: 'deepseek/deepseek-v4-pro', effort: 'ultra' }), /可选：none \/ low \/ high \/ max/);
  await assert.rejects(a.command('ses_1', { requestId: 'r3', op: 'send', text: 'x', model: 'openai/gpt-9' }), /没有模型 openai\/gpt-9/);
  assert.equal(a.describe({ id: 's', model: { providerID: 'deepseek', id: 'deepseek-v4-pro', variant: 'high' } }).model, 'deepseek/deepseek-v4-pro · high');
});
