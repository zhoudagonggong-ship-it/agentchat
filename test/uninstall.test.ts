import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installHooks, uninstallHooks } from '../src/device/claude/adapter.ts';
import { installGooseTool, uninstallGooseTool } from '../src/device/goose/adapter.ts';
import { installOpenCodeTool, uninstallOpenCodeTool } from '../src/device/opencode/adapter.ts';
import { installHint, uninstallHint } from '../src/device/tool.ts';

const dir = () => mkdtempSync(join(tmpdir(), 'un-'));

test('uninstall gives each agent its settings back as they were', () => {
  const claude = join(dir(), 'settings.json');
  const own = { model: 'opus', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'mine.sh' }] }] } };
  writeFileSync(claude, JSON.stringify(own));
  installHooks(claude, 'C:\\A\\src\\device\\claude\\hook.ts', 'node.exe');
  assert.equal(uninstallHooks(claude), true);
  assert.deepEqual(JSON.parse(readFileSync(claude, 'utf8')), own);

  const goose = join(dir(), 'config.yaml');
  const yaml = ['extensions:', '  developer:', '    enabled: true', 'GOOSE_MODE: auto', ''].join('\r\n');
  writeFileSync(goose, yaml);
  installGooseTool(goose, { command: 'node.exe', args: ['mcp.ts', '--agent', 'goose'] });
  assert.equal(uninstallGooseTool(goose), true);
  assert.equal(readFileSync(goose, 'utf8'), yaml);
  assert.equal(uninstallGooseTool(goose), false);

  const opencode = join(dir(), 'opencode.json');
  writeFileSync(opencode, JSON.stringify({ model: 'x', mcp: { other: { type: 'remote', url: 'https://x' } } }));
  installOpenCodeTool(opencode, ['node.exe', 'mcp.ts']);
  assert.equal(uninstallOpenCodeTool(opencode), true);
  assert.deepEqual(JSON.parse(readFileSync(opencode, 'utf8')), { model: 'x', mcp: { other: { type: 'remote', url: 'https://x' } } });
});

test('the note about AllinOne goes in once and comes out cleanly', () => {
  const own = join(dir(), 'AGENTS.md');
  writeFileSync(own, '# 我的规则\n\n总是用中文。\n');
  assert.equal(installHint(own), true);
  assert.equal(installHint(own), false); // already there: unchanged
  assert.match(readFileSync(own, 'utf8'), /总是用中文。[\s\S]*## AgentChat/);
  assert.equal(uninstallHint(own), true);
  assert.equal(readFileSync(own, 'utf8'), '# 我的规则\n\n总是用中文。\n');

  const fresh = join(dir(), 'sub', '.goosehints'); // made by us: removed again entirely
  installHint(fresh);
  uninstallHint(fresh);
  assert.equal(existsSync(fresh), false);
});
