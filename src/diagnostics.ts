// 「导出诊断信息」: one zip on the desktop with what helps someone else find a problem (state, recent log, versions),
// with secrets taken out first, so the owner can send it along when asking for help.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { arch, release } from 'node:os';

const run = promisify(execFile);
const LOG_TAIL = 2 * 1024 * 1024;

/** Takes passwords, tokens, keys and pairing codes out of text (logs and state alike). */
export function redact(text: string): string {
  return text
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/g, '$1 [已隐去]')
    .replace(/("?(?:password|passwd|secret|token|apiKey|api_key|authorization|deviceSecret|secretHash|auth)"?\s*[:=]\s*)(?!(?:Bearer|Basic) \[)("[^"]*"|[^\s,;}&]+)/gi, '$1"[已隐去]"')
    .replace(/([?&](?:code|token|key|auth)=)[^&\s"']+/gi, '$1[已隐去]')
    .replace(/\b(sk|rk|pk)-[A-Za-z0-9_-]{12,}/g, '[已隐去的密钥]');
}

function tail(file: string, bytes: number): string {
  if (!existsSync(file)) return '';
  const size = statSync(file).size;
  const start = Math.max(0, size - bytes);
  const buf = Buffer.alloc(size - start);
  const fd = openSync(file, 'r');
  try {
    readSync(fd, buf, 0, buf.length, start);
  } finally {
    closeSync(fd);
  }
  return buf.toString('utf8');
}

/**
 * Writes the zip and returns its path. `state` is what the control window shows; `outDir` is the desktop unless given.
 */
export async function exportDiagnostics(dataDir: string, appDir: string, state: unknown, code: string, outDir?: string): Promise<string> {
  const now = new Date();
  const stamp = new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 16).replace(/[-:T]/g, ''); // local time
  const name = `AgentChat-诊断信息-${stamp}`;
  const desktop = outDir ?? (await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "[Environment]::GetFolderPath('Desktop')"], { windowsHide: true })).stdout.trim();
  const stage = join(dataDir, name);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  const pkg = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')) as { version?: string };
  const summary = { version: pkg.version, code, node: process.version, windows: release(), arch: arch(), at: new Date().toISOString(), state };
  writeFileSync(join(stage, '概况.json'), redact(JSON.stringify(summary, null, 2)));
  writeFileSync(join(stage, 'allinone.log'), redact(tail(join(dataDir, 'allinone.log'), LOG_TAIL)));
  const config = join(dataDir, 'config.json');
  if (existsSync(config)) writeFileSync(join(stage, 'config.json'), redact(readFileSync(config, 'utf8')));
  const zip = join(desktop, `${name}.zip`);
  try {
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Compress-Archive -Path '${stage.replace(/'/g, "''")}\\*' -DestinationPath '${zip.replace(/'/g, "''")}' -Force`],
      { windowsHide: true, timeout: 120_000 });
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  return zip;
}
