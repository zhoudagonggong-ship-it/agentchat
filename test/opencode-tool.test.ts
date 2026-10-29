import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installOpenCodeTool } from '../src/device/opencode/adapter.ts';

const command = ['node.exe', 'C:\\AllinOne\\src\\device\\mcp.ts', '--agent', 'opencode'];

test('adds the tool to OpenCode settings once, merged with what is there', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'oc-')), 'opencode', 'opencode.json');
  assert.equal(installOpenCodeTool(file, command), true); // no file yet: made
  const own = JSON.parse(readFileSync(file, 'utf8'));
  own.model = 'deepseek/deepseek-flash';
  own.mcp.other = { type: 'remote', url: 'https://x' };
  writeFileSync(file, JSON.stringify(own));
  assert.equal(installOpenCodeTool(file, command), false); // already there
  assert.equal(installOpenCodeTool(file, ['node2.exe', ...command.slice(1)]), true); // program moved
  const after = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(after.model, 'deepseek/deepseek-flash');
  assert.deepEqual(after.mcp.other, { type: 'remote', url: 'https://x' });
  assert.deepEqual(after.mcp.allinone.command[0], 'node2.exe');
});

test('leaves a settings file with comments alone', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'oc-')), 'opencode.json');
  writeFileSync(file, '{ // mine\n "model": "x" }');
  assert.equal(installOpenCodeTool(file, command), false);
  assert.equal(readFileSync(file, 'utf8'), '{ // mine\n "model": "x" }');
});
