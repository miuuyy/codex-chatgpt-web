<h1 align="center">ChatGPT Web for Codex</h1>

<p align="center">
  <strong>ChatGPT Web(Pro 포함)을 Codex의 네이티브 모델처럼 사용하세요.</strong><br>
  모델 등급만 바꾸고, 기존 작업 흐름은 그대로 유지하세요.
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a>
</p>
<p align="center">
  <a href="TROUBLESHOOTING.md">문제 해결</a> · <a href="SECURITY.md">보안</a> · <a href="CONTRIBUTING.md">기여</a>
</p>
<p align="center">
  <a href="https://github.com/miuuyy/codex-chatgpt-web/actions/workflows/ci.yml"><img src="https://github.com/miuuyy/codex-chatgpt-web/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/macOS-arm64%20%7C%20x64-black?logo=apple" alt="macOS arm64 and x64">
  <img src="https://img.shields.io/badge/Windows-x64-0078d4?logo=windows11" alt="Windows x64">
  <img src="https://img.shields.io/badge/Linux-x64-fcc624?logo=linux&logoColor=black" alt="Linux x64">
  <img src="https://img.shields.io/badge/Free_AI-no_API_fees-10a37f" alt="Free AI with no API fees">
</p>

Free 및 Go 계정에서는 Codex의 네이티브 모델 선택기에 **ChatGPT Web — Luna**가 표시됩니다.
추론 선택기를 제공하는 계정에서는 구독 범위에 따라 **Instant**, **Medium**, **High**,
**Extra High**, **Pro**를 그대로 사용할 수 있습니다. 이 브리지는 현재 컴파일된 Codex 작업
컨텍스트를 ChatGPT Temporary Chat으로 보내고, 이미지를 첨부하며, 화면에 표시되는 추론 과정,
도구 활동 및 Markdown을 동일한 Codex 작업으로 스트리밍합니다.

<p align="center">
  <img src="assets/demo.gif" alt="네이티브 Codex 하네스를 사용하는 ChatGPT Web 실시간 턴" width="960">
</p>

```text
Codex task ──Responses + SSE──▶ codex-chatgpt-web ──embedded browser──▶ ChatGPT
     ▲                                │                                      │
     └──────── native UI, context, images, tracing, and tool lifecycle ──────┘
```

Codex는 네이티브 작업, 컨텍스트 수명 주기, UI 및 도구 하네스를 그대로 유지합니다. 로컬
Responses 브리지는 선택된 모델 작업만 해당 작업에 연결된 ChatGPT Temporary Chat으로
라우팅합니다. Full 모드에서는 다음 compaction 경계까지 MCP가 ChatGPT를 같은 Codex 작업의
도구에 다시 연결합니다.

> [!TIP]
> 저는 [ChatGPT Persona Voice](https://github.com/miuuyy/ChatGPT-Persona-Voice)도 만들었습니다.
> ChatGPT/Codex의 음성을 거의 실시간으로 로컬에서 바꾸는 앱입니다. 계정, 브라우저 세션 또는
> ChatGPT 요청을 건드리지 않으므로 계정 차단 위험 없이 사용할 수 있습니다. 제 작업이 마음에
> 든다면 한 번 사용해 보세요.

## 주요 기능

- **Codex 네이티브 모델.** ChatGPT Web이 Codex의 모델 선택기에서 직접 실행되며, 기존 작업 UI,
  컨텍스트 수명 주기, 스트리밍, 추적 및 도구 표시 방식은 그대로 유지됩니다.
- **MCP를 통한 전체 Codex 하네스.** Full 모드에서는 로그인한 계정에 표시되는 모든 effort
  (Pro 포함)가 현재 작업의 파일 시스템, shell, 이미지, 승인 및 구성된 도구/앱을 사용할 수 있습니다.
- **연속 작업 세션과 네이티브 compaction.** 연속 메시지는 하나의 작업 연결형 Temporary Chat을
  재사용합니다. 컨텍스트 경계에 도달하면 유지 중인 agent가 checkpoint를 기록한 뒤 Codex가
  깨끗한 채팅에서 계속합니다. 해당 비공개 채팅이 닫혔다면 표준 Codex 기록을 fallback으로 사용합니다.
- **하나의 크로스 플랫폼 런처.** macOS, Windows 및 Linux 앱에서 로그인, 모델 설정, MCP 가이드,
  상태 확인, 안전한 진단 및 최대 5개의 작업 연결형 브라우저 탭을 한 곳에서 관리합니다.
- **Fail-closed 동작.** 모델이나 도구가 없거나 ChatGPT UI가 변경된 경우 다른 경로나 기능으로
  조용히 전환하지 않고 명시적으로 오류를 반환합니다. End-to-end 검증 범위는
  [release validation](docs/release-validation.md)에 기록되어 있습니다.

Temporary Chat은 ChatGPT의 개인정보 보호 모드이지 익명 사용이나 로컬 전용 추론을 의미하지
않습니다. 프롬프트는 여전히 OpenAI에서 처리되며 계정 설정과 OpenAI의
[Temporary Chat 정책](https://help.openai.com/en/articles/8914046-temporary-chat-faq)의 적용을
받습니다. 이 프로젝트는 비공식 프로젝트이며, 사용자는 적용되는 OpenAI 약관과 작업 공간 정책을
준수할 책임이 있습니다.

## 빠른 시작

데스크톱 런처를 설치하거나 업데이트합니다. 기존 설치를 업데이트하거나 복구하려면 런처를 종료한
뒤 같은 명령을 다시 실행하세요. ChatGPT 프로필과 런처 설정은 유지하면서 애플리케이션과 내장
런타임을 교체합니다.

**macOS 또는 Linux**

```bash
curl -fsSL https://github.com/miuuyy/codex-chatgpt-web/releases/latest/download/install-launcher.sh | sh
```

**Windows PowerShell**

```powershell
irm https://github.com/miuuyy/codex-chatgpt-web/releases/latest/download/install-launcher.ps1 | iex
```

그다음 앱에서 세 가지 확인을 완료합니다.

1. 런처의 내장 ChatGPT 브라우저에서 직접 로그인합니다. 로그인 페이지와 ID 공급자 창은 동일한
   런처 소유 비공개 브라우저 프로필 안에서 유지되며, 브라우저 간에 세션을 복사하지 않습니다.
2. 브라우저 smoke test를 실행합니다.
3. **모델 설치**를 누르고 Codex를 한 번 다시 시작한 뒤 **ChatGPT Web — …** 모델을 선택합니다.

런처는 설정 과정에서 현재 계정의 ChatGPT 제어 항목을 감지합니다. Free/Go 계정에는 Luna만
표시되며, 로그인한 계정에 Pro가 제공될 때만 Pro가 나타납니다. 별도의 **MCP** 페이지는 선택
사항이며 터미널 명령 없이 Full harness 설정을 안내합니다.

패키지된 런처는 로그인과 ChatGPT 모델 턴을 내장 브라우저에서 처리합니다. 모델 API 키,
설치된 Chrome/Chromium, 시스템 Node/Bun 또는 프로젝트가 별도로 다운로드하는 브라우저가
필요하지 않습니다.

**소스에서 실행**

```bash
git clone https://github.com/miuuyy/codex-chatgpt-web.git && \
cd codex-chatgpt-web && \
bun run app
```

소스 실행에는 Bun 1.4.0이 필요합니다. 이 명령은 잠긴 의존성을 설치하고 앱을 엽니다.

## 모드

| 모드 | 모델 | 로컬 Codex 도구 | 추가 설정 |
| --- | --- | --- | --- |
| **Browser-only** | Free/Go: Luna; Plus: Instant–High; Pro: Extra High 및 Pro 추가 | 사용 불가, Codex에서 경고 표시 | 없음 |
| **Full harness (With Automation)** | Free/Go: Luna; Plus: Instant–High; Pro: Extra High 및 Pro 추가 | 표시된 모든 effort에서 사용 가능(Pro 포함) | OpenAI tunnel + ChatGPT 커넥터 |
| **Zero Risk** | ChatGPT 모델과 effort를 직접 선택, 선택적으로 Pro 크기의 컨텍스트 사용 | 사용 가능, 전체 turn-bound Codex harness 유지 | 별도의 OpenAI tunnel + `Codex Zero Risk` 커넥터, 직접 붙여넣고 전송 |

자동 모드의 각 모델 선택 항목은 하나의 고정된 ChatGPT 모드에 대응합니다. Codex에는 기본
Effort와 Speed 항목이 계속 표시되지만 이를 변경해도 선택된 브라우저 모델이 조용히 바뀌지
않습니다. 자동 Full 모드에서는 사용 가능한 모든 effort가 동일한 turn-bound MCP 기능을
사용합니다. Pro에도 별도의 제한이나 축소된 도구 계약이 없습니다.

Zero Risk는 로컬 Responses 브리지와 전체 Codex 하네스를 유지하지만 ChatGPT 페이지를 읽거나
변경하지 않으며, 프롬프트를 자동으로 전송하지도 않습니다. 런처가 프롬프트를 준비해 클립보드에
복사하면 사용자가 모델, effort, `Codex Zero Risk` 커넥터를 선택한 뒤 직접 붙여넣고 전송합니다.
이를 통해 ChatGPT Web 자동화 자체에서 발생할 수 있는 계정 위험을 제거할 수 있습니다.

## Full harness

Full 모드는 공식 [OpenAI tunnel-client](https://github.com/openai/tunnel-client)를 통해 ChatGPT의
도구 호출을 현재 Codex 작업으로 다시 연결합니다. 터널은 outbound 방식이므로 공인 IP를 노출하거나
inbound 포트를 열거나 라우터 포트 포워딩을 설정할 필요가 없습니다.

런처의 MCP 페이지가 전체 설정 과정을 안내합니다. 정확한 클릭 순서는 런처 안의 영상 가이드를
참고하세요.

> [!NOTE]
> **Limits**
>
> GPT-5.6 Sol Pro 및 GPT-6 Astra의 현재 ChatGPT 메시지 허용량은
> [Limits](https://github.com/miuuyy/codex-chatgpt-web/discussions/309)를 참고하세요.
> 컨텍스트 한도는 계정 유형과 선택한 effort에 따라 달라집니다. Plus의 Medium/High는 실측
> 90,000-token 창을 사용하며, 실험적 3× context를 활성화하면 최대 270,000 tokens까지 확장됩니다.
> 모든 경우에 네이티브 Codex compaction이 지원됩니다.

1. 필수 설정을 완료하고 **MCP**를 연 다음 Tunnel과 일반 API 키를 생성하고
   **하네스 연결**을 누릅니다.
2. ChatGPT **Developer Mode**를 활성화하고, **Tunnel** 방식의 새 커넥터를 만들고 이름을 정확히
   **Codex Native2**로 지정합니다. **Authentication: None**과 **Allow all actions**를 사용합니다.
3. **런타임 검증**을 실행해 **Codex Native2**가 연결되어 사용 가능한지 확인합니다.

쓰기/수정 작업은 ChatGPT 작업 공간과 관리자 정책에서도 허용되어야 합니다.
[Developer Mode와 MCP 앱](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt)을
참고하세요. `--auto-approve-tool-calls`를 명시적으로 활성화하지 않은 상태에서 예상치 못한 승인
프롬프트가 나타나면 fail-closed로 처리됩니다. 이 옵션은 **Allow once**만 클릭하며 영구 권한은
부여하지 않습니다.

## 운영

**활동**에서 안전한 로컬 진단을 확인하고 **설정 → 진단 실행**에서 end-to-end 상태 확인을
수행할 수 있습니다. 설정에서는 유지 중인 브라우저 턴을 취소하거나 제거 전에 Codex 통합을
삭제할 수도 있습니다. 모든 브라우저 checkpoint에서 스크린샷이 필요한 경우에만
`CODEX_CHATGPT_WEB_BROWSER_DIAGNOSTICS=1`을 설정하세요.

새 설치에서는 cross-backend subagent에 **Compatibility V1**을 사용합니다. **Native**는 Codex
자체 기능 설정을 유지하면서 plaintext Web-to-Web V2 delegation을 활성화합니다. 프로토콜을
변경한 뒤에는 Codex를 다시 시작하고 새 작업을 시작하세요.

```bash
codex-chatgpt-web subagents status
codex-chatgpt-web subagents compatibility-v1
codex-chatgpt-web subagents native
```

## 제한 사항 및 보안

- 이 프로젝트는 비공식 브라우저 자동화이며 OpenAI API가 아닙니다. ChatGPT UI 변경으로 selector가
  깨질 수 있으며, 이 경우 모델이나 전송 방식을 조용히 바꾸지 않고 명시적으로 실패합니다.
- 브라우저 상태는 민감한 로그인 정보이며 loopback listener는 동일한 로컬 사용자로 실행되는
  프로세스에서 접근할 수 있습니다. 런처 프로필을 공유하지 말고 신뢰할 수 있는 워크스테이션에서
  사용하세요.
- 현재 릴리스 패키지는 macOS 13+(arm64/x64), Windows x64 및 Linux x64를 대상으로 합니다.
  런타임, 테스트 및 패키징은 CI에서 세 운영체제 모두에 대해 검증되며, 계정 종속 브라우저 및
  MCP 흐름은 별도의 release validation을 사용합니다.
- 아직 플랫폼 서명이 적용되지 않은 빌드에서는 Gatekeeper 또는 SmartScreen 경고가 표시될 수
  있습니다. 설치 프로그램은 설치 전에 공개된 SHA-256 manifest를 확인합니다.

Full 모드를 활성화하기 전에 전체 [아키텍처](docs/architecture.md)와
[보안 모델](docs/security-model.md)을 읽어보세요. 취약점은 [SECURITY.md](SECURITY.md)를 통해
보고해 주세요.

## 개발

```bash
bun run app
bun run dev:launcher
bun run src/cli.ts dev status
bun run dev:chat compaction-lab "Reply with exactly: DEV READY"
bun run verify
bun run smoke:subagents
bun run app:package
```

`dev:launcher`는 `~/.codex-chatgpt-web-dev` 아래에서 두 번째 런처 프로필을 시작합니다. Electron
상태, 브라우저 쿠키/로그인, ChatGPT 계정, 설정, sandbox된 `CODEX_HOME`, 채팅, 진단, broker 및
tunnel 프로필이 일반 런처와 완전히 분리됩니다. 일반 런처와 동시에 실행할 수 있으며 Responses
daemon을 시작하거나 Codex를 변경하지 않습니다. 선택적 Full 설정에서는 격리된 MCP tunnel만
시작하고 관리하며 별도 ChatGPT 커넥터 이름인 `Codex Native2 DEV`를 사용합니다.

`dev:chat`은 이름을 가진 영구 synthetic outer-Codex harness입니다. 격리된 런처 브라우저,
Temporary Chat, prompt compiler, Responses parser 및 compaction handler를 통해 현재 working
tree를 실행합니다. 선택적 Full 설정에서는 MCP 커넥터와 broker도 테스트하며, 도구 효과는
명시적인 simulation receipt로 반환됩니다. Browser-only 채팅은 outer tool을 노출하지 않습니다.
Responses listener를 열거나 `openai_base_url`을 변경하거나 실제 daemon을 중지하거나 17841
포트를 점유하지 않습니다. 메시지 없이 실행하면 `/status`, `/fill 30000`, `/compact`, `/model`,
`/reset` 명령을 사용할 수 있습니다. `DEV`라고 표시된 창에서 한 번 로그인하고 프로필을
초기화하세요. Full harness는 simulated tool round를 테스트할 때만 구성하면 됩니다. DEV 런처는
DEV tunnel을 준비 상태로 유지하고 이름이 지정된 채팅은 필요할 때 broker를 연결합니다.
프로덕션 자격 증명과 `Codex Native2` 커넥터는 암묵적으로 재사용되지 않습니다.
자세한 내용은 [DEV chat harness](docs/dev-chat.md)를 참고하세요.

- [아키텍처](docs/architecture.md)
- [DEV chat harness](docs/dev-chat.md)
- [보안 모델](docs/security-model.md)
- [문제 해결](TROUBLESHOOTING.md)
- [기여 가이드](CONTRIBUTING.md)

## Star History

<a href="https://www.star-history.com/?repos=miuuyy%2Fcodex-chatgpt-web&type=date&legend=top-left">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=miuuyy/codex-chatgpt-web&type=date&theme=dark&legend=top-left&sealed_token=hBVvg_eOjfMFDrfyeo5FPQkIwcvBEmXc6F7ZoOKnfFE4KPCs67o34w4XwVuM-bHGnKR-SKCAN_TSTWrzuqSBNU-RjNZCLT4f-xNs9qcDhciQtemxHKuuFj0N5YNqZIihdaQfakrh2ANhOrvP0K2LmLXX2zbsYyVaYZknyTnlYeIS_mOGvMcO32ZmPCHK">
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=miuuyy/codex-chatgpt-web&type=date&legend=top-left&sealed_token=hBVvg_eOjfMFDrfyeo5FPQkIwcvBEmXc6F7ZoOKnfFE4KPCs67o34w4XwVuM-bHGnKR-SKCAN_TSTWrzuqSBNU-RjNZCLT4f-xNs9qcDhciQtemxHKuuFj0N5YNqZIihdaQfakrh2ANhOrvP0K2LmLXX2zbsYyVaYZknyTnlYeIS_mOGvMcO32ZmPCHK">
    <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=miuuyy/codex-chatgpt-web&type=date&legend=top-left&sealed_token=hBVvg_eOjfMFDrfyeo5FPQkIwcvBEmXc6F7ZoOKnfFE4KPCs67o34w4XwVuM-bHGnKR-SKCAN_TSTWrzuqSBNU-RjNZCLT4f-xNs9qcDhciQtemxHKuuFj0N5YNqZIihdaQfakrh2ANhOrvP0K2LmLXX2zbsYyVaYZknyTnlYeIS_mOGvMcO32ZmPCHK">
  </picture>
</a>

## 면책 조항

이 프로젝트는 OpenAI와 제휴하거나 OpenAI의 보증을 받은 소프트웨어가 아닌 독립적인 소프트웨어입니다.
본인 소유의 계정으로만 사용하고 적용되는
[이용 약관](https://openai.com/policies/terms-of-use/)과 작업 공간 정책을 준수하세요.
이 프로젝트는 인증이나 접근 제어를 우회하지 않습니다.

문제가 있나요? 일반적인 문제와 해결 방법은 [문제 해결](TROUBLESHOOTING.md)을 참고하세요.
