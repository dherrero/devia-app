# Changelog

El formato sigue [Keep a Changelog](https://keepachangelog.com/es/1.1.0/)
y este proyecto se rige por [Semantic Versioning](https://semver.org/lang/es/).

## [2.0.0] — 2026-05-20

Primera versión "comercial" de Devia: incorpora la infraestructura de
distribución SaaS (login, gating Pro, paywall) y el endurecimiento de
runtime inspirado en hermes-agent (clasificación de errores, compresión
de contexto, abstracción de proveedores). Es una versión **major**
porque cambia contratos IPC consumidos por preload/renderer y porque
la app, por primera vez, distingue entre planes (Free vs Pro) en
funcionalidades visibles.

### Added — E-DSK-08 (Login + Free-by-default + Pro chunk gating)

- **Sync de la librería de auth desde devia-saas** (`#251`). Script
  `npm run sync:auth` materializa `renderer/app/libs/auth/` desde un
  checkout local de devia-saas (env `DEVIA_SAAS_REPO`), reescribiendo
  los imports `@dto` al mirror local `shared-auth-types.ts`. El árbol
  sincronizado está gitignorado y se regenera en `prebuild:renderer`.
- **Constante `DEVIA_SAAS_URL` baked-at-boot** (`#251`). Vive en
  `src-main/config/saas-url.ts` sin URL por defecto
  (vacía si `DEVIA_SAAS_URL` no está definida). Expuesta al
  renderer vía `bridge.saas.baseUrl()` (canal `saas:baseUrl`).
- **Toast de upgrade Pro** (`#258`). Componente standalone OnPush
  (`renderer/app/upgrade/upgrade-toast.component.ts`) + servicio
  signal-based que escucha el evento DOM `paywall-requested`. Debounce
  de 2 s para colapsar ráfagas en un único toast. El CTA abre
  `${DEVIA_SAAS_URL}/upgrade?feature=<feature>` en el navegador por
  defecto vía el nuevo IPC `shell:open-upgrade`.
- **Angular Router + chunks Pro obfuscados** (`#253`). El renderer
  pasa de bundle único a shell + `<router-outlet>`. El chat se lazy-
  loadea como ruta por defecto; las rutas Pro (`/pinned`,
  `/multi-execution`) emiten chunks `pro-*.js` que un post-build
  (`tools/obfuscate-pro-chunks.ts`) pasa por `javascript-obfuscator`
  en modo light. Smoke test (`tools/verify-pro-chunks.ts`) verifica
  que los chunks Pro existen, que `main.js` no filtra los nombres de
  clase, y que cada chunk lleva su marcador de obfuscation.

### Added — E-DSK-09 (Hermes-inspired hardening)

- **Taxonomía estructurada de errores de CLI** (`#262`). Tipo
  `FailoverReason` (9 acciones de recuperación) + `ClassifiedError`
  en `shared/domain/cli-errors.ts`, con tablas de matchers por CLI
  (`claude`, `codex`, `gemini`, `opencode`, `cursor-agent`,
  `copilot`, `qwen`, `deepseek`, `qoder`) más reglas genéricas. El
  evento `process:end` ahora viaja con `failoverReason` /
  `failoverHint` / `retryAfterSeconds`; el renderer dispara
  `paywall-requested` cuando llega `quota_exceeded` (engancha con
  `#258`). Portado de
  `hermes-agent/agent/error_classifier.py`.
- **Compresor de contexto para sesiones largas (Pro)** (`#263`).
  Módulo en `src-main/features/context-compression/` con
  `compress(history, client, opts)` iterativo (≤ 3 pasadas) que
  preserva el system prompt y los últimos K turnos verbatim y delega
  la suma de los del medio a un modelo auxiliar barato
  (`claude-haiku-4-5`). Fallback a truncación cuando la llamada
  auxiliar falla. LUT de tamaños de contexto por modelo en
  `shared/domain/context-budget.ts`. Plan gate stub en
  `plan-gate.ts` (reemplazable por `AuthService.hasPlan('pro')`
  cuando E-DSK-08 #252 mergee). Portado de
  `hermes-agent/agent/context_compressor.py` +
  `model_metadata.py`.
- **Abstracción `ProviderProfile` (estilo hermes)** (`#264`). Interface
  en `domain/provider-profile.ts` que colapsa los hooks que el runner
  necesita (`buildArgv`, `buildEnv`, `parseStreamLine`,
  `classifyError`, `supportedFeatures`) en una única vista por
  agente. La carpeta `profiles/` envuelve cada `RuntimeAgentDef`
  existente vía `toProviderProfile()`. Añadir un nuevo agente ahora
  es soltar un `RuntimeAgentDef` en el catálogo y el profile se
  materializa automáticamente. Portado de
  `hermes-agent/providers/base.py`.

### Added — E-DSK-10 (Spec Kit SDD integration)

- **Pre-flight env detector + installer + setup wizard** (`#266`).
  Detector `detectSpecKitEnv()` que verifica Python ≥ 3.11, Git, y
  la presencia de la CLI `specify` (preferentemente vía `uv tool`,
  con fallback a `pipx`). Cache en memoria con TTL de 5 min para
  evitar latencia repetida en el sidebar. Instalador con streaming
  de stdout/stderr al renderer (`speckit:install:status`) y soporte
  de cancelación. Wizard Material standalone OnPush
  (`renderer/app/spec-kit/setup-wizard.component.ts`) que muestra
  el estado del entorno, instrucciones específicas por OS para
  Python/Git, y un botón "Instalar" que delega al backend.
- **Toggle opcional de Spec Kit en /new y /newbase** (`#267`). Los
  modales de creación de proyecto añaden un `mat-checkbox` opt-in
  ("Inicializar Spec Kit en este proyecto"). El default sigue
  siendo **OFF**: el comportamiento histórico no cambia. Cuando se
  marca, tras crear el proyecto se ejecuta
  `specify init . --here --integration <key>` con la integración
  derivada del agente activo (Claude → `claude`, Codex → `codex`,
  Qoder → `qodercli`, etc.). DeepSeek y otros agentes sin
  integración upstream caen silenciosamente sin Spec Kit. Si el
  entorno no está listo, el checkbox se desactiva y se ofrece un
  enlace al setup wizard.
- **Sidebar Spec Kit con árbol + slash shortcuts** (`#268`). Nuevo
  panel `SpecSidebarComponent` que se muestra cuando el proyecto
  activo tiene `.specify/` inicializado. Lee el árbol de
  `specs/<NNN-slug>/{spec,plan,tasks,research}.md` + `contracts/`
  y la `constitution.md` del proyecto. fs.watch con debounce de
  300 ms en main → evento `speckit:tree:changed` al renderer, así
  los writes del agente (cuando ejecuta `/speckit.specify`,
  `/speckit.plan`, etc.) refrescan el árbol incrementalmente sin
  reload manual. Cada artefacto abre en un `mat-dialog` con
  markdown renderizado por el mismo pipeline marked + DOMPurify
  que las burbujas de chat. Barra de cinco botones
  (`/speckit.constitution`, `.specify`, `.clarify`, `.plan`,
  `.tasks`, `.implement`) que inyecta el comando en el composer;
  el separador (`-` para Claude, `.` para el resto) se aplica
  según el agente activo. Lector de artefactos sandboxeado a la
  raíz del proyecto (`readSpecArtifact` valida que el path
  resuelto siga dentro del proyecto antes de leer).

### Added — Soporte multi-ejecución por proyecto

- **Split-pane VS Code-like** (PR #66, branch
  `feat/multi-execution-per-project`). Cada proyecto puede tener 1 a
  4 ejecuciones de agente abiertas en paralelo, repartidas en hasta
  2 columnas × 2 filas. Cada ventana es una sesión Claude
  independiente, con su propia cola, su botón STOP, y sus mensajes
  separados. Iconos "dividir a la derecha" / "dividir
  horizontalmente" / "cerrar" por leaf. Layout persistido por
  proyecto en `~/.devia-app/projects/<hash>/{executions,panes}.json`.
  *(En revisión en PR #66 — no incluido aún en `next_release`.)*

### Changed — Internals

- `state.json` v2 — migración automática desde v1, soporte de
  `agentSessionId` por ejecución.
- `cli-launcher.onError` y `RunInstructionUseCase.onProcessEnd`
  ahora aceptan un parámetro `classifiedError?: ClassifiedError`
  opcional sin romper el contrato existente (la
  `ErrorClassification` legacy de 5 valores se mantiene mapeada vía
  `toLegacyClassification`).
- `auth-classifier.ts` (claude-runner) delega ahora al unificado
  `classify()` en lugar de mantener su propio matcher list. Los
  deep-link `devia://settings/agents/<id>` siguen viviendo aquí.
- `angular.json`: `namedChunks: true` en producción. Quitado
  `buildOptimizer: true` (rechazado por el builder esbuild de
  Angular 21).

### Dependencies

- `@angular/router@^21.2.13` (real dep, lo necesita la auth lib
  sincronizada y el router del shell).
- `tsx@^4.20.0` (devDep) para los scripts en TypeScript en
  `tools/`.
- `javascript-obfuscator@^4.2.2` (devDep) para el post-build de
  chunks Pro.

### IPC / contrato preload

Adiciones (compatibles con `1.0.0`):
- `saas:baseUrl` — `bridge.saas.baseUrl()`.
- `shell:open-upgrade` — `bridge.openUpgrade(feature)`.
- `process:end` payload gana `failoverReason`, `failoverHint`,
  `retryAfterSeconds`.
- `speckit:env-check`, `speckit:install`, `speckit:install:status`,
  `speckit:cancel-install`, `speckit:init`, `speckit:init:status`,
  `speckit:tree:get`, `speckit:tree:watch`, `speckit:tree:changed`,
  `speckit:artifact:read` — surface completa de Spec Kit
  (`bridge.speckit.*`).

### Tests

- 105 + N specs nuevos a través de los 9 tickets E-DSK:
  - `#251` 19 (sync auth lib).
  - `#258` 12 (toast service + build URL).
  - `#253` 5 (rutas + smoke chunks).
  - `#262` 66 (per-CLI matcher table).
  - `#263` 17 (compressor + plan gate).
  - `#264` 22 (provider profile golden snapshots + replays).
  - `#266` env detector + installer (spawn mockeado siempre,
    nunca se instala spec-kit en la máquina de tests).
  - `#267` init en `/new` y `/newbase` con mocking de `specify`.
  - `#268` tree reader (fixture en disco) + agent mapping.
- 2 specs heredados (audit-log + fs-session-store) siguen rojos —
  pre-existentes de PR #67, no introducidos por esta versión.

### Migración para usuarios

- Primera ejecución de `npm run sync:auth` requiere
  `DEVIA_SAAS_REPO` apuntando a un checkout local de devia-saas.
  Una vez sincronizada la primera vez, builds sucesivas reutilizan
  el árbol cacheado.
- `state.json` se migra de v1 a v2 automáticamente; no se requiere
  acción manual.
- Para forzar plan Pro en desarrollo, exportar
  `DEVIA_PLAN=pro`. Sin esa variable, el plan resuelve a Free.
- Para apuntar a otra instancia de devia-saas, exportar
  `DEVIA_SAAS_URL=https://saas.example.com` antes del build.

---

## [1.0.0] — 2026-05-19

Versión inicial pública. Multi-agent CLI (Claude Code, Codex,
Gemini, OpenCode, Cursor Agent, Copilot, Qwen, DeepSeek, Qoder),
splash screen con detección de agentes al arranque, RunLogger,
AskUserQuestion multi-turn, audit log, security hardening.
