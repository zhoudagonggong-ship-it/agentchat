// Reads a Claude Code transcript (~/.claude/projects/<folder>/<session>.jsonl) into the hub's item kinds.
// Reading is incremental: only bytes appended since the last read are parsed. Thinking is never reported.
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import type { Item } from '../../shared/protocol.ts';

const OUTPUT_TAIL = 4000;
const TAIL_BYTES = 512 * 1024;

export interface TurnState {
  turnId: string;
  startedAt: number; // ms
  status: 'inProgress' | 'completed' | 'interrupted';
}

function tail(text: unknown): string {
  const s = typeof text === 'string' ? text : Array.isArray(text) ? text.map((c: any) => (typeof c === 'string' ? c : c?.text ?? '')).join('\n') : '';
  return s.length > OUTPUT_TAIL ? '…' + s.slice(-OUTPUT_TAIL) : s;
}

// What the desktop app puts before a prompt for the model (the page the owner has open beside the chat, reminders):
// not what was typed or sent, and in the way of matching a message to the request that sent it.
const CONTEXT = /^\s*(?:<(artifact-view-context|system-reminder)\b[^>]*>[\s\S]*?<\/\1>|<artifact-content-authored-by-others\/>)/;

export function withoutContext(text: string): string {
  let rest = text.replace(/^﻿/, '');
  for (let m = CONTEXT.exec(rest); m; m = CONTEXT.exec(rest)) rest = rest.slice(m[0].length);
  return rest.replace(/^\s+/, '');
}

function userText(content: unknown): string | null {
  if (typeof content === 'string') return withoutContext(content) || null;
  if (!Array.isArray(content)) return null;
  const parts = content.map((c: any) => (c?.type === 'text' ? withoutContext(c.text) : c?.type === 'image' ? '[图片]' : null))
    .filter((x): x is string => x !== null && x !== '');
  return parts.length ? parts.join('\n') : null;
}

/** One-line summary of a tool call for the collapsed log. */
function toolSummary(name: string, input: any): string {
  if (!input || typeof input !== 'object') return '';
  return String(input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.query ?? input.description ?? input.prompt ?? '').slice(0, 500);
}

const TOOL_KIND: Record<string, string> = { Bash: 'shell', PowerShell: 'shell', Edit: 'edit', Write: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit', WebSearch: 'web', WebFetch: 'web' };

export class Transcript {
  private offset = 0;
  private carry = '';
  readonly items = new Map<string, Item>();
  readonly turns: TurnState[] = [];
  private readonly tools = new Map<string, Item>(); // tool_use id -> item
  /** Paths of files Claude wrote, for upload as outputs. */
  readonly writes: { itemId: string; turnId: string; path: string }[] = [];
  /** Pictures the owner pasted into a prompt (kept in the transcript as base64), shown on the owner's side. */
  readonly pasted: { itemId: string; turnId: string; mime: string; data: string }[] = [];
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  /** Parses what was appended since the last call. Returns the items that are new or changed. */
  update(): Item[] {
    let size: number;
    try {
      size = statSync(this.file).size;
    } catch {
      return [];
    }
    if (size < this.offset) {
      // Rewritten from scratch (rare): start over.
      this.offset = 0;
      this.carry = '';
      this.items.clear();
      this.turns.length = 0;
    }
    if (size === this.offset) return [];
    const fd = openSync(this.file, 'r');
    const buf = Buffer.alloc(size - this.offset);
    try {
      readSync(fd, buf, 0, buf.length, this.offset);
    } finally {
      closeSync(fd);
    }
    this.offset = size;
    const text = this.carry + buf.toString('utf8');
    const lines = text.split('\n');
    this.carry = lines.pop() ?? ''; // a line still being written
    const changed = new Map<string, Item>();
    for (const line of lines) {
      if (!line.trim()) continue;
      let r: any;
      try {
        r = JSON.parse(line);
      } catch {
        continue;
      }
      for (const item of this.apply(r)) changed.set(item.itemId, item);
    }
    return [...changed.values()];
  }

  private current(): TurnState | undefined {
    return this.turns.at(-1);
  }

  private status(turn: TurnState): Item {
    const item: Item = { itemId: `turn:${turn.turnId}`, turnId: turn.turnId, kind: 'status', ts: turn.startedAt + 999_999,
      data: { status: turn.status, startedAt: Math.floor(turn.startedAt / 1000), completedAt: turn.status === 'completed' ? Math.floor(Date.now() / 1000) : null, error: null } };
    this.items.set(item.itemId, item);
    return item;
  }

  private put(item: Item): Item {
    this.items.set(item.itemId, item);
    return item;
  }

  private apply(r: any): Item[] {
    if (r.isSidechain) return []; // sub-agent chatter stays on the computer
    const ts = Date.parse(r.timestamp ?? '') || Date.now();
    const out: Item[] = [];
    if (r.type === 'user' && r.message) {
      const content = r.message.content;
      if (Array.isArray(content) && content.some((c: any) => c?.type === 'tool_result')) {
        for (const c of content) {
          const tool = c?.type === 'tool_result' ? this.tools.get(c.tool_use_id) : undefined;
          if (!tool) continue;
          tool.data = { ...tool.data, status: c.is_error ? 'failed' : 'completed', output: tail(c.content) };
          out.push(this.put(tool));
        }
        return out;
      }
      if (r.isMeta) return out;
      const text = userText(content);
      if (text === null) return out;
      // A new prompt starts a turn; the previous one is over.
      const prev = this.current();
      if (prev && prev.status === 'inProgress') {
        prev.status = 'completed';
        out.push(this.status(prev));
      }
      const turn: TurnState = { turnId: r.promptId ?? r.uuid, startedAt: ts, status: 'inProgress' };
      this.turns.push(turn);
      if (Array.isArray(content)) {
        content.forEach((c: any, i: number) => {
          if (c?.type === 'image' && c.source?.type === 'base64' && typeof c.source.data === 'string') {
            this.pasted.push({ itemId: `paste:${r.uuid}:${i}`, turnId: turn.turnId, mime: String(c.source.media_type || 'image/png'), data: c.source.data });
          }
        });
      }
      out.push(this.put({ itemId: r.uuid, turnId: turn.turnId, kind: 'message', ts, data: { role: 'user', text, clientId: null } }));
      out.push(this.status(turn));
      return out;
    }
    if (r.type === 'assistant' && r.message) {
      const turn = this.current();
      const turnId = turn?.turnId ?? null;
      const blocks = Array.isArray(r.message.content) ? r.message.content : [];
      blocks.forEach((b: any, i: number) => {
        const itemId = `${r.uuid}:${i}`;
        if (b?.type === 'text' && b.text?.trim()) {
          out.push(this.put({ itemId, turnId, kind: 'message', ts: ts + i, data: { role: 'assistant', text: b.text, phase: null } }));
        } else if (b?.type === 'tool_use') {
          const item: Item = { itemId, turnId, kind: 'tool_call', ts: ts + i,
            data: { tool: TOOL_KIND[b.name] ?? b.name, summary: toolSummary(b.name, b.input), status: 'inProgress', output: '' } };
          this.tools.set(b.id, item);
          out.push(this.put(item));
          if (turnId && (b.name === 'Write') && typeof b.input?.file_path === 'string') this.writes.push({ itemId: `file:${itemId}`, turnId, path: b.input.file_path });
        }
      });
      if (turn && r.message.stop_reason === 'end_turn') {
        turn.status = 'completed';
        out.push(this.status(turn));
      }
      return out;
    }
    if (r.type === 'system' && r.subtype === 'turn_aborted' && this.current()) {
      this.current()!.status = 'interrupted';
      out.push(this.status(this.current()!));
    }
    return out;
  }

  /** Items of the last `turns` turns, oldest first. */
  recent(turns: number): Item[] {
    const keep = new Set(this.turns.slice(-turns).map((t) => t.turnId));
    return [...this.items.values()].filter((i) => i.turnId !== null && keep.has(i.turnId)).sort((a, b) => a.ts - b.ts);
  }
}

/** Latest line, the conversation's own title and whether a turn is still going, from the end of the file only. */
export function peek(file: string): { preview: string | null; running: boolean; title: string | null } {
  let size = 0;
  try {
    size = statSync(file).size;
  } catch {
    return { preview: null, running: false, title: null };
  }
  const start = Math.max(0, size - TAIL_BYTES);
  const fd = openSync(file, 'r');
  const buf = Buffer.alloc(size - start);
  try {
    readSync(fd, buf, 0, buf.length, start);
  } finally {
    closeSync(fd);
  }
  const lines = buf.toString('utf8').split('\n').slice(start > 0 ? 1 : 0).filter(Boolean).reverse();
  let preview: string | null = null;
  let running: boolean | null = null;
  let title: string | null = null;
  let firstPrompt: string | null = null;
  for (const line of lines) {
    let r: any;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (title === null && (r.type === 'custom-title' || r.type === 'summary')) title = String(r.customTitle ?? r.summary ?? '') || null;
    if (r.isSidechain || (r.type !== 'assistant' && r.type !== 'user')) continue;
    if (r.type === 'user' && typeof r.message?.content === 'string' && !r.isMeta) firstPrompt = userText(r.message.content);
    // A turn is over when its reply ended, or when it was interrupted (Claude Code records that as a user line).
    if (running === null) running = !(r.type === 'assistant' && r.message?.stop_reason === 'end_turn') && !/^\[Request interrupted/.test(userText(r.message?.content) ?? '');
    if (preview === null) {
      const text = r.type === 'assistant'
        ? (r.message?.content ?? []).filter((b: any) => b?.type === 'text').map((b: any) => b.text).join(' ')
        : Array.isArray(r.message?.content) && r.message.content.some((c: any) => c?.type === 'tool_result') ? '' : userText(r.message?.content) ?? '';
      if (text.trim()) preview = text.replace(/\s+/g, ' ').trim().slice(0, 80);
    }
  }
  // No title of its own (started in a terminal): the earliest prompt we can see names it.
  title ??= firstPrompt ? firstPrompt.replace(/\s+/g, ' ').trim().slice(0, 60) : null;
  return { preview, running: Boolean(running), title };
}
