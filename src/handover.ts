// Taking over the hub's data when this computer becomes the hub: the old hub zips it all and serves the zip once;
// this one downloads it, picking up where a broken connection left off, checks it whole, and only then tells the old
// hub it has it (the old hub steps down after that, not before: what it had written out may still have been on the way).
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, rmSync, statSync } from 'node:fs';
import { log } from './shared/util.ts';

const STALL_MS = 60_000; // no data for this long: the connection is taken for broken
const ATTEMPTS = 5;

/** A file's sha256, read in a stream (the zip runs to hundreds of MB). */
export async function fileSha256(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/**
 * Downloads `url` into `file`, resuming after a break (an HTTP Range from what is already there), up to ATTEMPTS
 * times; checks the size and the sha256 the server names; then tells the server it is done (`&done=1`).
 */
export async function takeOver(url: string, file: string, pause = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<void> {
  let error: Error | null = null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const { sha256 } = await downloadPart(url, file);
      if (sha256 && (await fileSha256(file)) !== sha256) {
        rmSync(file, { force: true }); // not the file it should be: start again from nothing
        throw new Error('the data came through damaged');
      }
      const done = await fetch(`${url}&done=1`);
      if (!done.ok) throw new Error(`the old hub did not take the word that it is done (HTTP ${done.status})`);
      log('handover', `received all ${(statSync(file).size / 1048576).toFixed(1)} MB, checked`);
      return;
    } catch (e) {
      error = e as Error;
      log('handover', `download attempt ${attempt} failed: ${error.message}`);
      if (attempt < ATTEMPTS) await pause(5_000 * attempt);
    }
  }
  throw error ?? new Error('download failed');
}

/** One go at it: from what `file` already holds to the end. */
async function downloadPart(url: string, file: string): Promise<{ sha256: string | null }> {
  const have = existsSync(file) ? statSync(file).size : 0;
  const abort = new AbortController();
  let stall = setTimeout(() => abort.abort(new Error('no data for a minute')), STALL_MS);
  const res = await fetch(url, { signal: abort.signal, headers: have ? { Range: `bytes=${have}-` } : {} });
  if (res.status === 416) return { sha256: res.headers.get('x-sha256') }; // all there already
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const partial = res.status === 206;
  const total = partial ? Number(/\/(\d+)$/.exec(res.headers.get('content-range') ?? '')?.[1] ?? 0) : Number(res.headers.get('content-length')) || 0;
  const out = createWriteStream(file, { flags: partial ? 'a' : 'w' });
  let got = partial ? have : 0;
  let said = Date.now();
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      clearTimeout(stall);
      stall = setTimeout(() => abort.abort(new Error('no data for a minute')), STALL_MS);
      got += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      if (Date.now() - said > 10_000) {
        said = Date.now();
        log('handover', `received ${(got / 1048576).toFixed(1)} of ${(total / 1048576).toFixed(1)} MB`);
      }
    }
  } finally {
    clearTimeout(stall);
    await new Promise((r) => out.end(r));
  }
  if (total && got !== total) throw new Error(`incomplete: ${got} of ${total} bytes`);
  return { sha256: res.headers.get('x-sha256') };
}
