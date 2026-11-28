# Auto-update

Status: implemented
Verified: b08bff62130756f1e2eb66ac2578efbef65c2823

## Purpose

In-app update of installed builds through electron-updater.

## Does

- `buildAutoUpdateFeature()` (`src/main/features/auto-update/index.ts`) wraps `autoUpdater` (`autoDownload` + `autoInstallOnAppQuit`); it is a no-op unless `app.isPackaged`. It checks 10 s after ready and every 6 h, maps updater events to `UpdateStatus` (`src/shared/domain/update.ts`) and pushes `update:status`.
- Renderer (`AppComponent` + `ElectronApiService.onUpdateStatus`): a passive "downloading" toast on `available`, a "restart to install" action toast on `downloaded` (`update:install` → `quitAndInstall`).
- Updates come from the public repo `dherrero/devia` Releases (`build.publish`, one `github` provider); the updater is injectable (`buildAutoUpdateFeature({ updater, isPackaged })`) for tests.

## Does NOT

- Does NOT update the unpackaged dev app (the check would throw).
- Does NOT auto-update Linux `.deb` installs: only the AppImage target (a failed check surfaces as an `error` status, never a crash).
- Does NOT let you change `build.publish` owner/repo or move `updates/latest.json` without breaking every shipped build.

## Entry points

- `src/main/features/auto-update/index.ts:buildAutoUpdateFeature`
- `src/shared/domain/update.ts` — status type
- `package.json` — `build.publish`

## IPC / MCP surface

- `update:check`, `update:install`, `update:status`.

## Persistence

electron-updater cache (library default).

## Config

None.

## Gotchas

- Release pipeline and secrets: [../architecture/build-and-distribution.md](../architecture/build-and-distribution.md).

## Tests

`src/main/features/auto-update/**/*.test.ts`.

## Related

[../architecture/build-and-distribution.md](../architecture/build-and-distribution.md)
