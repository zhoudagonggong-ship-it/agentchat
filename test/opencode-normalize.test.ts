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
