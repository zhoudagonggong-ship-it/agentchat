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

test('a message left waiting for its window when the program stopped is taken up again; others run once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dev-'));
  const runs: string[] = [];
  const open = async (waiting: boolean) => {
    const transport = { handlers: null as any, start() {}, send() {} };
    const device = new Device(dir, 'd1', 'pc', 'secret', transport as any);
    const sink: any[] = [];
    device.add({ info: { id: 'claude-code', kind: 'claude-code', label: 'Claude' }, start: async (s: any) => void sink.push(s), hydrate() {},
      command: async (_t: string, c: any) => { runs.push(c.requestId); if (waiting) sink[0].receipt(c.requestId, 'pending', undefined, 'waiting_for_window'); } } as any);
    await device.start();
    transport.handlers.message({ t: 'welcome' } satisfies HubToDevice);
    return transport;
  };
  const cmd = (requestId: string) => ({ t: 'command', agentId: 'claude-code', threadId: 't', command: { requestId, op: 'send', text: 'x' } }) as HubToDevice;
  let link = await open(true);
  link.handlers.message(cmd('r1'));
  await new Promise((r) => setTimeout(r, 20));
  link.handlers.message(cmd('r1')); // the hub sends it again: this run is still at it
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(runs, ['r1']);
  link = await open(false); // the program restarted: the wait went with it
  link.handlers.message(cmd('r1'));
  await new Promise((r) => setTimeout(r, 20));
  link.handlers.message(cmd('r1'));
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(runs, ['r1', 'r1']);
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
