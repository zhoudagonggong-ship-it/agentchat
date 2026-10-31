// Runs the tests with a temporary folder of their own, emptied before and after, so the many small databases the
// tests make never pile up on the computer.   node tools/test.mjs [node --test arguments]
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = join(tmpdir(), 'agentchat-tests');
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const args = process.argv.slice(2);
const r = spawnSync(process.execPath, ['--test', ...(args.length ? args : ['test/**/*.test.ts'])], {
  stdio: 'inherit', env: { ...process.env, TEMP: dir, TMP: dir, TMPDIR: dir },
});
rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
process.exitCode = r.status ?? 1;
