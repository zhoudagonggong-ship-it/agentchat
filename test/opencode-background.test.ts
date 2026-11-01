import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMessages } from '../src/device/opencode/normalize.ts';

// As OpenCode 2.2 records it: a shell call moved to the background, the idle after it, the notice when it ends.
const launch = (id: string, shell: string, at: number) => ({ id, time: { created: at }, type: 'assistant', content: [
  { type: 'tool', id: `call_${shell}`, name: 'shell', state: { status: 'completed', input: { background: true, command: 'node long.mjs' },
    metadata: { status: 'running', shellID: shell }, content: [{ type: 'text', text: `Command moved to the background (shell ID: ${shell}).` }] } },
] });
const ended = (id: string, shell: string, at: number) => ({ id, time: { created: at }, type: 'synthetic',
  metadata: { source: 'shell', shellID: shell, state: 'completed', exit: 0 }, text: `<shell id="${shell}" state="completed">done</shell>` });
const status = (items: any[]) => items.filter((i) => i.kind === 'status').at(-1)?.data;

test('a turn that left work in the background is not over at its idle; the notice of its end resumes it', () => {
  const start = [
    { id: 'msg_u', time: { created: 1000 }, text: '跑原文分析', type: 'user' },
    launch('msg_a', 'sh_1', 2000),
    { id: 'msg_i1', time: { created: 3000 }, type: 'idle', outcome: 'succeeded' },
  ];
  const first = normalizeMessages(start, new Map());
  assert.equal(status(first.items).status, 'inProgress', 'idle with a command still in the background');
  assert.deepEqual(status(first.items).background, ['sh_1']);
  assert.deepEqual(first.run!.waiting, ['sh_1']);

  // Another message meanwhile joins the turn (it is still the same piece of work).
  const asked = normalizeMessages([...start, { id: 'msg_q', time: { created: 4000 }, text: '进度如何', type: 'user' },
    { id: 'msg_r', time: { created: 4500 }, type: 'assistant', content: [{ type: 'text', text: '还在跑' }] },
    { id: 'msg_i2', time: { created: 5000 }, type: 'idle', outcome: 'succeeded' }], new Map());
  assert.equal(asked.items.find((i) => i.itemId === 'msg_q')!.turnId, 'msg_u');
  assert.equal(status(asked.items).status, 'inProgress');

  const done = normalizeMessages([...start, ended('msg_s', 'sh_1', 6000),
    { id: 'msg_r2', time: { created: 7000 }, type: 'assistant', content: [{ type: 'text', text: '全部跑完了' }] },
    { id: 'msg_i3', time: { created: 8000 }, type: 'idle', outcome: 'succeeded' }], new Map());
  assert.deepEqual(status(done.items), { status: 'completed', startedAt: 1, completedAt: 8, error: null });
  assert.equal(done.run!.waiting, undefined);

  // Read later from where the last read ended: the waiting carries over.
  const later = normalizeMessages([ended('msg_s', 'sh_1', 6000)], new Map(), first.run!);
  assert.equal(later.run!.running, true, 'resumed by the notice');
  assert.equal(later.run!.waiting, undefined);
});

test('background work that vanished without OpenCode resuming fails the turn, with the reason, after a grace', async () => {
  const { OpenCodeAdapter } = await import('../src/device/opencode/adapter.ts');
  const a = new OpenCodeAdapter() as any;
  const sent: any[] = [];
  a.sink = { items: (_t: string, items: any[]) => sent.push(...items) };
  a.hydrated.add('ses_1');
  a.known.set('ses_1', { threadId: 'ses_1', cwd: 'C:\\work\\影视工厂' });
  const messages = [
    { id: 'msg_u', time: { created: 1000 }, text: '跑', type: 'user' },
    launch('msg_a', 'sh_9', 2000),
    { id: 'msg_i', time: { created: 3000 }, type: 'idle', outcome: 'succeeded' },
  ];
  let shells: { id: string; status: string }[] = [{ id: 'sh_9', status: 'running' }];
  const asked: Record<string, string>[] = [];
  a.api = async (_m: string, path: string, _b: unknown, _r: boolean, headers: Record<string, string>) => {
    if (path === '/api/shell') {
      asked.push(headers);
      return { data: shells };
    }
    return { data: messages.slice().reverse() };
  };
  a.markDirty = () => {};
  await a.readThread('ses_1', 40);
  assert.equal(status(sent).status, 'inProgress');

  await a.watchBackground();
  assert.equal(decodeURIComponent(asked[0]!['x-opencode-directory']!), 'C:\\work\\影视工厂', 'its project folder’s list');
  assert.equal(a.stranded.size, 0, 'still running');

  shells = []; // gone: OpenCode restarted, say
  await a.watchBackground();
  assert.equal(a.stranded.size, 0, 'not at once: its notice may be on the way');
  a.stopped.set('sh_9', Date.now() - 4 * 60_000);
  await a.watchBackground();
  await a.readThread('ses_1', 40);
  const failed = status(sent);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /后台任务不见了/);
  assert.ok(failed.completedAt > Date.now() / 1000 - 5, 'ended now, so the owner and the sender hear of it');
});

test('conversations with commands running in the background say how many, and the hub keeps it', async () => {
  const { OpenCodeAdapter } = await import('../src/device/opencode/adapter.ts');
  const a = new OpenCodeAdapter() as any;
  const told: any[] = [];
  a.sink = { sessions: (list: any[]) => told.push(...list) };
  a.known.set('ses_l', { threadId: 'ses_l', cwd: 'C:\\lang', updatedAt: Math.floor(Date.now() / 1000), running: false });
  let shells = [{ id: 'sh_a', status: 'running', metadata: { sessionID: 'ses_l' } }, { id: 'sh_b', status: 'completed', metadata: { sessionID: 'ses_l' } }];
  a.api = async () => ({ data: shells });
  await a.watchBackground();
  assert.equal(told.at(-1).background, 1);
  shells = [];
  await a.watchBackground();
  assert.equal(told.at(-1).background, 0, 'and when it ends');
  const n = told.length;
  await a.watchBackground();
  assert.equal(told.length, n, 'nothing said when nothing changed');

  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { Store } = await import('../src/hub/store.ts');
  const store = new Store(mkdtempSync(join(tmpdir(), 'hub-')));
  const conv = (background: number) => ({ threadId: 'ses_l', agentId: 'opencode', title: '语言分级开发', cwd: null, updatedAt: 1, running: false, activeTurnId: null, preview: null, background });
  store.upsertSessions('pc', 'opencode', [conv(2)], true);
  assert.equal(store.session('pc:opencode:ses_l')!.background, 2);
  assert.equal(store.upsertSessions('pc', 'opencode', [conv(0)], true)[0]!.background, 0, 'a change the phone hears of');
  store.db.close();
});

test('the hub tells a turn waiting on the background from one at work or done', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { Store } = await import('../src/hub/store.ts');
  const store = new Store(mkdtempSync(join(tmpdir(), 'hub-')));
  const put = (data: Record<string, unknown>, ts: number) => store.upsertItems('s1', [{ itemId: 'turn:t1', turnId: 't1', kind: 'status', ts, data }]);
  put({ status: 'inProgress', background: ['sh_1'], idleAt: 300 }, 1);
  assert.equal(store.turnBackground('s1', 't1'), 300);
  put({ status: 'completed', startedAt: 1, completedAt: 9, error: null }, 2);
  assert.equal(store.turnBackground('s1', 't1'), null);
  store.db.close();
});

test('stopping the turn ends it, background or not', () => {
  const { items, run } = normalizeMessages([
    { id: 'msg_u', time: { created: 1000 }, text: '跑', type: 'user' },
    launch('msg_a', 'sh_2', 2000),
    { id: 'msg_i', time: { created: 3000 }, type: 'idle', outcome: 'interrupted' },
  ], new Map());
  assert.equal(status(items).status, 'interrupted');
  assert.equal(run!.waiting, undefined);
});
