import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installGooseTool } from '../src/device/goose/adapter.ts';

const config = ['extensions:', '  developer:', '    enabled: true', '    type: platform', '    name: developer', 'GOOSE_PROVIDER: custom_deepseek', 'GOOSE_MODE: auto', ''].join('\r\n');
const tool = { command: 'C:\\AllinOne\\runtime\\node\\node.exe', args: ['C:\\AllinOne\\src\\device\\mcp.ts', '--agent', 'goose'] };

test('adds the AllinOne extension once and keeps the rest of config.yaml', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'goose-')), 'config.yaml');
  writeFileSync(file, config);
  assert.equal(installGooseTool(file, tool), true);
  const text = readFileSync(file, 'utf8');
  assert.ok(text.includes('\r\n'), 'keeps Windows line ends');
  const lines = text.split('\r\n');
  assert.deepEqual(lines.slice(0, 3), ['extensions:', '  allinone:', '    enabled: true']);
  assert.ok(lines.includes("    cmd: 'C:\\AllinOne\\runtime\\node\\node.exe'"));
  assert.ok(lines.includes("    - 'C:\\AllinOne\\src\\device\\mcp.ts'"));
  for (const l of ['  developer:', '    name: developer', 'GOOSE_PROVIDER: custom_deepseek', 'GOOSE_MODE: auto']) assert.ok(lines.includes(l), l);
  assert.equal(readFileSync(file + '.allinone-backup', 'utf8'), config);
  assert.equal(installGooseTool(file, tool), false); // already there
});

test('moves the extension when the program moved, and leaves a missing config alone', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'goose-')), 'config.yaml');
  writeFileSync(file, config);
  installGooseTool(file, tool);
  assert.equal(installGooseTool(file, { command: 'D:\\node.exe', args: ['D:\\mcp.ts', '--agent', 'goose'] }), true);
  const text = readFileSync(file, 'utf8');
  assert.equal(text.split('  allinone:').length, 2);
  assert.ok(text.includes("cmd: 'D:\\node.exe'") && !text.includes('C:\\AllinOne\\runtime'));
  assert.ok(text.includes('GOOSE_MODE: auto'));
  const none = join(mkdtempSync(join(tmpdir(), 'goose-')), 'config.yaml');
  assert.equal(installGooseTool(none, tool), false);
  assert.equal(existsSync(none), false);
});
