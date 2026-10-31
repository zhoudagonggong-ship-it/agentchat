// The AgentChat tool: an MCP server (stdio) that each agent on this computer runs, so it can reach the agents on
// every computer through AgentChat, the same road the owner's phone takes. It only talks to this computer's
// AgentChat (127.0.0.1); the hub does the rest. Started by the agent as `node mcp.ts --agent <agent id>`.
import { CONTROL_PORT } from '../shared/protocol.ts';
import { AGENT_HINT } from './tool.ts';

const VERSION = '1.0.0';
const agent = process.argv[process.argv.indexOf('--agent') + 1] ?? '';
// The conversation this tool serves, when the agent says (Claude Code starts one tool per conversation and names it in
// CLAUDE_CODE_SESSION_ID). The hub then knows where the sender works instead of guessing from what is running.
const thread = process.env.CLAUDE_CODE_SESSION_ID ?? '';

const TOOLS = [
  {
    name: 'agents',
    description: '列出 AgentChat 里各台电脑上的 Agent（比如「5090 · OpenCode」）是否在线，以及它们最近的对话。发消息前先用它找对象。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'send',
    description: '通过 AgentChat 给另一台电脑上的某个 Agent 发一条消息，可以等它做完把回复带回来。'
      + '优先发到主人和它正在用的已有对话里：主人也在那里看、会插话。'
      + '主人要你让对方开一个新的工作对话时，用 title 给它起名：会在对方那里新建这个名字的对话，主人在手机和对方软件里都看得到、能参与'
      + '（已有同名的就直接发进去）。只是为了传话、不需要主人参与时，才用 newConversation：它会用你和这个 Agent 之间专门传话的那一个对话'
      + '（没有就建一个，以后一直复用，主人的手机上不显示它）。'
      + '消息开头会自动标明是你发的；对方需要审批时由主人在手机上处理，你不能代为审批。'
      + '对方要做很久时不必一直等（wait_minutes 设小一点或 0）：做完后，对方的汇报会自动发回到你现在这个对话里，以「[来自 …的汇报，经 AgentChat 转发]」开头，你收到后接着做。'
      + '拿到结果后，在你自己的对话里向主人汇报。',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: '发给谁：「电脑 · Agent」（用 agents 查名字），或主人起的备注名' },
        conversation: { type: 'string', description: '发到对方的哪个已有对话：标题' },
        conversationId: { type: 'string', description: '或者直接给对话编号（agents / send 返回的 conversationId），给了就不用 to 和 conversation' },
        title: { type: 'string', description: '新建一个这个名字的工作对话，把消息作为它的第一条（要同时给 to）。Codex、Claude Code、OpenCode、Goose 都支持' },
        newConversation: { type: 'boolean', description: '只为传话、主人不需要参与时：发到你和对方之间专门传话的对话（要同时给 to）' },
        cwd: { type: 'string', description: '新建对话时对方电脑上的工作目录（可省略，用对方的默认目录；Goose 总是用它自己的默认目录）' },
        text: { type: 'string', description: '要发的内容' },
        files: { type: 'array', items: { type: 'string' }, description: '一起交给对方的文件：你这台电脑上的完整路径（最多 9 个，每个最多 25 MB）。对方会在它的电脑上收到这些文件，消息里写明存放位置。对方这一轮产出的文件，也会随汇报自动带回给你' },
        wait_minutes: { type: 'number', description: '等它做完最多几分钟（默认 5，0 表示发完就返回；没做完可以再用 wait）' },
      },
      required: ['text'],
    },
  },
  {
    name: 'read',
    description: '看某个对话最近的内容：双方的消息、执行过的命令、产出的文件、在等主人处理的审批。用来检查对方做了什么。',
    inputSchema: {
      type: 'object',
      properties: {
        conversationId: { type: 'string', description: '对话编号（agents / send 返回的）' },
        to: { type: 'string', description: '或者：「电脑 · Agent」' },
        conversation: { type: 'string', description: '和对话标题' },
        count: { type: 'number', description: '看最近几条（默认 10，最多 50）' },
        full: { type: 'boolean', description: '消息原文完整给出，不截断（汇报太长被省略时用；配合 count: 1 只看最后一条）' },
      },
    },
  },
  {
    name: 'stop',
    description: '停止你用 send 发起、对方还在做的那一轮。',
    inputSchema: { type: 'object', properties: { task: { type: 'string', description: 'send 返回的任务编号' } }, required: ['task'] },
  },
  {
    name: 'wait',
    description: '等 send 发起的任务做完，拿回对方的回复；也会告诉你对方是否在等主人审批。',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'send 返回的任务编号' },
        minutes: { type: 'number', description: '最多等几分钟（默认 5，最多 60）' },
      },
      required: ['task'],
    },
  },
];

/** Told to the agent when it starts (agents that show MCP server instructions put it in their system prompt). */
const INSTRUCTIONS = AGENT_HINT;

async function allinone(op: string, args: Record<string, unknown>): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${CONTROL_PORT}/api/agent`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-allinone': '1' }, body: JSON.stringify({ op, agent, thread, args }),
    });
  } catch {
    throw new Error('这台电脑上的 AgentChat 没有运行');
  }
  const out = (await res.json()) as { result?: unknown; error?: string };
  if (!res.ok || out.error) throw new Error(out.error ?? `AgentChat ${res.status}`);
  return out.result;
}

async function call(name: string, args: Record<string, any>): Promise<unknown> {
  switch (name) {
    case 'agents':
      return allinone('agents', {});
    case 'send': {
      const sent = (await allinone('send', args)) as { task: string };
      const minutes = args.wait_minutes ?? 5;
      if (!(minutes > 0)) return sent;
      return { ...sent, ...((await allinone('wait', { task: sent.task, minutes })) as object) };
    }
    case 'wait':
      return allinone('wait', { task: args.task, minutes: args.minutes ?? 5 });
    case 'read':
    case 'stop':
      return allinone(name, args);
    default:
      throw new Error(`没有这个工具：${name}`);
  }
}

const send = (msg: Record<string, unknown>) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');

async function onMessage(m: any): Promise<void> {
  if (m.id === undefined) return; // notifications (initialized, cancelled) need no answer
  switch (m.method) {
    case 'initialize':
      return send({ id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} },
        serverInfo: { name: 'allinone', version: VERSION }, instructions: INSTRUCTIONS } });
    case 'ping':
      return send({ id: m.id, result: {} });
    case 'tools/list':
      return send({ id: m.id, result: { tools: TOOLS } });
    case 'tools/call':
      try {
        const result = await call(String(m.params?.name ?? ''), m.params?.arguments ?? {});
        return send({ id: m.id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } });
      } catch (error) {
        return send({ id: m.id, result: { content: [{ type: 'text', text: (error as Error).message }], isError: true } });
      }
    default:
      return send({ id: m.id, error: { code: -32601, message: `not supported: ${m.method}` } });
  }
}

let buf = '';
let busy = 0;
let ended = false;
const maybeExit = () => ended && !busy && process.exit(0);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      continue; // not JSON: ignore
    }
    busy++;
    void onMessage(message).finally(() => {
      busy--;
      maybeExit();
    });
  }
});
// The agent closed our input: finish the calls in hand, then go.
process.stdin.on('end', () => {
  ended = true;
  maybeExit();
});
