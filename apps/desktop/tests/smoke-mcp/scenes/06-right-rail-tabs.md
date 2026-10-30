# Scene 06 — Right rail tabs (terminal / tree / docker)

Verifies the activity bar (HT-RR-01) toggles each pane and the splitter
geometry persists.

## Setup
- A project selected (Docker tab only appears when Docker is available).

## Steps

1. `mcp__electron__electron_send_keyboard_shortcut` `Control+J`
   (terminal toggle).
2. `mcp__electron__electron_wait_for_selector` `ds-terminal-panel`.
3. `mcp__electron__electron_send_keyboard_shortcut`
   `Control+Shift+E` (tree toggle).
4. `mcp__electron__electron_wait_for_selector` `ds-project-tree`.
5. Click a file in the tree; the chat panel should switch to the
   Cambios tab automatically.
   - `mcp__electron__electron_query_attribute_by_selector`
     `ds-chat-header dv-tabs button[aria-selected="true"]`
     `id` → expect `tab-changes`.
6. `mcp__electron__electron_click_by_text` → `Chat` (back to chat).
7. Toggle terminal off via `Ctrl+J`.

## Cleanup
- Toggle tree off via `Ctrl+Shift+E`.
