import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexAdapter } from '../src/device/codex/adapter.ts';

/** An app-server that answers as Codex does and remembers whether it was closed. */
function fakeRpc(name: string, log: string[]) {
  let turns = 0;
  return {
    name,
    closed: false,
    async call(method: string, params: any) {
      log.push(`${name} ${method}`);
      if (method === 'turn/start') return { turn: { id: `${params.threadId}-turn${++turns}` } };
      if (method === 'thread/start') return { thread: { id: 'new1' } };
      return {};
    },
    close() {
      this.closed = true;
      log.push(`${name} closed`);
    },
  };
}

test('each conversation is written through an app-server of its own, closed (handed back) when its own turn ends', async () => {
  const a = new CodexAdapter('codex.exe', null, 'C:\\nowhere') as any;
  const log: string[] = [];
  const made: any[] = [];
  a.newWriter = () => {
    const r = fakeRpc(`w${made.length + 1}`, log);
    made.push(r);
    return r;
  };
  a.rpc = fakeRpc('shared', log);
  a.sink = { receipt: () => {}, items: () => {}, sessions: () => {} };
  a.scheduleRefresh = () => {};
  const queued: string[] = [];
  a.queueMessage = async (threadId: string) => { queued.push(threadId); };

  // A conversation the Codex app has open: the app runs it, through its queue.
  const appHas = fakeRpc('app-held', []);
  appHas.call = async () => { throw new Error('thread already has an active writer'); };
  a.writers.set('OPEN', appHas);
  await a.command('OPEN', { requestId: 'r0', op: 'send', text: '接着做' });
  assert.deepEqual(queued, ['OPEN']);

  // One it does not have open: AgentChat runs it itself.
  await a.command('A', { requestId: 'r1', op: 'send', text: '长任务' });
  await a.command('B', { requestId: 'r2', op: 'send', text: '短任务' });
  assert.deepEqual(log, ['w1 thread/resume', 'w1 turn/start', 'w2 thread/resume', 'w2 turn/start'], 'one app-server each; the shared one only reads');

  // B finishes while A still works: B alone goes back to the Codex app.
  a.onNotification('turn/completed', { threadId: 'B' });
  assert.equal(made[1].closed, true);
  assert.equal(made[0].closed, false);
  assert.equal(a.busy(), true, 'A still works here');

  // A message to A again goes through its own app-server; when its turn ends, it goes back too.
  await a.command('A', { requestId: 'r3', op: 'send', text: '补充' });
  assert.equal(log.at(-1), 'w1 turn/steer');
  a.onNotification('turn/completed', { threadId: 'A' });
  assert.equal(made[0].closed, true);
  assert.equal(a.busy(), false);

  // A new conversation is started in the app-server that then runs it.
  const { threadId } = await a.create('C:\\work', '新对话');
  assert.equal(threadId, 'new1');
  assert.equal(a.writers.get('new1'), made[2]);
  assert.ok(!log.includes('shared thread/start'));
});

test('a new Codex conversation goes into the project named, or the owner’s 「AgentChat」 project', async () => {
  const a = new CodexAdapter('codex.exe', null, 'C:\\nowhere') as any;
  const starts: string[] = [];
  a.newWriter = () => ({ async call(method: string, params: any) { if (method === 'thread/start') starts.push(params.cwd); return { thread: { id: `t${starts.length}` } }; }, close() {} });
  a.sink = { sessions: () => {} };
  a.readDesktopState = () => false;
  a.desktop.projects = [{ id: 'p1', name: 'AgentChat' }, { id: 'p2', name: '自媒体博主运营' }];
  a.desktop.mainRoots = new Map([['p1', 'd:\\agentchat'], ['p2', 'd:\\media']]);
  await a.create('', '没指定');
  await a.create('自媒体博主运营', '指定了项目');
  await a.create('C:\\work', '给了路径');
  assert.deepEqual(starts, ['d:\\agentchat', 'd:\\media', 'C:\\work']);
});
