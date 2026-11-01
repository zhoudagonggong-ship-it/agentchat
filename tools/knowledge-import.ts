// Puts the owner's handbook, or a batch of facts, into AgentChat's shared knowledge (src/hub/knowledge.ts), through
// this computer's AgentChat, as its Claude Code.
//   node tools/knowledge-import.ts handbook <手册.md>   the handbook, one rule per "## " section, replacing the one before
//   node tools/knowledge-import.ts facts <facts.json>   [{ title, body, keys, computer?, kind? }, …], each as `learn` takes it
import { readFileSync } from 'node:fs';
import { CONTROL_PORT } from '../src/shared/protocol.ts';

async function ask(op: string, args: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`http://127.0.0.1:${CONTROL_PORT}/api/agent`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-allinone': '1' }, body: JSON.stringify({ op, agent: 'claude-code', args }),
  });
  const out = (await res.json()) as { result?: unknown; error?: string };
  if (!res.ok || out.error) throw new Error(out.error ?? `AgentChat ${res.status}`);
  return out.result;
}

const [what, file] = process.argv.slice(2);
if (!file || (what !== 'handbook' && what !== 'facts')) {
  console.error('用法：node tools/knowledge-import.ts handbook <手册.md> | facts <facts.json>');
  process.exit(2);
}
const text = readFileSync(file, 'utf8').replace(/^﻿/, '');
if (what === 'handbook') {
  // The title line says which version it is; each "## " section is one rule, its "### " parts named in its keys.
  const version = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? '协作手册';
  const rules = text.split(/^## /m).slice(1).map((s) => {
    const [head, ...rest] = s.split('\n');
    const keys = [...s.matchAll(/^### (.+)$/gm)].map((m) => m[1]!.replace(/[（(].*$/, '').trim()).filter(Boolean);
    return { title: head!.trim(), body: rest.join('\n').trim().replace(/\n---\s*$/, '').trim(), keys };
  });
  console.log(await ask('import', { rules, source: `老周的${version}` }));
} else {
  for (const f of JSON.parse(text) as Record<string, unknown>[]) console.log(f.title, '→', JSON.stringify(await ask('learn', f)));
}
