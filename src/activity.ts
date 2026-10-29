// A short, human-readable feed of what this machine is doing, shown in the local control window.
export interface Activity {
  at: number;
  text: string;
  level: 'info' | 'warn';
}

const LIMIT = 100;
const feed: Activity[] = [];
const listeners = new Set<(a: Activity) => void>();

export function activity(text: string, level: Activity['level'] = 'info'): void {
  const entry = { at: Date.now(), text, level };
  feed.push(entry);
  if (feed.length > LIMIT) feed.shift();
  for (const fn of listeners) fn(entry);
}

export function recentActivity(): Activity[] {
  return feed.slice().reverse();
}

export function onActivity(fn: (a: Activity) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
