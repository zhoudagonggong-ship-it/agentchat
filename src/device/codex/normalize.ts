// Maps Codex turns and items to the hub's item kinds. Reasoning is never reported.
import type { Item } from '../../shared/protocol.ts';

const OUTPUT_TAIL = 4000;

export interface OutputFile {
  itemId: string;
  turnId: string;
  path: string;
}

function tail(text: unknown): string {
  const s = typeof text === 'string' ? text : '';
  return s.length > OUTPUT_TAIL ? '…' + s.slice(-OUTPUT_TAIL) : s;
}

function userText(content: any[]): string {
  return (content ?? []).map((c) => (c?.type === 'text' ? c.text : c?.type === 'image' || c?.type === 'localImage' ? '[图片]' : '')).filter(Boolean).join('\n');
}

/** Converts one turn. `files` collects outputs (new files, generated images) to upload. */
export function normalizeTurn(turn: any, files: OutputFile[]): Item[] {
  const items: Item[] = [];
  const base = (turn.startedAt ?? 0) * 1000;
  let order = 0;
  const push = (itemId: string, kind: Item['kind'], data: Record<string, unknown>) =>
    items.push({ itemId, turnId: turn.id, kind, ts: base + order++, data });

  for (const item of turn.items ?? []) {
    switch (item.type) {
      case 'userMessage':
        push(item.id, 'message', { role: 'user', text: userText(item.content), clientId: item.clientId ?? null });
        break;
      case 'agentMessage':
        push(item.id, 'message', { role: 'assistant', text: item.text ?? '', phase: item.phase ?? null });
        break;
      case 'commandExecution':
        push(item.id, 'tool_call', { tool: 'shell', summary: item.command ?? '', status: item.status, exitCode: item.exitCode ?? null,
          cwd: item.cwd ?? null, output: tail(item.aggregatedOutput) });
        break;
      case 'fileChange': {
        const changes = (item.changes ?? []) as { path: string; kind: { type: string } }[];
        push(item.id, 'tool_call', { tool: 'edit', summary: changes.map((c) => c.path).join('\n'), status: item.status,
          changes: changes.map((c) => ({ path: c.path, kind: c.kind?.type ?? 'update' })) });
        if (item.status === 'completed') {
          for (const c of changes) if (c.kind?.type === 'add') files.push({ itemId: `file:${item.id}:${c.path}`, turnId: turn.id, path: c.path });
        }
        break;
      }
      case 'mcpToolCall':
        push(item.id, 'tool_call', { tool: `${item.server}/${item.tool}`, summary: item.tool ?? '', status: item.status, error: item.error ?? null });
        break;
      case 'dynamicToolCall':
      case 'collabAgentToolCall':
        push(item.id, 'tool_call', { tool: item.type, summary: item.tool ?? item.name ?? '', status: item.status ?? null });
        break;
      case 'webSearch':
        push(item.id, 'tool_call', { tool: 'web', summary: item.query ?? '', status: 'completed' });
        break;
      case 'imageGeneration':
        push(item.id, 'tool_call', { tool: 'image', summary: item.revisedPrompt ?? '', status: item.status ?? null });
        if (item.savedPath && item.status !== 'failed') files.push({ itemId: `file:${item.id}`, turnId: turn.id, path: item.savedPath });
        break;
      default:
        break; // reasoning, plan, sleep, compaction and other internal items stay on the computer
    }
  }
  items.push({ itemId: `turn:${turn.id}`, turnId: turn.id, kind: 'status', ts: base + order,
    data: { status: turn.status, startedAt: turn.startedAt ?? null, completedAt: turn.completedAt ?? null, error: turn.error?.message ?? null } });
  return items;
}
