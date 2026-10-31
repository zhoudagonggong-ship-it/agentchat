import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Device, type Adapter, type AdapterSink } from '../src/device/device.ts';
import { sha256 } from '../src/shared/util.ts';
import type { DeviceToHub, HubToDevice } from '../src/shared/protocol.ts';

test('files on this computer linked in a reply go to the hub with it, and the links name them there', async () => {
  const sent: DeviceToHub[] = [];
  const transport = { handlers: null as any, start() {}, send: (m: DeviceToHub) => void sent.push(m) };
  const device = new Device(mkdtempSync(join(tmpdir(), 'dev-')), 'd1', 'pc', 'secret', transport as any);
  let sink!: AdapterSink;
  const adapter: Adapter = { info: { id: 'codex', kind: 'codex', label: 'Codex' }, start: async (s) => void (sink = s), hydrate() {}, command: async () => {} };
  device.add(adapter);
  await device.start();
  transport.handlers.message({ t: 'welcome' } satisfies HubToDevice);
  await new Promise((r) => setTimeout(r, 10));

  const dir = mkdtempSync(join(tmpdir(), 'out-'));
  const shot = join(dir, 'ui final.png').replaceAll('\\', '/');
  writeFileSync(shot, 'png bytes');
  const report = join(dir, '报告.md');
  writeFileSync(report, '# 报告');
  const text = `看图：\n\n![界面](<${shot}>)\n\n[完成报告](${report})；[网页](https://example.com) 和 [缺的](D:/nowhere/x.png) 不动。`;
  const reply = (itemId: string) => ({ itemId, turnId: 't1', kind: 'message' as const, ts: 1, data: { role: 'assistant', text } });
  sink.items('th1', [reply('m1')]);
  sink.items('th1', [reply('m1')]); // reported again: the files go once

  const out = sent.filter((m) => m.t === 'artifact' || m.t === 'items') as any[];
  const files = out.filter((m) => m.t === 'artifact');
  assert.deepEqual(files.map((f) => f.name).sort(), ['ui final.png', '报告.md']);
  assert.ok(out.indexOf(files[0]) < out.findIndex((m) => m.t === 'items'), 'the files go before the reply that shows them');
  const png = sha256(Buffer.from('png bytes'));
  assert.equal(files.find((f) => f.name === 'ui final.png').itemId, `link:${png}`);
  const shown = out.find((m) => m.t === 'items').items[0].data.text as string;
  assert.ok(shown.includes(`![界面](/files/${png})`));
  assert.ok(shown.includes(`[完成报告](/files/${sha256(Buffer.from('# 报告'))})`));
  assert.ok(shown.includes('[网页](https://example.com)') && shown.includes('[缺的](D:/nowhere/x.png)'));
  // The owner's own messages are left as typed.
  sink.items('th1', [{ itemId: 'u1', turnId: 't1', kind: 'message', ts: 2, data: { role: 'user', text: `![x](${shot})` } }]);
  assert.equal((sent.at(-1) as any).items[0].data.text, `![x](${shot})`);
});
