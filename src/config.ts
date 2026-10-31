// Per-machine settings. The only thing the user chooses is which device is the hub.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { HubRef } from './shared/protocol.ts';

export const APP_DIR = resolve(join(import.meta.dirname, '..'));
export const DATA_DIR = resolve(process.env.ALLINONE_DATA ?? join(APP_DIR, 'data'));
mkdirSync(DATA_DIR, { recursive: true });

export interface Config {
  hub: HubRef | null;
  /** Generated once; proves to the hub that a reconnecting device is the one the owner allowed. */
  deviceSecret: string;
  paused: boolean;
  /** The hub's term and the line that takes over when it is gone, as last heard (shift.ts). */
  term?: number;
  line?: HubRef[];
}

const FILE = join(DATA_DIR, 'config.json');
/** The very first start on this computer (before anything was saved). */
export const FIRST_RUN = !existsSync(FILE);
/** ALLINONE_TEST: a pretend computer in a test; leaves the real computer's settings (autostart) alone. */
export const IN_TEST = process.env.ALLINONE_TEST === '1';

export function loadConfig(): Config {
  let config: Partial<Config> = {};
  try {
    config = JSON.parse(readFileSync(FILE, 'utf8')) as Partial<Config>;
  } catch {
    // first run
  }
  const full: Config = { hub: config.hub ?? null, deviceSecret: config.deviceSecret ?? randomBytes(32).toString('base64url'), paused: config.paused ?? false,
    term: config.term, line: config.line };
  if (!config.deviceSecret) saveConfig(full);
  return full;
}

export function saveConfig(config: Config): void {
  const tmp = FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(config, null, 2));
  renameSync(tmp, FILE);
}
