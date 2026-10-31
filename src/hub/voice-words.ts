// What the speech recognizer is told before it listens, so it gets the owner's own words right (English names in
// Chinese speech above all): a list of words, as Qwen3-ASR takes its context ("Vocabulary: ..."), never sentences,
// which it reads back when it hears little. The words: ones the owner corrected after an earlier recognition, the
// names in the conversation being typed into, the names of computers and agents, and words the owner uses here.
import type { Store } from './store.ts';

/** Names the owner says all the time and a Chinese recognizer gets wrong. */
const FIXED = ['老周', 'Claude', 'Claude Code', 'Codex', 'DeepSeek', 'OpenCode', 'Goose', 'DSH', 'AgentChat', 'AllinOne',
  'Tailscale', '向日葵', 'SenseVoice', 'Qwen', 'GitHub', 'PowerShell', 'Python'];
/** English words that say nothing about the owner's work. */
const COMMON = new Set(('the and for with this that from are was were not but you your our can will has have had its into then than '
  + 'http https www com org net html json txt md png jpg exe dll cmd ps1 ts js py zip log tmp users appdata local roaming program files windows '
  + 'true false null none error ok yes no new old one two all any get set run use see let').split(' '));
const MINE_EVERY_MS = 10 * 60_000;
const WORDS_MAX = 80;
const LEARNED_MAX = 200;
const PASTE_MATCH_MS = 10 * 60_000; // a message sent this long after a paste may be the pasted text, corrected

type Learned = Record<string, { n: number; at: number }>;

export class VoiceWords {
  private mined: string[] = [];
  private minedAt = 0;
  /** The last text pasted on each computer, to compare with what the owner then sends. */
  private pastes = new Map<string, { text: string; at: number }>();

  private store: Store;
  /** The names of the member computers and their agents. */
  private names: () => string[];

  constructor(store: Store, names: () => string[]) {
    this.store = store;
    this.names = names;
  }

  /** The context for a recognition of speech for `target`. */
  context(target: string): string {
    const words = unique([...this.learned(), ...this.current(target), ...FIXED, ...this.names(), ...this.minedWords()]).slice(0, WORDS_MAX);
    return `热词：${words.join(', ')}`;
  }

  /** Recognized text was pasted on `device`. */
  pasted(device: string, text: string): void {
    this.pastes.set(device, { text, at: Date.now() });
  }

  /** The owner sent a message in a conversation on `device`: what it changed in a recent paste is learned. */
  sent(device: string, text: string): void {
    const paste = this.pastes.get(device);
    if (!paste || Date.now() - paste.at > PASTE_MATCH_MS) return;
    const heard = paste.text.slice(0, 400);
    const said = text.trim().slice(0, 400);
    if (!said || said === heard) {
      if (said === heard) this.pastes.delete(device);
      return;
    }
    const { kept, added } = diff(heard, said);
    // Another message, not the pasted one corrected (an English name heard as Chinese replaces a good part of it).
    if (kept < 4 || kept < heard.length * 0.5) return;
    this.pastes.delete(device);
    const words = added.map((s) => s.replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, '')).filter((s) => s.length >= 2 && s.length <= 16 && /[\p{L}\p{N}]/u.test(s));
    if (!words.length) return;
    const learned = this.learnedTable();
    for (const w of words) learned[w] = { n: (learned[w]?.n ?? 0) + 1, at: Date.now() };
    const kept2 = Object.entries(learned).sort((a, b) => b[1].at - a[1].at).slice(0, LEARNED_MAX);
    this.store.setSetting('voiceLearned', JSON.stringify(Object.fromEntries(kept2)));
  }

  /** Corrected words, the most used first. */
  private learned(): string[] {
    return Object.entries(this.learnedTable()).sort((a, b) => b[1].n - a[1].n || b[1].at - a[1].at).map(([w]) => w);
  }

  private learnedTable(): Learned {
    try {
      return JSON.parse(this.store.setting('voiceLearned') || '{}') as Learned;
    } catch {
      return {};
    }
  }

  /** English words the owner's conversations use often (titles and the owner's messages, recent ones weigh more). */
  private minedWords(): string[] {
    if (Date.now() - this.minedAt < MINE_EVERY_MS) return this.mined;
    this.minedAt = Date.now();
    const texts = [
      ...(this.store.db.prepare('SELECT title AS t FROM sessions WHERE archived = 0 ORDER BY updated_at DESC LIMIT 200').all() as { t: string }[]),
      ...(this.store.db.prepare("SELECT json_extract(data, '$.text') AS t FROM items WHERE kind = 'message' AND json_extract(data, '$.role') = 'user' ORDER BY ts DESC LIMIT 600")
        .all() as { t: string | null }[]),
    ];
    const score = new Map<string, { n: number; w: number; form: string }>();
    texts.forEach((r, i) => {
      for (const word of englishWords(String(r.t ?? ''))) {
        const key = word.toLowerCase();
        const s = score.get(key) ?? { n: 0, w: 0, form: word };
        s.n += 1;
        s.w += 1 / (1 + i / 100);
        score.set(key, s);
      }
    });
    this.mined = [...score.values()].filter((s) => s.n >= 2).sort((a, b) => b.w - a.w).slice(0, 80).map((s) => s.form);
    return this.mined;
  }

  /** The names in the conversation most lately busy on that computer (its title and last messages), if within the hour. */
  private current(target: string): string[] {
    const s = this.store.db.prepare('SELECT id, title, updated_at FROM sessions WHERE device_id = ? AND archived = 0 ORDER BY updated_at DESC LIMIT 1')
      .get(target) as { id: string; title: string; updated_at: number } | undefined;
    if (!s) return [];
    const at = s.updated_at > 1e12 ? s.updated_at : s.updated_at * 1000;
    if (Date.now() - at > 3600_000) return [];
    const lines = (this.store.db.prepare("SELECT json_extract(data, '$.text') AS t FROM items WHERE session_id = ? AND kind = 'message' ORDER BY ts DESC LIMIT 4")
      .all(s.id) as { t: string | null }[]).map((r) => String(r.t ?? ''));
    return englishWords([s.title, ...lines].join('\n')).slice(0, 20);
  }
}

/** The English (and mixed) words in a text, the owner's names for things: no web addresses, paths or plain English. */
function englishWords(text: string): string[] {
  const clean = text.replace(/https?:\/\/\S+/g, ' ').replace(/[A-Za-z]:\\\S+/g, ' ');
  return [...clean.matchAll(/[A-Za-z][A-Za-z0-9]*(?:[._+-][A-Za-z0-9]+)*/g)].map((m) => m[0])
    .filter((w) => w.length >= 3 && w.length <= 30 && !COMMON.has(w.toLowerCase()));
}

function unique(list: string[]): string[] {
  const seen = new Set<string>();
  return list.filter((w) => {
    const k = w.toLowerCase();
    if (!w || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** How much of `a` survives in `b` (characters in order), and the runs of `b` that are new. */
export function diff(a: string, b: string): { kept: number; added: string[] } {
  const n = a.length, m = b.length;
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const added: string[] = [];
  let run = '';
  let i = 0, j = 0;
  while (j < m) {
    if (i < n && a[i] === b[j]) {
      if (run) added.push(run), (run = '');
      i++, j++;
    } else if (i < n && dp[i + 1][j] >= dp[i][j + 1]) i++;
    else run += b[j++];
  }
  if (run) added.push(run);
  return { kept: dp[0][0], added };
}
