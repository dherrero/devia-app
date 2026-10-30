# Scene 01 - Theme switcher

Verifies the two-button titlebar theme toggle (HT-C-02 / HT-TB-01) flips
mode and family, then persists the active theme across reloads. The wiring
should hit `ThemeService.setTheme` and update `<html data-theme>`.

## Setup
- App started via `npm run start:desktop`.
- Any project - the switcher works without one selected.

## Steps

1. `mcp__electron__electron_wait_for_selector` -> `dv-theme-toggle`.
2. Click the button with `aria-label="Cambiar a modo oscuro"`.
3. `mcp__electron__electron_query_attribute_by_selector`
   - selector: `html`
   - attribute: `data-theme`
   - expect: `dark`
4. Click the button with `aria-label="Cambiar a tema Navy"`.
5. `mcp__electron__electron_query_attribute_by_selector`
   - selector: `html`
   - attribute: `data-theme`
   - expect: `navy-dark`
6. Click the button with `aria-label="Cambiar a modo claro"`.
7. `mcp__electron__electron_query_attribute_by_selector`
   - selector: `html`
   - attribute: `data-theme`
   - expect: `navy`
8. `mcp__electron__electron_local_storage_get_item` `devia.theme`
   -> expect `navy`.
9. `mcp__electron__electron_send_keyboard_shortcut` -> `Control+R`
   (reload). After load, verify `<html data-theme="navy">` again.

## Cleanup
- Click the family button to restore Violet, then ensure light mode is active.
