// Reads a DeepSeek Harness conversation file (session.v4.jsonl.zstd): zstd frames appended one after another, each
// holding whole JSON lines. Conversations grow to tens of megabytes, so only what is needed is decompressed: the
// frames added since the last look, or the latest ones. Read-only.
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import type { DshEvent } from './normalize.ts';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function readRange(file: string, from: number, to: number): Buffer {
  const buf = Buffer.alloc(Math.max(0, to - from));
  const fd = openSync(file, 'r');
  try {
    readSync(fd, buf, 0, buf.length, from);
  } finally {
    closeSync(fd);
  }
  return buf;
}

/**
 * Decompresses the frames in `buf` (it starts at a frame). The magic number can also turn up inside compressed
 * data: a piece that does not decompress on its own is joined to the next one. Returns the JSON lines, and how
 * many bytes held whole frames (a frame still being written at the end is left for next time).
 */
function frames(buf: Buffer): { lines: string[]; used: number } {
  const starts: number[] = [];
  for (let i = buf.indexOf(MAGIC); i >= 0; i = buf.indexOf(MAGIC, i + 1)) starts.push(i);
  const lines: string[] = [];
  let used = 0;
  let from = 0;
  for (let n = 1; from < starts.length && n <= starts.length; n++) {
    const end = n < starts.length ? starts[n]! : buf.length;
    try {
      const text = zstdDecompressSync(buf.subarray(starts[from]!, end)).toString('utf8');
      for (const line of text.split('\n')) if (line.trim()) lines.push(line);
      used = end;
      from = n;
    } catch {
      // Not a whole frame yet: take the next piece with it. A start that never makes a frame with the pieces after
      // it was the magic number inside compressed data (reading from the middle of the file): try the next start.
      if (n - from >= 8 && n < starts.length) {
        from++;
        n = from;
      }
    }
  }
  return { lines, used };
}

function parse(lines: string[]): DshEvent[] {
  const out: DshEvent[] = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line));
    } catch {
      // a broken line: skipped
    }
  }
  return out;
}

/** The events written since `offset` (a frame start, 0 for the beginning), and the offset to continue from. */
export function readFrom(file: string, offset: number): { events: DshEvent[]; offset: number } {
  const size = statSync(file).size;
  if (size <= offset) return { events: [], offset: size < offset ? 0 : offset };
  const buf = readRange(file, offset, size);
  const first = buf.indexOf(MAGIC);
  if (first < 0) return { events: [], offset };
  const { lines, used } = frames(buf.subarray(first));
  return { events: parse(lines), offset: offset + first + used };
}

/**
 * The latest events, at least `want` of them when the conversation has that many: read from the end in growing
 * chunks. Also returns the file size reached, to continue from with `readFrom`.
 */
export function readLatest(file: string, want: number): { events: DshEvent[]; offset: number } {
  const size = statSync(file).size;
  for (let chunk = 256 * 1024; ; chunk *= 4) {
    const from = Math.max(0, size - chunk);
    const buf = readRange(file, from, size);
    const first = buf.indexOf(MAGIC);
    if (first < 0) return { events: [], offset: size };
    const { lines, used } = frames(buf.subarray(first));
    const events = parse(lines);
    if (events.length >= want || from === 0) return { events, offset: from + first + used };
  }
}

/** The first event: the conversation's own header (id, folder, whether it is a sub-agent's). */
export function readHeader(file: string): DshEvent & { id?: string; cwd?: string; delegationDepth?: number } | null {
  const buf = readRange(file, 0, Math.min(statSync(file).size, 64 * 1024));
  const { lines } = frames(buf);
  return lines.length ? (parse([lines[0]!])[0] ?? null) as any : null;
}
