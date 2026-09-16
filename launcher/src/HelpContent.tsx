import type { Copy } from "./i18n";
import { Icon } from "./icons";
import type { Language, Surface } from "./types";
import "./help.css";

// Keep the guide aligned with README.md → Get started / Models / Full harness.
const en = {
  intro: "Use ChatGPT Web as a model in your existing Codex workflow. Keep this launcher running while you work.",
  start: "Start here",
  steps: [
    { title: "Prepare the launcher", body: "Sign in to ChatGPT in Browser. In Setup, run the browser check and install models. You only need to finish setup once." },
    { title: "Select a Web model in Codex", body: "Restart Codex after installation, then choose ChatGPT Web — High or another available Web model. Send your task from Codex as usual." },
    { title: "Follow the result in Codex", body: "The launcher sends the task to ChatGPT and returns the response to the same Codex task. In Full mode, tool activity and file changes also appear in Codex." },
  ],
  clients: "Where to start a task",
  codex: "Codex app / CLI",
  codexBody: "Use the app’s model picker or /model in the CLI. To start a CLI session directly with High, run this in your project folder:",
  orcaBody: "Start Codex in Orca with codex --profile gpt to load gpt.config.toml and use the Web bridge. Ordinary Codex sessions keep the base config.toml routing. Select the model from the profile's model picker.",
  models: "Models and effort",
  modelsBody: "Available entries depend on the ChatGPT account signed in here. Each automatic Web entry has a fixed mode: select High, Pro, Instant, etc. in the model list. Codex’s separate Effort and Speed controls do not change that Web entry’s mode.",
  tools: "What MCP adds",
  full: "Full mode · local tools",
  fullBody: "MCP connects ChatGPT to the tools of the current Codex task: shell commands, files, and configured tools. Complete the MCP guide with an OpenAI tunnel and the Codex Native2 ChatGPT plugin. In automatic mode, the launcher attaches that plugin for each task.",
  permission: "Codex Native2 requires Allow all actions for tool work. The outer Codex session’s sandbox and approval policy still govern execution. Workspace policies must also permit write actions.",
  browserOnly: "Browser-only · text responses",
  browserOnlyBody: "Without MCP, you can use Web models for responses, but they cannot run local commands or modify project files.",
  manual: "Zero Risk · manual sending",
  manualBody: "This separate interaction mode requires its own Codex Zero Risk connector. Copy the prepared prompt, choose the connector, model and effort in ChatGPT, then paste and send it yourself. Change the interaction mode in Settings and follow the matching MCP guide.",
  trouble: "If something does not work",
  questions: [
    { title: "Web models are missing", body: "Open Setup and check model installation. Fully restart Codex; in Orca, open a new Codex session or terminal. If you use a custom CODEX_HOME, confirm that the client loads the configuration where the models were installed." },
    { title: "ChatGPT responds, but tools do not run", body: "Open MCP and run Verify runtime. Check that Codex Native2 is connected in the same ChatGPT workspace, has Allow all actions, and that the tunnel is running. A successful runtime check confirms the connection; verify actual tool work with a small task in Codex." },
    { title: "A task is stuck or login expired", body: "Check the account in Browser, then use Settings → Run doctor and inspect Activity. Settings can cancel an active browser turn. Keep the launcher running during Web tasks." },
  ],
  docs: "Repository documentation",
  readme: "Usage guide",
  troubleshooting: "Troubleshooting",
};

const guides: Record<Language, typeof en> = {
  en,
  "zh-TW": en,
  ko: {
    intro: "평소 쓰던 Codex에서 ChatGPT Web을 모델로 선택해 사용합니다. 작업 중에는 이 런처를 켜 두세요.",
    start: "이렇게 시작하세요",
    steps: [
      { title: "런처 준비", body: "브라우저에서 ChatGPT에 로그인하고, 구성의 ‘설정’에서 브라우저 확인과 모델 설치를 마칩니다. 최초 설정을 완료했다면 다시 설치할 필요는 없습니다." },
      { title: "Codex에서 Web 모델 선택", body: "설치 후 Codex를 다시 시작하고 ChatGPT Web — High 등 사용 가능한 Web 모델을 선택하세요. 작업 요청은 평소처럼 Codex에 입력합니다." },
      { title: "Codex에서 결과 확인", body: "런처가 작업을 ChatGPT에 보내고 같은 Codex 작업으로 응답을 돌려줍니다. Full 모드에서는 명령 실행과 파일 변경도 Codex에 표시됩니다." },
    ],
    clients: "어디서 작업을 시작하나요?",
    codex: "일반 Codex 앱 / CLI",
    codexBody: "앱의 모델 선택 메뉴 또는 CLI의 /model을 사용하세요. 프로젝트 폴더에서 아래 명령으로 High 모델을 바로 시작할 수도 있습니다.",
    orcaBody: "Orca에서 codex --profile gpt로 실행하면 gpt.config.toml을 읽고 Web 브리지를 사용합니다. 일반 Codex 세션은 기본 config.toml의 라우팅을 유지합니다. 프로필의 모델 목록에서 사용할 모델을 선택하세요.",
    models: "모델과 추론 강도",
    modelsBody: "표시되는 모델은 이 런처에 로그인한 ChatGPT 계정에 따라 달라집니다. 자동 모드의 각 Web 모델은 동작 모드가 고정되어 있으므로 모델 목록에서 High, Pro, Instant 등을 선택하세요. Codex의 별도 Effort·Speed 설정으로 Web 모델의 모드가 바뀌지는 않습니다.",
    tools: "MCP는 어떤 역할인가요?",
    full: "Full 모드 · 로컬 도구 사용",
    fullBody: "MCP는 ChatGPT와 현재 Codex 작업의 도구를 연결합니다. 명령 실행, 파일 작업, 설정된 도구를 사용할 수 있습니다. MCP 안내에 따라 OpenAI 터널과 ChatGPT의 Codex Native2 플러그인을 연결하세요. 자동 모드에서는 런처가 작업마다 이 플러그인을 연결합니다.",
    permission: "도구 작업에는 Codex Native2의 ‘모든 액션 허용’이 필요합니다. 실제 실행에는 바깥쪽 Codex 세션의 샌드박스와 승인 정책이 계속 적용됩니다. 워크스페이스 정책도 쓰기 작업을 허용해야 합니다.",
    browserOnly: "Browser-only · 텍스트 응답",
    browserOnlyBody: "MCP 없이도 Web 모델의 응답은 받을 수 있지만, 로컬 명령을 실행하거나 프로젝트 파일을 수정할 수는 없습니다.",
    manual: "Zero Risk · 직접 보내기",
    manualBody: "별도의 Codex Zero Risk 커넥터를 사용하는 수동 모드입니다. 준비된 프롬프트를 복사하고 ChatGPT에서 커넥터·모델·추론 강도를 선택한 다음 직접 붙여 넣어 전송합니다. 설정에서 상호작용 모드를 바꾸고 해당 MCP 안내를 따라 설정하세요.",
    trouble: "잘 안 될 때",
    questions: [
      { title: "Web 모델이 목록에 없어요", body: "구성의 ‘설정’에서 모델 설치 상태를 확인하세요. Codex를 완전히 다시 시작하고, Orca에서는 새 Codex 세션이나 터미널을 여세요. 별도 CODEX_HOME을 사용한다면 모델을 설치한 설정을 해당 클라이언트가 읽는지 확인하세요." },
      { title: "답변은 오는데 도구가 실행되지 않아요", body: "MCP에서 ‘런타임 확인’을 실행하세요. 같은 ChatGPT 워크스페이스에 Codex Native2가 연결되어 있는지, 권한이 ‘모든 액션 허용’인지, 터널이 실행 중인지 확인하세요. 런타임 확인은 연결 상태를 검증하므로 실제 도구 실행은 Codex에서 작은 작업으로 확인하세요." },
      { title: "작업이 멈추거나 로그인이 풀렸어요", body: "브라우저에서 계정을 확인한 뒤 설정의 ‘진단 실행’과 활동 로그를 확인하세요. 설정에서 진행 중인 브라우저 턴을 취소할 수 있습니다. Web 모델 작업 중에는 런처를 계속 실행해 두세요." },
    ],
    docs: "레포의 자세한 설명",
    readme: "사용 가이드",
    troubleshooting: "문제 해결",
  },
  "zh-CN": {
    intro: "在现有 Codex 工作流中选择 ChatGPT Web 模型。工作期间请保持启动器运行。",
    start: "开始使用",
    steps: [
      { title: "准备启动器", body: "在浏览器中登录 ChatGPT，在设置中完成浏览器检查和模型安装。首次配置完成后无需重复安装。" },
      { title: "在 Codex 中选择 Web 模型", body: "安装后重启 Codex，选择 ChatGPT Web — High 或其他可用的 Web 模型，然后像平常一样在 Codex 中提交任务。" },
      { title: "在 Codex 中查看结果", body: "启动器将任务发送到 ChatGPT，并把回复返回同一个 Codex 任务。Full 模式还会显示工具活动和文件更改。" },
    ],
    clients: "在哪里启动任务",
    codex: "Codex 应用 / CLI",
    codexBody: "使用应用的模型选择器或 CLI 的 /model。也可以在项目目录中运行以下命令，直接使用 High：",
    orcaBody: "在 Orca 中运行 codex --profile gpt，加载 gpt.config.toml 并使用 Web 桥接。普通 Codex 会话保留基础 config.toml 的路由。在该配置的模型列表中选择模型。",
    models: "模型与推理强度",
    modelsBody: "可用模型取决于启动器中登录的 ChatGPT 账户。自动模式下每个 Web 条目的模式固定；请从模型列表选择 High、Pro、Instant 等。Codex 的独立 Effort 和 Speed 控件不会改变该 Web 条目的模式。",
    tools: "MCP 的作用",
    full: "Full 模式 · 本地工具",
    fullBody: "MCP 将 ChatGPT 连接到当前 Codex 任务的命令、文件及已配置的工具。按照 MCP 指引配置 OpenAI 隧道和 ChatGPT 的 Codex Native2 插件。自动模式下，启动器会为任务连接该插件。",
    permission: "工具操作需要将 Codex Native2 设为“允许所有操作”。实际执行仍遵循外层 Codex 会话的沙箱和审批策略，工作区策略也必须允许写入。",
    browserOnly: "Browser-only · 文本回复",
    browserOnlyBody: "无需 MCP 也能获得 Web 模型回复，但无法执行本地命令或修改项目文件。",
    manual: "Zero Risk · 手动发送",
    manualBody: "该交互模式需要单独的 Codex Zero Risk 连接器。复制准备好的提示词，在 ChatGPT 中选择连接器、模型与推理强度，然后自行粘贴并发送。在设置中切换交互模式，并完成对应的 MCP 指引。",
    trouble: "遇到问题时",
    questions: [
      { title: "找不到 Web 模型", body: "在设置中检查模型安装。完全重启 Codex；在 Orca 中打开新会话或终端。如果使用自定义 CODEX_HOME，请确认客户端读取的是安装模型时使用的配置。" },
      { title: "能回复，但工具无法运行", body: "在 MCP 中运行“验证运行时”。确认 Codex Native2 连接到相同的 ChatGPT 工作区、允许所有操作，且隧道正在运行。运行时检查确认连接状态；请在 Codex 中用小任务验证实际工具操作。" },
      { title: "任务卡住或登录过期", body: "在浏览器中检查账户，然后在设置中运行诊断并查看活动日志。设置也可取消当前浏览器轮次。执行 Web 任务时请保持启动器运行。" },
    ],
    docs: "仓库文档",
    readme: "使用指南",
    troubleshooting: "故障排查",
  },
  ja: {
    intro: "いつもの Codex で ChatGPT Web をモデルとして選択します。作業中はランチャーを起動したままにしてください。",
    start: "使い始めるには",
    steps: [
      { title: "ランチャーを準備", body: "ブラウザーで ChatGPT にログインし、セットアップでブラウザーチェックとモデルのインストールを完了します。初回設定が完了すれば再インストールは不要です。" },
      { title: "Codex で Web モデルを選択", body: "インストール後に Codex を再起動し、ChatGPT Web — High など利用可能な Web モデルを選択します。タスクはいつもどおり Codex に入力します。" },
      { title: "Codex で結果を確認", body: "ランチャーがタスクを ChatGPT に送り、同じ Codex タスクに応答を返します。Full モードではツールの動作やファイル変更も Codex に表示されます。" },
    ],
    clients: "タスクを開始する場所",
    codex: "Codex アプリ / CLI",
    codexBody: "アプリのモデル選択、または CLI の /model を使います。プロジェクトのフォルダーで次のコマンドを実行すると High で開始できます。",
    orcaBody: "Orca で codex --profile gpt を実行すると、gpt.config.toml を読み込み Web ブリッジを使用します。通常の Codex セッションは基本の config.toml のルーティングを維持します。プロファイルのモデル一覧からモデルを選択してください。",
    models: "モデルと推論強度",
    modelsBody: "利用可能なモデルはランチャーでログインした ChatGPT アカウントによって異なります。自動モードの各 Web 項目はモードが固定です。モデル一覧で High、Pro、Instant などを選んでください。Codex の個別の Effort・Speed 設定では Web 項目のモードは変わりません。",
    tools: "MCP の役割",
    full: "Full モード · ローカルツール",
    fullBody: "MCP は ChatGPT と現在の Codex タスクのコマンド、ファイル、設定済みツールを接続します。MCP ガイドに従い OpenAI トンネルと ChatGPT の Codex Native2 プラグインを設定してください。自動モードではランチャーがタスクごとに接続します。",
    permission: "ツール操作には Codex Native2 の「すべてのアクションを許可」が必要です。実行には外側の Codex セッションのサンドボックスと承認ポリシーが引き続き適用されます。ワークスペースでも書き込みを許可する必要があります。",
    browserOnly: "Browser-only · テキスト応答",
    browserOnlyBody: "MCP なしでも Web モデルの応答を受け取れますが、ローカルコマンドの実行やプロジェクトファイルの変更はできません。",
    manual: "Zero Risk · 手動送信",
    manualBody: "このモードには専用の Codex Zero Risk コネクタが必要です。準備されたプロンプトをコピーし、ChatGPT でコネクタ・モデル・推論強度を選択して、自分で貼り付けて送信します。設定で操作モードを変更し、対応する MCP ガイドを完了してください。",
    trouble: "うまく動かないとき",
    questions: [
      { title: "Web モデルが見つからない", body: "セットアップでモデルのインストールを確認し、Codex を完全に再起動してください。Orca では新しいセッションかターミナルを開きます。独自の CODEX_HOME を使う場合は、モデルをインストールした設定を読み込んでいるか確認してください。" },
      { title: "応答はあるがツールが動かない", body: "MCP でランタイム検証を実行します。Codex Native2 が同じ ChatGPT ワークスペースに接続され、すべてのアクションが許可され、トンネルが動作しているか確認してください。検証は接続状態を確認するため、実際のツール操作は Codex の小さなタスクで試してください。" },
      { title: "タスクが止まる・ログインが切れた", body: "ブラウザーでアカウントを確認し、設定で診断を実行してアクティビティを確認します。設定からブラウザーのターンを取り消せます。Web タスク中はランチャーを起動したままにしてください。" },
    ],
    docs: "リポジトリのドキュメント",
    readme: "使い方ガイド",
    troubleshooting: "トラブルシューティング",
  },
};

export function helpCopyFor(language: Language) {
  return guides[language];
}

export function HelpContent({ copy, language, navigate, openDocument }: {
  copy: Copy;
  language: Language;
  navigate: (surface: Surface) => void;
  openDocument: (file: "README.md" | "TROUBLESHOOTING.md") => void;
}) {
  const guide = helpCopyFor(language);
  return (
    <div className="help-content">
      <section aria-labelledby="help-start">
        <h2 id="help-start">{guide.start}</h2>
        <ol className="help-steps">
          {guide.steps.map((step, index) => (
            <li key={step.title}>
              <span className="setup-index" aria-hidden="true">{index + 1}</span>
              <div><h3>{step.title}</h3><p>{step.body}</p></div>
            </li>
          ))}
        </ol>
        <div className="help-actions">
          {(["browser", "setup", "mcp"] as const).map((surface) => (
            <button className="button-secondary" key={surface} onClick={() => navigate(surface)} type="button">
              <Icon name={surface} />{surface === "mcp" ? "MCP" : copy[surface]}
            </button>
          ))}
        </div>
      </section>
      <section aria-labelledby="help-clients">
        <h2 id="help-clients">{guide.clients}</h2>
        <div className="help-client-grid">
          <article><h3>{guide.codex}</h3><p>{guide.codexBody}</p><pre><code>codex --profile gpt -m chatgpt-web/high</code></pre></article>
          <article><h3>Orca</h3><p>{guide.orcaBody}</p></article>
        </div>
        <h3>{guide.models}</h3><p>{guide.modelsBody}</p>
      </section>
      <section aria-labelledby="help-tools">
        <h2 id="help-tools">{guide.tools}</h2>
        <h3>{guide.full}</h3><p>{guide.fullBody}</p><p className="help-note">{guide.permission}</p>
        <h3>{guide.browserOnly}</h3><p>{guide.browserOnlyBody}</p>
        <h3>{guide.manual}</h3><p>{guide.manualBody}</p>
      </section>
      <section aria-labelledby="help-trouble">
        <h2 id="help-trouble">{guide.trouble}</h2>
        {guide.questions.map((question) => (
          <details key={question.title}><summary>{question.title}</summary><p>{question.body}</p></details>
        ))}
        <div className="help-actions">
          <button className="button-secondary" onClick={() => navigate("settings")} type="button"><Icon name="settings" />{copy.settings}</button>
          <button className="button-secondary" onClick={() => navigate("activity")} type="button"><Icon name="activity" />{copy.activity}</button>
        </div>
      </section>
      <footer>
        <h2>{guide.docs}</h2>
        <div className="help-actions">
          <button className="button-secondary" onClick={() => openDocument("README.md")} type="button">{guide.readme}<Icon name="external" /></button>
          <button className="button-secondary" onClick={() => openDocument("TROUBLESHOOTING.md")} type="button">{guide.troubleshooting}<Icon name="external" /></button>
        </div>
      </footer>
    </div>
  );
}
