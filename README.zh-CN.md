<h1 align="center">ChatGPT Web for Codex</h1>

<p align="center">
  <strong>将 ChatGPT Web（包括 Pro）作为 Codex 原生模型使用。</strong><br>
  切换模型档位，保留原有工作流。
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="https://github.com/miuuyy/codex-chatgpt-web/actions/workflows/ci.yml"><img src="https://github.com/miuuyy/codex-chatgpt-web/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/macOS-arm64%20%7C%20x64-black?logo=apple" alt="macOS arm64 and x64">
  <img src="https://img.shields.io/badge/Windows-x64-0078d4?logo=windows11" alt="Windows x64">
  <img src="https://img.shields.io/badge/Linux-x64-fcc624?logo=linux&logoColor=black" alt="Linux x64">
  <img src="https://img.shields.io/badge/Free_AI-no_API_fees-10a37f" alt="Free AI with no API fees">
</p>

Free 和 Go 账户会在 Codex 原生模型选择器中看到 **ChatGPT Web — Luna**。具有推理选择器的
账户仍会按订阅权限看到 **Instant**、**Medium**、**High**、**Extra High** 和 **Pro**。
桥接程序会把当前编译后的 Codex 任务上下文发送到一个全新的 ChatGPT 临时聊天，附加图片，
并将可见的推理过程、工具活动和 Markdown 流式传回同一个 Codex 任务。

<p align="center">
  <img src="assets/demo.gif" alt="ChatGPT Web 实时轮次正在使用原生 Codex harness" width="960">
</p>

```text
Codex task ──Responses + SSE──▶ codex-chatgpt-web ──embedded browser──▶ ChatGPT
     ▲                                │                                      │
     └──────── native UI, context, images, tracing, and tool lifecycle ──────┘
```

Codex 会保留原生任务、上下文生命周期、界面和工具 harness。本地 Responses 桥接程序只会将
所选模型的任务转发到与该任务绑定的 ChatGPT 临时聊天；在完整模式下，MCP 会把 ChatGPT 连接回
同一个 Codex 任务的工具，直到下一次上下文压缩边界。

> [!TIP]
> 我还开发了 **[ChatGPT Persona Voice](https://github.com/miuuyy/ChatGPT-Persona-Voice)**：一款
> 能够近实时改变 ChatGPT/Codex 声音的本地应用。它不会接触你的账户、浏览器会话或 ChatGPT
> 请求，因此不会带来账户封禁风险。如果你喜欢我的作品，欢迎试用。

## 亮点

- **Codex 原生模型。** ChatGPT Web 直接出现在 Codex 模型选择器中，同时保留原有任务界面、
  上下文生命周期、流式输出、追踪和工具展示。
- **通过 MCP 使用完整 Codex harness。** 完整模式支持登录账户公开的全部 effort（包括 Pro），
  并可访问当前任务的文件系统、shell、图片、审批以及已配置的工具和应用。
- **连续任务会话与原生上下文压缩。** 连续消息会复用同一个与任务绑定的临时聊天。到达上下文
  边界时，保留的 agent 会先写出检查点，再由 Codex 从干净聊天继续；若该私有聊天已被关闭，
  则使用 Codex 的规范任务历史作为回退来源。
- **统一的跨平台启动器。** macOS、Windows 和 Linux 应用统一管理登录、模型设置、MCP 指南、
  健康检查、安全诊断以及最多五个可见的任务绑定浏览器标签页。
- **故障时明确失败。** 模型、工具缺失或 ChatGPT UI 发生变化时会返回明确错误，而不会静默切换
  路由或能力。端到端覆盖范围记录在[发布验证](docs/release-validation.md)中。

临时聊天是 ChatGPT 的隐私模式，并不代表匿名或仅在本地推理：提示仍会由 OpenAI 处理，并受账户
设置及 OpenAI [临时聊天政策](https://help.openai.com/en/articles/8914046-temporary-chat-faq)
约束。本项目为非官方项目；用户仍需自行遵守适用的 OpenAI 条款和工作区政策。

## 快速开始

安装或更新桌面启动器。若要更新或修复现有安装，请先退出启动器，然后再次运行同一条命令；它会
替换应用程序和内置运行时，同时保留 ChatGPT 配置文件和启动器配置。

**macOS 或 Linux**

```bash
curl -fsSL https://github.com/miuuyy/codex-chatgpt-web/releases/latest/download/install-launcher.sh | sh
```

**Windows PowerShell**

```powershell
irm https://github.com/miuuyy/codex-chatgpt-web/releases/latest/download/install-launcher.ps1 | iex
```

然后在应用中完成三项检查：

1. 直接在启动器的私有内置 ChatGPT 浏览器中登录。如果账户要求通行密钥或高级浏览器安全，请显式
   选择 **通行密钥登录**。启动器会使用确定性选出的受支持 Chrome/Chromium 可执行文件创建一个由
   启动器管理的全新临时 profile，并以普通浏览器方式启动。完成登录并确认临时聊天已就绪后，请
   返回启动器并选择 **我已登录 — 继续**。启动器只关闭该专用浏览器，通过私有调试管道在禁用联网的
   情况下重新打开其隔离 profile，并只提取允许的 ChatGPT/OpenAI 状态。Electron 随后会独立证明
   准确的临时聊天和服务端会话，最后删除临时 profile 与传输文件。
2. 运行浏览器冒烟测试。
3. 点击 **安装模型**，重启一次 Codex，然后选择一个 **ChatGPT Web — …** 模型。

启动器会在设置期间检测当前账户的 ChatGPT 控件：Free/Go 账户只会显示 Luna；只有已登录账户
支持 Pro 时，Pro 才会显示。独立的 **MCP** 页面是可选项，它会在不需要终端命令的情况下引导你
完成完整 harness 设置。

打包后的启动器通常在内置浏览器中完成登录并运行模型轮次，因此不需要已安装的浏览器、模型 API
密钥、系统级 Node/Bun，也不会由本项目另行下载浏览器。可选的通行密钥交接会准确使用已配置的
受支持 Chrome/Chromium 可执行文件；若未配置，则使用设置流程随后会持久化的同一平台 Google
Chrome 默认路径。它不会打开系统默认浏览器，也不会复用普通浏览器 profile。

**从源码运行**

```bash
git clone https://github.com/miuuyy/codex-chatgpt-web.git && \
cd codex-chatgpt-web && \
bun run app
```

源码方式需要 Bun 1.4.0。该命令会安装锁定版本的依赖并打开应用。

## 模式

| 模式 | 模型 | 本地 Codex 工具 | 额外设置 |
| --- | --- | --- | --- |
| **仅浏览器** | Free/Go：Luna；Plus：Instant–High；Pro：增加 Extra High 和 Pro | 不可用；Codex 会显示警告 | 默认无需额外设置 |
| **完整 harness** | Free/Go：Luna；Plus：Instant–High；Pro：增加 Extra High 和 Pro | 每个列出的 effort 均支持，包括 Pro | OpenAI 隧道 + ChatGPT 连接器 |

模型选择器中的每一项都对应一个固定的 ChatGPT 模式。Codex 仍会显示内置的 Effort 和 Speed
选项，但更改它们不会在后台静默切换所选的浏览器模型。在完整模式下，每一个可用 effort 都会
获得同一个与当前回合绑定的 MCP 能力；Pro 没有单独限制，也没有缩减后的工具契约。可选的通行密钥
交接与模式无关，并需要上文所述的已安装且受支持的 Chrome/Chromium 可执行文件。

## 完整 harness

完整模式通过官方
[OpenAI tunnel-client](https://github.com/openai/tunnel-client)
将 ChatGPT 的工具调用连接回当前 Codex 任务。该隧道为出站连接：不会暴露公网 IP、开放入站端口，
也不需要配置路由器端口转发。

> [!WARNING]
> 请创建名为 **Codex Native2** 的**新**连接器，并将权限设置为 **允许所有操作**。不要重命名、
> 刷新或复用旧的 **Codex Native** 连接器：ChatGPT 会按连接器身份缓存公开 MCP 合约，而
> **允许低风险操作** 会在命令和补丁到达 Codex harness 前将其拦截。

1. 完成启动器中的必需设置。
2. 在启动器中打开 **MCP**。请在将使用 ChatGPT 连接器的同一个 OpenAI 账户中创建 Tunnel
   和普通 API 密钥；创建密钥本身免费，也不会消耗模型 API 额度。
3. 粘贴 Tunnel ID 和 API 密钥，然后点击 **连接 Harness**。
4. 在 ChatGPT 设置中启用 **开发者模式**。新建连接器时选择 **Tunnel**，选择刚创建的
   Tunnel，将 **身份验证** 设为 **无**，并将名称准确设置为 **Codex Native2**。
5. 如果已有旧的 **Codex Native** 连接器，请保持其不变。不要重命名或刷新它：ChatGPT 会按
   连接器身份缓存公开 MCP 合约，而此版本使用新的直接 turn-token 合约。在 **Codex Native2**
   的 **权限** 中选择 **允许所有操作**；**允许低风险操作** 会在命令和补丁到达本地运行时前将其
   拦截。外层 Codex harness 仍会执行沙箱和审批规则。
6. 运行 **验证运行时**。它只会准确选择 **Codex Native2**。如果只找到 **Codex Native**，
   验证会返回明确的迁移错误，而不会接受旧连接器。

写入/修改操作还需要 ChatGPT 工作区及其管理员政策允许。请参阅
[开发者模式和 MCP 应用](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt)。
除非显式启用 `--auto-approve-tool-calls`，否则意外的审批提示会直接失败；该选项只会点击
**Allow once**，绝不会授予永久权限。

## 日常操作

使用 **活动** 页面查看安全的本地诊断，并通过 **设置 → 运行诊断** 执行端到端健康检查。设置页还可
取消保留的浏览器任务，或在卸载前移除 Codex 集成。仅在需要为每个浏览器检查点保存截图时设置
`CODEX_CHATGPT_WEB_BROWSER_DIAGNOSTICS=1`。

新安装默认使用 **Compatibility V1** 以支持跨后端 subagent。**Native** 会保留 Codex 自身的
功能设置，并启用明文 Web-to-Web V2 委派。切换协议后，请重启 Codex 并创建新任务：

```bash
codex-chatgpt-web subagents status
codex-chatgpt-web subagents compatibility-v1
codex-chatgpt-web subagents native
```

## 限制和安全性

- 这是非官方浏览器自动化，并非 OpenAI API。ChatGPT UI 变更可能破坏选择器；发生变化时会明确
  失败，而不是静默切换模型或传输方式。
- 浏览器状态和通行密钥流程中的短期传输文件都是敏感登录凭据。浏览器控制使用启动器所拥有的
  子进程调试管道，而不是 TCP 监听器；profile 和传输文件仍位于当前 OS 用户的信任边界内。
  切勿共享启动器 profile，并且只在可信工作站上使用通行密钥登录。
- 通行密钥和身份提供商交互只发生在普通浏览器阶段。之后的受管理捕获阶段会阻止外部联网，也不会
  伪装自动化；导入的会话首先由 Electron 独立接受或拒绝。
- 发布包目前支持 macOS 13+（arm64/x64）、Windows x64 和 Linux x64。运行时、测试和打包会在
  CI 中对三种系统进行检查；依赖账户的浏览器与 MCP 流程使用单独的
  [发布验证](docs/release-validation.md)。
- 构建目前尚未进行平台签名，因此 Gatekeeper 或 SmartScreen 可能会显示警告。安装程序会在安装前
  验证已发布的 SHA-256 清单。

启用完整模式前，请阅读完整的[架构说明](docs/architecture.md)和
[安全模型](docs/security-model.md)。安全漏洞请通过 [SECURITY.md](SECURITY.md) 报告。

## 开发

```bash
bun run app
bun run dev:launcher
bun run src/cli.ts dev status
bun run dev:chat compaction-lab "Reply with exactly: DEV READY"
bun run verify
bun run smoke:subagents
bun run app:package
```

`dev:launcher` 会在 `~/.codex-chatgpt-web-dev` 下启动第二个独立的启动器配置：Electron 状态、
浏览器 Cookie/登录、ChatGPT 账户、配置、沙箱化 `CODEX_HOME`、聊天、诊断、broker 和 tunnel
配置均与正式启动器隔离。它可以与正式启动器同时运行，绝不会启动 Responses daemon 或修改
Codex。可选的完整模式只会启动并监管隔离的 DEV MCP tunnel，并使用独立连接器名称
`Codex Native2 DEV`。

`dev:chat` 是一个具名、持久的合成外层 Codex harness。它通过隔离的启动器浏览器、临时聊天、
prompt compiler、Responses parser 和压缩处理器执行当前工作树。可选的完整模式也会测试 MCP
连接器和 broker；工具效果会显示为明确的模拟回执。仅浏览器聊天不会暴露外层工具。该命令不会
打开 Responses listener、修改 `openai_base_url`、停止正式 daemon，也不会占用 17841 端口。
不带消息运行时，可使用 `/status`、`/fill 30000`、`/compact`、`/model` 和 `/reset`。首次使用时，
请在标有 **DEV** 的窗口中登录并初始化一次配置。完整模式仅用于模拟工具轮次；DEV 启动器会保持
DEV tunnel 就绪，具名聊天按需连接 broker。正式凭据和 `Codex Native2` 连接器绝不会被隐式复用。
详见 [DEV chat harness](docs/dev-chat.md)。

- [架构说明](docs/architecture.md)
- [DEV chat harness](docs/dev-chat.md)
- [安全模型](docs/security-model.md)
- [贡献指南](CONTRIBUTING.md)

## Star History

<a href="https://www.star-history.com/?repos=miuuyy%2Fcodex-chatgpt-web&type=date&legend=top-left">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=miuuyy/codex-chatgpt-web&type=date&theme=dark&legend=top-left&sealed_token=hBVvg_eOjfMFDrfyeo5FPQkIwcvBEmXc6F7ZoOKnfFE4KPCs67o34w4XwVuM-bHGnKR-SKCAN_TSTWrzuqSBNU-RjNZCLT4f-xNs9qcDhciQtemxHKuuFj0N5YNqZIihdaQfakrh2ANhOrvP0K2LmLXX2zbsYyVaYZknyTnlYeIS_mOGvMcO32ZmPCHK">
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=miuuyy/codex-chatgpt-web&type=date&legend=top-left&sealed_token=hBVvg_eOjfMFDrfyeo5FPQkIwcvBEmXc6F7ZoOKnfFE4KPCs67o34w4XwVuM-bHGnKR-SKCAN_TSTWrzuqSBNU-RjNZCLT4f-xNs9qcDhciQtemxHKuuFj0N5YNqZIihdaQfakrh2ANhOrvP0K2LmLXX2zbsYyVaYZknyTnlYeIS_mOGvMcO32ZmPCHK">
    <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=miuuyy/codex-chatgpt-web&type=date&legend=top-left&sealed_token=hBVvg_eOjfMFDrfyeo5FPQkIwcvBEmXc6F7ZoOKnfFE4KPCs67o34w4XwVuM-bHGnKR-SKCAN_TSTWrzuqSBNU-RjNZCLT4f-xNs9qcDhciQtemxHKuuFj0N5YNqZIihdaQfakrh2ANhOrvP0K2LmLXX2zbsYyVaYZknyTnlYeIS_mOGvMcO32ZmPCHK">
  </picture>
</a>

## 免责声明

本项目是独立软件，与 OpenAI 无关联，也未获得 OpenAI 背书。请仅使用自己的账户，并遵守适用的
[使用条款](https://openai.com/policies/terms-of-use/)和工作区政策；本项目不会绕过身份验证或
访问控制。
