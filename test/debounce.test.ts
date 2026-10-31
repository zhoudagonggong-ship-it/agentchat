import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { debounce } from '../src/shared/util.ts';

test('a file written to all the time is still read: the wait for quiet has a limit', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  try {
    const runs: number[] = [];
    const plain = debounce(() => runs.push(-Date.now()), 600);
    const capped = debounce(() => runs.push(Date.now()), 600, 1500);
    // Another conversation writes every 300 ms for 10 s (a turn running commands).
    for (let t = 0; t < 10_000; t += 300) {
      plain();
      capped();
      mock.timers.tick(300);
    }
    const plainRuns = runs.filter((r) => r < 0).length;
    const cappedRuns = runs.filter((r) => r > 0);
    assert.equal(plainRuns, 0, 'without a limit nothing is read while the writing goes on');
    assert.ok(cappedRuns.length >= 6, `read ${cappedRuns.length} times`);
    for (let i = 1; i < cappedRuns.length; i++) assert.ok(cappedRuns[i] - cappedRuns[i - 1] <= 1800);
    // Once quiet, as before: one run 600 ms after the last call.
    mock.timers.tick(2000);
    runs.length = 0;
    capped();
    mock.timers.tick(599);
    assert.equal(runs.length, 0);
    mock.timers.tick(1);
    assert.equal(runs.length, 1);
  } finally {
    mock.timers.reset();
  }
});
