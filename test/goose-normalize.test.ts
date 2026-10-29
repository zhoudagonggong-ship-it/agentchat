import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRows, textItemId, type MessageRow } from '../src/device/goose/normalize.ts';

// Rows as Goose 1.56 stores them in sessions.db.
const visible = '{"userVisible":true,"agentVisible":true}';
const row = (id: number, message_id: string, role: string, content: unknown[], seconds: number, meta = visible): MessageRow =>
  ({ id, message_id, role, content_json: JSON.stringify(content), created_timestamp: seconds, metadata_json: meta });
const rows = [
  row(1, 'msg_u1', 'user', [{ type: 'text', text: '执行 echo hi' }], 100),
  row(2, 'msg_ctx', 'user', [{ type: 'text', text: '<turn-context>…</turn-context>' }], 100, '{"userVisible":false,"agentVisible":true,"turnContext":true}'),
  row(3, 'a1', 'assistant', [{ type: 'thinking', thinking: '想' }, { type: 'toolRequest', id: 'call_1', toolCall: { status: 'success', value: { name: 'shell', arguments: { command: 'echo hi' } } } }], 101),
  row(4, 'msg_r', 'user', [{ type: 'toolResponse', id: 'call_1', toolResult: { status: 'success', value: { content: [{ type: 'text', text: 'hi\r' }], isError: false } } }], 102),
  row(5, 'a2', 'assistant', [{ type: 'text', text: '输出是 hi。' }], 103),
  row(6, 'msg_u2', 'user', [{ type: 'text', text: '再写个文件' }], 110),
  row(7, 'a3', 'assistant', [{ type: 'toolRequest', id: 'call_2', toolCall: { status: 'success', value: { name: 'write', arguments: { path: 'C:\\w\\a.md', content: 'x' } } } }], 111),
];

test('maps turns, hides context and thinking, pairs tool results', () => {
  const n = normalizeRows(rows, new Map([['msg_u1', 'interrupted']]));
  assert.deepEqual(n.items.map((i) => [i.itemId, i.kind]), [
    ['msg_u1', 'message'], ['call_1', 'tool_call'], [textItemId('a2'), 'message'], ['turn:msg_u1', 'status'], ['msg_u2', 'message'], ['call_2', 'tool_call'],
  ]);
  assert.deepEqual([n.items[1]!.data.status, n.items[1]!.data.output], ['completed', 'hi\r']);
  assert.equal(n.items[3]!.data.status, 'interrupted');
  assert.equal(n.items[5]!.data.status, 'inProgress');
  assert.equal(n.turnId, 'msg_u2');
  assert.equal(n.open, true); // the second turn waits for the tool result
  assert.equal(n.preview, '再写个文件');
  assert.ok(n.items.every((i, k) => k === 0 || i.ts > n.items[k - 1]!.ts));
});

test('a tool cut off by a stop ends its turn as interrupted', () => {
  const stopped = [...rows, row(8, 'msg_r2', 'user', [{ type: 'toolResponse', id: 'call_2', toolResult: { status: 'success',
    value: { content: [{ type: 'text', text: 'Tool call was interrupted before completing' }], isError: true } } }], 112)];
  const n = normalizeRows(stopped, new Map());
  assert.equal(n.open, false);
  assert.equal(n.items.at(-1)!.data.status, 'interrupted');
});

test('a finished last turn gets a completed status and its written file', () => {
  const done = [...rows, row(8, 'msg_r2', 'user', [{ type: 'toolResponse', id: 'call_2', toolResult: { status: 'success', value: { content: [], isError: false } } }], 112),
    row(9, 'a4', 'assistant', [{ type: 'text', text: '写好了' }], 113)];
  const n = normalizeRows(done, new Map());
  assert.equal(n.open, false);
  assert.deepEqual(n.items.at(-1)!.data, { status: 'completed', startedAt: 110, completedAt: 113, error: null });
  assert.deepEqual(n.files, [{ itemId: 'file:call_2', turnId: 'msg_u2', path: 'C:\\w\\a.md' }]);
});
