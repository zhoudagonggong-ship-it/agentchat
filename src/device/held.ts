// Messages held back from a desktop app's window so as not to disturb the owner working at this computer (typing,
// or the conversation still running). No reminder pops up for them (the owner found those more noise than help): the
// tray counts them and its menu offers to send everything waiting in now. One that cannot go in at all for a reason
// the owner has to see to gets a card on the phone instead (see the adapters).

export interface Held {
  id: string;
  /** Who sent it ("office-pc · Goose") and to which conversation here. */
  who: string;
  title: string;
  since: number;
  /** The owner said: send it in now, even though they are at the computer or the conversation runs. */
  now: boolean;
}

const held = new Map<string, Held>();
let changed: (count: number) => void = () => {};

/** Where the count goes: the tray, when this program runs under it. */
export function heldOutput(onCount: (count: number) => void): void {
  changed = onCount;
}

/** Who a forwarded message comes from, as its mark says (「[来自 X「对话」…，经 AgentChat 转发]」); the phone otherwise. */
export function senderOf(text: string): string {
  return text.match(/^\[来自 ([^「\]，]+)/)?.[1]?.trim() ?? '你在手机上发的';
}

/** A message that cannot go in now because of the owner (in_use, busy, draft). Returns what the owner decided so far (`now`). */
export function hold(id: string, who: string, title: string, _reason: string): Held {
  let h = held.get(id);
  if (!h) {
    h = { id, who, title, since: Date.now(), now: false };
    held.set(id, h);
    changed(held.size);
  }
  return h;
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
