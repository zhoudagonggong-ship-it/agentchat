import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describePermissions, formContent, formQuestions } from '../src/device/codex/adapter.ts';

// Shapes from `codex app-server generate-json-schema` (codex-cli 0.164).
test('a permission request reads as what is asked for', () => {
  assert.equal(describePermissions({ network: { enabled: true }, fileSystem: { write: ['D:\\work'], read: null } }), '联网\n写入：D:\\work');
  assert.equal(describePermissions({ fileSystem: { entries: [{ access: 'read', path: { type: 'path', path: 'C:\\data' } }] } }), '读取：C:\\data');
  assert.equal(describePermissions({}), '更多权限');
});

const schema = {
  type: 'object',
  properties: {
    name: { type: 'string', title: '名字' },
    count: { type: 'integer' },
    ok: { type: 'boolean', title: '同意吗' },
    color: { type: 'string', oneOf: [{ const: 'r', title: '红' }, { const: 'g', title: '绿' }] },
    size: { type: 'string', enum: ['s', 'm'], enumNames: ['小', '中'] },
    tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } },
  },
};

test('an MCP form becomes phone questions', () => {
  const qs = formQuestions(schema);
  assert.deepEqual(qs.map((q) => [q.key, q.title, q.custom, q.options.map((o) => o.label).join('/')]), [
    ['name', '名字', true, ''], ['count', 'count', true, ''], ['ok', '同意吗', false, '是/否'],
    ['color', 'color', false, '红/绿'], ['size', 'size', false, '小/中'], ['tags', 'tags', false, 'a/b'],
  ]);
});

test('answers go back in the form field types', () => {
  assert.deepEqual(formContent(schema, { name: '周', count: '3', ok: 'false', color: 'g', tags: 'a' }),
    { name: '周', count: 3, ok: false, color: 'g', tags: ['a'] });
});
