// Maps rows of Goose's own message table (sessions.db, `messages`) to the hub's item kinds.
// Thinking, hidden turn context and other non-visible rows are never reported.
// Goose has no turn ids: a turn runs from one typed message to the next, named after that message.
import type { Item } from '../../shared/protocol.ts';

const OUTPUT_TAIL = 4000;

export interface MessageRow { id: number; message_id: string | null; role: string; content_json: string; created_timestamp: number; metadata_json: string | null }

export interface OutputFile { itemId: string; turnId: string | null; path: string }

/** All text of one assistant message is one item; the streamed text uses the same id. */
export function textItemId(messageId: string): string {
  return `${messageId}:text`;
}

const TOOLS: Record<string, string> = { shell: 'shell', edit: 'edit', write: 'edit', text_editor: 'edit' };

function tail(text: string): string {
  return text.length > OUTPUT_TAIL ? '…' + text.slice(-OUTPUT_TAIL) : text;
}

function parse<T>(raw: string | null): T | null {
  try {
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

/** Whether a row is a message typed to the agent: the start of a turn. */
export function opensTurn(row: MessageRow): boolean {
  if (row.role !== 'user' || parse<{ userVisible?: boolean }>(row.metadata_json)?.userVisible === false) return false;
  const content = parse<any[]>(row.content_json) ?? [];
  return !content.some((c) => c?.type === 'toolResponse') && content.some((c) => c?.type === 'text' && String(c.text ?? ''));
}

export interface Normalized {
  items: Item[];
  files: OutputFile[];
  turnId: string | null;
  preview: string | null;
  /** Whether the latest turn still waits for the agent (a typed message or tool result with nothing after it). */
  open: boolean;
}

/**
 * `rows` oldest first. `outcomes` holds how turns run from the phone ended (Goose does not record a stop);
 * other finished turns count as completed.
 */
export function normalizeRows(rows: MessageRow[], outcomes: Map<string, string>): Normalized {
  const items: Item[] = [];
  const files: OutputFile[] = [];
  const tools = new Map<string, Item>();
  let turn: string | null = null;
  let turnStart = 0;
  let lastTs = 0;
  let preview: string | null = null;
  let open = false;
  const ts = (seconds: number) => (lastTs = Math.max(lastTs + 1, seconds * 1000));
  const close = (endSeconds: number) => {
    if (!turn) return;
    items.push({ itemId: `turn:${turn}`, turnId: turn, kind: 'status', ts: ts(endSeconds),
      data: { status: outcomes.get(turn) ?? 'completed', startedAt: turnStart, completedAt: endSeconds, error: null } });
  };
  let lastSeconds = 0;
  for (const row of rows) {
    const meta = parse<{ userVisible?: boolean }>(row.metadata_json) ?? {};
    const content = parse<any[]>(row.content_json) ?? [];
    const id = row.message_id ?? `row:${row.id}`;
    const seconds = Number(row.created_timestamp) || 0;
    if (meta.userVisible === false) continue; // turn context and other agent-only rows
    if (row.role === 'user') {
      const text = content.filter((c) => c?.type === 'text').map((c) => String(c.text ?? '')).join('\n');
      const results = content.filter((c) => c?.type === 'toolResponse');
      for (const r of results) {
        const tool = tools.get(String(r.id));
        if (!tool) continue;
        const value = r.toolResult?.value;
        const failed = r.toolResult?.status !== 'success' || value?.isError === true;
        const output = Array.isArray(value?.content) ? value.content.map((c: any) => (c?.type === 'text' ? c.text : '')).join('') : '';
        tool.data = { ...tool.data, status: failed ? 'failed' : 'completed', output: tail(output),
          error: failed ? String(r.toolResult?.error ?? '').slice(0, 300) || null : null };
        // Goose's own record of a stop: the tool was cut off and the turn ends there.
        if (failed && turn && /interrupted before completing/i.test(output) && !outcomes.has(turn)) outcomes.set(turn, 'interrupted');
        if (!failed && tool.data.tool === 'edit' && tool.data.created && typeof tool.data.summary === 'string') {
          files.push({ itemId: `file:${tool.itemId}`, turnId: tool.turnId, path: tool.data.summary });
        }
      }
      if (results.length) {
        open = true; // the agent continues after a tool result
        continue;
      }
      if (!text) continue;
      close(lastSeconds);
      turn = id;
      turnStart = seconds;
      open = true;
      items.push({ itemId: id, turnId: turn, kind: 'message', ts: ts(seconds), data: { role: 'user', text, clientId: null } });
      preview = text;
    } else if (row.role === 'assistant') {
      const text = content.filter((c) => c?.type === 'text').map((c) => String(c.text ?? '')).join('');
      if (text.trim()) {
        items.push({ itemId: textItemId(id), turnId: turn, kind: 'message', ts: ts(seconds), data: { role: 'assistant', text } });
        preview = text;
      }
      let calls = 0;
      for (const c of content) {
        if (c?.type !== 'toolRequest') continue;
        calls++;
        const call = c.toolCall?.value ?? {};
        const name = String(call.name ?? 'tool').split('__').pop()!;
        const args = call.arguments ?? {};
        const summary = args.command ?? args.path ?? args.file_path ?? args.query ?? JSON.stringify(args).slice(0, 200);
        const item: Item = { itemId: String(c.id), turnId: turn, kind: 'tool_call', ts: ts(seconds), data: { tool: TOOLS[name] ?? name,
          summary: String(summary), status: 'inProgress', output: '', error: null, created: name === 'write' } };
        tools.set(item.itemId, item);
        items.push(item);
      }
      open = calls > 0;
    }
    lastSeconds = seconds;
  }
  // A turn run from the phone has ended when its run ended, even if Goose stopped it mid-tool.
  if (turn && outcomes.has(turn)) open = false;
  if (!open) close(lastSeconds);
  for (const t of tools.values()) delete t.data.created;
  return { items, files, turnId: turn, preview, open };
}
