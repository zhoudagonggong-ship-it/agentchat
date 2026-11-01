import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeCodeAdapter } from '../src/device/claude/adapter.ts';
import type { Item } from '../src/shared/protocol.ts';

/** An adapter whose window answers as told, with a phone that sees its cards and receipts. */
function setup(answers: string[]) {
  const a = new ClaudeCodeAdapter(null) as any;
  const cards: Item[] = [];
  const receipts: string[] = [];
  const tried: string[] = [];
  a.sink = { items: (_t: string, items: Item[]) => cards.push(...items.map((i) => structuredClone(i))), receipt: (_r: string, state: string, _t?: string, why?: string) => receipts.push(why ? `${state}:${why}` : state) };
  a.meta.set('th1', { cliSessionId: 'th1', localId: 'local_abc', cwd: null, title: '工厂控制台开发', archived: false, activity: 0 });
  a.desktopSend = async (_title: string, link: string) => {
    tried.push(link);
    const reason = answers.shift() ?? 'not_listed';
    return { ok: reason === 'ok', reason };
  };
  const answer = (value: string) => {
    const [id, ask] = [...a.asks.entries()][0] as [string, any];
    ask.answer('accept', { q0: value });
    return id;
  };
  return { a, cards, receipts, tried, answer };
}
const until = async (ok: () => boolean) => { for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 20)); };

test('a message the window cannot take waits on a card on the phone, never going around it; tried again, it goes in', async () => {
  const { a, cards, receipts, tried, answer } = setup(['not_listed', 'ok']);
  const sent = a.sendInWindow('th1', '工厂控制台开发', '你好', 'req1', 'office-pc · OpenCode');
  await until(() => cards.length > 0);
  assert.equal(cards[0]!.data.kind, 'delivery');
  assert.equal(cards[0]!.data.state, 'pending');
  assert.match(String(cards[0]!.data.reason), /office-pc · OpenCode 发来的消息送不进「工厂控制台开发」：在 Claude 窗口里打不开这个对话/);
  assert.equal(tried[0], 'claude://claude.ai/epitaxy/local_abc', 'the conversation is opened by its own link');
  answer('retry');
  assert.equal(await sent, true, 'typed into the window, not handed to the CLI');
  assert.equal(cards.at(-1)!.data.state, 'sent');
  assert.deepEqual(receipts, ['pending:waiting_for_window', 'accepted']);
  assert.equal(a.asks.size, 0);
});

test('on the card the owner may drop the message, or send it from behind the window', async () => {
  const drop = setup(['ambiguous']);
  const dropped = drop.a.sendInWindow('th1', '工厂控制台开发', '你好', 'req2', '你在手机上发的');
  await until(() => drop.cards.length > 0);
  assert.match(String(drop.cards[0]!.data.reason), /^你在手机上发的消息送不进.*两个同名的对话/);
  drop.answer('drop');
  assert.equal(await dropped, true);
  assert.equal(drop.cards.at(-1)!.data.state, 'dropped');
  assert.deepEqual(drop.receipts, ['pending:waiting_for_window', 'failed:dropped_by_owner']);

  const cli = setup(['no_window']);
  const behind = cli.a.sendInWindow('th1', '工厂控制台开发', '你好', 'req3', 'server · Codex');
  await until(() => cli.cards.length > 0);
  cli.answer('cli');
  assert.equal(await behind, false, 'the caller continues it with the CLI');
  assert.equal(cli.cards.at(-1)!.data.state, 'cli');
});
