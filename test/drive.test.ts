import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Drive, drivePath, parsePropfind } from '../src/hub/drive.ts';

const multistatus = (entries: [string, boolean, number?][]) => `<?xml version="1.0" encoding="UTF-8"?><D:multistatus xmlns:D="DAV:">${entries.map(([href, dir, size]) =>
  `<D:response><D:href>${href}</D:href><D:propstat><D:prop><D:displayname></D:displayname>${dir ? '<D:resourcetype><D:collection xmlns:D="DAV:"/></D:resourcetype>'
    : `<D:resourcetype></D:resourcetype><D:getcontentlength>${size}</D:getcontentlength>`}<D:getlastmodified>Thu, 29 Oct 2026 10:00:00 GMT</D:getlastmodified></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`).join('')}</D:multistatus>`;

test('a WebDAV folder listing becomes entries, folders first, the folder itself left out', () => {
  const xml = multistatus([['/n/pc/agentchat/', true], ['/n/pc/agentchat/%E4%BA%A4%E4%BB%98/', true], ['/n/pc/agentchat/b.png', false, 12], ['/n/pc/agentchat/a.md', false, 3]]);
  const entries = parsePropfind(xml, '/n/pc/agentchat/');
  assert.deepEqual(entries.map((e) => [e.name, e.dir, e.size]), [['交付', true, 0], ['a.md', false, 3], ['b.png', false, 12]]);
  assert.equal(entries[2]!.mime, 'image/png');
  assert.equal(entries[1]!.mtime, Date.parse('2026-10-29T10:00:00Z'));
});

test('paths from the page cannot leave the drive', () => {
  assert.deepEqual(drivePath('/交付//v1/./a.zip'), ['交付', 'v1', 'a.zip']);
  assert.deepEqual(drivePath(''), []);
  assert.equal(drivePath('/a/../../secret'), null);
  assert.equal(drivePath('/a\\b'), null);
});

test('the drive is found on whichever computer shares it, and listed', async () => {
  const tree: Record<string, [string, boolean, number?][]> = {
    '/': [['/', true], ['/example.ts.net/', true]],
    '/example.ts.net/': [['/example.ts.net/', true], ['/example.ts.net/laptop/', true], ['/example.ts.net/server/', true]],
    '/example.ts.net/laptop/': [['/example.ts.net/laptop/', true], ['/example.ts.net/laptop/photos/', true]],
    '/example.ts.net/server/': [['/example.ts.net/server/', true], ['/example.ts.net/server/agentchat/', true]],
    '/example.ts.net/server/agentchat/': [['/example.ts.net/server/agentchat/', true], ['/example.ts.net/server/agentchat/report.md', false, 5]],
  };
  const server = createServer((req, res) => {
    const entries = tree[decodeURIComponent(req.url ?? '')];
    if (req.method !== 'PROPFIND' || !entries) return void res.writeHead(404).end();
    res.writeHead(207, { 'Content-Type': 'application/xml' }).end(multistatus(entries));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const drive = new Drive(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, async () => null);
    const got = await drive.list([]);
    assert.equal(got.computer, 'server');
    assert.deepEqual(got.entries.map((e) => e.name), ['report.md']);
    await assert.rejects(drive.list(['missing']), /不存在/);
  } finally {
    server.close();
  }
});

test('on the computer sharing it, the drive is its own folder: list, add, read, remove, and a missing drive says so', async () => {
  const root = mkdtempSync(join(tmpdir(), 'drive-'));
  const drive = new Drive('http://127.0.0.1:9', async () => ({ computer: 'server', root }));
  const server = createServer((req, res) => {
    if (!drive.handle(req, new URL(req.url ?? '/', 'http://x'), res)) res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/drive`;
  const q = (p: string) => `?path=${encodeURIComponent(p)}`;
  try {
    assert.equal((await fetch(`${base}/mkdir${q('/交付')}`, { method: 'POST' })).status, 200);
    assert.equal((await fetch(`${base}/mkdir${q('/交付')}`, { method: 'POST' })).status, 409);
    assert.equal((await fetch(`${base}/file${q('/交付/说明.md')}`, { method: 'PUT', body: '# 好' })).status, 200);
    const listed = await (await fetch(`${base}/list${q('/交付')}`)).json();
    assert.deepEqual(listed.entries.map((e: any) => [e.name, e.size, e.mime]), [['说明.md', 5, 'text/markdown; charset=utf-8']]);
    assert.equal(await (await fetch(`${base}/file${q('/交付/说明.md')}`)).text(), '# 好');
    assert.equal((await fetch(`${base}/file${q('/交付/没有.md')}`)).status, 404);
    assert.equal((await fetch(`${base}/list${q('/没有')}`)).status, 404);
    assert.equal((await fetch(`${base}/file${q('/交付')}`, { method: 'DELETE' })).status, 200);
    assert.equal(readdirSync(root).length, 0);
  } finally {
    server.close();
  }
  const none = new Drive('http://127.0.0.1:9', async () => null);
  await assert.rejects(none.list([]), /还没有网盘/);
});
