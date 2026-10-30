# Scene 04 — Mode bar Plan / Apply / YOLO

Verifies the mode bar (HT-MD-01) updates `state.runMode` and the
statusbar pill (HT-ST-01) mirrors it. YOLO must paint danger.

## Setup
- A project selected.
- Chat view active.

## Steps

1. `mcp__electron__electron_click_by_text` → `Plan` inside
   `ds-mode-bar`.
2. `mcp__electron__electron_query_attribute_by_selector`
   - selector: `ds-mode-bar .ds-mode-bar__seg[aria-label="Modo Plan"]`
   - attribute: `aria-pressed`
   - expect: `true`.
3. `mcp__electron__electron_query_text_by_selector`
   - selector: `ds-statusbar .pill[data-tone]`
   - expect: contains `Plan`.
4. `mcp__electron__electron_click_by_text` → `YOLO`.
5. `mcp__electron__electron_query_attribute_by_selector`
   - selector: `ds-statusbar .pill`
   - attribute: `data-tone`
   - expect: `danger`.
6. `mcp__electron__electron_click_by_text` → `Apply`.

## Cleanup
- None (Apply is the default).
