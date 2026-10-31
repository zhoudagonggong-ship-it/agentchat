import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Device, type Adapter } from '../src/device/device.ts';
import { sha256 } from '../src/shared/util.ts';
import { withAttachments, type Command, type DeviceToHub, type HubToDevice } from '../src/shared/protocol.ts';

test('a new conversation started with its first message gets that message’s files in the inbox, named by path', async () => {
  const sent: DeviceToHub[] = [];
  const transport = { handlers: null as any, start() {}, send: (m: DeviceToHub) => void sent.push(m) };
  const dir = mkdtempSync(join(tmpdir(), 'dev-'));
  const device = new Device(dir, 'd1', 'pc', 'secret', transport as any);
  let typed = '';
  const goose: Adapter = { info: { id: 'goose', kind: 'goose', label: 'Goose' }, start: async () => {}, hydrate() {}, command: async () => {},
    create: async (_cwd, _title, first?: Command) => {
      typed = withAttachments(first!.text!, first!.files ?? []);
      return { threadId: 't-new', sent: true };
    } };
  device.add(goose);
  await device.start();
  transport.handlers.message({ t: 'welcome' } satisfies HubToDevice);

  const bytes = Buffer.from('# 任务书');
  const file = { name: '任务书-v1.md', size: bytes.length, sha256: sha256(bytes), mime: 'text/markdown' };
  transport.handlers.message({ t: 'create', id: 7, agentId: 'goose', cwd: '', title: '提取', data: [bytes.toString('base64')],
    first: { requestId: 'r1', op: 'send', text: '请按附件做', files: [file] } } satisfies HubToDevice);
  for (let i = 0; i < 50 && !sent.some((m) => m.t === 'created'); i++) await new Promise((r) => setTimeout(r, 10));

  const saved = join(dir, 'inbox', file.sha256, file.name);
  assert.ok(existsSync(saved), 'the file is in the inbox');
  assert.equal(readFileSync(saved, 'utf8'), '# 任务书');
  assert.match(typed, new RegExp(`任务书-v1\\.md：${saved.replace(/\\/g, '\\\\')}`), 'the message names the saved path, not the name twice');
  assert.deepEqual(sent.find((m) => m.t === 'created'), { t: 'created', id: 7, threadId: 't-new', sent: true });
});
