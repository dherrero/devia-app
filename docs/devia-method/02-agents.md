# Devia Method — verificación por agente

Pruebas reales (no mocks) con los CLIs instalados: Claude Code, Codex 0.141, Gemini 0.46, OpenCode 1.19.3 y pi 1.3.0. Dos tipos:

1. **Aceptación** (`tools/agent-e2e/run.cjs <agente> --scenario kit`): la petición "Let's make a react todo list" en modo plan, por el
   pipeline completo de Devia. El método debe dispararse ANTES de escribir código: el agente carga `brainstorming`, pregunta, no escribe
   ficheros y no toca el tablero hasta que el usuario aprueba el diseño.
2. **Comportamiento multi-turno** (`tools/agent-e2e/evals.cjs <agente>`): un usuario simulado responde a las tarjetas y a los mensajes;
   las aserciones son sobre lo que el agente HIZO (llamadas a herramientas, estado del kanban, ficheros y commits), no sobre su prosa.
   Casos: `brainstorm` → `plan` → `execute` (una sola sesión), `trivial`, `bugfix`. `--cheap` ejecuta solo `brainstorm` y `trivial`;
   `--repeat N` informa k/N por aserción porque un modelo no es determinista.

## Resultados

| Agente | Aceptación (`kit`) | Evals multi-turno |
| --- | --- | --- |
| Claude (haiku) | PASS 2/2 | todas las aserciones duras por mayoría: brainstorm, plan, execute, trivial, bugfix |
| Codex | PASS | pendiente (ver más abajo) |
| Gemini | PASS | pendiente |
| pi | PASS | pendiente |
| OpenCode | PASS | pendiente |

Qué cambió por culpa de las pruebas (y por qué hay evals):

- **La excepción "petición trivial" era demasiado laxa.** Un modelo pequeño trató "un CLI pequeño" como trivial, se saltó `brainstorming` y
  escribió el código en el chat. Ahora crear algo nuevo (un programa, un script, una funcionalidad, una página) nunca es excepción;
  solo lo es una edición donde nada está abierto y nada nuevo se crea.
- **El protocolo de plan de Devia competía con el método.** Con dos instrucciones dando un primer paso distinto, el modelo se quedaba con
  la última. Con el método activo, el protocolo de plan delega en la secuencia del método.
- **En `apply` el agente no puede ejecutar Bash arbitrario** (Claude usa `acceptEdits`, que un `-p` no puede ampliar): no pudo correr tests
  ni hacer commit. La ejecución de un plan aprobado es "aceptar y no preguntar" (`apply-yolo`) y así lo prueba el caso `execute`.

## Cobertura que falta

- Evals multi-turno con Codex, Gemini, pi y OpenCode (cuestan tokens reales; se lanzan con `evals.cjs <agente> --cheap` y luego completo).
- Aserciones blandas que hoy fallan en `execute`: el agente no deja comentarios en el hilo de la tarea ni usa `devia_todo`.
- Windows y Linux (el kit se materializa con bits de ejecución restaurados, sin probar fuera de macOS).
