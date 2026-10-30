# renderer — SPA Angular 21

Interfaz gráfica de Devia. Una Single Page Application escrita en Angular 21 con Material 3, compilada a `dist/renderer/browser/` y cargada por Electron como fichero local.

---

## Stack

| Aspecto | Tecnología |
|---------|-----------|
| Framework | Angular 21 (standalone components, sin NgModules) |
| UI | Angular Material 3 (dark theme, paleta verde M3) |
| Estado | Signals + computed (sin RxJS donde no hace falta) |
| Change detection | OnPush en todos los componentes |
| Markdown | marked 18 + DOMPurify 3 (con fallback a texto plano) |
| Terminal | xterm.js 5.5 + addon-fit + addon-web-links |
| i18n | @ngx-translate/core 15 (10 idiomas) |
| Voz | @xenova/transformers 2.17 (Whisper, local) |
| Tests | Vitest 4 + @analogjs/vitest-angular + jsdom |

---

## Estructura

```
renderer/
├── main.ts                 bootstrapApplication (punto de entrada)
├── index.html              Shell HTML con <ds-root>
├── styles.scss             Tema M3 oscuro + tokens --dv-* + paletas de acento
├── test-setup.ts           Inicialización de Angular TestBed para Vitest
│
├── app/
│   ├── app.component.ts            Shell principal (layout grid 3 columnas)
│   ├── app-state.service.ts        Store central de signals
│   ├── electron-api.service.ts     Bridge a window.devia
│   ├── i18n.service.ts             Cambio de idioma en tiempo real
│   │
│   ├── titlebar/                   Barra superior
│   ├── sidebar/                    Panel izquierdo (proyectos, acciones)
│   ├── chat-panel/                 Panel central (mensajes, compositor, terminal)
│   │   ├── message-bubble/         Burbuja de mensaje (markdown, tool calls, diff)
│   │   ├── tool-call-card/         Detalle de herramienta usada
│   │   ├── question-card/          Tarjeta interactiva AskUserQuestion
│   │   ├── diff-viewer/            Visor de diff Git inline
│   │   └── terminal-panel/         Terminal xterm.js con PTY
│   ├── queue/                      Panel de cola de instrucciones
│   ├── right-rail/                 Panel derecho (árbol de archivos)
│   ├── statusbar/                  Barra inferior (agente, branch, proceso)
│   ├── toasts/                     Sistema de notificaciones
│   ├── modals/                     Diálogos Material
│   └── theme/                      Paletas de acento y tamaño de fuente
│
├── assets/
│   ├── images/             Logo Devia.PNG
│   ├── icons/              Iconos SVG de tech stacks
│   └── i18n/               JSON de traducciones (es, en, fr, de, pt, it, ar, hi, zh, ru)
│
└── types/
    └── devia.d.ts          Tipo de window.devia (contextBridge)
```

---

## Servicios principales

### `AppStateService`
Store central reactivo. Todos los componentes leen de aquí.

**Signals:**

| Signal | Tipo | Descripción |
|--------|------|-------------|
| `config` | `DeviaConfigView \| null` | Configuración del usuario |
| `projects` | `ProjectEntry[]` | Lista de proyectos del workspace |
| `chats` | `Map<project, ChatMessage[]>` | Historial de chat por proyecto |
| `assistantStreams` | `Map<project, ChatMessage>` | Mensajes en streaming activo |
| `pendingQuestions` | `Map<project, QuestionAskEvent>` | Preguntas AskUserQuestion en curso |
| `gitInfo` | `GitInfo \| null` | Estado git del proyecto seleccionado |
| `pinnedPaths` | `string[]` | Proyectos anclados en sidebar |
| `runMode` | `RunMode` | Modo de ejecución (apply / plan) |

**Internamente:**
- `recentlyEnded`: grace-map para diff snapshots tardíos (TTL 10 s, sweep cada 5 s).
- `MAX_EVENTS = 500`: el log de eventos se recorta al cerrar cada run.
- Implementa `OnDestroy` para limpiar el interval del sweep.

### `ElectronApiService`
Wrapper tipado sobre `window.devia`. El único punto de contacto con el bridge.

- Todos los métodos devuelven `Promise<T>` o `void`.
- Los eventos IPC se suscriben con `onXxx(handler)`.
- Los componentes nunca deben acceder a `window.devia` directamente.

### `I18nService`
- Detecta el idioma del sistema operativo al arrancar.
- Permite cambiarlo en tiempo real desde Configuración.
- Persiste la elección en `DeviaConfig.language`.

---

## Componentes

### `AppComponent`
Layout de 3 columnas: sidebar (fija) + chat-panel (flex) + right-rail (opcional).
Gestiona la apertura de modales y el estado de colapso de la sidebar.

### `ChatPanelComponent`
Panel central con:
- Historial de mensajes para el proyecto seleccionado.
- Burbuja de streaming activo.
- Tarjeta de pregunta pendiente (`QuestionCardComponent`).
- Compositor de instrucciones (texto, voz, imagen).
- Terminal integrado.

### `MessageBubbleComponent`
Renderiza mensajes de tres roles: `user`, `assistant`, `system`.

Para mensajes de asistente:
- **Markdown**: `marked.parse()` + `DOMPurify.sanitize()`. Si DOMPurify no está disponible o lanza, `htmlUsePlainText()` activa el fallback a `<pre>` (sin innerHTML).
- **Content blocks**: texto y tool calls interleaved en el orden de emisión.
- **Bloque thinking**: desplegable `<details>` con el razonamiento del modelo.
- **Uso de tokens**: `usageLabel()` muestra `↑ IN ↓ OUT tokens [· 🧠 REASONING] [· $COST]`.
- **Diff inline**: si el message tiene `diff`, se renderiza `DiffViewerComponent`.

Computeds puros (testeables sin DOM):

| Computed | Descripción |
|---------|-------------|
| `usageLabel()` | Formatea tokens y coste |
| `hasThinking()` | Verdadero si hay texto de thinking |
| `agentLabel()` | `"agentId · model"` o sólo uno de los dos |
| `statusIcon()` | `'warning'` / `'cancel'` / null según runStatus |
| `showRetry()` | Muestra botón Reintentar según cancelReason |
| `htmlUsePlainText()` | Fallback cuando DOMPurify no está disponible |
| `modeLabel()` | Badge del modo de ejecución (apply/plan) |

### `ToolCallCardComponent`
Muestra el detalle de una herramienta invocada por el agente.

Computeds puros:

| Computed | Descripción |
|---------|-------------|
| `isRunning()` | Verdadero si no hay resultado todavía |
| `statusIcon()` | `'check_circle'` / `'error'` / null |
| `hasDiff()` | Verdadero si es herramienta de edición con diff |
| `formattedInput()` | Input del tool call formateado según tipo |
| `truncatedResult()` | Resultado truncado a 2000 chars |

### `DiffViewerComponent`
Visor de diff git inline.

- Muestra paths relativos al workspace (con path absoluto en `title`).
- Dos modos: `project` (fetch via IPC) o `inlineFiles` (pre-fetched).
- `displayPath(absPath)` usa `toRelativePath()` de `shared/domain/path-display.ts`.

### `SettingsModalComponent`
Diálogo de configuración. Secciones: workspace, agente, modelo, env vars, tema, idioma, auditoría.

Comportamientos implementados:
- **Rechazo de agente**: si el main process rechaza `selectAgent()`, el modal permanece abierto y muestra el motivo en un banner rojo.
- **Secretos enmascarados**: los campos `API_KEY`/`TOKEN`/`SECRET` muestran `••••••••` al abrir. Botón «Editar» per campo para introducir un nuevo valor.
- **Hint MCP**: nota informativa de que los servidores MCP solo los usa Claude.

### `QuestionCardComponent`
Tarjeta que aparece cuando el agente emite un `AskUserQuestion`. Input: `question: QuestionAskEvent | null`.

---

## Sistema de temas

### Tokens CSS (`--dv-*`)
Todos los colores usan custom properties de libs/styles, importadas por
renderer/styles.scss. El renderer solo mantiene extensiones de layout locales.
Nunca hardcodear colores en componentes.

Ejemplos:
```scss
--dv-bg          // Fondo principal
--dv-surf-2      // Fondo elevado (tarjetas)
--dv-fg          // Texto principal
--dv-muted       // Texto secundario
--dv-acc         // Color de acento del tema activo
--dv-danger      // Error / destructivo
--dv-bor         // Bordes
```

## Internacionalización (i18n)

10 idiomas soportados: `es`, `en`, `fr`, `de`, `pt`, `it`, `ar`, `hi`, `zh`, `ru`.

- Ficheros en `renderer/assets/i18n/<lang>.json`.
- Pipe `| translate` en templates: `{{ 'key' | translate }}`.
- Pipe con parámetros: `{{ 'key' | translate:{ name: value } }}`.
- Cambio en tiempo real sin recargar la app.
- Fallback a `es` si falta una clave en el idioma activo.

Para añadir una clave nueva:
1. Añade la clave en `es.json` (idioma base).
2. Añade la misma clave en los demás JSON (si tienes las traducciones).
3. Usa `| translate` en el template — nunca strings en español hardcodeados.

---

## Tests

```bash
npm run test:renderer    # Vitest + jsdom + @analogjs/vitest-angular
```

- Configuración en `vitest.angular.config.ts`.
- Inicialización de TestBed en `renderer/test-setup.ts`.
- Los `.spec.ts` con `it.todo()` documentan tests pendientes que requieren setup adicional.

Componentes con tests reales:
- `QuestionCardComponent` — 4 tests DOM.
- `ToolCallCardComponent` — 17 tests (computeds + DOM).
- `MessageBubbleComponent` — 21 tests (computeds + DOM).

---

## Convenciones

- **Standalone**: cada componente es autocontenido (imports declarados en el decorator).
- **OnPush**: siempre. Sin excepciones.
- **Signals**: `signal()` para estado mutable, `computed()` para derivados, `input()` para props, `output()` para eventos.
- **Sin RxJS** salvo donde Angular lo requiere internamente.
- **Sin `window.devia` directo**: siempre a través de `ElectronApiService`.
- **Sin strings de color**: usa tokens `--dv-*`.
- **Sin strings hardcodeados en español**: usa `| translate`.
- **Material imports al mínimo**: sólo los módulos que usa el componente.
