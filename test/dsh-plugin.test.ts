import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installDshPlugin, uninstallDshPlugin } from '../src/device/dsh/adapter.ts';

const profile = [
  '# Your patch layer for this dsh profile, applied after every bundle layer:',
  '- id: ui-settings-account',
  '  name: "@deepseek-ai/dsh-client-ui-settings-account"',
  '- insert:',
  '    - id: film-factory',
  "      name: 'C:\\w\\film\\lib\\index.js'",
  '',
].join('\r\n');

test('the DSH plugin goes into the desktop profile once, as an insert by absolute path, and comes out cleanly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-profile-'));
  const file = join(dir, 'cordis.patch.yml');
  writeFileSync(file, profile);
  assert.equal(installDshPlugin(file, "C:\\AllinOne\\src\\device\\dsh\\plugin\\agentchat-bridge.mjs", 'C:\\Users\\x\\.dsh\\agentchat-bridge.json'), true);
  const text = readFileSync(file, 'utf8');
  assert.ok(text.startsWith(profile.trimEnd()), 'the owner\'s own entries stay first and unchanged');
  assert.match(text, /- insert:\r\n {4}- id: agentchat-bridge\r\n {6}name: 'C:\\AllinOne\\src\\device\\dsh\\plugin\\agentchat-bridge\.mjs'\r\n {6}config:\r\n {8}connectionFile: 'C:\\Users\\x\\\.dsh\\agentchat-bridge\.json'/);
  assert.ok(existsSync(file + '.allinone-backup'));
  // Again: nothing changes.
  assert.equal(installDshPlugin(file, "C:\\AllinOne\\src\\device\\dsh\\plugin\\agentchat-bridge.mjs", 'C:\\Users\\x\\.dsh\\agentchat-bridge.json'), false);
  assert.equal(uninstallDshPlugin(file), true);
  assert.equal(readFileSync(file, 'utf8').trimEnd(), profile.trimEnd());
  assert.equal(uninstallDshPlugin(file), false);
});
