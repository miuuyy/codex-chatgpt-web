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
所选模型的轮次转发到全新的 ChatGPT 临时聊天；在完整模式下，MCP 会把 ChatGPT 连接回同一个
Codex 任务的工具。

## 亮点

- **精致的跨平台启动器。** 一条命令即可安装原生 macOS、Windows 或 Linux 应用。登录流程、设置、
  冒烟测试、MCP 指南、运行状态和本地日志都集中在同一处；内置浏览器还能让你实时看到每个
  ChatGPT 轮次的执行过程。最多可同时运行五个与 Codex 任务绑定的浏览器标签页；此上限用于避免
  对 ChatGPT 账户产生过多并行流量。
- **ChatGPT 就是所选模型。** 它作为 Codex 原生模型运行，而不是由另一个宿主模型调用的工具。
  原有的模型选择器、任务生命周期、流式输出、追踪和工具界面保持不变。
- **本地优先的任务会话。** Codex 仍然是电脑上任务历史的真实来源。每个浏览器轮次都会从一个
  全新的 ChatGPT 临时聊天开始，并接收当前编译后的上下文。达到实测浏览器上限时会触发压缩，
  Luna 则通过自适应滚动检查点携带已完成的状态。浏览器聊天不会在任务之间复用，也不会加入普通
  ChatGPT 历史记录。
- **通过 MCP 使用完整 Codex harness。** 在完整模式下，Instant 到 Extra High 可以通过 MCP
  使用当前 Codex 任务的文件系统、shell、图片、审批以及已配置的工具和应用。调用及其真实结果
  会留在同一个浏览器响应中，不会被模拟成文本。
- **Pro 仍然实用。** Pro 是唯一的例外：ChatGPT 当前的 Pro 模式不会暴露此桥接程序所需的自定义
  MCP 连接器。它的原生能力（包括网页搜索和研究）仍然可用。你可以先用 Instant 到 Extra High
  收集本地工作区上下文，再切换到 Pro；Pro 会收到当前编译后的 Codex 上下文，用于更深入的分析，
  同时仍受实测浏览器上限和压缩规则约束。
- **故障时明确失败，并经过人工测试。** 模型选择、超长内联上下文、图片、流式输出、可见追踪、
  上下文压缩、原生工具轮次、取消操作和 Pro 均已在 macOS 和 Windows 11 上完成端到端测试。
  UI 变化或能力缺失会产生明确错误，而不是静默回退。

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

1. 在启动器打开的系统默认浏览器窗口中登录，然后关闭该专用窗口。启动器会先验证会话，
   再将其导入私有的内置浏览器 profile。
2. 运行浏览器冒烟测试。
3. 点击 **安装模型**，重启一次 Codex，然后选择一个 **ChatGPT Web — …** 模型。

启动器会在设置期间检测当前账户的 ChatGPT 控件：Free/Go 账户只会显示 Luna；只有已登录账户
支持 Pro 时，Pro 才会显示。独立的 **MCP** 页面是可选项，它会在不需要终端命令的情况下引导你
完成完整 harness 设置。

打包后的启动器会在兼容 passkey 的登录交接过程中使用系统默认浏览器。当前登录适配器要求默认
浏览器兼容 Chromium；不支持的浏览器引擎会明确失败。ChatGPT 模型轮次仍在启动器的内置浏览器中
运行，不需要模型 API 密钥、系统级 Node/Bun，也不会由本项目另行下载浏览器。

**从源码运行**

```bash
git clone https://github.com/miuuyy/codex-chatgpt-web.git && \
cd codex-chatgpt-web && \
bun run app
```

源码方式需要 Bun 1.3.14。该命令会安装锁定版本的依赖并打开应用。

## 模式

| 模式 | 模型 | 本地 Codex 工具 | 额外设置 |
| --- | --- | --- | --- |
| **仅浏览器** | Free/Go：Luna；Plus：Instant–High；Pro：增加 Extra High 和 Pro | 不可用；Codex 会显示警告 | 无 |
| **完整 harness** | Free/Go：Luna；Plus：Instant–High；Pro：增加 Extra High 和 Pro | 非 Pro 模型：连接器可用时支持；Pro：只读 | OpenAI 隧道 + ChatGPT 连接器 |

模型选择器中的每一项都对应一个固定的 ChatGPT 模式。Codex 仍会显示内置的 Effort 和 Speed
选项，但更改它们不会在后台静默切换所选的浏览器模型。Pro 会收到 Codex 当前编译后的上下文，
但 ChatGPT Pro 无法主动发起本地 MCP/工具调用。

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

在 **活动** 页面查看结构化本地日志，在 **设置 → 运行诊断** 中执行端到端健康检查。如果已停止的
任务仍让 ChatGPT 继续工作，请使用 **设置 → 取消残留的浏览器任务**。删除启动器前，请使用
**设置 → 移除 Codex 集成**，以恢复此前的 Codex 路由。

## 限制和安全性

- 这是非官方浏览器自动化，并非 OpenAI API。ChatGPT UI 变更可能破坏选择器；发生变化时会明确
  失败，而不是静默切换模型或传输方式。
- ChatGPT 针对不同账户设置的输入框上限小于某些底层模型的上下文窗口。实测边界以及实现更大且
  确定性传输的要求记录在
  [#76](https://github.com/miuuyy/codex-chatgpt-web/issues/76) 中。
- 浏览器状态是敏感的登录凭据，loopback 监听器也可被同一本地用户运行的进程访问。切勿共享
  启动器 profile，并仅在可信工作站上使用。
- 发布包目前支持 macOS 13+（arm64/x64）、Windows x64 和 Linux x64。浏览器流程已在 macOS
  和 Windows 11 上完成手动端到端测试；核心运行时、测试和原生打包会在 CI 中对三种操作系统
  进行检查。
- 在为发布配置平台签名证书之前，macOS Gatekeeper 或 Windows SmartScreen 可能会显示未知发布者
  警告。一键安装脚本会在安装前验证发布的 SHA-256 清单。

启用完整模式前，请阅读完整的[架构说明](docs/architecture.md)和
[安全模型](docs/security-model.md)。安全漏洞请通过 [SECURITY.md](SECURITY.md) 报告。

## 开发

```bash
bun run app
bun run verify
bun run app:package
```

- [架构说明](docs/architecture.md)
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
