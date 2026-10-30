# Scene 05 — Queue pause / resume / SIGUIENTE pill

Exercises the per-project queue panel (HT-QP-01). Verifies enqueue when
busy, pause flips the SIGUIENTE pill off, resume flips it back on.

## Setup
- A project selected.
- An agent invocation already in flight (Scene 03 leaves one if you
  skipped the cleanup).

## Steps

1. Send a second instruction while the agent is busy:
   - `mcp__electron__electron_fill_input` `ds-input-bar textarea`
     `segundo mensaje encolado`
   - `mcp__electron__electron_press_key` `Enter`.
2. `mcp__electron__electron_wait_for_selector` `ds-queue-panel`.
3. `mcp__electron__electron_query_text_by_selector`
   - selector: `.ds-queue-row.is-next .next-pill`
   - expect: `SIGUIENTE`.
4. `mcp__electron__electron_click_by_text` → `Pausar`.
5. `mcp__electron__electron_wait_for_selector` `.ds-queue-banner`.
6. `mcp__electron__electron_query_visible_by_selector`
   - selector: `.ds-queue-row.is-next .next-pill`
   - expect: `false` (pill gone while paused).
7. `mcp__electron__electron_click_by_text` → `Reanudar`.
8. Queue empties as items get dispatched.

## Cleanup
- Click `Limpiar` twice to flush any leftovers.
