// Claude Code adapter. The Claude desktop app keeps its Code conversations' list in claude-code-sessions/*.json
// (title, folder, archived) and their content in ~/.claude/projects/<folder>/<id>.jsonl. Both are read, never written.
// Sending types into the desktop app (desktop-send.ps1) when it can; otherwise it continues the conversation
// with the desktop app's own bundled claude.exe (`-p --resume`), which the app sees only after a restart.
// New conversations another agent asks for are started with the same CLI (`--session-id`, `--name`).
// Permission prompts and questions reach the phone through Claude Code's own hooks (hook.ts), which this
// adapter installs in the user settings; the computer and the phone may both answer, the first one counts.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync, watch, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { Adapter, AdapterSink } from '../device.ts';
import type { AgentInfo, Command, Item, ProjectInfo, SessionInfo } from '../../shared/protocol.ts';
import { carriesTag, markTag, withAttachments } from '../../shared/protocol.ts';
import { debounce, log } from '../../shared/util.ts';
import { Transcript, peek, withoutContext } from './transcript.ts';
import { toolCommand } from '../tool.ts';
import { DATA_DIR } from '../../config.ts';
import { activity } from '../../activity.ts';
import { hold, release, senderOf } from '../held.ts';

const HYDRATE_TURNS = 20;
// A turn can sit on one long command for many minutes without writing; only after this long is an unfinished turn taken as abandoned.
const RUNNING_WINDOW_MS = 30 * 60_000;
const DESKTOP_SEND = join(import.meta.dirname, 'desktop-send.ps1');
const HOOK = join(import.meta.dirname, 'hook.ts');
const SETTINGS = join(homedir(), '.claude', 'settings.json');
// Away from the keyboard this long: the phone is asked too. Back at it: the computer takes over again.
const AWAY_MS = Number(process.env.ALLINONE_AWAY_MS ?? 30_000); // the variables only in tests
const BACK_MS = Number(process.env.ALLINONE_BACK_MS ?? 5_000);
/** A button on the prompt box's row, as the window shows it. */
interface RowButton { name: string; x: number; enabled: boolean }
/** What AgentChat learned about the desktop app's window since it changed (the send button's new names). */
const LEARNED_UI = join(DATA_DIR, 'learned-ui.json');
function learnedUi(): { claudeSend?: string[] } {
  try {
    return JSON.parse(readFileSync(LEARNED_UI, 'utf8'));
  } catch {
    return {};
  }
}
function saveLearnedUi(v: { claudeSend?: string[] }): void {
  writeFileSync(LEARNED_UI, JSON.stringify(v, null, 2));
}
// A message for a desktop conversation waits this long for the window (locked screen, a draft, a busy window).
const WINDOW_WAIT_MS = 2 * 3_600_000;
// Only these leave the window out: no desktop app running, or a conversation it does not list. Nothing to bypass then.
const CLI_ONLY = new Set(['no_window', 'not_listed']);
// What keeps a message out of the window for the owner's sake: they are using the computer, have a draft in the box,
// or the conversation still runs. The owner is told, and may say to send it in now.
const OWNER_WAITS = new Set(['in_use', 'busy', 'draft']);
// Claude Code ends a hook after 600 s; give up on the phone a little before.
const HOOK_WAIT_MS = 590_000;

interface Meta { cliSessionId: string; cwd: string | null; title: string | null; archived: boolean; activity: number }
interface PendingAsk { threadId: string; item: Item; answer(decision: string, answers?: Record<string, string>): void }

/** Milliseconds since the last key press or mouse move on this computer. */
function idleMs(): Promise<number> {
  return new Promise((done) => execFile('powershell.exe', ['-NoProfile', '-Command', `Add-Type -Namespace AllinOne -Name Idle -MemberDefinition '
[StructLayout(LayoutKind.Sequential)] public struct L { public uint cbSize; public uint dwTime; }
[DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref L l);
public static uint Ms() { var l = new L(); l.cbSize = (uint)Marshal.SizeOf(l); GetLastInputInfo(ref l); return (uint)Environment.TickCount - l.dwTime; }'
[AllinOne.Idle]::Ms()`], { windowsHide: true, timeout: 20_000 }, (_e, stdout) => done(Number(String(stdout).trim()) || 0)));
}

/**
 * Adds the AgentChat hooks to Claude Code's user settings (once, or again when this program moved),
 * keeping everything else in the file as it is.
 */
export function installHooks(settingsFile = SETTINGS, hook = HOOK, node = process.execPath): boolean {
  let settings: Record<string, any> = {};
  try {
    if (existsSync(settingsFile)) settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
  } catch {
    return false; // unreadable: never overwrite the owner's settings
  }
  const ours = (h: any) => typeof h?.args?.[0] === 'string' && /[\\/]device[\\/]claude[\\/]hook\.ts$/.test(h.args[0]);
  const entry = { type: 'command', command: node, args: [hook], timeout: 600 };
  const want: [string, string | undefined][] = [['PermissionRequest', undefined], ['PreToolUse', 'AskUserQuestion']];
  const hooks = (settings.hooks ??= {});
  let changed = false;
  for (const [event, matcher] of want) {
    const groups: any[] = (hooks[event] ??= []);
    const current = groups.flatMap((g) => (g.hooks ?? []).filter(ours));
    if (current.length === 1 && JSON.stringify(current[0]) === JSON.stringify(entry)) continue;
    // Drop ours (an older place or version), then add it once.
    for (const g of groups) g.hooks = (g.hooks ?? []).filter((h: any) => !ours(h));
    hooks[event] = groups.filter((g) => g.hooks.length);
    hooks[event].push({ ...(matcher ? { matcher } : {}), hooks: [entry] });
    changed = true;
  }
  if (changed) writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
  return changed;
}

/** Takes the AgentChat hooks back out of Claude Code's user settings (uninstall); everything else stays. */
export function uninstallHooks(settingsFile = SETTINGS): boolean {
  let settings: Record<string, any>;
  try {
    settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
  } catch {
    return false;
  }
  const ours = (h: any) => typeof h?.args?.[0] === 'string' && /[\\/]device[\\/]claude[\\/]hook\.ts$/.test(h.args[0]);
  let changed = false;
  for (const [event, groups] of Object.entries((settings.hooks ?? {}) as Record<string, any[]>)) {
    for (const g of groups) {
      const before = (g.hooks ?? []).length;
      g.hooks = (g.hooks ?? []).filter((h: any) => !ours(h));
      changed ||= g.hooks.length !== before;
    }
    settings.hooks[event] = groups.filter((g) => g.hooks.length);
    if (!settings.hooks[event].length) delete settings.hooks[event];
  }
  if (settings.hooks && !Object.keys(settings.hooks).length) delete settings.hooks;
  if (changed) writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
  return changed;
}

/** Folders the Claude desktop app may use (packaged Windows apps live under LocalCache). */
function appDataDirs(): string[] {
  const local = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
  const dirs = [join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Claude')];
  const pkgs = join(local, 'Packages');
  if (existsSync(pkgs)) for (const d of readdirSync(pkgs)) if (d.startsWith('Claude_')) dirs.push(join(pkgs, d, 'LocalCache', 'Roaming', 'Claude'));
  // Newer desktop builds keep their data (and the bundled CLI) here instead.
  const data = join(local, 'Claude-Data');
  if (existsSync(data)) for (const d of readdirSync(data)) if (d.startsWith('claude_')) dirs.push(join(data, d));
  return dirs.filter((d) => existsSync(d));
}

/** The newest claude.exe bundled with the desktop app, or one on PATH via CLAUDE_EXE. */
export function findClaudeExe(): string | null {
  if (process.env.CLAUDE_EXE) return existsSync(process.env.CLAUDE_EXE) ? process.env.CLAUDE_EXE : null;
  const found: string[] = [];
  for (const dir of appDataDirs()) {
    const root = join(dir, 'claude-code');
    if (!existsSync(root)) continue;
    for (const version of readdirSync(root)) {
      const vdir = join(root, version);
      if (!statSync(vdir).isDirectory()) continue;
      for (const build of readdirSync(vdir)) {
        const exe = join(vdir, build, process.platform === 'win32' ? 'claude.exe' : 'claude');
        if (existsSync(exe)) found.push(exe);
      }
    }
  }
  found.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return found[0] ?? null;
}

export class ClaudeCodeAdapter implements Adapter {
  readonly info: AgentInfo = { id: 'claude-code', kind: 'claude-code', label: 'Claude Code' };
  private sink!: AdapterSink;
  private exe: string | null;
  private readonly projectsDir = join(homedir(), '.claude', 'projects');
  private meta = new Map<string, Meta>(); // cli session id -> desktop metadata
  private files = new Map<string, string>(); // cli session id -> transcript path
  private readonly known = new Map<string, SessionInfo>();
  private readonly hydrated = new Map<string, Transcript>();
  private readonly uploaded = new Set<string>();
  private readonly runs = new Map<string, ChildProcess>(); // turns we started from the phone
  private readonly dirty = new Set<string>();
  private uiQueue: Promise<void> = Promise.resolve();
  private readonly windowQueues = new Map<string, Promise<boolean>>(); // messages waiting for the window, by conversation
  private readonly asked = new Set<string>(); // button rows a model was asked about
  private learnDay = '';
  private learnCount = 0;
  private readonly asks = new Map<string, PendingAsk>();
  private askSeq = 0;
  // One for every conversation's file: while one of them is written to all the time (a turn running commands writes
  // its progress every moment), the others are still read within a second and a half.
  private readonly flush = debounce(() => void this.refresh(), 600, 1500);
  private readonly relist = debounce(() => void this.refresh(true), 1200, 5000);

  constructor(exe: string | null) {
    this.exe = exe;
  }

  async start(sink: AdapterSink): Promise<void> {
    this.sink = sink;
    if (!existsSync(this.projectsDir)) throw new Error('没有 Claude Code 对话目录');
    try {
      if (installHooks()) log('claude', 'hooks installed in Claude Code settings');
    } catch (error) {
      log('claude', `could not install hooks: ${(error as Error).message}`);
    }
    void this.installTool();
    this.scan();
    for (const id of this.files.keys()) this.known.set(id, this.describe(id));
    sink.projects(this.projectList());
    sink.sessions([...this.known.values()].filter((s) => !this.meta.get(s.threadId)?.archived), true);
    watch(this.projectsDir, { recursive: true }, (_e, name) => {
      const file = name ? String(name) : '';
      if (!file.endsWith('.jsonl')) return;
      const id = basename(file, '.jsonl');
      if (!this.files.has(id)) return this.relist(); // a conversation we have not seen yet
      this.dirty.add(id);
      this.flush();
    });
    for (const dir of appDataDirs()) {
      const metaDir = join(dir, 'claude-code-sessions');
      if (existsSync(metaDir)) watch(metaDir, { recursive: true }, () => this.relist()); // renamed, archived, new
    }
  }

  hydrate(threadId: string): void {
    if (this.hydrated.has(threadId) || !this.files.has(threadId)) return;
    const t = new Transcript(this.files.get(threadId)!);
    t.update();
    this.hydrated.set(threadId, t);
    this.report(threadId, t.recent(HYDRATE_TURNS), t);
  }

  async command(threadId: string, command: Command): Promise<void> {
    const { requestId } = command;
    if (command.op === 'send') {
      // A run of ours still going in this conversation (a message before this one): this one waits its turn, as a
      // message typed into a busy window does, and goes in once that run has ended.
      if (this.runs.has(threadId)) {
        this.sink.receipt(requestId, 'pending', undefined, 'waiting_for_window');
        const until = Date.now() + WINDOW_WAIT_MS;
        while (this.runs.has(threadId) && Date.now() < until) await new Promise((r) => setTimeout(r, 2_000));
        if (this.runs.has(threadId)) return this.sink.receipt(requestId, 'failed', undefined, 'busy');
      }
      const text = withAttachments(command.text ?? '', command.files ?? []);
      // A desktop conversation: always typed into the desktop app itself, as the owner would, which then stays its
      // only writer. A message written behind its back would be unseen there until the app restarts, and fork the
      // conversation. Only with no desktop app running, or a conversation it does not list, does the CLI continue it.
      const title = this.meta.get(threadId)?.title;
      let fallback = false;
      if (title) {
        const sent = await this.sendInWindow(threadId, title, text, requestId, command.origin?.label ?? senderOf(text));
        if (sent) return;
        fallback = true;
      }
      // Otherwise continue it with the CLI.
      // The desktop app updates itself and moves its CLI; look again whenever the one we knew is gone.
      if (!this.exe || !existsSync(this.exe)) this.exe = findClaudeExe();
      if (!this.exe) return this.sink.receipt(requestId, 'failed', undefined, 'claude_not_found');
      const cwd = this.meta.get(threadId)?.cwd ?? this.known.get(threadId)?.cwd ?? undefined;
      // Running right now: a second writer would fork the conversation. Wait for the turn to end.
      if (this.describe(threadId).running) return this.sink.receipt(requestId, 'failed', undefined, 'busy_on_computer');
      // Continue the same conversation, as typing into it would. The message lands in its transcript.
      // Attachments live outside the project folder: let this run read their folders, as dropping a file in would.
      const dirs = [...new Set((command.files ?? []).flatMap((f) => (f.path ? [dirname(f.path)] : [])))].flatMap((d) => ['--add-dir', d]);
      // `desktop_restart`: the desktop app shows this only after it restarts; the phone says so.
      this.runCli(threadId, ['--resume', threadId, ...dirs], cwd, text, requestId, fallback ? 'desktop_restart' : undefined);
      return;
    }
    if (command.op === 'approve') {
      const pending = command.approvalId ? this.asks.get(command.approvalId) : undefined;
      if (!pending || pending.threadId !== threadId) return this.sink.receipt(requestId, 'failed', undefined, 'approval_not_found');
      pending.answer(command.decision ?? 'decline', command.answers);
      return this.sink.receipt(requestId, 'accepted');
    }
    if (command.op === 'interrupt') {
      const child = this.runs.get(threadId);
      // A turn started in the desktop app runs inside the app; only turns started from the phone can be stopped here.
      if (!child) return this.sink.receipt(requestId, 'failed', undefined, 'no_active_turn');
      child.kill();
      return this.sink.receipt(requestId, 'accepted');
    }
    this.sink.receipt(requestId, 'failed', undefined, 'unsupported');
  }

  /**
   * Types the message into the desktop app's window, waiting (and trying again every 8 s, for up to two hours) while
   * that cannot be done right now: the screen is locked, the owner has a draft in the box, the window is busy.
   * Messages for one conversation keep their order. Resolves false when only the CLI can carry it: no desktop app
   * running, or the conversation is not in its list; the receipt is then the caller's.
   */
  private sendInWindow(threadId: string, title: string, text: string, requestId: string, who: string): Promise<boolean> {
    const previous = this.windowQueues.get(threadId) ?? Promise.resolve(true);
    // Only what the conversation took after this message came in can be this message (a little slack for clocks).
    const since = Date.now() - 5_000;
    const run = previous.catch(() => true).then(async () => {
      const deadline = Date.now() + WINDOW_WAIT_MS;
      let told = false;
      let lastReason = '';
      let now = false; // the owner said: send it in now
      for (;;) {
        // Sent already, by the owner pressing Send on what we put in the box, say: done, never a second time.
        if (this.inTranscript(threadId, text, since)) {
          this.sink.receipt(requestId, 'accepted');
          return true;
        }
        // Its turn still running (its transcript says so): wait without going near the window at all, unless the
        // owner said to send it now (the app then queues it for after the turn, as pressing Enter there does).
        let running = false;
        try {
          running = this.files.has(threadId) && this.describe(threadId).running;
        } catch {
          running = false; // being rewritten: let the window tell
        }
        const ui = running && !now ? { ok: false, reason: 'busy' } : await this.desktopSend(title, text, now);
        if (ui.ok) {
          this.sink.receipt(requestId, 'accepted');
          log('claude', `desktop send ok: ${title}`);
          // Typed into another conversation's box (a pane that had not caught up, say), it never shows up here.
          setTimeout(() => {
            if (!this.inTranscript(threadId, text, since)) log('claude', `desktop send: not in ${title}'s transcript 15 s later, it may have gone into another conversation`);
          }, 15_000);
          return true;
        }
        if (CLI_ONLY.has(ui.reason)) {
          log('claude', `desktop send not possible (${ui.reason}): ${title}; using the CLI`);
          return false;
        }
        if (ui.reason === 'ambiguous') {
          // Two conversations of this name in the sidebar: which one to type into is not ours to guess.
          this.sink.receipt(requestId, 'failed', undefined, 'ambiguous_title');
          return true;
        }
        // None of the buttons looked like send: the app changed. Ask the model once which one it is now, then try again.
        if (ui.reason.startsWith('no_send_button') && ui.row?.length && (await this.learnSendButton(ui.row))) continue;
        if (ui.reason !== lastReason) {
          lastReason = ui.reason;
          log('claude', `desktop send waits (${ui.reason}): ${title}`);
        }
        if (!told) {
          told = true;
          this.sink.receipt(requestId, 'pending', undefined, 'waiting_for_window');
        }
        // Waiting on the owner (at the keyboard, a draft in the box, the turn running): the owner hears of it.
        const h = OWNER_WAITS.has(ui.reason) ? hold(requestId, who, title, ui.reason) : null;
        if (Date.now() > deadline) {
          this.sink.receipt(requestId, 'failed', undefined, 'window_unavailable');
          return true;
        }
        // A look at the window every 8 s only (the box is left alone meanwhile), at once when the owner says so.
        for (let i = 0; i < 8 && !(h?.now && !now); i++) await new Promise((r) => setTimeout(r, 1_000));
        now = h?.now ?? now;
      }
    });
    this.windowQueues.set(threadId, run);
    void run.finally(() => {
      release(requestId);
      if (this.windowQueues.get(threadId) === run) this.windowQueues.delete(threadId);
    });
    return run;
  }

  /**
   * The rules for finding the send button failed, the desktop app having changed: ask a model once, with only the
   * names and places of the buttons on the box's row (no picture of the screen), which one sends. An answer that is
   * not one of those names, or names a button that stops, adds or records, is not taken. What it learns is kept, so
   * the next messages need no model. A few times a day at most, each row asked about once.
   */
  private async learnSendButton(row: RowButton[]): Promise<boolean> {
    const names = row.map((b) => b.name).filter(Boolean);
    const key = names.join('|');
    const day = new Date().toDateString();
    if (this.asked.has(key) || (this.learnDay === day && this.learnCount >= 3)) return false;
    this.asked.add(key);
    if (this.learnDay !== day) [this.learnDay, this.learnCount] = [day, 0];
    this.learnCount++;
    if (!this.exe || !existsSync(this.exe)) this.exe = findClaudeExe();
    if (!this.exe) return false;
    const prompt = '下面是一个聊天软件输入框底部那一行的按钮（名字和横向位置）。哪一个是「把输入框里的消息发出去（或排进队列）」的按钮？'
      + '只回答它的名字，原样照抄，不要别的字；都不是就回答 NONE。\n' + row.map((b) => `- ${b.name}（x=${b.x}）`).join('\n');
    const answer = await new Promise<string>((done) => {
      // Saves nothing (no conversation appears anywhere), loads no tools: it only answers.
      const child = spawn(this.exe!, ['-p', '--no-session-persistence', '--model', 'haiku', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
        '--tools', '', '--output-format', 'json'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      child.stdout!.on('data', (d) => (out += d));
      const timer = setTimeout(() => child.kill(), 90_000);
      child.on('exit', () => {
        clearTimeout(timer);
        try {
          done(String(JSON.parse(out).result ?? '').trim());
        } catch {
          done('');
        }
      });
      child.on('error', () => done(''));
      child.stdin!.end(prompt);
    });
    const pick = names.find((n) => n === answer.replace(/^[「"']|[」"']$/g, '').trim());
    if (!pick || /停止|Stop|录音|语音|Voice|添加|Add|附件|Attach/i.test(pick)) {
      log('claude', `send button not learned (answer: ${answer.slice(0, 40)}; row: ${key})`);
      return false;
    }
    saveLearnedUi({ ...learnedUi(), claudeSend: [...new Set([...(learnedUi().claudeSend ?? []), pick])] });
    log('claude', `learned the desktop app's send button: ${pick} (row: ${key})`);
    activity(`Claude 桌面端改版了，AgentChat 学会了新的发送键「${pick}」`);
    return true;
  }

  /**
   * Whether this message is in the conversation already, sent or queued for after the running turn (Claude Code
   * records both), since `since` (ms). Compared spaces aside, by much of its text: messages from agents all begin
   * with the same mark (「[来自 X「对话」的汇报，经 AgentChat 转发] 你派的「…」), so their first words tell nothing apart.
   */
  private inTranscript(threadId: string, text: string, since: number): boolean {
    const file = this.files.get(threadId);
    if (!file) return false;
    // A forwarded message is known by its tag, wherever it stands in what the app wrote down.
    const mark = markTag(text);
    if (mark) return this.locate(mark).includes(threadId);
    const want = text.replace(/\s+/g, '').slice(0, 400);
    if (!want) return false;
    try {
      const size = statSync(file).size;
      const fd = openSync(file, 'r');
      // Generously: a picture read in the turn since takes up megabytes of transcript.
      const buf = Buffer.alloc(Math.min(size, 16 * 1024 * 1024));
      try {
        readSync(fd, buf, 0, buf.length, size - buf.length);
      } finally {
        closeSync(fd);
      }
      for (const line of buf.toString('utf8').split('\n').reverse()) {
        if (!line.includes('"user"') && !line.includes('queue-operation')) continue;
        let r: any;
        try {
          r = JSON.parse(line);
        } catch {
          continue;
        }
        // Read newest first: once the entries are older than the message, it is not there.
        const at = Date.parse(r.timestamp ?? '');
        if (at < since) break;
        const content = r.type === 'queue-operation' ? r.content : r.type === 'user' ? r.message?.content : null;
        // Without what the desktop app puts before a prompt (the page the owner has open beside the chat).
        const said = withoutContext(typeof content === 'string' ? content
          : Array.isArray(content) ? content.map((c: any) => (c?.type === 'text' ? c.text : '')).join('') : '');
        if (said && said.replace(/\s+/g, '').startsWith(want)) return true;
      }
    } catch {
      // being rewritten: look again next time
    }
    return false;
  }

  /**
   * The conversations whose transcript holds a message with this tag, sent or queued for after the running turn
   * (Claude Code records both). Only transcripts written in the last half hour: a message just put in is there.
   */
  locate(tag: string): string[] {
    const out: string[] = [];
    for (const [threadId, file] of this.files) {
      try {
        const { size, mtimeMs } = statSync(file);
        if (mtimeMs < Date.now() - 30 * 60_000) continue;
        const fd = openSync(file, 'r');
        const buf = Buffer.alloc(Math.min(size, 4 * 1024 * 1024));
        try {
          readSync(fd, buf, 0, buf.length, size - buf.length);
        } finally {
          closeSync(fd);
        }
        if (carriesTag(buf.toString('utf8'), tag)) out.push(threadId);
      } catch {
        // being rewritten: looked at again shortly
      }
    }
    return out;
  }

  /** A CLI turn of ours, a question waiting for the phone, or a message waiting for the window. */
  busy(): boolean {
    return this.runs.size > 0 || this.asks.size > 0 || this.windowQueues.size > 0;
  }

  /** One turn with the CLI (`-p`, the message on stdin); reports the message taken once Claude Code answers. */
  private runCli(threadId: string, args: string[], cwd: string | undefined, text: string, requestId: string, note?: string): ChildProcess {
    const child = spawn(this.exe!, ['-p', ...args, '--output-format', 'stream-json', '--verbose'],
      { cwd: cwd && existsSync(cwd) ? cwd : undefined, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.runs.set(threadId, child);
    let accepted = false;
    child.stdout!.on('data', () => {
      if (accepted) return;
      accepted = true;
      this.sink.receipt(requestId, 'accepted', undefined, note);
    });
    let err = '';
    child.stderr!.on('data', (d) => (err = (err + String(d)).slice(-400)));
    child.on('exit', (code) => {
      this.runs.delete(threadId);
      if (!accepted) this.sink.receipt(requestId, 'failed', undefined, (err.trim().split('\n').pop() || `exit ${code}`).slice(0, 200));
      this.dirty.add(threadId);
      this.flush();
    });
    child.on('error', (e) => this.sink.receipt(requestId, 'failed', undefined, e.message));
    // Files are named by their paths on this computer; Claude Code opens them (pictures included) with its own tools.
    child.stdin!.end(text);
    return child;
  }

  /**
   * A new conversation named `title`, started with its first message by the CLI (a Claude Code conversation exists
   * once it has one). The phone sees it at once; the desktop app's own list holds only conversations started there.
   */
  async create(cwd: string, title: string, first?: Command): Promise<{ threadId: string; sent: boolean }> {
    if (!first?.text) throw new Error('Claude Code 新建对话需要第一条消息');
    if (!this.exe || !existsSync(this.exe)) this.exe = findClaudeExe();
    if (!this.exe) throw new Error('claude_not_found');
    cwd ||= homedir();
    const threadId = randomUUID();
    // Attachments live outside the project folder: let the run read their folders, as for any message.
    const dirs = [...new Set((first.files ?? []).flatMap((f) => (f.path ? [dirname(f.path)] : [])))].flatMap((d) => ['--add-dir', d]);
    const child = this.runCli(threadId, ['--session-id', threadId, '--name', title, ...dirs], cwd, withAttachments(first.text, first.files ?? []), first.requestId);
    // Its transcript appears as soon as the run starts; report it before answering, so the hub knows it.
    for (let i = 0; i < 120 && !this.files.has(threadId) && child.exitCode === null; i++) {
      await new Promise((r) => setTimeout(r, 250));
      this.scan();
    }
    this.scan();
    if (!this.files.has(threadId)) throw new Error('Claude Code 没能开始这个对话');
    const info = { ...this.describe(threadId), title };
    this.known.set(threadId, info);
    this.sink.sessions([info], false);
    return { threadId, sent: true };
  }

  /**
   * Registers the AgentChat tool (mcp.ts) as a user-wide MCP server, through Claude Code's own `claude mcp`
   * (its ~/.claude.json is rewritten by Claude Code all the time: never edited here). Only when missing or moved.
   */
  private async installTool(): Promise<void> {
    const want = { type: 'stdio', ...toolCommand(this.info.id), env: {} };
    try {
      const current = JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8'))?.mcpServers?.allinone;
      if (current && current.command === want.command && JSON.stringify(current.args) === JSON.stringify(want.args)) return;
    } catch {
      // no ~/.claude.json yet: claude mcp makes it
    }
    if (!this.exe || !existsSync(this.exe)) this.exe = findClaudeExe();
    if (!this.exe) return;
    const run = (args: string[]) => new Promise<void>((done, fail) => execFile(this.exe!, args, { windowsHide: true, timeout: 60_000 },
      (error, _out, err) => (error ? fail(new Error(String(err || error.message).trim().slice(0, 200))) : done())));
    try {
      await run(['mcp', 'remove', 'allinone', '--scope', 'user']).catch(() => {});
      await run(['mcp', 'add-json', 'allinone', JSON.stringify(want), '--scope', 'user']);
      log('claude', 'AgentChat tool added to Claude Code');
    } catch (error) {
      log('claude', `could not add the AgentChat tool: ${(error as Error).message}`);
    }
  }

  // ---------- permission prompts and questions (from hook.ts) ----------

  /**
   * Claude Code asks for permission, or asks a question (AskUserQuestion). When the owner is away from the keyboard
   * the phone gets a card; its answer is the hook's output. Returns null to leave it to the computer: the owner is
   * at the keyboard or comes back, Claude Code ended the hook (`gone`: answered on the computer), or time ran out.
   */
  async hook(input: any, gone: AbortSignal): Promise<unknown | null> {
    const threadId = String(input?.session_id ?? '');
    const question = input?.hook_event_name === 'PreToolUse' && input.tool_name === 'AskUserQuestion';
    if (!this.sink || !threadId || (!question && input?.hook_event_name !== 'PermissionRequest')) return null;
    if (!this.files.has(threadId)) this.scan();
    if (!this.files.has(threadId) || (await idleMs()) < AWAY_MS || gone.aborted) return null;
    const tool = String(input.tool_name ?? '');
    const args = (input.tool_input ?? {}) as Record<string, any>;
    const approvalId = `cl${Date.now().toString(36)}${(this.askSeq++).toString(36)}`;
    const qs = question ? (Array.isArray(args.questions) ? args.questions : []).map((q: any, i: number) => ({ key: `q${i}`, text: String(q.question ?? ''),
      title: String(q.header ?? ''), description: String(q.question ?? ''), custom: true,
      options: (Array.isArray(q.options) ? q.options : []).map((o: any) => ({ value: String(o.label), label: String(o.label), description: String(o.description ?? '') })) })) : [];
    if (question && !qs.length) return null;
    const data: Record<string, unknown> = question
      ? { kind: 'question', questions: qs.map(({ text: _t, ...q }: any) => q), command: null, cwd: null, reason: qs[0].description }
      : tool === 'Bash' || tool === 'PowerShell' ? { kind: 'command', command: String(args.command ?? ''), cwd: input.cwd ?? null, reason: args.description ?? null }
        : /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool) ? { kind: 'file', command: String(args.file_path ?? args.notebook_path ?? ''), cwd: input.cwd ?? null, reason: null }
          : tool.startsWith('mcp__') ? { kind: 'mcp', command: `${tool}\n${JSON.stringify(args).slice(0, 300)}`, cwd: null, reason: '插件工具' }
            : { kind: 'command', command: `${tool} ${JSON.stringify(args).slice(0, 300)}`, cwd: input.cwd ?? null, reason: null };
    const item: Item = { itemId: `approval:${approvalId}`, turnId: null, kind: 'approval_request', ts: Date.now(), data: { approvalId, ...data, state: 'pending' } };
    return new Promise((resolve) => {
      const finish = (output: unknown | null, state: string, answer?: string) => {
        if (!this.asks.delete(approvalId)) return;
        clearTimeout(timer);
        clearInterval(watcher);
        item.data = { ...item.data, state, ...(answer ? { answer } : {}) };
        this.sink.items(threadId, [item]);
        resolve(output);
      };
      const timer = setTimeout(() => finish(null, 'elsewhere'), HOOK_WAIT_MS);
      gone.addEventListener('abort', () => finish(null, 'elsewhere'));
      // Back at the keyboard: hand it to the computer (a question shows there only once the hook is done).
      const watcher = setInterval(() => void idleMs().then((ms) => ms < BACK_MS && finish(null, 'elsewhere')), 3000);
      this.asks.set(approvalId, { threadId, item, answer: (decision, answers) => {
        const accept = decision === 'accept';
        if (!question) {
          return finish({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: accept ? { behavior: 'allow' }
            : { behavior: 'deny', message: '在手机上被拒绝' } } }, accept ? 'accepted' : 'declined');
        }
        if (!accept || !answers) {
          return finish({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: '用户在手机上选择不回答' } }, 'cancelled');
        }
        // Claude Code takes the answers keyed by each question's text.
        const byText = Object.fromEntries(qs.filter((q: any) => answers[q.key]).map((q: any) => [q.text, answers[q.key]]));
        finish({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { ...args, answers: byText } } },
          'answered', Object.values(byText).join('；'));
      } });
      log('claude', `${question ? 'question' : 'permission'} sent to the phone (${tool})`);
      this.sink.items(threadId, [item]);
    });
  }

  /** One at a time: each send drives the same desktop window. */
  private desktopSend(title: string, text: string, now = false): Promise<{ ok: boolean; reason: string; row?: RowButton[] }> {
    const run = this.uiQueue.then(() => new Promise<{ ok: boolean; reason: string; row?: RowButton[] }>((resolve) => {
      const payload = Buffer.from(JSON.stringify({ title, text, now, sendNames: learnedUi().claudeSend }), 'utf8').toString('base64');
      // On stdin, not the command line: a long message would not fit there (spawn ENAMETOOLONG).
      const child = execFile('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', DESKTOP_SEND],
        { windowsHide: true, timeout: 60_000 }, (error, stdout, stderr) => {
          try {
            resolve(JSON.parse(String(stdout).trim().split('\n').pop() || ''));
          } catch {
            // It may well have sent: the transcript tells on the next look. What it said instead, to find out why.
            if (!error) log('claude', `desktop send gave no answer: ${JSON.stringify(String(stdout).slice(-200))} ${JSON.stringify(String(stderr).slice(-200))}`);
            resolve({ ok: false, reason: error?.message.slice(0, 120) ?? 'no_answer' });
          }
        });
      child.stdin?.end(payload);
    }));
    this.uiQueue = run.then(() => undefined);
    return run;
  }

  // ---------- reading ----------

  /** Desktop metadata plus every transcript on disk (conversations started in a terminal have no metadata). */
  private scan(): void {
    const meta = new Map<string, Meta>();
    for (const dir of appDataDirs()) {
      const root = join(dir, 'claude-code-sessions');
      if (!existsSync(root)) continue;
      for (const org of readdirSync(root)) {
        const orgDir = join(root, org);
        if (!statSync(orgDir).isDirectory()) continue;
        for (const user of readdirSync(orgDir)) {
          const userDir = join(orgDir, user);
          if (!statSync(userDir).isDirectory()) continue;
          for (const f of readdirSync(userDir)) {
            if (!f.startsWith('local_') || !f.endsWith('.json')) continue;
            try {
              const j = JSON.parse(readFileSync(join(userDir, f), 'utf8'));
              if (typeof j.cliSessionId === 'string') {
                meta.set(j.cliSessionId, { cliSessionId: j.cliSessionId, cwd: j.cwd ?? null, title: j.title ?? null,
                  archived: Boolean(j.isArchived), activity: Number(j.lastActivityAt) || 0 });
              }
            } catch {
              // being rewritten; next change event reads it again
            }
          }
        }
      }
    }
    const files = new Map<string, string>();
    for (const folder of readdirSync(this.projectsDir)) {
      const dir = join(this.projectsDir, folder);
      if (!statSync(dir).isDirectory()) continue;
      for (const f of readdirSync(dir)) if (f.endsWith('.jsonl')) files.set(basename(f, '.jsonl'), join(dir, f));
    }
    this.meta = meta;
    this.files = files;
  }

  private describe(id: string): SessionInfo {
    const file = this.files.get(id)!;
    const m = this.meta.get(id);
    const { preview, running, title } = peek(file);
    const mtime = statSync(file).mtimeMs;
    const live = this.runs.has(id) || (running && Date.now() - mtime < RUNNING_WINDOW_MS);
    const cwd = m?.cwd ?? this.cwdFromFile(file);
    const folder = cwd ? basename(cwd) : null;
    return { threadId: id, agentId: this.info.id, title: (m?.title || title || preview || '未命名对话').slice(0, 120), cwd,
      updatedAt: Math.floor(mtime / 1000), running: live, activeTurnId: live ? `run:${id}` : null, preview,
      projectId: folder ? `dir:${cwd!.toLowerCase()}` : null, projectName: folder, pinned: false };
  }

  /** Conversations started in a terminal have no desktop metadata: take the folder from the first records. */
  private cwdFromFile(file: string): string | null {
    try {
      const fd = openSync(file, 'r');
      const buf = Buffer.alloc(64 * 1024);
      const n = readSync(fd, buf, 0, buf.length, 0);
      closeSync(fd);
      return /"cwd":"((?:[^"\\]|\\.)*)"/.exec(buf.toString('utf8', 0, n))?.[1]?.replace(/\\\\/g, '\\') ?? null;
    } catch {
      return null;
    }
  }

  /** Projects are working folders, most recently used first (as the Code tab groups them). */
  private projectList(): ProjectInfo[] {
    const byId = new Map<string, { name: string; at: number }>();
    for (const s of this.known.values()) {
      if (!s.projectId || this.meta.get(s.threadId)?.archived) continue;
      const p = byId.get(s.projectId);
      if (!p || p.at < s.updatedAt) byId.set(s.projectId, { name: s.projectName ?? '', at: s.updatedAt });
    }
    return [...byId.entries()].sort((a, b) => b[1].at - a[1].at).map(([id, p]) => ({ id, name: p.name }));
  }

  private async refresh(relist = false): Promise<void> {
    try {
      if (relist) this.scan();
      const ids = relist ? [...this.files.keys()] : [...this.dirty];
      this.dirty.clear();
      const changed: SessionInfo[] = [];
      for (const id of ids) {
        if (!this.files.has(id)) continue;
        const s = this.describe(id);
        this.known.set(id, s);
        if (!this.meta.get(id)?.archived) changed.push(s);
        const t = this.hydrated.get(id);
        if (t) this.report(id, t.update(), t);
      }
      if (relist) {
        for (const id of [...this.known.keys()]) if (!this.files.has(id)) this.known.delete(id);
        this.sink.projects(this.projectList());
        this.sink.sessions([...this.known.values()].filter((s) => !this.meta.get(s.threadId)?.archived), true);
      } else if (changed.length) {
        this.sink.sessions(changed, false);
      }
    } catch (error) {
      log('claude', `refresh failed: ${(error as Error).message}`);
    }
  }

  private report(threadId: string, items: ReturnType<Transcript['update']>, t: Transcript): void {
    for (let i = 0; i < items.length; i += 200) this.sink.items(threadId, items.slice(i, i + 200));
    // Files Claude wrote inside the conversation's folder are its outputs.
    const cwd = this.known.get(threadId)?.cwd?.toLowerCase();
    for (const w of t.writes) {
      if (this.uploaded.has(w.itemId) || !cwd || !w.path.toLowerCase().startsWith(cwd)) continue;
      this.uploaded.add(w.itemId);
      this.sink.artifact(threadId, w.itemId, w.turnId, w.path);
    }
    // Pictures pasted into a prompt: the phone shows them as pictures, not "[图片]".
    for (const p of t.pasted) {
      if (this.uploaded.has(p.itemId)) continue;
      this.uploaded.add(p.itemId);
      const ext = p.mime.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png';
      this.sink.artifactData(threadId, p.itemId, p.turnId, `图片.${ext}`, p.mime, Buffer.from(p.data, 'base64'), true);
    }
  }
}
