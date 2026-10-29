// Run by src\setup\uninstall.ps1: takes back out of each agent what AllinOne added (Claude Code's hooks, and the
// AllinOne tool in Claude Code, Codex, OpenCode and Goose), each through the same official way it went in.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { findClaudeExe, uninstallHooks } from './device/claude/adapter.ts';
import { findCodexExe } from './device/codex/adapter.ts';
import { HINT_FILE as OPENCODE_HINT, uninstallOpenCodeTool } from './device/opencode/adapter.ts';
import { HINT_FILE as GOOSE_HINT, uninstallGooseTool } from './device/goose/adapter.ts';
import { TOOL_NAME, uninstallHint } from './device/tool.ts';
import { homedir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const step = async (name: string, work: () => unknown) => {
  try {
    console.log(name, await work());
  } catch (error) {
    console.log(name, 'failed:', (error as Error).message.split('\n')[0]);
  }
};

await step('claude hooks', () => uninstallHooks());
await step('claude tool', async () => {
  const exe = findClaudeExe();
  if (exe) await run(exe, ['mcp', 'remove', TOOL_NAME, '--scope', 'user'], { windowsHide: true, timeout: 60_000 });
  return Boolean(exe);
});
await step('codex tool', async () => {
  const exe = findCodexExe();
  if (exe) await run(exe, ['mcp', 'remove', TOOL_NAME], { windowsHide: true, timeout: 60_000 });
  return Boolean(exe);
});
await step('opencode tool', () => uninstallOpenCodeTool());
await step('goose tool', () => uninstallGooseTool());
// The note about AllinOne in each agent's global instructions.
await step('codex note', () => uninstallHint(join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'AGENTS.md')));
await step('opencode note', () => uninstallHint(OPENCODE_HINT));
await step('goose note', () => uninstallHint(GOOSE_HINT));
