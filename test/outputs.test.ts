import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isOutput } from '../src/device/device.ts';

test("files an agent writes count as the owner's results only when they are not part of its work", () => {
  for (const p of ['C:\\AllinOneProject\\build\\promo\\final\\AgentChat-promo.mp4', 'D:\\AgentOutputs\\x\\封面.png', 'C:\\Self-Media\\手册.md',
    'C:\\work\\报告.docx', 'C:\\work\\data.xlsx', 'C:\\work\\voice.wav', 'C:\\work\\slides.pdf', 'C:\\work\\notes.txt']) assert.ok(isOutput(p), p);
  for (const p of ['C:\\AllinOneProject\\src\\hub\\replica.ts', 'C:\\AllinOneProject\\tools\\restart-when-idle.ps1', 'C:\\x\\test\\shift.test.ts',
    'C:\\Users\\me\\.claude\\projects\\x\\memory\\MEMORY.md', 'C:\\repo\\.git\\config', 'C:\\repo\\node_modules\\a\\readme.md',
    'C:\\repo\\package.json', 'C:\\repo\\.gitignore', 'C:\\repo\\web\\style.css']) assert.ok(!isOutput(p), p);
});
