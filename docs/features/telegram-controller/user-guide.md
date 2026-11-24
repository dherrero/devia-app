# Telegram remote control — setup and usage guide

Status: implemented
Verified: b08bff62130756f1e2eb66ac2578efbef65c2823 (translated from the original Spanish guide; command list re-checked against `src/main/features/telegram-controller/application/command-router.ts`)

Devia can be controlled from Telegram **while the app is open**. A controller built into the app connects to your Telegram bot and acts as a bridge: what you type in the chat runs in the active project, is mirrored in the app, and the agent's answer comes back to your phone. Feature overview and code map: [../telegram-controller.md](../telegram-controller.md).

> There is no background service: remote control only works with Devia open. When the app is closed the bot stops answering.

## 1. Create a Telegram bot

1. Open Telegram and talk to [@BotFather](https://t.me/BotFather).
2. Send `/newbot` and follow the prompts (bot name + username).
3. BotFather gives you an **API key** (token) shaped like `123456789:AAExxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`.

## 2. Get your Chat ID

The **Chat ID** identifies the only chat allowed to control the app.

1. Open a chat with your new bot and send any message (e.g. `hi`).
2. Talk to [@userinfobot](https://t.me/userinfobot) or [@RawDataBot](https://t.me/RawDataBot): it tells you your numeric `id`.
3. Note that number (e.g. `123456789`).

## 3. Configure it in Devia

1. Titlebar settings gear → **Settings** → section **Remote control** (`tab_remote_control` in `src/renderer/assets/i18n/en.json`).
2. Under **Telegram**: enable **Enable Telegram**, paste the **Bot API Key**, enter the **Chat ID**.
3. Press **Test connection** to verify the token (it shows the bot's `@username`).
4. Save. The status indicator becomes **Connected**.

The API key is stored **encrypted** on the machine (OS keychain through `src/main/shared/secret-vault.ts`) and only the configured Chat ID can control the app.

## 4. Use it

From your bot's chat:

- **Free text** → runs as an instruction in the active project. You see the run in the app too and receive the agent's answer when it ends.
- **Attachments** (images, PDF, documents, video, audio) → send them with a **text/caption** that is the instruction. Devia downloads the file, saves it and passes it to the agent to read with its Read tool. Several at once (an album) are allowed; sent **without a caption**, the bot asks you to resend with an instruction.
- `/projects` — lists the workspace projects. Each line carries a ready-to-paste `/use <path>` command, 📦 for runnable projects and 📂 for container folders. If the active project is a folder, `/projects` shows its content (with a ⬆️ to go back).
- `/use <path>` — chooses the active project or folder; nested paths work (e.g. `/use Acme/devia`). Without an argument it uses the last one open in the app. For a container folder, use `/projects` to enter it.
- `/status` — active project, whether a run is in progress, agent and mode, git branch/working-tree state, and the session's context-usage % and accumulated cost.
- `/stop [project]` — stops the run in progress.
- `/clean [project]` — resets the agent session (starts from scratch; also drops the pending queue).
- `/mode plan|apply|yolo` — permission mode of runs.
- `/agent` — shows the active agent.
- `/sync` — switches the project to its default branch and pulls (needs a clean tree and not already being on it).
- `/exec <command>` or `!<command>` — runs a shell command in the project (only if enabled; see Security).
- `/help` and `/start` — show the help with all commands.

On long runs you receive a periodic notice that it is still working.

## Sync conversations with the desktop

The conversation goes both ways:

- **Telegram → desktop** (always): what you write from Telegram also appears in the app's chat, and the agent's answer shows in both. Telegram also tells you which project it runs in.
- **Desktop → Telegram** (optional): with *Settings › Remote control › Mirror desktop conversations to the chat* on, every conversation you start in the app is also sent to Telegram: your message (with `👤`) and the agent's answer, both labelled with the project `*[project]*`.

Questions work **turn by turn**: the agent may ask in text but releases the process so you answer in the next message (there are no interactive dialogs over Telegram).

> **Privacy:** mirroring sends your messages and the agent's answers (which may include code snippets) to Telegram's servers. It is **off by default**.

## Receiving files from Devia

The agent can also **send files to the chat**: a screenshot, a report, an exported CSV, a long log. Ask naturally ("send me the screenshot of the home page"). If an answer is too long for the chat, the agent may decide to send it as a file instead of ten messages.

**How they arrive**

- First the agent's text reply (with a `📎 N file(s) follow` notice) and **then** the files.
- Several files are grouped in **albums** of up to 10: photos and videos together, documents on their own, audio on its own. A comment the agent attached to a file appears as **that** file's caption (also inside an album).
- Files arrive even if the run ends with an error.
- If you **stop** the run (`/stop` or *Stop* in the app), none of its pending files is sent: you get a single `⏹️ Run stopped: I did not send N file(s)` notice.
- Same with mirrored desktop conversations.
- In the app each file shows in the thread as a **file card** labelled *For Telegram*, from which you can open it or reveal it in its folder. The label does not mean it already arrived: Devia uploads at the end of the reply (and not at all if you stop the run).

**Limits**

- Up to **50 MB** per file (Telegram's bot limit). Larger: the agent knows and proposes compressing or splitting.
- Images (JPG, PNG, WebP) go as **photo** up to 10 MB; above that, or other formats (SVG, GIF, HEIC…), as **document**.
- At most **10 files per run**. For more, ask for a `.zip`.
- Folders are never sent: the agent must compress them first.

**Which folders can be sent**

Only files **inside Devia's workspace** (the root folder with your projects) and, for an isolated session, inside **that session's worktree**. Nothing else: not your home folder, downloads or other disks. Symlinks are resolved before checking, so a link inside the project pointing outside is refused, and a file with **several hard links** is always refused (its origin cannot be known: copy it and send the copy).

Also:

- Nothing from **Devia's data folder** (conversations, memory, attachments, outbox archive) ever leaves, even when it sits inside the workspace.
- If your workspace is your **home folder** (or above it), file sending is disabled: pick a more specific root folder in Devia.
- Right before uploading, Devia re-checks the file is the one that was validated (same file, same size, not a link). If it changed in between, it is not sent.

**Never sent**

Anything that looks like a secret or credential is always refused, even inside the project and even if you ask explicitly. Examples:

- any `.env*` file and variants (`.env.local`, `.envrc`, `prod.env`, `.dev.vars`…);
- keys and certificates (`id_rsa`, `id_ed25519`, `*.pem`, `*.key`, `*.p12`, `*.ppk`…), keychains and folders such as `.ssh/`, `.gnupg/`, `.aws/`, `.kube/` or the gcloud config;
- credentials and token files (any name with `credentials`, `secrets.*`, `kubeconfig`, `.npmrc`, `.netrc`, `.pgpass`, `.vault-token`, `*.tfvars`, `terraform.tfstate`…);
- terminal histories (`.zsh_history`, `.bash_history`…);
- the inside of `.git/` and Devia's and Claude's configuration.

This list is **not configurable**: it is a code constant (`SECRET_PATH_PATTERNS` in `src/shared/domain/outbound-file-policy.ts`) so no agent can widen it.

**Turn it on or off**

*Settings › Remote control › Allow Devia to send files to the chat*. **On by default**; the change applies on the next run without restarting the bot. The restrictions above (allowed folders and secret files) always apply, whatever the setting.

> **Privacy:** the content of sent files leaves the machine and is uploaded to Telegram's servers. If you never want that, turn the setting off.

**If something fails**

- If a file cannot be uploaded (no longer exists, changed since validation, Telegram rejects it, the bot disconnected…), after the reply you get `⚠️ No pude enviar: report.pdf (changed), …` with each file and the reason (the message text is Spanish in code). The other files are still sent; if Telegram rejects a whole album, Devia retries its files one by one.
- If Devia refuses a file the agent already considered sent (e.g. it changed right after the request), it also appears in that notice.
- If the agent asks for a disallowed file (outside the workspace, secret, too large or beyond the 10 limit), it is told immediately and should explain it in its reply.

**Agents without MCP tools: the `outbox/` folder**

Some agents cannot use Devia's tools. They are told to copy the file into an `outbox/` folder inside their working directory: at the end of the run Devia empties it (archiving locally) and sends those files to the chat with the same rules and limits. An `outbox/` file that cannot leave (e.g. a secret) stays archived on the machine and appears in the `⚠️ No pude enviar…` notice. In **plan mode** the agent cannot write files, so it only works there if it has the tool.

> Recommendation: add `outbox/` to your projects' `.gitignore`. Devia does **not** do it automatically.

## Security

- **Only your Chat ID** can control the app; any other chat and messages from before startup are ignored.
- **Shell commands** (`/exec`, `!`) are **off by default**. Turn them on only if needed, in *Settings › Remote control › Allow shell commands (/exec) from Telegram*: they grant command execution to whoever controls the chat.
- The API key is never shown in logs or forwarded to the chat.
- **File sending** only admits workspace files and never secrets. Each send is in the audit log with name and size, never content.

## Not available remotely

Some app actions make no sense over Telegram and are not included (e.g. tunnels to preview remotely). For tasks like deploying with Docker you can use `/exec docker compose up -d --build` if shell is enabled.

## Related

- [../telegram-controller.md](../telegram-controller.md), [../outbox.md](../outbox.md), [../ui-tools.md](../ui-tools.md)
