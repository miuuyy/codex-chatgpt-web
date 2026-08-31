<h1 align="center">Codex 用 ChatGPT Web</h1>

<p align="center">
  <strong>ChatGPT Web（Pro を含む）を Codex のネイティブモデルとして使用。</strong><br>
  モデルの利用枠を切り替えて、いつものワークフローを維持できます。
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.ja.md">日本語</a>
</p>

<p align="center">
  <a href="TROUBLESHOOTING.md">トラブルシューティング</a> · <a href="SECURITY.md">セキュリティ</a> · <a href="CONTRIBUTING.md">コントリビューション</a>
</p>

<p align="center">
  <a href="https://github.com/miuuyy/codex-chatgpt-web/actions/workflows/ci.yml"><img src="https://github.com/miuuyy/codex-chatgpt-web/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT ライセンス"></a>
  <img src="https://img.shields.io/badge/macOS-arm64%20%7C%20x64-black?logo=apple" alt="macOS arm64 および x64">
  <img src="https://img.shields.io/badge/Windows-x64-0078d4?logo=windows11" alt="Windows x64">
  <img src="https://img.shields.io/badge/Linux-x64-fcc624?logo=linux&logoColor=black" alt="Linux x64">
  <img src="https://img.shields.io/badge/Free_AI-no_API_fees-10a37f" alt="API 料金なしの AI">
</p>

Free および Go アカウントでは、Codex のネイティブモデル選択画面に
**ChatGPT Web — Luna** が追加されます。reasoning セレクターが表示されるアカウントでは、
サブスクリプションで利用可能な **Instant**、**Medium**、**High**、**Extra High**、**Pro** を使用できます。
ブリッジは、コンパイル済みの現在の Codex タスクコンテキストを新しい ChatGPT 一時チャットへ送り、
画像を添付し、表示される reasoning、ツールアクティビティ、Markdown を同じ Codex タスクへストリーミングします。

<p align="center">
  <img src="assets/demo.gif" alt="ネイティブ Codex ハーネスを使用する ChatGPT Web ターン" width="960">
</p>

```text
Codex タスク ──Responses + SSE──▶ codex-chatgpt-web ──内蔵ブラウザー──▶ ChatGPT
      ▲                                  │                              │
      └──── ネイティブ UI、コンテキスト、画像、トレース、ツールライフサイクル ────┘
```

Codex はネイティブのタスク、コンテキストライフサイクル、UI、ツールハーネスを維持します。
ローカル Responses ブリッジは、選択されたモデルのタスクだけをタスクに紐付いた ChatGPT 一時チャットへルーティングします。
Full モードでは、次のコンパクション境界まで、MCP が ChatGPT を同じ Codex タスクのツールへ接続します。

> [!TIP]
> **[ChatGPT Persona Voice](https://github.com/miuuyy/ChatGPT-Persona-Voice)** も開発しています。
> ChatGPT/Codex の音声をローカル環境でほぼリアルタイムに変換するアプリです。
> アカウント、ブラウザーセッション、ChatGPT リクエストには一切触れないため、
> 使用によってアカウントがブロックされるリスクはありません。気に入っていただけたら、ぜひお試しください。

## 主な特長

- **Codex のネイティブモデル。** ChatGPT Web は Codex のモデル選択画面から実行され、元のタスク UI、
  コンテキストライフサイクル、ストリーミング、トレース、ツール表示はそのまま維持されます。
- **MCP 経由の完全な Codex ハーネス。** Full モードでは、Pro を含め、サインイン中のアカウントで
  利用可能なすべての effort から、実行中タスクのファイルシステム、シェル、画像、承認、設定済みツール／アプリを使用できます。
- **継続的なタスクセッションとネイティブコンパクション。** 連続するメッセージは、タスクに紐付いた
  1 つの一時チャットを再利用します。コンテキスト境界に達すると、保持中のエージェントがチェックポイントを書き、
  その後 Codex が新しいチャットを開始します。チャットが閉じられていた場合は、正規の Codex 履歴がフォールバックになります。
- **1 つのクロスプラットフォームランチャー。** macOS、Windows、Linux 向けアプリが、サインイン、
  モデル設定、MCP ガイド、ヘルスチェック、安全な診断、最大 5 件の表示可能なタスク紐付きブラウザータブを管理します。
- **Fail-closed 動作。** モデルやツールの欠落、ChatGPT UI の変更が発生した場合、ルートや機能を黙って切り替えず、
  明示的なエラーを返します。エンドツーエンドの対象範囲は
  [リリース検証](docs/release-validation.md)に記載されています。

一時チャットは ChatGPT のプライバシーモードであり、匿名化やローカル推論ではありません。
プロンプトは引き続き OpenAI によって処理され、アカウント設定および OpenAI の
[一時チャットポリシー](https://help.openai.com/en/articles/8914046-temporary-chat-faq)が適用されます。
このプロジェクトは非公式です。適用される OpenAI の利用規約とワークスペースポリシーを守る責任は利用者にあります。

## クイックスタート

デスクトップランチャーをインストールまたは更新します。既存のインストールを更新・修復する場合は、
ランチャーを終了して同じコマンドをもう一度実行してください。ChatGPT プロファイルとランチャー設定を保持したまま、
アプリケーションと内蔵ランタイムが置き換えられます。

**macOS または Linux**

```bash
curl -fsSL https://github.com/miuuyy/codex-chatgpt-web/releases/latest/download/install-launcher.sh | sh
```

**Windows PowerShell**

```powershell
irm https://github.com/miuuyy/codex-chatgpt-web/releases/latest/download/install-launcher.ps1 | iex
```

アプリ内で次の 3 項目を完了します。

1. ランチャー内蔵の ChatGPT ブラウザーで直接サインインします。ログインページと ID プロバイダーの
   ウィンドウは、同じランチャー管理の非公開ブラウザープロファイル内に保持されます。ブラウザー間でセッションをコピーしません。
2. ブラウザーのスモークテストを実行します。
3. **モデルをインストール**を押し、Codex を一度再起動して、**ChatGPT Web — …** モデルを選択します。

セットアップ時に、ランチャーが現在のアカウントの ChatGPT コントロールを検出します。
Free/Go アカウントでは Luna のみが表示され、Pro はサインイン中のアカウントで利用可能な場合にのみ表示されます。
独立した **MCP** ページは任意で、ターミナルコマンドを使わずに Full ハーネスの設定を案内します。

パッケージ版ランチャーは、サインインと ChatGPT モデルのターンを内蔵ブラウザーで処理します。
ブラウザー拡張、モデル API キー、インストール済みの Chrome/Chromium、システムの Node/Bun、
プロジェクト管理のブラウザーダウンロードは不要です。

**ソースから実行**

```bash
git clone https://github.com/miuuyy/codex-chatgpt-web.git && \
cd codex-chatgpt-web && \
bun run app
```

この方法には Bun 1.4.0 が必要です。コマンドはロックされた依存関係をインストールしてアプリを開きます。

## モード

| モード | モデル | ローカル Codex ツール | 追加設定 |
| --- | --- | --- | --- |
| **Browser-only** | Free/Go: Luna、Plus: Instant～High、Pro: Extra High と Pro を追加 | なし。Codex が警告を表示 | なし |
| **Full harness** | Free/Go: Luna、Plus: Instant～High、Pro: Extra High と Pro を追加 | Pro を含むすべての表示 effort で使用可能 | OpenAI または Cloudflare トンネル + ChatGPT コネクタ |

モデル選択画面の各項目は、1 つの固定 ChatGPT モードに対応します。Codex には内蔵の Effort と Speed 行も表示されますが、
それらを変更しても、選択済みのブラウザーモデルが黙って切り替わることはありません。
Full モードでは、利用可能なすべての effort が同じターン紐付き MCP capability を受け取ります。
Pro 専用の制限や縮小されたツール契約はありません。

## Full ハーネス

Full モードは、公式の [OpenAI tunnel-client](https://github.com/openai/tunnel-client) または既存の
Cloudflare Named Tunnel を通じて、ChatGPT のツール呼び出しを現在の Codex タスクへ接続します。
どちらも外向き接続で、ルーターのポート転送は不要です。Cloudflare は本番デスクトップランチャーで
のみ使用できます。リポジトリの DEV ハーネスは意図的に Responses HTTP リスナーを持たないため、
引き続き OpenAI Tunnel を使用します。

> [!WARNING]
> ランチャーでコネクタ名を指定し、その正確な名前でコネクタを作成して、権限を
> **Allow all actions** に設定してください。既存コネクタで現在の MCP 認証契約を使用する場合は、
> **Connect** または **Reconnect** を選択します。どちらも表示されない場合は、ランチャーの表示項目で
> 編集して保存し、もう一度接続します。通常、コネクタを削除する必要はありません。

1. ランチャーの必須セットアップを完了します。
2. ランチャーで **MCP** を開き、使用するコネクタ名を入力します。
3. トンネル方式を 1 つ選択します。
   - **OpenAI Tunnel:** ChatGPT コネクタと同じ OpenAI アカウントで Tunnel と通常の API キーを
     作成し、両方を貼り付けて **ハーネスを接続**を押します。キーの作成は無料で、モデル API
     クレジットを消費しません。
   - **Cloudflare 名前付きトンネル:** `cloudflared` をインストールし、実行ファイルと YAML 設定を
     選択して、設定内の正確なホスト名を 1 つ選んでから **ハーネスを接続**を押します。ランチャーは
     最初に `~/.cloudflared/config.yml` を自動確認します。実行時には、ランダムな MCP URL パスだけを
     現在の loopback ポートへ転送する非公開の一時設定を作成します。元の YAML は変更せず、
     トンネル停止時に一時ファイルを削除します。
4. ChatGPT の設定で **Developer Mode** を有効にし、ランチャーに表示された正確な名前で
   コネクタを作成または更新します。OpenAI Tunnel では **Tunnel** と設定済みトンネルを選択します。
   Cloudflare ではランチャーの完全な URL でカスタム MCP コネクタを作成し、**Authentication** は
   **OAuth** を選びます。Advanced OAuth settings に表示された **Registration URL** を貼り、DCR と
   token endpoint authentication は **None** のままにして、認可ページでローカルパスフレーズを入力します。
   URL を知っているだけではアクセスできません。
5. **Permissions** で **Allow all actions** を選択します。**Allow low-risk actions** ではコマンド呼び出しが
   ブロックされます。既存コネクタは接続、再接続、または編集して保存することで再認可でき、通常は削除不要です。
6. **ランタイムを検証**を実行します。検証は設定済みのコネクタ名のみを正確に選択し、古いコネクタへ
   フォールバックしません。

書き込み／変更操作には、ChatGPT ワークスペースと管理者ポリシー側での許可も必要です。
[Developer Mode と MCP アプリ](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt)を参照してください。
予期しない承認プロンプトは、`--auto-approve-tool-calls` が明示的に有効でない限り fail-closed になります。
このオプションが押すのは **Allow once** だけで、永続的な許可は付与しません。

## 運用

安全なローカル診断には **アクティビティ**、エンドツーエンドのヘルスチェックには
**設定 → 診断を実行**を使用します。設定から、保持中のブラウザーターンのキャンセルや、
アンインストール前の Codex 統合削除も行えます。すべてのブラウザーチェックポイントでスクリーンショットが必要な場合にのみ、
`CODEX_CHATGPT_WEB_BROWSER_DIAGNOSTICS=1` を設定してください。

新規インストールでは、クロスバックエンドのサブエージェントに **Compatibility V1** を使用します。
**Native** は Codex 独自の機能設定を維持し、プレーンテキストの Web-to-Web V2 delegation を有効にします。
プロトコル変更後は Codex を再起動し、新しいタスクを開始してください。

```bash
codex-chatgpt-web subagents status
codex-chatgpt-web subagents compatibility-v1
codex-chatgpt-web subagents native
```

## 制限とセキュリティ

- これは非公式のブラウザー自動化であり、OpenAI API ではありません。ChatGPT UI の変更によりセレクターが壊れる可能性があります。
  差異が発生した場合、モデルや転送方式を黙って切り替えず、明示的に失敗します。
- ブラウザー状態は機密性の高いログイン情報です。また、loopback リスナーには同じローカルユーザーで動作する
  プロセスからアクセスできます。ランチャープロファイルを共有せず、信頼できるワークステーションを使用してください。
- リリースパッケージは現在、macOS 13+（arm64/x64）、Windows x64、Linux x64 を対象としています。
  ランタイム、テスト、パッケージングは CI で 3 プラットフォームすべてに対して検証されます。
  アカウント依存のブラウザー／MCP フローには、個別の[リリース検証](docs/release-validation.md)を使用します。
- ビルドはまだプラットフォーム署名されていないため、Gatekeeper または SmartScreen が警告を表示する場合があります。
  インストーラーは、インストール前に公開 SHA-256 マニフェストを検証します。

Full モードを有効にする前に、完全な[アーキテクチャ](docs/architecture.md)と
[セキュリティモデル](docs/security-model.md)をお読みください。脆弱性は [SECURITY.md](SECURITY.md) から報告してください。

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

`dev:launcher` は `~/.codex-chatgpt-web-dev` に 2 つ目のランチャープロファイルを作成します。
Electron state、ブラウザーの cookie／ログイン、ChatGPT アカウント、設定、サンドボックス化された `CODEX_HOME`、
チャット、診断、broker、トンネルプロファイルは本番環境から分離されます。通常のランチャーと同時に実行でき、
Responses daemon の起動や Codex の変更は行いません。任意の Full セットアップでは、個別に設定した
ChatGPT コネクタ名を使用し、隔離された OpenAI MCP トンネルのみを起動・監視します。本番の
Cloudflare 設定は再利用しません。

`dev:chat` は名前付きの永続的な synthetic outer-Codex ハーネスです。現在の作業ツリーを、隔離されたランチャーの
ブラウザー、一時チャット、プロンプトコンパイラー、Responses parser、コンパクションハンドラーを通して実行します。
任意の Full セットアップでは MCP コネクタと broker も検証され、ツールの効果は明示的なシミュレーション結果になります。
Browser-only チャットは外側のツールを公開しません。Responses リスナーを開いたり、`openai_base_url` を変更したり、
稼働中 daemon を停止したり、ポート 17841 を使用したりすることもありません。
メッセージなしで実行すると、`/status`、`/fill 30000`、`/compact`、`/model`、`/reset` コマンドを使用できます。
**DEV** と表示されたウィンドウ内で一度サインインし、プロファイルを初期化してください。
シミュレーションツールのターンが必要な場合にのみ、任意の Full ハーネスを設定します。
ランチャーは DEV トンネルを使用可能な状態に保ち、名前付きチャットは必要に応じて broker を接続します。
本番の認証情報や本番コネクタが暗黙的に再利用されることはありません。
[DEV chat ハーネス](docs/dev-chat.md)を参照してください。

- [アーキテクチャ](docs/architecture.md)
- [DEV chat ハーネス](docs/dev-chat.md)
- [セキュリティモデル](docs/security-model.md)
- [トラブルシューティング](TROUBLESHOOTING.md)
- [コントリビューションガイド](CONTRIBUTING.md)

## Star の履歴

<a href="https://www.star-history.com/?repos=miuuyy%2Fcodex-chatgpt-web&type=date&legend=top-left">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=miuuyy/codex-chatgpt-web&type=date&theme=dark&legend=top-left&sealed_token=hBVvg_eOjfMFDrfyeo5FPQkIwcvBEmXc6F7ZoOKnfFE4KPCs67o34w4XwVuM-bHGnKR-SKCAN_TSTWrzuqSBNU-RjNZCLT4f-xNs9qcDhciQtemxHKuuFj0N5YNqZIihdaQfakrh2ANhOrvP0K2LmLXX2zbsYyVaYZknyTnlYeIS_mOGvMcO32ZmPCHK">
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=miuuyy/codex-chatgpt-web&type=date&legend=top-left&sealed_token=hBVvg_eOjfMFDrfyeo5FPQkIwcvBEmXc6F7ZoOKnfFE4KPCs67o34w4XwVuM-bHGnKR-SKCAN_TSTWrzuqSBNU-RjNZCLT4f-xNs9qcDhciQtemxHKuuFj0N5YNqZIihdaQfakrh2ANhOrvP0K2LmLXX2zbsYyVaYZknyTnlYeIS_mOGvMcO32ZmPCHK">
    <img alt="Star 履歴チャート" src="https://api.star-history.com/chart?repos=miuuyy/codex-chatgpt-web&type=date&legend=top-left&sealed_token=hBVvg_eOjfMFDrfyeo5FPQkIwcvBEmXc6F7ZoOKnfFE4KPCs67o34w4XwVuM-bHGnKR-SKCAN_TSTWrzuqSBNU-RjNZCLT4f-xNs9qcDhciQtemxHKuuFj0N5YNqZIihdaQfakrh2ANhOrvP0K2LmLXX2zbsYyVaYZknyTnlYeIS_mOGvMcO32ZmPCHK">
  </picture>
</a>

## 免責事項

これは独立したソフトウェアであり、OpenAI との提携や OpenAI による推奨を受けたものではありません。
ご自身のアカウントで、適用される[利用規約](https://openai.com/policies/terms-of-use/)と
ワークスペースポリシーに従って使用してください。認証やアクセス制御を回避するものではありません。
