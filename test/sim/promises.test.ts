// AgentChat's promises under the simulator, a few short runs per kind of mischief (node test/sim/run.ts runs long
// ones). Marked todo: what today's code is known to break; each comes off the list as the rebuild fixes it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentApp, KINDS } from './agent.ts';
import { PRESETS } from './chaos.ts';
import { SMALL, soak } from './soak.ts';
import type { Chaos, World } from './world.ts';

const cases: { name: string; chaos: Chaos }[] = [
  { name: 'calm', chaos: PRESETS.calm! },
  { name: 'network breaking', chaos: PRESETS.net! },
  { name: 'hub and computers crashing', chaos: PRESETS.crash! },
  { name: 'windows going wrong', chaos: PRESETS.window! },
  { name: 'everything at once', chaos: PRESETS.all! },
];

test('a message an agent shows waiting before a turn takes it up still gets its report', async () => {
  // Shown in no turn at first, in its turn later: the hub follows the turn that finally takes it up.
  const setup = (world: World) => {
    const rng = world.rng;
    world.add('usa', [new AgentApp('claude@usa', KINDS.claude, rng, ['宣传片', '语言专家'])]);
    world.add('office', [new AgentApp('codex@office', { ...KINDS.codex, showsWaiting: true }, rng, ['小工具', '盘点'])]);
  };
  const broken = [];
  for (const seed of [1, 2, 3]) broken.push(...(await soak(seed, PRESETS.all!, { ...SMALL, tasks: 40, addOns: 0.5 }, undefined, setup)).violations.map((v) => `seed ${seed} ${v.rule} ${v.task}：${v.detail}`));
  assert.deepEqual(broken, []);
});

test('a message a window put in the wrong conversation, where nobody can look, is sent back and goes where it belongs', async () => {
  // Claude Code's records cannot be looked through here, and its window often types into the wrong conversation:
  // only the conversation that got it by mistake can tell, by sending it back.
  const setup = (world: World) => {
    const rng = world.rng;
    world.add('usa', [new AgentApp('claude@usa', { ...KINDS.claude, unsearchable: true }, rng, ['宣传片', '语言专家', '工厂控制台'])]);
    world.add('office', [new AgentApp('codex@office', KINDS.codex, rng, ['小工具', '盘点'])]);
  };
  const chaos = { ...PRESETS.calm!, window: { busy: 0, busyMs: [0, 0] as [number, number], elsewhere: 0.3, unsent: 0, lagMs: [0, 2_000] as [number, number] } };
  const broken = [];
  let returned = 0;
  for (const seed of [1, 2, 3]) {
    const r = await soak(seed, chaos, { ...SMALL, tasks: 30 }, undefined, setup);
    broken.push(...r.violations.map((v) => `seed ${seed} ${v.rule} ${v.task}：${v.detail}`));
    returned += r.alarms;
  }
  assert.deepEqual(broken, []);
  assert.ok(returned > 0, 'some messages went astray and were sent back');
});

for (const c of cases) {
  test(`promises hold: ${c.name}`, async () => {
    const broken = [];
    for (const seed of [1, 2, 4]) broken.push(...(await soak(seed, c.chaos)).violations.map((v) => `seed ${seed} ${v.rule} ${v.task}：${v.detail}`));
    assert.deepEqual(broken, []);
  });
}
