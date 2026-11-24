# Code Graph (S-44)

Status: implemented
Verified: b08bff62130756f1e2eb66ac2578efbef65c2823

## Purpose

Devia's own, fully local code graph of the user's project: served to every agent as the `devia-code-graph` MCP server and to the user as the `/graph` view. Indexing only ever starts from the user's button.

## Does

- Languages (`CODE_GRAPH_LANGUAGES`, `src/shared/domain/code-graph.ts`): TypeScript, JavaScript (`.ts .tsx .mts .cts .js .jsx .mjs .cjs`), Python, Java, Go, Dart. Node kinds `NODE_KINDS` (file, module, class, interface, enum, function, method, property, field, variable, constant, type_alias, namespace …); edge kinds `EDGE_KINDS` (`contains`, `calls`, `imports`, `exports`, `extends`, `implements`, `references`, `type_of`, `returns`, `instantiates`, `overrides`, `decorates`).
- Engine (`src/main/features/code-graph/engine/`, NO Electron imports because the main process, the index worker and the MCP process all load it): `discovery/` (file walk, `.gitignore`, > 1 MB / minified skipped), `extraction/` (tree-sitter wasm per language, `registry.ts`), `resolution/` (imports, path aliases, per-language resolvers, type inference), `indexer/` (`orchestrator.ts` `indexProject` + `EXTRACTION_VERSION`, worker thread, `sync.ts` incremental), `graph/` (callers/callees/impact/path, explore, affected, communities and hubs), `search/` (FTS5 on `name`, docstring/signature lower tier, substring fallback), `db/` (`schema.sql`, `openGraphDb` WAL + `busy_timeout` 5000, migrations, `queries.ts`, `writer-lock.ts`).
- Data: `<deviaDir>/code-graph/<projectKey(abs)>/graph.db` plus `project.json` (`ProjectDoc`: `createdAt`, `autoUpdate` default true, `agentAccess` (absent = on, only `false` stored), `builtAtCommit`, `indexedAt`). Nothing is written into the user's repo. A full index builds `graph.db.building` and renames it over `graph.db` only when finished. Every reader opens a READONLY handle per request and closes it before returning (Windows would block the swap).
- Single writer: `writer.lock` (`acquireWriterLock(dir, 'indexer' | 'sync')`), stolen when its pid is dead or both `since` and mtime are older than 30 min; a full index refreshes the mtime every 60 s. During a full index the MCP never syncs.
- Sync (`syncProject`) re-extracts added/modified/deleted files plus dependents and must equal a full reindex (`sync-parity.test.ts`); returns `fullIndexRequired` when `EXTRACTION_VERSION`, the root or a resolution config (`tsconfig*`/`jsconfig*`, `go.mod`, `pubspec.yaml`) changed. Watcher (`fs.watch` recursive, per-directory fallback capped at 2000 dirs ⇒ `watchDegraded`) runs only for the project open in `/graph` (max 5 watched); HEAD polled every 20 s for `staleReason: 'commit'`.
- MCP server `devia-code-graph` (`mcp-server/server.ts`, stdio, no SDK; args `--devia-dir <deviaDir> --project <abs>`): tools `graph_explore` (primary: a bag of exact symbol names → their source plus the call path), `graph_search`, `graph_node`, `graph_callers`, `graph_callees`, `graph_impact`, `graph_affected`, `graph_files`, `graph_status`. Symbols accept `name`, `Class.method` or `file.ts#name`. Output capped at `MAX_OUTPUT_CHARS` 24 000 except `graph_explore` (file-count budget); a sync before answering with a 2 s soft deadline and a hard 5 s ceiling (`SYNC_CEILING_MS`).
- Gating: `codeGraphMcpServer(projectAbs)` returns a config only when that checkout has `graph.db` AND `agentAccess !== false`, decided at run start; the prompt block (`codeGraphProtocol`, ~47 words) is gated on that run's delivery.
- Worktrees: graphs are per checkout; an isolated pane's worktree gets its own graph seeded from the base with `VACUUM INTO` in a short-lived worker, then synced in the background; dropped when the worktree is removed. A worktree without a graph gets no server (never the base's).
- Usage metric (S-48): each `tools/call` is appended to `<dataDir>/tool-usage.jsonl`; the toolbar chip shows totals and warns when the graph is on but unused.
- Renderer `/graph` view (`src/renderer/app/features/code-graph/`): Cytoscape.js + `cytoscape-fcose` (lazy chunk, behind the `GraphRenderer` port), `CodeGraphStateService`, `GraphViewStore` (expansions, LRU cap, filters), components empty-state, index-progress, toolbar, canvas, search, filters, node-detail; `resolveCollisions` keeps nodes from overlapping.

## Does NOT

- Does NOT index automatically: the user starts it; with `autoUpdate` it only syncs an already indexed project.
- Does NOT support languages beyond the six above (add one per the checklist below).
- Receiver typing follows initializer/declared types only; an untyped receiver, ambiguous name or more than one candidate gives NO edge (silence beats a wrong edge). Known gaps: Python `global` reassignment, TS class declared in a function hiding an imported one, generic arrow type parameters, Python `match/case` captures, Dart `show`/`hide`, ambient `.d.ts` globals, computed receivers `a().b()`.
- Does NOT replace reading code: `graph_*` answers structure, flow and impact only.
- Scale target is ~50k nodes per DB; the view caps children per expansion (500), visible elements (`VISIBLE_ELEMENT_CAP` 8000) and edges per page (5000).
- The oracle test (`tools/code-graph/oracle.test.ts`) is skipped without `CODEGRAPH_ORACLE_BIN`.

## Entry points

- `src/main/features/code-graph/index.ts:buildCodeGraphFeature` — wiring
- `src/main/features/code-graph/application/code-graph.use-case.ts` — status/index/cancel/reset/update/watch
- `src/main/features/code-graph/application/graph-view.use-case.ts` — view queries
- `src/main/features/code-graph/engine/indexer/orchestrator.ts:indexProject`
- `src/main/features/code-graph/engine/indexer/sync.ts` — incremental sync
- `src/main/features/code-graph/engine/db/schema.sql` — schema
- `src/main/features/code-graph/mcp-server/server.ts` — MCP process
- `src/main/features/code-graph/mcp-server/graph-tools.ts` — tools
- `src/main/features/code-graph/mcp-server/code-graph-mcp-injector.ts` — gating
- `src/main/features/code-graph/ipc/code-graph.ipc.ts`
- `src/renderer/app/features/code-graph/code-graph-page.component.ts` — `/graph` route
- `src/shared/domain/code-graph.ts` — shared types

## IPC / MCP surface

- MCP tools above; IPC `code-graph:status`, `code-graph:index`, `code-graph:cancel`, `code-graph:reset`, `code-graph:set-agent-access`, `code-graph:set-auto-update`, `code-graph:update`, `code-graph:watch`, `code-graph:unwatch`, `code-graph:overview`, `code-graph:expand`, `code-graph:node-detail`, `code-graph:search`, `code-graph:usage`, push events `code-graph:progress` and `code-graph:status-changed`.

## Persistence

`<deviaDir>/code-graph/<projectKey>/graph.db`, `project.json`, `writer.lock`, `tool-usage.jsonl`.

## Config

Per-project toggles `autoUpdate` and `agentAccess` live in `project.json`, not in `DeviaConfig`.

## Gotchas

- `ELECTRON_RUN_AS_NODE` + wasm: `node:sqlite` (FTS5 + WAL) and `web-tree-sitter` work under Electron-as-Node straight from `app.asar` (no `asarUnpack`); `tsc` copies no assets, so `scripts/copy-assets.cjs` copies `wasm/*.wasm` and `db/*.sql` to `dist` (`watch:main`/`dev` skip it, hence the `resolveWasmDir` fallback to `src`). Never `import.meta` in `src/main` (CommonJS). Each tree-sitter `Tree` must be `delete()`d.
- Bump `EXTRACTION_VERSION` whenever an extractor changes what it stores, so old graphs re-index instead of drifting.
- The server id `devia-code-graph` is copied into the runner, `agents/shared/native-config-mcp.ts` and the Gemini def (features never import each other); `src/main/features/code-graph-server-id.test.ts` pins every copy.
- Parts of the engine are adapted from codegraph (MIT); see `NOTICE` (each adapted file starts with an attribution line, kept in sync by `tools/notice-code-graph.test.ts`).
- Perf budgets: full index ≤ 90 s, 1-file sync ≤ 500 ms, `graph_explore` ≤ 1 s, overview ≤ 300 ms, expand ≤ 200 ms, worker RSS ≤ 1.5 GB (`bestOf` + `perfBudget` in `engine/graph/test-graph.ts`).
- Adding a language: vendor the wasm and list it in `NOTICE`; map extensions in `grammars.ts` and add it to `CODE_GRAPH_LANGUAGES`; write `engine/extraction/languages/<lang>.ts` (+ `<lang>-types.ts`); one `registerExtractor` line in `registry.ts`; a `LanguageResolver` in `engine/resolution/languages/`; test conventions in `discovery/test-detection.ts`; fixtures, `receiver-types.test.ts`/`sync-parity.test.ts` rows, an oracle fixture, bump `EXTRACTION_VERSION`.

## Tests

`src/main/features/code-graph/**/*.test.ts` (incl. `sync-parity.test.ts`), `tools/code-graph/` (oracle, bench), `tools/i18n-code-graph-orphans.test.ts`, renderer specs.

## Related

[mcp.md](mcp.md), [split-view.md](split-view.md), [../reference/mcp-servers.md](../reference/mcp-servers.md)
