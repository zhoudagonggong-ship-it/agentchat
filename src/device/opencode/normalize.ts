// Maps OpenCode 2.x messages to the hub's item kinds. Reasoning and system notices are never reported.
// OpenCode has no turn ids: a turn is everything from one user message to the next, named after that message.
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

export interface Normalized {
  items: Item[];
  files: OutputFile[];
  /** The turn in progress (or last finished) at the end of these messages. */
  turnId: string | null;
  preview: string | null;
}

/** `messages` oldest first; `clientIds` maps OpenCode's id of a message sent from the phone to its request id. */
export function normalizeMessages(messages: any[], clientIds: Map<string, string>): Normalized {
  const items: Item[] = [];
  const files: OutputFile[] = [];
  let turn: string | null = null;
  let turnStart = 0;
  let preview: string | null = null;
  for (const m of messages) {
    const ts = Number(m.time?.created) || 0;
    switch (m.type) {
      case 'user': {
        turn = m.id;
        turnStart = ts;
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
            // A file the agent wrote is one of its outputs.
            const path = part.state?.input?.filePath;
            if (name === 'write' && status === 'completed' && typeof path === 'string') files.push({ itemId: `file:${id}`, turnId: turn, path });
          }
        });
        break;
      }
      case 'idle':
        if (turn) {
          const status = m.outcome === 'succeeded' ? 'completed' : m.outcome === 'interrupted' ? 'interrupted' : 'failed';
          // Why it failed, as OpenCode says it (a model's quota used up, say): the owner and the sender need to know.
          const error = status === 'failed' ? String(m.error?.message ?? m.error?.data?.message ?? '') || null : null;
          items.push({ itemId: `turn:${turn}`, turnId: turn, kind: 'status', ts,
            data: { status, startedAt: Math.floor(turnStart / 1000), completedAt: Math.floor(ts / 1000), error } });
        }
        break;
      default:
        break; // system notices, model and agent switches, compaction stay on the computer
    }
  }
  return { items, files, turnId: turn, preview };
}
