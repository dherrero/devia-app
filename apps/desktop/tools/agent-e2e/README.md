# Agent E2E harness (S-30 T-344)

Drives **real** CLI agents through Devia's **real** run pipeline and checks
that what reaches each CLI is unchanged. It is the safety net for the S-30
refactor (render ↔ core ↔ mappers ↔ CLI): every task must leave the `wiring`
half of these snapshots identical.

```bash
npx nx run desktop:build:main                         # the harness runs on dist/main
node apps/desktop/tools/agent-e2e/run.cjs all         # compare against snapshots/
node apps/desktop/tools/agent-e2e/run.cjs pi          # one agent: claude | pi | opencode
node apps/desktop/tools/agent-e2e/run.cjs all --update             # accept a new baseline
node apps/desktop/tools/agent-e2e/run.cjs opencode --record        # refresh wire fixtures
node apps/desktop/tools/agent-e2e/run.cjs claude --scenario apply  # one scenario
```

**Costs real money and needs the CLIs installed and logged in. Never runs in CI.**
Claude runs on `haiku`; OpenCode on `opencode/deepseek-v4.1-flash-free` (the
default `big-pickle` stalls mid-turn on tool-heavy prompts); pi on its
configured default model.

## How it works

- `headless.cjs` — builds `RunInstructionUseCase` with the production
  collaborators (launcher, adapter registry, bundled MCP servers) and in-memory
  stand-ins only for what the renderer owns (config, sessions, state). The
  session store keeps the transcript the renderer would persist, so
  `continuity: 'replay'` agents get the same history as in the app. **This is
  the only file to touch when the composition changes.**
- `scenarios.cjs` — one Devia session, three turns: `apply` (devia_todo,
  devia_ask_user answered by the harness, mem_save, kanban_create_spec),
  `resume` (does the agent remember?), `plan` (no file written, MCP kept).
- `run.cjs` — intercepts `child_process.spawn`, so the oracle is literally what
  reached the CLI: argv, stdin, and the files the argv points at (`--mcp-config`,
  `-e`, `--append-system-prompt`) or the native config in its cwd — read at
  spawn time, because they are temp files removed when the run ends.

## Snapshots

`snapshots/<agent>-<scenario>.json`, with paths, uuids and temp names normalised.

| half | contents | on mismatch |
| --- | --- | --- |
| `wiring` | binary, argv (long free text collapsed), stdin shape, MCP servers delivered, system-prompt channel + what it announces | **FAIL** (exit 1) |
| `behaviour` | exit code, event types, Devia tools called, cards drawn, recalled (resume), wroteFile (plan) | warn — the model is not deterministic; re-run |

Fixtures recorded with `--record` land in
`src-main/features/agents/<agent>/__fixtures__/<scenario>.jsonl` (stdout only,
home path and secret-looking values redacted) and back the wire-contract golden
tests of each mapper.
