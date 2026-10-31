import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/hub/store.ts';
import { ReplicaSource } from '../src/hub/replica.ts';
import { ReplicaSink } from '../src/device/replica.ts';
import { sha256 } from '../src/shared/util.ts';

const listen = (server: Server) => new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as { port: number }).port)));

/** Every table's rows, in a fixed order (the copy's own bookkeeping left out). */
function dump(file: string): string {
  const db = new DatabaseSync(file);
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
  const out = tables.map((t) => `${t}: ${JSON.stringify(db.prepare(`SELECT * FROM ${t}`).all()
    .filter((r: any) => !(t === 'meta' && String(r.key).startsWith('replica:'))).map((r) => JSON.stringify(r)).sort())}`).join('\n');
  db.close();
  return out;
}

/** A hub's record with a copy on another computer, linked as the hub links them (in order, or with a whole copy). */
async function pair() {
  const dir = mkdtempSync(join(tmpdir(), 'replica-'));
  const store = new Store(join(dir, 'hub'));
  const source = new ReplicaSource(store.db, join(dir, 'hub'));
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://hub');
    if (url.pathname === '/api/replica') return source.serve(url, req, res);
    const art = store.artifact(url.pathname.slice('/files/'.length));
    if (!art) return void res.writeHead(404).end();
    res.writeHead(200).end(readFileSync(art.path));
  });
  const base = `http://127.0.0.1:${await listen(server)}/`;
  const sink = new ReplicaSink(join(dir, 'computer'));
  const asks: [string, number][] = [];
  sink.send = (epoch, n) => asks.push([epoch, n]);
  sink.hub = () => base;
  /** Answers the copy's words until it has everything there is. */
  const settle = async () => {
    source.flush();
    for (let guard = 0; asks.length && guard < 100; guard++) {
      const [epoch, n] = asks.shift()!;
      const next = epoch === source.epoch ? source.after(n) : null;
      if (next?.length) sink.changesets(source.epoch, next[0].n, next.map((c) => c.data));
      else if (!next) {
        const s = await source.snapshot();
        await sink.snapshot(source.epoch, s.n, `${base}api/replica?token=${s.token}`);
      }
    }
  };
  const writes = (k: number) => {
    for (let i = 0; i < k; i++) {
      const r = Math.random();
      if (r < 0.4) store.upsertItems('dev:codex:t1', [{ itemId: `i${Math.floor(Math.random() * 50)}`, turnId: 't', kind: 'message', ts: Date.now(), data: { role: 'user', text: randomBytes(20).toString('hex') } }]);
      else if (r < 0.6) store.setSetting(`k${Math.floor(Math.random() * 5)}`, String(Math.random()));
      else if (r < 0.75) store.registerDevice(`d${Math.floor(Math.random() * 4)}`, 'pc', 'secret', []);
      else if (r < 0.85) store.removeDevice(`d${Math.floor(Math.random() * 4)}`);
      else {
        const data = randomBytes(1000 + Math.floor(Math.random() * 5000));
        store.saveArtifact(sha256(data), 'f.bin', data.length, 'application/octet-stream', data);
      }
    }
  };
  const done = () => {
    server.close();
    sink.close();
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, source, sink, settle, writes, done, asks };
}

test("a computer's copy of the hub's record ends up the same as the hub's, whole copy first, changes after", async () => {
  const p = await pair();
  p.writes(200);
  p.sink.joined(); // no copy yet: a whole one
  await p.settle();
  assert.ok(p.sink.ready);
  for (let round = 0; round < 20; round++) {
    p.writes(30);
    p.source.flush(); // the hub sends what changed every couple of seconds
    p.asks.push([p.source.epoch, (p.sink as any).n]);
    await p.settle();
  }
  p.store.db.exec('PRAGMA wal_checkpoint');
  assert.equal(dump(join(p.sink.dir, 'hub.sqlite')), dump(join(p.dir, 'hub', 'hub.sqlite')));
  p.done();
});

test('changesets missed or repeated are put right: the copy says where it is and gets what follows', async () => {
  const p = await pair();
  p.sink.joined();
  await p.settle();
  p.writes(20);
  const a = p.source.flush()!;
  p.writes(20);
  const b = p.source.flush()!;
  p.sink.changesets(p.source.epoch, b.n, [b.data]); // a got lost on the way
  assert.equal((p.sink as any).n, a.n - 1);
  p.sink.changesets(p.source.epoch, a.n, [a.data, b.data]);
  p.sink.changesets(p.source.epoch, a.n, [a.data, b.data]); // once more: already in
  assert.equal((p.sink as any).n, b.n);
  await p.settle();
  assert.equal(dump(join(p.sink.dir, 'hub.sqlite')), dump(join(p.dir, 'hub', 'hub.sqlite')));
  p.done();
});

test('a new run of the hub (another epoch) gives the copy a whole new copy', async () => {
  const p = await pair();
  p.writes(50);
  p.sink.joined();
  await p.settle();
  const old = (p.sink as any).epoch;
  // The hub restarted: a new source on the same record.
  const again = new ReplicaSource(p.store.db, join(p.dir, 'hub'));
  (p as any).source = again;
  p.writes(50);
  p.sink.changesets(again.epoch, 1, [again.flush()!.data]); // not its run: it asks again from where it is
  assert.deepEqual(p.asks.at(-1), [old, (p.sink as any).n]);
  p.done();
});

test("taking over: the copy and its files take the place of this computer's old hub record", async () => {
  const p = await pair();
  p.writes(150);
  p.sink.joined();
  await p.settle();
  await (p.sink as any).fetchFiles();
  const shas = (p.store.db.prepare('SELECT sha256 FROM artifacts').all() as { sha256: string }[]).map((r) => r.sha256);
  assert.ok(shas.length > 0);
  const want = dump(join(p.sink.dir, 'hub.sqlite'));
  const target = join(p.dir, 'computer');
  assert.equal(p.sink.promote(target), true);
  assert.equal(dump(join(target, 'hub.sqlite')), want);
  for (const s of shas) assert.ok(existsSync(join(target, 'artifacts', s)), `file ${s.slice(0, 8)} came along`);
  // The record opens as a hub's, numbers going on well past the old hub's.
  const store = new Store(target);
  const seq = store.currentSeq;
  store.skipSeq(1_000_000);
  assert.equal(store.currentSeq, seq + 1_000_000);
  store.db.close();
  p.done();
});
