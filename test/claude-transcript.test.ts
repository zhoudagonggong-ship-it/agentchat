import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transcript } from '../src/device/claude/transcript.ts';

test('a prompt reads as sent, without what the desktop app puts before it', () => {
  const sent = '[来自 X · Claude Code「Y」，经 AgentChat 转发] 你好';
  const lines = [
    // The page the owner has open beside the chat, as Claude's desktop app writes it before the prompt.
    { type: 'user', uuid: 'u1', timestamp: '2026-10-30T06:00:00Z', message: { role: 'user', content:
      `<artifact-view-context artifact="a1">\n{"context":{"mode":"edit"}}\n(The JSON line above …)\n<artifact-content-authored-by-others/>\n</artifact-view-context>\n\n${sent}` } },
    { type: 'user', uuid: 'u2', timestamp: '2026-10-30T06:01:00Z', message: { role: 'user', content: [
      { type: 'text', text: '<system-reminder>\nfiles were re-read\n</system-reminder>' }, { type: 'text', text: '再来一条' }] } },
  ];
  const dir = mkdtempSync(join(tmpdir(), 'transcript-'));
  const file = join(dir, 't.jsonl');
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const texts = new Transcript(file).update().filter((i) => i.kind === 'message').map((i) => i.data.text);
  assert.deepEqual(texts, [sent, '再来一条']);
});
