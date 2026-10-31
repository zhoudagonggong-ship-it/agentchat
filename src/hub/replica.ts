// The hub's record, copied as it changes to every other computer, so any of them can take over as hub (see shift.ts).
// Changes are taken from SQLite itself (a session: every row written, whatever wrote it) as small changesets, a few
// seconds apart, numbered from the start of this run (the epoch). A computer further behind than the changesets kept
// here, or of another epoch, first takes a whole copy (a snapshot), then the changesets after it.
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, rmSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { DatabaseSync, Session } from 'node:sqlite';
import { fileSha256 } from '../handover.ts';
import { log } from '../shared/util.ts';

const KEEP_BYTES = 64 * 1024 * 1024; // changesets kept for computers catching up; further behind takes a snapshot

export class ReplicaSource {
  /** This run's own name: numbers count from its start. */
  readonly epoch = randomBytes(8).toString('hex');
  private n = 0;
  private session: Session;
  private readonly kept: { n: number; data: Buffer }[] = [];
  private keptBytes = 0;
  private snap: { n: number; file: string; sha256: string; token: string } | null = null;
  private making: Promise<{ n: number; token: string }> | null = null;
  private readonly db: DatabaseSync;
  private readonly dir: string;

  constructor(db: DatabaseSync, dir: string) {
    this.db = db;
    this.dir = dir;
    this.session = db.createSession();
  }

  /** The latest changeset's number. */
  get head(): number {
    return this.n;
  }

  /** What changed since the last call, as the next changeset; null when nothing did. */
  flush(): { n: number; data: Buffer } | null {
    const data = Buffer.from(this.session.changeset());
    if (!data.length) return null;
    this.session.close();
    this.session = this.db.createSession();
    const c = { n: ++this.n, data };
    this.kept.push(c);
    this.keptBytes += data.length;
    while (this.keptBytes > KEEP_BYTES && this.kept.length > 1) this.keptBytes -= this.kept.shift()!.data.length;
    return c;
  }

  /** The changesets after `n`, in order; null when they are no longer all kept (a snapshot then). */
  after(n: number): { n: number; data: Buffer }[] | null {
    if (n === this.n) return [];
    if (n > this.n || !this.kept.length || this.kept[0].n > n + 1) return null;
    return this.kept.filter((c) => c.n > n);
  }

  /** A whole copy as of a changeset's end: reused while the changesets after it are still kept. */
  snapshot(): Promise<{ n: number; token: string }> {
    if (this.snap && this.after(this.snap.n)) return Promise.resolve(this.snap);
    this.making ??= (async () => {
      try {
        this.flush(); // the copy and the numbering agree: the copy holds everything up to this changeset
        const n = this.n;
        const file = join(this.dir, 'replica-out.sqlite');
        rmSync(file, { force: true });
        this.db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
        this.snap = { n, file, sha256: await fileSha256(file), token: randomBytes(18).toString('base64url') };
        log('replica', `snapshot at ${n}: ${(statSync(file).size / 1048576).toFixed(1)} MB`);
        return this.snap;
      } finally {
        this.making = null;
      }
    })();
    return this.making;
  }

  /** GET /api/replica?token=…: the snapshot, from where a broken download got to (an HTTP Range). */
  serve(url: URL, req: IncomingMessage, res: ServerResponse): void {
    const s = this.snap;
    if (!s || url.searchParams.get('token') !== s.token || !existsSync(s.file)) return void res.writeHead(404).end();
    if (url.searchParams.get('done') === '1') return void res.writeHead(200).end('ok');
    const size = statSync(s.file).size;
    const from = Number(/^bytes=(\d+)-$/.exec(String(req.headers.range ?? ''))?.[1] ?? 0);
    if (from >= size && from > 0) return void res.writeHead(416, { 'Content-Range': `bytes */${size}`, 'X-Sha256': s.sha256 }).end();
    res.writeHead(from ? 206 : 200, { 'Content-Type': 'application/octet-stream', 'Content-Length': size - from, 'X-Sha256': s.sha256,
      ...(from ? { 'Content-Range': `bytes ${from}-${size - 1}/${size}` } : {}) });
    createReadStream(s.file, { start: from }).pipe(res);
  }
}
