import { createHash } from 'node:crypto';

export function log(scope: string, ...parts: unknown[]): void {
  const time = new Date().toISOString().slice(11, 19);
  console.log(`${time} [${scope}]`, ...parts);
}

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function parseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Runs `fn` at most once per `ms`, always ending with a trailing call after the last trigger. */
/**
 * Runs `fn` once calls have stopped for `ms`. `maxWait`: calls that never stop (a file written to all the time) still
 * run it this long after the first of them.
 */
export function debounce(fn: () => void, ms: number, maxWait = Infinity): () => void {
  let timer: NodeJS.Timeout | null = null;
  let first = 0;
  const run = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    first = 0;
    fn();
  };
  return () => {
    if (timer) clearTimeout(timer);
    first ||= Date.now();
    timer = setTimeout(run, Math.max(0, Math.min(ms, first + maxWait - Date.now())));
  };
}
