<h1 align="center">ChatGPT Web for Codex</h1>

<p align="center">
  <strong>ChatGPT Web（Proを含む）をCodexのネイティブモデルとして使う。</strong><br>
  モデルのグレードを切り替えても、ワークフローはそのまま。
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.ja.md">日本語</a>
</p>

<p align="center">
  <a href="https://github.com/miuuyy/codex-chatgpt-web/actions/workflows/ci.yml"><img src="https://github.com/miuuyy/codex-chatgpt-web/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/macOS-arm64%20%7C%20x64-black?logo=apple" alt="macOS arm64 and x64">
  <img src="https://img.shields.io/badge/Windows-x64-0078d4?logo=windows11" alt="Windows x64">
  <img src="https://img.shields.io/badge/Linux-x64-fcc624?logo=linux&logoColor=black" alt="Linux x64">
  <img src="https://img.shields.io/badge/Free_AI-no_API_fees-10a37f" alt="Free AI with no API fees">
</p>

FreeおよびGoアカウントでは、Codexのネイティブモデル選択画面に**ChatGPT Web — Luna**が追加されます。
推論レベルの選択機能が表示されるアカウントでは、契約内容に応じて**Instant**、**Medium**、**High**、
**Extra High**、**Pro**も利用できます。ブリッジは、コンパイル済みの現在のCodexタスクコンテキストを
新しいChatGPT Temporary Chatへ送り、画像を添付し、表示される推論、ツールの動作、Markdownを
同じCodexタスクへストリーミングで返します。

<p align="center">
  <img src="assets/demo.gif" alt="ネイティブCodexハーネスを使用したChatGPT Webターン" width="960">
</p>

```text
Codexタスク ──Responses + SSE──▶ codex-chatgpt-web ──埋め込みブラウザ──▶ ChatGPT
     ▲                                │                                      │
     └──── ネイティブUI、コンテキスト、画像、トレース、ツールライフサイクル ────┘
```

Codexは、ネイティブのタスク、コンテキストのライフサイクル、UI、ツールハーネスをそのまま管理します。
ローカルのResponsesブリッジは、選択したモデルのターンだけを新しいChatGPT Temporary Chatへ送ります。
Fullモードでは、MCPによってChatGPTを同じCodexタスクのツールへ再接続します。

> [!TIP]
> **[ChatGPT Persona Voice](https://github.com/miuuyy/ChatGPT-Persona-Voice)**も公開しています。
> ChatGPT/Codexの音声をほぼリアルタイムで変更するローカルアプリです。アカウント、ブラウザセッション、
> ChatGPTリクエストには一切触れないため、利用によってアカウントがブロックされるリスクはありません。
> 気に入っていただけたら、ぜひお試しください。

## 主な特長

- **洗練されたクロスプラットフォームランチャー。** 1つのコマンドでmacOS、Windows、Linux向けの
  ネイティブアプリをインストールできます。ログイン、セットアップ、スモークテスト、MCPガイド、
  ランタイムの状態、ローカルログを一か所で管理し、埋め込みブラウザでChatGPTの各ターンをリアルタイムに
  確認できます。タスクにひも付いたブラウザタブは最大5つまで並列実行でき、アカウントへの過剰な並列アクセスを
  防ぐために上限が設けられています。
- **選択したモデルそのものがChatGPT。** 別のホストモデルから呼び出すツールではなく、Codexの
  ネイティブモデルとして動作します。元のモデル選択画面、タスクのライフサイクル、ストリーミング、
  トレース、ツールUIはそのまま維持されます。
- **ローカル優先のタスクセッション。** コンピューター上のタスク履歴は、引き続きCodexが信頼できる
  情報源です。ブラウザの各ターンは新しいChatGPT Temporary Chatで始まり、コンパイル済みの現在の
  コンテキストを受け取ります。測定済みのブラウザ上限に達するとコンパクションが実行され、Lunaでは
  適応型のローリングチェックポイントを通じて完了済み状態が引き継がれます。ブラウザチャットが別の
  タスクで再利用されたり、通常のChatGPT履歴に追加されたりすることはありません。
- **MCP経由でCodexハーネスをすべて利用。** Fullモードでは、ログイン中のアカウントで利用可能な
  Luna、Instant、Medium、High、Extra High、Proのすべてが、現在のCodexタスクのファイルシステム、
  シェル、画像、承認、設定済みのツール／アプリを、同じターンにひも付いたMCP機能を通じて使用できます。
  呼び出しと実際の結果は同じブラウザ応答内に保たれ、テキストとして模擬されることはありません。
- **Proも同じ契約。** Proには、他のeffortとまったく同じMCP、コンテキスト、画像、トレース、
  ツールラウンド、ブラウザ上限、コンパクションの契約が適用されます。effort固有のMCP除外はありません。
  Browser-onlyモードでは、すべてのルートが引き続き読み取り専用です。
- **明示的に失敗する設計とリリースゲート。** UIの変更や機能不足は、暗黙のフォールバックではなく
  明示的なエラーになります。アカウントに応じたモデル選択、長いコンテキスト、画像、ストリーミング、
  コンパクション、ネイティブツールラウンド、キャンセル、Proは、パッケージのスモークテストとは別に、
  文書化された[リリース検証](docs/release-validation.md)で確認されます。

Temporary ChatはChatGPTのプライバシーモードであり、匿名化やローカルだけでの推論ではありません。
プロンプトは引き続きOpenAIによって処理され、アカウント設定およびOpenAIの
[Temporary Chatポリシー](https://help.openai.com/en/articles/8914046-temporary-chat-faq)が適用されます。
このプロジェクトは非公式です。利用者は、適用されるOpenAIの規約とワークスペースポリシーを順守する責任があります。

## クイックスタート

デスクトップランチャーをインストールまたは更新します。既存のインストールを更新・修復する場合は、
ランチャーを終了して同じコマンドをもう一度実行してください。ChatGPTプロファイルとランチャー設定を保持したまま、
アプリケーションと埋め込みランタイムが置き換えられます。

**macOSまたはLinux**

```bash
curl -fsSL https://github.com/miuuyy/codex-chatgpt-web/releases/latest/download/install-launcher.sh | sh
```

**Windows PowerShell**

```powershell
irm https://github.com/miuuyy/codex-chatgpt-web/releases/latest/download/install-launcher.ps1 | iex
```

続いて、アプリ内の3項目を確認します。

1. ランチャーに埋め込まれたChatGPTブラウザから直接ログインします。ログインページとIDプロバイダーの
   ウィンドウは、ランチャーが所有する同じプライベートブラウザプロファイル内に保たれます。ブラウザ間で
   セッションがコピーされることはありません。
2. ブラウザのスモークテストを実行します。
3. **モデルをインストール**を押し、Codexを一度再起動して、**ChatGPT Web — …**モデルを選択します。

セットアップ時に、ランチャーが現在のアカウントで利用できるChatGPTの操作項目を検出します。
Free/GoアカウントではLunaのみが表示され、Proはログイン中のアカウントで利用可能な場合にだけ表示されます。
独立した**MCP**ページは任意で、ターミナルコマンドを使わずにFullハーネスを設定できるよう案内します。

パッケージ版ランチャーでは、ログインとChatGPTモデルのターンが埋め込みブラウザ内で完結します。
モデル用API key、インストール済みのChrome/Chromium、システムのNode/Bun、プロジェクト管理の
ブラウザダウンロードは不要です。

**ソースから実行**

```bash
git clone https://github.com/miuuyy/codex-chatgpt-web.git && \
cd codex-chatgpt-web && \
bun run app
```

ソースから実行する場合はBun 1.4.0が必要です。このコマンドはロック済みの依存関係をインストールし、アプリを開きます。

## モード

| モード | モデル | ローカルCodexツール | 追加セットアップ |
| --- | --- | --- | --- |
| **Browser-only** | Free/Go: Luna、Plus: Instant～High、Pro: Extra HighとProを追加 | なし。Codexに警告が表示されます | なし |
| **Full harness** | Free/Go: Luna、Plus: Instant～High、Pro: Extra HighとProを追加 | Proを含むすべての記載effortで利用可能 | OpenAI Tunnel + ChatGPTコネクタ |

モデル選択画面の各項目には、固定されたChatGPTモードが1つずつ割り当てられます。Codexには組み込みの
Effort行とSpeed行が引き続き表示されますが、それらを変更しても、選択中のブラウザモデルが暗黙に変わることはありません。
Fullモードでは、利用可能なすべてのeffortに同じターン単位のMCP機能が渡されます。Proだけに別の制限や
縮小されたツール契約が適用されることはありません。

## Fullハーネス

Fullモードでは、公式の[OpenAI tunnel-client](https://github.com/openai/tunnel-client)を通じて、
ChatGPTのツール呼び出しを現在のCodexタスクへ接続します。トンネルは外向きに接続されるため、
パブリックIPの公開、受信ポートの開放、ルーターのポート転送は不要です。

> [!WARNING]
> **Codex Native2**という名前で**新しい**コネクタを作成し、Permissionsを
> **Allow all actions**に設定してください。古い**Codex Native**コネクタの名前変更、更新、再利用は
> 行わないでください。ChatGPTはコネクタIDごとに公開MCP契約をキャッシュします。また、
> **Allow low-risk actions**では、コマンドやパッチがCodexハーネスへ届く前にブロックされます。

1. ランチャーで必須のセットアップを完了します。
2. ランチャーで**MCP**を開きます。ChatGPTコネクタを使用するOpenAIアカウントと同じアカウントで
   Tunnelと通常のAPI keyを作成します。キーの作成は無料で、モデルAPIのクレジットは消費しません。
3. Tunnel IDとAPI keyを貼り付け、**ハーネスに接続**を押します。
4. ChatGPTの設定で**Developer Mode**を有効にします。**Tunnel**を使って**新しい**コネクタを作成し、
   そのTunnelを選択して、**Authentication**を**None**に設定し、名前を正確に**Codex Native2**とします。
5. 古い**Codex Native**コネクタが存在する場合は、そのまま残してください。名前変更や更新は行わないでください。
   ChatGPTはコネクタIDごとに公開MCP契約をキャッシュし、このリリースでは新しい直接turn-token契約を使用します。
   **Codex Native2**の**Permissions**で**Allow all actions**を選択してください。**Allow low-risk actions**では、
   コマンドやパッチがこのランタイムへ届く前にブロックされます。外側のCodexハーネスでは、引き続き
   サンドボックスと承認ルールが適用されます。
6. **ランタイムを検証**を実行します。検証では**Codex Native2**だけを正確に選択します。
   **Codex Native**しか見つからない場合、古いコネクタを受け入れず、明示的な移行エラーで失敗します。

書き込み／変更操作には、ChatGPTワークスペースとその管理者ポリシーで操作が許可されていることも必要です。
詳しくは[Developer ModeとMCP apps](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt)
を参照してください。`--auto-approve-tool-calls`を明示的に有効にしていない限り、予期しない承認プロンプトは
安全側に倒して失敗します。このオプションがクリックするのは**Allow once**だけで、永続的な許可は付与しません。

## 運用

構造化されたローカルログは**アクティビティ**、エンドツーエンドの健全性確認は
**設定 → 診断を実行**を使用します。停止したタスクの後もChatGPTが処理を続けている場合は
**設定 → 保持中のブラウザターンをキャンセル**を使用してください。ランチャーを削除する前に
**設定 → Codex連携を削除**を実行すると、以前のCodexルートが復元されます。

ブラウザターンの診断では、各チェックポイントにサイズ制限付きのJSON状態を保存します。停止したターンや
失敗したターンではスクリーンショットも取得し、成功するすべての手順を遅くすることなく、表示中のUIから
DOMの変更を診断できるようにします。調査中にすべてのチェックポイントでスクリーンショットを取得するには、
ランタイム起動前に`CODEX_CHATGPT_WEB_BROWSER_DIAGNOSTICS=1`を設定してください。

サブエージェントプロトコルは、明示的なインストール設定です。新規インストールでは
**Compatibility V1**が使用されます。これは`multi_agent`を有効にし、グローバルの`multi_agent_v2`
オーバーライドを無効にします。切断またはアンインストール時には、ユーザーが以前設定していたfeature行を復元します。
有効中は`[agents].max_depth`を少なくとも2に引き上げ、Web子エージェントがWeb孫エージェントを起動できるようにし、
終了時に以前の値へ戻します。これはバックエンドをまたいで使える共通の操作面であり、ネイティブ親とWeb親のどちらも、
不透明なV2 payloadなしでWeb子へ委譲できます。親が待機を始める前に子が完了していても、対象を指定したwaitで
状態を確認できます。Web親の`wait_agent`は明示的な10秒ポーリングとして公開されるため、1回の長いwaitが
コネクタのMCPチャネルを占有して、子自身のツールを妨げることはありません。**Native**は高度なオプトイン設定で、
Codex自身のfeature設定を保持し、平文のWeb-to-Web V2委譲をサポートします。切り替えは意図して行い、その後
Codexを再起動して新しいタスクを開始してください。既存のタスクではプロトコルを途中で変更できません。

```bash
codex-chatgpt-web subagents status
codex-chatgpt-web subagents compatibility-v1
codex-chatgpt-web subagents native
```

## 制限とセキュリティ

- これは非公式のブラウザ自動操作であり、OpenAI APIではありません。ChatGPT UIの変更によってselectorが
  動作しなくなる可能性があります。その場合、モデルや転送方式を暗黙に切り替えず、明示的に失敗します。
- ChatGPTでアカウントごとに設定されるcomposer上限は、基盤モデルのコンテキストウィンドウより小さい場合があります。
  測定済みの境界と、より大きく決定的な転送方式に必要な条件は
  [#76](https://github.com/miuuyy/codex-chatgpt-web/issues/76)で管理しています。
- ブラウザ状態は機密性の高いログイン情報です。また、loopbackリスナーには同じローカルユーザーとして動作する
  プロセスからアクセスできます。ランチャープロファイルは共有せず、信頼できるワークステーションを使用してください。
- リリースパッケージは現在、macOS 13以降（arm64/x64）、Windows x64、Linux x64を対象としています。
  ランタイム、テスト、ネイティブパッケージングは、CIで3つすべてのOSを対象にゲートされています。
  アカウント依存のブラウザフローとMCPフローには、別途[リリース検証](docs/release-validation.md)が必要です。
  パッケージのスモークテストだけをエンドツーエンドの証明とは見なしません。
- リリース用のプラットフォーム署名情報が設定されるまでは、macOS GatekeeperまたはWindows SmartScreenに
  発行元不明の警告が表示される場合があります。1コマンドのインストーラーは、インストール前に公開済みの
  SHA-256 manifestを検証します。

Fullモードを有効にする前に、完全な[アーキテクチャ](docs/architecture.md)と
[セキュリティモデル](docs/security-model.md)をお読みください。脆弱性は[SECURITY.md](SECURITY.md)から報告してください。

## 開発

```bash
bun run app
bun run dev:launcher
bun run src/cli.ts dev status
bun run dev:chat compaction-lab "Reply with exactly: DEV READY"
bun run verify
bun run smoke:subagents
bun run app:package
```

`dev:launcher`は、`~/.codex-chatgpt-web-dev`に2つ目のランチャープロファイルを作成します。
Electronの状態、ブラウザのcookie／ログイン、ChatGPTアカウント、設定、サンドボックス化された`CODEX_HOME`、
チャット、診断、broker、トンネルプロファイルはすべて分離されます。通常のランチャーと同時に実行でき、
Responses daemonを起動したりCodexを変更したりすることはありません。任意のFullセットアップでは、
独立したChatGPTコネクタ名`Codex Native2 DEV`を使用し、分離されたMCPトンネルだけを起動・管理します。

`dev:chat`は、名前付きで状態を保持する合成outer-Codexハーネスです。分離されたランチャーブラウザ、
Temporary Chat、prompt compiler、Responses parser、compaction handlerを通じて、現在の作業ツリーを実行します。
任意のFullセットアップではMCPコネクタとbrokerも実行しますが、ツールの効果は明示的なシミュレーション結果です。
Browser-onlyチャットではouterツールを公開しません。Responsesリスナーを開く、`openai_base_url`を変更する、
稼働中のdaemonを停止する、ポート17841を使用する、といったことはありません。メッセージなしで実行すると、
`/status`、`/fill 30000`、`/compact`、`/model`、`/reset`コマンドを使用できます。**DEV**と表示された
ウィンドウ内で一度ログインし、プロファイルを初期化してください。シミュレーションツールラウンドが必要な場合だけ、
任意のFullハーネスを設定します。ランチャーはDEVトンネルを利用できる状態に保ち、名前付きチャットは必要に応じて
brokerへ接続します。プロダクションの認証情報や`Codex Native2`コネクタが暗黙に再利用されることはありません。
詳しくは[DEV chatハーネス](docs/dev-chat.md)を参照してください。

- [アーキテクチャ](docs/architecture.md)
- [DEV chatハーネス](docs/dev-chat.md)
- [セキュリティモデル](docs/security-model.md)
- [コントリビューションガイド](CONTRIBUTING.md)

## Starの推移

<a href="https://www.star-history.com/?repos=miuuyy%2Fcodex-chatgpt-web&type=date&legend=top-left">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=miuuyy/codex-chatgpt-web&type=date&theme=dark&legend=top-left&sealed_token=hBVvg_eOjfMFDrfyeo5FPQkIwcvBEmXc6F7ZoOKnfFE4KPCs67o34w4XwVuM-bHGnKR-SKCAN_TSTWrzuqSBNU-RjNZCLT4f-xNs9qcDhciQtemxHKuuFj0N5YNqZIihdaQfakrh2ANhOrvP0K2LmLXX2zbsYyVaYZknyTnlYeIS_mOGvMcO32ZmPCHK">
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=miuuyy/codex-chatgpt-web&type=date&legend=top-left&sealed_token=hBVvg_eOjfMFDrfyeo5FPQkIwcvBEmXc6F7ZoOKnfFE4KPCs67o34w4XwVuM-bHGnKR-SKCAN_TSTWrzuqSBNU-RjNZCLT4f-xNs9qcDhciQtemxHKuuFj0N5YNqZIihdaQfakrh2ANhOrvP0K2LmLXX2zbsYyVaYZknyTnlYeIS_mOGvMcO32ZmPCHK">
    <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=miuuyy/codex-chatgpt-web&type=date&legend=top-left&sealed_token=hBVvg_eOjfMFDrfyeo5FPQkIwcvBEmXc6F7ZoOKnfFE4KPCs67o34w4XwVuM-bHGnKR-SKCAN_TSTWrzuqSBNU-RjNZCLT4f-xNs9qcDhciQtemxHKuuFj0N5YNqZIihdaQfakrh2ANhOrvP0K2LmLXX2zbsYyVaYZknyTnlYeIS_mOGvMcO32ZmPCHK">
  </picture>
</a>

## 免責事項

本ソフトウェアは独立したプロジェクトであり、OpenAIとの提携やOpenAIによる推奨を受けたものではありません。
ご自身のアカウントでのみ使用し、適用される[利用規約](https://openai.com/policies/terms-of-use/)と
ワークスペースポリシーを順守してください。本ソフトウェアは、認証やアクセス制御を回避するものではありません。
