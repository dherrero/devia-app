# shared — Código compartido entre procesos

Este directorio contiene los únicos ficheros que tanto el proceso principal (Node.js) como el renderer (Angular) pueden importar directamente.

**Regla fundamental**: ningún fichero de `shared/` debe importar `electron`, `node:*`, ni ninguna API específica de un entorno. Debe funcionar en Node.js y en el browser sin modificaciones.

---

## Estructura

```
shared/
├── contracts/          Contratos del bridge IPC
│   ├── ipc-channels.ts     Nombres de todos los canales (const object)
│   ├── devia-bridge.ts     Interfaz de window.devia (contextBridge API)
│   └── events.ts           Tipos de eventos emitidos del main al renderer
│
└── domain/             Tipos de dominio (interfaces puras, algunas funciones puras)
    ├── agent.ts
    ├── agent-event.ts
    ├── attachment.ts
    ├── base.ts
    ├── chat.ts
    ├── clone.ts
    ├── compose.ts
    ├── config.ts
    ├── git.ts
    ├── mcp.ts
    ├── path-display.ts
    ├── persisted-agent-event.ts
    ├── project.ts
    ├── project-tree.ts
    ├── prompt-pack.ts
    ├── queue.ts
    ├── run-capabilities.ts
    ├── session.ts
    ├── skill.ts
    ├── status.ts
    ├── tool-call.helpers.ts
    └── tool-icons.ts
```

---

## Contratos IPC (`contracts/`)

### `ipc-channels.ts`
Objeto const con el nombre de todos los canales IPC. Nunca usar literales de string.

```ts
export const IPC = {
  projectsList:  'projects:list',
  agentSelect:   'agent:select',
  // ... 40+ canales
} as const;
```

Al añadir un canal nuevo:
1. Añadir aquí.
2. Añadir la firma en `devia-bridge.ts`.
3. Registrar el handler en `src-main/shell/composition-root.ts`.
4. Añadir el wrapper tipado en `renderer/app/electron-api.service.ts`.

### `devia-bridge.ts`
La interfaz completa de `window.devia` — lo que el renderer puede llamar.

```ts
export interface DeviaBridge {
  getConfig(): Promise<DeviaConfigView>;
  selectAgent(agentId: string): Promise<SelectAgentResult>;
  // ...
}
```

### `events.ts`
Tipos de eventos push del main al renderer (sin respuesta IPC):

| Evento | Cuándo |
|--------|--------|
| `ProcessStartEvent` | El agente CLI ha arrancado |
| `ProcessEndEvent` | El proceso ha terminado |
| `ClaudeOutputEvent` | Una línea de output del agente (AgentEvent serializado) |
| `GitInfoChangedEvent` | El estado git del proyecto ha cambiado |
| `DiffSnapshotEvent` | Un diff nuevo está disponible para un run |
| `QuestionAskEvent` | El agente emitió AskUserQuestion |

---

## Dominio (`domain/`)

### `agent.ts`
```ts
type RunId = string & { readonly __brand: 'RunId' };

function isForeignEvent(
  streamRunId: RunId | undefined,
  eventRunId:  RunId | undefined,
): boolean
// Devuelve true si el evento pertenece a un run diferente al stream activo.
// Lógica: stream sin runId → acepta todo (legacy). Stream con runId + evento sin runId → descarta.
```

También contiene `DetectedAgentView` (lo que el renderer recibe sobre un agente detectado), `AgentModelOption`, `AgentProviderType`.

### `agent-event.ts`
Unión discriminada de todos los eventos de streaming:

```ts
type AgentEvent =
  | { type: 'text_delta';      delta: string }
  | { type: 'thinking_delta';  delta: string }
  | { type: 'tool_use';        id: string; name: string; input: unknown }
  | { type: 'tool_result';     toolUseId: string; content: string; isError: boolean }
  | { type: 'usage';           inputTokens?: number; outputTokens?: number;
                               cachedInputTokens?: number; reasoningOutputTokens?: number;
                               costUsd?: number; durationMs?: number }
  | { type: 'turn_end';        stopReason: string }
  | { type: 'error';           message: string; classification?: ErrorClassification }
  | { type: 'session_started'; agentSessionId: string }
  | { type: 'status';          label: string; model?: string }
  | { type: 'question';        toolUseId: string; question: string }
  | { type: 'raw';             line: string }
  // ...
```

### `chat.ts`
```ts
interface MessageUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningOutputTokens?: number;
  costUsd?: number;
  durationMs?: number;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text?: string;
  runId?: RunId;
  runStatus?: 'running' | 'succeeded' | 'failed' | 'canceled';
  usage?: MessageUsage;
  toolCalls?: ToolCallRecord[];
  contentBlocks?: ContentBlock[];
  events?: AgentEvent[];        // log de eventos (cap: 500 por run)
  thinking?: string;
  // ...
}
```

### `config.ts`
```ts
interface DeviaConfig {
  workspaceRoot:  string;
  ignoreFolders:  string[];
  agentId:        string;
  agentModels:    Record<string, AgentModelPrefs>;
  agentCliEnv:    AgentCliEnvPrefs;
  agentToolPolicy: Record<string, AgentToolPolicy>;
  language?:      string;
}
```

### `session.ts`
```ts
interface PersistedSession {
  id:        string;
  project:   string;
  createdAt: number;
  updatedAt: number;
  messages:  unknown[];
}

function parsePersistedSession(value: unknown): PersistedSession | null
// Valida en el boundary de persistencia. Devuelve null si faltan campos requeridos.
// Los campos extra son aceptados (compatibilidad hacia adelante).
```

### `path-display.ts`
```ts
function toRelativePath(absPath: string, workspaceRoot: string): string
// Convierte una ruta absoluta a relativa respecto al workspace.
// Normaliza separadores a '/'. Si la ruta está fuera del workspace, devuelve la ruta normalizada.
// Sin dependencias de Node.js — funciona en browser y en main process.
```

### `persisted-agent-event.ts`
Funciones para el log de eventos de un mensaje:

```ts
function appendAgentEvent(events: AgentEvent[], event: AgentEvent): AgentEvent[]
// Coalesca deltas consecutivos text_delta/thinking_delta en una sola entrada.

function rebuildFromEvents(events: AgentEvent[]): Partial<ChatMessage>
// Reconstruye los campos derivados (text, toolCalls, usage, thinking) desde el log.

function isValidEventLog(events: unknown): events is AgentEvent[]
// Guarda de tipo para cargar logs persistidos.
```

### `run-capabilities.ts`
Capacidades configuradas para un run específico:

```ts
interface RunCapabilities {
  runId:             RunId;
  mode:              RunMode;
  expiresAt:         number;
  disallowedTools:   string[];
  allowedTools?:     string[];
  allowedMcpServerIds?: string[];
}
```

### `tool-icons.ts`
Registro de iconos Material por nombre de tool:

```ts
function getToolIcon(toolName: string): ToolIconEntry | null
// Devuelve el iconName y color para mostrar en ToolCallCardComponent.
```

---

## Reglas para código en `shared/`

1. **No hay imports de `electron`** — rompe el renderer.
2. **No hay imports de `node:*`** — rompe el renderer.
3. **No hay side effects al importar** — los módulos son puros.
4. **Las funciones puras van aquí** cuando las necesitan ambos procesos.
5. **Los tipos opcionales usan `?:`**, no `T | undefined` explícito (por `exactOptionalPropertyTypes`).
6. **No hay lógica de negocio con I/O** — eso va en las features del main process.
