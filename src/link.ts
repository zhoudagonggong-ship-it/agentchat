// How a device talks to the hub: over a WebSocket when the hub is another machine,
// or directly in-process when this machine is the hub. Both look the same to the device.
import { lookup } from 'node:dns/promises';
import { connect } from 'node:net';
import type { DeviceToHub, HubToDevice } from './shared/protocol.ts';
import { log, parseJson } from './shared/util.ts';

export interface Transport {
  send(msg: DeviceToHub): void;
  /** Set by the device before `start()`. */
  handlers: { message(msg: HubToDevice): void; connected(): void; disconnected(reason?: string): void };
  start(): void;
  readonly connected: boolean;
}

const SILENCE_LIMIT_MS = 75_000; // the hub sends a tick every 30 s
const MAX_BACKOFF_MS = 30_000;

/** Native WebSocket client with reconnect and silence detection. */
export class WsTransport implements Transport {
  handlers: Transport['handlers'] = { message() {}, connected() {}, disconnected() {} };
  private ws: WebSocket | null = null;
  private backoff = 1000;
  private lastHeard = 0;
  private watchdog: NodeJS.Timeout | null = null;
  private url: string;

  constructor(url: string) {
    this.url = url;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  start(): void {
    this.open();
    this.watchdog = setInterval(() => {
      if (this.connected && Date.now() - this.lastHeard > SILENCE_LIMIT_MS) {
        log('link', 'hub silent, reconnecting');
        this.ws?.close();
      }
    }, 15_000);
  }

  send(msg: DeviceToHub): void {
    if (this.connected) this.ws!.send(JSON.stringify(msg));
  }

  private open(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 1000;
      this.lastHeard = Date.now();
      log('link', 'connected to hub');
      this.handlers.connected();
    };
    ws.onmessage = (event) => {
      this.lastHeard = Date.now();
      const msg = parseJson<HubToDevice>(String(event.data));
      if (msg) this.handlers.message(msg);
    };
    let opened = false;
    ws.addEventListener('open', () => (opened = true));
    ws.onclose = async () => {
      if (this.ws !== ws) return;
      this.ws = null;
      // Never got through: find out why (the WebSocket error itself carries no detail).
      const reason = opened ? '' : await diagnose(this.url);
      if (reason !== this.lastReason && reason) log('link', `cannot reach the hub: ${reason}`); // once per cause, not every retry
      this.lastReason = reason;
      this.handlers.disconnected(reason || undefined);
      const wait = this.backoff;
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
      setTimeout(() => this.open(), wait);
    };
    ws.onerror = () => {
      // onclose follows and schedules the reconnect
    };
  }

  private lastReason = '';
}

/** Why the hub cannot be reached, in words the owner can act on: name, then port, then the connection itself. */
async function diagnose(url: string): Promise<string> {
  const { hostname, port, protocol } = new URL(url);
  try {
    await lookup(hostname);
  } catch {
    return '找不到主电脑的地址：请在这台电脑的 Tailscale 里打开「使用 Tailscale DNS」';
  }
  const reachable = await new Promise<boolean>((resolve) => {
    const socket = connect({ host: hostname, port: Number(port) || (protocol === 'wss:' ? 443 : 80), timeout: 5000 });
    socket.once('connect', () => (socket.destroy(), resolve(true)));
    socket.once('timeout', () => (socket.destroy(), resolve(false)));
    socket.once('error', () => resolve(false));
  });
  if (!reachable) return '主电脑没有响应：主电脑那台电脑可能关机、睡眠、不在线，或程序没在运行';
  return '能连到主电脑那台电脑，但连接被拒绝（Tailscale 账号不同，或主电脑的 HTTPS 没有发布）';
}

/** In-process link used when the device runs inside the hub. `deliver` is wired by the hub. */
export class LocalTransport implements Transport {
  handlers: Transport['handlers'] = { message() {}, connected() {}, disconnected() {} };
  connected = false;
  private toHub: (msg: DeviceToHub) => void;

  constructor(toHub: (msg: DeviceToHub) => void) {
    this.toHub = toHub;
  }

  start(): void {
    this.connected = true;
    queueMicrotask(() => this.handlers.connected());
  }

  send(msg: DeviceToHub): void {
    // Copy through JSON so both sides never share mutable objects, exactly like the wire.
    queueMicrotask(() => this.toHub(JSON.parse(JSON.stringify(msg)) as DeviceToHub));
  }

  deliver(msg: HubToDevice): void {
    queueMicrotask(() => this.handlers.message(JSON.parse(JSON.stringify(msg)) as HubToDevice));
  }
}
