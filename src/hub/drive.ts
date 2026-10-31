// The shared drive: a folder on one computer shared to the tailnet with Tailscale's own Taildrive
// (`tailscale drive share agentchat <folder>`). Every other computer with Tailscale reaches it at the same local
// address, http://100.100.100.100:8080/<tailnet>/<computer>/<share> (WebDAV), with no account or password: Tailscale
// knows who asks. The computer sharing it does not see its own shares there: it opens the folder itself.
// The hub opens it for the phone and the browser, which cannot speak WebDAV themselves: listing, reading, adding
// files and folders, removing.
import { execFile } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { CLI as TAILSCALE } from '../tailscale.ts';

export const DRIVE_SHARE = 'agentchat';
const DAV = 'http://100.100.100.100:8080';
const FIND_AGAIN_MS = 10 * 60_000;
const NO_DRIVE = '还没有网盘：在一台电脑上用 tailscale drive share 分享名为 agentchat 的文件夹';

export interface DriveEntry { name: string; dir: boolean; size: number; mtime: number; mime: string }

/** Where the drive is: a folder of this computer, or a WebDAV path on another. */
export interface Place { computer: string; root?: string; dav?: string }

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.log': 'text/plain; charset=utf-8',
  '.json': 'application/json', '.csv': 'text/csv; charset=utf-8', '.html': 'text/html; charset=utf-8', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg',
  '.zip': 'application/zip', '.apk': 'application/vnd.android.package-archive' };
const mimeOf = (name: string, told = '') => MIME[extname(name).toLowerCase()] ?? (told || 'application/octet-stream');
const byKind = (a: DriveEntry, b: DriveEntry) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, 'zh-CN');

class DriveError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The entries of one WebDAV PROPFIND answer (Depth 1), the folder itself left out. */
export function parsePropfind(xml: string, self: string): DriveEntry[] {
  const out: DriveEntry[] = [];
  const tag = (block: string, name: string) => block.match(new RegExp(`<(?:[\\w-]+:)?${name}[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, 'i'))?.[1]?.trim() ?? '';
  const want = decodeURIComponent(self).replace(/\/+$/, '');
  for (const block of xml.split(/<(?:[\w-]+:)?response[\s>]/i).slice(1)) {
    const href = decodeURIComponent(tag(block, 'href').replace(/^https?:\/\/[^/]+/, '')).replace(/\/+$/, '');
    if (!href || href === want) continue;
    const name = href.split('/').pop()!;
    const dir = /<(?:[\w-]+:)?collection\b/i.test(block);
    const mtime = Date.parse(tag(block, 'getlastmodified')) || 0;
    out.push({ name, dir, size: dir ? 0 : Number(tag(block, 'getcontentlength')) || 0, mtime, mime: dir ? '' : mimeOf(name, tag(block, 'getcontenttype')) });
  }
  return out.sort(byKind);
}

/** A path inside the drive as given by the page ("/交付/v1/a.zip"), made safe: no "..", no empty parts. */
export function drivePath(raw: string | null): string[] | null {
  const parts = String(raw ?? '').split('/').filter((p) => p !== '' && p !== '.');
  if (parts.some((p) => p === '..' || /[\\:*?"<>|\u0000-\u001f]/.test(p))) return null;
  return parts;
}

const cli = (args: string[]) => new Promise<string>((done) =>
  execFile(TAILSCALE, args, { windowsHide: true, timeout: 15_000 }, (error, out) => done(error ? '' : String(out))));

/** The folder this computer shares as DRIVE_SHARE (`tailscale drive list`), with this computer's name in the tailnet. */
async function ownShare(): Promise<Place | null> {
  const row = (await cli(['drive', 'list'])).split(/\r?\n/).map((l) => l.trim().split(/\s{2,}/)).find((c) => c[0] === DRIVE_SHARE && c[1]);
  if (!row) return null;
  let computer = '';
  try {
    computer = String(JSON.parse(await cli(['status', '--json'])).Self?.DNSName ?? '').split('.')[0]!;
  } catch {
    // the name only labels the page
  }
  return { computer, root: row[1]! };
}

export class Drive {
  private place: Place | null = null;
  private foundAt = 0;
  private finding: Promise<Place | null> | null = null;
  private readonly dav: string;
  private readonly own: () => Promise<Place | null>;

  constructor(dav = DAV, own = ownShare) {
    this.dav = dav;
    this.own = own;
  }

  private async propfind(path: string): Promise<DriveEntry[] | null> {
    const res = await fetch(this.dav + path, { method: 'PROPFIND', headers: { Depth: '1' }, signal: AbortSignal.timeout(15_000) });
    if (res.status === 404) return null;
    if (!res.ok && res.status !== 207) throw new DriveError(502, `网盘没有回应（${res.status}）`);
    return parsePropfind(await res.text(), path);
  }

  /** Where the share is: this computer's own, or another's seen through WebDAV; looked for again now and then. */
  private find(): Promise<Place | null> {
    if (this.place && Date.now() - this.foundAt < FIND_AGAIN_MS) return Promise.resolve(this.place);
    this.finding ??= (async () => {
      try {
        let place = await this.own().catch(() => null);
        for (const tailnet of place ? [] : (await this.propfind('/').catch(() => null)) ?? []) {
          if (!tailnet.dir) continue;
          const net = `/${encodeURIComponent(tailnet.name)}`;
          for (const machine of (await this.propfind(`${net}/`)) ?? []) {
            const at = `${net}/${encodeURIComponent(machine.name)}`;
            if (machine.dir && (await this.propfind(`${at}/`).catch(() => null))?.some((s) => s.dir && s.name === DRIVE_SHARE)) {
              place = { computer: machine.name, dav: `${at}/${DRIVE_SHARE}` };
              break;
            }
          }
          if (place) break;
        }
        [this.place, this.foundAt] = [place, Date.now()];
        return place;
      } finally {
        this.finding = null;
      }
    })();
    return this.finding;
  }

  private async where(): Promise<Place> {
    const place = await this.find();
    if (!place) throw new DriveError(404, NO_DRIVE);
    return place;
  }

  private davUrl(place: Place, parts: string[], dir = false): string {
    return this.dav + place.dav + (parts.length ? '/' + parts.map(encodeURIComponent).join('/') : '') + (dir ? '/' : '');
  }

  async list(parts: string[]): Promise<{ computer: string; entries: DriveEntry[] }> {
    const place = await this.where();
    if (place.root) {
      const dir = join(place.root, ...parts);
      const names = await readdir(dir, { withFileTypes: true }).catch(() => null);
      if (!names) throw new DriveError(404, '这个文件夹不存在');
      const entries: DriveEntry[] = [];
      for (const d of names) {
        const s = await stat(join(dir, d.name)).catch(() => null);
        if (s) entries.push({ name: d.name, dir: s.isDirectory(), size: s.isDirectory() ? 0 : s.size, mtime: s.mtimeMs, mime: s.isDirectory() ? '' : mimeOf(d.name) });
      }
      return { computer: place.computer, entries: entries.sort(byKind) };
    }
    const entries = await this.propfind(this.davUrl(place, parts, true).slice(this.dav.length));
    if (!entries) throw new DriveError(404, '这个文件夹不存在');
    return { computer: place.computer, entries };
  }

  /** A file to send on: its size when known and its bytes. */
  private async read(parts: string[]): Promise<{ size: number | null; body: Readable }> {
    const place = await this.where();
    if (place.root) {
      const file = join(place.root, ...parts);
      const s = await stat(file).catch(() => null);
      if (!s?.isFile()) throw new DriveError(404, '没有这个文件');
      return { size: s.size, body: createReadStream(file) };
    }
    const got = await fetch(this.davUrl(place, parts), { signal: AbortSignal.timeout(60_000) });
    if (!got.ok || !got.body) throw new DriveError(got.status === 404 ? 404 : 502, '打不开这个文件');
    return { size: Number(got.headers.get('content-length')) || null, body: Readable.fromWeb(got.body as any) };
  }

  private async write(parts: string[], body: IncomingMessage): Promise<void> {
    const place = await this.where();
    if (place.root) return void (await pipeline(body, createWriteStream(join(place.root, ...parts))));
    const sent = await fetch(this.davUrl(place, parts), { method: 'PUT', body: Readable.toWeb(body) as any, duplex: 'half',
      headers: body.headers['content-length'] ? { 'Content-Length': String(body.headers['content-length']) } : {} } as RequestInit);
    if (!sent.ok) throw new DriveError(502, `没有传上去（${sent.status}）`);
  }

  private async makeDir(parts: string[]): Promise<void> {
    const place = await this.where();
    if (place.root) {
      await mkdir(join(place.root, ...parts)).catch((e: NodeJS.ErrnoException) => {
        throw new DriveError(e.code === 'EEXIST' ? 409 : 502, e.code === 'EEXIST' ? '已经有同名的了' : '没有建成');
      });
      return;
    }
    const sent = await fetch(this.davUrl(place, parts, true), { method: 'MKCOL', signal: AbortSignal.timeout(60_000) });
    if (!sent.ok) throw new DriveError(sent.status === 405 ? 409 : 502, sent.status === 405 ? '已经有同名的了' : `没有建成（${sent.status}）`);
  }

  private async remove(parts: string[]): Promise<void> {
    const place = await this.where();
    if (place.root) return void (await rm(join(place.root, ...parts), { recursive: true }));
    const sent = await fetch(this.davUrl(place, parts), { method: 'DELETE', signal: AbortSignal.timeout(60_000) });
    if (!sent.ok) throw new DriveError(502, `没有删掉（${sent.status}）`);
  }

  /** The routes under /api/drive/; false when the request is not one of them. */
  handle(req: IncomingMessage, url: URL, res: ServerResponse): boolean {
    if (!url.pathname.startsWith('/api/drive/')) return false;
    const reply = (status: number, body: unknown) => {
      if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const parts = drivePath(url.searchParams.get('path'));
    if (!parts) return reply(400, { error: '路径不对' }), true;
    const op = `${req.method} ${url.pathname.slice('/api/drive/'.length)}`;
    void (async () => {
      try {
        if (op === 'GET list') return reply(200, await this.list(parts));
        if (!parts.length) return reply(400, { error: '要指定文件' });
        if (op === 'GET file') {
          const { size, body } = await this.read(parts);
          const name = parts[parts.length - 1]!;
          res.writeHead(200, { 'Content-Type': mimeOf(name), 'Cache-Control': 'no-cache', ...(size !== null ? { 'Content-Length': size } : {}),
            'Content-Disposition': `${url.searchParams.has('download') ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(name)}` });
          return void body.pipe(res);
        }
        if (op === 'PUT file') await this.write(parts, req);
        else if (op === 'POST mkdir') await this.makeDir(parts);
        else if (op === 'DELETE file') await this.remove(parts);
        else return reply(405, { error: '不支持' });
        reply(200, { ok: true });
      } catch (error) {
        reply(error instanceof DriveError ? error.status : 502, { error: (error as Error).message.slice(0, 200) });
      }
    })();
    return true;
  }
}
