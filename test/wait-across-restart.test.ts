import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Device } from '../src/device/device.ts';
import { normalizeRows, opensTurn, type MessageRow } from '../src/device/goose/normalize.ts';
import type { DeviceToHub, HubToDevice } from '../src/shared/protocol.ts';

test('a wait cut off by the hub restarting is asked again, for the minutes left, once the hub is back', async () => {
  const sent: DeviceToHub[] = [];
  const transport = { handlers: null as any, start() {}, send: (m: DeviceToHub) => void sent.push(m) };
  const device = new Device(mkdtempSync(join(tmpdir(), 'dev-')), 'd1', 'pc', 'secret', transport as any);
  await device.start();
  transport.handlers.message({ t: 'welcome' } satisfies HubToDevice);
  const answer = device.ask('wait', 'claude-code', { task: 't1', minutes: 60 }, 60_000);
  const asks = () => sent.filter((m) => m.t === 'ask') as Extract<DeviceToHub, { t: 'ask' }>[];
  assert.equal(asks().length, 1);
  // The hub restarts: the connection drops and comes back; the hub never answers the first copy.
  transport.handlers.disconnected('restart');
  // A wait asked while the hub is away waits for it, rather than failing at once.
  const later = device.ask('wait', 'claude-code', { task: 't2', minutes: 5 }, 60_000);
  assert.equal(asks().length, 1);
  transport.handlers.message({ t: 'welcome' } satisfies HubToDevice);
  const again = asks().slice(1);
  assert.deepEqual(again.map((a) => a.args.task).sort(), ['t1', 't2']);
  const first = again.find((a) => a.args.task === 't1')!;
  assert.ok(Number(first.args.minutes) <= 60 && Number(first.args.minutes) > 59);
  transport.handlers.message({ t: 'answer', id: first.id, result: { state: 'done' } } as HubToDevice);
  transport.handlers.message({ t: 'answer', id: again.find((a) => a.args.task === 't2')!.id, result: { state: 'running' } } as HubToDevice);
  assert.deepEqual(await answer, { state: 'done' });
  assert.deepEqual(await later, { state: 'running' });
  // Other asks still need the hub there.
  transport.handlers.disconnected('restart');
  await assert.rejects(device.ask('send', 'claude-code', { text: 'hi' }, 1_000), /没有连上主电脑/);
});

const row = (id: number, role: string, content: unknown[], seconds = id): MessageRow =>
  ({ id, message_id: `m${id}`, role, content_json: JSON.stringify(content), created_timestamp: seconds, metadata_json: null });

test('a long Goose turn read from its typed message on ends, and its files belong to it', () => {
  const typed = row(1, 'user', [{ type: 'text', text: '做 A2' }]);
  assert.equal(opensTurn(typed), true);
  const toolResult = row(3, 'user', [{ type: 'toolResponse', id: 'c1', toolResult: { status: 'success', value: { content: [] } } }]);
  assert.equal(opensTurn(toolResult), false);
  // The rows read began after the typed message (it was far back): the reader puts it first.
  const rows = [typed,
    row(2, 'assistant', [{ type: 'toolRequest', id: 'c1', toolCall: { value: { name: 'developer__write', arguments: { path: 'a.py' } } } }]),
    toolResult,
    row(4, 'assistant', [{ type: 'text', text: '做完了' }])];
  const n = normalizeRows(rows, new Map());
  assert.equal(n.turnId, 'm1');
  assert.equal(n.open, false);
  assert.ok(n.items.some((i) => i.kind === 'status' && i.turnId === 'm1' && i.data.status === 'completed'));
  assert.ok(n.items.filter((i) => i.kind !== 'status').every((i) => i.turnId === 'm1'));
  assert.deepEqual(n.files.map((f) => f.turnId), ['m1']);
  // Without it, as before: nothing knew the turn, so it never ended.
  assert.equal(normalizeRows(rows.slice(1), new Map()).turnId, null);
});
