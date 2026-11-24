# Devia Method — per-agent verification

Status: implemented (verification record)
Verified: b08bff62130756f1e2eb66ac2578efbef65c2823 (results below were recorded when S-39 landed and were not re-run)

Real tests (no mocks) with the installed CLIs: Claude Code, Codex 0.141, Gemini 0.46, OpenCode 1.19.3 and pi 1.3.0. Two kinds:

1. **Acceptance** (`tools/agent-e2e/run.cjs <agent> --scenario kit`): the request "Let's make a react todo list" in plan mode, through Devia's full pipeline. The method must fire BEFORE any code is written: the agent loads `brainstorming`, asks, writes no files and does not touch the board until the user approves the design.
2. **Multi-turn behaviour** (`tools/agent-e2e/evals.cjs <agent>`): a simulated user answers cards and messages; assertions are about what the agent DID (tool calls, kanban state, files and commits), not its prose. Cases: `brainstorm` → `plan` → `execute` (one session), `trivial`, `bugfix`. `--cheap` runs only `brainstorm` and `trivial`; `--repeat N` reports k/N per assertion because a model is not deterministic.

## Results

| Agent | Acceptance (`kit`) | Multi-turn evals |
| --- | --- | --- |
| Claude (haiku) | PASS 2/2 | full chain (brainstorm → plan → execute in `apply-yolo`, trivial, bugfix): all hard assertions |
| Codex | PASS | full chain: all hard assertions |
| Gemini | PASS (after the plan-mode policy) | full chain: all hard assertions |
| pi | PASS (after resetting its tools outside plan mode) | full chain: all hard assertions |
| OpenCode | PASS | full chain: all hard assertions |

No full run hit a budget limit: all exited 0 with no cut-offs. Remaining soft assertions below the ideal are optional: test-before-code ordering is not detectable on agents that write through the shell (Codex, OpenCode, pi), and some leave no comment in the task thread or do not recall memory before asking.

Non-blocking observations: OpenCode (free model) once created a board task before the user answered in an earlier run; Codex uses Devia's cards (a simulated user approves them instantly), so the assertion "nothing on the board before the first answer" only counts what happens before its first card; Gemini's first `mem_search` in a new session returned an MCP client error (the server answers the same call fine).

What changed because of the tests (and why evals exist):

- **The "trivial request" exception was too lax.** A small model treated "a small CLI" as trivial, skipped `brainstorming` and wrote the code in the chat. Now creating something new (a program, script, feature, page) is never an exception; only an edit where nothing is open and nothing new is created is.
- **Devia's plan protocol competed with the method.** With two instructions giving different first steps, the model kept the last. With the method active, the plan protocol delegates to the method's sequence.
- **Gemini's plan mode blocked Devia's tools.** Its policy denies everything not read-only, so it could not save the design on the kanban, and it could call `exit_plan_mode` itself and end up writing files. It now receives a per-run `--policy` file (in Devia's temp directory, removed afterwards) that allows the three Devia servers in plan mode and forbids leaving it. With that it passes `brainstorm` (spec and plan on the kanban, no files).
- **pi could not write after plan mode.** pi stores the tool set it was launched with in the session; a session that went through plan mode (`--tools read,grep,find,ls,mcp__*`) and resumes without `--tools` still lacks `bash`, `edit` and `write` (checked with pi 1.3.0). Devia's normal flow is plan → approve → apply in the same session, so pi's apply could do nothing. Now, outside plan mode, Devia passes `--tools +bash,+edit,+write`, which adds the writers to what the session has without overriding the user's `defaultTools`.
- **In `apply` the agent cannot run arbitrary Bash** (Claude uses `acceptEdits`, which a `-p` run cannot extend): it could not run tests or commit. Executing an approved plan is "accept and don't ask" (`apply-yolo`), and the `execute` case proves it that way.

## Coverage gaps

- One pass per agent and case: results are majority of 1; `--repeat N` gives k/N to measure model dispersion.
- Models: Claude was tested with haiku and OpenCode with its free model; a more capable model should behave better, not worse.
- Windows and Linux (the kit is materialised with exec bits restored; untested outside macOS).

## Related

- [00-audit.md](00-audit.md), [01-design.md](01-design.md), [../features/starter-kits.md](../features/starter-kits.md)
