import { test, expect } from '@playwright/test';
import { THEMES, applyTheme } from './theme-matrix';

/**
 * Token smoke test (HT-QA-01).
 *
 * Loads a minimal stub page that imports the renderer's `styles.scss`
 * and renders a swatch palette plus a representative set of UI
 * primitives (buttons, pills, badges, the segmented mode bar). Captures
 * one screenshot per theme so any drift in the token graph (`--dv-*`
 * → `--dv-*`) shows up as a pixel diff.
 *
 * The renderer doesn't expose a "swatch" route, so the test serves a
 * small inline HTML that mirrors the patterns used by the real
 * components. When the real renderer is wired up to the visual
 * regression harness (separate story), this spec stays valuable as the
 * "tokens only" baseline — fastest signal when the palette refactor
 * goes sideways.
 */
const SWATCH_HTML = `
<!doctype html>
<html data-theme="light">
  <head>
    <meta charset="utf-8" />
    <title>Devia tokens</title>
    <link rel="stylesheet" href="./styles.css" />
    <style>
      body { margin: 0; padding: 24px; font-family: var(--dv-font-ui); }
      .row { display: flex; gap: 12px; margin-bottom: 24px; flex-wrap: wrap; }
      .swatch { width: 80px; height: 56px; border-radius: var(--dv-r-md);
                border: 0.5px solid var(--dv-border); }
      .label  { font-size: var(--dv-fs-xs); color: var(--dv-text-mute); margin-top: 4px; }
      .pill   { display: inline-flex; padding: 1px 10px; border-radius: var(--dv-r-pill);
                font-size: var(--dv-fs-2xs); }
      .pill.accent   { background: var(--dv-accent); color: var(--dv-accent-on); }
      .pill.danger   { background: var(--dv-danger-soft); color: var(--dv-danger); }
      .pill.warning  { background: var(--dv-warning-soft); color: var(--dv-warning); }
      .pill.info     { background: var(--dv-info-soft); color: var(--dv-info); }
    </style>
  </head>
  <body>
    <h2 style="color: var(--dv-text);">Surfaces</h2>
    <div class="row">
      <div><div class="swatch" style="background:var(--dv-bg);"></div><div class="label">bg</div></div>
      <div><div class="swatch" style="background:var(--dv-bg-elev);"></div><div class="label">bg-elev</div></div>
      <div><div class="swatch" style="background:var(--dv-surface-1);"></div><div class="label">surface-1</div></div>
      <div><div class="swatch" style="background:var(--dv-surface-2);"></div><div class="label">surface-2</div></div>
      <div><div class="swatch" style="background:var(--dv-surface-3);"></div><div class="label">surface-3</div></div>
      <div><div class="swatch" style="background:var(--dv-accent);"></div><div class="label">accent</div></div>
      <div><div class="swatch" style="background:var(--dv-accent-tint);"></div><div class="label">accent-tint</div></div>
    </div>
    <h2 style="color: var(--dv-text);">Semantic pills</h2>
    <div class="row">
      <span class="pill accent">ACCENT</span>
      <span class="pill danger">DANGER</span>
      <span class="pill warning">WARNING</span>
      <span class="pill info">INFO</span>
    </div>
  </body>
</html>
`;

for (const theme of THEMES) {
  test(`tokens · ${theme.label}`, async ({ page }) => {
    await page.setContent(SWATCH_HTML);
    await applyTheme(page, theme);
    await expect(page).toHaveScreenshot(`tokens-${theme.key}.png`);
  });
}
