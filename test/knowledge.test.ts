import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/hub/store.ts';
import { Knowledge } from '../src/hub/knowledge.ts';

const comfy = { title: 'ComfyUI 和生图模型在哪', computer: 'office-pc', keys: ['ComfyUI', 'FLUX', 'Qwen Image', '模型'],
  body: '程序在 C:\\Users\\me\\AppData\\Local\\Comfy-Desktop\\ComfyUI-Installs\\AI影视制作工厂\\ComfyUI，模型在 ComfyUI-Shared\\models' };

test('what one agent learns, every agent finds, and a message about it carries it to the computer it is for', () => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'hub-')));
  const k = new Knowledge(store.db);
  const { id } = k.learn(comfy, 'office-pc · Codex') as { id: string };
  assert.throws(() => k.learn({ ...comfy, keys: [] }, 'x'), /关键词/);
  assert.throws(() => k.learn({ ...comfy, kind: 'rule' }, 'x'), /主人/);
  assert.throws(() => k.learn({ ...comfy, title: '密钥', body: 'GEMINI_API_KEY=AIzaSyAbcdefghijk' }, 'x'), /密钥/);

  const found = k.know({ query: 'FLUX 模型' }) as { entries: { id: string; by: string }[] };
  assert.equal(found.entries[0]!.id, id);
  assert.match(found.entries[0]!.by, /office-pc · Codex/);
  assert.deepEqual((k.know({ query: 'FLUX', computer: 'server' }) as { entries: unknown[] }).entries, [], 'another computer’s entry is not shown for server');

  // OpenCode is asked to look at the models on 5090: it is told where they are, once.
  const extra = k.related('盘点一下 5090 上的本地模型，FLUX 有没有', 'office-pc', 's1');
  assert.match(extra, /ComfyUI-Shared/);
  assert.equal(k.related('FLUX 再看一下', 'office-pc', 's1'), '', 'the same conversation is not told twice in a day');
  assert.equal(k.related('FLUX 有没有', 'server', 's2'), '', 'nor told about another computer');

  // Wrong: put right by an entry of the same title (or by naming it), the old one taken back.
  const fixed = k.learn({ ...comfy, body: '模型在 D:\\models' }, 'office-pc · OpenCode') as { id: string; replaced: string[] };
  assert.deepEqual(fixed.replaced, [id]);
  assert.equal(k.entry(id)!.goneBy, 'office-pc · OpenCode 改正');
  assert.equal((k.know({}) as { index: string[] }).index.length, 1);

  // The owner's handbook: only as a whole, replacing the one before.
  k.importRules({ rules: [{ title: '一、称呼', body: '叫老周', keys: ['老周'] }] }, 'laptop · Claude Code');
  k.importRules({ rules: [{ title: '一、称呼', body: '叫老周，不叫主人', keys: ['老周'] }, { title: '二、用法', body: '汇报只是通知', keys: [] }] }, 'laptop · Claude Code');
  const rules = (k.know({ query: '协作手册' }) as { entries: { body: string }[] }).entries;
  assert.deepEqual(rules.map((r) => r.body), ['叫老周，不叫主人', '汇报只是通知']);
  assert.equal(k.related('老周说的', 'office-pc', 's3'), '', 'rules are read with know, not added to messages');
  store.db.close();
});
