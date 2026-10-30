# Scene 08 — Settings modal open / close

Verifies the kebab menu, the dialog wiring and that the modal closes
without freezing the underlying chat.

## Setup
- Any project (or none).

## Steps

1. `mcp__electron__electron_click_by_selector`
   `ds-titlebar dv-menu button[dsMenuTriggerButton]` (the kebab button).
2. `mcp__electron__electron_wait_for_selector`
   `[role="menu"]`.
3. `mcp__electron__electron_click_by_text` → `Configuración`.
4. `mcp__electron__electron_wait_for_selector`
   `ds-settings-modal, ds-modal-shell`.
5. `mcp__electron__electron_query_text_by_selector`
   `ds-modal-shell h2, ds-modal-shell header`
   → expect contains `Configuración`.
6. `mcp__electron__electron_press_key` `Escape`.
7. `mcp__electron__electron_wait_for_function`
   `() => !document.querySelector('ds-modal-shell')`.
8. Re-open via kebab again; verify the modal mounts a second time
   without leaking state.

## Cleanup
- Press Escape if the modal is still open.
