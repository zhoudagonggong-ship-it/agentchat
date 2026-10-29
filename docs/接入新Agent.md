# 怎么接入一个新的 Agent

AgentChat 里每一家 Agent 都是一个**适配器**。适配器负责把这家 Agent 的对话「翻译」成 AgentChat 统一的样子，再把手机发来的指令交给它。主电脑、手机、Agent 之间的互通都不用改，接入一家新 Agent，基本上就是写一个适配器，再把它登记到几个地方。

现有的四个适配器都可以拿来参考：

| 适配器 | 读对话 | 发消息 | 适合参考的地方 |
|---|---|---|---|
| `src/device/opencode/` | 它的本地服务 `/api` + 事件流 | 同一个服务 | **最简单、最推荐的起点**：有服务就全走服务 |
| `src/device/codex/` | 官方的 `codex app-server`（JSON-RPC） | 同上；桌面端占着对话时放进 Codex 自己的队列 | 各种审批和提问、和桌面端共用对话 |
| `src/device/claude/` | 读它的对话记录文件 | 在桌面端窗口里输入；不行就用命令行 `claude -p --resume` | 读文件、用钩子（hooks）把审批送到手机 |
| `src/device/goose/` | 只读打开它的 SQLite | 在它的窗口里输入（UI Automation）；不行就用 `goose acp` | 自动操作窗口：没人用电脑时才动、做完把焦点还回去 |

## 1. 先确认这家 Agent 能接

至少要满足下面三条：

- 能**列出对话**：标题、最后更新时间、工作目录。
- 能**读出对话内容**：双方的消息，最好还有它执行过的命令和改过的文件。
- 能**往已有对话里发一条消息**，并且这条消息出现在 Agent 自己的界面里。

最好还能做到：停止正在运行的一轮、在审批或提问时把请求交出来并接收回答、新建对话。

能用的接口按推荐程度排序：
1. Agent 自己的本地服务（HTTP / WebSocket）；
2. 官方协议（JSON-RPC、ACP、MCP）；
3. 官方命令行；
4. 只读它的数据文件，再配合自动操作它的窗口。

不接受破解、改它的程序文件，或者直接往它的数据库里写东西。

## 2. 写适配器

在 `src/device/<agent>/` 下新建 `adapter.ts`，把「翻译对话内容」的部分单独放进 `normalize.ts`，方便写测试。适配器要实现 `src/device/device.ts` 里的 `Adapter` 接口：

| 成员 | 做什么 |
|---|---|
| `info` | `{ id, kind, label }`，例如 `{ id: 'goose', kind: 'goose', label: 'Goose' }`。`id` 在同一台电脑上不能重复，也不要再改。 |
| `start(sink)` | 连上 Agent，报告全部对话（`sink.sessions(list, true)`）和项目（`sink.projects`），然后开始盯着变化。没装或者连不上就抛出错误，AgentChat 会当它不存在。 |
| `hydrate(threadId)` | 手机打开了这个对话：报告它最近的内容，之后有新内容也要实时报告。 |
| `command(threadId, command)` | 执行手机发来的指令（见第 4 步），无论成功失败都要回一个回执。 |
| `create?(cwd, title, first)` | 可选：新建一个叫 `title` 的对话。见第 5 步。 |

### 报告的内容（`AdapterSink`）

| 方法 | 用途 |
|---|---|
| `sessions(list, complete)` | 对话列表（`SessionInfo`）。`complete = true` 表示这是全部对话，不在列表里的会被当作已归档。平时只报有变化的，`complete = false`。 |
| `projects(list)` | 这家 Agent 自己的项目分组，按它界面里的顺序。没有分组就报告用过的工作目录。 |
| `items(threadId, items)` | 对话内容（`Item`），可以重复报告：同一个 `itemId` 会被更新，不会重复显示。 |
| `artifact(...)` / `artifactData(...)` | Agent 产出的文件。给路径或内容都行，主电脑会自动传上去。 |
| `delta(threadId, itemId, turnId, text)` | 正在生成的回复，一段一段地报告，手机上就能看到打字的效果。可选。 |
| `receipt(requestId, state, turnId?, error?)` | 指令的回执：`accepted` 表示 Agent 收下了，`failed` 表示失败，`error` 里写原因代码。 |

`SessionInfo` 里，`running` 和 `activeTurnId` 要尽量准确：手机靠它们显示「正在运行」，Agent 之间等回复时，也靠它们判断这一轮做完了没有。`preview` 是最新一句话（截短），显示在对话列表里。

### 对话内容（`Item`）的几种类型

| `kind` | `data` |
|---|---|
| `message` | `{ role: 'user' \| 'assistant', text, clientId? }`。手机发出的那条消息，如果 Agent 能带回它的编号，就放在 `clientId` 里，手机就能确认「送到了」。 |
| `tool_call` | `{ tool: 'shell' \| 'edit' \| 'web' \| 其他名字, summary, status: 'inProgress' \| 'completed' \| 'failed', output, error }`。`output` 只保留结尾几千个字。 |
| `status` | 每一轮的结束：`{ status: 'completed' \| 'failed' \| 'interrupted', startedAt, completedAt, error }`。`itemId` 用 `turn:<轮次编号>`。 |
| `approval_request` | 审批或提问，见第 4 步。 |
| `artifact` | 产出的文件。不用自己拼：调用 `sink.artifact` / `sink.artifactData`，AgentChat 会生成。 |

同一轮的所有内容用同一个 `turnId`。Agent 自己没有轮次编号的话，就把「一条用户消息到下一条用户消息之间」算作一轮，用那条用户消息的编号当 `turnId`，参考 `opencode/normalize.ts`。

## 3. 尊重 Agent 自己的窗口

这一步最容易出问题，请务必照做：

- **让 Agent 自己写对话。** 主人在 Agent 的桌面窗口里开着这个对话时，消息要通过窗口（或者窗口背后的同一个服务）发进去，窗口里才能马上看到。从窗口背后另开一个进程写进去，窗口往往要重启才看得到，还可能把对话分叉。
- **自动操作窗口时**，参考 `goose/desktop-send.ps1`：
  - 用 Windows UI Automation 点按钮、填输入框，不模拟鼠标和键盘；
  - 只在 **30 秒内没人碰键盘鼠标** 时才动，否则返回 `in_use`；
  - 锁屏时不动；
  - 输入框里有没发出去的字时不动，不能把主人的草稿弄丢；
  - 做完把焦点还给主人原来的窗口。
- **用完就放手。** 如果 Agent 在对话被占用时会拒绝别人写（比如 Codex 的 `active writer`），一轮做完要真正放开它，否则主人在桌面端就没法接着写。

## 4. 执行指令

`command.op` 有三种：

- **`send`：发消息。** 正文在 `command.text`。手机发来的文件已经存到本机，路径在 `command.files[].path`；用 `withAttachments(text, files)` 把文件路径写进正文。这一轮还在跑的话，能插话就插话，不能就回 `failed` / `busy_on_computer`。
- **`interrupt`：停止正在运行的那一轮。** 没有在运行的就回 `failed` / `no_active_turn`。
- **`approve`：回答审批或提问。** 用 `command.approvalId` 找到对应的请求；`command.decision` 是 `accept`、`decline` 或 `cancel`；提问的答案在 `command.answers` 里，按问题的 `key` 存放。

Agent 来要审批时，报告一个 `approval_request`：

```
{ itemId: 'approval:<id>', turnId, kind: 'approval_request',
  data: { approvalId, kind: 'command' | 'file' | 'permissions' | 'mcp' | 'question',
          command, cwd, reason, questions?, state: 'pending' } }
```

手机或电脑上有人回答之后（谁先答算谁的），把 `state` 改成 `accepted`、`declined` 或 `answered` 再报告一次。一直没人回答的，超时后按「拒绝」处理，`state` 写 `expired`。提问的 `questions` 格式参考 `codex/adapter.ts` 里的 `formQuestions`。

失败的原因代码（`error`）要在 `web/app.js` 的 `REQ_ERRORS` 里加一句给人看的中文。

## 5. 新建对话（可选）

`create(cwd, title, first)` 要新建一个名字叫 `title` 的对话，并且主人在 Agent 自己的界面里也看得到：

- 能先建空对话再发消息的（Codex、OpenCode），建好后返回 `{ threadId }`，第一条消息由 AgentChat 接着照常发送。
- 对话有了第一条消息才算存在的（Claude Code、Goose），就带着 `first` 一起建，返回 `{ threadId, sent: true }`，`first` 的回执照常报告。

## 6. 登记到 AgentChat

适配器写好以后，还要在这几处登记：

| 位置 | 加什么 |
|---|---|
| `src/shared/protocol.ts` | `AgentInfo.kind` 加上新的种类 |
| `src/worker.ts` 的 `detectAgents()` | 检测这家 Agent 装了没有，装了就 `new` 一个适配器。检测要很轻：每 2 分钟就会跑一次，只查几个文件在不在，不要每次都启动程序。 |
| 适配器的 `start()` | 把 AgentChat 工具（`src/device/tool.ts` 的 `toolCommand`）用这家 Agent 自己的方式注册成 MCP，再用 `installHint()` 把说明写进它的全局说明文件，这样它的新对话就知道能用 AgentChat。都要合并、不覆盖，已经有了就不再动。 |
| `src/uninstall.ts` | 把上面加的东西都撤回去 |
| `web-control/index.html` 的「这台电脑上还没有 Agent」卡片、`README.md` 的表格 | 加上官方下载链接 |

## 7. 测试

- **`test/<agent>-normalize.test.ts`：** 用真实的样例数据（去掉个人内容）测试「翻译」结果，参考 `test/opencode-normalize.test.ts`。
- **注册和撤回：** 测试加进 Agent 设置里的东西能原样撤回，参考 `test/uninstall.test.ts`。
- **在真机上走一遍：**
  1. 手机上能看到对话列表和内容；
  2. 从手机发一条消息，Agent 的窗口里马上出现，回复也回到手机；
  3. 在 Agent 里触发一次审批，手机上能批；
  4. 用 AgentChat 工具让另一个 Agent 给它发一条消息，并拿回回复。

## 提交前对照一遍

先用 [设计原则](设计原则.md) 里的三个问题问一遍自己，再对照下面的清单：

- [ ] 只用了这家 Agent 的开放接口，没往它的数据里直接写东西
- [ ] 主人开着它的窗口时，从手机发的消息在窗口里马上看得到
- [ ] 自动操作窗口时，遵守 30 秒没人用、锁屏不动、有草稿不动、焦点还回去
- [ ] 回执、审批、停止都有回应，失败原因在 `REQ_ERRORS` 里有中文说明
- [ ] 检测足够轻，没装这家 Agent 的电脑上不报错
- [ ] 注册的工具和说明能被 `uninstall.ts` 撤回
- [ ] 测试全部通过
