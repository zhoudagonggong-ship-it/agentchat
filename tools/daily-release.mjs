#!/usr/bin/env node
/**
 * Daily release to GitHub: the code, its notes and the installer, for a day that had changes.
 *
 * Run once a day by the Claude desktop app's scheduled task 「AgentChat 每日发布到 GitHub」 (which checks the result
 * and tells the owner); it acts from the release hour (Beijing time) on, and once per day:
 *   1. commits since the last release (its 「版本 x」 commit)? none: nothing to do;
 *   2. the version is that day's date (2026.10.29): set in package.json and committed;
 *   3. the installer is built from that commit, never from the working tree (work in progress stays out);
 *   4. the public copy (build/public, a history of its own) is brought to that commit and checked for private
 *      details: any found, it stops and publishes nothing;
 *   5. notes are written from those commit messages (by Claude Code on this computer, without tools); a dry run
 *      keeps its notes (build/release-ready.json), and the release uses them while the changes are the same;
 *   6. the code is pushed with a tag, and a GitHub release is made with the installer and its SHA-256.
 * Each step goes to build/daily-release.log; the end is shown in the corner of the screen for a moment.
 *
 *   node tools/daily-release.mjs [--day 2026-10-29] [--now] [--dry]
 *   --now: whatever the hour; --dry: build and check everything, commit and publish nothing
 */
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PUBLIC = join(ROOT, 'build', 'public');
const LOG = join(ROOT, 'build', 'daily-release.log');
const READY = join(ROOT, 'build', 'release-ready.json'); // notes a dry run wrote ahead, for the release to use
const REPO = 'zhoudagonggong-ship-it/agentchat';
const ZONE = 'Asia/Shanghai';
const RELEASE_HOUR = 8;
// Files that stay on this computer: in the development history, never in the public copy.
const PRIVATE_FILES = ['组网方案讨论纪要.pdf'];
// What must not reach the public repository: keys, and the owner's own details (this network, its addresses, their
// accounts and computers), one pattern a line in build/private-words.txt, which stays on this computer. Without that
// file nothing is published.
const WORDS = join(ROOT, 'build', 'private-words.txt');
const PRIVATE = new RegExp(['-----BEGIN [A-Z ]*PRIVATE KEY', 'sk-[A-Za-z0-9]{20}', 'gh[pousr]_[A-Za-z0-9]{20}',
  ...(existsSync(WORDS) ? readFileSync(WORDS, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')) : [])].join('|'), 'i');

const args = process.argv.slice(2);
const log = (line) => {
  const text = `[${new Date().toISOString()}] ${line}`;
  console.log(text);
  appendFileSync(LOG, text + '\n', 'utf8');
};
const parts = (ms) => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
  .formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
const dayOf = (ms) => { const p = parts(ms); return `${p.year}-${p.month}-${p.day}`; };

/** git: this checkout's own MinGit (seen from outside the Claude app under its Packages folder), or one on PATH. */
function findGit() {
  const local = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
  const tail = join('Programs', 'MinGit', 'cmd', 'git.exe');
  const found = [join(local, tail)];
  const pkgs = join(local, 'Packages');
  if (existsSync(pkgs)) for (const d of readdirSync(pkgs)) if (d.startsWith('Claude_')) found.push(join(pkgs, d, 'LocalCache', 'Local', tail));
  return found.find((f) => existsSync(f)) ?? 'git';
}
const GIT = findGit();
// GitHub's own command line, installed for this user by winget (or for everyone).
function findGh() {
  const winget = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Microsoft', 'WinGet');
  const found = [join(winget, 'Links', 'gh.exe'), join(process.env.ProgramFiles ?? 'C:\\Program Files', 'GitHub CLI', 'gh.exe')];
  const pkgs = join(winget, 'Packages');
  if (existsSync(pkgs)) for (const d of readdirSync(pkgs)) if (d.startsWith('GitHub.cli_')) found.push(join(pkgs, d, 'bin', 'gh.exe'));
  return found.find((f) => existsSync(f)) ?? 'gh';
}
const GH = findGh();
const git = (cwd, ...a) => execFileSync(GIT, ['-c', 'core.quotepath=off', '-C', cwd, ...a], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** Claude Code bundled with the desktop app, newest first. */
function findClaude() {
  const local = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
  const roots = [join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Claude')];
  for (const base of [join(local, 'Claude-Data'), join(local, 'Packages')]) {
    if (!existsSync(base)) continue;
    for (const d of readdirSync(base)) {
      if (d.startsWith('claude_')) roots.push(join(base, d));
      if (d.startsWith('Claude_')) roots.push(join(base, d, 'LocalCache', 'Roaming', 'Claude'));
    }
  }
  const found = [];
  for (const r of roots) {
    const cc = join(r, 'claude-code');
    if (!existsSync(cc)) continue;
    for (const v of readdirSync(cc)) for (const b of existsSync(join(cc, v)) && statSync(join(cc, v)).isDirectory() ? readdirSync(join(cc, v)) : []) {
      const exe = join(cc, v, b, 'claude.exe');
      if (existsSync(exe)) found.push(exe);
    }
  }
  return found.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? null;
}

/** The notes: by Claude when it answers, otherwise the commit subjects as they are. */
async function notesFor(version, subjects) {
  const plain = ['## 更新内容 · What changed', '', ...subjects.map((s) => `- ${s}`)].join('\n');
  const exe = findClaude();
  if (!exe) return plain;
  const prompt = `下面是开源项目 AgentChat 在 ${version} 这一天的全部提交说明（中文，写给开发者看的）。请写这个版本在 GitHub Release 上的更新说明，给用户看：
- 先英文后中文，两部分内容一致；用 Markdown，分「新增 / 改进 / 修复」（英文 New / Improved / Fixed），没有的就不写；
- 用用户能懂的话写清楚变了什么、对用户有什么用，不写内部实现细节；
- 不要写任何电脑名、人名、地址、路径、账号；
- 只输出更新说明本身，不要别的话。

${subjects.map((s) => `- ${s}`).join('\n')}`;
  const text = await new Promise((done) => {
    const child = spawn(exe, ['-p', '--no-session-persistence', '--model', 'sonnet', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', '', '--output-format', 'json'],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    const timer = setTimeout(() => child.kill(), 10 * 60_000);
    child.on('error', () => done(''));
    child.on('exit', () => {
      clearTimeout(timer);
      try { const j = JSON.parse(out); done(j.is_error ? '' : String(j.result ?? '')); } catch { done(''); }
    });
    child.stdin.end(prompt, 'utf8');
  });
  if (!text.trim()) return plain;
  if (PRIVATE.test(text)) { log('notes from Claude named something private; using the commit subjects instead'); return PRIVATE.test(plain) ? null : plain; }
  return text.trim();
}

/** Notes a dry run wrote for this very version and these very changes (none came since). */
function readyNotes(version, subjects) {
  try {
    const r = JSON.parse(readFileSync(READY, 'utf8'));
    return r.version === version && JSON.stringify(r.subjects) === JSON.stringify(subjects) && r.notes && !PRIVATE.test(r.notes) ? r.notes : null;
  } catch {
    return null;
  }
}

function toast(text) {
  const ps = `Add-Type -AssemblyName System.Windows.Forms;$n=New-Object System.Windows.Forms.NotifyIcon;$n.Icon=[System.Drawing.SystemIcons]::Information;` +
    `$n.BalloonTipTitle='AgentChat 发布';$n.BalloonTipText='${text.replace(/'/g, "''")}';$n.Visible=$true;$n.ShowBalloonTip(4000);Start-Sleep -Seconds 5;$n.Dispose()`;
  try { spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps], { windowsHide: true, detached: true, stdio: 'ignore' }).unref(); } catch {}
}

async function main() {
  const now = Date.now();
  const at = args.indexOf('--day');
  const day = at >= 0 ? args[at + 1] : dayOf(now - 24 * 3600 * 1000);
  if (!args.includes('--now') && at < 0 && Number(parts(now).hour) < RELEASE_HOUR) return;
  const [y, m, d] = day.split('-').map(Number);
  const version = `${y}.${m}.${d}`;
  const tag = `v${version}`;
  // Once per day: the tag on GitHub says it was done.
  if (git(PUBLIC, 'ls-remote', '--tags', 'origin', tag)) return;
  if (!existsSync(WORDS)) throw new Error('build/private-words.txt is missing: without it the check for private details cannot run');

  // 1. What changed since the last release (its 「版本 x」 commit): the code released is the latest, so the notes cover
  //    all of it, the hours after midnight included. No release before: that day's commits (Beijing time). A 「版本」
  //    commit for this very version is from an attempt that failed, not a release.
  const last = git(ROOT, 'log', '-E', '--grep=^版本 [0-9]+\\.[0-9]+\\.[0-9]+$', '--format=%H %s')
    .split('\n').find((l) => l && !l.endsWith(` 版本 ${version}`))?.split(' ')[0];
  const from = new Date(`${day}T00:00:00+08:00`).toISOString();
  const to = new Date(new Date(`${day}T00:00:00+08:00`).getTime() + 86_400_000).toISOString();
  const subjects = (last ? git(ROOT, 'log', `${last}..HEAD`, '--format=%s') : git(ROOT, 'log', `--since=${from}`, `--until=${to}`, '--format=%s'))
    .split('\n').filter((s) => s && !/^版本 \d+\.\d+\.\d+$/.test(s)).reverse();
  if (!subjects.length) return log(`${day}: no changes since the last release, nothing to release`);
  log(`${day}: ${subjects.length} commits since the last release, releasing ${tag}`);

  // 2. The version, committed on its own (whatever else is being worked on stays as it is).
  const dry = args.includes('--dry');
  const withVersion = (file) => {
    const pkg = readFileSync(file, 'utf8');
    if (pkg.includes(`"version": "${version}"`)) return false;
    writeFileSync(file, pkg.replace(/"version":\s*"[^"]*"/, `"version": "${version}"`));
    return true;
  };
  if (!dry && withVersion(join(ROOT, 'package.json'))) git(ROOT, 'commit', '-m', `版本 ${version}`, '--', 'package.json');
  const commit = git(ROOT, 'rev-parse', 'HEAD');

  // 3. The installer, from that commit plus what it needs that is not in git (Node, the ws module, the phone app).
  const stage = join(ROOT, 'build', 'release-stage');
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  git(ROOT, `--work-tree=${stage}`, 'checkout', commit, '--', '.');
  git(ROOT, 'reset', '-q');
  if (dry) withVersion(join(stage, 'package.json'));
  for (const p of ['node_modules', join('runtime', 'node'), join('build', 'android', 'AllinOne.apk')]) cpSync(join(ROOT, p), join(stage, p), { recursive: true });
  execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(stage, 'tools', 'package.ps1')], { encoding: 'utf8' });
  const zip = join(stage, 'dist', `AgentChat-${version}.zip`);
  if (!existsSync(zip)) throw new Error('the installer was not built');

  // 4. The public copy at that commit, checked for private details.
  for (const e of readdirSync(PUBLIC)) if (e !== '.git') rmSync(join(PUBLIC, e), { recursive: true, force: true });
  git(ROOT, `--work-tree=${PUBLIC}`, 'checkout', commit, '--', '.');
  git(ROOT, 'reset', '-q');
  for (const f of PRIVATE_FILES) rmSync(join(PUBLIC, f), { force: true });
  git(PUBLIC, 'add', '-A');
  const added = git(PUBLIC, 'diff', '--cached', '-U0').split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));
  const leak = added.find((l) => PRIVATE.test(l));
  if (leak) throw new Error(`private details in the changes, nothing published: ${leak.slice(0, 120)}`);

  // 5. Notes: the ones a dry run wrote ahead (the owner may have read them) while the changes are still the same.
  // 6. Code, tag and release.
  const ready = readyNotes(version, subjects);
  const notes = ready ?? (await notesFor(version, subjects));
  if (!notes) throw new Error('no notes without private details, nothing published');
  const notesFile = join(stage, 'notes.md');
  writeFileSync(notesFile, `${notes}\n`, 'utf8');
  if (dry) {
    writeFileSync(READY, JSON.stringify({ version, subjects, notes }, null, 2), 'utf8');
    return log(`dry run: ${tag} ready, ${added.length} lines added, installer ${zip}, notes ${notesFile} (kept for the release); nothing published`);
  }
  if (ready) log('using the notes written ahead');
  if (git(PUBLIC, 'status', '--porcelain')) git(PUBLIC, 'commit', '-q', '-F', notesFile);
  git(PUBLIC, 'tag', '-a', tag, '-m', `AgentChat ${version}`);
  git(PUBLIC, 'push', 'origin', 'main', tag);
  execFileSync(GH, ['release', 'create', tag, zip, `${zip}.sha256`, '--repo', REPO, '--title', `AgentChat ${version}`, '--notes-file', notesFile], { encoding: 'utf8' });
  rmSync(READY, { force: true });
  log(`${tag} released with ${(statSync(zip).size / 1048576).toFixed(1)} MB installer`);
  toast(`已发布 ${tag}：代码、说明和安装包`);
}

main().catch((error) => {
  log(`release failed: ${error.message.split('\n').slice(0, 3).join(' ')}`);
  toast(`今天的发布没有完成：${error.message.slice(0, 80)}`);
  process.exitCode = 1;
});
