// The kinds of mischief the simulator runs under, by name.
import { QUIET, type Chaos } from './world.ts';

const window = { busy: 0.3, busyMs: [5_000, 120_000] as [number, number], elsewhere: 0.05, unsent: 0.03, lagMs: [0, 5_000] as [number, number] };
const net = { ...QUIET, latencyMs: [5, 400] as [number, number], cutEveryMs: 20 * 60_000 };
const crash = { hubCrashEveryMs: 90 * 60_000, deviceCrashEveryMs: 60 * 60_000 };

export const PRESETS: Record<string, Chaos> = {
  calm: QUIET,
  net,
  crash: { ...QUIET, ...crash },
  window: { ...QUIET, window },
  all: { ...net, ...crash, window },
};
