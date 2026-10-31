import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { heldCount, heldOutput, hold, release, sendNow, senderOf, type Reminder } from '../src/device/held.ts';

test('a message held back for the owner is told once, again when late, sent on the owner’s word, and counted', () => {
  mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  try {
    const told: Reminder[] = [];
    const counts: number[] = [];
    heldOutput((r) => told.push(r), (n) => counts.push(n));
    const who = senderOf('[来自 office-pc · Goose「语言分级开发」的汇报，经 AgentChat 转发] 做完了');
    assert.equal(who, 'office-pc · Goose');
    assert.equal(senderOf('今天怎么样'), '你在手机上发的');

    const h = hold('r1', who, '语言专家设计', 'in_use');
    hold('r1', who, '语言专家设计', 'in_use'); // looked at again 8 s later: nothing new
    assert.equal(told.length, 1);
    assert.match(told[0]!.title, /office-pc · Goose 的消息在等你/);
    assert.match(told[0]!.text, /你正在用这台电脑.*「语言专家设计」/);
    assert.equal(told[0]!.action, 'sendnow r1');
    assert.deepEqual(counts, [1]);

    mock.timers.tick(11 * 60_000);
    hold('r1', who, '语言专家设计', 'busy');
    hold('r1', who, '语言专家设计', 'busy');
    assert.equal(told.length, 2, 'told once more when late, not again after');
    assert.match(told[1]!.title, /已经等了 11 分钟/);
    assert.match(told[1]!.text, /这个对话正在运行/);

    hold('r2', 'server · Codex', '别的对话', 'draft');
    assert.equal(heldCount(), 2);
    assert.equal(sendNow('r1'), 1);
    assert.equal(h.now, true);
    assert.equal(sendNow(), 2, 'the tray’s menu: everything waiting');
    release('r1');
    release('r2');
    release('r2');
    assert.deepEqual(counts, [1, 2, 1, 0]);
    assert.equal(sendNow('r1'), 0, 'already gone');
  } finally {
    mock.timers.reset();
  }
});
