import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Device, type Adapter } from '../src/device/device.ts';
import { Store } from '../src/hub/store.ts';
import type { DeviceToHub, HubToDevice } from '../src/shared/protocol.ts';

const fakeAdapter = (id: string, started: string[]): Adapter => ({
  info: { id, kind: 'opencode', label: id },
  start: async () => void started.push(id),
  hydrate() {},
  command: async () => {},
});

test('an agent found while running starts at once and the hub hears of it', async () => {
  const sent: DeviceToHub[] = [];
  const transport = { handlers: null as any, start() {}, send: (m: DeviceToHub) => void sent.push(m) };
  const device = new Device(mkdtempSync(join(tmpdir(), 'dev-')), 'd1', 'pc', 'secret', transport as any);
  const started: string[] = [];
  device.add(fakeAdapter('codex', started));
  await device.start();
  transport.handlers.message({ t: 'welcome' } satisfies HubToDevice);
  device.add(fakeAdapter('goose', started));
  device.add(fakeAdapter('goose', started)); // found again: nothing happens
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(started, ['codex', 'goose']);
  const agents = sent.filter((m) => m.t === 'agents');
  assert.equal(agents.length, 1);
  assert.deepEqual((agents[0] as any).agents.map((a: any) => a.id), ['codex', 'goose']);
});

test('the hub tells which agents are new to a known computer', () => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'hub-')));
  const codex = { id: 'codex', kind: 'codex' as const, label: 'Codex' };
  const goose = { id: 'goose', kind: 'goose' as const, label: 'Goose' };
  store.registerDevice('d1', 'pc', 'secret', [codex]);
  assert.deepEqual(store.setAgents('d1', [codex, goose]), [goose]);
  assert.deepEqual(store.setAgents('d1', [codex, goose]), []);
  assert.deepEqual(store.setAgents('unknown', [codex]), []);
});
