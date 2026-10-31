// The simulator's world: one hub, a few computers each running AgentChat's Device with simulated agents, and the
// network between them, all in one process on a simulated clock. The hub and the Device are AgentChat's own code;
// only the network, the agents' apps and the clock are made up, and each can be made to misbehave.
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock } from 'node:test';
import { Hub } from '../../src/hub/hub.ts';
import { Device } from '../../src/device/device.ts';
import { onActivity } from '../../src/activity.ts';
import type { Transport } from '../../src/link.ts';
import type { DeviceToHub, HubToDevice } from '../../src/shared/protocol.ts';
import { sessionKey } from '../../src/shared/protocol.ts';
import { CALM, SimAdapter, type AgentApp, type WindowChaos } from './agent.ts';
import { Rng } from './rng.ts';

/** The network's mischief: how slow, how often a connection breaks, how long a crashed program stays down. */
export interface Chaos {
  latencyMs: [number, number];
  /** Mean time between a connection breaking (0: never). */
  cutEveryMs: number;
  /** Mean time between the hub crashing, and between one computer's AgentChat crashing (0: never). */
  hubCrashEveryMs: number;
  deviceCrashEveryMs: number;
  downMs: [number, number];
  window: WindowChaos;
}

export const QUIET: Chaos = { latencyMs: [5, 40], cutEveryMs: 0, hubCrashEveryMs: 0, deviceCrashEveryMs: 0, downMs: [2_000, 20_000], window: CALM };

export interface Alarm { at: number; text: string }

/** What the program on one side of a connection writes: the hub's end looks like a `ws` WebSocket. */
class HubEnd extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  private readonly link: Link;
  constructor(link: Link) {
    super();
    this.link = link;
  }
  send(raw: string): void {
    this.link.toDevice(raw);
  }
  ping(): void {
    this.link.ping();
  }
  terminate(): void {
    this.link.cut('terminated by the hub');
  }
  close(): void {
    this.link.cut('closed by the hub');
  }
}

/** One connection between a computer and the hub: in order, with delay; when it breaks, what was on the way is lost. */
class Link {
  up = true;
  readonly hubEnd: HubEnd;
  private toHubAt = 0;
  private toDeviceAt = 0;
  private readonly world: World;
  private readonly computer: Computer;
  constructor(world: World, computer: Computer) {
    this.world = world;
    this.computer = computer;
    this.hubEnd = new HubEnd(this);
  }
  private later(last: 'toHubAt' | 'toDeviceAt'): number {
    const at = Math.max(this[last], Date.now() + this.world.rng.between(...this.world.chaos.latencyMs));
    this[last] = at;
    return at - Date.now();
  }
  toHub(msg: DeviceToHub): void {
    if (!this.up) return;
    const raw = JSON.stringify(msg);
    setTimeout(() => this.up && this.hubEnd.emit('message', raw), this.later('toHubAt'));
  }
  toDevice(raw: string): void {
    if (!this.up) return;
    setTimeout(() => this.up && this.computer.transport.handlers.message(JSON.parse(raw) as HubToDevice), this.later('toDeviceAt'));
  }
  ping(): void {
    if (this.up) setTimeout(() => this.up && this.hubEnd.emit('pong'), this.later('toDeviceAt'));
  }
  cut(reason: string): void {
    if (!this.up) return;
    this.up = false;
    this.hubEnd.readyState = 3;
    this.hubEnd.emit('close');
    if (this.computer.link === this) {
      this.computer.link = null;
      this.computer.transport.connected = false;
      this.computer.transport.handlers.disconnected(reason);
      this.world.reconnectLater(this.computer);
    }
  }
}

class SimTransport implements Transport {
  handlers: Transport['handlers'] = { message() {}, connected() {}, disconnected() {} };
  connected = false;
  private readonly world: World;
  private readonly computer: Computer;
  constructor(world: World, computer: Computer) {
    this.world = world;
    this.computer = computer;
  }
  start(): void {
    this.world.reconnectLater(this.computer, 0);
  }
  send(msg: DeviceToHub): void {
    this.computer.link?.toHub(msg);
  }
}

export class Computer {
  readonly id: string;
  readonly dir: string;
  readonly name: string;
  readonly apps: AgentApp[];
  device: Device | null = null;
  transport!: SimTransport;
  link: Link | null = null;
  adapters: SimAdapter[] = [];
  constructor(name: string, apps: AgentApp[], root: string) {
    this.name = name;
    this.apps = apps;
    this.id = `dev-${name}`;
    this.dir = join(root, name);
    mkdirSync(this.dir, { recursive: true });
  }
  conv(app: AgentApp, threadId: string): string {
    return sessionKey(this.id, app.kind.info.id, threadId);
  }
}

/** Makes a dead program inert: whatever it still had scheduled does nothing (a crashed process acts no more). */
function kill(target: object, fields: string[]): void {
  let proto = Object.getPrototypeOf(target);
  while (proto && proto !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name !== 'constructor' && typeof (target as any)[name] === 'function') (target as any)[name] = () => undefined;
    }
    proto = Object.getPrototypeOf(proto);
  }
  const inert: any = new Proxy({}, { get: () => () => inert });
  for (const f of fields) {
    try {
      (target as any)[f]?.db?.close?.();
      (target as any)[f]?.close?.();
    } catch {
      // already closed
    }
    (target as any)[f] = inert;
  }
}

export class World {
  readonly rng: Rng;
  readonly chaos: Chaos;
  readonly computers: Computer[] = [];
  readonly alarms: Alarm[] = [];
  readonly root: string;
  hub: Hub | null = null;
  private stopActivity: () => void = () => {};
  private log = console.log;

  constructor(seed: number, chaos: Chaos = QUIET) {
    this.rng = new Rng(seed);
    this.chaos = chaos;
    this.root = mkdtempSync(join(tmpdir(), 'agentchat-sim-'));
  }

  add(name: string, apps: AgentApp[]): Computer {
    const c = new Computer(name, apps, this.root);
    this.computers.push(c);
    return c;
  }

  async boot(): Promise<void> {
    console.log = () => {};
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-11-02T01:00:00Z') });
    this.stopActivity = onActivity((a) => a.level === 'warn' && this.alarms.push({ at: a.at, text: a.text }));
    this.startHub();
    for (const c of this.computers) await this.startDevice(c);
    if (this.chaos.hubCrashEveryMs) this.every(this.chaos.hubCrashEveryMs, () => this.crashHub());
    if (this.chaos.deviceCrashEveryMs) this.every(this.chaos.deviceCrashEveryMs, () => this.crashDevice(this.rng.pick(this.computers)));
    if (this.chaos.cutEveryMs) this.every(this.chaos.cutEveryMs, () => this.rng.pick(this.computers).link?.cut('network'));
    await this.run(10_000);
  }

  /** Ends the run and takes its files away (the databases are closed first: Windows keeps open files). */
  stop(): void {
    this.stopActivity();
    mock.timers.reset();
    console.log = this.log;
    for (const db of [(this.hub as any)?.store?.db, ...this.computers.map((c) => (c.device as any)?.db)]) {
      try {
        db?.close?.();
      } catch {
        // closed already
      }
    }
    rmSync(this.root, { recursive: true, force: true, maxRetries: 3 });
  }

  /** Lets simulated time pass, letting everything that was due run. */
  async run(ms: number, step = 200): Promise<void> {
    for (let t = 0; t < ms; t += step) {
      mock.timers.tick(step);
      for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
    }
  }

  private every(meanMs: number, fn: () => void): void {
    const next = () => setTimeout(() => {
      fn();
      next();
    }, this.rng.between(meanMs / 2, meanMs * 1.5));
    next();
  }

  startHub(): void {
    const hub = new Hub(join(this.root, 'hub'), 'hub-1', 'hub', 'hub.test', 'owner');
    hub.resume();
    this.hub = hub;
  }

  crashHub(): void {
    if (!this.hub) return;
    // The parts it lends work to (the relay's own timers) die with it.
    kill((this.hub as any).relay, ['store']);
    kill(this.hub, ['store', 'relay', 'replica']);
    this.hub = null;
    for (const c of this.computers) c.link?.cut('hub crashed');
    setTimeout(() => this.startHub(), this.rng.between(...this.chaos.downMs));
  }

  async startDevice(c: Computer): Promise<void> {
    c.transport = new SimTransport(this, c);
    c.adapters = c.apps.map((app) => new SimAdapter(app, this.rng, this.chaos.window));
    const device = new Device(c.dir, c.id, c.name, 'secret', c.transport);
    for (const a of c.adapters) device.add(a);
    c.device = device;
    await device.start();
  }

  crashDevice(c: Computer): void {
    if (!c.device) return;
    for (const a of c.adapters) a.kill();
    c.link?.cut('AgentChat crashed');
    kill(c.device, ['db']);
    c.device = null;
    setTimeout(() => void this.startDevice(c), this.rng.between(...this.chaos.downMs));
  }

  /** A computer tries the hub again after a moment, as the real link does, until it gets through. */
  reconnectLater(c: Computer, ms = this.rng.between(1_000, 5_000)): void {
    setTimeout(() => {
      if (!c.device || c.link) return;
      if (!this.hub) return this.reconnectLater(c);
      const link = new Link(this, c);
      c.link = link;
      this.hub.attachRemoteDevice(link.hubEnd as any, true);
      c.transport.connected = true;
      c.transport.handlers.connected();
    }, ms);
  }

  /**
   * A conversation of an app calls AgentChat's send. The app shows the call while it runs, the way agents' apps do;
   * whether the tool says which conversation is calling depends on the agent.
   */
  async send(c: Computer, app: AgentApp, threadId: string, args: Record<string, unknown>): Promise<{ ok: true; result: any } | { ok: false; error: string }> {
    const done = app.calling(threadId, args);
    try {
      if (!c.device) throw new Error('AgentChat 没在运行');
      const result = await c.device.ask('send', app.kind.info.id, args, 60_000, app.kind.caller === 'tool' ? threadId : undefined);
      // The program died while the call was in it (a killed device answers nothing): the agent's tool gets an error.
      if (result === undefined) throw new Error('AgentChat 中途停了');
      return { ok: true, result };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    } finally {
      done();
    }
  }
}
