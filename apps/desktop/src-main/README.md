# src-main — Proceso principal de Electron

Contiene toda la lógica del proceso principal: spawn de agentes CLI, persistencia en disco, manejo de IPC, git, docker y shell. Se compila de TypeScript a CommonJS (`tsconfig.main.json`) y se ejecuta en el contexto de Node.js nativo de Electron.

---

## Estructura

```
src-main/
├── shell/                   Puntos de entrada y cableado
│   ├── main.ts              Ciclo de vida de Electron (BrowserWindow, app events)
│   ├── preload.ts           contextBridge → window.devia
│   └── composition-root.ts  Wiring de features + registro de IPC handlers
│
├── shared/                  Código interno compartido entre features
│   ├── ports/               Interfaces de contratos (ConfigRepository, SessionStore, …)
│   ├── persistence/         Implementaciones genéricas (FsStateStore, …)
│   ├── feature.ts           Interfaz base Feature (register, onReady)
│   ├── workspace-paths.ts   resolveInsideWorkspace, isPathContained, validateLeafName
│   └── claude-defaults.ts   Constantes por defecto para Claude
│
└── features/                20 bounded contexts — uno por carpeta
```

---

## Puntos de entrada (`shell/`)

### `main.ts`
- Crea la `BrowserWindow` con `nodeIntegration: false`, `contextIsolation: true`.
- Configura el preload script.
- Registra manejadores de ciclo de vida: `app.on('ready')`, `will-quit`, `window-all-closed`.
- Carga `dist/renderer/browser/index.html`.

### `preload.ts`
- Expone `window.devia` mediante `contextBridge.exposeInMainWorld`.
- La forma del objeto está declarada en `shared/contracts/devia-bridge.ts`.
- Nunca añadir nada a `window` directamente — siempre a través del bridge.

### `composition-root.ts`
- Construye todas las dependencias (config, registry, sessions, queue, audit, …).
- Llama a `feature.register(ctx)` en cada feature para que registren sus IPC handlers.
- Llama a `feature.onReady()` tras `app.whenReady()`.
- Es el único fichero que importa todas las features.

---

## Features

Cada feature sigue la misma estructura interna:

```
features/<nombre>/
├── domain/          Tipos e interfaces propias de la feature
├── application/     Use cases (lógica de negocio, sin I/O directo)
├── infrastructure/  Implementaciones de puertos (fs, process, git, …)
└── ipc/             IPC handlers que delegan en los use cases
```

### `claude-runner`
Spawna y gestiona el proceso del agente CLI activo para cada proyecto.

- **`run-instruction.use-case.ts`**: minta un `RunId`, construye el entorno, inyecta el system prompt (via `stdin-prepend` o `argv` según el adaptador), lanza el CLI, gestiona el ciclo de vida completo.
- **`cli-runner-adapter.ts`**: puente entre el use case y el `CliLauncher`.
- **`system-prompt.ts`**: construye el prompt de sistema base (git context + tech stack).
- **IPC**: `runner:run`, `runner:stop`, `runner:stop-all`, `runner:cancel`.

### `cli-adapters`
Soporte multi-agente: Claude Code, Codex, Gemini, OpenCode, Cursor Agent, Copilot y adaptadores adaptados (Qwen, DeepSeek, Qoder).

**Subcarpetas clave:**

| Subcarpeta | Propósito |
|-----------|-----------|
| `infrastructure/defs/` | Definiciones estáticas de cada agente (`RuntimeAgentDef`) |
| `infrastructure/parsers/` | Parsers de stream: claude-stream-json, codex, gemini, opencode, copilot, cursor-agent |
| `infrastructure/detection/` | Detección de binarios en PATH, probing de versión y auth |
| `infrastructure/spawn-invocation.ts` | Escaping seguro de argumentos cmd.exe (Windows) |
| `infrastructure/kill-tree.ts` | Matar el árbol de procesos en Windows (`taskkill /T /F`) |
| `infrastructure/error-classifier.ts` | Clasifica errores de stderr en categorías tipadas |
| `infrastructure/resolve-cwd.ts` | Valida y resuelve el CWD del proyecto |
| `infrastructure/prompt-budget.ts` | Guarda de presupuesto de tokens en argv |
| `application/select-agent.use-case.ts` | Valida y persiste el agente seleccionado; rechaza providers no-CLI |

**`registry.ts`**: catálogo de todos los agentes en tres tiers:
1. CLI de primer nivel (Claude, Codex, Gemini, OpenCode, Cursor Agent, Copilot)
2. Adaptados con streaming plain-text (Qwen, DeepSeek, Qoder)
3. Planificados/informativos (APIs directas, MCP, local-model, ACP)

**IPC**: `agents:list`, `agent:select`, `agent:test`, `agent:set-model`, `agent:set-env`.

### `workspace`
Gestión de proyectos y configuración de usuario.

- **`fs-config-repository.ts`**: lee/escribe `~/.devia-app/devia-app.config.json`.
- **`fs-workspace-scanner.ts`**: escanea el workspace para listar proyectos git.
- **`fs-tech-detector.ts`**: detecta el tech stack (Node, Python, Gradle, Go, Rust, …).
- **`fs-bases-store.ts`**: plantillas «Nuevo desde base» en `bases.json`.
- **`node-project-file-system.ts`**: operaciones cross-platform de ficheros.
- **IPC**: `projects:list`, `projects:create`, `projects:delete`, `projects:rename`, `config:get`, `config:set`, `workspace:pick-folder`.

### `sessions`
Historial de chat por proyecto, persistido como JSON en `~/.devia-app/sessions/`.

- **`fs-session-store.ts`**: save/load/list con validación `parsePersistedSession()` en cada lectura y escritura. Guard de path traversal via `resolveInsideWorkspace`.
- **IPC**: `sessions:list`, `sessions:load`, `sessions:save`, `sessions:delete`, `sessions:switch`.

### `queue`
Cola de instrucciones por proyecto.

- Permite encolar prompts mientras el agente está ocupado.
- Persistida en `~/.devia-app/queue/<proyecto>/queue.json`.
- **IPC**: `queue:enqueue`, `queue:dequeue`, `queue:list`, `queue:reorder`, `queue:clear`, `queue:pause`, `queue:resume`.

### `terminal`
Terminal PTY real por proyecto vía `node-pty`.

- **`pty-manager.ts`**: crea, gestiona y destruye sesiones PTY.
- **IPC**: `terminal:start`, `terminal:write`, `terminal:resize`, `terminal:exit`.

### `git`
Contexto git para el system prompt y el UI.

- **`cli-git-syncer.ts`**: `git status`, `git diff`, `git pull`.
- **`fs-git-watcher.ts`**: vigila cambios para refrescar GitInfo.
- **`diff-parser.ts`**: parsea la salida de `git diff` a un `DiffResult` tipado.
- **IPC**: `git:info`, `git:diff`, `git:sync`, `git:watch-start`, `git:watch-stop`.

### `mcp`
Registro de servidores MCP para la integración de herramientas de Claude.

- **`registry.ts`**: catálogo en memoria; cargado desde `~/.devia-app/mcp-servers.json`.
- **`temp-config-writer.ts`**: escribe `tmp/mcp-<uuid>.json` para `claude --mcp-config`.
- **`index.ts`**: `sweepStaleMcpTempFiles()` al arrancar (limpia ficheros > 24h).
- **IPC**: `mcp:list`, `mcp:rescan`.

### `security`
Registro de auditoría de tool-calls.

- **`audit-log.ts`**: JSONL, rotación con timestamp (`audit.log.<YYYYMMDDTHHmmssZ>.jsonl`) al superar 1 MiB. Limpieza de backups > 30 días.
- **IPC**: `audit:read-last`, `audit:export`.

### `prompt-packs`
Sistema de prompt packs (prompts de sistema por proyecto).

- **`scanner.ts`**: escanea directorios buscando `<id>/PACK.md`. Guard de symlinks con `lstatSync`.
- **`registry.ts`**: catálogo en memoria de packs disponibles.
- **`compose-system-prompt.ts`**: compone el system prompt final (baseline + packs).

### `project-tree`
Árbol de ficheros del proyecto para el raíl derecho.

- **`fs-project-tree-reader.ts`**: lee el árbol de ficheros con respeto a `.gitignore`.
- **IPC**: `project-tree:read`.

### `skills`
Descubrimiento e instalación de skills para los agentes.

- Descubrimiento desde GitHub (`SKILL.md` frontmatter).
- Instalación local y gestión de caché.
- **IPC**: `skills:discover`, `skills:install`, `skills:list`, `skills:remove`.

---

## Puertos compartidos (`shared/ports/`)

Las features se comunican entre sí exclusivamente a través de interfaces:

| Puerto | Propósito |
|--------|-----------|
| `ConfigRepository` | Leer/escribir la configuración del usuario |
| `SessionStore` | Persistir y recuperar sesiones de chat |
| `ProjectRegistry` | Registro en memoria de proyectos activos y sus procesos |
| `OutboxFlusher` | Vaciar la bandeja de salida de un proyecto |
| `AttachmentEnricher` | Enriquecer metadatos de adjuntos |
| `GitInspector` | Acceder al contexto git del proyecto |
| `StateStore` | Persistencia genérica de estado de runtime |
| `PinnedStore` | Gestión de proyectos anclados en la sidebar |

---

## Seguridad del sistema de ficheros

Todas las rutas suministradas desde el renderer pasan por:

1. **`resolveInsideWorkspace(config, relPath)`** — normaliza con `path.resolve`, rechaza `..` y paths absolutos fuera del workspace.
2. **`validateLeafName(raw)`** — rechaza nombres con `/`, `\`, `.`, `..` o vacíos.
3. **`lstatSync` + `isSymbolicLink()`** — el scanner de prompt packs no sigue symlinks.
4. **`parsePersistedSession(value)`** — valida la estructura JSON antes de deserializar.
5. **`classifyDetectionError(err)`** — convierte errores del OS en etiquetas seguras antes de enviarlos al renderer (sin paths absolutos).

---

## Tests

```bash
npm run test:main        # Vitest, env node
npm run test:coverage    # Con cobertura v8
```

- Cada feature tiene su propio `*.test.ts` junto a la implementación.
- Los tests usan fakes en memoria — nunca se spawnean CLIs reales (Claude, Codex, etc.).
- Los parsers de stream tienen cobertura > 80 % medida por v8.

---

## Añadir una nueva feature

1. Crea `src-main/features/<nombre>/` con las subcarpetas necesarias.
2. Exporta una función `buildXxxFeature(deps): XxxFeatureBuilt`.
3. Registra en `composition-root.ts`.
4. Añade los canales IPC a `shared/contracts/ipc-channels.ts`.
5. Declara los métodos en `shared/contracts/devia-bridge.ts`.
6. Implementa el wrapper en `renderer/app/electron-api.service.ts`.
