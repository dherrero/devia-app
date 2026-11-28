# Interface tools for any agent (`devia-ui`) — release notes

Status: implemented (release note, written when S-25 landed; later sessions added items, see the feature page for current behaviour)
Verified: b08bff62130756f1e2eb66ac2578efbef65c2823

Claude Code stopped offering its question tool in the mode Devia uses, and cards with buttons stopped appearing. Devia now serves its own interface tools, and they work with **all supported agents**, not only Claude.

## What is new

- **Questions with options** (`devia_ask_user`): the agent asks and the user answers with one click.
- **Step list** (`devia_todo`): the agent publishes its plan and ticks steps as it goes. Saved with the session.
- **Plan approval** (`devia_plan_approve`): in plan mode the agent shows the plan; the user can approve it, approve and run (Devia switches the session to apply mode) or reject it with a comment.
- **Request a review** (`devia_request_review`): the agent opens the Changes view so the user can comment the diff line by line.
- **Confirm actions** (`devia_confirm`): before something sensitive the agent asks permission. "Always allow" only applies to that exact action and is never offered for actions flagged dangerous.
- **Pick files** (`devia_pick`): the user selects files or folders on the project tree.
- **Notifications** (`devia_notify`): system notification when the window is not in view, and a Telegram message when connected.
- **Skills for everyone** (`devia_skill`): any agent can read the project's skills.
- **Send files to the chat** (`devia_send_file`, S-32): with Telegram connected, the agent can send screenshots, reports or exports to the chat. They arrive after its reply, grouped in albums (each file with its own caption), and also appear as a "For Telegram" card in the app thread. If the run is stopped, its files are not sent. Only files inside the workspace (never Devia's data folder, nor a workspace that is the home folder), never secrets (`.env*`, keys, credentials, shell histories…) nor hard links, up to 50 MB and 10 per run. Details: [../features/telegram-controller/user-guide.md](../features/telegram-controller/user-guide.md).

## The plan, step by step

- When the agent proposes a plan, only the proposal shows above the composer.
- Once decided, the plan **stays in the chat** ("Plan approved" or "Plan rejected", with the user's reason), collapsed and without buttons.
- If approved and run, a **stepper** appears collapsed to one line ("Step 2/5 · …"). It advances by itself as the agent finishes each step.
- If a step needs something from the user (confirm an action, pick files), the stepper opens by itself and the form appears **inside that step**. After answering, the form becomes a summary line ("✓ Confirmed: …") and the stepper folds again.
- Answered cards disappear and do not come back; the panel empties when the run ends.
- If the agent asks for a review and there are no uncommitted changes, it is answered automatically instead of waiting.

## From Telegram

The chat has no buttons, so only tools that need no decision are offered: the step list, notifications, skills and, if file sending is enabled (Settings › Remote control › Allow Devia to send files to the chat, on by default), file sending. For everything else the agent asks in text with numbered options and the user answers in the next message.

## Settings

A **Interface tools** section in Settings: the user can turn off the ones they do not want (each shows how much context it takes) and revoke the "always allow" grants given in the active project.

## Internal changes

- The previous version's `devia-ask` server is removed. Devia cleans only its own entries from the configs of projects where it was already used; an entry added by hand with that name is respected.
- Checks with each agent are done through use. If a tool fails with a specific agent, report it.

## Related

- [../features/ui-tools.md](../features/ui-tools.md), [00-architecture.md](00-architecture.md), [01-cross-agent-matrix.md](01-cross-agent-matrix.md), [02-context-cost.md](02-context-cost.md)
