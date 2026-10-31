// A run of the simulator: agents on three computers hand each other tasks for hours of simulated time, adding to a
// task while it runs now and then, through whatever mischief the chaos allows; then the record of what really
// happened is checked against AgentChat's four promises.
import { AgentApp, KINDS } from './agent.ts';
import { QUIET, World, type Chaos, type Computer } from './world.ts';

export interface Task {
  id: string;
  from: { c: Computer; app: AgentApp; threadId: string; conv: string };
  to: { c: Computer; app: AgentApp; threadId: string; conv: string };
  sentAt: number;
  /** The sender waited for the outcome itself (then no report is due). */
  waited: boolean;
  attempts: { ok: boolean; task?: string; error?: string; state?: string; note?: string }[];
}

export interface Violation { rule: string; task: string; detail: string }
export interface Report { seed: number; tasks: number; violations: Violation[]; alarms: number }

export interface Plan {
  tasks: number;
  /** Simulated time the tasks are spread over. */
  hours: number;
  /** Share of tasks followed by one or two more for the same conversation while it works. */
  addOns: number;
  /** Share of senders that wait for the outcome instead of leaving it to the report. */
  waits: number;
}

export const SMALL: Plan = { tasks: 40, hours: 3, addOns: 0.25, waits: 0.15 };

/** The three computers of the owner's setup, each agent with a few conversations. */
export function owners(world: World): { usa: Computer; office: Computer; home: Computer } {
  const rng = world.rng;
  const usa = world.add('usa', [new AgentApp('claude@usa', KINDS.claude, rng, ['宣传片', '语言专家', '工厂控制台'])]);
  const office = world.add('office', [
    new AgentApp('opencode@office', KINDS.opencode, rng, ['五分钟片', '语言分级', '影视工厂']),
    new AgentApp('codex@office', KINDS.codex, rng, ['小工具', '盘点']),
  ]);
  const home = world.add('home', [new AgentApp('codex@home', KINDS.codex, rng, ['管道', '语音'])]);
  return { usa, office, home };
}

const pickConv = (world: World, avoid?: AgentApp) => {
  const options = world.computers.flatMap((c) => c.apps.filter((a) => a !== avoid).flatMap((app) => [...app.convs.keys()].map((threadId) => ({ c, app, threadId, conv: c.conv(app, threadId) }))));
  return world.rng.pick(options);
};

/** Sends one task, as an agent does: on an error, it tries once more a little later. */
async function sendTask(world: World, task: Task, text: string): Promise<void> {
  const args = { conversationId: task.to.conv, text, wait_minutes: task.waited ? 30 : 0 };
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await world.send(task.from.c, task.from.app, task.from.threadId, args);
    task.attempts.push(r.ok ? { ok: true, task: r.result.task, state: r.result.state, note: r.result.note } : { ok: false, error: r.error });
    if (r.ok) return;
    await new Promise((resolve) => setTimeout(resolve, 20_000));
  }
}

/** `setup`: other computers and agents than the owner's (see owners). */
export async function soak(seed: number, chaos: Chaos = QUIET, plan: Plan = SMALL, inspect?: (world: World, tasks: Task[]) => void,
  setup: (world: World) => unknown = owners): Promise<Report> {
  const world = new World(seed, chaos);
  setup(world);
  await world.boot();
  const tasks: Task[] = [];
  const span = plan.hours * 3_600_000;
  let n = 0;
  for (let i = 0; i < plan.tasks; i++) {
    const from = pickConv(world);
    const to = pickConv(world, from.app);
    const extra = world.rng.chance(plan.addOns) ? world.rng.between(1, 2) : 0;
    const waited = world.rng.chance(plan.waits);
    const at = world.rng.between(0, span);
    for (let k = 0; k <= extra; k++) {
      const task: Task = { id: `TASK-${++n}`, from, to, sentAt: 0, waited: k === 0 && waited, attempts: [] };
      tasks.push(task);
      setTimeout(() => {
        task.sentAt = Date.now();
        // An agent hands work on from within a turn of its own: the owner asked it to, there.
        const c = from.app.convs.get(from.threadId)!;
        if (!from.app.running(c)) from.app.land(from.threadId, '老周：这件事派给别人做');
        void sendTask(world, task, `${task.id}：${k ? '补充一条要求' : '请处理这件事'}`);
      }, at + k * world.rng.between(5_000, 30_000));
    }
  }
  await world.run(span + 3 * 3_600_000, 500);
  const violations = check(world, tasks);
  inspect?.(world, tasks);
  world.stop();
  return { seed, tasks: tasks.length, violations, alarms: world.alarms.length };
}

/** Why the hub sent no report for a task, as its own record shows. */
function why(world: World, task: Task): string {
  const id = task.attempts.find((a) => a.task)?.task;
  const db = (world.hub as any)?.store?.db;
  if (!id || !db?.prepare) return '中枢记录看不到';
  const r = db.prepare('SELECT state, turn_id, payload FROM requests WHERE request_id = ?').get(id) as { state: string; turn_id: string | null; payload: string } | undefined;
  if (!r) return '中枢没有这条任务';
  if (!JSON.parse(r.payload).origin?.sessionId) return '认不出发送方';
  if (!r.turn_id) return `送到时没归到一轮（${r.state}）`;
  const status = db.prepare("SELECT data FROM items WHERE session_id = ? AND item_id = ?").get(JSON.parse(r.payload).origin && db.prepare('SELECT session_id FROM requests WHERE request_id = ?').get(id).session_id, `turn:${r.turn_id}`) as { data: string } | undefined;
  if (!status) return '中枢没收到这一轮的结束';
  const owed = (db.prepare('SELECT owed FROM requests WHERE request_id = ?').get(id) as { owed: string | null }).owed;
  return owed === 'sent' ? '记为已汇报但没送到' : `这一轮 ${JSON.parse(status.data).status}，但没发汇报（${owed}）`;
}

/**
 * AgentChat's promises, checked against what really happened:
 * 1. no message goes missing without anyone being told;
 * 2. a message reaches the conversation it was sent to at most once;
 * 3. a message that lands in another conversation is noticed;
 * 4. every task a conversation took up comes back, once, to the conversation that sent it (or someone is told).
 */
export function check(world: World, tasks: Task[]): Violation[] {
  const out: Violation[] = [];
  const landings = world.computers.flatMap((c) => c.apps.flatMap((app) => app.landings.map((l) => ({ ...l, conv: c.conv(app, l.threadId) }))));
  const alarmed = (task: Task) => {
    const tags = task.attempts.filter((a) => a.task).map((a) => `#${a.task!.slice(0, 8)}`);
    return world.alarms.some((a) => a.text.includes(task.id) || tags.some((t) => a.text.includes(t)));
  };
  for (const task of tasks) {
    const sent = task.attempts.find((a) => a.ok);
    if (!sent) continue; // the sender was told it did not go: that is a known outcome
    const mine = landings.filter((l) => l.text.includes(`${task.id}：`) && !l.text.includes('的汇报'));
    const inTarget = mine.filter((l) => l.conv === task.to.conv);
    const elsewhere = mine.filter((l) => l.conv !== task.to.conv);
    if (!mine.length && !alarmed(task)) out.push({ rule: '1 消息丢了没人知道', task: task.id, detail: `发往 ${task.to.app.name}/${task.to.app.convs.get(task.to.threadId)!.title}，状态 ${sent.state}` });
    if (inTarget.length > 1) out.push({ rule: '2 同一条送到了两次', task: task.id, detail: `${inTarget.length} 次` });
    if (elsewhere.length && !alarmed(task)) out.push({ rule: '3 送错了对话没人发现', task: task.id, detail: `落在 ${elsewhere.map((l) => l.conv.split(':').at(-1)).join('、')}` });
  }
  // Rule 4, by the turns that took the tasks up: one report per sender per turn, to that sender.
  const byId = new Map(tasks.map((t) => [t.id, t]));
  for (const c of world.computers) {
    for (const app of c.apps) {
      for (const conv of app.convs.values()) {
        for (const turn of conv.turns.filter((t) => t.end !== null)) {
          const taken = turn.messages.map((id) => conv.msgs.find((m) => m.id === id)!.text)
            .filter((t) => !t.includes('的汇报')).map((t) => /TASK-\d+(?=：)/.exec(t)?.[0]).filter((id): id is string => Boolean(id)).map((id) => byId.get(id)!)
            .filter((t) => t && t.to.conv === c.conv(app, conv.threadId));
          const groups = new Map<string, Task[]>();
          for (const t of taken) groups.set(t.from.conv, [...(groups.get(t.from.conv) ?? []), t]);
          for (const [sender, group] of groups) {
            const first = group[0]!;
            if (group.some((t) => t.waited)) continue;
            const reports = landings.filter((l) => l.text.includes('的汇报') && l.text.includes(`${first.id}：`));
            const right = reports.filter((l) => l.conv === sender);
            const wrong = reports.filter((l) => l.conv !== sender);
            if (wrong.length && !alarmed(first)) out.push({ rule: '4 汇报送错了对话没人发现', task: first.id, detail: `该回 ${first.from.app.name}/${first.from.app.convs.get(first.from.threadId)!.title}` });
            // No report, and nobody told: broken. No report because the sender was not known: broken even if told, since
            // every message must be known by its sender (老周, 2026-10-30).
            const cause = right.length ? '' : why(world, first);
            if (cause && (cause === '认不出发送方' || !alarmed(first))) out.push({ rule: `4 做完了没有汇报（${cause}）`, task: first.id, detail: `${group.length} 条一起做的，发送方 ${first.from.app.name}` });
            if (right.length > 1) out.push({ rule: '4 汇报发了不止一次', task: first.id, detail: `${right.length} 次` });
          }
        }
      }
    }
  }
  return out;
}
