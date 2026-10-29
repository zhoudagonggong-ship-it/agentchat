import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installHooks } from '../src/device/claude/adapter.ts';

const hook = 'C:\\AllinOne\\src\\device\\claude\\hook.ts';

test('installs the hooks once and keeps the owner settings', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'hooks-')), 'settings.json');
  const own = { model: 'opus', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'mine.sh' }] }] } };
  writeFileSync(file, JSON.stringify(own));
  assert.equal(installHooks(file, hook, 'node.exe'), true);
  const s = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(s.model, 'opus');
  assert.deepEqual(s.hooks.PreToolUse[0], own.hooks.PreToolUse[0]);
  assert.deepEqual(s.hooks.PreToolUse[1], { matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: 'node.exe', args: [hook], timeout: 600 }] });
  assert.deepEqual(s.hooks.PermissionRequest, [{ hooks: [{ type: 'command', command: 'node.exe', args: [hook], timeout: 600 }] }]);
  assert.equal(installHooks(file, hook, 'node.exe'), false); // already there
});

test('moves the hooks when the program moved, and never touches an unreadable file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hooks-'));
  const file = join(dir, 'settings.json');
  installHooks(file, hook, 'node.exe');
  const moved = 'D:\\New\\src\\device\\claude\\hook.ts';
  assert.equal(installHooks(file, moved, 'node2.exe'), true);
  const s = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(s.hooks.PermissionRequest.length, 1);
  assert.deepEqual(s.hooks.PermissionRequest[0].hooks[0].args, [moved]);
  writeFileSync(file, '{ broken');
  assert.equal(installHooks(file, hook, 'node.exe'), false);
  assert.equal(readFileSync(file, 'utf8'), '{ broken');
});
