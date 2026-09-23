<p align="center">
  <img src="assets/readme/hero.svg" width="960" alt="Passez aux modèles web. Restez dans Codex. Votre abonnement ChatGPT, votre façon de travailler, toutes les fonctionnalités.">
</p>

<p align="center">
  <a href="https://github.com/miuuyy/codex-chatgpt-web/releases/download/v6.0.0/codex-web-gpt-6.0.0-win-x64.exe"><img src="assets/readme/download-windows.svg" width="224" height="64" alt="Windows · x64"></a>&nbsp;
  <a href="https://github.com/miuuyy/codex-chatgpt-web/releases/download/v6.0.0/codex-web-gpt-6.0.0-mac-arm64.dmg"><img src="assets/readme/download-macos.svg" width="224" height="64" alt="macOS · Apple silicon"></a>&nbsp;
  <a href="https://github.com/miuuyy/codex-chatgpt-web/releases/download/v6.0.0/codex-web-gpt-6.0.0-linux-x64.AppImage"><img src="assets/readme/download-linux.svg" width="224" height="64" alt="Linux · x64"></a>
</p>

<p align="center">
  <a href="https://github.com/miuuyy/codex-chatgpt-web/releases/download/v6.0.0/codex-web-gpt-6.0.0-mac-x64.dmg">macOS Intel</a> · <a href="https://github.com/miuuyy/codex-chatgpt-web/releases/latest">Toutes les versions</a>
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.fr.md">Français</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a>
</p>

<p align="center">
  <img src="assets/demo.gif" width="960" alt="Un tour ChatGPT Web exécuté avec l’environnement natif de Codex">
</p>

<p align="center">
  <a href="#get-started">Premiers pas</a> · <a href="https://github.com/miuuyy/codex-chatgpt-web/releases">Nouveautés</a> · <a href="docs/architecture.md">Architecture</a> · <a href="TROUBLESHOOTING.md">Dépannage</a>
</p>

Utilisez les modèles ChatGPT Web disponibles sur votre compte, y compris Pro, depuis le sélecteur natif de Codex. Les limites d’utilisation de ChatGPT Web sont distinctes de votre quota Work ou Codex. Vous conservez la même interface, vos tâches, vos images et les réponses en continu.

Le mode complet relie ChatGPT aux fichiers, au terminal, aux outils et aux autorisations de la tâche en cours grâce à MCP. Les conversations restent associées à votre tâche Codex pour continuer à travailler lorsque le contexte s’allonge.

<div id="get-started"><a id="quick-start"></a></div>

## Premiers pas

**Modèles disponibles :** Free/Go → **Luna / Think**. Comptes disposant du réglage du raisonnement → **Instant–High**, ainsi que **Extra High** et **Pro** lorsqu’ils sont disponibles. Le lanceur détecte les fonctionnalités accessibles à votre compte.

1. **Installez le lanceur** avec le téléchargement correspondant à votre système ci-dessus.
2. **Connectez-vous à ChatGPT** dans le navigateur intégré, puis lancez le test de fonctionnement du navigateur.
3. **Installez les modèles**, puis redémarrez Codex une fois. En mode automatique, choisissez un modèle dont le nom se termine par **(Web)**. Chaque version Pro possède sa propre entrée ; le raisonnement de Sol se règle avec l’effort. Le mode Sans risque conserve son entrée dédiée.
4. **Pour programmer avec les outils**, ouvrez **MCP** dans le lanceur et terminez la configuration du mode complet décrite ci-dessous.

L’application comprend son navigateur et son moteur d’exécution. Il n’est pas nécessaire d’installer Chrome, Node ou Bun séparément.

<details>
<summary><strong>Installation, mises à jour et réparation depuis le terminal</strong></summary>

Quittez le lanceur avant la mise à jour. Ces programmes d’installation sélectionnent la plateforme et l’architecture, vérifient les sommes de contrôle publiées et préservent votre profil ChatGPT ainsi que les paramètres du lanceur.

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
<summary><strong>Modèles, modes et configuration MCP</strong></summary>

<a id="modes"></a>

Les modes automatiques proposent Luna/Think lorsque le compte ne possède pas de sélecteur de raisonnement. Sinon, ils proposent Instant–High, avec Extra High et Pro disponibles indépendamment si le compte y donne accès.

| Mode | Envoi des messages | Outils Codex locaux |
| --- | --- | --- |
| **Navigateur seul** | Automatique | Non |
| **Mode complet (avec automatisation)** | Automatique | Oui, via MCP |
| **Sans risque** | Copier-coller et envoi manuels | Oui, via un connecteur MCP distinct |

Le mode Sans risque ne lit ni ne manipule la page ChatGPT. Choisissez vous-même le modèle et le connecteur `Codex Zero Risk`, collez et envoyez le message préparé, puis confirmez avec **Envoyé** dans le lanceur. Les modèles automatiques dont le nom se termine par **(Web)** proposent dans Codex les niveaux d’effort qu’ils prennent en charge. Instant et chaque version Pro possèdent des entrées distinctes afin de préserver leurs capacités de contexte ; les anciennes entrées enregistrées conservent leur mode fixe d’origine.

<a id="full-harness"></a>

### Mode complet

Le mode complet relie les appels d’outils de ChatGPT à la tâche Codex en cours au moyen du client officiel
[OpenAI tunnel-client](https://github.com/openai/tunnel-client). Le tunnel établit une connexion sortante :
il n’expose pas d’adresse IP publique, n’ouvre pas de port entrant et ne nécessite aucune redirection sur le routeur.

La page **MCP** du lanceur vous accompagne pendant toute la configuration. Pour suivre les étapes à l’écran, consultez les
[tutoriels vidéo](TROUBLESHOOTING.md).

> **Limites**
>
> Consultez les [limites](https://github.com/miuuyy/codex-chatgpt-web/discussions/309) pour connaître les quotas actuels
> de messages ChatGPT pour **GPT-5.6 Sol Pro** et **GPT-6 Astra**. La taille du contexte dépend
> du type de compte et de l’effort sélectionné. Pour Plus Medium/High, la fenêtre mesurée est de 90 000 jetons,
> ou jusqu’à 270 000 jetons avec le **contexte ×3** expérimental activé. La réduction native
> du contexte par Codex reste prise en charge dans tous les cas.

1. Terminez la configuration requise, ouvrez **MCP**, créez le tunnel et une clé API standard, puis cliquez
   sur **Connecter l’environnement d’exécution**.
2. Activez le **mode développeur** de ChatGPT et créez un nouveau connecteur de tunnel nommé exactement
   **Codex Native2**, avec **Authentication: None** (aucune authentification) et **Allow all actions** (autoriser toutes les actions).
3. Lancez **Vérifier le moteur** pour confirmer que **Codex Native2** est associé et disponible.

Les actions d’écriture et de modification doivent également être autorisées par l’espace de travail ChatGPT
et par la politique définie par son administrateur. Consultez la documentation sur le
[mode développeur et les applications MCP](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt).
Toute demande d’autorisation inattendue bloque l’opération, sauf si `--auto-approve-tool-calls` est explicitement activé.
Cette option choisit **Autoriser une fois**, jamais une autorisation permanente.

</details>

<details>
<summary><strong>Diagnostics et sous-agents</strong></summary>

<a id="operations"></a>

Consultez **Activité** pour les diagnostics locaux expurgés et **Paramètres → Lancer le diagnostic** pour vérifier le fonctionnement complet.
Les paramètres permettent aussi d’annuler un tour conservé dans le navigateur ou de retirer l’intégration Codex avant la désinstallation.
**Enregistrer les conversations dans ChatGPT** conserve les conversations des tâches dans l’historique ChatGPT. Cette option est désactivée par défaut et indépendante de **Nouvelle conversation dans le navigateur à chaque échange**.
Définissez `CODEX_CHATGPT_WEB_BROWSER_DIAGNOSTICS=1` uniquement si chaque point de contrôle du navigateur doit inclure une capture d’écran.

Les nouvelles installations utilisent **Compatibilité V1** pour les sous-agents entre différents moteurs. **Natif** préserve
les réglages propres à Codex et active la délégation Web-vers-Web V2 en texte brut. Redémarrez Codex et ouvrez une nouvelle tâche
après avoir changé le protocole :

```bash
codex-chatgpt-web subagents status
codex-chatgpt-web subagents compatibility-v1
codex-chatgpt-web subagents native
```

</details>

<details>
<summary><strong>Prérequis et sécurité</strong></summary>

<a id="limitations-and-security"></a>

- Il s’agit d’une automatisation non officielle du navigateur, pas d’une API OpenAI. Les modifications de l’interface ChatGPT peuvent rendre les sélecteurs incompatibles ;
  l’opération échoue alors explicitement, sans changer discrètement de modèle ou de transport.
- Les données du navigateur contiennent des informations de connexion sensibles. Les processus exécutés sous le même utilisateur local
  peuvent joindre le service sur l’interface de bouclage. Ne partagez jamais le profil du lanceur et utilisez un ordinateur de confiance.
- Les paquets publiés ciblent actuellement macOS 13+ (arm64/x64), Windows x64 et Linux x64. Le moteur,
  les tests et la création des paquets sont vérifiés sur ces trois plateformes en intégration continue. Les parcours navigateur et MCP liés à un compte font l’objet
  d’une [validation des versions](docs/release-validation.md) distincte.
- Les paquets ne sont pas encore signés pour chaque plateforme ; Gatekeeper ou SmartScreen peuvent donc afficher un avertissement. Les programmes d’installation vérifient
  le manifeste SHA-256 publié avant l’installation.

Lisez la documentation complète sur l’[architecture](docs/architecture.md) et le
[modèle de sécurité](docs/security-model.md) avant d’activer le mode complet. Signalez les vulnérabilités en suivant
[SECURITY.md](SECURITY.md).

La conversation temporaire est un [mode de confidentialité de ChatGPT](https://help.openai.com/en/articles/8914046-temporary-chat-faq) ; les messages sont toujours traités par OpenAI.

Couverture des vérifications : [validation des versions](docs/release-validation.md).

Ce logiciel est indépendant et n’est ni affilié à OpenAI ni approuvé par OpenAI. Utilisez-le uniquement avec
votre propre compte, dans le respect des [conditions d’utilisation](https://openai.com/policies/terms-of-use/) applicables
et des règles de votre espace de travail. Il ne contourne ni l’authentification ni les contrôles d’accès.

</details>

<details>
<summary><strong>Exécution depuis les sources et développement</strong></summary>

<a id="development"></a>

```bash
git clone https://github.com/miuuyy/codex-chatgpt-web.git && \
cd codex-chatgpt-web && \
bun run app
```

L’exécution depuis les sources nécessite Bun 1.4.0. La commande installe les versions verrouillées des dépendances, puis ouvre l’application.

```bash
bun run app
bun run dev:launcher
bun run src/cli.ts dev status
bun run dev:chat compaction-lab "Reply with exactly: DEV READY"
bun run verify
bun run smoke:subagents
bun run app:package
```

`dev:launcher` utilise un profil et un compte distincts dans `~/.codex-chatgpt-web-dev`. `dev:chat` teste le véritable navigateur et les parcours de réduction du contexte avec des résultats d’outils explicitement simulés, sans modifier le routage habituel de Codex. Consultez l’[environnement de discussion DEV](docs/dev-chat.md) pour la configuration et les commandes.

</details>

## Historique des étoiles

<a href="https://www.star-history.com/?repos=miuuyy%2Fcodex-chatgpt-web&type=date&legend=top-left">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=miuuyy/codex-chatgpt-web&type=date&theme=dark&legend=top-left&sealed_token=hBVvg_eOjfMFDrfyeo5FPQkIwcvBEmXc6F7ZoOKnfFE4KPCs67o34w4XwVuM-bHGnKR-SKCAN_TSTWrzuqSBNU-RjNZCLT4f-xNs9qcDhciQtemxHKuuFj0N5YNqZIihdaQfakrh2ANhOrvP0K2LmLXX2zbsYyVaYZknyTnlYeIS_mOGvMcO32ZmPCHK">
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=miuuyy/codex-chatgpt-web&type=date&legend=top-left&sealed_token=hBVvg_eOjfMFDrfyeo5FPQkIwcvBEmXc6F7ZoOKnfFE4KPCs67o34w4XwVuM-bHGnKR-SKCAN_TSTWrzuqSBNU-RjNZCLT4f-xNs9qcDhciQtemxHKuuFj0N5YNqZIihdaQfakrh2ANhOrvP0K2LmLXX2zbsYyVaYZknyTnlYeIS_mOGvMcO32ZmPCHK">
    <img alt="Graphique de l’historique des étoiles" src="https://api.star-history.com/chart?repos=miuuyy/codex-chatgpt-web&type=date&legend=top-left&sealed_token=hBVvg_eOjfMFDrfyeo5FPQkIwcvBEmXc6F7ZoOKnfFE4KPCs67o34w4XwVuM-bHGnKR-SKCAN_TSTWrzuqSBNU-RjNZCLT4f-xNs9qcDhciQtemxHKuuFj0N5YNqZIihdaQfakrh2ANhOrvP0K2LmLXX2zbsYyVaYZknyTnlYeIS_mOGvMcO32ZmPCHK">
  </picture>
</a>

---

[Dépannage](TROUBLESHOOTING.md) · [Sécurité](SECURITY.md) · [Contribuer](CONTRIBUTING.md) · [Licence MIT](LICENSE) · [Intégration continue](https://github.com/miuuyy/codex-chatgpt-web/actions/workflows/ci.yml)

Autre projet du créateur : <img src="assets/readme/persona-voice.svg" width="20" height="20" alt=""> [ChatGPT Persona Voice](https://github.com/miuuyy/ChatGPT-Persona-Voice) — des voix personnalisées locales, en quasi-temps réel, pour ChatGPT et Codex.
