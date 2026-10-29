// Maps DeepSeek Harness session events (session.v4.jsonl, one JSON event per line) to the hub's item kinds.
// What DSH puts into the conversation on its own (reminders, runtime context, skills), the model's reasoning and
// the requests it sends are never reported: only what the owner typed, what the agent answered, the tools it ran,
// its approvals and the files it handed over.
import type { Item } from '../../shared/protocol.ts';

const OUTPUT_TAIL = 4000;

export interface DshEvent { type: string; seq?: number; time?: number; data?: any }

export interface OutputFile { itemId: string; turnId: string | null; path: string }

export interface Normalized {
  items: Item[];
  files: OutputFile[];
  /** The latest turn, and whether it is still running (started, not ended). */
  turnId: string | null;
  running: boolean;
  preview: string | null;
}

const TOOLS: Record<string, string> = { pwsh: 'shell', bash: 'shell', shell: 'shell', edit: 'edit', write: 'edit', multi_edit: 'edit', web_fetch: 'web', web_search: 'web' };

function tail(text: string): string {
  return text.length > OUTPUT_TAIL ? '…' + text.slice(-OUTPUT_TAIL) : text;
}

function texts(content: unknown): string {
  return Array.isArray(content) ? content.filter((c) => c?.type === 'text').map((c) => String(c.text ?? '')).join('') : '';
}

function args(raw: unknown): Record<string, any> {
  if (raw && typeof raw === 'object') return raw as Record<string, any>;
  try {
    return JSON.parse(String(raw ?? '{}'));
  } catch {
    return {};
  }
}

const turnOf = (n: number) => `turn:${n}`;

/** `events` oldest first, possibly only the latest part of the conversation. */
export function normalizeEvents(events: DshEvent[]): Normalized {
  const items: Item[] = [];
  const files: OutputFile[] = [];
  const tools = new Map<string, Item>();
  const approvals = new Map<string, Item>();
  let turn: string | null = null;
  let turnStartedAt = 0;
  let running = false;
  let preview: string | null = null;
  for (const e of events) {
    const d = e.data ?? {};
    const ts = Number(e.time) || 0;
    switch (e.type) {
      case 'turn/start':
        turn = turnOf(Number(d.turn));
        turnStartedAt = ts;
        running = true;
        break;
      case 'turn/end': {
        const t = turnOf(Number(d.turn));
        const kind = String(d.reason?.kind ?? 'completed');
        const status = kind === 'completed' ? 'completed' : /cancel|interrupt|abort|stop/i.test(kind) ? 'interrupted' : 'failed';
        items.push({ itemId: t, turnId: t, kind: 'status', ts,
          data: { status, startedAt: Math.floor(turnStartedAt / 1000), completedAt: Math.floor(ts / 1000), error: status === 'failed' ? String(d.reason?.message ?? kind).slice(0, 300) : null } });
        if (t === turn) running = false;
        break;
      }
      case 'user/message': {
        // Only what was typed: DSH adds its own context as user messages too, marked by their source.
        if (d.source?.kind !== 'user') break;
        const text = texts(d.content).trim();
        if (!text) break;
        items.push({ itemId: String(d.id ?? `seq:${e.seq}`), turnId: turn, kind: 'message', ts, data: { role: 'user', text, clientId: null } });
        preview = text;
        break;
      }
      case 'assistant/message': {
        const content: any[] = d.message?.content ?? [];
        const text = content.filter((c) => c?.type === 'text').map((c) => String(c.text ?? '')).join('').trim();
        if (text) {
          items.push({ itemId: `seq:${e.seq}:text`, turnId: d.turn !== undefined ? turnOf(Number(d.turn)) : turn, kind: 'message', ts, data: { role: 'assistant', text } });
          preview = text;
        }
        break;
      }
      case 'tool/call': {
        const name = String(d.name ?? 'tool');
        const a = args(d.arguments);
        const summary = a.command ?? a.file_path ?? a.path ?? a.pattern ?? a.url ?? a.query ?? JSON.stringify(a).slice(0, 200);
        const item: Item = { itemId: String(d.callId ?? `seq:${e.seq}`), turnId: d.turn !== undefined ? turnOf(Number(d.turn)) : turn, kind: 'tool_call', ts,
          data: { tool: TOOLS[name] ?? name, summary: String(summary), status: 'inProgress', output: '', error: null } };
        tools.set(item.itemId, item);
        items.push(item);
        break;
      }
      case 'tool/result': {
        const m = d.message ?? {};
        const tool = tools.get(String(m.toolCallId ?? m.source?.callId ?? ''));
        if (!tool) break;
        const output = texts(m.content);
        const failed = m.isError === true || /^Error:/.test(output);
        tool.data = { ...tool.data, status: failed ? 'failed' : 'completed', output: tail(output), error: failed ? output.slice(0, 300) : null };
        break;
      }
      case 'approval/asked': {
        const item: Item = { itemId: `approval:${d.id}`, turnId: turn, kind: 'approval_request', ts,
          data: { approvalId: String(d.id), kind: /write|edit/i.test(String(d.toolName ?? '')) ? 'file' : 'command', command: String(d.toolName ?? ''),
            cwd: null, reason: d.reason ? String(d.reason) : null, state: 'pending', onComputer: true } };
        approvals.set(String(d.id), item);
        items.push(item);
        break;
      }
      case 'approval/decided': {
        const item = approvals.get(String(d.id));
        if (item) item.data = { ...item.data, state: /allow|accept|approve/i.test(String(d.outcome ?? '')) ? 'accepted' : 'declined' };
        break;
      }
      case 'deliverables/presented':
        for (const f of d.files ?? []) if (f?.path) files.push({ itemId: `file:${e.seq}:${f.path}`, turnId: d.turn !== undefined ? turnOf(Number(d.turn)) : turn, path: String(f.path) });
        break;
    }
  }
  return { items, files, turnId: turn, running, preview };
}
