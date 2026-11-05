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
| Claude (haiku) | PASS 2/2 | cadena completa: brainstorm, plan, execute (apply-yolo), trivial, bugfix; todas las aserciones duras |
| Codex | PASS | `--cheap` (brainstorm + trivial): todas las aserciones duras |
| Gemini | PASS (tras la política de modo plan) | `brainstorm` y `trivial`: todas las aserciones duras |
| pi | PASS | `--cheap`: todas las aserciones duras |
| OpenCode | PASS | `--cheap`: todas las aserciones duras |

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
- **En `apply` el agente no puede ejecutar Bash arbitrario** (Claude usa `acceptEdits`, que un `-p` no puede ampliar): no pudo correr tests
  ni hacer commit. La ejecución de un plan aprobado es "aceptar y no preguntar" (`apply-yolo`) y así lo prueba el caso `execute`.

## Cobertura que falta

- Evals completos (`plan`, `execute`, `bugfix`) con Codex, Gemini, pi y OpenCode: solo se han pasado los baratos (`--cheap`), el completo cuesta tokens reales.
- Aserciones blandas que hoy fallan en `execute`: el agente no deja comentarios en el hilo de la tarea ni usa `devia_todo`.
- Windows y Linux (el kit se materializa con bits de ejecución restaurados, sin probar fuera de macOS).
