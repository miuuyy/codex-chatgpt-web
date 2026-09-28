# Reiniciar o Codex com a correção local (WSL Ubuntu)

Este guia ativa a versão corrigida do **Codex Web GPT** que já foi compilada e instalada no seu WSL. **Não precisa clonar, compilar, refazer o login nem configurar o MCP novamente.**

> **Importante:** encerrar o Codex interrompe todas as tarefas em execução. Salve seu trabalho e termine as conversas ativas antes de seguir.

## 1. Feche os aplicativos

1. Feche o **Codex** (inclusive o aplicativo no Windows, se estiver usando).
2. No ícone do **Codex Web GPT** na bandeja do sistema, escolha **Quit / Sair**. Apenas fechar a janela pode deixá-lo rodando em segundo plano.
3. Abra **um terminal novo** do Ubuntu no WSL para executar os próximos comandos.

## 2. Encerre processos restantes no WSL

Execute no terminal novo:

```bash
# Codex CLI e seus processos Linux
pkill -TERM -x codex 2>/dev/null || true
pkill -TERM -f '[c]odex-linux' 2>/dev/null || true

# Launcher e runtime do Codex Web GPT
pkill -TERM -f '[c]odex-chatgpt-web' 2>/dev/null || true
pkill -TERM -f '[c]odex-web-gpt' 2>/dev/null || true
```

Esses comandos podem encerrar outras sessões do Codex abertas no WSL. Eles **não fecham** o aplicativo do Codex que esteja rodando diretamente no Windows; feche-o pela interface.

## 3. Confirme que a porta antiga está livre

```bash
ss -ltnp '( sport = :17841 )'
```

**Esperado:** nenhuma linha com `LISTEN`. Caso apareça, confira se o Codex Web GPT foi realmente encerrado pela bandeja do sistema. Não inicie um segundo launcher sobre o primeiro.

## 4. Confira que o launcher aponta para a versão corrigida

```bash
grep 'CODEX_WEB_GPT_APPIMAGE=' ~/.local/bin/codex-web-gpt
```

O caminho exibido deve conter **`6.1.3-local-fix`**. O AppImage corrigido está instalado em:

```text
~/.local/lib/codex-web-gpt/6.1.3-local-fix/Codex Web GPT.AppImage
```

## 5. Inicie o launcher corrigido

```bash
~/.local/bin/codex-web-gpt
```

Depois que a janela do **Codex Web GPT** abrir e o bridge estiver pronto, abra o **Codex** normalmente. Suas configurações e o MCP existentes continuam os mesmos.

Para verificar o bridge no WSL:

```bash
curl -fsS http://127.0.0.1:17841/healthz
```

Procure `"status":"ok"`. **A versão ainda aparece como `6.1.3`**: isso é esperado, pois a correção foi compilada em cima dessa versão. A identificação da versão corrigida é o caminho `6.1.3-local-fix` do passo 4.

## 6. Se quiser voltar à versão original (rollback)

Primeiro, feche o Codex e saia do Codex Web GPT pela bandeja do sistema. Depois execute:

```bash
install -m 0755 \
  ~/.local/bin/codex-web-gpt.original-6.1.3 \
  ~/.local/bin/codex-web-gpt

~/.local/bin/codex-web-gpt
```

Esse procedimento restaura o atalho para o AppImage oficial que foi preservado em `~/.local/lib/codex-web-gpt/6.1.3/`.

---

**Estado da correção:** a compilação, a checagem TypeScript e o empacotamento passaram. O teste de regressão automatizado ainda não foi concluído; será preciso confirmar em uso real que o problema do prompt duplicado não retorna.
