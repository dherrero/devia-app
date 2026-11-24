# Devia Method — design (S-39)

Status: implemented (design record)
Verified: b08bff62130756f1e2eb66ac2578efbef65c2823

Decisions D1–D5 approved 2026-11-04. See [00-audit.md](00-audit.md) for the skill-by-skill matrix.

## D1 · Provenance: vendored literal + own with trail

```
resources/kits/devia-method/
  kit.json                  id, version, bootstrap, skill index (name + trigger), disposition
  UPSTREAM.md               per skill: upstream path, sha at fork, disposition, what changes and why
  LICENSE                   the starting project's MIT license; root NOTICE carries attribution
  skills/<name>/…           literal (copied from the pin, hash verified) and own (provenance in `UPSTREAM.md`, generated from `kit.json`)
  VERSION.json              pin of the upstream the literals come from
```

- **Literal** skills are regenerated with `npm run vendor:upstream` and their hash is verified; bumping a version is a re-vendor.
- **Own** skills are never overwritten. `npm run kit:upstream-diff -- --tag vX` compares upstream at the fork sha with the new tag for each own skill and shows the diff, so improvements are ported by hand (with judgement, not blindly).

## D2 · Name and license

"Devia Method", kit `devia-method`. Skill names stay plain (`brainstorming`, `writing-plans`…) except the replacements (`using-devia`, `isolating-work`, `finishing-work`). MIT requires keeping copyright and license in copies and derivative works: kit `LICENSE` + root `NOTICE`. The final product is Devia's and is not presented as the original project.

## D3 · One bootstrap path

The bootstrap (`using-devia`) reaches **every agent through Devia's system prompt**, Claude included. Claude keeps `--plugin-dir` only for native skill discovery (its `Skill` tool + descriptions), **without `hooks/`**. One path gives uniform behaviour, is testable the same way on all five agents and removes the double-injection risk.

## D4 · The kanban as state

Spec = approved design. Tasks = plan. Task thread = ledger. `kanban_close_task(commit)` = "task complete". Memory keeps decisions and bugs. `devia_todo` is the live view. There are no plan or ledger files. Resuming (after compaction or with another agent) is `kanban_list` + `git log`.

## D5 · One sequence in plan mode

With the method active, Devia's plan protocol stops ordering "explore → persist" on its own and delegates to the method's sequence: `brainstorming` → approved design → plan on the kanban → `devia_plan_approve` → apply. Without the method it stays as before (byte-identical). This replaces S-38's translation table, which left two instructions competing.

## Quality

1. **Kit lint** (cheap, in `npm test`): own skills contain no `TodoWrite`, `AskUserQuestion`, `PLAN_FILE`, `docs/` plan paths, namespace prefixes or the starting project's name; every `devia_*` / `kanban_*` / `mem_*` tool they name exists in Devia's registries; the manifest covers all skills and vice versa; literals still match their pin.
2. **Behaviour evals** (T-426): multi-turn with a simulated user and assertions on tool calls; never in CI.

## What does not change from S-38

Per-version materializer, `StarterKitsPort`, native-install detection, per-agent delivery, `devia_skill` with support files and the skill directory, the Gemini fix, OpenCode `readDirs`, the Settings UI.

## Related

- [00-audit.md](00-audit.md), [02-agents.md](02-agents.md), [../features/starter-kits.md](../features/starter-kits.md)
