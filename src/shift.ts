// Shifts: which computer is the hub. Every computer keeps a copy of the hub's record (replica.ts), so the hub is only a
// duty, handed on in a set order (the line). A planned change (an update, shutting down) hands it on first; a hub that
// is simply gone (power cut, network) is taken over by the next one in line that is there. Each hub's time on duty has
// a number (the term), counting up: when two computers both act as hub, the later term stays and the other steps down.
import { HUB_PORT } from './shared/protocol.ts';

/** The hub's computer has been unreachable this long, and Tailscale no longer sees it: it is gone. */
export const LOST_MS = 30_000;
/** Tailscale still sees the computer: its program may only be restarting (that takes seconds), so wait a little longer. */
export const LOST_ONLINE_MS = 90_000;
/** Each computer before this one in line, there on the network, gets this long to take over first. */
export const GRACE_MS = 45_000;

/** What a computer says at /api/info; null: no answer (not the hub, or not there). */
export interface Probe { hub: boolean; term: number; stableId: string }

export type Verdict = { do: 'wait' } | { do: 'follow'; id: string; term: number } | { do: 'takeOver'; term: number };

/** Position in the line: the earlier, the sooner on duty (not in it: last). */
export function rank(line: string[], id: string): number {
  const i = line.indexOf(id);
  return i < 0 ? Number.MAX_SAFE_INTEGER : i;
}

/** Whether the hub `other` is the one to stay when this hub (`self`, on `term`) meets it. */
export function outranks(other: Probe, self: string, term: number, line: string[]): boolean {
  if (!other.hub || other.stableId === self) return false;
  return other.term > term || (other.term === term && rank(line, other.stableId) < rank(line, self));
}

/**
 * A computer that lost its hub (`hub`, on `term`) for `lostFor` ms decides: follow a hub that is there (the latest
 * term), wait (it may come back, or someone before us in line takes over), or take over itself. `online`: computers
 * Tailscale sees; `probes`: their answers; `ready`: this computer holds a copy of the record.
 */
export function decide(s: { self: string; hub: string; term: number; line: string[]; lostFor: number; online: Set<string>;
  probes: Map<string, Probe | null>; ready: boolean }): Verdict {
  let best: Probe | null = null;
  for (const p of s.probes.values()) {
    if (!p?.hub || (p.term < s.term) || (p.term === s.term && p.stableId !== s.hub)) continue;
    if (!best || p.term > best.term || (p.term === best.term && rank(s.line, p.stableId) < rank(s.line, best.stableId))) best = p;
  }
  // The hub answers after all (only our link to it broke): reconnecting is all it takes.
  if (best) return best.stableId === s.hub && best.term === s.term ? { do: 'wait' } : { do: 'follow', id: best.stableId, term: best.term };
  const limit = s.online.has(s.hub) ? LOST_ONLINE_MS : LOST_MS;
  if (s.lostFor < limit) return { do: 'wait' };
  let before = 0;
  for (const id of s.line) {
    if (id === s.hub) continue;
    if (id === s.self) return s.ready ? { do: 'takeOver', term: s.term + 1 } : { do: 'wait' };
    before++;
    if (s.online.has(id) && s.lostFor < limit + GRACE_MS * before) return { do: 'wait' };
  }
  return { do: 'wait' };
}

/** The line as kept (ids in order), with every allowed computer in it: one not placed yet goes last. */
export function lineOf(kept: string[], members: { id: string; name: string }[], hubId: string): string[] {
  const known = new Set(members.map((m) => m.id).concat(hubId));
  const line = kept.filter((id, i) => known.has(id) && kept.indexOf(id) === i);
  if (!line.includes(hubId)) line.unshift(hubId);
  for (const m of [...members].sort((a, b) => a.name.localeCompare(b.name))) if (!line.includes(m.id)) line.push(m.id);
  return line;
}

/** Asks a computer whether it is the hub. */
export async function probe(dnsName: string): Promise<Probe | null> {
  try {
    const res = await fetch(`https://${dnsName}:${HUB_PORT}/api/info`, { signal: AbortSignal.timeout(4000) });
    const info = (await res.json()) as { app?: string; hub?: boolean; term?: number; stableId?: string };
    if (info.app !== 'allinone' || !info.stableId) return null;
    return { hub: info.hub === true, term: Number(info.term) || 1, stableId: info.stableId };
  } catch {
    return null;
  }
}
