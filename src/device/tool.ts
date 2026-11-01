// How each agent starts the AgentChat tool (mcp.ts): this program's own Node and file, so it moves and updates with it.
// And the few lines that tell an agent the tool is there, for agents that read global instructions from a file.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const TOOL_NAME = 'allinone';
export const TOOL_FILE = join(import.meta.dirname, 'mcp.ts');

export function toolCommand(agentId: string): { command: string; args: string[] } {
  return { command: process.execPath, args: [TOOL_FILE, '--agent', agentId] };
}

/** What every agent should know about AgentChat, in a new conversation or on a new computer alike. */
export const AGENT_HINT = [
  '## AgentChat',
  '这台电脑装了 AgentChat。你有它的工具 allinone（agents / send / wait / read / stop / know / learn / approve），可以联系主人其他电脑上的 Agent（Codex、Claude Code、OpenCode、Goose、DSH）：',
  '- 谁派活谁负责：你派出去的活，规矩由你定（send 的 rules），对方过程中的请示也由你批（approve），主人只看结果。对方的请示会以「…的请示」发到你的对话。',
  '- 所有 Agent 共用一本知识库：各台电脑装了什么、东西放在哪、踩过的坑、主人的协作手册。开工前，凡是要用到某台电脑上的东西（模型、软件、目录），先用 know 查，'
    + '不要只凭自己的记忆或搜几个目录就说「没有」。查清楚的新情况、发现写错的，用 learn 记下来或改正，别的 Agent 马上就知道。',
  '- 主人让你把事情交给另一台电脑上的 Agent、问它、或看它在做什么时，用这些工具，不要用 SSH 或其他办法直接去调对方。',
  '- 先用 agents 看有哪些 Agent 和对话；优先发到主人正在用的已有对话里。主人要对方开一个新的工作对话时，用 send 的 title 给它起名。',
  '- 对方在另一台电脑上，看不到你这里的文件：要它用的文件，放进 send 的 files（本机路径），它会收到一份；它做出来的文件也会随汇报带回给你。',
  '- 主人还有一个各台电脑共用的网盘（Tailscale 自带的 Taildrive）：任何一台电脑上都是 http://100.100.100.100:8080/ 下的「网络名/电脑名/agentchat」文件夹，用 WebDAV 读写，不要账号密码（列目录：curl -X PROPFIND -H "Depth: 1" <地址>/；取文件：curl -o；放文件：curl -T）。'
    + '大文件和做好的成品放这里，消息里写清路径：成品放「交付/项目/版本」，素材放「素材/项目」，临时传递放「交换」；「我的」是主人自己的，不要动。',
  '- 对方要做很久时不必一直等：做完后它的汇报会自动发回你的对话（开头是「[来自 …的汇报，经 AgentChat 转发]」），收到后接着做。',
  '- 别的 Agent 经 AgentChat 发来的消息，开头写着收件人和编号（「经 AgentChat 转发给「对话名」 #1a2b3c4d」）。收件人不是你所在的这个对话时，是送错了：'
    + '不要处理，只回复一句「退回 #编号」，AgentChat 会把它送到该去的地方。同一个编号第二次出现，也不要再处理一遍。',
  '- 拿到结果后，在你自己的对话里向主人汇报。',
].join('\n');

const START = '<!-- AllinOne: start (AllinOne 自动添加，卸载时会去掉) -->';
const END = '<!-- AllinOne: end -->';

/**
 * Puts AGENT_HINT into an agent's global instructions file, between markers, keeping everything else as it is.
 * Returns whether the file changed.
 */
export function installHint(file: string): boolean {
  const before = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const block = `${START}\n${AGENT_HINT}\n${END}`;
  const at = before.indexOf(START);
  const end = before.indexOf(END);
  const after = at >= 0 && end > at
    ? before.slice(0, at) + block + before.slice(end + END.length)
    : (before.trimEnd() ? before.trimEnd() + '\n\n' : '') + block + '\n';
  if (after === before) return false;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, after);
  return true;
}

/** Takes the block out again; a file that held nothing else goes too. Returns whether there was one. */
export function uninstallHint(file: string): boolean {
  if (!existsSync(file)) return false;
  const before = readFileSync(file, 'utf8');
  const at = before.indexOf(START);
  const end = before.indexOf(END);
  if (at < 0 || end < at) return false;
  const rest = (before.slice(0, at).trimEnd() + '\n' + before.slice(end + END.length).replace(/^\s+/, '')).trim();
  if (rest) writeFileSync(file, rest + '\n');
  else rmSync(file);
  return true;
}
