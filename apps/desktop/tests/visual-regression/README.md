# Visual regression suite — Devia Desktop (HT-QA-01)

This directory holds the Playwright-based visual diff suite that guards the
desktop renderer against unintended UI changes. It is **opt-in**: not part of
`nx test desktop` so a missing browser binary or a slow CI agent doesn't block
the regular pipeline.

## Running locally

```bash
# One-time: download the browser binaries playwright needs.
npx playwright install chromium

# From the repo root:
npx playwright test --config apps/desktop/tests/visual-regression/playwright.config.ts
```

The first run captures a baseline screenshot per assertion into
`__screenshots__/` next to each spec. Commit those files; subsequent runs
diff against them and fail on a > 5 % pixel delta.

## Goldens

The 14 OpenDesign references live in `docs/od-design/ds-desktop-*.png`. They
are *not* the Playwright goldens — they are the design source-of-truth. Our
goldens capture the actual rendered Devia desktop in the same 4 themes and
let us detect drift between releases. A separate "golden refresh" job will
diff our goldens against the OpenDesign references periodically.

## Theme matrix

Each spec exercises the four canonical themes that ship with the desktop:

| Theme key    | data-theme  |
| ------------ | ----------- |
| violet-light | `light`     |
| violet-dark  | `dark`      |
| navy-light   | `navy`      |
| navy-dark    | `navy-dark` |

The Playwright runner uses Chromium headless against a static build of the
renderer (no Electron main). Components that depend on `window.devia`
(IPC bridge) are stubbed via the `setupBridgeStubs.ts` fixture so the diff
remains deterministic.

## When this runs in CI

Not yet — the suite needs goldens committed before it can fail meaningfully.
After capturing the initial baseline locally, add a `desktop:visual-regression`
nx target and wire it as a separate GitHub Actions job that uploads diff
artefacts on failure.
