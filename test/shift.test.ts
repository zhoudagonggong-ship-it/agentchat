import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, GRACE_MS, LOST_MS, LOST_ONLINE_MS, lineOf, outranks, type Probe } from '../src/shift.ts';

const line = ['n95', 'server', 'pc5090', 'laptop'];
const base = { hub: 'n95', term: 3, line, probes: new Map<string, Probe | null>(), ready: true };

test('the first in line after the hub takes over once the hub is gone long enough; the others wait their turn', () => {
  const online = new Set(['server', 'pc5090', 'laptop']);
  assert.deepEqual(decide({ ...base, self: 'server', lostFor: LOST_MS - 1, online }), { do: 'wait' });
  assert.deepEqual(decide({ ...base, self: 'server', lostFor: LOST_MS, online }), { do: 'takeOver', term: 4 });
  // The next ones give the earlier ones, there on the network, time to take over first.
  assert.deepEqual(decide({ ...base, self: 'pc5090', lostFor: LOST_MS + GRACE_MS - 1, online }), { do: 'wait' });
  assert.deepEqual(decide({ ...base, self: 'pc5090', lostFor: LOST_MS + GRACE_MS, online }), { do: 'takeOver', term: 4 });
  assert.deepEqual(decide({ ...base, self: 'laptop', lostFor: LOST_MS + GRACE_MS, online }), { do: 'wait' });
});

test('one earlier in line but not on the network is not waited for', () => {
  assert.deepEqual(decide({ ...base, self: 'pc5090', lostFor: LOST_MS, online: new Set(['pc5090']) }), { do: 'takeOver', term: 4 });
});

test('a hub Tailscale still sees (its program restarting, say) is waited for longer', () => {
  const online = new Set(['n95', 'server']);
  assert.deepEqual(decide({ ...base, self: 'server', lostFor: LOST_ONLINE_MS - 1, online }), { do: 'wait' });
  assert.deepEqual(decide({ ...base, self: 'server', lostFor: LOST_ONLINE_MS, online }), { do: 'takeOver', term: 4 });
});

test('a computer without a copy of the record does not take over; the next one does after its grace', () => {
  const online = new Set(['server', 'pc5090']);
  assert.deepEqual(decide({ ...base, self: 'server', lostFor: LOST_MS * 10, online, ready: false }), { do: 'wait' });
  assert.deepEqual(decide({ ...base, self: 'pc5090', lostFor: LOST_MS + GRACE_MS, online }), { do: 'takeOver', term: 4 });
});

test('a hub already there is followed, the latest term first; the old hub answering again means only waiting', () => {
  const online = new Set(['server', 'pc5090']);
  const probes = new Map<string, Probe | null>([['server', { hub: true, term: 4, stableId: 'server' }], ['n95', { hub: true, term: 3, stableId: 'n95' }]]);
  assert.deepEqual(decide({ ...base, self: 'pc5090', lostFor: 1000, online, probes }), { do: 'follow', id: 'server', term: 4 });
  const back = new Map<string, Probe | null>([['n95', { hub: true, term: 3, stableId: 'n95' }]]);
  assert.deepEqual(decide({ ...base, self: 'pc5090', lostFor: LOST_MS * 10, online, probes: back }), { do: 'wait' });
  // An old hub of an earlier term is not followed.
  const stale = new Map<string, Probe | null>([['laptop', { hub: true, term: 2, stableId: 'laptop' }]]);
  assert.deepEqual(decide({ ...base, self: 'server', lostFor: LOST_MS, online, probes: stale }), { do: 'takeOver', term: 4 });
});

test('two hubs meeting: the later term stays; on the same term, the earlier in line', () => {
  assert.equal(outranks({ hub: true, term: 4, stableId: 'server' }, 'n95', 3, line), true);
  assert.equal(outranks({ hub: true, term: 3, stableId: 'n95' }, 'server', 4, line), false);
  assert.equal(outranks({ hub: true, term: 4, stableId: 'server' }, 'pc5090', 4, line), true);
  assert.equal(outranks({ hub: true, term: 4, stableId: 'pc5090' }, 'server', 4, line), false);
  assert.equal(outranks({ hub: false, term: 9, stableId: 'pc5090' }, 'server', 4, line), false);
});

test('the line keeps the order chosen, drops computers no longer allowed, and puts new ones last', () => {
  const members = [{ id: 'server', name: 'server' }, { id: 'laptop', name: 'laptop' }, { id: 'pc5090', name: 'pc5090' }];
  assert.deepEqual(lineOf(['server', 'gone', 'n95', 'server'], members, 'n95'), ['server', 'n95', 'laptop', 'pc5090']);
  assert.deepEqual(lineOf([], members, 'n95'), ['n95', 'laptop', 'pc5090', 'server']);
});

/**
 * Many runs of the hub going away, the computers looking every 15 s each from their own moment, some of them gone too:
 * exactly one takes over (no two hubs), and it is the earliest in line that is there with a copy.
 */
test('simulated: whoever is there, exactly one computer takes over, the right one', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let run = 0; run < 2000; run++) {
    const there = line.slice(1).filter(() => rnd() < 0.7);
    const ready = new Set(there.filter(() => rnd() < 0.85));
    const online = new Set(there);
    const offset = new Map(there.map((id) => [id, rnd() * 15_000]));
    let hub: string | null = null;
    const tookOver: string[] = [];
    for (let t = 0; t < 20 * 60_000 && !hub; t += 1000) {
      for (const id of there) {
        if ((t - offset.get(id)!) % 15_000 >= 1000 || t < offset.get(id)!) continue; // looks every 15 s
        const probes = new Map<string, Probe | null>(there.filter((o) => o !== id).map((o) => [o, o === hub ? { hub: true, term: 4, stableId: o } : null]));
        const v = decide({ self: id, hub: 'n95', term: 3, line, lostFor: t + 30_000, online, probes, ready: ready.has(id) });
        if (v.do === 'takeOver') {
          tookOver.push(id);
          hub = id;
        }
      }
    }
    const want = line.slice(1).find((id) => online.has(id) && ready.has(id)) ?? null;
    assert.ok(tookOver.length <= 1, `run ${run}: ${tookOver.join(' and ')} both took over`);
    assert.equal(hub, want, `run ${run}: there ${[...online]}, ready ${[...ready]}`);
  }
});
