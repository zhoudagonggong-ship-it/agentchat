import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/hub/store.ts';
import { Device, type Adapter, type AdapterSink } from '../src/device/device.ts';
import { HISTORY_MS } from '../src/shared/protocol.ts';
import type { DeviceToHub, HubToDevice, Item, SessionInfo } from '../src/shared/protocol.ts';

const HOUR = 3_600_000;
const conv = (running: boolean, turn: string | null): SessionInfo =>
  ({ threadId: 't1', title: '工厂控制台开发', cwd: null, updatedAt: 1000, running, activeTurnId: turn, preview: 'hi' } as SessionInfo);
const msg = (itemId: string, turnId: string | null, ts: number, extra: Record<string, unknown> = {}): Item =>
  ({ itemId, turnId, kind: 'message', ts, data: { role: 'assistant', text: itemId, ...extra } });

test('the hub lets a finished day-old turn go, with the files only it named; the rest of the day stays', () => {
  const dir = mkdtempSync(join(tmpdir(), 'history-'));
  const store = new Store(dir);
  const id = 'pc:codex:t1';
  const now = Date.now();
  const old = now - HISTORY_MS - HOUR;
  store.upsertSessions('pc', 'codex', [conv(true, 'run')], true);
  const file = (sha: string) => store.saveArtifact(sha, `${sha.slice(0, 4)}.png`, 3, 'image/png', Buffer.from('png'));
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((x) => x.repeat(64));
  for (const sha of [a, b, c, d]) file(sha);
  store.db.prepare('UPDATE artifacts SET created_at = ?').run(old);
  store.upsertItems(id, [
    msg('old1', 'A', old - HOUR), msg('old2', 'A', old), { itemId: 'oldfile', turnId: 'A', kind: 'artifact', ts: old + 1, data: { sha256: a, name: 'a.png' } },
    // A turn begun long ago that went on into the day stays whole, with its file.
    msg('long1', 'B', old), msg('long2', 'B', now - HOUR), { itemId: 'longfile', turnId: 'B', kind: 'artifact', ts: now - HOUR + 1, data: { sha256: b, name: 'b.png' } },
    // The turn the conversation is running, and an approval still waiting, stay however old.
    msg('run1', 'run', old),
    { itemId: 'ask', turnId: 'C', kind: 'approval_request', ts: old, data: { state: 'pending', command: 'rm x' } },
    msg('loose', null, old),
  ]);
  store.db.prepare("INSERT OR IGNORE INTO friends(device_id, agent_id, added) VALUES ('pc', 'codex', 1)").run();
  assert.ok(store.setFriend('pc', 'codex', { avatar: c }));
  const ledger = store.ledger;
  ledger.create('req-old-done-1', id, 'send', { op: 'send', text: 'x' }, 'x', 'delivered');
  ledger.create('req-old-owed-1', id, 'send', { op: 'send', text: 'y' }, 'y', 'delivered', 'pc:claude:t9');
  ledger.create('req-new-done-1', id, 'send', { op: 'send', text: 'z' }, 'z', 'delivered');
  store.db.prepare("UPDATE requests SET created_at = ? WHERE request_id LIKE 'req-old%'").run(old);
  writeFileSync(join(store.artifactDir, 'e'.repeat(64)), 'left over'); // a file on disk the record does not know (just written)

  assert.equal(store.forgetItems(now - HISTORY_MS, 2), 2); // a batch at a time
  assert.equal(store.forgetItems(now - HISTORY_MS, 100), 2);
  assert.equal(store.forgetItems(now - HISTORY_MS, 100), 0);
  const left = (store.db.prepare('SELECT item_id FROM items ORDER BY item_id').all() as { item_id: string }[]).map((r) => r.item_id);
  assert.deepEqual(left, ['ask', 'long1', 'long2', 'longfile', 'run1']);
  assert.equal(store.forgetRequests(now - HISTORY_MS), 1);
  assert.ok(!ledger.get('req-old-done-1') && ledger.get('req-old-owed-1') && ledger.get('req-new-done-1'));

  const went = store.forgetFiles(now - HISTORY_MS);
  assert.deepEqual(went, { files: 2, bytes: 6 }); // a: its turn went; d: named by nothing
  assert.ok(!store.artifact(a) && !existsSync(join(store.artifactDir, a)));
  assert.ok(store.artifact(b) && store.artifact(c), 'one a kept turn names, and a friend picture, stay');
  assert.ok(existsSync(join(store.artifactDir, 'e'.repeat(64))), 'one just written is not taken for a leftover');

  // A computer reading the conversation again reports it all: the old turn stays out, the rest goes in.
  const again = store.notHistory(id, [msg('old1', 'A', old - HOUR), msg('old2', 'A', old), msg('long1', 'B', old), msg('new', 'D', now)], now - HISTORY_MS);
  assert.deepEqual(again.map((i) => i.itemId), ['long1', 'new']);
  // The room goes back to the disk, with a copy of the record being taken from it.
  store.db.createSession();
  assert.equal(store.compact(0), true);
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('a computer reading an old conversation again sends only the last day of it, and no files of older turns', async () => {
  const sent: DeviceToHub[] = [];
  const transport = { handlers: null as any, start() {}, send: (m: DeviceToHub) => void sent.push(m) };
  const device = new Device(mkdtempSync(join(tmpdir(), 'dev-')), 'd1', 'pc', 'secret', transport as any);
  let sink!: AdapterSink;
  const adapter: Adapter = { info: { id: 'codex', kind: 'codex', label: 'Codex' }, start: async (s) => void (sink = s), hydrate() {}, command: async () => {} };
  device.add(adapter);
  await device.start();
  transport.handlers.message({ t: 'welcome' } satisfies HubToDevice);
  await new Promise((r) => setTimeout(r, 10));

  const now = Date.now();
  const old = now - HISTORY_MS - HOUR;
  sink.items('th1', [msg('o1', 'A', old - HOUR), msg('o2', 'A', old), msg('n1', 'B', old), msg('n2', 'B', now)]);
  sink.artifactData('th1', 'f1', 'A', 'old.png', 'image/png', Buffer.from('old'));
  sink.artifactData('th1', 'f2', 'B', 'new.png', 'image/png', Buffer.from('new'));
  await new Promise((r) => setTimeout(r, 10));
  const items = sent.filter((m) => m.t === 'items').flatMap((m: any) => m.items.map((i: Item) => i.itemId));
  assert.deepEqual(items, ['n1', 'n2']);
  assert.deepEqual(sent.filter((m) => m.t === 'artifact').map((m: any) => m.name), ['new.png']);
});
