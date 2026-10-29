// JSON-RPC client for a private `codex app-server` over stdio (one JSON message per line).
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { log } from '../../shared/util.ts';

const run = promisify(execFile);
type Id = number | string;
interface RpcMessage { id?: Id; method?: string; params?: unknown; result?: unknown; error?: { code?: number; message?: string } }

export interface RpcHandlers {
  notification(method: string, params: any): void;
  /** A request from the server (approvals and the like); resolve with the result to send back. */
  request(method: string, params: any, id: Id): Promise<unknown>;
  /** The server process restarted; previously loaded threads must be resumed again. */
  restarted(): void;
}

export class RpcError extends Error {
  readonly code: number | undefined;
  constructor(message: string, code?: number) {
    super(message);
    this.code = code;
  }
}

export class CodexRpc {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<Id, { resolve(v: unknown): void; reject(e: Error): void; timer: NodeJS.Timeout }>();
  private ready: Promise<void> | null = null;
  private stopped = false;
  private backoff = 1000;
  private readonly exe: string;
  private readonly handlers: RpcHandlers;
  private readonly pidFile: string | null;

  constructor(exe: string, handlers: RpcHandlers, pidFile: string | null = null) {
    this.exe = exe;
    this.handlers = handlers;
    this.pidFile = pidFile;
  }

  start(): Promise<void> {
    // A failed launch must not stick: close the half-started process so the next call tries again.
    this.ready ??= this.launch().catch((error: Error) => {
      const child = this.child;
      this.child = null;
      this.ready = null;
      child?.kill();
      throw error;
    });
    return this.ready;
  }

  stop(): void {
    this.stopped = true;
    this.child?.kill();
  }

  /**
   * Closes the app-server on purpose; the next call starts a fresh one. An app-server keeps every conversation it
   * ran a turn in to itself until it exits (`thread/unsubscribe` does not let go of it), and the desktop app cannot
   * continue such a conversation meanwhile.
   */
  recycle(): void {
    if (!this.child) return;
    this.recycling = true;
    this.child.kill();
  }
  private recycling = false;

  async call<T = any>(method: string, params: unknown, timeoutMs = 60_000): Promise<T> {
    await this.start();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError(`timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.write({ id, method, params });
    });
  }

  private write(msg: RpcMessage): void {
    this.child?.stdin.write(JSON.stringify(msg) + '\n');
  }

  private async launch(): Promise<void> {
    await this.reapLeftover();
    const child = spawn(this.exe, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;
    if (this.pidFile && child.pid) writeFileSync(this.pidFile, String(child.pid));
    createInterface({ input: child.stdout }).on('line', (line) => this.onLine(line));
    child.stderr.on('data', () => {}); // diagnostics are noisy; failures surface as RPC errors
    child.on('exit', (code) => {
      if (this.child !== child) return;
      this.child = null;
      this.ready = null;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new RpcError('codex app-server exited'));
      }
      this.pending.clear();
      if (this.stopped) return;
      if (this.recycling) {
        this.recycling = false;
        return; // started again by the next call
      }
      log('codex', `app-server exited (${code}); restarting in ${this.backoff / 1000}s`);
      setTimeout(() => {
        this.start().then(() => this.handlers.restarted(), () => {});
      }, this.backoff);
      this.backoff = Math.min(this.backoff * 2, 60_000);
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    const id = this.nextId++;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new RpcError('timeout: initialize')), 90_000);
      this.pending.set(id, { resolve: () => resolve(), reject, timer });
      this.write({ id, method: 'initialize', params: { clientInfo: { name: 'allinone', title: 'AllinOne', version: '0.1.0' } } });
    });
    this.write({ method: 'initialized' });
    this.backoff = 1000;
  }

  /**
   * A force-killed program leaves its app-server behind (Windows does not end child processes).
   * Close the one we started last time, after checking it really is a bare `codex.exe app-server`.
   */
  private async reapLeftover(): Promise<void> {
    if (!this.pidFile || !existsSync(this.pidFile) || process.platform !== 'win32') return;
    const pid = Number(readFileSync(this.pidFile, 'utf8'));
    rmSync(this.pidFile, { force: true });
    if (!Number.isInteger(pid) || pid <= 0) return;
    try {
      const { stdout } = await run('powershell.exe', ['-NoProfile', '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { windowsHide: true, timeout: 20_000 });
      if (/codex\.exe"?\s+app-server\s*$/i.test(stdout.trim())) {
        process.kill(pid);
        log('codex', `closed the app-server left over from the last run (${pid})`);
      }
    } catch {
      // nothing to clean up
    }
  }

  private onLine(line: string): void {
    let msg: RpcMessage;
    try {
      msg = JSON.parse(line) as RpcMessage;
    } catch {
      return;
    }
    if (msg.method && msg.id !== undefined) {
      const id = msg.id;
      this.handlers.request(msg.method, msg.params, id).then(
        (result) => this.write({ id, result }),
        (error: Error) => this.write({ id, error: { code: -32000, message: error.message } } as RpcMessage),
      );
    } else if (msg.method) {
      this.handlers.notification(msg.method, msg.params);
    } else if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new RpcError(msg.error.message ?? 'rpc error', msg.error.code));
      else p.resolve(msg.result);
    }
  }
}
