import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zstdCompressSync } from 'node:zlib';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeEvents, type DshEvent } from '../src/device/dsh/normalize.ts';
import { readFrom, readHeader, readLatest } from '../src/device/dsh/log.ts';

// Shapes as DeepSeek Harness 0.2 writes them to session.v4.jsonl (content shortened).
const events: DshEvent[] = [
  { type: 'session', data: undefined },
  { type: 'turn/start', seq: 4, time: 1000, data: { turn: 1 } },
  { type: 'user/message', seq: 8, time: 1100, data: { role: 'user', id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: '列出文件' }] } },
  { type: 'user/message', seq: 9, time: 1101, data: { role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'Current working directory: …' }] } },
  { type: 'assistant/message', seq: 12, time: 1200, data: { turn: 1, step: 1, message: { role: 'assistant', content: [
    { type: 'reasoning', text: '想一想' }, { type: 'tool-call', id: 'c1', name: 'pwsh', arguments: '{"command":"dir"}' }] } } },
  { type: 'tool/call', seq: 13, time: 1201, data: { turn: 1, step: 1, callId: 'c1', name: 'pwsh', arguments: '{"command": "dir", "description": "list"}' } },
  { type: 'tool/result', seq: 14, time: 1300, data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'a.txt' }] } } },
  { type: 'tool/call', seq: 15, time: 1301, data: { turn: 1, step: 2, callId: 'c2', name: 'glob', arguments: '{"pattern": "*"}' } },
  { type: 'tool/result', seq: 16, time: 1302, data: { turn: 1, step: 2, message: { role: 'tool', toolCallId: 'c2', content: [{ type: 'text', text: 'Error: glob search failed' }] } } },
  { type: 'approval/asked', seq: 17, time: 1350, data: { id: 'ap1', toolName: 'write', reason: '要写到工作区之外' } },
  { type: 'approval/decided', seq: 18, time: 1360, data: { id: 'ap1', outcome: 'allowed-once' } },
  { type: 'assistant/message', seq: 20, time: 1400, data: { turn: 1, step: 3, message: { role: 'assistant', content: [{ type: 'reasoning', text: '…' }, { type: 'text', text: '有一个文件 a.txt。' }] } } },
  { type: 'deliverables/presented', seq: 21, time: 1401, data: { turn: 1, files: [{ path: 'C:\\w\\a.txt', description: '' }] } },
  { type: 'turn/end', seq: 22, time: 1402, data: { turn: 1, reason: { kind: 'completed' } } },
  { type: 'turn/start', seq: 23, time: 2000, data: { turn: 2 } },
  { type: 'user/message', seq: 24, time: 2001, data: { role: 'user', id: 'u2', source: { kind: 'user' }, content: [{ type: 'text', text: '再看一次' }] } },
];

test('DSH events become the hub items: typed messages, answers, tools, approvals, turns', () => {
  const n = normalizeEvents(events);
  const messages = n.items.filter((i) => i.kind === 'message');
  // DSH's own context is not the owner's words; reasoning is not the answer.
  assert.deepEqual(messages.map((m) => [m.data.role, m.data.text]), [['user', '列出文件'], ['assistant', '有一个文件 a.txt。'], ['user', '再看一次']]);
  const tools = n.items.filter((i) => i.kind === 'tool_call');
  assert.deepEqual(tools.map((t) => [t.data.tool, t.data.summary, t.data.status]), [['shell', 'dir', 'completed'], ['glob', '*', 'failed']]);
  const approval = n.items.find((i) => i.kind === 'approval_request')!;
  assert.equal(approval.data.state, 'accepted');
  assert.equal(approval.data.onComputer, true);
  const status = n.items.find((i) => i.kind === 'status')!;
  assert.equal(status.itemId, 'turn:1');
  assert.equal(status.data.status, 'completed');
  assert.deepEqual(n.files.map((f) => f.path), ['C:\\w\\a.txt']);
  // The second turn started and has not ended.
  assert.equal(n.turnId, 'turn:2');
  assert.equal(n.running, true);
  assert.equal(n.preview, '再看一次');
  assert.ok(messages.every((m) => m.turnId), 'every message belongs to a turn');
});

test('the conversation file is read in frames: from the start, only what was added, and the latest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-'));
  const file = join(dir, 'session.v4.jsonl.zstd');
  const frame = (lines: object[]) => zstdCompressSync(Buffer.from(lines.map((l) => JSON.stringify(l) + '\n').join('')));
  writeFileSync(file, frame([{ type: 'session', id: 'session-x', cwd: 'C:\\w', delegationDepth: 0 }, events[1]!]));
  appendFileSync(file, frame([events[2]!]));
  assert.equal(readHeader(file)?.id, 'session-x');
  const all = readFrom(file, 0);
  assert.equal(all.events.length, 3);
  // Nothing new: nothing read.
  assert.equal(readFrom(file, all.offset).events.length, 0);
  // Appended later: only that comes.
  appendFileSync(file, frame(events.slice(3, 6)));
  const next = readFrom(file, all.offset);
  assert.deepEqual(next.events.map((e) => e.type), ['user/message', 'assistant/message', 'tool/call']);
  // A frame still being written at the end is left for next time.
  const half = frame([events[6]!]);
  appendFileSync(file, half.subarray(0, 6));
  assert.equal(readFrom(file, next.offset).events.length, 0);
  assert.equal(readLatest(file, 2).events.at(-1)?.type, 'tool/call');
});
