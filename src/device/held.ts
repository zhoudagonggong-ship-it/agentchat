// Messages held back from a desktop app's window so as not to disturb the owner working at this computer (typing,
// or the conversation still running). Held quietly they would leave the owner unaware that another agent waits, so:
// the owner hears of it once when it starts waiting (a reminder in the corner of the screen, which sends it in when
// clicked), again if it has waited long, and the tray menu offers to send everything waiting in now.

const LATE_MS = 10 * 60_000;

export interface Held {
  id: string;
  /** Who sent it ("office-pc · Goose") and to which conversation here. */
  who: string;
  title: string;
  since: number;
  /** The owner said: send it in now, even though they are at the computer or the conversation runs. */
  now: boolean;
  late: boolean;
}

export interface Reminder { title: string; text: string; action?: string }

const held = new Map<string, Held>();
let remind: (r: Reminder) => void = () => {};
let changed: (count: number) => void = () => {};

/** Where reminders and the count go: the tray, when this program runs under it. */
export function heldOutput(onRemind: (r: Reminder) => void, onCount: (count: number) => void): void {
  [remind, changed] = [onRemind, onCount];
}

/** Who a forwarded message comes from, as its mark says (「[来自 X「对话」…，经 AgentChat 转发]」); the phone otherwise. */
export function senderOf(text: string): string {
  return text.match(/^\[来自 ([^「\]，]+)/)?.[1]?.trim() ?? '你在手机上发的';
}

/**
 * A message that cannot go in now because of the owner (`reason`: in_use, busy, draft). The first time, the owner is
 * told; after LATE_MS, told once more. Returns what the owner decided so far (`now`).
 */
export function hold(id: string, who: string, title: string, reason: string): Held {
  let h = held.get(id);
  if (!h) {
    h = { id, who, title, since: Date.now(), now: false, late: false };
    held.set(id, h);
    changed(held.size);
    remind({ title: `${who} 的消息在等你`, text: `${why(reason)}，暂时没送进「${title}」。点这里现在送进去。`, action: `sendnow ${id}` });
  } else if (!h.late && Date.now() - h.since > LATE_MS) {
    h.late = true;
    remind({ title: `${who} 的消息已经等了 ${Math.round((Date.now() - h.since) / 60_000)} 分钟`, text: `还没送进「${title}」（${why(reason)}）。点这里现在送进去。`, action: `sendnow ${id}` });
  }
  return h;
}

function why(reason: string): string {
  return reason === 'draft' ? '输入框里有你没发出的字' : reason === 'busy' ? '这个对话正在运行' : '你正在用这台电脑';
}

/** It went in, or will not go in at all. */
export function release(id: string): void {
  if (held.delete(id)) changed(held.size);
}

/** The owner said send it (or, without an id, everything waiting) in now. */
export function sendNow(id?: string): number {
  let n = 0;
  for (const h of held.values()) if (!id || h.id === id) [h.now, n] = [true, n + 1];
  return n;
}

export function heldCount(): number {
  return held.size;
}
