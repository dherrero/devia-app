# `devia-ui` — one MCP server for every interface tool (S-25)

Why this shape, written down so it is not re-litigated in six months.

## The problem S-24 left open

S-24 proved the pattern: Claude Code 2.1.220 dropped `AskUserQuestion` from
headless runs, MCP tools still reach one, so Devia served the question card as
its own MCP server (`devia-ask`). It worked, and it was **cross-agent by
construction** — every CLI that speaks MCP gained a capability only Claude Code
had.

That immediately raised the question this spec answers: which other Claude Code
built-ins can Devia serve itself, and how should they be packaged?

## The decision: one server, not one per tool

**Rejected: a server per feature.** It reads cleaner and it is much worse. Each
MCP server costs:

1. a child-process spawn on **every run**, and
2. its tool schemas in the **cached prompt prefix on every turn**.

Devia has already paid that bill twice and both times the fix was to *shrink*
the prefix: S-16 T-188 (advertise only two bootstrap tools on an empty kanban
board) and T-189 (drop Claude's `Workflow`, ~4.5k tokens/turn). Eight servers
would have multiplied the exact cost those tasks removed.

**Chosen: one `devia-ui` server** with a tool registry, a shared rendezvous, one
delivery gate and one fallback protocol.

Measured at introduction, serialised `tools/list` payload:

| Profile | chars | ≈ tokens |
| --- | --- | --- |
| plan | 2 891 | 830 |
| apply | 4 180 | 1 200 |
| remote (Telegram) | 1 368 | 390 |
| whole surface | 4 817 | 1 376 |

S-32 added `devia_send_file` with a bare schema (+438 chars). Today: plan
3 056 (3 494 with `send_file`, own cap `planWithSendFile` 3 600), apply 4 207
(4 645 with `send_file`), remote apply 1 395 (1 833 with `send_file`), whole
surface 5 420.

`ui-tools-budget.test.ts` fails if a change pushes a profile past its cap. When
it trips, the answer is to narrow the default policy — not to raise the cap
without saying why.

## Invariants

1. **Rendezvous per RUN**, not per project (`<tmp>/devia-ui/<runId>`). Two
   split-view panes must never share one. Contrast `devia-memory` /
   `devia-kanban`, which are per project.
2. **The advertised set is deterministic for the whole run.** The runner decides
   it and passes it on argv; the server never infers. A set that changed
   mid-run would invalidate the agent's cached prefix every turn.
3. **Every UI tool needs a plain-text fallback.** This stopped being a special
   case of "ask" and became part of the contract: a run without a capability is
   taught how to get there in prose, or the model goes silent or invents an
   answer.
4. **Blocking vs fire-and-forget is a property of the tool.** Only blocking ones
   arm the runner's kill timer.
5. **The renderer decides what can be advertised.** `IMPLEMENTED_UI_TOOLS` lists
   the tools with a card; a blocking tool without one would hang the run until
   the timeout.

## Things that turned out differently than planned

- **`devia_skill` does not replace `buildSkillRegistryHint`.** The plan assumed
  the hint was a listing worth removing from the prompt. It is a ~340-char
  pointer to the registry file, so the swap would have saved nothing and cost a
  tool schema. Hint kept as is.
- **"Approve and run" cannot switch the mode of the run in flight.** Sandbox and
  permission flags live in the argv of the already-spawned process. The tool
  tells the agent to end its turn; Devia switches the session and queues a
  follow-up with the plan inlined.
- **A remote run is not "no UI tools".** S-24 withheld the whole server; the
  per-tool policy keeps the three that need no interaction (four since S-32,
  when `devia_send_file` is available).

## `devia_send_file` (S-32): a tool, not a server

The Telegram "send me the file" feature landed as one more `devia-ui` tool, which
is what invariant "adding a tool must not mean adding a server" asks for. Shape
decisions:

- **Offered only where there is a chat.** `canSendFiles` = relay connected &&
  (remote run || desktop mirror) && `remoteControl.allowFileSend`. Opt-in in the
  policy: without it the advertised set, the argv and the prompt are
  byte-identical to before. Plan + apply + apply-yolo — plan keeps it on
  purpose (sending an existing file is read-only) under its own budget cap; it
  survives the remote filter because it needs no click (remote now carries up
  to four schemas).
- **Fire-and-forget, but validated in the server.** A refusal noticed only by
  the main process would never reach the agent. So `resolveLocally` grew a
  pass-through result: the server validates (`checkOutboundFile`), answers the
  agent, and forwards an enriched request through the normal rendezvous.
- **Revalidated in main.** The request file lives in a tmp dir the agent can
  write; `RunFileGate` re-runs the same guard and owns the per-run counter.
  The admitted file (with its `dev`/`ino` identity) is published on the
  `RunGateway`; the Telegram forwarder sends it after the text reply. A
  request main refuses is published as `file_rejected` (`source: 'tool'`) so
  the chat learns it did not go out, and `RunInteraction.stop()` does a final
  fire-and-forget poll so a request written at the very end is not lost.
- **Re-checked at upload.** The file is reopened with `O_NOFOLLOW` and
  `fstat`ed: regular, single link, same `dev`/`ino` and size as validated,
  bounded read from the handle, one file at a time. A run the user stopped
  uploads nothing (`failed:stopped`); an errored run still does.
- **Fixed safety, not configurable.** Roots (workspace + the run's live session
  worktree; a root at or above the home folder is refused, `home_root`),
  Devia's data dir denied (`--deny-roots`, `devia_data`), a secret denylist
  that is a code constant, realpath re-checks, hard links refused. Limits live
  in `shared/domain/outbound-file-policy.ts`. The setting only turns the
  feature off.
- **Fallback without MCP: `outbox/`.** An agent that cannot get the tool is told
  (in `buildUiFallbackHint`) to copy the file to `outbox/`; the flush runs
  through the same gate before `end`. Plan mode is told it cannot send files.

## Not in scope

`devia_spawn_agent` (cross-agent subagents) — its own spec, because it is an
execution-model change, not another card.
