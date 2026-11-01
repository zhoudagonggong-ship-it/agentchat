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
    description: '列出 AgentChat 里各台电脑上的 Agent（比如「5090 · OpenCode」）是否在线，以及它们最近的对话（含每个对话现在用的模型 model、后台在跑的任务数 background）。发消息前先用它找对象。',
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
        title: { type: 'string', description: '新建一个这个名字的工作对话，把消息作为它的第一条（要同时给 to）。Claude Code、OpenCode、Codex 都支持。'
          + 'Codex：老周指定了对话、Codex 里也有，就用 conversation 发进那个对话；老周没指定，或指定的找不到，就用 title 新建。'
          + '对话正开在 Codex 软件里时，消息交给软件跑（老周看得到，模型不换，停止在软件里点）；没开着时由 AgentChat 自己跑（能用 model、effort 选模型，能 stop，请示发给你）。新建的对话 Codex 软件要重启后才显示' },
        newConversation: { type: 'boolean', description: '只为传话、主人不需要参与时：发到你和对方之间专门传话的对话（要同时给 to）' },
        cwd: { type: 'string', description: '新建对话时对方电脑上的工作目录（可省略，用对方的默认目录）。Codex 也可以直接写 Codex 软件里的项目名（如「自媒体博主运营」），对话就建在那个项目下；老周指定了项目时一定要填。Codex 不填就建在老周专门建的「AgentChat」项目下' },
        text: { type: 'string', description: '要发的内容' },
        files: { type: 'array', items: { type: 'string' }, description: '一起交给对方的文件：你这台电脑上的完整路径（最多 9 个，每个最多 25 MB）。对方会在它的电脑上收到这些文件，消息里写明存放位置。对方这一轮产出的文件，也会随汇报自动带回给你' },
        wait_minutes: { type: 'number', description: '等它做完最多几分钟（默认 5，0 表示发完就返回；没做完可以再用 wait）' },
        model: {
          type: 'string',
          description: '让对方从这条消息起用哪个模型（可选；新建对话和已有对话都行）。写法照 agents 里对话显示的 model：'
            + 'Codex 如 gpt-6.1-terra、gpt-6.1-sol、gpt-6-astra；OpenCode 写「提供方/模型名」，如 deepseek/deepseek-v4-pro。目前 Codex、OpenCode 支持',
        },
        effort: {
          type: 'string',
          description: '推理强度（可选）：Codex 如 low / medium / high / xhigh / max；OpenCode 是模型的档位，如 DeepSeek 的 none / low / high / max。不认识的会报错并列出可选的',
        },
        rules: {
          type: 'array',
          description: '这件活的规矩（可选）：你是派活方，你定规矩，AgentChat 设进对方的对话，由对方的程序强制执行，不靠它自觉。'
            + 'effect 为 ask 的，对方做到那一步会停下来，把请示发到你的对话，由你用 approve 批；deny 的直接不许做。'
            + '例：[{"tool":"edit","match":"*/test/*","effect":"ask"}, {"tool":"shell","match":"*rerun*","effect":"ask"}, {"tool":"edit","match":"*/lib/core/*","effect":"deny"}]。'
            + 'tool 常用 edit（改写文件，match 对文件路径，路径用 / 分隔）、shell（执行命令，match 对命令原文）、read（读文件）。match 用 * 通配。'
            + '规矩只认字面，拆字可以绕过，所以结果仍要核对。目前 OpenCode 支持，其他 Agent 会告诉你没设上',
          items: {
            type: 'object',
            properties: {
              tool: { type: 'string', description: 'edit / shell / read 等' },
              match: { type: 'string', description: '通配符：文件路径或命令原文' },
              effect: { type: 'string', enum: ['ask', 'deny', 'allow'] },
            },
            required: ['tool', 'match', 'effect'],
          },
        },
      },
      required: ['text'],
    },
  },
  {
    name: 'approve',
    description: '答复你派出去的活里对方的请示。对方碰到要批准的事（你定的 ask 规矩、它的程序要权限、它问你问题），AgentChat 会把「…的请示」发到你的对话：'
      + '你是这件活的负责人，按主人给你的要求来判断，不要转去问主人。30 分钟没答复，请示会交给主人。',
    inputSchema: {
      type: 'object',
      properties: {
        approval: { type: 'string', description: '请示里给的编号' },
        decision: { type: 'string', enum: ['allow', 'allow_all', 'deny'], description: 'allow：只批这一条；allow_all：批这条，并且这一轮里同类的不再问（对方老在问差不多的命令时用）；deny：不批' },
        message: { type: 'string', description: '说给对方的话：为什么不批、改怎么做，或批准时的提醒' },
        answers: { type: 'object', description: '对方问问题时的回答：按请示里列的键填，比如 {"q0": "用方案二"}' },
      },
      required: ['approval', 'decision'],
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
    name: 'know',
    description: '查 AgentChat 知识库：所有电脑上的 Agent 共用的一本。里面有各台电脑装了什么、模型和程序放在哪、怎么用（事实），踩过的坑（经验），'
      + '以及主人定的协作手册（规则）。开工前，凡是要用到某台电脑上的东西（模型、软件、目录、账号配在哪），先查这里，不要凭自己的记忆或只搜几个目录就下结论。'
      + '不带 query 看全部标题；query 写「协作手册」读完整手册。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要查什么，比如「ComfyUI 模型」「FLUX」「ffmpeg」' },
        computer: { type: 'string', description: '只看某台电脑的（电脑名，比如 office-pc），可省略' },
      },
    },
  },
  {
    name: 'learn',
    description: '往 AgentChat 知识库里记一条，所有电脑上的 Agent 马上都能查到，派活时也会自动附给对方。'
      + '查清楚了某台电脑上有什么、在哪、怎么用，或发现知识库里写的和实际不一样，就记下来（不一样的用 replaces 改正那一条）。'
      + '只记查实的，写上怎么查实的；不要写密钥、密码的值，只写它配在哪里。协作规则由主人定，不在这里改。',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '标题，一句话，比如「ComfyUI 和生图模型在哪」' },
        body: { type: 'string', description: '内容：具体路径、版本、用法、状态（文件在 / 跑通过 / 质量验收过），以及怎么查实的' },
        keys: { type: 'array', items: { type: 'string' }, description: '关键词（1～12 个）：别人的任务里出现这些词，这条会自动附上。比如 ["ComfyUI", "FLUX", "生图", "模型"]' },
        computer: { type: 'string', description: '说的是哪台电脑（电脑名，比如 office-pc）；对所有电脑都成立就省略' },
        kind: { type: 'string', enum: ['fact', 'lesson'], description: 'fact：事实（默认）；lesson：经验教训' },
        replaces: { type: 'string', description: '改正已有的哪一条：它的编号（know 查到的 id）' },
      },
      required: ['title', 'body', 'keys'],
    },
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
    case 'know':
    case 'learn':
    case 'approve':
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
