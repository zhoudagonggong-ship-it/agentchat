import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMessages, textItemId } from '../src/device/opencode/normalize.ts';

// Shapes as OpenCode 2.2 returns them from /api/session/:id/message.
const messages = [
  { id: 'msg_a', time: { created: 1000 }, type: 'model-switched', model: { id: 'deepseek-flash' } },
  { id: 'msg_u', time: { created: 2000 }, text: '执行 echo hi', type: 'user' },
  { id: 'msg_t', time: { created: 3000 }, type: 'assistant', content: [
    { type: 'reasoning', text: '想一想' },
    { type: 'tool', id: 'call_1', name: 'shell', state: { status: 'completed', input: { command: 'echo hi' }, content: [{ type: 'text', text: 'hi\r\n' }] } },
    { type: 'tool', id: 'call_2', name: 'write', state: { status: 'completed', input: { filePath: 'C:\\w\\out.md' } } },
  ] },
  { id: 'msg_r', time: { created: 4000 }, type: 'assistant', content: [{ type: 'text', text: '输出是 hi。' }] },
  { id: 'msg_i', time: { created: 5000 }, type: 'idle', outcome: 'succeeded' },
];

test('maps a turn to messages, tool calls, outputs and a status', () => {
  const { items, files, turnId, preview } = normalizeMessages(messages, new Map([['msg_u', 'req1']]));
  assert.equal(turnId, 'msg_u');
  assert.equal(preview, '输出是 hi。');
  assert.deepEqual(items.map((i) => [i.itemId, i.kind]), [
    ['msg_u', 'message'], ['call_1', 'tool_call'], ['call_2', 'tool_call'], [textItemId('msg_r', 0), 'message'], ['turn:msg_u', 'status'],
  ]);
  assert.equal(items[0]!.data.clientId, 'req1');
  assert.deepEqual([items[1]!.data.tool, items[1]!.data.summary, items[1]!.data.output], ['shell', 'echo hi', 'hi\r\n']);
  assert.deepEqual(items.at(-1)!.data, { status: 'completed', startedAt: 2, completedAt: 5, error: null });
  assert.deepEqual(files, [{ itemId: 'file:call_2', turnId: 'msg_u', path: 'C:\\w\\out.md' }]);
});

test('messages sent while it runs join the running turn, which one idle ends', () => {
  const { items } = normalizeMessages([
    { id: 'msg_1', time: { created: 1000 }, text: '任务', type: 'user' },
    { id: 'msg_2', time: { created: 2000 }, text: '补充一', type: 'user' },
    { id: 'msg_3', time: { created: 3000 }, text: '补充二', type: 'user' },
    { id: 'msg_r', time: { created: 4000 }, type: 'assistant', content: [{ type: 'text', text: '都做完了' }] },
    { id: 'msg_i', time: { created: 5000 }, type: 'idle', outcome: 'succeeded' },
    { id: 'msg_4', time: { created: 6000 }, text: '下一个任务', type: 'user' },
  ], new Map());
  assert.deepEqual(items.map((i) => [i.itemId, i.turnId]), [
    ['msg_1', 'msg_1'], ['msg_2', 'msg_1'], ['msg_3', 'msg_1'], [textItemId('msg_r', 0), 'msg_1'], ['turn:msg_1', 'msg_1'], ['msg_4', 'msg_4'],
  ]);
});

test('a run whose first message dropped out of the latest ones read goes on under its own name', () => {
  // The first read: the task, and OpenCode still at it.
  const first = normalizeMessages([{ id: 'msg_1', time: { created: 1000 }, text: '任务', type: 'user' }], new Map());
  assert.deepEqual(first.run, { turn: 'msg_1', start: 1000, running: true });
  // A later read sees only the latest messages: two added while it ran, then the end.
  const later = normalizeMessages([
    { id: 'msg_2', time: { created: 2000 }, text: '补充一', type: 'user' },
    { id: 'msg_3', time: { created: 3000 }, text: '补充二', type: 'user' },
    { id: 'msg_i', time: { created: 5000 }, type: 'idle', outcome: 'succeeded' },
  ], new Map(), first.run!);
  assert.deepEqual(later.items.map((i) => [i.itemId, i.turnId]), [['msg_2', 'msg_1'], ['msg_3', 'msg_1'], ['turn:msg_1', 'msg_1']]);
  assert.deepEqual(later.items.at(-1)!.data, { status: 'completed', startedAt: 1, completedAt: 5, error: null });
  assert.equal(later.run!.running, false);
  // Read again with the run's own message in view: what was read says it all.
  const again = normalizeMessages([{ id: 'msg_1', time: { created: 1000 }, text: '任务', type: 'user' }], new Map(), later.run!);
  assert.deepEqual(again.run, { turn: 'msg_1', start: 1000, running: true });
});
