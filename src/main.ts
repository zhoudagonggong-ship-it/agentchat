// Entry point. Every computer runs this same program; normally it is started by the tray (tray/tray.ps1).
//   npm start                 run in this console (development)
//   npm start -- devices      list the computers on the tailnet
//   npm start -- hub <name>   choose the hub from the command line (the control window does the same)
import { bootCheck } from './update.ts';

const [command, arg] = process.argv.slice(2);

async function main(): Promise<void> {
  // First, before the rest of the code loads: a freshly updated version that keeps failing is rolled back here.
  if (!command) bootCheck();
  const { loadConfig, saveConfig } = await import('./config.ts');
  const { tailnetStatus } = await import('./tailscale.ts');
  const { Worker } = await import('./worker.ts');
  if (command === 'devices' || command === 'hub') {
    const config = loadConfig();
    const tailnet = await tailnetStatus();
    if (command === 'devices') {
      for (const d of tailnet.devices) {
        const mark = config.hub?.stableId === d.stableId ? '  ← 主电脑' : '';
        console.log(`${d.online ? '●' : '○'} ${d.name}${d.self ? '（本机）' : ''}${mark}`);
      }
      return;
    }
    const chosen = tailnet.devices.find((d) => d.name === arg);
    if (!chosen) throw new Error(`tailnet 里没有叫「${arg}」的电脑；用 devices 查看列表`);
    saveConfig({ ...config, hub: { stableId: chosen.stableId, dnsName: chosen.dnsName, name: chosen.name } });
    console.log(`主电脑已设为：${chosen.name}`);
    return;
  }
  await new Worker().start();
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});
