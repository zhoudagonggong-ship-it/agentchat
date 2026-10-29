// Self-update: the hub's copy of the program is the one every computer should run.
// A device whose code differs gets the hub's package, checks it, swaps it in and restarts.
// A new version that never reaches the hub after MAX_TRIES starts is rolled back.
// Only Node built-ins (and PowerShell's own zip commands), and nothing that would break with the rest of the code:
// main.ts runs bootCheck() before loading anything else.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const APP_DIR = resolve(join(import.meta.dirname, '..'));
const DATA_DIR = resolve(process.env.ALLINONE_DATA ?? join(APP_DIR, 'data'));
const UPDATE_DIR = join(DATA_DIR, 'update');
const STATE = join(UPDATE_DIR, 'state.json');
const PREVIOUS = join(UPDATE_DIR, 'previous');
const MAX_TRIES = 3;
/** What makes up the program (runtime/ and data/ stay; the phone app goes along so a new hub can serve it). */
// Never add to this list: older copies check a package against the same list, and would turn the new one down.
const PARTS = ['src', 'web', 'web-control', 'tray', 'node_modules', 'package.json', 'AllinOne.vbs', join('build', 'android', 'AllinOne.apk')];
/** These run the tray itself; when they change, the tray has to start again too. */
const TRAY_PARTS = ['tray', 'AllinOne.vbs'];
export const TRAY_RESTART_CODE = 76;
const run = promisify(execFile);

interface State { version: string; from: string; tries: number; at: number }

function files(base: string, parts: string[]): string[] {
  const out: string[] = [];
  const walk = (p: string) => {
    if (!existsSync(p)) return;
    if (statSync(p).isDirectory()) for (const f of readdirSync(p)) walk(join(p, f));
    else out.push(p);
  };
  for (const part of parts) walk(join(base, part));
  return out.map((f) => relative(base, f).split(sep).join('/')).sort();
}

/** A fingerprint of the program's files: equal code, equal version, on any computer. */
export function codeVersion(base = APP_DIR, parts = PARTS): string {
  const hash = createHash('sha256');
  for (const f of files(base, parts)) hash.update(f + '\0').update(readFileSync(join(base, f))).update('\0');
  return hash.digest('hex').slice(0, 16);
}

/** A development checkout is never overwritten: its code is ahead of any package. */
export const isDevCheckout = (): boolean => existsSync(join(APP_DIR, '.git'));

let packed: { version: string; data: Buffer } | null = null;
let packing: Promise<{ version: string; data: Buffer }> | null = null;
/** The hub's own program as a zip, built once per version; devices connecting together share one build. */
export function buildPackage(): Promise<{ version: string; data: Buffer }> {
  if (packed?.version === codeVersion()) return Promise.resolve(packed);
  packing ??= pack().finally(() => (packing = null));
  return packing;
}

async function pack(): Promise<{ version: string; data: Buffer }> {
  const version = codeVersion();
  mkdirSync(UPDATE_DIR, { recursive: true });
  const zip = join(UPDATE_DIR, `package-${version}.zip`);
  if (!existsSync(zip)) {
    const paths = PARTS.filter((p) => existsSync(join(APP_DIR, p))).map((p) => `'${join(APP_DIR, p).replace(/'/g, "''")}'`).join(',');
    // Keeps build\android\AllinOne.apk under its folder: zip the staged copy, not the file alone.
    const stage = join(UPDATE_DIR, `pack-${version}`);
    rmSync(stage, { recursive: true, force: true });
    mkdirSync(stage, { recursive: true });
    await ps(`$ErrorActionPreference='Stop'; foreach ($p in @(${paths})) { $rel = $p.Substring(${APP_DIR.length + 1}); $dst = Join-Path '${stage}' $rel; New-Item -ItemType Directory -Force (Split-Path $dst) | Out-Null; Copy-Item $p $dst -Recurse -Force }; Compress-Archive -Path (Join-Path '${stage}' '*') -DestinationPath '${zip}' -Force`);
    rmSync(stage, { recursive: true, force: true });
    for (const f of readdirSync(UPDATE_DIR)) if (/^package-.*\.zip$/.test(f) && f !== `package-${version}.zip`) rmSync(join(UPDATE_DIR, f), { force: true });
  }
  packed = { version, data: readFileSync(zip) };
  return packed;
}

/**
 * Unpacks the hub's package, checks it really is `version`, moves the running copy aside and the new one in.
 * Returns the exit code to restart with: the tray's own files changed, or only the program's.
 */
export async function applyPackage(version: string | null, data: Buffer): Promise<number> {
  // `version` null: a release downloaded from GitHub (checked by its SHA-256 instead); it takes its own fingerprint.
  const name = version ?? 'release';
  const stage = join(UPDATE_DIR, `stage-${name}`);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  const zip = join(UPDATE_DIR, `incoming-${name}.zip`);
  writeFileSync(zip, data);
  await ps(`Expand-Archive -LiteralPath '${zip}' -DestinationPath '${stage}' -Force`);
  rmSync(zip, { force: true });
  const got = codeVersion(stage);
  if (!existsSync(join(stage, 'src', 'main.ts'))) {
    rmSync(stage, { recursive: true, force: true });
    throw new Error('the package holds no program');
  }
  version ??= got;
  if (got !== version) {
    rmSync(stage, { recursive: true, force: true });
    throw new Error(`package check failed (${got} ≠ ${version})`);
  }
  const from = codeVersion();
  const trayChanged = codeVersion(APP_DIR, TRAY_PARTS) !== codeVersion(stage, TRAY_PARTS);
  rmSync(PREVIOUS, { recursive: true, force: true });
  mkdirSync(PREVIOUS, { recursive: true });
  // Every move is undone if one fails (a file held open elsewhere): never half old, half new.
  const done: [string, string][] = [];
  try {
    for (const part of PARTS) {
      const cur = join(APP_DIR, part);
      const next = join(stage, part);
      if (existsSync(cur)) {
        moveInto(cur, join(PREVIOUS, part));
        done.push([join(PREVIOUS, part), cur]);
      }
      if (existsSync(next)) {
        moveInto(next, cur);
        done.push([cur, next]);
      }
    }
  } catch (error) {
    for (const [now, back] of done.reverse()) moveInto(now, back);
    rmSync(stage, { recursive: true, force: true });
    throw error;
  }
  rmSync(stage, { recursive: true, force: true });
  writeState({ version, from, tries: 0, at: Date.now() });
  return trayChanged ? TRAY_RESTART_CODE : 75;
}

/** Before anything else loads: count the starts of a fresh update and roll it back if it never settles. */
export function bootCheck(): void {
  const state = readState();
  if (!state) return;
  if (state.tries >= MAX_TRIES && existsSync(PREVIOUS)) {
    for (const part of PARTS) {
      const saved = join(PREVIOUS, part);
      if (!existsSync(saved)) continue;
      rmSync(join(APP_DIR, part), { recursive: true, force: true });
      moveInto(saved, join(APP_DIR, part));
    }
    rmSync(PREVIOUS, { recursive: true, force: true });
    rmSync(STATE, { force: true });
    // Remembered so the hub's same package is not taken again right away.
    writeFileSync(join(UPDATE_DIR, 'rejected.json'), JSON.stringify({ version: state.version, at: Date.now() }));
    console.error(`update ${state.version} did not start; rolled back to ${state.from}`);
    return;
  }
  writeState({ ...state, tries: state.tries + 1 });
}

/** The new version reached the hub: keep it. */
export function confirmUpdate(): string | null {
  const state = readState();
  if (!state) return null;
  rmSync(STATE, { force: true });
  return state.version;
}

/** A version that was rolled back here is not offered again for a day. */
export function wasRejected(version: string): boolean {
  try {
    const r = JSON.parse(readFileSync(join(UPDATE_DIR, 'rejected.json'), 'utf8')) as { version: string; at: number };
    return r.version === version && Date.now() - r.at < 86_400_000;
  } catch {
    return false;
  }
}

function readState(): State | null {
  try {
    return JSON.parse(readFileSync(STATE, 'utf8')) as State;
  } catch {
    return null;
  }
}

function writeState(state: State): void {
  mkdirSync(UPDATE_DIR, { recursive: true });
  writeFileSync(STATE, JSON.stringify(state));
}

function moveInto(from: string, to: string): void {
  mkdirSync(join(to, '..'), { recursive: true });
  renameSync(from, to);
}

async function ps(script: string): Promise<void> {
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, timeout: 120_000 });
}
