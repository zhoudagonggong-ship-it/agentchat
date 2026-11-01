// Maps OpenCode 2.x messages to the hub's item kinds. Reasoning and system notices are never reported.
// OpenCode has no turn ids: a turn is everything from one user message until OpenCode goes idle, named after that
// message. Messages sent while it runs join the running turn: OpenCode answers them in the same run, with one idle.
// A command moved to the background keeps the turn going past that idle, until OpenCode is told it ended (a
// "synthetic" message, which resumes it) and goes idle with nothing left in the background.
import type { Item } from '../../shared/protocol.ts';

const OUTPUT_TAIL = 4000;

export interface OutputFile {
  itemId: string;
  turnId: string | null;
  path: string;
}

/** The streamed text of an assistant message and its finished text part share this id. */
export function textItemId(messageId: string, ordinal: number): string {
  return `${messageId}:t${ordinal}`;
}

const TOOLS: Record<string, string> = { shell: 'shell', bash: 'shell', edit: 'edit', write: 'edit', patch: 'edit', apply_patch: 'edit', multiedit: 'edit',
  websearch: 'web', webfetch: 'web' };
const STATUS: Record<string, string> = { pending: 'inProgress', running: 'inProgress', completed: 'completed', error: 'failed', failed: 'failed' };

function tail(text: string): string {
  return text.length > OUTPUT_TAIL ? '…' + text.slice(-OUTPUT_TAIL) : text;
}

function partText(content: unknown): string {
  return Array.isArray(content) ? content.map((c) => (c?.type === 'text' && typeof c.text === 'string' ? c.text : '')).join('') : '';
}

function summary(input: Record<string, unknown> | undefined): string {
  const v = input?.command ?? input?.filePath ?? input?.path ?? input?.pattern ?? input?.query ?? input?.url ?? input?.description;
  return typeof v === 'string' ? v : input ? JSON.stringify(input).slice(0, 200) : '';
}

/**
 * The turn at the end of what was read, and whether it was still running. `waiting`: commands it moved to the
 * background (OpenCode's shell IDs) that have not told it they ended: until they do, the turn is not over, though
 * OpenCode went idle; OpenCode resumes it with a notice when one ends.
 */
export interface Run {
  turn: string;
  start: number;
  running: boolean;
  waiting?: string[];
}

export interface Normalized {
  items: Item[];
  files: OutputFile[];
  /** The turn in progress (or last finished) at the end of these messages. */
  turnId: string | null;
  /** That turn as the next read carries it on. */
  run: Run | null;
  preview: string | null;
}

/**
 * `messages` oldest first; `clientIds` maps OpenCode's id of a message sent from the phone to its request id.
 * `before`: the run the previous read ended in. Only the latest messages are read, and a long run's first message
 * may have dropped out of them: the run goes on under its own name, not under the next message's.
 */
export function normalizeMessages(messages: any[], clientIds: Map<string, string>, before?: Run): Normalized {
  const items: Item[] = [];
  const files: OutputFile[] = [];
  const carried = before && !messages.some((m) => m.id === before.turn) ? before : undefined;
  let turn: string | null = carried?.turn ?? null;
  let turnStart = carried?.start ?? 0;
  let running = carried?.running ?? false;
  const waiting = new Set(carried?.waiting ?? []);
  let preview: string | null = null;
  for (const m of messages) {
    const ts = Number(m.time?.created) || 0;
    switch (m.type) {
      case 'user': {
        // A message while work goes on in the background joins the turn, as one sent while it runs does.
        if (!running && !waiting.size) {
          turn = m.id;
          turnStart = ts;
          running = true;
        }
        const text = typeof m.text === 'string' ? m.text : m.payload?.text ?? '';
        items.push({ itemId: m.id, turnId: turn, kind: 'message', ts, data: { role: 'user', text, clientId: clientIds.get(m.id) ?? null } });
        preview = text || preview;
        break;
      }
      case 'assistant': {
        let ordinal = 0;
        (m.content ?? []).forEach((part: any, i: number) => {
          if (part?.type === 'text') {
            const text = String(part.text ?? '');
            items.push({ itemId: textItemId(m.id, ordinal++), turnId: turn, kind: 'message', ts: ts + i, data: { role: 'assistant', text } });
            if (text.trim()) preview = text;
          } else if (part?.type === 'tool') {
            const status = STATUS[part.state?.status] ?? part.state?.status ?? null;
            const name = String(part.name ?? 'tool');
            const id = String(part.id ?? `${m.id}:${i}`);
            items.push({ itemId: id, turnId: turn, kind: 'tool_call', ts: ts + i, data: { tool: TOOLS[name] ?? name, summary: summary(part.state?.input),
              status, output: tail(partText(part.state?.content)), error: part.state?.error?.message ?? part.state?.error ?? null } });
            // Moved to the background: the turn goes on until OpenCode hears it ended.
            const shellId = part.state?.metadata?.shellID;
            if (part.state?.input?.background && typeof shellId === 'string' && status !== 'failed') waiting.add(shellId);
            // A file the agent wrote is one of its outputs.
            const path = part.state?.input?.filePath;
            if (name === 'write' && status === 'completed' && typeof path === 'string') files.push({ itemId: `file:${id}`, turnId: turn, path });
          }
        });
        break;
      }
      case 'synthetic': {
        // A command in the background ended: OpenCode resumes the turn with its output.
        const shellId = m.metadata?.source === 'shell' ? m.metadata?.shellID : null;
        if (typeof shellId === 'string' && waiting.delete(shellId) && turn) running = true;
        break;
      }
      case 'idle': {
        running = false;
        if (!turn) break;
        const status = m.outcome === 'succeeded' ? 'completed' : m.outcome === 'interrupted' ? 'interrupted' : 'failed';
        // Idle with work still in the background (and not stopped by the owner): still going.
        if (status === 'completed' && waiting.size) {
          items.push({ itemId: `turn:${turn}`, turnId: turn, kind: 'status', ts,
            data: { status: 'inProgress', startedAt: Math.floor(turnStart / 1000), completedAt: null, error: null, background: [...waiting], idleAt: Math.floor(ts / 1000) } });
          break;
        }
        if (status !== 'completed') waiting.clear();
        // Why it failed, as OpenCode says it (a model's quota used up, say): the owner and the sender need to know.
        const error = status === 'failed' ? String(m.error?.message ?? m.error?.data?.message ?? '') || null : null;
        items.push({ itemId: `turn:${turn}`, turnId: turn, kind: 'status', ts,
          data: { status, startedAt: Math.floor(turnStart / 1000), completedAt: Math.floor(ts / 1000), error } });
        break;
      }
      default:
        break; // system notices, model and agent switches, compaction stay on the computer
    }
  }
  return { items, files, turnId: turn, run: turn ? { turn, start: turnStart, running, ...(waiting.size ? { waiting: [...waiting] } : {}) } : null, preview };
}
