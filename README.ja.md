<p align="center">
  <img src="assets/readme/hero.svg" width="960" alt="Web モデルに切り替えても、Codex はそのまま。ChatGPT のプラン。いつものワークフロー。モデルの力を最大限に。">
</p>

<p align="center">
  <a href="https://github.com/miuuyy/codex-chatgpt-web/releases/download/v6.0.0/codex-web-gpt-6.0.0-win-x64.exe"><img src="assets/readme/download-windows.svg" width="224" height="64" alt="Windows · x64"></a>&nbsp;
  <a href="https://github.com/miuuyy/codex-chatgpt-web/releases/download/v6.0.0/codex-web-gpt-6.0.0-mac-arm64.dmg"><img src="assets/readme/download-macos.svg" width="224" height="64" alt="macOS · Apple silicon"></a>&nbsp;
  <a href="https://github.com/miuuyy/codex-chatgpt-web/releases/download/v6.0.0/codex-web-gpt-6.0.0-linux-x64.AppImage"><img src="assets/readme/download-linux.svg" width="224" height="64" alt="Linux · x64"></a>
</p>

<p align="center">
  <a href="https://github.com/miuuyy/codex-chatgpt-web/releases/download/v6.0.0/codex-web-gpt-6.0.0-mac-x64.dmg">macOS Intel</a> · <a href="https://github.com/miuuyy/codex-chatgpt-web/releases/latest">すべてのリリース</a>
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.fr.md">Français</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a>
</p>

<p align="center">
  <img src="assets/demo.gif" width="960" alt="ネイティブ Codex ハーネスを使用する ChatGPT Web ターン">
</p>

<p align="center">
  <a href="#get-started">使い始める</a> · <a href="https://github.com/miuuyy/codex-chatgpt-web/releases">更新内容</a> · <a href="docs/architecture.md">アーキテクチャ</a> · <a href="TROUBLESHOOTING.md">トラブルシューティング</a>
</p>

アカウントで利用可能な Pro を含む ChatGPT Web モデルを、Codex のネイティブモデル選択画面から使えます。ChatGPT Web の独立した利用枠を使うため、Work や Codex の利用枠は消費しません。UI、タスク、画像、ストリーミングはそのままです。

Full ハーネスモードでは、MCP を通じて ChatGPT を現在のタスクのファイル、ターミナル、ツール、承認に接続します。会話は Codex タスクに紐付いたままなので、コンテキストが増えても作業を続けられます。

<div id="get-started"><a id="quick-start"></a></div>

## 使い始める

**利用可能なモデル：** Free/Go → **Luna / Think**。推論コントロールがあるアカウント → **Instant～High** に加え、利用可能な場合に **Extra High** と **Pro**。ランチャーがアカウントの利用可能なモデルを検出します。

1. **ランチャーをインストール**：上のボタンから、お使いの OS 向けのアプリをダウンロードします。
2. **ChatGPT にサインイン**：内蔵ブラウザーでログインし、ブラウザーのスモークテストを実行します。
3. **モデルをインストール**：Codex を一度再起動します。自動モードでは、名前の末尾が **(Web)** のモデルを選択します。Pro はバージョン別の項目、Sol の推論レベルは Effort で選択します。Zero Risk は専用の項目を引き続き使用します。
4. **ツールを使って開発する場合**：ランチャーの **MCP** を開き、下記の Full ハーネス設定を完了します。

ブラウザーとランタイムはアプリに含まれています。Chrome、Node、Bun の別途インストールは不要です。

<details>
<summary><strong>ターミナルからのインストール・更新・修復</strong></summary>

更新前にランチャーを終了してください。以下のインストーラーは OS とアーキテクチャを選択し、公開チェックサムを検証します。ChatGPT プロファイルとランチャー設定は保持されます。

**macOS / Linux**

```bash
curl -fsSL https://github.com/miuuyy/codex-chatgpt-web/releases/latest/download/install-launcher.sh | sh
```

**Windows PowerShell**

```powershell
irm https://github.com/miuuyy/codex-chatgpt-web/releases/latest/download/install-launcher.ps1 | iex
```

</details>

<details>
<summary><strong>モデル・モード・MCP の設定</strong></summary>

<a id="modes"></a>

自動モードでは、推論セレクターがないアカウントに Luna/Think を表示します。それ以外は Instant～High に加え、Extra High と Pro をそれぞれ利用可能な場合に表示します。

| モード | メッセージの送信 | ローカル Codex ツール |
| --- | --- | --- |
| **Browser-only** | 自動 | なし |
| **Full harness (With Automation)** | 自動 | MCP 経由で利用可能 |
| **Zero Risk** | 手動で貼り付けて送信 | 専用 MCP コネクタ経由で利用可能 |

Zero Risk は ChatGPT ページを読み取ったり操作したりしません。モデルと `Codex Zero Risk` コネクタを自分で選び、用意されたプロンプトを貼り付けて送信し、ランチャーで **Sent** を確認してください。名前の末尾が **(Web)** の自動モデルでは、対応する Effort を Codex で選択できます。コンテキスト上限を維持するため、Instant と各 Pro バージョンは別の項目になります。既存のタスクに保存された旧モデル項目は、従来の固定モードを維持します。

<a id="full-harness"></a>

### Full ハーネス

Full モードは、公式の [OpenAI tunnel-client](https://github.com/openai/tunnel-client) を通じて、
ChatGPT のツール呼び出しを現在の Codex タスクへ接続します。トンネルは外向きであり、公開 IP の露出、
受信ポートの開放、ルーターのポート転送は不要です。

> **Limits**
>
> **GPT-5.6 Sol Pro** と **GPT-6 Astra** の現在の ChatGPT メッセージ上限については、
> [Limits](https://github.com/miuuyy/codex-chatgpt-web/discussions/309) を参照してください。
> Token コンテキスト上限は、アカウント種別と選択した effort によって異なります。Plus の
> Medium/High は実測 90,000-token ウィンドウを使用し、実験的な **3× context** を有効にすると
> 最大 270,000 tokens まで拡張されます。いずれの場合もネイティブ Codex compaction に対応します。

1. ランチャーの必須セットアップを完了します。
2. ランチャーで **MCP** を開きます。ChatGPT コネクタを使用するものと同じ OpenAI アカウントで
   Tunnel と通常の API キーを作成します。キーの作成は無料で、モデル API クレジットを消費しません。
3. Tunnel ID と API キーを貼り付け、**ハーネスを接続**を押します。
4. ChatGPT の設定で **Developer Mode** を有効にします。**Tunnel** を使う**新しい**コネクタを作成し、
   対象の Tunnel を選択して、**Authentication** を **None**、名前を正確に **Codex Native2** に設定します。
5. **Codex Native2** の **Permissions** で **Allow all actions** を選択します。
   **Allow low-risk actions** では、コマンドとパッチがこのランタイムへ到達する前にブロックされます。
   外側の Codex ハーネスでは、引き続きサンドボックスと承認が適用されます。
6. **ランタイムを検証**を実行し、**Codex Native2** が接続済みで利用可能であることを確認します。

書き込み／変更操作には、ChatGPT ワークスペースと管理者ポリシー側での許可も必要です。
[Developer Mode と MCP アプリ](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt)を参照してください。
予期しない承認プロンプトは、`--auto-approve-tool-calls` が明示的に有効でない限り fail-closed になります。
このオプションが押すのは **Allow once** だけで、永続的な許可は付与しません。

</details>

<details>
<summary><strong>診断とサブエージェント</strong></summary>

<a id="operations"></a>

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

</details>

<details>
<summary><strong>動作環境とセキュリティ</strong></summary>

<a id="limitations-and-security"></a>

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

一時チャットは [ChatGPT のプライバシーモード](https://help.openai.com/en/articles/8914046-temporary-chat-faq)です。プロンプトは引き続き OpenAI によって処理されます。

検証範囲：[リリース検証](docs/release-validation.md)。

これは独立したソフトウェアであり、OpenAI との提携や OpenAI による推奨を受けたものではありません。
ご自身のアカウントで、適用される[利用規約](https://openai.com/policies/terms-of-use/)と
ワークスペースポリシーに従って使用してください。認証やアクセス制御を回避するものではありません。

</details>

<details>
<summary><strong>ソースからの実行と開発</strong></summary>

<a id="development"></a>

```bash
git clone https://github.com/miuuyy/codex-chatgpt-web.git && \
cd codex-chatgpt-web && \
bun run app
```

ソースからの実行には Bun 1.4.0 が必要です。このコマンドはロックされた依存関係をインストールしてアプリを開きます。

```bash
bun run app
bun run dev:launcher
bun run src/cli.ts dev status
bun run dev:chat compaction-lab "Reply with exactly: DEV READY"
bun run verify
bun run smoke:subagents
bun run app:package
```

`dev:launcher` は `~/.codex-chatgpt-web-dev` 内の独立したプロファイルとアカウントを使います。`dev:chat` は実際のブラウザーとコンパクション処理を使い、ツールの結果は明示的にシミュレーションします。通常の Codex のルートは変更しません。設定とコマンドは [DEV chat ハーネス](docs/dev-chat.md)を参照してください。

</details>

## Star の履歴

<a href="https://www.star-history.com/?repos=miuuyy%2Fcodex-chatgpt-web&type=date&legend=top-left">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=miuuyy/codex-chatgpt-web&type=date&theme=dark&legend=top-left&sealed_token=hBVvg_eOjfMFDrfyeo5FPQkIwcvBEmXc6F7ZoOKnfFE4KPCs67o34w4XwVuM-bHGnKR-SKCAN_TSTWrzuqSBNU-RjNZCLT4f-xNs9qcDhciQtemxHKuuFj0N5YNqZIihdaQfakrh2ANhOrvP0K2LmLXX2zbsYyVaYZknyTnlYeIS_mOGvMcO32ZmPCHK">
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=miuuyy/codex-chatgpt-web&type=date&legend=top-left&sealed_token=hBVvg_eOjfMFDrfyeo5FPQkIwcvBEmXc6F7ZoOKnfFE4KPCs67o34w4XwVuM-bHGnKR-SKCAN_TSTWrzuqSBNU-RjNZCLT4f-xNs9qcDhciQtemxHKuuFj0N5YNqZIihdaQfakrh2ANhOrvP0K2LmLXX2zbsYyVaYZknyTnlYeIS_mOGvMcO32ZmPCHK">
    <img alt="Star 履歴チャート" src="https://api.star-history.com/chart?repos=miuuyy/codex-chatgpt-web&type=date&legend=top-left&sealed_token=hBVvg_eOjfMFDrfyeo5FPQkIwcvBEmXc6F7ZoOKnfFE4KPCs67o34w4XwVuM-bHGnKR-SKCAN_TSTWrzuqSBNU-RjNZCLT4f-xNs9qcDhciQtemxHKuuFj0N5YNqZIihdaQfakrh2ANhOrvP0K2LmLXX2zbsYyVaYZknyTnlYeIS_mOGvMcO32ZmPCHK">
  </picture>
</a>

---

[トラブルシューティング](TROUBLESHOOTING.md) · [セキュリティ](SECURITY.md) · [コントリビューション](CONTRIBUTING.md) · [MIT ライセンス](LICENSE) · [CI](https://github.com/miuuyy/codex-chatgpt-web/actions/workflows/ci.yml)

もう一つの自作アプリ：<img src="assets/readme/persona-voice.svg" width="20" height="20" alt=""> [ChatGPT Persona Voice](https://github.com/miuuyy/ChatGPT-Persona-Voice) — ChatGPT と Codex に、ローカルでほぼリアルタイムのカスタム音声を。
