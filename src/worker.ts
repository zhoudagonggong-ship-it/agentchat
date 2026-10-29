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
import { CLI as TAILSCALE, tailnetStatus, tailscaleLoginUrl, tailscaleProblem, tailscaleUp, type TailnetStatus, type TailscaleStep } from './tailscale.ts';
import { Hub } from './hub/hub.ts';
import { Device } from './device/device.ts';
import { CodexAdapter, findCodexExe } from './device/codex/adapter.ts';
import { ClaudeCodeAdapter, findClaudeExe } from './device/claude/adapter.ts';
import { OpenCodeAdapter, hasOpenCode } from './device/opencode/adapter.ts';
import { GooseAdapter, hasGoose } from './device/goose/adapter.ts';
import { homedir, hostname } from 'node:os';
import { WsTransport, type Transport } from './link.ts';
import { activity, onActivity, recentActivity } from './activity.ts';
import type { AskOp, HubRef, MemberSeed } from './shared/protocol.ts';
import { CONTROL_PORT, HUB_LOCAL_PORT, HUB_PORT } from './shared/protocol.ts';
import { debounce, log } from './shared/util.ts';
import { applyPackage, codeVersion, confirmUpdate, isDevCheckout, wasRejected } from './update.ts';
import { downloadRelease, latestRelease, type Release } from './release.ts';
import { exportDiagnostics } from './diagnostics.ts';

export const RESTART_CODE = 75;
const CONTROL_DIR = join(APP_DIR, 'web-control');
const SEED_FILE = join(DATA_DIR, 'hub-seed.json');
const HANDOVER_FILE = join(DATA_DIR, 'handover-in.zip');
const HANDOVER_STALL_MS = 60_000;
const DETECT_EVERY_TICKS = 4; // about every 2 minutes
const RELEASE_EVERY_TICKS = 2880; // a day
const RELEASE_FIRST_TICK = 10; // five minutes after starting
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
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
  /** What the owner still has to do before AllinOne can run (shown in the window); null when nothing. */
  private setup: { step: TailscaleStep | 'https'; url?: string } | null = null;
  private release: Release | null = null;
  private peers: Peer[] = [];
  /** No 主电脑 on the tailnet yet: asking whether this one should be it, or waiting for another (the owner said no). */
  private firstStart: 'ask' | 'waiting' | null = null;
  private discovering = false;
  private autostart = false;
  private readonly controls = new Set<WebSocket>();
  private readonly underTray = process.env.ALLINONE_TRAY === '1';

  async start(): Promise<void> {
    if (this.underTray) this.redirectLogs();
    // The window and tray first: until Tailscale is ready they guide the owner through it.
    this.startControlServer();
    this.listenToTray();
    onActivity(() => this.changed());
    this.autostart = await this.autostartEnabled();
    // Started for the first time without the installer (which turns it on itself): starting with Windows is the default.
    if (FIRST_RUN && !this.autostart && !isDevCheckout()) await this.setAutostart(true);
    await this.waitForTailscale();
    this.peers = this.tailnet.devices.map((d) => ({ ...d, isHub: this.config.hub?.stableId === d.stableId }));

    const self = this.tailnet.self;
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
    }
    this.changed();
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

  private async startHub(): Promise<void> {
    const self = this.tailnet.self;
    let seeds: MemberSeed[] = [];
    if (existsSync(SEED_FILE)) {
      seeds = JSON.parse(readFileSync(SEED_FILE, 'utf8')) as MemberSeed[];
      rmSync(SEED_FILE);
    }
    if (existsSync(HANDOVER_FILE)) await this.takeHandover();
    this.hub = new Hub(DATA_DIR, self.stableId, self.name, self.dnsName, this.tailnet.ownerLogin, seeds);
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
    device.onHubMoved = (hub, members, handover) => void this.followHub(hub, members, handover);
    // Self-update from the hub; a development checkout (with .git) keeps its own code.
    if (this.role !== 'hub' && this.config.hub?.stableId !== self.stableId) {
      if (isDevCheckout()) log('update', 'development checkout: not taking updates from the hub');
      else device.code = codeVersion();
    }
    device.onJoined = () => {
      this.detectAgents();
      const version = confirmUpdate();
      if (version) activity(`已更新到新版本（${version.slice(0, 8)}）`);
    };
    device.onUpdate = (version, data) => void this.update(version, data);
    // The owner sits here: the reminder shows as the tray's bubble (clicking it opens the conversation).
    device.onAlert = (alert) => {
      if (this.underTray) process.stdout.write('@@alert ' + JSON.stringify(alert) + '\n');
    };
    this.detectAgents();
    if (!device.agents.length) activity('本机没有找到 Codex、Claude Code、OpenCode 或 Goose');
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
      let error: Error | null = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          await download(handover, HANDOVER_FILE);
          error = null;
          activity('已取回旧主电脑的数据');
          break;
        } catch (e) {
          error = e as Error;
          log('handover', `download attempt ${attempt} failed: ${error.message}`);
          rmSync(HANDOVER_FILE, { force: true });
        }
      }
      if (error) activity(`没能取回旧主电脑的数据（${error.message}），只带上成员名单`, 'warn');
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
    // Handing over from the current hub: the new one takes the data, everyone follows, then this one steps down.
    if (this.hub && this.role === 'hub') {
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
            activity('等待主电脑：在平时开着的那台电脑上安装 AllinOne，这台会自动连上它');
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
        case '/api/agent': {
          // The AllinOne tool (mcp.ts) of an agent on this computer: the hub lists agents, sends, waits.
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
      else if (cmd === 'quit') process.exit(0);
    });
    process.stdin.on('end', () => process.exit(0)); // the tray went away
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

/** Streams a download to a file; gives up only when nothing arrives for HANDOVER_STALL_MS. Progress goes to the log. */
export async function download(url: string, file: string): Promise<void> {
  const abort = new AbortController();
  let stall = setTimeout(() => abort.abort(new Error('no data for a minute')), HANDOVER_STALL_MS);
  const res = await fetch(url, { signal: abort.signal });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const out = createWriteStream(file);
  let got = 0;
  let said = Date.now();
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      clearTimeout(stall);
      stall = setTimeout(() => abort.abort(new Error('no data for a minute')), HANDOVER_STALL_MS);
      got += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      if (Date.now() - said > 10_000) {
        said = Date.now();
        log('handover', `received ${(got / 1048576).toFixed(1)} of ${(total / 1048576).toFixed(1)} MB`);
      }
    }
  } finally {
    clearTimeout(stall);
    await new Promise((r) => out.end(r));
  }
  if (total && got !== total) throw new Error(`incomplete: ${got} of ${total} bytes`);
  log('handover', `received all ${(got / 1048576).toFixed(1)} MB`);
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
