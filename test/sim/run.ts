// Runs the simulator from the command line and prints what broke, by promise, with the seeds to replay it:
//   node test/sim/run.ts [chaos] [seeds] [tasks]      chaos: calm | net | crash | window | all (default all)
import { PRESETS } from './chaos.ts';
import { soak, SMALL, type Violation } from './soak.ts';

const [name = 'all', seedsArg = '5', tasksArg = String(SMALL.tasks)] = process.argv.slice(2);
const chaos = PRESETS[name];
if (!chaos) throw new Error(`no chaos called ${name}`);
const seeds = Number(seedsArg);
const plan = { ...SMALL, tasks: Number(tasksArg), hours: Math.max(SMALL.hours, Number(tasksArg) / 15) };

const all: (Violation & { seed: number })[] = [];
let tasks = 0;
for (let seed = 1; seed <= seeds; seed++) {
  const started = performance.now();
  const r = await soak(seed, chaos, plan);
  tasks += r.tasks;
  all.push(...r.violations.map((v) => ({ ...v, seed })));
  process.stdout.write(`seed ${seed}: ${r.tasks} 个任务，${r.violations.length} 处违规，${r.alarms} 次报警（${Math.round(performance.now() - started)} ms）\n`);
}
const byRule = new Map<string, typeof all>();
for (const v of all) byRule.set(v.rule, [...(byRule.get(v.rule) ?? []), v]);
process.stdout.write(`\n捣乱方式 ${name}：${seeds} 轮，共 ${tasks} 个任务，${all.length} 处违规\n`);
for (const [rule, list] of [...byRule].sort()) {
  process.stdout.write(`- ${rule}：${list.length} 处，例：${list.slice(0, 3).map((v) => `seed ${v.seed} ${v.task}（${v.detail}）`).join('；')}\n`);
}
