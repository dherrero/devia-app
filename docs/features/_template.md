# <Feature name>

Status: implemented | partial | deprecated
Verified: <sha of dev the page was checked against>

## Purpose

One or two sentences: what problem it solves and who triggers it (user, agent, system).

## Does

Bulleted, verifiable capabilities. One fact per bullet. Name the real symbols.

## Does NOT

Capabilities a reader might assume exist but do not. Each one verified against code (search, not memory). Include limits and unsupported agents/platforms.

## Entry points

`path/from/repo/root.ts:symbol` — one line each, with a 3-6 word role. Main-process feature folder first, then shared/domain, then renderer.

## IPC / MCP surface

IPC channels (names from `src/shared/contracts/ipc-channels.ts`) and MCP tool names (from the tool registry). `None.` when there are none.

## Persistence

Paths under `~/.devia-app/` (or the project) and the file format. `None.` when stateless.

## Config

`DeviaConfig` keys (see `src/shared/domain/config.ts`), env vars and per-project settings that change behaviour. `None.` when there are none.

## Gotchas

Non-obvious constraints, invariants, past failures, AGENTS.md-vs-code discrepancies. Keep the WHY.

## Tests

Where the behaviour is pinned (test file paths) and what is NOT covered.

## Related

Links to other pages in this folder and deep-dive docs.
