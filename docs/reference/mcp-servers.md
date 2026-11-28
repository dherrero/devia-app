# Devia's bundled MCP servers

Status: implemented
Verified: b08bff62130756f1e2eb66ac2578efbef65c2823

All are stdio JSON-RPC servers written by hand (no MCP SDK), spawned by the agent with `process.execPath` + `ELECTRON_RUN_AS_NODE=1` (compiled to `dist/main/main/features/<feature>/mcp-server/server.js`). They reach every agent through its mapper ([../architecture/agent-layers.md](../architecture/agent-layers.md)). Their ids are in `BUNDLED_SERVER_IDS` (`src/main/features/mcp/infrastructure/marker-merge.ts`) and are never pruned by the MCP-manager sync.

| Server id | Tools | Gating / args | Page |
| --- | --- | --- | --- |
| `devia-memory` | `mem_save`, `mem_search`, `mem_context`, `mem_session_summary`, `mem_get_observation`, `mem_save_prompt`, `mem_current_project` | `config.memory.enabled`; args `--devia-dir`, `--project`; env `DEVIA_ACTIVE_AGENT_ID` | [../features/memory.md](../features/memory.md) |
| `devia-kanban` | `kanban_create_spec`, `kanban_create_task`, `kanban_list`, `kanban_list_specs`, `kanban_get_task`, `kanban_update_task`, `kanban_move_task`, `kanban_comment`, `kanban_close_task`, `kanban_request_user_input`, `kanban_record_subagent`, `kanban_archive_spec`, `kanban_reopen_spec` | injected for runs; advertises only the two create tools while the board is empty | [../features/sdd.md](../features/sdd.md) |
| `devia-ui` | `devia_ask_user`, `devia_todo`, `devia_plan_approve`, `devia_request_review`, `devia_confirm`, `devia_pick`, `devia_notify`, `devia_skill`, `devia_send_file` | per-run set by mode, channel and `config.uiTools`; args `--tools a,b,c` (+ `--skills-dir`, `--subagents-dir`; `--send-roots`, `--cwd`, `--deny-roots` only with `send_file`) | [../features/ui-tools.md](../features/ui-tools.md) |
| `devia-code-graph` | `graph_explore`, `graph_search`, `graph_node`, `graph_callers`, `graph_callees`, `graph_impact`, `graph_affected`, `graph_files`, `graph_status` | only when the run's effective checkout has `graph.db` and `agentAccess !== false`; args `--devia-dir`, `--project` | [../features/code-graph.md](../features/code-graph.md) |
| `devia-code-mode` | `search_tools`, `get_types`, `run_script` | only when the user set a server to `exposure: 'codemode'` on a supported agent; args `--servers-file`, `--events-dir` | [../features/code-mode.md](../features/code-mode.md) |

Delivery rules:

- One native-config write per run for Devia's servers (`NativeConfigMcpDelivery`, `prune: false`); a run WITHOUT a server removes a stale entry Devia wrote earlier.
- Claude: `--mcp-config` + per-project grants in `.claude/settings.local.json`; under an enterprise `managed-mcp.json` none of these servers is injected.
- The server id strings are copied into the runner, `native-config-mcp.ts` and the Gemini def; `src/main/features/code-graph-server-id.test.ts` pins them for code-graph.
- `devia-ui` costs ~4.2–5.4 KB of tool schemas in the cached prompt prefix, which is why there is ONE ui server.

## Related

- [../features/mcp.md](../features/mcp.md), [../architecture/process-and-ipc.md](../architecture/process-and-ipc.md)
