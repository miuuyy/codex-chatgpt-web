<p align="center">
  <img src="assets/readme/hero.svg" width="960" alt="Переключайтесь на веб-модели и оставайтесь в Codex. Ваш план ChatGPT. Ваш рабочий процесс. Максимальные возможности.">
</p>

<p align="center">
  <a href="https://github.com/miuuyy/codex-chatgpt-web/releases/download/v5.0.8/codex-web-gpt-5.0.8-win-x64.exe"><img src="assets/readme/download-windows.svg" width="224" height="64" alt="Windows · x64"></a>&nbsp;
  <a href="https://github.com/miuuyy/codex-chatgpt-web/releases/download/v5.0.8/codex-web-gpt-5.0.8-mac-arm64.dmg"><img src="assets/readme/download-macos.svg" width="224" height="64" alt="macOS · Apple silicon"></a>&nbsp;
  <a href="https://github.com/miuuyy/codex-chatgpt-web/releases/download/v5.0.8/codex-web-gpt-5.0.8-linux-x64.AppImage"><img src="assets/readme/download-linux.svg" width="224" height="64" alt="Linux · x64"></a>
</p>

<p align="center">
  <a href="https://github.com/miuuyy/codex-chatgpt-web/releases/download/v5.0.8/codex-web-gpt-5.0.8-mac-x64.dmg">macOS Intel</a> · <a href="https://github.com/miuuyy/codex-chatgpt-web/releases/latest">Все релизы</a>
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.ru.md">Русский</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a>
</p>

<p align="center">
  <img src="assets/demo.gif" width="960" alt="Запрос ChatGPT Web в реальном времени через нативную среду Codex">
</p>

<p align="center">
  <a href="#get-started">Начало работы</a> · <a href="https://github.com/miuuyy/codex-chatgpt-web/releases">Что нового</a> · <a href="docs/architecture.md">Архитектура</a> · <a href="TROUBLESHOOTING.md">Устранение неполадок</a>
</p>

Используйте доступные вашему аккаунту модели ChatGPT Web, включая Pro, прямо из нативного выбора моделей Codex — с отдельными лимитами ChatGPT Web и без расходования квоты Work или Codex. Интерфейс, задачи, изображения и потоковая выдача остаются прежними.

Режим Full harness подключает ChatGPT к файлам, терминалу, инструментам и подтверждениям текущей задачи через MCP. Диалоги остаются привязаны к задаче Codex, поэтому работу можно продолжать по мере роста контекста.

<div id="get-started"><a id="quick-start"></a></div>

## Начало работы

**Доступные модели:** Free/Go → **Luna / Think**. Аккаунты с настройками уровня рассуждения → **Instant–High**, а также **Extra High** и **Pro**, если они доступны. Лаунчер сам определяет возможности вашего аккаунта.

1. **Установите лаунчер** с помощью загрузки для вашей системы выше.
2. **Войдите в ChatGPT** во встроенном браузере и запустите smoke-тест браузера.
3. **Установите модели**, один раз перезапустите Codex и выберите модель **ChatGPT Web — …**.
4. **Для разработки с инструментами** откройте **MCP** в лаунчере и завершите настройку Full harness ниже.

Приложение уже включает браузер и среду выполнения. Отдельно устанавливать Chrome, Node или Bun не требуется.

<details>
<summary><strong>Установка, обновление и восстановление через терминал</strong></summary>

Перед обновлением закройте лаунчер. Эти установщики определяют платформу и архитектуру, проверяют опубликованные контрольные суммы и сохраняют ваш профиль ChatGPT и настройки лаунчера.

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
<summary><strong>Модели, режимы и настройка MCP</strong></summary>

<a id="modes"></a>

Автоматические режимы предлагают Luna/Think, если в аккаунте нет выбора уровня рассуждения; иначе доступны Instant–High, а Extra High и Pro появляются независимо, когда они доступны аккаунту.

| Режим | Отправка сообщений | Локальные инструменты Codex |
| --- | --- | --- |
| **Browser-only** | Автоматически | Нет |
| **Full harness (With Automation)** | Автоматически | Да, через MCP |
| **Zero Risk** | Вставка и отправка вручную | Да, через отдельный MCP-коннектор |

Zero Risk не читает страницу ChatGPT и не управляет ею. Самостоятельно выберите модель и коннектор `Codex Zero Risk`, вставьте и отправьте подготовленный промпт, затем подтвердите **Sent** в лаунчере. Каждая автоматическая запись модели выбирает фиксированный режим ChatGPT; строки Effort и Speed в Codex его не переопределяют.

<a id="full-harness"></a>

### Full harness

Full mode подключает вызовы инструментов ChatGPT обратно к текущей задаче Codex через официальный
[OpenAI tunnel-client](https://github.com/openai/tunnel-client). Туннель работает исходящим соединением: он не
публикует внешний IP, не открывает входящий порт и не требует проброса портов на роутере.

Страница **MCP** в лаунчере проведёт вас через всю настройку. Точные шаги показаны в
[видеоинструкциях](TROUBLESHOOTING.md).

> **Лимиты**
>
> Актуальные лимиты сообщений ChatGPT для **GPT-5.6 Sol Pro** и **GPT-6 Astra** смотрите в разделе
> [Limits](https://github.com/miuuyy/codex-chatgpt-web/discussions/309). Лимиты контекста зависят от
> типа аккаунта и выбранного уровня рассуждения. Plus Medium/High использует измеренное окно в 90 000 токенов или
> до 270 000 токенов при включённом экспериментальном **3× context**, при этом нативный compaction Codex
> поддерживается на всём пути.

1. Завершите обязательную настройку, откройте **MCP**, создайте Tunnel и обычный API-ключ, затем нажмите
   **Connect harness**.
2. Включите в ChatGPT **Developer Mode** и создайте новый Tunnel-коннектор с точным именем
   **Codex Native2**, параметрами **Authentication: None** и **Allow all actions**.
3. Запустите **Verify runtime**, чтобы подтвердить, что **Codex Native2** подключён и доступен.

Действия записи и изменения также требуют, чтобы рабочее пространство ChatGPT и политика его администратора разрешали
их. Подробнее:
[developer mode and MCP apps](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt).
Неожиданные запросы подтверждения завершаются с ошибкой, если явно не включён `--auto-approve-tool-calls`;
эта опция нажимает **Allow once** и никогда не выдаёт постоянное разрешение.

</details>

<details>
<summary><strong>Диагностика и субагенты</strong></summary>

<a id="operations"></a>

Используйте **Activity** для безопасной локальной диагностики и **Settings → Run doctor** для сквозной проверки состояния.
В настройках также можно отменить удерживаемый браузерный запрос или удалить интеграцию Codex перед деинсталляцией.
Устанавливайте `CODEX_CHATGPT_WEB_BROWSER_DIAGNOSTICS=1` только когда для каждой контрольной точки браузера нужен снимок экрана.

Новые установки используют **Compatibility V1** для субагентов между разными backend-средами. **Native** сохраняет собственные
настройки функций Codex и включает делегирование Web-to-Web V2 в обычном текстовом виде. После изменения протокола
перезапустите Codex и начните новую задачу:

```bash
codex-chatgpt-web subagents status
codex-chatgpt-web subagents compatibility-v1
codex-chatgpt-web subagents native
```

</details>

<details>
<summary><strong>Требования и безопасность</strong></summary>

<a id="limitations-and-security"></a>

- Это неофициальная автоматизация браузера, а не OpenAI API. Изменения интерфейса ChatGPT могут сломать селекторы;
  рассинхронизация приводит к явной ошибке вместо незаметного переключения модели или транспорта.
- Состояние браузера — чувствительный артефакт авторизации, а loopback listener доступен процессам,
  работающим от того же локального пользователя. Никогда не передавайте профиль лаунчера другим; используйте доверенную рабочую станцию.
- Релизные пакеты сейчас рассчитаны на macOS 13+ (arm64/x64), Windows x64 и Linux x64. Runtime,
  тесты и упаковка проверяются на всех трёх платформах в CI; браузерные и MCP-сценарии, зависящие от аккаунта, используют
  отдельную [release validation](docs/release-validation.md).
- Сборки пока не подписаны для платформ, поэтому Gatekeeper или SmartScreen могут показывать предупреждение. Установщики проверяют
  опубликованный SHA-256 manifest перед установкой.

Перед включением Full mode прочитайте полные документы по [архитектуре](docs/architecture.md) и
[модели безопасности](docs/security-model.md). Сообщайте об уязвимостях через
[SECURITY.md](SECURITY.md).

Temporary Chat — это [режим конфиденциальности ChatGPT](https://help.openai.com/en/articles/8914046-temporary-chat-faq); промпты всё равно обрабатываются OpenAI.

Покрытие проверками: [release validation](docs/release-validation.md).

Это независимое программное обеспечение, не связанное с OpenAI и не одобренное OpenAI. Используйте его только со
своим аккаунтом и в соответствии с применимыми [Terms of Use](https://openai.com/policies/terms-of-use/)
и политиками рабочего пространства; оно не обходит аутентификацию или контроль доступа.

</details>

<details>
<summary><strong>Запуск из исходников и разработка</strong></summary>

<a id="development"></a>

```bash
git clone https://github.com/miuuyy/codex-chatgpt-web.git && \
cd codex-chatgpt-web && \
bun run app
```

Для запуска из исходников требуется Bun 1.4.0. Команда устанавливает зафиксированные зависимости и открывает приложение.

```bash
bun run app
bun run dev:launcher
bun run src/cli.ts dev status
bun run dev:chat compaction-lab "Reply with exactly: DEV READY"
bun run verify
bun run smoke:subagents
bun run app:package
```

`dev:launcher` использует отдельный профиль и аккаунт в `~/.codex-chatgpt-web-dev`. `dev:chat` проверяет реальные браузерные и compaction-сценарии с явными симулированными результатами инструментов, не изменяя обычный маршрут Codex. Настройка и команды описаны в [DEV chat harness](docs/dev-chat.md).

</details>

## История звёзд

<a href="https://www.star-history.com/?repos=miuuyy%2Fcodex-chatgpt-web&type=date&legend=top-left">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=miuuyy/codex-chatgpt-web&type=date&theme=dark&legend=top-left&sealed_token=hBVvg_eOjfMFDrfyeo5FPQkIwcvBEmXc6F7ZoOKnfFE4KPCs67o34w4XwVuM-bHGnKR-SKCAN_TSTWrzuqSBNU-RjNZCLT4f-xNs9qcDhciQtemxHKuuFj0N5YNqZIihdaQfakrh2ANhOrvP0K2LmLXX2zbsYyVaYZknyTnlYeIS_mOGvMcO32ZmPCHK">
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=miuuyy/codex-chatgpt-web&type=date&legend=top-left&sealed_token=hBVvg_eOjfMFDrfyeo5FPQkIwcvBEmXc6F7ZoOKnfFE4KPCs67o34w4XwVuM-bHGnKR-SKCAN_TSTWrzuqSBNU-RjNZCLT4f-xNs9qcDhciQtemxHKuuFj0N5YNqZIihdaQfakrh2ANhOrvP0K2LmLXX2zbsYyVaYZknyTnlYeIS_mOGvMcO32ZmPCHK">
    <img alt="График истории звёзд" src="https://api.star-history.com/chart?repos=miuuyy/codex-chatgpt-web&type=date&legend=top-left&sealed_token=hBVvg_eOjfMFDrfyeo5FPQkIwcvBEmXc6F7ZoOKnfFE4KPCs67o34w4XwVuM-bHGnKR-SKCAN_TSTWrzuqSBNU-RjNZCLT4f-xNs9qcDhciQtemxHKuuFj0N5YNqZIihdaQfakrh2ANhOrvP0K2LmLXX2zbsYyVaYZknyTnlYeIS_mOGvMcO32ZmPCHK">
  </picture>
</a>

---

[Устранение неполадок](TROUBLESHOOTING.md) · [Безопасность](SECURITY.md) · [Участие в разработке](CONTRIBUTING.md) · [Лицензия MIT](LICENSE) · [CI](https://github.com/miuuyy/codex-chatgpt-web/actions/workflows/ci.yml)

Другой мой проект: <img src="assets/readme/persona-voice.svg" width="20" height="20" alt=""> [ChatGPT Persona Voice](https://github.com/miuuyy/ChatGPT-Persona-Voice) — локальные пользовательские голоса почти в реальном времени для ChatGPT и Codex.
