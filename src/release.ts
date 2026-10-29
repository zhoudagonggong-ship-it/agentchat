// New versions published on GitHub Releases. Only the hub looks (once a day), and only takes one when the owner
// says so; the other computers then follow the hub as they always do. The repository is `allinone.releases` in
// package.json ("owner/name"); empty: nothing is checked.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const APP_DIR = join(import.meta.dirname, '..');

export interface Release { version: string; zip: string; sha256: string | null; notes: string }

function packageInfo(): { version: string; repo: string } {
  const pkg = JSON.parse(readFileSync(join(APP_DIR, 'package.json'), 'utf8')) as { version: string; allinone?: { releases?: string } };
  return { version: pkg.version, repo: pkg.allinone?.releases ?? '' };
}

export const currentVersion = (): string => packageInfo().version;

/** 1.10.0 > 1.9.2; a leading "v" is ignored. */
export function newer(a: string, b: string): boolean {
  const parts = (v: string) => v.replace(/^v/i, '').split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

/** The latest release, when it is newer than this program and carries the install zip. */
export async function latestRelease(): Promise<Release | null> {
  const { version, repo } = packageInfo();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return null;
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'AgentChat' }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) return null;
  const r = (await res.json()) as { tag_name?: string; body?: string; assets?: { name: string; browser_download_url: string }[] };
  const zip = r.assets?.find((a) => /^(AgentChat|AllinOne)-.*\.zip$/.test(a.name)); // AllinOne: the old name
  if (!r.tag_name || !zip || !newer(r.tag_name, version)) return null;
  // The release may publish the zip's SHA-256 beside it ("<zip>.sha256"): then the download is checked against it.
  const sum = r.assets?.find((a) => a.name === `${zip.name}.sha256`);
  const sha256 = sum ? (await (await fetch(sum.browser_download_url, { signal: AbortSignal.timeout(30_000) })).text()).trim().split(/\s+/)[0]!.toLowerCase() : null;
  return { version: r.tag_name.replace(/^v/i, ''), zip: zip.browser_download_url, sha256, notes: (r.body ?? '').slice(0, 2000) };
}

/** Downloads a release's zip, checked against its published SHA-256 when there is one. */
export async function downloadRelease(release: Release): Promise<Buffer> {
  const res = await fetch(release.zip, { signal: AbortSignal.timeout(15 * 60_000) });
  if (!res.ok) throw new Error(`下载失败（${res.status}）`);
  const data = Buffer.from(await res.arrayBuffer());
  if (release.sha256 && createHash('sha256').update(data).digest('hex') !== release.sha256) throw new Error('下载的文件校验不通过');
  return data;
}
