import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hub } from '../src/hub/hub.ts';
import { fileSha256, takeOver } from '../src/handover.ts';

const listen = (server: Server) => new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as { port: number }).port)));

test('a handover cut off halfway resumes where it broke, is checked whole, and only then ends on the old hub', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'handover-'));
  const zip = join(dir, 'out.zip');
  const data = randomBytes(3 * 1024 * 1024);
  writeFileSync(zip, data);
  const hub = new Hub(join(dir, 'hub'), 'hub-1', 'hub', 'hub.test', 'owner');
  let ended: boolean | null = null;
  (hub as any).handover = { token: 'tok', zip, sha256: await fileSha256(zip), done: (ok: boolean) => (ended = ok) };
  const back = createServer((req, res) => (hub as any).http(req, res));
  const backPort = await listen(back);
  // In between (as Tailscale's proxy is): the first download is cut off after 1 MB, as a hub stepping down too soon did.
  let cuts = 0;
  const front = createServer((req, res) => {
    const up = request({ port: backPort, path: req.url, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode!, r.headers);
      let sent = 0;
      r.on('data', (chunk: Buffer) => {
        sent += chunk.length;
        if (!req.headers.range && cuts === 0 && sent > 1024 * 1024) {
          cuts++;
          res.destroy();
          r.destroy();
          return;
        }
        res.write(chunk);
      });
      r.on('end', () => res.end());
    });
    req.pipe(up);
  });
  const frontPort = await listen(front);
  // Nothing ends the handover while the data is merely on its way.
  assert.equal(ended, null);
  const file = join(dir, 'in.zip');
  await takeOver(`http://127.0.0.1:${frontPort}/api/handover?token=tok`, file, async () => {});
  assert.equal(cuts, 1);
  assert.ok(readFileSync(file).equals(data));
  assert.equal(ended, true); // the new hub said it has it all
  back.close();
  front.close();
});

test('a handover that comes through damaged is downloaded again from the start', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'handover-bad-'));
  const zip = join(dir, 'out.zip');
  const data = randomBytes(256 * 1024);
  writeFileSync(zip, data);
  const hub = new Hub(join(dir, 'hub'), 'hub-1', 'hub', 'hub.test', 'owner');
  (hub as any).handover = { token: 'tok', zip, sha256: await fileSha256(zip), done: () => {} };
  const back = createServer((req, res) => (hub as any).http(req, res));
  const port = await listen(back);
  const file = join(dir, 'in.zip');
  // A leftover of the same size but other bytes: the check catches it and the next go starts from nothing.
  writeFileSync(file, randomBytes(256 * 1024));
  await takeOver(`http://127.0.0.1:${port}/api/handover?token=tok`, file, async () => {});
  assert.ok(readFileSync(file).equals(data));
  back.close();
});
