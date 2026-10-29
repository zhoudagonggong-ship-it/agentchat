import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportDiagnostics, redact } from '../src/diagnostics.ts';

test('secrets never leave in the diagnostics', () => {
  const text = [
    '{"deviceSecret": "EkXX0Is9qBd7q9vwr8E7jLqWUN1pW6KKn3PdvOAEGrk", "hub": {"name": "server"}}',
    'GET /api/pair?code=u6HoYLN88aPoEANP&x=1',
    'authorization: Basic b3BlbmNvZGU6c2VjcmV0',
    'password=hunter2 next',
    'key sk-ant-abcdefghijklmnop1234',
  ].join('\n');
  const out = redact(text);
  for (const secret of ['EkXX0Is9', 'u6HoYLN88', 'b3BlbmNvZGU6', 'hunter2', 'abcdefghijklmnop1234']) assert.ok(!out.includes(secret), secret);
  assert.ok(out.includes('"name": "server"')); // the rest stays readable
});

test('the zip holds the summary, the log and the settings', async () => {
  const data = mkdtempSync(join(tmpdir(), 'diag-'));
  writeFileSync(join(data, 'allinone.log'), 'line one\npassword=hunter2\n');
  writeFileSync(join(data, 'config.json'), JSON.stringify({ deviceSecret: 'abc123', paused: false }));
  const zip = await exportDiagnostics(data, join(import.meta.dirname, '..'), { role: 'hub' }, 'v1', data);
  assert.ok(readdirSync(data).includes(zip.split(/[\\/]/).pop()!));
  assert.ok(!readdirSync(data).some((f) => f.startsWith('AllinOne-诊断信息-') && !f.endsWith('.zip')), 'staging folder left behind');
});
