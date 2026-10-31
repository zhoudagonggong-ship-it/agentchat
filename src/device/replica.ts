// This computer's copy of the hub's record (see hub/replica.ts), kept so it can take over as hub when it has to:
// a whole copy taken once, then the hub's changesets applied in order. Files the record names are fetched by their
// hash in the background, one at a time.
import { constants, DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { takeOver } from '../handover.ts';
import { log, sha256 } from '../shared/util.ts';

const FILES_EVERY_MS = 10 * 60_000;
const FILES_AT_ONCE = 4;

export class ReplicaSink {
  private db: DatabaseSync | null = null;
  private epoch = '';
  private n = 0;
  private fetching: Promise<void> | null = null;
  private filesAt = 0;
  private closed = false;
  readonly dir: string;
  private readonly file: string;
  private readonly files: string;
  /** This computer's own hub files, from when it was the hub: copied, not downloaded. */
  private readonly own: string;
  /** Says where this copy is, asking for what follows. */
  send: (epoch: string, n: number) => void = () => {};
  /** The hub's address (https://…/), for the snapshot and files. */
  hub: () => string = () => '';

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'replica');
    this.file = join(this.dir, 'hub.sqlite');
    this.files = join(this.dir, 'artifacts');
    this.own = join(dataDir, 'artifacts');
    mkdirSync(this.files, { recursive: true });
    this.open();
  }

  private open(): void {
    this.db?.close();
    this.db = null;
    this.epoch = '';
    this.n = 0;
    if (!existsSync(this.file)) return;
    try {
      const db = new DatabaseSync(this.file);
      const get = (k: string) => (db.prepare('SELECT value FROM meta WHERE key = ?').get(k) as { value: string } | undefined)?.value;
      this.epoch = get('replica:epoch') ?? '';
      this.n = Number(get('replica:n') ?? 0);
      this.db = db;
    } catch (e) {
      log('replica', `copy unreadable, taking a new one: ${(e as Error).message}`);
      rmSync(this.file, { force: true });
    }
  }

  /** Whether there is a copy at all (one of whatever age: better than none when taking over). */
  get ready(): boolean {
    return Boolean(this.db && this.epoch);
  }

  /** Connected to the hub: say where we are. */
  joined(): void {
    if (!this.closed) this.send(this.epoch, this.n);
  }

  /**
   * The next changesets (`n`: the first one's number), applied together. Whatever happens, the answer says where this
   * copy is now: the hub sends what follows from there (or a whole copy, for another run of the hub).
   */
  changesets(epoch: string, n: number, data: Buffer[]): void {
    if (this.closed) return;
    const db = this.db;
    const skip = this.n + 1 - n; // ones already in
    if (!db || epoch !== this.epoch || skip < 0 || skip >= data.length) return this.send(this.epoch, this.n);
    try {
      db.exec('BEGIN');
      for (const c of data.slice(skip)) db.applyChangeset(c, { onConflict: () => constants.SQLITE_CHANGESET_REPLACE });
      const last = n + data.length - 1;
      db.prepare("INSERT INTO meta(key, value) VALUES ('replica:n', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(last));
      db.exec('COMMIT');
      this.n = last;
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // nothing open
      }
      log('replica', `changesets from ${n} not applied (${(e as Error).message}); taking a new copy`);
      this.epoch = ''; // a fresh snapshot next
    }
    this.send(this.epoch, this.n);
    if (Date.now() - this.filesAt > FILES_EVERY_MS) void this.fetchFiles();
  }

  /** Too far behind: take the whole copy, then go on from it. */
  async snapshot(epoch: string, n: number, url: string): Promise<void> {
    if (this.closed) return;
    const part = join(this.dir, 'incoming.sqlite');
    try {
      await takeOver(url, part);
      if (this.closed) return;
      this.db?.close();
      this.db = null;
      for (const f of ['hub.sqlite', 'hub.sqlite-wal', 'hub.sqlite-shm']) rmSync(join(this.dir, f), { force: true });
      renameSync(part, this.file);
      const db = new DatabaseSync(this.file);
      db.exec('PRAGMA journal_mode = WAL');
      db.prepare("INSERT INTO meta(key, value) VALUES ('replica:epoch', ?), ('replica:n', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(epoch, String(n));
      db.close();
      this.open();
      log('replica', `took a whole copy of the hub's record (at ${n})`);
    } catch (e) {
      rmSync(part, { force: true });
      log('replica', `could not take a copy: ${(e as Error).message}`);
    }
    this.send(this.epoch, this.n);
    void this.fetchFiles();
  }

  /** Files the record names that are not here yet, one at a time, each checked by its hash. */
  private fetchFiles(): Promise<void> {
    this.filesAt = Date.now();
    this.fetching ??= (async () => {
      try {
        // One kept from this computer's own time as hub is there already: taking over finds it in place.
        const have = new Set([...readdirSync(this.files), ...(existsSync(this.own) ? readdirSync(this.own) : [])]);
        const want = ((this.db?.prepare('SELECT sha256 FROM artifacts').all() ?? []) as { sha256: string }[]).map((r) => r.sha256).filter((s) => !have.has(s));
        let got = 0;
        const put = (sha: string, data: Buffer) => {
          writeFileSync(join(this.files, sha + '.tmp'), data);
          renameSync(join(this.files, sha + '.tmp'), join(this.files, sha));
          got++;
        };
        const queue = [...want];
        const worker = async () => {
          for (let sha = queue.shift(); sha && !this.closed && this.hub(); sha = queue.shift()) {
            try {
              const res = await fetch(`${this.hub()}files/${sha}`, { signal: AbortSignal.timeout(120_000) });
              if (!res.ok) continue;
              const data = Buffer.from(await res.arrayBuffer());
              if (sha256(data) === sha) put(sha, data);
            } catch {
              // the next round tries again
            }
          }
        };
        await Promise.all(Array.from({ length: FILES_AT_ONCE }, worker));
        if (got) log('replica', `fetched ${got} of ${want.length} files the record names`);
      } finally {
        this.fetching = null;
      }
    })();
    return this.fetching;
  }

  /**
   * This computer becomes the hub: the copy takes the place of the hub record in `dataDir` (an older one there is
   * from when this computer was hub before), its files join the others. Returns false when there is no copy.
   */
  promote(dataDir: string): boolean {
    this.closed = true;
    if (!this.ready) return false;
    this.db!.close();
    this.db = null;
    for (const f of ['hub.sqlite', 'hub.sqlite-wal', 'hub.sqlite-shm']) rmSync(join(dataDir, f), { force: true });
    renameSync(this.file, join(dataDir, 'hub.sqlite'));
    for (const f of ['hub.sqlite-wal', 'hub.sqlite-shm']) if (existsSync(join(this.dir, f))) renameSync(join(this.dir, f), join(dataDir, f));
    const artifacts = join(dataDir, 'artifacts');
    mkdirSync(artifacts, { recursive: true });
    for (const f of readdirSync(this.files)) {
      if (f.endsWith('.tmp') || existsSync(join(artifacts, f))) rmSync(join(this.files, f), { force: true });
      else renameSync(join(this.files, f), join(artifacts, f));
    }
    return true;
  }

  close(): void {
    this.closed = true;
    this.db?.close();
    this.db = null;
  }
}
