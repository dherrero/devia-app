# Documentation conventions

These rules keep `docs/` accurate and cheap for an AI agent to read.

## Language and tone

- English only. No marketing, no narrative, no "we decided". State facts.
- Bullets over prose. One fact per bullet. Short sentences.
- History only where it explains a constraint, and then under `## Gotchas`.

## References

- Code references use repo-root-relative paths: `src/main/features/queue/application/queue-service.ts:QueueService`. Symbol after the colon, no line numbers (they rot).
- Every `src/...`, `tools/...`, `scripts/...` path in backticks must exist: `tools/docs-parity.test.ts` checks it.
- Link other pages with relative Markdown links. Links must resolve (also checked).
- Mark a claim you could not verify in code with the prefix `UNVERIFIED:`. Do not leave unverified claims unmarked.

## Truth

- Code wins over AGENTS.md and over this folder. When they disagree, fix the doc and note the discrepancy under `## Gotchas`.
- `Does NOT` entries are checked by searching the code (Grep / code graph), never inferred from absence in prose.
- Counts (languages, agents, channels, tools) are read from the source file that defines them.

## Page format

- Copy [features/_template.md](features/_template.md). Keep the 11 headings, in order. A section with nothing to say contains `None.`.
- First lines under the title: `Status:` and `Verified:` (sha of `dev`).
- Aim for at most ~150 lines. Longer topics get a folder `features/<name>/` with subpages and keep `features/<name>.md` as the entry page.
- Reference pages (`reference/`, `architecture/`) may use tables instead of the 11 headings but keep `Status:` and `Verified:`.

## Updating

- Change a feature → update its page, its row in [capabilities.md](capabilities.md) and the index in [README.md](README.md) in the same PR.
- New folder in `src/main/features/` → new page named after the folder.
- Update `Verified:` on every page you re-check.
- Do not copy code or long comments into docs; name the symbol and say what it does.
