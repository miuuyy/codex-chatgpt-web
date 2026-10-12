<p align="center">
  <img src="assets/readme/hero.svg" width="960" alt="Use modelos Web. Continue no Codex. Seu plano do ChatGPT. Seu fluxo de trabalho. Máxima capacidade.">
</p>

<p align="center">
  <a href="https://github.com/miuuyy/codex-chatgpt-web/releases/download/v6.1.8/codex-web-gpt-6.1.8-win-x64.exe"><img src="assets/readme/download-windows.svg" width="224" height="64" alt="Windows · x64"></a>&nbsp;
  <a href="https://github.com/miuuyy/codex-chatgpt-web/releases/download/v6.1.8/codex-web-gpt-6.1.8-mac-arm64.dmg"><img src="assets/readme/download-macos.svg" width="224" height="64" alt="macOS · Apple silicon"></a>&nbsp;
  <a href="https://github.com/miuuyy/codex-chatgpt-web/releases/download/v6.1.8/codex-web-gpt-6.1.8-linux-x64.AppImage"><img src="assets/readme/download-linux.svg" width="224" height="64" alt="Linux · x64"></a>
</p>

<p align="center">
  <a href="https://github.com/miuuyy/codex-chatgpt-web/releases/download/v6.1.8/codex-web-gpt-6.1.8-mac-x64.dmg">macOS Intel</a> · <a href="https://github.com/miuuyy/codex-chatgpt-web/releases/latest">Todas as versões</a>
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a> · <a href="README.pt-BR.md">Português (Brasil)</a>
</p>

<p align="center">
  <img src="assets/demo.gif" width="960" alt="Um turno ao vivo do ChatGPT Web usando o ambiente nativo do Codex">
</p>

<p align="center">
  <a href="#get-started">Primeiros passos</a> · <a href="https://github.com/miuuyy/codex-chatgpt-web/releases">Novidades</a> · <a href="docs/architecture.md">Arquitetura</a> · <a href="TROUBLESHOOTING.md">Solução de problemas</a>
</p>

Use os modelos do ChatGPT Web disponíveis na sua conta, incluindo Pro, no seletor de modelos nativo do Codex — com os limites de uso separados do ChatGPT Web, sem consumir sua cota do Work ou do Codex. Mantenha a mesma interface, tarefas, imagens e transmissão de respostas.

O modo Full harness conecta o ChatGPT aos arquivos, terminal, ferramentas e aprovações da tarefa atual por meio de MCP. As conversas permanecem vinculadas à sua tarefa do Codex, para que você possa continuar trabalhando conforme o contexto aumenta.

<div id="get-started"><a id="quick-start"></a></div>

## Primeiros passos

**Modelos disponíveis:** Free/Go → **Luna / Think**. Contas pagas → **GPT-6 Sol** e **GPT-5.6 Sol**, com **Instant–High**, além de **Extra High** e **Pro** quando disponíveis. Cada versão tem sua própria entrada; conversas existentes com GPT-5.6 continuam usando GPT-5.6. A disponibilidade depende da sua conta e do espaço de trabalho.

1. **Instale o inicializador** usando o download para seu sistema acima.
2. **Entre no ChatGPT** no navegador integrado e execute o teste rápido do navegador.
3. **Instale os modelos** e reinicie o Codex uma vez. No modo automático, escolha um modelo cujo nome termine em **(Web)**. As versões Pro têm entradas separadas; o raciocínio Sol é selecionado em Effort. Zero Risk mantém sua entrada dedicada.
4. **Para programar com ferramentas**, abra **MCP** no inicializador e conclua a configuração de Full harness abaixo.

O aplicativo inclui seu navegador e ambiente de execução. Não é necessário instalar Chrome, Node ou Bun separadamente.

<details>
<summary><strong>Instalação pelo terminal, atualizações e reparo</strong></summary>

Feche o inicializador antes de atualizar. Estes instaladores selecionam a plataforma e a arquitetura, verificam as somas de verificação publicadas e preservam seu perfil do ChatGPT e as configurações do inicializador.

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
<summary><strong>Modelos, modos e configuração de MCP</strong></summary>

<a id="modes"></a>

Os modos automáticos oferecem Luna/Think quando a conta não tem um seletor de raciocínio; caso contrário, oferecem Instant–High, com Extra High e Pro disponíveis de forma independente quando oferecidos pela conta.

| Modo | Envio de mensagens | Ferramentas locais do Codex |
| --- | --- | --- |
| **Somente navegador** | Automático | Não |
| **Full harness (com automação)** | Automático | Sim, por meio de MCP |
| **Zero Risk** | Cole e envie manualmente | Sim, por meio de um conector MCP separado |

Zero Risk não lê nem opera a página do ChatGPT. Escolha o modelo e o conector `Codex Zero Risk`, cole e envie o prompt preparado e confirme **Enviado** no inicializador. Os modelos automáticos cujo nome termina em **(Web)** exibem as opções de Effort compatíveis no Codex. Instant e cada versão Pro têm entradas separadas para preservar seus limites de contexto; entradas de modelos salvas anteriormente mantêm seu modo fixo original.

<a id="full-harness"></a>

### Full harness

O modo completo conecta as chamadas de ferramentas do ChatGPT à tarefa atual do Codex por meio do
[OpenAI tunnel-client](https://github.com/openai/tunnel-client) oficial. O túnel usa conexões de saída: não
expõe um IP público, não abre uma porta de entrada nem exige encaminhamento no roteador.

A página **MCP** do inicializador orienta toda a configuração. Para ver os cliques exatos, consulte os
[tutoriais em vídeo](TROUBLESHOOTING.md).

> **Limites**
>
> Consulte [Limites](https://github.com/miuuyy/codex-chatgpt-web/discussions/309) para saber os limites atuais
> de mensagens do ChatGPT para **GPT-5.6 Sol Pro** e **GPT-6 Astra**. Os limites de contexto dependem do
> tipo de conta e do esforço selecionado. Plus Medium/High usa uma janela medida de 90.000 tokens.
> GPT-5.6 oferece até 270.000 tokens com o **Bigger Context (3×)** experimental ativado, com suporte à
> compactação nativa do Codex em todos os casos.
>
> GPT-6 Sol oferece Bigger Context em Medium, High e Extra High quando disponível: **120.000 tokens
> no Plus**, com compactação em **110.000**, e **240.000 no Pro**, com compactação em **220.000**.
> GPT-6 Instant usa o contexto padrão.
> GPT-5.6 e GPT-6 Pro mantêm seus limites existentes de Bigger Context.

1. Conclua a configuração necessária, abra **MCP**, crie o Tunnel e a chave de API comum e pressione
   **Conectar ambiente**.
2. Ative o **Modo de desenvolvedor** do ChatGPT e crie um novo conector Tunnel com o nome exato
   **Codex Native2**, com **Authentication: None** e **Allow all actions**.
3. Execute **Verificar ambiente** para confirmar que **Codex Native2** está conectado e disponível.

As ações de escrita/modificação também exigem que o espaço de trabalho do ChatGPT e a política de seu administrador
as permitam. Consulte
[modo de desenvolvedor e aplicativos MCP](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt).
Solicitações de aprovação inesperadas bloqueiam a operação, a menos que `--auto-approve-tool-calls` seja ativado explicitamente;
essa opção clica em **Allow once**, nunca concede uma autorização permanente.

</details>

<details>
<summary><strong>Diagnósticos e subagentes</strong></summary>

<a id="operations"></a>

Use **Atividade** para diagnósticos locais seguros e **Configurações → Executar diagnóstico** para verificar o funcionamento de ponta a ponta.
As configurações também permitem cancelar uma interação retida no navegador ou remover a integração com o Codex antes da desinstalação.
**Salvar conversas no ChatGPT** mantém as conversas das tarefas no histórico do ChatGPT. Desativado por padrão; independente de **Nova conversa no navegador a cada turno**.
Defina `CODEX_CHATGPT_WEB_BROWSER_DIAGNOSTICS=1` somente quando cada ponto de verificação do navegador precisar de uma captura de tela.

Novas instalações usam **Compatibility V1** para subagentes entre diferentes backends. **Native** preserva as
configurações de recursos do próprio Codex e habilita a delegação Web-to-Web V2 em texto simples. Reinicie o Codex e inicie uma nova tarefa
após alterar o protocolo:

```bash
codex-chatgpt-web subagents status
codex-chatgpt-web subagents compatibility-v1
codex-chatgpt-web subagents native
```

</details>

<details>
<summary><strong>Requisitos e segurança</strong></summary>

<a id="limitations-and-security"></a>

- Esta é uma automação de navegador não oficial, não uma API da OpenAI. Mudanças na interface do ChatGPT podem invalidar os seletores;
  divergências geram falhas explícitas em vez de trocar silenciosamente o modelo ou o transporte.
- O estado do navegador contém dados sensíveis de login, e processos executados pelo mesmo usuário local
  podem acessar o serviço que escuta na interface de loopback. Nunca compartilhe o perfil do inicializador; use uma estação de trabalho confiável.
- Os pacotes de distribuição atualmente atendem macOS 13+ (arm64/x64), Windows x64 e Linux x64. O ambiente de execução,
  os testes e o empacotamento precisam passar na CI das três plataformas; os fluxos de navegador e MCP vinculados à conta usam a
  [validação de versões](docs/release-validation.md) separada.
- As compilações ainda não têm assinatura de plataforma, então Gatekeeper ou SmartScreen podem exibir avisos. Os instaladores verificam
  o manifesto SHA-256 publicado antes da instalação.

Leia a [arquitetura](docs/architecture.md) completa e o
[modelo de segurança](docs/security-model.md) antes de ativar o modo completo. Relate vulnerabilidades por meio de
[SECURITY.md](SECURITY.md).

A conversa temporária é um [modo de privacidade do ChatGPT](https://help.openai.com/en/articles/8914046-temporary-chat-faq); os prompts ainda são processados pela OpenAI.

Cobertura de validação: [validação de versões](docs/release-validation.md).

Este software é independente e não é afiliado à OpenAI nem endossado por ela. Use-o somente com
sua própria conta e de acordo com os [Termos de Uso](https://openai.com/policies/terms-of-use/)
e as políticas do espaço de trabalho; ele não contorna autenticação nem controles de acesso.

</details>

<details>
<summary><strong>Executar a partir do código-fonte e desenvolver</strong></summary>

<a id="development"></a>

```bash
git clone https://github.com/miuuyy/codex-chatgpt-web.git && \
cd codex-chatgpt-web && \
bun run app
```

A execução a partir do código-fonte exige Bun 1.4.0. O comando instala as dependências nas versões fixadas e abre o aplicativo.

```bash
bun run app
bun run dev:launcher
bun run src/cli.ts dev status
bun run dev:chat compaction-lab "Reply with exactly: DEV READY"
bun run verify
bun run smoke:subagents
bun run app:package
```

`dev:launcher` usa um perfil e uma conta separados em `~/.codex-chatgpt-web-dev`. `dev:chat` exercita os fluxos reais de navegador e compactação com resultados de ferramentas explicitamente simulados, sem alterar sua rota normal do Codex. Consulte o [ambiente de testes de chat DEV](docs/dev-chat.md) para a configuração e os comandos.

</details>

<a id="star-history"></a>

## Histórico de estrelas

<a href="https://www.star-history.com/?repos=miuuyy%2Fcodex-chatgpt-web&type=date&legend=top-left">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=miuuyy/codex-chatgpt-web&type=date&theme=dark&legend=top-left&sealed_token=hBVvg_eOjfMFDrfyeo5FPQkIwcvBEmXc6F7ZoOKnfFE4KPCs67o34w4XwVuM-bHGnKR-SKCAN_TSTWrzuqSBNU-RjNZCLT4f-xNs9qcDhciQtemxHKuuFj0N5YNqZIihdaQfakrh2ANhOrvP0K2LmLXX2zbsYyVaYZknyTnlYeIS_mOGvMcO32ZmPCHK">
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=miuuyy/codex-chatgpt-web&type=date&legend=top-left&sealed_token=hBVvg_eOjfMFDrfyeo5FPQkIwcvBEmXc6F7ZoOKnfFE4KPCs67o34w4XwVuM-bHGnKR-SKCAN_TSTWrzuqSBNU-RjNZCLT4f-xNs9qcDhciQtemxHKuuFj0N5YNqZIihdaQfakrh2ANhOrvP0K2LmLXX2zbsYyVaYZknyTnlYeIS_mOGvMcO32ZmPCHK">
    <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=miuuyy/codex-chatgpt-web&type=date&legend=top-left&sealed_token=hBVvg_eOjfMFDrfyeo5FPQkIwcvBEmXc6F7ZoOKnfFE4KPCs67o34w4XwVuM-bHGnKR-SKCAN_TSTWrzuqSBNU-RjNZCLT4f-xNs9qcDhciQtemxHKuuFj0N5YNqZIihdaQfakrh2ANhOrvP0K2LmLXX2zbsYyVaYZknyTnlYeIS_mOGvMcO32ZmPCHK">
  </picture>
</a>

---

[Solução de problemas](TROUBLESHOOTING.md) · [Segurança](SECURITY.md) · [Como contribuir](CONTRIBUTING.md) · [Licença MIT](LICENSE) · [CI](https://github.com/miuuyy/codex-chatgpt-web/actions/workflows/ci.yml)

Também de minha autoria: <img src="assets/readme/persona-voice.svg" width="20" height="20" alt=""> [ChatGPT Persona Voice](https://github.com/miuuyy/ChatGPT-Persona-Voice) — vozes personalizadas locais, quase em tempo real, para ChatGPT e Codex.
