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
  <img src="https://img.shields.io/badge/macOS-arm64%20%7C%20Intel-black?logo=apple" alt="macOS arm64 and Intel">
  <img src="https://img.shields.io/badge/Free_AI-no_API_fees-10a37f" alt="Free AI with no API fees">
  <img src="https://img.shields.io/badge/Windows-coming_soon-0078d4?logo=windows11" alt="Windows support coming soon">
</p>

在 Codex 原生模型选择器中选择 **ChatGPT Web — Instant**、**Medium**、**High**、
**Extra High**、**Ultra** 或 **Pro**。桥接程序会把完整的 Codex 任务上下文发送到一个全新的
ChatGPT 临时聊天，附加图片，并将可见的推理过程、工具活动和 Markdown 流式传回同一个
Codex 任务。

<p align="center">
  <img src="assets/demo.gif" alt="ChatGPT Web 在原生 Codex harness 中运行" width="960">
</p>

```text
Codex task ──Responses + SSE──▶ codex-chatgpt-web ──loopback DevTools──▶ ordinary Chrome ──▶ ChatGPT
     ▲                                │                                      │
     └──────── native UI, context, images, tracing, and tool lifecycle ──────┘
```

## 亮点

- **原生 Codex harness。** 使用的仍然是你熟悉的 Codex 模型选择器、任务历史、上下文生命周期、
  审批、沙箱、流式输出、追踪和工具界面，而不是另一个聊天客户端。与 OpenCodex 类似，
  它只更换模型后端，同时保留原生工作流。
- **本地优先的任务会话。** Codex 仍然是电脑上任务历史的真实来源。每个浏览器轮次都会从一个
  全新的 ChatGPT 临时聊天开始，并接收完整的累计 Codex 上下文，因此浏览器聊天不会在任务之间
  复用，也不会加入普通 ChatGPT 历史记录。
- **通过 MCP 使用完整 Codex harness。** 在完整模式下，Instant 到 Ultra 可以通过 MCP
  使用当前 Codex 任务的文件系统、shell、图片、审批以及已配置的工具和应用。调用及其真实结果
  会留在同一个浏览器响应中，不会被模拟成文本。
- **真正的并行 Ultra 编排。** 手动选择的 Ultra 路由以 Extra High 作为协调器，并可请求外层
  Codex harness 派生最多三个原生协作代理。桥接程序会将这些代理固定到已配置的原生 Codex 模型，
  防止它们递归继承 Ultra，同时保持用户默认的服务层级。除此之外，桥接程序还可让最多四个 Ultra
  浏览器轮次并行运行，每个轮次使用独立的临时聊天页面；普通路由仍然独占浏览器。
- **Pro 仍然实用。** Pro 是唯一的例外：ChatGPT 当前的 Pro 模式不会暴露此桥接程序所需的自定义
  MCP 连接器。它的原生能力（包括网页搜索和研究）仍然可用。你可以先用 Instant 到 Extra High
  收集本地工作区上下文，再切换到 Pro；Pro 会收到完整的累计 Codex 任务，用于更深入的分析。
- **故障时明确失败，并经过人工测试。** 模型选择、超长内联上下文、图片、流式输出、可见追踪、
  上下文压缩、原生工具轮次、取消操作和 Pro 均已在 macOS 上完成端到端测试。UI 变化或能力缺失
  会产生明确错误，而不是静默回退。

临时聊天是 ChatGPT 的隐私模式，并不代表匿名或仅在本地推理：提示仍会由 OpenAI 处理，并受账户
设置及 OpenAI [临时聊天政策](https://help.openai.com/en/articles/8914046-temporary-chat-faq)
约束。本项目为非官方项目；用户仍需自行遵守适用的 OpenAI 条款和工作区政策。

## 快速开始

仅浏览器模式需要 macOS、Google Chrome 和 ChatGPT 账户。它不需要 API 密钥、隧道、系统级
Node/Bun、OpenCodex、Playwright 或额外下载自动化浏览器。

```bash
curl -fsSL https://github.com/miuuyy/codex-chatgpt-web/releases/latest/download/install.sh \
  | sh -s -- --browser-only --acknowledge-unofficial
```

在安装程序打开的唯一一个 Chrome 窗口中登录，重启一次 Codex，然后选择一个
**ChatGPT Web — …** 模型。只有通过身份验证的账户支持 Pro 时，Pro 才会显示。
完成后，程序会在 macOS 登录后自动启动，无需再次执行终端命令。

## 模式

| 模式 | 模型 | 本地 Codex 工具 | 额外设置 |
| --- | --- | --- | --- |
| **仅浏览器** | Instant–Extra High、Pro | 不可用；Codex 会显示警告 | 无 |
| **完整 harness** | Instant–Ultra、Pro | Instant–Ultra：可用；Pro：只读 | OpenAI 隧道 + ChatGPT 连接器 |

模型选择器中的每一项都对应一个固定的 ChatGPT 模式。Codex 仍会显示内置的 Effort 和 Speed
选项，但更改它们不会在后台静默切换所选的浏览器模型。Pro 会收到 Codex 已经收集的完整上下文，
但 ChatGPT Pro 无法主动发起本地 MCP/工具调用。

> [!WARNING]
> **Ultra 是实验性功能，必须由用户明确选择。** 它可能派生三个原生 Codex 代理，并允许同一账户下
> 最多四个 ChatGPT Web 轮次同时运行。账户限制、限流、工作区政策以及 OpenAI 条款的合规责任
> 由用户承担。Ultra 不会轮换账户、更改服务层级，也不会通过重试规避限制。

代理保留 Codex 内置的 `openai` provider 和实时模型目录。它会原样转发官方目录，只附加自己的
ChatGPT Web 条目，因此原生模型、任务历史、审批、沙箱和工具结果仍由 Codex 管理。

## 完整 harness

完整模式通过官方
[OpenAI tunnel-client](https://github.com/openai/tunnel-client)
将 ChatGPT 的工具调用连接回当前 Codex 任务。该隧道为出站连接：不会暴露公网 IP、开放入站端口，
也不需要配置路由器端口转发。

1. 在 [Platform 隧道设置](https://platform.openai.com/settings/organization/tunnels)中创建隧道。
2. 在 [Platform API 密钥设置](https://platform.openai.com/settings/organization/api-keys)中创建一个仅具有
   **Tunnels Read + Use** 权限的运行时密钥。
3. 安装并导入密钥：

   ```bash
   curl -fsSL https://github.com/miuuyy/codex-chatgpt-web/releases/latest/download/install.sh | sh
   ~/.local/bin/codex-chatgpt-web tunnel key-import
   ```

4. 使用你的隧道 ID 运行设置：

   ```bash
   ~/.local/bin/codex-chatgpt-web setup --full \
     --tunnel-id tunnel_0123456789abcdef0123456789abcdef \
     --acknowledge-unofficial
   ```

5. 当 `doctor` 报告 ready 时，在
   [ChatGPT 连接器设置](https://chatgpt.com/#settings/Connectors)中将该隧道连接到一个名为
   `Codex Native` 的 ChatGPT 连接器，扫描其工具，配置需要的操作权限，然后重启一次 Codex。

写入/修改操作需要 ChatGPT 工作区及管理员政策允许。OpenAI 目前仅为 Business 和
Enterprise/Edu 工作区说明了这些操作；个人 Pro 账户仅限 read/fetch MCP 权限。请参阅
[开发者模式和 MCP 应用](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt)。
除非显式启用 `--auto-approve-tool-calls`，否则意外的审批提示会直接失败；该选项只会点击
**Allow once**，绝不会授予永久权限。

## 日常操作

```bash
codex-chatgpt-web doctor
codex-chatgpt-web service status
codex-chatgpt-web tunnel status        # 完整模式
codex-chatgpt-web browser check
codex-chatgpt-web login                # 刷新已过期的 ChatGPT 会话
codex-chatgpt-web uninstall --yes
```

设置程序会将私有状态保存在 `~/.codex-chatgpt-web` 下，安装带版本的 launchd 服务，并记录此前的
Codex 路由，以便卸载时恢复。除非显式提供 `--replace-codex-route`，否则它不会替换不同的路由；
任务仍在活动时，它也会拒绝停止或更新。

如果你在原生工具轮次之间停止 Codex 任务，Codex 将不再有可用于发送取消信号的 Responses 请求。
此时可以在不停止 daemon 的情况下中止仍保留的浏览器轮次，然后重试更新：

```bash
codex-chatgpt-web service cancel-turns
```

## 限制和安全性

- 这是非官方浏览器控制，并非 OpenAI API。ChatGPT UI 变更可能破坏选择器；发生变化时会明确
  失败，而不是静默切换模型或传输方式。
- 专用普通 Chrome profile 是敏感的登录凭据。Cookie 只保存在
  `~/.codex-chatgpt-web/chrome-profile` 内，不会被导出；切勿共享或提交该目录。
- 专用 profile 打开时，Chrome DevTools 会监听固定的 loopback 端口。同一本地用户下运行的任何
  进程都可以控制该 profile，因此不要用它进行无关浏览。
- Responses 监听器只绑定到 loopback，但以同一本地用户身份运行的其他进程仍可访问它。
  请仅在可信的单用户工作站上使用。
- 普通浏览器轮次会串行执行。最多四个独立路由的 Ultra 轮次可在隔离页面中并行运行；
  ChatGPT 账户限制仍可能对并发工作进行限流。
- 托管后台安装目前仅支持 macOS。
- Codex Desktop 会将 Pro 的 wire effort 固定显示为 **Ultra**，并始终显示 **Standard** speed。
  这些控件不会改变固定的 ChatGPT Web 模型；重命名它们需要修改已签名的 Codex 应用。

启用完整模式前，请阅读完整的[架构说明](docs/architecture.md)和
[安全模型](docs/security-model.md)。安全漏洞请通过 [SECURITY.md](SECURITY.md) 报告。

## 开发

```bash
bun install --frozen-lockfile
bun run verify
```

`verify` 会运行依赖审计、严格 TypeScript 检查、harness/MCP/配置测试以及可重定位运行时冒烟测试。
浏览器传输使用一个带固定 loopback DevTools 端口的可见专用普通 Chrome profile，且不会启用
WebDriver 模式。

- [架构说明](docs/architecture.md)
- [安全模型](docs/security-model.md)
- [贡献指南](CONTRIBUTING.md)

## 致谢与免责声明

Responses 转换、Codex 目录集成和浏览器 harness 的部分代码依据 MIT 许可证改编自
[OpenCodex](https://github.com/lidge-jun/opencodex)。详情请参阅
[第三方声明](LICENSES/NOTICE.md)。

本项目是实验性的独立软件，与 OpenAI 无关联，也未获得 OpenAI 背书。不得使用本项目规避使用限制
或访问控制。在公开分发前，请查阅 OpenAI 当前的
[使用条款](https://openai.com/policies/terms-of-use/)和
[服务协议](https://openai.com/policies/services-agreement/)。
