// Reads the tailnet through the local `tailscale` CLI (no LocalAPI socket handling of our own).
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

const run = promisify(execFile);
const WINDOWS_CLI = 'C:\\Program Files\\Tailscale\\tailscale.exe';
// ALLINONE_TAILSCALE: another CLI, only in tests.
export const CLI = process.env.ALLINONE_TAILSCALE ?? (process.platform === 'win32' && existsSync(WINDOWS_CLI) ? WINDOWS_CLI : 'tailscale');

export interface TailnetDevice {
  stableId: string;
  name: string; // short host name shown to the user
  dnsName: string; // e.g. my-pc.tail1234.ts.net (no trailing dot)
  os: string;
  online: boolean;
  self: boolean;
}

export interface TailnetStatus {
  self: TailnetDevice;
  ownerLogin: string;
  devices: TailnetDevice[]; // self first
}

interface RawNode { ID: string; HostName: string; DNSName: string; OS: string; Online: boolean; UserID: number }

function toDevice(node: RawNode, self: boolean): TailnetDevice {
  const dnsName = node.DNSName.replace(/\.$/, '');
  return {
    stableId: node.ID,
    name: dnsName.split('.')[0] || node.HostName,
    dnsName,
    os: node.OS,
    online: self || node.Online,
    self,
  };
}

/**
 * What still stands between this computer and the tailnet, in the order the owner fixes it: Tailscale is not
 * installed, not running (or turned off), or not signed in. null when it is ready.
 */
export type TailscaleStep = 'install' | 'start' | 'login';
export async function tailscaleProblem(): Promise<{ step: TailscaleStep; url?: string } | null> {
  let stdout = '';
  try {
    stdout = (await run(CLI, ['status', '--json'], { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 15_000 })).stdout;
  } catch (error) {
    const e = error as { code?: string; stdout?: string };
    if (e.code === 'ENOENT') return { step: 'install' };
    stdout = e.stdout ?? ''; // a stopped Tailscale still prints its state, with a failing exit code
  }
  return problemFromStatus(stdout);
}

/** Reads `tailscale status --json` output: what the owner still has to do, or null. */
export function problemFromStatus(stdout: string): { step: TailscaleStep; url?: string } | null {
  let raw: { BackendState?: string; AuthURL?: string };
  try {
    raw = JSON.parse(stdout);
  } catch {
    return { step: 'start' }; // the service does not answer
  }
  if (raw.BackendState === 'Running') return null;
  if (raw.BackendState === 'NeedsLogin' || raw.BackendState === 'NeedsMachineAuth') return { step: 'login', ...(raw.AuthURL ? { url: raw.AuthURL } : {}) };
  return { step: 'start' };
}

/** Starts signing in; resolves with the page the owner signs in on (Tailscale prints it), or null. */
export function tailscaleLoginUrl(): Promise<string | null> {
  return new Promise((done) => {
    const child = execFile(CLI, ['login'], { windowsHide: true, timeout: 10 * 60_000 }, () => {});
    let text = '';
    const look = (d: unknown) => {
      text += String(d);
      const url = /https:\/\/login\.tailscale\.com\/\S+/.exec(text)?.[0];
      if (url) done(url);
    };
    child.stdout?.on('data', look);
    child.stderr?.on('data', look);
    setTimeout(() => done(null), 20_000);
  });
}

/** Turns Tailscale on (it was installed but stopped). */
export async function tailscaleUp(): Promise<void> {
  await run(CLI, ['up'], { windowsHide: true, timeout: 30_000 }).catch(() => {});
}

export async function tailnetStatus(): Promise<TailnetStatus> {
  const { stdout } = await run(CLI, ['status', '--json'], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  const raw = JSON.parse(stdout) as { Self: RawNode; Peer?: Record<string, RawNode>; User?: Record<string, { LoginName: string }> };
  const self = toDevice(raw.Self, true);
  const peers = Object.values(raw.Peer ?? {}).map((node) => toDevice(node, false));
  const ownerLogin = raw.User?.[String(raw.Self.UserID)]?.LoginName ?? '';
  return { self, ownerLogin, devices: [self, ...peers.sort((a, b) => a.name.localeCompare(b.name))] };
}
