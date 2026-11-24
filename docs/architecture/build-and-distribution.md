# Build, packaging and distribution

Status: implemented
Verified: b08bff62130756f1e2eb66ac2578efbef65c2823 (app version 0.39.0)

## Toolchain

- Single npm project at the repository root (no monorepo tooling). Node `>=26.13.0` (`.nvmrc` = 26.13.0), npm `>=11.11.0`. Electron 41 (`build.electronVersion` 41.7.0 pinned explicitly, devDependency `^41.4.0`: keep them in sync when bumping).
- Main process: `tsc -p tsconfig.main.json` + `node scripts/copy-assets.cjs` (copies code-graph `wasm/*.wasm`, `db/*.sql` and the code-mode `ts-libs.json` into `dist`). Renderer: `ng build --project devia-renderer --configuration=production`.
- Runtime `dependencies` (what gets packaged): `@agentclientprotocol/sdk`, `electron-updater`, `node-pty`, `quickjs-emscripten`, `typescript`, `web-tree-sitter`, `zod`. Everything the Angular build bundles is a `devDependency` on purpose; anything the main process imports at runtime must be in `dependencies` (note: `@xenova/transformers`, imported dynamically by voice and memory re-rank, is a devDependency; see [../features/voice.md](../features/voice.md)).
- `node-pty` is rebuilt for the Electron ABI by `scripts/rebuild-native.cjs` (postinstall).

## Scripts (`package.json`)

`npm run dev` (tsc watch + ng build watch + Electron `--dev`), `dev:live` (renderer from `ng serve` on :4300), `start`, `build`, `typecheck` (both tsconfigs; does NOT compile Angular templates, `build` does), `lint`, `test` (main + renderer + libs), `test:coverage`, `pack`, `pack:dir` (unsigned, in `release/`), `pack:mac|win|linux`, `audit:runtime`, `vendor:upstream`, `kit:build`, `check:kits`. Startup race: run `npm run build` BEFORE `npm run dev`, because main does not hot-reload and the first tsc pass finishes after Electron boots.

## Packaging (electron-builder, config in `package.json` → `build`)

- `files`: `dist/main/**`, `dist/renderer/**`, `package.json`, minus `*.map` and `*.ts` (the `!**/*.ts` rule also strips every `.d.ts`; see code-mode).
- `extraResources`: icon and the kits directory (outside the asar: executable scripts).
- Targets: macOS (`hardenedRuntime`, `gatekeeperAssess: false`, `notarize: true`, entitlements `build/entitlements.mac.plist` for both `entitlements` and `entitlementsInherit`), Windows `nsis` x64, Linux `AppImage` + `deb` x64.
- Do NOT rename the package (`devia-app`): the userData folder derives from it.
- Anything shipped in the app (new runtime dependency, wasm/asset, worker or MCP entry file) needs `npm run pack:dir` and a launch of the unpacked app before a PR.
- The packaged `app.asar` holds only `dist/main`, `dist/renderer` and `package.json` (~27 MB since S-44).
- macOS signing: identity auto-detected from the login keychain; notarization needs `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID` or `APPLE_API_KEY` + `APPLE_API_KEY_ID` + `APPLE_API_ISSUER`; with none present it signs but skips notarization silently.

## Distribution and updates

- Open source (Apache-2.0) in `dherrero/devia-app`; binaries are published from a separate public repo `dherrero/devia` (landing + Releases). `build.publish` is one `github` provider (`owner: dherrero`, `repo: devia`, `releaseType: release`); do NOT change it or move the landing's `updates/latest.json`: every shipped build points at them.
- In-app updater: [../features/auto-update.md](../features/auto-update.md).

## CI and release (`.github/workflows/`)

- `ci-dev.yml` (PRs and pushes to `dev`: typecheck, lint, unit tests, as parallel jobs). Branch protection on `dev` requires the check `Dev · Typecheck · Lint · Test`, the `gate` job that aggregates the others: keep that name or update the rule.
- `ci.yml` (PRs/pushes to `main`): adds coverage, build and runtime audit.
- `paths-ignore` (`**.md`, `docs/**`) applies to every trigger except `pull_request` on `dev`, so docs-only PRs still report the required check.
- `release.yml` bumps the version from Conventional Commits and tags; a push to `main` with a `feat:` message triggers a release (use `chore:` for CI-only changes).
- `desktop-release.yml` runs after it (`workflow_run`): a `gate` job skips when that version already has installers in `dherrero/devia`; a `build` matrix (macOS/Windows/Linux, `max-parallel: 1`) syncs `package.json` to the tag, runs `npm run build`, packages and uploads to the Release; a final `manifest` job regenerates `updates/latest.json` via `scripts/gen-update-manifest.mjs` (the integrity feed the app verifies is `latest*.yml`).
- Repository secrets (maintainers): `PUBLIC_REPO_TOKEN`, `MAC_CSC_LINK` (base64 `.p12`) + `MAC_CSC_KEY_PASSWORD`, `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`; `DEVIA_SAAS_URL` optional (unset: the upgrade deep link does nothing).

## Related

- [../features/auto-update.md](../features/auto-update.md), [../features/code-mode.md](../features/code-mode.md), [../features/code-graph.md](../features/code-graph.md), [../../AGENTS.md](../../AGENTS.md)
