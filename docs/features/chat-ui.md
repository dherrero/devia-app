# Chat UI (chat panel, composer, tool cards, diff review)

Status: implemented
Verified: b08bff62130756f1e2eb66ac2578efbef65c2823

## Purpose

The central conversation surface: message list, composer, mode bar, tool-call cards, diff viewer with line comments, queue panel, execution stepper and question/plan cards.

## Does

- `ChatPanelComponent` (`src/renderer/app/features/chat/chat-panel/chat-panel.component.ts`): bottom-anchored windowed list; only the tail slice is mounted (`WINDOW_SIZE` 20) and a top sentinel with `IntersectionObserver` prepends older messages in chunks of `LOAD_CHUNK` 10, preserving scroll. The window re-pins to the tail only on a real session change or while `stickToBottom()`.
- Components under `chat-panel/components/`: `input-bar`, `attachments-bar`, `mode-bar`, `chat-header`, `messages-feed`, `message-bubble` (markdown via `marked` + DOMPurify, falls back to plain text), `tool-call-card`, `diff-viewer`, `question-card`, `question-answered-card`, `plan-message`, `handoff-divider`, `empty-state`.
- `ToolCallCardComponent`: tool input/output/status/diff; renders sub-agent cards with nested calls (open while running, folded when done), and a `run_script` card for [code-mode.md](code-mode.md).
- `DiffViewerComponent` (`.../components/diff-viewer/`): inline git diff with workspace-relative paths. With `[commentable]="true"` (only the Changes view) each non-hunk line opens an inline comment editor; **Cancel** discards, **Send for review** builds a `revisa:` prompt from the comments (`buildReviewPrompt`, `src/shared/domain/review-comment.ts`) and puts it in the composer. Comments live per project in `AppStateService.reviewComments`, anchored to a diff snapshot; `reconcileReviewComments` prunes anchors that no longer resolve after a commit/stash/edit.
- Interface tools: `ds-ui-tool-host` (`src/renderer/app/features/chat/ui-tools/ui-tool-host.component.ts`) draws exactly one of three shapes: proposal (pending `devia_plan_approve`), executing (read-only stepper from `libs/ui`, opens by itself when a step needs an answer), loose (waiting card alone). State in `UiToolsService.executionStates` per session ([ui-tools.md](ui-tools.md)).
- Queue panel (`chat/queue/queue-panel.component.ts`, [queue.md](queue.md)), auto-resume banner (`chat/auto-resume/`, [auto-continue.md](auto-continue.md)), terminal pane (`chat/terminal/`, [terminal.md](terminal.md)).
- Composer: attachments of any type ([attachments.md](attachments.md)), voice dictation ([voice.md](voice.md)), drafts preserved per pane across route changes (`ComposerDraftStore`), mode selector ([run-modes.md](run-modes.md)).
- State: `AppStateService` (`src/renderer/app/core/services/app-state.service.ts`) signals store; the renderer reaches the bridge only through `ElectronApiService`.

## Does NOT

- Does NOT use RxJS or NgModules: standalone, OnPush components with signals.
- Does NOT persist composer drafts across app restarts.
- Does NOT render interactive cards for remote (Telegram) runs; those use plain text ([telegram-controller.md](telegram-controller.md)).
- Does NOT make `devia_request_review` a panel card: the Changes view is its card, and an empty diff answers by itself (`decision: 'empty'`).

## Entry points

- `src/renderer/app/features/chat/chat-route.component.ts` — route shell
- `src/renderer/app/features/chat/chat-panel/chat-panel.component.ts:ChatPanelComponent`
- `src/renderer/app/features/chat/chat-panel/components/tool-call-card/` — tool cards
- `src/renderer/app/features/chat/chat-panel/components/diff-viewer/` — diff + comments
- `src/renderer/app/features/chat/ui-tools/ui-tools.service.ts:UiToolsService`
- `src/renderer/app/core/services/app-state.service.ts:AppStateService`
- `src/renderer/app/core/services/electron-api.service.ts:ElectronApiService`
- `src/shared/domain/review-comment.ts` — comment anchors and prompt

## IPC / MCP surface

- All through `ElectronApiService`; main-side channels are listed per feature. UI tool events `ui:tool-request` / `ui:tool-result`; `question:ask` / `question:answer`; `claude:output`, `process:*`.

## Persistence

Chat history via [sessions.md](sessions.md); review comments in memory (`AppStateService.reviewComments`); layout in localStorage.

## Config

Language, theme, font size ([settings.md](settings.md)); `uiTools.enabled` can only narrow the advertised tools.

## Gotchas

- Design tokens: real names are `--dv-fg`, `--dv-muted`, `--dv-surf`/`--dv-surf-2`/`--dv-surf-3`, `--dv-bor`, `--dv-divider`, `--dv-acc-fg`, `--dv-danger*`; Material-style names (`--dv-on-surface`, …) do not exist and silently resolve to nothing. `tools/check-scss-tokens.ts` does not catch this.
- Answered `devia_ask_user` cards are keyed on the tool name via `isAskUserTool()` (`src/shared/domain/question-ask.ts`) and on the rendezvous callId, not the stream `tool_use` id.
- Claude's decoder drops `user` lines, so the optimistic `tool_result` written on answer is the only record of a Claude question answer.

## Tests

- `src/renderer/app/features/chat/**/*.spec.ts` (jsdom + `@analogjs/vitest-angular`); some specs are `it.todo()` placeholders for DOM-runner tests.

## Related

- [split-view.md](split-view.md), [ui-tools.md](ui-tools.md), [sessions.md](sessions.md), [settings.md](settings.md)
