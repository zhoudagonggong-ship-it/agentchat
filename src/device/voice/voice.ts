// Voice input on this computer: runs voice.ps1 (hotkey, recording, the status box, pasting) in the owner's desktop
// session and passes its lines to and from the hub. A recording made here is recognized here, by a local SenseVoice
// service (started on demand: as soon as listening begins, so it is warm by the time the owner stops speaking).
// How it goes is shown on the computer spoken to (through the hub), which may be this one.
// One helper per program; restarted if it stops. Windows only, and only under the tray (a console run has no
// desktop of its own to show the box on).
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { DeviceToHub, HubToDevice, VoiceTone } from '../../shared/protocol.ts';
import { log } from '../../shared/util.ts';

const SCRIPT = join(import.meta.dirname, 'voice.ps1');
/** The recognizer: SenseVoice-Small behind a small local HTTP service (see the SenseVoice setup on the microphone computer). */
const ASR_START = process.env.ALLINONE_ASR ?? 'D:\\Tools\\SenseVoice\\run.cmd';
const ASR_URL = 'http://127.0.0.1:18860';
const ASR_START_MS = 180_000; // loading the model the first time can take a while

export class Voice {
  private child: ChildProcessWithoutNullStreams | null = null;
  private backoff = 2000;
  private stopped = false;
  /** Lines from the helper for the hub. */
  onMessage: (msg: Extract<DeviceToHub, { t: 'voice' }>) => void = () => {};

  start(): void {
    if (process.platform !== 'win32' || this.child || this.stopped) return;
    const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    const started = Date.now();
    child.stdout.setEncoding('utf8');
    createInterface({ input: child.stdout }).on('line', (line) => this.fromHelper(line));
    let err = '';
    child.stderr.on('data', (d) => (err = (err + String(d)).slice(-400)));
    child.on('exit', (code) => {
      this.child = null;
      if (this.stopped) return;
      if (Date.now() - started > 60_000) this.backoff = 2000; // it ran fine for a while: a fresh start
      log('voice', `helper stopped (${code}); again in ${this.backoff / 1000}s ${err.trim().split('\n').pop() ?? ''}`);
      setTimeout(() => this.start(), this.backoff).unref();
      this.backoff = Math.min(this.backoff * 2, 5 * 60_000);
    });
    child.on('error', (e) => log('voice', `helper did not start: ${e.message}`));
  }

  stop(): void {
    this.stopped = true;
    this.child?.kill();
    this.asr?.kill();
  }

  /** What the hub asks of this computer. */
  toHelper(msg: Extract<HubToDevice, { t: 'voice' }>): void {
    const { t: _t, ...rest } = msg;
    // The helper reads plain strings only, and has no use for the recognizer's context.
    if (msg.op === 'listen') this.write({ op: 'listen' });
    else this.write(msg.op === 'show' ? { ...rest, done: msg.done ? '1' : '' } : rest);
    if (msg.op === 'listen') {
      this.context = msg.context ?? '';
      this.chain = Promise.resolve([]);
      this.take++;
      void this.recognizer(); // warm it up while the owner speaks
    }
  }

  /** Words and background from the hub for the recognition of what is being said now. */
  private context = '';

  private write(cmd: Record<string, unknown>): void {
    if (!this.child) return void log('voice', `no helper for ${cmd.op}`);
    this.child.stdin.write(JSON.stringify(cmd) + '\n');
  }

  // ---------- recognition ----------

  private asr: ChildProcess | null = null;
  private asrReady: Promise<boolean> | null = null;

  private async healthy(): Promise<boolean> {
    try {
      return (await fetch(`${ASR_URL}/health`, { signal: AbortSignal.timeout(1500) })).ok;
    } catch {
      return false;
    }
  }

  /** The local recognition service, started if it is not running. Resolves false when there is none to start. */
  private recognizer(): Promise<boolean> {
    this.asrReady ??= (async () => {
      if (await this.healthy()) return true;
      if (!existsSync(ASR_START)) return false;
      if (!this.asr) {
        log('voice', `starting the recognizer: ${ASR_START}`);
        const child = spawn('cmd.exe', ['/c', ASR_START], { windowsHide: true, stdio: 'ignore' });
        this.asr = child;
        child.on('exit', (code) => {
          log('voice', `recognizer stopped (${code})`);
          this.asr = null;
          this.asrReady = null;
        });
      }
      const until = Date.now() + ASR_START_MS;
      while (Date.now() < until) {
        if (await this.healthy()) return true;
        await new Promise((r) => setTimeout(r, 1000));
      }
      return false;
    })().then((ok) => {
      if (!ok) this.asrReady = null; // try again next time
      return ok;
    });
    return this.asrReady;
  }

  /** For the box on the computer spoken to. */
  private status(text: string, tone: VoiceTone, done?: boolean): void {
    this.onMessage({ t: 'voice', op: 'status', text, tone, done });
  }

  // What the owner says comes in pieces, cut where they pause (to think, say): each is recognized while they go on
  // speaking, one after the other (a piece is told the text before it), and the whole is sent once they let go.
  private chain: Promise<string[]> = Promise.resolve([]);
  private take = 0; // which listening the pieces belong to

  /** A piece of the recording (`path` empty: nothing more was said); `last`: the owner let go. */
  private piece(path: string, last: boolean): void {
    const take = this.take;
    const mine = this.chain.then(async (texts) => {
      if (!path) return texts;
      const text = await this.recognizeFile(path, texts.join(''));
      return text ? [...texts, text] : texts;
    });
    mine.catch(() => {}); // a failure is reported once, with the last piece
    this.chain = mine;
    if (last) void this.deliver(mine, take);
  }

  /** All pieces recognized: the text goes to the hub for the computer spoken to. */
  private async deliver(pieces: Promise<string[]>, take: number): Promise<void> {
    try {
      const text = joinPieces(await pieces);
      if (take !== this.take) return; // the owner already speaks again
      if (!text) {
        this.status('没听清，再说一次', 'busy', true);
        return this.onMessage({ t: 'voice', op: 'cancel' });
      }
      this.status(`已送出：${text.length > 24 ? text.slice(0, 24) + '…' : text}`, 'ok', true);
      this.onMessage({ t: 'voice', op: 'text', text: text.slice(0, 20_000) });
    } catch (error) {
      log('voice', `recognition failed: ${(error as Error).message}`);
      this.asrReady = null;
      this.status(`识别失败：${(error as Error).message}`, 'bad', true);
      this.onMessage({ t: 'voice', op: 'cancel' });
    }
  }

  /** One piece recognized by the local service; `before`: what was said before it, which helps it along. */
  private async recognizeFile(path: string, before: string): Promise<string> {
    const started = Date.now();
    try {
      if (!(await this.healthy())) {
        this.status(existsSync(ASR_START) ? '正在启动识别服务…（第一次要多等一会儿）' : '识别中…', 'busy');
        if (!(await this.recognizer())) throw new Error(existsSync(ASR_START) ? '识别服务没能启动' : '麦克风那台电脑还没装语音识别服务（SenseVoice）');
      }
      const audio = await readFile(path);
      // Words only (sentences get read back on near-silence): the names in what was said just before join the list.
      const known = this.context.toLowerCase();
      const earlier = [...new Set(before.match(/[A-Za-z][A-Za-z0-9]*(?:[._+-][A-Za-z0-9]+)*/g) ?? [])].filter((w) => w.length >= 3 && !known.includes(w.toLowerCase()));
      const context = earlier.length ? `${this.context || '热词：'}${this.context ? ', ' : ''}${earlier.join(', ')}` : this.context;
      const ask = async (withContext: boolean): Promise<string> => {
        // The context rides in a header (URL-encoded); a recognizer that does not use it ignores it.
        const headers: Record<string, string> = { 'Content-Type': 'audio/wav' };
        if (withContext && context) headers['X-ASR-Context'] = encodeURIComponent(context);
        const res = await fetch(`${ASR_URL}/recognize`, { method: 'POST', headers, body: audio, signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const answer = (await res.json()) as { text?: string; ms?: number };
        const text = String(answer.text ?? '').trim();
        log('voice', `recognized ${audio.length} bytes in ${answer.ms ?? '?'} ms (${Date.now() - started} ms here${withContext && context ? ', with context' : ''}): ${text.length} chars`);
        return text;
      };
      let text = await ask(true);
      // The recognizer reads its context back when it hears no one (more than anyone says in that time, or the list
      // itself): again without it; still too much, and nothing was said. A lone 嗯 is not something to type either.
      if (context && (!plausible(text, audio.length) || text.includes('热词'))) text = await ask(false);
      if (!plausible(text, audio.length) || /^[\s\p{P}嗯啊呃哦唔噢额]*$/u.test(text)) {
        if (text) log('voice', `dropped ${text.length} chars heard in ${((audio.length - 44) / 32000).toFixed(1)} s`);
        return '';
      }
      return text;
    } finally {
      await rm(path, { force: true }).catch(() => {});
    }
  }

  private fromHelper(line: string): void {
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(line.replace(/^﻿/, ''));
    } catch {
      return void (line.trim() && log('voice', line.trim().slice(0, 200)));
    }
    if (m.op === 'log') return void log('voice', String(m.text ?? '').slice(0, 300));
    if (m.op === 'key') this.onMessage({ t: 'voice', op: 'key', fgProc: String(m.fgProc ?? ''), fgTitle: String(m.fgTitle ?? '').slice(0, 300) });
    else if (m.op === 'release') this.onMessage({ t: 'voice', op: 'release' });
    else if (m.op === 'status') this.status(String(m.text ?? ''), m.tone === 'ok' || m.tone === 'bad' ? m.tone : 'busy', m.done === true);
    else if (m.op === 'audio') this.piece(String(m.path ?? ''), m.last === true);
    else if (m.op === 'cancel') this.onMessage({ t: 'voice', op: 'cancel' });
  }
}

/** Whether `text` can have been said in a 16 kHz 16-bit mono WAV of `bytes`: fast speech is some 6 characters a second. */
export function plausible(text: string, bytes: number): boolean {
  const seconds = Math.max(0, bytes - 44) / 32000;
  return text.length <= seconds * 10 + 6;
}

/** The pieces as one text: a space only between two that meet in Latin letters or digits. */
export function joinPieces(pieces: string[]): string {
  return pieces.reduce((all, p) => (all && /[A-Za-z0-9]$/.test(all) && /^[A-Za-z0-9]/.test(p) ? `${all} ${p}` : all + p), '');
}
