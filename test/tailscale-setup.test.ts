import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

// The real Tailscale is never touched: a missing CLI, and status outputs as Tailscale prints them.
test('tells what the owner still has to do with Tailscale', async () => {
  process.env.ALLINONE_TAILSCALE = 'C:\\nowhere\\tailscale.exe';
  const { problemFromStatus, tailscaleProblem } = await import('../src/tailscale.ts');
  assert.deepEqual(await tailscaleProblem(), { step: 'install' });
  assert.equal(problemFromStatus('{"BackendState":"Running"}'), null);
  assert.deepEqual(problemFromStatus('{"BackendState":"NeedsLogin","AuthURL":"https://login.tailscale.com/a/abc"}'), { step: 'login', url: 'https://login.tailscale.com/a/abc' });
  assert.deepEqual(problemFromStatus('{"BackendState":"Stopped"}'), { step: 'start' });
  assert.deepEqual(problemFromStatus('failed to connect to local tailscaled'), { step: 'start' });
});

test('the program starts without Tailscale and waits for it, instead of crashing', () => {
  // Only loads the modules with a missing CLI: the worker's start is what the window test covers by hand.
  const out = execFileSync(process.execPath, ['-e', "import('./src/worker.ts').then(() => console.log('loaded'))"], { env: { ...process.env, ALLINONE_TAILSCALE: 'C:\\nowhere\\tailscale.exe' } }).toString();
  assert.match(out, /loaded/);
});
