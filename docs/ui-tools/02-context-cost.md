# `devia-ui` — real context cost (S-25 F4.3)

**Status: NOT MEASURED.** Procedure and empty table below. Needs live runs, so
it is manual by design.

## Why measure again

`ui-tools-budget.test.ts` counts characters of the serialised `tools/list`
payload. That is the right guard for regressions but it is a proxy: it says
nothing about what the model's cached prefix actually grows by once the server
is delivered, the system prompt gains its announcement lines, and the agent's
own overhead is added.

## Method

Same project, same single instruction, three configurations. Claude, because it
reports context usage most reliably.

- **(a) baseline** — a build with S-24 `devia-ask` (`git checkout` the commit
  before `f63508ee`).
- **(b)** current build, **plan** mode.
- **(c)** current build, **apply** mode.

For each: read the context-usage % and token count from the S-7 `SessionStats`
rollup (the same numbers the footer shows), cross-checked against the raw stdout
log. Record the FIRST turn of a fresh session — later turns carry conversation
that has nothing to do with this.

## Results

| Config | prefix tokens | context % at turn 1 | delta vs (a) |
| --- | --- | --- | --- |
| (a) S-24 `devia-ask` | | | — |
| (b) S-25 plan | | | |
| (c) S-25 apply | | | |

Static measurement already on record (chars of `tools/list`): plan 2 891,
apply 4 180, remote 1 368, whole surface 4 817.

## Acceptance

- The delta of (b) and (c) versus (a) must stay **under 2 000 tokens**.
- If it does not: narrow the default policy in `ui-tools-policy.ts` — do not
  close the task by "documenting" the overshoot.
- Do **not** discount a `buildSkillRegistryHint` saving. S-25 F2.7 measured it
  and found the swap does not pay off, so the hint stays and there is nothing
  to subtract.
