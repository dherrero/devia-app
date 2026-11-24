# Security guards (implemented, do not revert)

Status: implemented
Verified: b08bff62130756f1e2eb66ac2578efbef65c2823

Each item names the code that enforces it.

| Guard | Where |
| --- | --- |
| `resolveInsideWorkspace()` before any filesystem operation on user-supplied paths | `src/main/shared/workspace-paths.ts` |
| `parsePersistedSession()` at every session read/write boundary | `src/shared/domain/session.ts` |
| `classifyDetectionError()` strips host paths from agent detection errors before IPC | `src/main/features/cli-adapters/infrastructure/detection/classify-detection-error.ts` |
| Prompt-pack scanner uses `lstatSync` + `isSymbolicLink()` | `src/main/features/prompt-packs/infrastructure/scanner.ts` |
| `isForeignEvent()` strict filter in `consumeAgentEvent` (runId mismatch drops the event) | `src/shared/domain/agent.ts` |
| Audit log with timestamped rotation, never overwrites history | `src/main/features/security/audit-log.ts` |
| `checkOutboundFile()` (roots + `realpath` + `SECRET_PATH_PATTERNS`) in the `devia-ui` server AND again in main (`RunFileGate`) before any file leaves through the chat relay | `src/main/shared/outbound-file-guard.ts`, `src/main/shared/outbound-file-gate.ts`, `src/shared/domain/outbound-file-policy.ts` |
| Upload-time re-check on the open handle (`O_NOFOLLOW`, `fstat`, `nlink === 1`, same `dev`/`ino`, exact size) | `src/main/features/telegram-controller/infrastructure/telegram-client.ts` |
| `decideShellPath()` limits `shell:openPath` / `shell:reveal` to allowed roots | `src/main/features/shell/path-policy.ts` |
| `devia_confirm` grants match by EXACT normalised action, never prefix; `danger` actions never get "always" | `src/main/features/ui-tools/infrastructure/confirmation-store.ts` |
| `devia_skill` name charset, root re-check, symlink rejection, 256 KiB cap | `src/main/features/ui-tools/mcp-server/` |
| User-defined agent defs: `bin` must be a bare PATH name, `env` dropped, `envOverrideKeys` must match `SAFE_ENV_KEY_PATTERN`, cannot re-point a built-in id | `src/main/features/cli-adapters/index.ts` |
| Secrets at rest sealed with `safeStorage` (AES-256-GCM fallback) | `src/main/shared/secret-vault.ts` |
| Telegram: allowlist of ONE chat id; shell passthrough off by default; token redacted from the config view | `src/main/features/telegram-controller/` |
| Code-graph reader: `lstat`, symlinks never followed, READONLY handle per request; MCP `PATH_REFUSED` for paths escaping the project | `src/main/features/code-graph/engine/discovery/`, `mcp-server/graph-tools.ts` |
| Code-mode sandbox: QuickJS WASM with only `tools` and `console.log`; writes denied (`TOOL_DENIED`); servers file mode 0600, removed after the run | `src/main/features/code-mode/` |
| Per-run MCP configs owner-only in `<deviaDir>/tmp/`, removed after the run | `src/main/features/agents/shared/native-config-mcp.ts`, claude-runner |
| Kill on cancel: Windows `taskkill /T /F /PID` for the whole process tree | `src/main/features/cli-adapters/infrastructure/kill-tree.ts` |
| macOS Hardened Runtime entitlements (`allow-jit`, `allow-unsigned-executable-memory`, `disable-library-validation`, `allow-dyld-environment-variables`) are needed for spawning CLIs, node-pty and `ELECTRON_RUN_AS_NODE` servers | `build/entitlements.mac.plist` |
| `contextIsolation: true`, `nodeIntegration: false` | `src/main/shell/main.ts` |

## Known absences

- No default-deny environment for children: the host environment is inherited ([../features/cli-adapters.md](../features/cli-adapters.md)); `env-slicer.ts`, `ssrf-validator.ts`, `tool-token-issuer.ts` and `workspace-boundary.ts` exist but nothing imports them ([../features/security.md](../features/security.md)).
- No OS-level sandbox for agents beyond what each CLI flag provides ([../features/run-modes.md](../features/run-modes.md)).

## Related

- [../features/security.md](../features/security.md), [../features/telegram-controller.md](../features/telegram-controller.md), [../features/ui-tools.md](../features/ui-tools.md)
