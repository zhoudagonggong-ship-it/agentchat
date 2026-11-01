import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heldCount, heldOutput, hold, release, sendNow, senderOf } from '../src/device/held.ts';

test('a message held back for the owner is counted quietly and sent on the owner’s word', () => {
  const counts: number[] = [];
  heldOutput((n) => counts.push(n));
  const who = senderOf('[来自 office-pc · Goose「语言分级开发」的汇报，经 AgentChat 转发] 做完了');
  assert.equal(who, 'office-pc · Goose');
  assert.equal(senderOf('今天怎么样'), '你在手机上发的');

  const h = hold('r1', who, '语言专家设计', 'in_use');
  hold('r1', who, '语言专家设计', 'busy'); // looked at again 8 s later: nothing new
  assert.deepEqual(counts, [1]);
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
});
