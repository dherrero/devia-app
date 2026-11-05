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
| Claude (haiku) | PASS 2/2 | cadena completa (brainstorm → plan → execute en `apply-yolo`, trivial, bugfix): todas las aserciones duras |
| Codex | PASS | cadena completa: todas las aserciones duras |
| Gemini | PASS (tras la política de modo plan) | cadena completa: todas las aserciones duras |
| pi | PASS (tras restablecer sus herramientas fuera del modo plan) | cadena completa: todas las aserciones duras |
| OpenCode | PASS | cadena completa: todas las aserciones duras |

Ninguna ejecución completa tocó un límite de presupuesto: todas terminaron con código 0 y no hubo cortes. Las aserciones blandas que quedan por
debajo del ideal son opcionales: el orden test-antes-que-código no se detecta en agentes que escriben por la shell (Codex, OpenCode, pi),
y algunos no dejan comentario en el hilo de la tarea o no recuperan memoria antes de preguntar.

Observaciones que no bloquean: OpenCode (modelo gratuito) llegó a crear una tarea en el tablero antes de que el usuario respondiera en
una ejecución anterior; Codex usa las tarjetas de Devia (un usuario simulado las aprueba al instante), así que la aserción "nada en el tablero
antes de la primera respuesta" cuenta solo lo que ocurre antes de su primera tarjeta; el primer `mem_search` de Gemini en una sesión nueva
devolvió un error del cliente MCP (el servidor responde bien a la misma llamada).

Qué cambió por culpa de las pruebas (y por qué hay evals):

- **La excepción "petición trivial" era demasiado laxa.** Un modelo pequeño trató "un CLI pequeño" como trivial, se saltó `brainstorming` y
  escribió el código en el chat. Ahora crear algo nuevo (un programa, un script, una funcionalidad, una página) nunca es excepción;
  solo lo es una edición donde nada está abierto y nada nuevo se crea.
- **El protocolo de plan de Devia competía con el método.** Con dos instrucciones dando un primer paso distinto, el modelo se quedaba con
  la última. Con el método activo, el protocolo de plan delega en la secuencia del método.
- **El modo plan de Gemini no dejaba usar las herramientas de Devia.** Su política deniega todo lo que no sea de solo lectura, así que no
  podía guardar el diseño en el kanban, y además podía llamar a `exit_plan_mode` por su cuenta y acabar escribiendo ficheros. Ahora recibe
  por ejecución un fichero `--policy` (en el directorio temporal de Devia, borrado al terminar) que permite los tres servidores de Devia en
  modo plan y prohíbe salir de él. Con eso pasa `brainstorm` (spec y plan en el kanban, sin ficheros).
- **pi no podía escribir tras el modo plan.** pi guarda en la sesión el conjunto de herramientas con el que se lanzó; una sesión que pasó por
  modo plan (`--tools read,grep,find,ls,mcp__*`) y se reanuda sin `--tools` sigue sin `bash`, `edit` ni `write` (comprobado con pi 1.3.0).
  El flujo normal de Devia es plan → aprobar → apply en la misma sesión, así que el apply de pi no podía hacer nada. Ahora, fuera del modo
  plan, Devia pasa `--tools +bash,+edit,+write`, que añade los escritores a lo que tenga la sesión sin pisar el `defaultTools` del usuario.
- **En `apply` el agente no puede ejecutar Bash arbitrario** (Claude usa `acceptEdits`, que un `-p` no puede ampliar): no pudo correr tests
  ni hacer commit. La ejecución de un plan aprobado es "aceptar y no preguntar" (`apply-yolo`) y así lo prueba el caso `execute`.

## Cobertura que falta

- Una sola pasada por agente y caso: los resultados son por mayoría de 1; `--repeat N` da k/N para medir la dispersión de los modelos.
- Modelos: Claude se probó con haiku y OpenCode con su modelo gratuito; un modelo más capaz debería comportarse mejor, no peor.
- Windows y Linux (el kit se materializa con bits de ejecución restaurados, sin probar fuera de macOS).
