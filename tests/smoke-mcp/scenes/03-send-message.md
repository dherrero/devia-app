# Scene 03 — Send message (golden path)

End-to-end smoke for the composer (HT-IN-01) and the messages feed
(HT-CH-03). Drives the input bar, fires the IPC, watches the streaming
bubble land, and snaps to the bottom.

## Setup
- Workspace configured.
- A project selected — pick the first one in the sidebar list.

## Steps

1. `mcp__electron__electron_click_by_selector` first row inside
   `.dsm-list .dsm-proj`.
2. `mcp__electron__electron_wait_for_selector` `ds-chat-panel`.
3. `mcp__electron__electron_fill_input`
   - selector: `ds-input-bar textarea`
   - text: `hola, smoke test`
4. `mcp__electron__electron_query_attribute_by_selector`
   - selector: `.ds-input-bar__send`
   - attribute: `data-disabled`
   - expect: missing / `null` (canSend = true).
5. `mcp__electron__electron_press_key` `Enter`.
6. `mcp__electron__electron_wait_for_selector`
   `ds-message-bubble.msg-user` (the just-sent bubble).
7. `mcp__electron__electron_wait_for_selector`
   `ds-chat-header dv-badge` (the "Ejecutando" badge appears).
8. Optional: wait for the streaming bubble to finish and assert it
   contains text. Skip on a flaky agent.
9. Assert auto-follow re-pinned: scroll position is at the bottom
   (`scrollHeight - scrollTop - clientHeight < 12`).

## Cleanup
- Click the `Nueva sesión` reset icon to wipe the session.
