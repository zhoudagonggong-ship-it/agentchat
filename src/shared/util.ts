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
export function debounce(fn: () => void, ms: number): () => void {
  let timer: NodeJS.Timeout | null = null;
  return () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn();
    }, ms);
  };
}
