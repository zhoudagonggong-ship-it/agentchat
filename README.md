# AllinOne

在手机上查看和操作你每台电脑上的 AI Agent（Codex、Claude Code、OpenCode、Goose）：看它们在做什么、给它们发消息、替它们点审批，还能让不同电脑上的 Agent 互相派活。

- 所有电脑装同一个程序。其中一台常开的电脑当**主电脑**，负责连接你的手机和其他电脑。
- 电脑和手机之间通过 [Tailscale](https://tailscale.com)（免费）安全地连在一起，不经过任何第三方服务器。
- 目前支持 **Windows 10 / 11** 电脑和**安卓**手机。iPhone 可以用浏览器打开网页版，但没有后台提醒。

## 安装

### 第一台电脑

1. 下载最新的 `AllinOne-<版本>.zip`，解压，双击里面的 **Setup.cmd**。
   - 如果 Windows 提示「Windows 已保护你的电脑」，点「更多信息」→「仍要运行」。AllinOne 是开源程序，没有购买代码签名证书，所以会有这个提示。
2. AllinOne 的窗口会自动打开，并一步步带你装好 Tailscale：
   - 下载并安装 Tailscale；
   - 用浏览器登录 Tailscale 账号（Google、微软账号都可以）；
   - 在 Tailscale 网页上点一次「Enable」，打开 HTTPS。

   每一步做完，窗口都会自动进入下一步。
3. 窗口问「这台电脑平时开着吗？」时，点「是」，它就成了主电脑。

安装后桌面上会有 AllinOne 图标，开机自动启动；右下角有一个圆点图标：绿色是正常，橙色表示有事要你处理，灰色表示已暂停。

### 其他电脑

同样双击 Setup.cmd，然后登录**同一个** Tailscale 账号。它会自动找到主电脑并加入，不用你做别的。

### 手机

1. 手机上安装 Tailscale（应用商店搜「Tailscale」），登录和电脑**同一个**账号。
2. 在主电脑的 AllinOne 窗口里点「添加手机 → 显示二维码」，用手机相机扫码。
   - 还没装 AllinOne App 的话，打开的网页会一步步教你安装，装好就自动配对。

### 让 Agent 出现在手机上

在电脑上装好任意一个 Agent，打开并登录一次，2 分钟内手机的「通讯录 → 新的朋友」里就会出现它，点「添加」即可。窗口里也有各家的下载链接。

| Agent | 下载 |
|---|---|
| Codex | https://developers.openai.com/codex |
| Claude Code（在 Claude 桌面版里） | https://claude.com/download |
| OpenCode | https://opencode.ai/download |
| Goose | https://block.github.io/goose/ |

各家 Agent 自己的账号、模型和密钥，仍然在它们自己的软件里设置。

## 常见问题

**手机连不上？** App 会告诉你是 Tailscale 没装、没打开，还是被手机省电功能关掉了，并给出对应的按钮。最常见的情况是省电：把 Tailscale 的电池设置改成「不受限制」。

**换一台电脑当主电脑？** 在当前主电脑的窗口里：设置 → 主电脑「更换」→ 选目标电脑，点「移交给它」。其他电脑和手机会自动跟过去，对话记录也一起搬过去。

**有新版本？** 主电脑每天检查一次。有新版本时，窗口和手机上会出现「更新」按钮，点一下就会更新，其他电脑也会自动跟着更新。

**遇到问题想找人帮忙？** 右键右下角的圆点图标，选「导出诊断信息」，桌面上会出现一个诊断包，把它发给帮你看问题的人。里面的密码和密钥已经去掉了。

**卸载？** 开始菜单 → AllinOne → 卸载 AllinOne，或者在「设置 → 应用」里卸载。AllinOne 加进各家 Agent 的设置会一并撤掉；对话记录要不要保留，会先问你。

## 开发

- AllinOne 为什么这样设计、开发时对照什么：见 [docs/设计原则.md](docs/设计原则.md)。
- 想接入一个新的 Agent：见 [docs/接入新Agent.md](docs/接入新Agent.md)。
- 参与开发、提交改动：见 [CONTRIBUTING.md](CONTRIBUTING.md)。
- 程序结构、常用命令、怎么测试：见 [docs/开发说明.md](docs/开发说明.md)。

## 许可

[MIT](LICENSE)
