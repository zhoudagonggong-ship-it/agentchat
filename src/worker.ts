// The long-running program on every computer: runs the chosen role(s), serves the local control
// window on 127.0.0.1, and reports status to the tray icon. Changing the role restarts this process
// (exit code 75); the tray supervisor starts it again.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, normalize } from 'node:path';
import { createInterface } from 'node:readline';
import { format, promisify } from 'node:util';
import { WebSocketServer, type WebSocket } from 'ws';
import { APP_DIR, DATA_DIR, FIRST_RUN, IN_TEST, loadConfig, saveConfig, type Config } from './config.ts';
import { Voice } from './device/voice/voice.ts';
import { CLI as TAILSCALE, tailnetStatus, tailscaleLoginUrl, tailscaleProblem, tailscaleUp, type TailnetStatus, type TailscaleStep } from './tailscale.ts';
import { Hub } from './hub/hub.ts';
import { Device } from './device/device.ts';
import { CodexAdapter, findCodexExe } from './device/codex/adapter.ts';
import { ClaudeCodeAdapter, findClaudeExe } from './device/claude/adapter.ts';
import { OpenCodeAdapter, hasOpenCode } from './device/opencode/adapter.ts';
import { GooseAdapter, hasGoose } from './device/goose/adapter.ts';
import { DshAdapter, hasDsh } from './device/dsh/adapter.ts';
import { homedir, hostname } from 'node:os';
import { WsTransport, type Transport } from './link.ts';
import { activity, onActivity, recentActivity } from './activity.ts';
import { heldOutput, sendNow } from './device/held.ts';
import type { AskOp, HubRef, MemberSeed } from './shared/protocol.ts';
import { CONTROL_PORT, HUB_LOCAL_PORT, HUB_PORT } from './shared/protocol.ts';
import { debounce, log } from './shared/util.ts';
import { applyPackage, codeVersion, confirmUpdate, isDevCheckout, wasRejected } from './update.ts';
import { downloadRelease, latestRelease, type Release } from './release.ts';
import { exportDiagnostics } from './diagnostics.ts';
import { takeOver } from './handover.ts';
import { ReplicaSink } from './device/replica.ts';
import { decide, outranks, probe } from './shift.ts';

export const RESTART_CODE = 75;
const CONTROL_DIR = join(APP_DIR, 'web-control');
const SEED_FILE = join(DATA_DIR, 'hub-seed.json');
const HANDOVER_FILE = join(DATA_DIR, 'handover-in.zip');
const DETECT_EVERY_TICKS = 4; // about every 2 minutes
const RELEASE_EVERY_TICKS = 2880; // a day
const RELEASE_FIRST_TICK = 10; // five minutes after starting
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const SHIFT_EVERY_MS = 15_000; // a computer without its hub looks around this often
const RIVAL_EVERY_MS = 60_000; // the hub looks for another one acting as hub this often
const LEAVE_MAX_MS = 25_000; // shutting down: at most this long to hand the duty on
const run = promisify(execFile);
const LOG_MAX = 5 * 1024 * 1024;
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

type Role = 'none' | 'hub' | 'device' | 'paused';
interface Peer { stableId: string; name: string; dnsName: string; os: string; online: boolean; self: boolean; isHub: boolean }

export class Worker {
  private config: Config = loadConfig();
  private tailnet!: TailnetStatus;
  private role: Role = 'none';
  private hub: Hub | null = null;
  private device: Device | null = null;
  /** What the owner still has to do before AgentChat can run (shown in the window); null when nothing. */
  private setup: { step: TailscaleStep | 'https'; url?: string } | null = null;
  private release: Release | null = null;
  private peers: Peer[] = [];
  /** No 主电脑 on the tailnet yet: asking whether this one should be it, or waiting for another (the owner said no). */
  private firstStart: 'ask' | 'waiting' | null = null;
  private discovering = false;
  private autostart = false;
  private readonly controls = new Set<WebSocket>();
  private readonly underTray = process.env.ALLINONE_TRAY === '1';
  /** This computer's copy of the hub's record (while it is not the hub itself). */
  private replica: ReplicaSink | null = null;
  /** Since when the hub has been out of reach (0: connected). */
  private lostSince = 0;
  private lookingAround = false;

  async start(): Promise<void> {
    if (this.underTray) this.redirectLogs();
    // The window and tray first: until Tailscale is ready they guide the owner through it.
    this.startControlServer();
    this.listenToTray();
    this.leaveOnSignals();
    onActivity(() => this.changed());
    this.autostart = await this.autostartEnabled();
    // Started for the first time without the installer (which turns it on itself): starting with Windows is the default.
    if (FIRST_RUN && !this.autostart && !isDevCheckout()) await this.setAutostart(true);
    await this.waitForTailscale();
    this.peers = this.tailnet.devices.map((d) => ({ ...d, isHub: this.config.hub?.stableId === d.stableId }));

    const self = this.tailnet.self;
    // Hub when this computer stopped: while it was away (a power cut), another one may have taken over.
    if (!this.config.paused && this.config.hub?.stableId === self.stableId) {
      const rival = await this.findRival();
      if (rival) {
        activity(`本机离开期间「${rival.name}」接了主电脑的班，本机改为普通成员`);
        await run(TAILSCALE, ['serve', `--https=${HUB_PORT}`, 'off'], { windowsHide: true }).catch(() => {});
        this.config = { ...this.config, hub: rival.ref, term: rival.term };
        saveConfig(this.config);
      }
    }
    if (this.config.paused) {
      this.role = 'paused';
      activity('已暂停');
    } else if (!this.config.hub) {
      activity('正在查找主电脑');
      void this.findHub();
    } else if (this.config.hub.stableId === self.stableId) {
      await this.startHub();
      this.startDevice(this.hub!.connectLocalDevice());
      this.role = 'hub';
    } else {
      this.startDevice(new WsTransport(`wss://${this.config.hub.dnsName}:${HUB_PORT}/ws/device`));
      this.role = 'device';
      this.keepReplica();
    }
    setInterval(() => void this.keepShift(), SHIFT_EVERY_MS);
    this.changed();
  }

  // ---------- shifts (shift.ts) ----------

  /** Another computer acting as hub, on a later term (or the same, earlier in line): the one to stay. */
  private async findRival(): Promise<{ ref: HubRef; term: number } | null> {
    const self = this.tailnet.self.stableId;
    const line = this.config.line ?? [];
    const term = this.hub?.term ?? this.config.term ?? 1;
    const answers = await Promise.all(line.filter((r) => r.stableId !== self).map(async (ref) => ({ ref, p: await probe(ref.dnsName) })));
    const found = answers.filter((a) => a.p && outranks(a.p, self, term, line.map((r) => r.stableId)))
      .sort((a, b) => b.p!.term - a.p!.term)[0];
    return found ? { ref: found.ref, term: found.p!.term } : null;
  }

  /** A copy of the hub's record kept here, so this computer can take over. */
  private keepReplica(): void {
    const device = this.device!;
    rmSync(join(DATA_DIR, 'replica-out.sqlite'), { force: true }); // the copy this computer made for others while hub
    const replica = new ReplicaSink(DATA_DIR);
    this.replica = replica;
    replica.send = (epoch, n) => device.tell({ t: 'replicaAt', epoch, n });
    replica.hub = () => (this.config.hub ? `https://${this.config.hub.dnsName}:${HUB_PORT}/` : '');
    device.onReplica = (msg) => {
      if (msg.t === 'replica') replica.changesets(msg.epoch, msg.n, msg.data.map((d) => Buffer.from(d, 'base64')));
      else void replica.snapshot(msg.epoch, msg.n, msg.url);
    };
  }

  private shiftWorking = false;
  /**
   * Every SHIFT_EVERY_MS. A computer: without its hub for a while, look around (follow a hub that is there, or take
   * over when it is our turn). The hub: give way to a rival; hand the duty back to a computer before us in line that
   * is back; remember the line, for after a restart.
   */
  private async keepShift(): Promise<void> {
    if (this.shiftWorking) return;
    this.shiftWorking = true;
    try {
      if (this.role === 'device') await this.lookAround();
      if (this.role === 'hub' && this.hub) await this.checkDuty();
    } catch (e) {
      log('shift', `looking around failed: ${(e as Error).message}`);
    } finally {
      this.shiftWorking = false;
    }
  }

  private async lookAround(): Promise<void> {
    if (this.device?.status !== 'connecting') {
      this.lostSince = 0;
      return;
    }
    this.lostSince ||= Date.now();
    const lostFor = Date.now() - this.lostSince;
    const hub = this.config.hub;
    const line = this.config.line ?? [];
    if (lostFor < SHIFT_EVERY_MS || !hub || !line.length) return;
    const self = this.tailnet.self.stableId;
    this.tailnet = await tailnetStatus();
    const online = new Set(this.tailnet.devices.filter((d) => d.online).map((d) => d.stableId));
    const others = line.some((r) => r.stableId === hub.stableId) ? line : [...line, hub];
    const probes = new Map(await Promise.all(others.filter((r) => r.stableId !== self).map(async (r) => [r.stableId, await probe(r.dnsName)] as const)));
    const verdict = decide({ self, hub: hub.stableId, term: this.config.term ?? 1, line: line.map((r) => r.stableId), lostFor, online,
      probes, ready: this.replica?.ready ?? false });
    if (verdict.do === 'follow') {
      const ref = others.find((r) => r.stableId === verdict.id)!;
      activity(`主电脑「${hub.name}」失联，转到「${ref.name}」`, 'warn');
      this.follow(ref, verdict.term);
    } else if (verdict.do === 'takeOver') {
      activity(`主电脑「${hub.name}」失联 ${Math.round(lostFor / 1000)} 秒，本机按顺序接班`, 'warn');
      await this.promote(verdict.term);
    }
  }

  private async checkDuty(): Promise<void> {
    const hub = this.hub!;
    const line = hub.line();
    if (JSON.stringify(line) !== JSON.stringify(this.config.line) || this.config.term !== hub.term) {
      this.config = { ...this.config, line, term: hub.term };
      saveConfig(this.config);
    }
    if (Date.now() - this.rivalAt >= RIVAL_EVERY_MS) {
      this.rivalAt = Date.now();
      const rival = await this.findRival();
      if (rival) {
        activity(`「${rival.ref.name}」也在当主电脑（第 ${rival.term} 班，本机第 ${hub.term} 班），本机让出`, 'warn');
        return this.giveWay(rival.ref, rival.term);
      }
    }
    // The duty goes back where it belongs, when that cuts nothing off here.
    const back = hub.reclaimTarget();
    if (back && this.device?.busy()) {
      if (!this.reclaimWaitSaid) log('shift', `${back.name} could take the duty back, but work here is under way`);
      this.reclaimWaitSaid = true;
    } else this.reclaimWaitSaid = false;
    if (back && !this.device?.busy()) {
      activity(`「${back.name}」排在本机前面，已回来，把主电脑的工作交还给它`);
      if (await this.handOff(back.stableId)) this.restart();
    }
  }
  private rivalAt = 0;
  private reclaimWaitSaid = false;

  /** Steps down for a hub found acting as such: this computer's own record gives way to the other one's. */
  private async giveWay(ref: HubRef, term: number): Promise<void> {
    await run(TAILSCALE, ['serve', `--https=${HUB_PORT}`, 'off'], { windowsHide: true }).catch(() => {});
    this.config = { ...this.config, hub: ref, term };
    saveConfig(this.config);
    this.restart();
  }

  /** Over to another hub, without stopping the agents here. */
  private follow(hub: HubRef, term?: number): void {
    this.config = { ...this.config, hub, ...(term ? { term } : {}) };
    saveConfig(this.config);
    this.lostSince = 0;
    this.device?.relink(new WsTransport(`wss://${hub.dnsName}:${HUB_PORT}/ws/device`));
    this.changed();
  }

  /** This computer takes over as hub from its copy of the record, on `term`; the agents here carry on meanwhile. */
  private async promote(term: number): Promise<void> {
    if (this.role !== 'device' || !this.device) return;
    const self = this.tailnet.self;
    const had = this.replica?.promote(DATA_DIR) ?? false;
    this.replica = null;
    this.device.onReplica = () => {};
    if (!had) activity('本机没有主电脑记录的副本，用本机原有的记录接班', 'warn');
    this.config = { ...this.config, hub: { stableId: self.stableId, dnsName: self.dnsName, name: self.name }, term };
    saveConfig(this.config);
    await this.startHub(term);
    this.role = 'hub';
    this.device.relink(this.hub!.connectLocalDevice());
    activity(`本机已接班当主电脑（第 ${term} 班）`);
    this.changed();
  }

  /** Hands the hub's duty on to the next in line (or `to`); false when no computer could take it. */
  private async handOff(to?: string): Promise<boolean> {
    if (this.role !== 'hub' || !this.hub) return false;
    const next = await this.hub.stepDown(to).catch((e: Error) => (log('shift', `handing over failed: ${e.message}`), null));
    if (!next) return false;
    await run(TAILSCALE, ['serve', `--https=${HUB_PORT}`, 'off'], { windowsHide: true }).catch(() => {});
    this.config = { ...this.config, hub: next, term: this.hub.term + 1 };
    saveConfig(this.config);
    return true;
  }

  /** Going away (shutting down, quitting, updating): the hub hands its duty on first, as far as time allows. */
  private async leave(why: string): Promise<void> {
    if (this.role !== 'hub') return;
    activity(`${why}：先把主电脑的工作交给下一台`);
    const done = await Promise.race([this.handOff(), new Promise<boolean>((r) => setTimeout(() => r(false), LEAVE_MAX_MS))]);
    if (!done) activity('没能交出主电脑的工作（没有能接班的电脑，或时间不够）；它不在时，其他电脑会按顺序接班', 'warn');
  }

  private leaveOnSignals(): void {
    let leaving = false;
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'] as const) {
      process.on(signal, () => {
        if (leaving) return;
        leaving = true;
        void this.leave('程序被关闭').finally(() => process.exit(0));
      });
    }
  }

  // ---------- Tailscale ----------

  /** Checks every few seconds until Tailscale is installed, running and signed in; the window says what to do. */
  private async waitForTailscale(): Promise<void> {
    let told = '';
    for (;;) {
      const problem = await tailscaleProblem();
      if (!problem) {
        this.tailnet = await tailnetStatus();
        if (this.setup) activity('Tailscale 已就绪');
        this.setup = null;
        return;
      }
      this.setup = { step: problem.step, url: problem.url ?? this.setup?.url };
      if (told !== problem.step) {
        told = problem.step;
        activity({ install: '还没有安装 Tailscale', start: 'Tailscale 没有运行', login: 'Tailscale 还没有登录' }[problem.step], 'warn');
      }
      this.changed();
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  /**
   * Publishes the hub on the tailnet over HTTPS. A tailnet where HTTPS is still off makes Tailscale print the page
   * that turns it on (and wait): the window offers that page, and this tries again until it works.
   */
  private async publishHub(): Promise<void> {
    try {
      await run(TAILSCALE, ['serve', '--bg', `--https=${HUB_PORT}`, `http://127.0.0.1:${HUB_LOCAL_PORT}`], { windowsHide: true, timeout: 20_000 });
      if (this.setup?.step === 'https') activity('HTTPS 已打开');
      this.setup = null;
      activity('主电脑已启动，手机和其他电脑现在可以连接');
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string; message: string };
      const url = /https:\/\/login\.tailscale\.com\/\S+/.exec(`${e.stdout ?? ''}\n${e.stderr ?? ''}\n${e.message}`)?.[0];
      if (url) {
        if (this.setup?.step !== 'https') activity('还差一步：要在 Tailscale 里打开 HTTPS', 'warn');
        this.setup = { step: 'https', url };
      } else {
        activity(`无法通过 Tailscale 发布主电脑：${e.message.split('\n')[0]}`, 'warn');
      }
      this.changed();
      setTimeout(() => void this.publishHub(), 10_000);
    }
  }

  /** The window's buttons for each setup step. */
  private async setupAction(what: string): Promise<void> {
    const open = (url: string) => execFile('cmd.exe', ['/c', 'start', '', url], { windowsHide: true });
    if (what === 'install') return void open('https://tailscale.com/download/windows');
    if (what === 'start') {
      const app = 'C:\\Program Files\\Tailscale\\tailscale-ipn.exe';
      if (existsSync(app)) execFile(app, [], { windowsHide: false });
      return tailscaleUp();
    }
    if (what === 'login') {
      const url = this.setup?.url ?? (await tailscaleLoginUrl());
      if (url) open(url);
      else activity('请点右下角的 Tailscale 图标，选择 Log in', 'warn');
      return;
    }
    if (what === 'https' && this.setup?.url) open(this.setup.url);
  }

  // ---------- roles ----------

  /** `term`: taking over from this computer's copy of the record, as that term. */
  private async startHub(term?: number): Promise<void> {
    const self = this.tailnet.self;
    let seeds: MemberSeed[] = [];
    if (existsSync(SEED_FILE)) {
      seeds = JSON.parse(readFileSync(SEED_FILE, 'utf8')) as MemberSeed[];
      rmSync(SEED_FILE);
    }
    if (existsSync(HANDOVER_FILE)) await this.takeHandover();
    this.hub = new Hub(DATA_DIR, self.stableId, self.name, self.dnsName, this.tailnet.ownerLogin, seeds, term);
    this.hub.onChange = () => this.changed();
    this.hub.onInstallUpdate = () => void this.installRelease();
    this.hub.start();
    await this.publishHub();
  }

  /** Before the hub opens its store: the previous hub's database and files take the place of this machine's own. */
  private async takeHandover(): Promise<void> {
    const stage = join(DATA_DIR, 'handover-in');
    try {
      rmSync(stage, { recursive: true, force: true });
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${HANDOVER_FILE}' -DestinationPath '${stage}' -Force`], { windowsHide: true, timeout: 300_000 });
      if (!existsSync(join(stage, 'hub.sqlite'))) throw new Error('no database in the copy');
      for (const f of ['hub.sqlite', 'hub.sqlite-wal', 'hub.sqlite-shm']) rmSync(join(DATA_DIR, f), { force: true });
      renameSync(join(stage, 'hub.sqlite'), join(DATA_DIR, 'hub.sqlite'));
      const artifacts = join(DATA_DIR, 'artifacts');
      mkdirSync(artifacts, { recursive: true });
      if (existsSync(join(stage, 'artifacts'))) {
        for (const f of readdirSync(join(stage, 'artifacts'))) if (!existsSync(join(artifacts, f))) renameSync(join(stage, 'artifacts', f), join(artifacts, f));
      }
      activity('已接手旧主电脑的对话、好友和文件');
    } catch (error) {
      activity(`接手旧主电脑数据失败：${(error as Error).message}`, 'warn');
    } finally {
      rmSync(stage, { recursive: true, force: true });
      rmSync(HANDOVER_FILE, { force: true });
    }
  }

  private startDevice(transport: Transport): void {
    const self = this.tailnet.self;
    const device = new Device(DATA_DIR, self.stableId, self.name, this.config.deviceSecret, transport);
    this.device = device;
    device.onStatus = () => {
      if (device.status === 'joined') activity(`已连接主电脑「${this.config.hub?.name}」`);
      if (device.status === 'pending') activity('已向主电脑发出加入请求，等待允许', 'warn');
      this.changed();
    };
    device.onHubMoved = (msg) => {
      if (this.role === 'hub') return; // our own hub handing on: the program around it sees to this computer
      if (msg.promote && msg.hub.stableId === self.stableId) {
        activity('主电脑把工作交给本机');
        void this.promote(msg.term ?? (this.config.term ?? 1) + 1);
      } else if (msg.hub.stableId !== self.stableId) {
        activity(`主电脑换到「${msg.hub.name}」`);
        this.follow(msg.hub, msg.term);
      } else void this.followHub(msg.hub, msg.members, msg.handover);
    };
    device.onShift = (msg) => {
      if (this.role === 'hub' || (msg.term === this.config.term && JSON.stringify(msg.line) === JSON.stringify(this.config.line))) return;
      this.config = { ...this.config, term: msg.term, line: msg.line };
      saveConfig(this.config);
    };
    // Self-update from the hub; a development checkout (with .git) keeps its own code.
    if (this.role !== 'hub' && this.config.hub?.stableId !== self.stableId) {
      if (isDevCheckout()) log('update', 'development checkout: not taking updates from the hub');
      else device.code = codeVersion();
    }
    device.onJoined = () => {
      this.replica?.joined();
      this.detectAgents();
      const version = confirmUpdate();
      if (version) activity(`已更新到新版本（${version.slice(0, 8)}）`);
    };
    device.onUpdate = (version, data) => void this.update(version, data);
    // The owner sits here: the reminder shows as the tray's bubble (clicking it opens the conversation).
    device.onAlert = (alert) => {
      if (this.underTray) process.stdout.write('@@alert ' + JSON.stringify(alert) + '\n');
    };
    // Voice input (Win+Alt+Space): a helper of its own in the owner's desktop session; the hub decides who listens.
    if (this.underTray && !IN_TEST) {
      const voice = new Voice();
      voice.onMessage = (m) => device.voice(m);
      device.onVoice = (m) => voice.toHelper(m);
      voice.start();
    }
    // Messages held back from an agent's window while the owner works: told in the same bubble (a click sends it in),
    // counted in the tray's menu.
    heldOutput((r) => {
      if (this.underTray) process.stdout.write('@@alert ' + JSON.stringify(r) + '\n');
    }, (count) => {
      if (this.underTray) process.stdout.write(`@@held ${count}\n`);
    });
    this.detectAgents();
    if (!device.agents.length) activity('本机没有找到 Codex、Claude Code、OpenCode、Goose 或 DSH');
    // An agent installed (or first opened) later is picked up without a restart: no timer of its own, it rides on
    // the hub's tick (every 30 s) every DETECT_EVERY_TICKS, and on each reconnect. Looking costs a few file checks.
    let ticks = 0;
    device.onTick = () => {
      if (++ticks % DETECT_EVERY_TICKS === 0) this.detectAgents();
      // The hub alone looks for a new release: a few minutes after it starts, then once a day.
      if (this.role === 'hub' && ticks % RELEASE_EVERY_TICKS === RELEASE_FIRST_TICK) void this.checkRelease();
    };
    void device.start();
  }

  /** Adds every supported agent found on this computer that is not connected yet; returns their names. */
  detectAgents(): string[] {
    const device = this.device;
    if (!device) return [];
    const found = [];
    if (!device.adapter('codex')) {
      const codex = findCodexExe();
      if (codex) found.push(new CodexAdapter(codex, join(DATA_DIR, 'codex-app-server.pid')));
    }
    if (!device.adapter('claude-code') && existsSync(join(homedir(), '.claude', 'projects'))) found.push(new ClaudeCodeAdapter(findClaudeExe()));
    if (!device.adapter('opencode') && hasOpenCode()) found.push(new OpenCodeAdapter());
    if (!device.adapter('goose') && hasGoose()) found.push(new GooseAdapter(DATA_DIR));
    if (!device.adapter('dsh') && hasDsh()) found.push(new DshAdapter());
    for (const adapter of found) device.add(adapter);
    const names = found.map((a) => a.info.label);
    if (names.length && device.agents.length > names.length) activity(`发现新的 Agent：${names.join('、')}`);
    if (names.length) this.changed();
    return names;
  }

  /** The hub moved: remember the new one (and, if it is us, the members to keep and the old hub's data) and restart. */
  private async followHub(hub: HubRef, members?: MemberSeed[], handover?: string): Promise<void> {
    const toUs = hub.stableId === this.tailnet.self.stableId;
    if (toUs && handover) {
      activity('本机将成为主电脑，正在取回旧主电脑的数据');
      rmSync(HANDOVER_FILE, { force: true }); // what an earlier handover left is not this one's
      try {
        await takeOver(handover, HANDOVER_FILE);
        activity('已取回旧主电脑的数据');
      } catch (e) {
        rmSync(HANDOVER_FILE, { force: true });
        activity(`没能取回旧主电脑的数据（${(e as Error).message}），只带上成员名单；旧主电脑上的数据还在，可以再换一次`, 'warn');
      }
    }
    if (members && toUs) writeFileSync(SEED_FILE, JSON.stringify(members));
    this.config = { ...this.config, hub };
    saveConfig(this.config);
    this.restart();
  }

  private updating = false;
  private updateWaitSince = 0;
  /** Takes the hub's program and restarts into it (the tray restarts too when its own files changed). */
  private async update(version: string, data: Buffer): Promise<void> {
    if (this.updating) return;
    if (wasRejected(version)) return log('update', `version ${version} was rolled back here before; not taking it again today`);
    // An agent here is in the middle of work this program carries (a turn, an approval): restarting would cut it off.
    // Wait for it, looking again every 30 s, for half an hour at most.
    if (this.device?.busy() && (this.updateWaitSince ||= Date.now()) > Date.now() - 30 * 60_000) {
      if (Date.now() - this.updateWaitSince < 1000) activity('有新版本，等这台电脑上正在进行的任务做完再更新');
      setTimeout(() => void this.update(version, data), 30_000);
      return;
    }
    this.updateWaitSince = 0;
    this.updating = true;
    activity('收到主电脑的新版本，正在更新');
    try {
      const code = await applyPackage(version, data);
      log('update', `updated to ${version}; restarting`);
      await this.leave('更新程序');
      setTimeout(() => process.exit(code), 300);
    } catch (error) {
      this.updating = false;
      activity(`更新失败：${(error as Error).message}`, 'warn');
    }
  }

  /** A newer release on GitHub: offered in the window and on the phone; taken only when the owner says so. */
  private async checkRelease(): Promise<void> {
    const release = await latestRelease().catch((e: Error) => (log('release', `check failed: ${e.message}`), null));
    if (!release || release.version === this.release?.version) return;
    this.release = release;
    activity(`有新版本 ${release.version}，可以在设置里更新`);
    this.hub?.offerVersion(release.version);
    this.changed();
  }

  /** The owner chose to update: the hub takes the release, then every other computer follows it as usual. */
  private async installRelease(): Promise<void> {
    if (!this.release || this.updating) return;
    this.updating = true;
    activity(`正在下载新版本 ${this.release.version}`);
    try {
      const code = await applyPackage(null, await downloadRelease(this.release));
      log('update', `release ${this.release.version} installed; restarting`);
      await this.leave('更新程序');
      setTimeout(() => process.exit(code), 300);
    } catch (error) {
      this.updating = false;
      activity(`更新失败：${(error as Error).message}`, 'warn');
    }
  }

  private restart(): void {
    log('worker', 'restarting to apply the new role');
    setTimeout(() => process.exit(RESTART_CODE), 300);
  }

  /** Asks every online computer whether it is the hub. */
  private async discover(): Promise<void> {
    if (this.discovering) return;
    this.discovering = true;
    this.changed();
    try {
      this.tailnet = await tailnetStatus();
      const results = await Promise.all(this.tailnet.devices.map(async (d) => {
        if (d.self) return { ...d, isHub: this.role === 'hub' };
        if (!d.online) return { ...d, isHub: false };
        try {
          const res = await fetch(`https://${d.dnsName}:${HUB_PORT}/api/info`, { signal: AbortSignal.timeout(4000) });
          const info = (await res.json()) as { app?: string; hub?: boolean };
          return { ...d, isHub: info.app === 'allinone' && info.hub === true };
        } catch {
          return { ...d, isHub: false };
        }
      }));
      this.peers = results;
    } finally {
      this.discovering = false;
      this.changed();
    }
  }

  /**
   * No 主电脑 chosen yet: join the one already running on the tailnet (a computer on the same account is let in by
   * itself), or, when there is none, ask once whether this computer stays on and should be it. Looks again every
   * 30 seconds meanwhile, so a 主电脑 started elsewhere is joined without anyone choosing.
   */
  private async findHub(): Promise<void> {
    if (this.config.hub || this.role !== 'none') return;
    await this.discover();
    if (this.config.hub || this.role !== 'none') return;
    const hub = this.peers.find((p) => p.isHub && !p.self);
    if (hub) {
      activity(`找到主电脑「${hub.name}」，正在加入`);
      return this.chooseHub(hub.stableId);
    }
    if (this.firstStart !== 'waiting') this.firstStart = 'ask';
    this.changed();
    setTimeout(() => void this.findHub(), 30_000);
  }

  private async chooseHub(stableId: string): Promise<void> {
    const peer = this.peers.find((p) => p.stableId === stableId);
    if (!peer) throw new Error('没有这台电脑');
    const ref: HubRef = { stableId: peer.stableId, dnsName: peer.dnsName, name: peer.name };
    if (this.config.hub?.stableId === stableId) return;
    // Handing over from the current hub: from the new one's copy of the record when it is current (see shift.ts), else
    // the new one takes the data as a whole first; everyone follows, then this one steps down.
    if (this.hub && this.role === 'hub') {
      if (await this.handOff(stableId)) return this.restart();
      await this.hub.moveTo(ref);
      await run(TAILSCALE, ['serve', `--https=${HUB_PORT}`, 'off'], { windowsHide: true }).catch(() => {});
    }
    this.config = { ...this.config, hub: ref };
    saveConfig(this.config);
    activity(stableId === this.tailnet.self.stableId ? '本机将成为主电脑' : `将连接主电脑「${peer.name}」`);
    this.restart();
  }

  private setPaused(paused: boolean): void {
    if (this.config.paused === paused) return;
    this.config = { ...this.config, paused };
    saveConfig(this.config);
    if (paused && this.role === 'hub') void run(TAILSCALE, ['serve', `--https=${HUB_PORT}`, 'off'], { windowsHide: true }).catch(() => {});
    this.restart();
  }

  // ---------- autostart (per user, no admin rights needed) ----------

  private testAutostart = false;
  private async autostartEnabled(): Promise<boolean> {
    if (IN_TEST) return this.testAutostart;
    if (process.platform !== 'win32') return false;
    try {
      await run('reg.exe', ['query', RUN_KEY, '/v', 'AllinOne'], { windowsHide: true });
      return true;
    } catch {
      return false;
    }
  }

  private async setAutostart(enabled: boolean): Promise<void> {
    if (IN_TEST) this.testAutostart = enabled;
    else if (enabled) {
      const launcher = join(APP_DIR, 'AllinOne.vbs');
      await run('reg.exe', ['add', RUN_KEY, '/v', 'AllinOne', '/t', 'REG_SZ', '/d', `wscript.exe "${launcher}"`, '/f'], { windowsHide: true });
    } else {
      await run('reg.exe', ['delete', RUN_KEY, '/v', 'AllinOne', '/f'], { windowsHide: true }).catch(() => {});
    }
    this.autostart = await this.autostartEnabled();
    activity(this.autostart ? '已开启开机自启' : '已关闭开机自启');
  }

  // ---------- state for the control window and tray ----------

  private snapshot() {
    // Still setting up Tailscale: no tailnet yet, only what to do next.
    if (!this.tailnet) {
      return { self: { name: hostname(), stableId: '' }, role: 'none', hub: null, link: null, peers: [], discovering: false, pending: [], agents: [],
        activity: recentActivity().slice(0, 50), autostart: this.autostart, phoneUrl: null, setup: this.setup };
    }
    const self = this.tailnet.self;
    const members = this.hub?.members() ?? [];
    return {
      setup: this.setup,
      release: this.release ? { version: this.release.version, notes: this.release.notes } : null,
      self: { name: self.name, stableId: self.stableId },
      role: this.role,
      hub: this.config.hub,
      link: this.device ? { status: this.device.status, detail: this.device.statusDetail } : null,
      peers: this.peers.map((p) => {
        const m = members.find((x) => x.id === p.stableId);
        return { ...p, member: m ? (m.approved ? (m.online ? 'online' : 'offline') : 'pending') : null };
      }),
      discovering: this.discovering,
      firstStart: this.role === 'none' ? this.firstStart : null,
      pending: this.hub?.pendingJoins() ?? [],
      agents: this.device?.agents ?? [],
      activity: recentActivity().slice(0, 50),
      autostart: this.autostart,
      phoneUrl: this.role === 'hub' ? `https://${self.dnsName}:${HUB_PORT}/` : this.config.hub ? `https://${this.config.hub.dnsName}:${HUB_PORT}/` : null,
    };
  }

  private trayState(): { color: 'green' | 'gray' | 'orange'; tip: string } {
    if (this.setup) return { color: 'orange', tip: `${this.tailnet?.self.name ?? hostname()} · 需要设置，点开窗口` };
    const self = this.tailnet.self.name;
    if (this.role === 'paused') return { color: 'gray', tip: `${self} · 已暂停` };
    if (this.role === 'none') return { color: 'orange', tip: this.firstStart === 'ask' ? `${self} · 需要设置，点开窗口` : `${self} · 正在查找主电脑` };
    if (this.hub?.pendingJoins().length) return { color: 'orange', tip: `${self} · 有电脑请求加入` };
    if (this.role === 'hub') {
      const online = this.hub!.members().filter((m) => m.online && !m.isHub).length;
      return { color: 'green', tip: `${self} · 主电脑 · ${online} 台设备在线` };
    }
    const status = this.device?.status;
    if (status === 'joined') return { color: 'green', tip: `${self} · 已连接主电脑` };
    if (status === 'pending') return { color: 'orange', tip: `${self} · 等待主电脑允许` };
    if (status === 'rejected') return { color: 'orange', tip: `${self} · 被主电脑拒绝` };
    const why = this.device?.statusDetail;
    return { color: why ? 'orange' : 'gray', tip: why ? `${self} · 连不上主电脑：${why}` : `${self} · 正在连接主电脑` };
  }

  private readonly changed = debounce(() => {
    const raw = JSON.stringify({ t: 'state', state: this.snapshot() });
    for (const ws of this.controls) if (ws.readyState === ws.OPEN) ws.send(raw);
    if (this.underTray) process.stdout.write('@@tray ' + JSON.stringify(this.trayState()) + '\n');
  }, 150);

  // ---------- local control server ----------

  private startControlServer(): void {
    const server = createServer((req, res) => void this.control(req, res));
    const wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
      if (!this.localOnly(req) || req.url !== '/ws/control') {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        return socket.destroy();
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        this.controls.add(ws);
        ws.send(JSON.stringify({ t: 'state', state: this.snapshot() }));
        ws.on('close', () => this.controls.delete(ws));
      });
    });
    server.on('error', (error) => log('worker', `control server: ${error.message}`));
    server.listen(CONTROL_PORT, '127.0.0.1');
  }

  /** Only this computer's own browser window: right host, same origin, never through tailscale serve. */
  private localOnly(req: IncomingMessage): boolean {
    const host = req.headers.host;
    const origin = req.headers.origin;
    const okHost = host === `127.0.0.1:${CONTROL_PORT}` || host === `localhost:${CONTROL_PORT}`;
    const okOrigin = origin === undefined || origin === `http://${host}`;
    return okHost && okOrigin && req.headers['tailscale-user-login'] === undefined;
  }

  private async control(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.localOnly(req)) return void res.writeHead(403).end();
    const url = new URL(req.url ?? '/', 'http://local');
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
      const rel = url.pathname === '/' ? 'index.html' : normalize(url.pathname).replace(/^[\\/]+/, '');
      const file = join(CONTROL_DIR, rel);
      if (!file.startsWith(CONTROL_DIR) || !existsSync(file) || !statSync(file).isFile()) return void res.writeHead(404).end();
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
      return void createReadStream(file).pipe(res);
    }
    // State-changing calls need a custom header, which a foreign web page cannot send without a CORS preflight.
    if (req.method !== 'POST' || req.headers['x-allinone'] !== '1') return void res.writeHead(405).end();
    const body = await readJson(req);
    const reply = (status: number, value: unknown) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
    try {
      switch (url.pathname) {
        case '/api/discover':
          void this.discover();
          return reply(200, { ok: true });
        case '/api/hub': {
          const id = String(body.stableId ?? '');
          if (!this.peers.some((p) => p.stableId === id)) return reply(404, { error: '没有这台电脑' });
          // A handover can take minutes (the new hub copies the data): answer now, report through activity.
          void this.chooseHub(id).catch((e: Error) => activity(`更换主电脑失败：${e.message}`, 'warn'));
          return reply(200, { ok: true });
        }
        case '/api/first':
          // The one question on a first computer: does it stay on (then it is the 主电脑)?
          if (body.yes) void this.chooseHub(this.tailnet.self.stableId).catch((e: Error) => activity(`设为主电脑失败：${e.message}`, 'warn'));
          else {
            this.firstStart = 'waiting';
            activity('等待主电脑：在平时开着的那台电脑上安装 AgentChat，这台会自动连上它');
            this.changed();
          }
          return reply(200, { ok: true });
        case '/api/pair-link':
          if (!this.hub) return reply(409, { error: '只有主电脑可以添加手机' });
          return reply(200, { link: this.hub.createPairLink() });
        case '/api/allow':
          return reply(this.hub?.allow(String(body.id ?? '')) ? 200 : 404, { ok: true });
        case '/api/deny':
          this.hub?.deny(String(body.id ?? ''));
          return reply(200, { ok: true });
        case '/api/stepdown': {
          // Before a planned restart of this computer's program (tools/restart-when-idle.ps1): hand the duty on first.
          if (this.role !== 'hub') return reply(200, { ok: true, role: this.role });
          const to = await this.handOff();
          if (to) this.restart();
          return reply(to ? 200 : 409, to ? { ok: true } : { error: '没有能接班的电脑' });
        }
        case '/api/release-install':
          void this.installRelease();
          return reply(200, { ok: true });
        case '/api/setup':
          await this.setupAction(String(body.do ?? ''));
          return reply(200, { ok: true });
        case '/api/pause':
          this.setPaused(Boolean(body.paused));
          return reply(200, { ok: true });
        case '/api/diagnostics': {
          const zip = await this.diagnostics();
          return reply(zip ? 200 : 500, zip ? { file: zip } : { error: '导出失败，详见动态' });
        }
        case '/api/autostart':
          await this.setAutostart(Boolean(body.enabled));
          this.changed();
          return reply(200, { ok: true });
        case '/api/claude-hook': {
          // Claude Code asks permission or a question: the phone may answer. Claude Code ends the hook when the
          // computer answered first, which closes this request.
          const claude = this.device?.adapter('claude-code') as ClaudeCodeAdapter | undefined;
          const gone = new AbortController();
          res.on('close', () => gone.abort());
          return slowReply(res, claude ? claude.hook(body, gone.signal).then((output) => ({ output })) : Promise.resolve({ output: null }));
        }
        case '/api/dsh-bridge': {
          // AgentChat's plugin inside the DSH desktop asks for the next message to send and says how it went.
          const dsh = this.device?.adapter('dsh') as DshAdapter | undefined;
          if (!dsh) return reply(404, { error: '这台电脑上没有 DSH' });
          return dsh.bridge(body).then(({ status, value }) => reply(status, value));
        }
        case '/api/agent': {
          // The AgentChat tool (mcp.ts) of an agent on this computer: the hub lists agents, sends, waits.
          const op = String(body.op ?? '') as AskOp;
          const agentId = String(body.agent ?? '');
          if (!['agents', 'send', 'wait', 'read', 'stop'].includes(op) || !this.device?.adapter(agentId)) return reply(400, { error: '不支持的操作或 Agent' });
          const args = (body.args && typeof body.args === 'object' ? body.args : {}) as Record<string, unknown>;
          // Waiting takes the minutes asked; a send may first start a conversation on another computer (up to two minutes).
          const minutes = op === 'wait' ? Math.min(60, Math.max(0, Number(args.minutes ?? 10))) : op === 'send' ? 2.5 : 0;
          const thread = typeof body.thread === 'string' ? body.thread.slice(0, 200) : undefined;
          return slowReply(res, this.device.ask(op, agentId, args, minutes * 60_000 + 30_000, thread).then((result) => ({ result }), (e: Error) => ({ error: e.message })));
        }
        default:
          return reply(404, { error: 'not found' });
      }
    } catch (error) {
      return reply(400, { error: (error as Error).message });
    }
  }

  // ---------- tray link ----------

  /** Saves the zip for asking for help on the desktop and shows it in Explorer (a pretend computer keeps it in its data). */
  private async diagnostics(): Promise<string | null> {
    try {
      const zip = await exportDiagnostics(DATA_DIR, APP_DIR, this.snapshot(), codeVersion(), IN_TEST ? DATA_DIR : undefined);
      activity(`诊断信息已保存到桌面：${basename(zip)}（密码和密钥已去掉）`);
      if (!IN_TEST) execFile('explorer.exe', [`/select,${zip}`], { windowsHide: false });
      return zip;
    } catch (error) {
      activity(`导出诊断信息失败：${(error as Error).message.split('\n')[0]}`, 'warn');
      return null;
    }
  }

  private listenToTray(): void {
    if (!this.underTray) return;
    createInterface({ input: process.stdin }).on('line', (line) => {
      const cmd = line.trim();
      if (cmd === 'pause') this.setPaused(true);
      else if (cmd === 'resume') this.setPaused(false);
      else if (cmd === 'rescan') {
        const names = this.detectAgents();
        if (!names.length) activity('没有发现新的 Agent');
      }
      else if (cmd === 'diagnostics') void this.diagnostics();
      else if (cmd.startsWith('presence ')) {
        // The tray's look at the keyboard and mouse (every 15 s): where the owner sits decides where reminders go.
        const [, idle, locked] = cmd.split(' ');
        this.device?.presence(Number(idle) || 0, locked === '1');
      }
      else if (cmd === 'sendnow' || cmd.startsWith('sendnow ')) {
        // The owner, from the reminder or the tray's menu: send what waits for them into the window now.
        const n = sendNow(cmd.slice('sendnow'.length).trim() || undefined);
        activity(n ? `马上把 ${n} 条等着的消息送进去` : '那条消息已经送进去了');
      }
      else if (cmd === 'quit') void this.leave('退出程序').finally(() => process.exit(0));
    });
    process.stdin.on('end', () => void this.leave('托盘程序关闭').finally(() => process.exit(0))); // the tray went away
  }

  /** Under the tray, stdout carries tray messages; everything else goes to a log file, kept to two files of LOG_MAX. */
  private redirectLogs(): void {
    const path = join(DATA_DIR, 'allinone.log');
    const open = () => createWriteStream(path, { flags: 'a' });
    const rotate = () => {
      try {
        if (statSync(path).size < LOG_MAX) return false;
        renameSync(path, join(DATA_DIR, 'allinone.1.log'));
        return true;
      } catch {
        return false; // no log yet
      }
    };
    rotate();
    let file = open();
    setInterval(() => {
      if (!rotate()) return;
      file.end();
      file = open();
    }, 10 * 60_000).unref();
    console.log = (...args: unknown[]) => file.write(format(...args) + '\n');
    console.error = console.log;
  }
}

/**
 * Answers a call that may take many minutes. A client's fetch gives up after 5 minutes without headers, or
 * without a byte of body: the headers go out at once, a space (still valid JSON) every minute, the JSON when ready.
 */
function slowReply(res: ServerResponse, value: Promise<unknown>): void {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.flushHeaders();
  const keepAlive = setInterval(() => res.write(' '), 60_000);
  const end = (v: unknown) => {
    clearInterval(keepAlive);
    res.end(JSON.stringify(v));
  };
  void value.then(end, (e: Error) => end({ error: e.message }));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 64 * 1024) break;
  }
  try {
    const value = JSON.parse(raw || '{}');
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}
