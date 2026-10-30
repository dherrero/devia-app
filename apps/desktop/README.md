# Devia

Aplicación de escritorio para vibe-coding con agentes CLI. Devia es una interfaz gráfica que permite crear, gestionar y desplegar proyectos software conversando con agentes CLI como Claude Code, Codex, Gemini, OpenCode, Cursor o Copilot desde una sola ventana, sin terminal y sin nube.

---

## Índice de documentación

| Módulo | Descripción |
|--------|-------------|
| [src-main/](src-main/README.md) | Proceso principal de Electron: spawn de agentes, IPC, persistencia |
| [renderer/](renderer/README.md) | SPA Angular 21: componentes, señales, temas, i18n |
| [shared/](shared/README.md) | Tipos de dominio y contratos IPC compartidos entre procesos |
| [docs/](docs/) | Planes técnicos, historias y decisiones de arquitectura |

---

## ¿Qué hace Devia?

- **Gestión de proyectos**: listar, crear (vacío o desde plantilla), clonar repos externos, organizar en carpetas del workspace y anclar favoritos en la barra lateral.
- **Ejecución de agentes CLI**: Claude Code, Codex, Gemini CLI, OpenCode, Cursor Agent, GitHub Copilot, Qwen, DeepSeek y Qoder — uno por proyecto en paralelo. Los proveedores no-CLI (API, MCP, modelo local) se registran solo para visibilidad y no pueden seleccionarse como agente activo.
- **Modos de ejecución**: selector plan / apply / apply-yolo en el compositor que ajusta los permisos del agente por instrucción.
- **Sesiones persistentes**: el historial de chat sobrevive reinicios; continúa o reinicia sesión con un click.
- **Traspaso de contexto entre agentes**: cada sesión recuerda qué agente la inició (badge en la barra lateral); al continuarla con otro agente, Devia inyecta automáticamente un resumen del trabajo (objetivo, ficheros tocados y últimos intercambios) en su primer turno, lo registra en la memoria interna y deja un divisor en el chat. Opcionalmente comprime el historial con el modelo auxiliar o pide al agente anterior un resumen rico antes de cambiar. Las sesiones del split pueden adoptarse en cualquier panel y los cambios/borrados de sesión se bloquean mientras un agente trabaja en ella.
- **Vista dividida multi-sesión**: hasta 4 paneles (2×2) en la misma ventana, cada uno con su propia sesión y agente trabajando en paralelo; abre una sesión existente en el panel enfocado o escribe en un panel vacío para crear una nueva, con badge «Panel» en la barra lateral y resaltado del panel con foco. Cada panel adicional trabaja **aislado en su propio git worktree** (rama nueva desde la rama principal del repo) para que dos agentes nunca pisen los mismos ficheros; el split y sus worktrees sobreviven al reinicio de la app, recuperando los ficheros de cada sesión.
- **Compresión de contexto**: resume automáticamente el historial largo con un modelo auxiliar barato (Haiku / GPT-5-mini / Gemini-Flash) para no agotar la ventana de contexto, con fallback a truncado.
- **Cola de instrucciones**: encola prompts mientras el agente está ocupado; reordena con drag-drop, pausa/reanuda.
- **Planificador SDD / Kanban**: flujo spec-driven con tablero Kanban por proyecto; el planner descompone el objetivo en tareas y dirige al agente. El estado vive en `~/.devia-app/projects/<key>/kanban.json`, nunca dentro del repo.
- **Sub-agentes**: gestor de sub-agentes multi-CLI — instala, importa y elimina sub-agentes reutilizables entre proyectos.
- **Servidores MCP**: registro, instalación y prueba de servidores Model Context Protocol; se inyectan en las ejecuciones de Claude vía `--mcp-config`.
- **Skills**: descubre e instala habilidades para los agentes desde GitHub.
- **Prompt Packs**: sistema de prompts de sistema por proyecto.
- **Terminal integrado**: xterm.js con PTY real por proyecto.
- **Visor de diff Git**: ve los cambios del agente en línea en cada burbuja de mensaje.
- **Snapshots y rollback**: instantáneas de configuración y archivos antes de operaciones destructivas, con restauración, anclado y retención automática.
- **Transcripción de voz**: input por dictado vía Whisper (@xenova/transformers), todo local.
- **Archivos adjuntos**: imagen drag-drop para modelos multimodales.
- **Outbox**: archivos generados por el agente archivados bajo `~/.devia-app/outbox-archive/`.
- **Panel de árbol de proyecto**: navegador de archivos en el raíl derecho.
- **Docker Compose**: deploy / down / logs por proyecto.
- **Registro de auditoría**: traza de cada tool-call en JSONL (`audit.log`) con rotación por timestamp y retención de 30 días.
- **Internacionalización**: 10 idiomas (es, en, fr, de, pt, it, ar, hi, zh, ru).
- **Temas**: 8 paletas de acento Material 3, tamaño de fuente ajustable.

---

## Stack técnico

| Capa | Tecnología |
|------|-----------|
| Contenedor | Electron 41 |
| Proceso principal | Node.js · TypeScript 5.9 → CommonJS |
| Interfaz | Angular 21 · Angular Material 3 · TypeScript 5.9 |
| Estilos | SCSS · tokens `--dv-*` · tema oscuro M3 |
| Estado UI | Signals + computed (sin RxJS) · OnPush |
| Renderizado Markdown | marked 18 + DOMPurify 3 |
| Terminal | xterm.js 5.5 + node-pty 1.1 |
| Voz | @xenova/transformers 2.17 (Whisper, local) |
| i18n | @ngx-translate/core 15 |
| Tests | Vitest 4 (node env para main, jsdom + @analogjs/vitest-angular para renderer) |
| Build | tsc (main) · Angular CLI (renderer) · electron-builder (paquete) |

---

## Instalación y desarrollo

```bash
git clone <repo>
cd devia-app
npm install

# Arrancar en modo desarrollo
npm run dev                # build + Electron con DevTools

# Iteración rápida del renderer
npm run watch:renderer     # en terminal 1 — rebuild incremental
npm run dev                # en terminal 2 — recargar ventana con Ctrl+R

# Iteración del main process
npm run watch:main         # en terminal 1 — rebuild incremental
# Reiniciar Electron para recoger cambios del main
```

### Scripts disponibles

```bash
# Desarrollo
npm start              # build + Electron
npm run dev            # build + Electron con DevTools + logging

# Build individual
npm run build          # ambos (main + renderer)
npm run build:main     # tsc -p tsconfig.main.json
npm run build:renderer # ng build --configuration production

# Tests
npm test               # ambas suites (main + renderer)
npm run test:main      # sólo src-main (Vitest, env node)
npm run test:renderer  # sólo renderer (Vitest, env jsdom + Angular)
npm run test:coverage  # cobertura

# Calidad
npm run typecheck      # tsc --noEmit en ambos tsconfigs

# Distribución
npm run pack           # build + electron-builder --dir (sin instalar)
npm run dist           # build + electron-builder (instalable)
npm run dist:win       # build + electron-builder --win
npm run dist:mac       # build + electron-builder --mac
npm run dist:linux     # build + electron-builder --linux
```

---

## Arquitectura general

```
┌──────────────────────────────────────────────────────┐
│  Renderer  (Angular 21 · Material 3 · SPA)           │
│  app-state.service  ←signals→  componentes OnPush    │
└────────────────────┬─────────────────────────────────┘
                     │  contextBridge  (window.devia)
         preload.ts  │  shared/contracts/devia-bridge.ts
┌────────────────────▼─────────────────────────────────┐
│  Main Process  (Node.js · TypeScript · CommonJS)      │
│  composition-root.ts → 20 features con IPC handlers  │
│  shared/contracts/ipc-channels.ts  (40+ canales)     │
└────────────────────┬─────────────────────────────────┘
                     │  child_process / node-pty
┌────────────────────▼─────────────────────────────────┐
│  Procesos externos                                    │
│  claude · codex · gemini · opencode-cli               │
│  docker compose · shell exec                          │
└──────────────────────────────────────────────────────┘
```

Cada capa tiene una responsabilidad única:

- **Renderer**: presenta estado, captura input del usuario, sin lógica de negocio.
- **Main process**: todo lo que necesita acceso a Node.js/OS (spawn, filesystem, git, docker).
- **Shared**: tipos de dominio y contratos IPC neutros — sin imports de Electron ni de Angular.

---

## Configuración

La configuración vive en `~/.devia-app/devia-app.config.json`. La primera vez que abres la app un modal te pide el workspace.

```json
{
  "workspaceRoot": "/home/usuario/repos",
  "ignoreFolders": ["node_modules", "dist"],
  "agentId": "claude",
  "agentModels": { "claude": { "model": "claude-sonnet-4-5" } },
  "agentCliEnv":  { "claude": { "ANTHROPIC_API_KEY": "..." } },
  "language": "es"
}
```

Otros ficheros en `~/.devia-app/`:

| Fichero | Contenido |
|---------|-----------|
| `state.json` | Flag `newSession` y toggles de runtime |
| `bases.json` | Plantillas para «Nuevo desde base» |
| `sessions/<project>/` | Historial de chat por proyecto (JSON) |
| `outbox-archive/` | Archivos generados por el agente |
| `attachments/` | Imágenes adjuntadas en el input |
| `tmp/mcp-*.json` | Configs temporales de MCP (limpiadas al arrancar) |
| `audit.log` | Registro de tool-calls (rotación con timestamp) |
| `mcp-servers.json` | Servidores MCP configurados |

---

## Git workflow

GitHub Flow estricto:

| Prefijo | Uso |
|---------|-----|
| `feat/` | Nueva funcionalidad |
| `fix/` | Corrección de bug |
| `refactor/` | Cambio sin comportamiento nuevo |
| `docs/` | Solo documentación |
| `chore/` | Herramientas, deps, scripts |

Reglas:
1. Nunca commitear en `main` directamente.
2. Commitear solo cuando el usuario confirme que funciona.
3. No abrir PR sin petición explícita.
4. Push inmediato tras cada commit.
