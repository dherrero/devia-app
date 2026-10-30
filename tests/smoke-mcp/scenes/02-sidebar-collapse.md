# Scene 02 — Sidebar collapse + drag

Verifies the global `Ctrl+B` shortcut and the floating collapse toggle
(HT-S-01 / HT-SB-01). Also exercises the splitter drag so the persisted
width round-trips.

## Setup
- Sidebar visible (default).

## Steps

1. `mcp__electron__electron_query_visible_by_selector` `ds-sidebar`
   → expect `true`.
2. `mcp__electron__electron_send_keyboard_shortcut` → `Control+B`.
3. `mcp__electron__electron_wait_for_function`
   ```
   () => document.querySelector('.dsm-main')
            .style.gridTemplateColumns.startsWith('0px')
   ```
4. `mcp__electron__electron_send_keyboard_shortcut` → `Control+B`.
5. `mcp__electron__electron_wait_for_function`
   ```
   () => !document.querySelector('.dsm-main')
            .style.gridTemplateColumns.startsWith('0px')
   ```
6. Drag the splitter from x=280 to x=350:
   - `mcp__electron__electron_drag_from_to`
   - from selector: `.dsm-vsplitter`
   - to coords: `(350, 200)`
7. `mcp__electron__electron_local_storage_get_item` `devia:sidebar:widthPx`
   → expect value close to `350`.

## Cleanup
- Double-click `.dsm-vsplitter` to reset.
