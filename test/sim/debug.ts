// Replays one run and prints everything about the tasks named: what the sender got back, where the task landed,
// what the hub recorded.   node test/sim/debug.ts <chaos: calm> <seed> <tasks> TASK-2 TASK-7
import { soak, SMALL } from './soak.ts';
import { PRESETS } from './chaos.ts';

const [, , chaosName = 'calm', seedArg = '1', tasksArg = '10', ...names] = process.argv;
const plan = { ...SMALL, tasks: Number(tasksArg), hours: Math.max(SMALL.hours, Number(tasksArg) / 15) };
// The world keeps console.log quiet while it runs: write straight out.
const say = (...a: unknown[]) => process.stdout.write(a.join(' ') + '\n');
const r = await soak(Number(seedArg), PRESETS[chaosName]!, plan, (world, tasks) => {
  for (const name of names) {
    const t = tasks.find((x) => x.id === name)!;
    const conv = (app: any, threadId: string) => `${app.name}/${app.convs.get(threadId).title}`;
    say(`\n== ${t.id}: ${conv(t.from.app, t.from.threadId)} → ${conv(t.to.app, t.to.threadId)}, waited ${t.waited}`);
    say('attempts', JSON.stringify(t.attempts));
    for (const c of world.computers) for (const app of c.apps) for (const l of app.landings) if (l.text.includes(`${t.id}：`)) say(`  landed ${new Date(l.at).toISOString().slice(11, 19)} in ${conv(app, l.threadId)}: ${l.text.slice(0, 90)}`);
    const id = t.attempts.find((a) => a.task)?.task;
    if (id && world.hub) {
      const db = (world.hub as any).store.db;
      say('request', JSON.stringify(db.prepare('SELECT state, turn_id, error, payload FROM requests WHERE request_id = ?').get(id)));
      say('handback', JSON.stringify(db.prepare('SELECT * FROM handbacks WHERE request_id = ?').get(id)));
      say('card', JSON.stringify(db.prepare("SELECT data FROM items WHERE item_id = ?").get(`handoff:${id}`)));
    }
  }
});
say('\nviolations', JSON.stringify(r.violations, null, 1));
