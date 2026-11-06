# Devia Method — auditoría de la biblioteca de skills de partida, v7.0.1 (S-39 / T-419)

Fuente: `vendor/upstream/skills/**` (14 skills, ~10 800 líneas con referencias). Criterio: lo que es disciplina pura se
queda; lo que asume ficheros, harness o git se adapta o reemplaza; lo que solapa con una superficie de Devia se enlaza a ella.

## Hallazgo estructural

`executing-plans` y `subagent-driven-development` son una **máquina de estado sobre ficheros**:

```
docs/plans/<plan>.md ──task-brief──▶ <espacio-de-trabajo>/<plan>/task-N-brief.md
        │                                         <espacio-de-trabajo>/<plan>/progress.md   (ledger: "Task N: complete …", "Ruling: …")
        └──sdd-workspace──▶ directorio por plan   task-start / task-done / review-package
```

Existe para sobrevivir a la compactación de contexto ("controllers that lost their place re-dispatched entire completed task
sequences — the single most expensive failure observed"). Devia ya tiene el equivalente nativo: el kanban.

| Upstream | Devia |
| --- | --- |
| plan en un fichero de `docs/` | tareas del kanban (`kanban_create_task`, `dependsOn`) |
| design doc en un fichero de `docs/` | spec del kanban (`kanban_create_spec`) |
| cabecera del plan (Goal, Architecture, Global Constraints, Review Focus) | descripción del spec |
| `task-brief PLAN_FILE N` | `kanban_get_task` (el cuerpo de la tarea ES el brief) |
| ledger `progress.md` · `Ruling:` · `minor (deferred)` | hilo de comentarios de la tarea (`kanban_comment`) |
| `task-start` (brief + BASE) | `kanban_move_task in_progress` + `git rev-parse HEAD` |
| `task-done` (corre tests, solo si pasan anota) | script `task-verify` (corre tests, guarda salida, no anota) + `kanban_close_task(commit)` solo si exit 0 |
| "Task N: complete" · reanudar tras compactar | `kanban_close_task` con commit · `kanban_list` + `git log` |
| `sdd-workspace` (directorio por plan) | desaparece (el estado ya no está en ficheros) |
| `review-package PLAN_FILE BASE HEAD` | `review-package BASE HEAD` (sin plan; salida en `.devia/review/`, autoignorado) |
| subagentes despachados | `kanban_record_subagent` deja constancia en la tarea |
| `TodoWrite` | `devia_todo` (stepper) |
| `AskUserQuestion` / preguntar | `devia_ask_user` (tarjeta) · texto cuando es conversación abierta |
| pedir aprobación del plan | `devia_plan_approve` |
| revisión humana | `devia_request_review` (vista Cambios con comentarios anclados) |
| worktrees | paneles divididos de Devia (worktree por panel, protocolo propio) |
| notas/decisiones | memoria de Devia (`mem_save`, `mem_context`) |

Ventaja añadida: con el estado en el kanban, **otro agente puede continuar** (handoff entre agentes), cosa que ficheros en
un directorio oculto dentro de un worktree no permitían.

## Matriz de disposición

| Skill | Disposición | Qué cambia (líneas / secciones) |
| --- | --- | --- |
| skill de arranque de upstream | **REEMPLAZAR** → `using-devia` | Se conserva la regla ("1 % de probabilidad") y los red flags. Fuera: *Platform Adaptation* (6 `references/*-tools.md`), `SUBAGENT-STOP` se mantiene. Entra: índice de skills (nombre + disparador) para los agentes sin descubrimiento nativo, y mapa de superficies de Devia. |
| `brainstorming` | **ADAPTAR a fondo** | Se quedan: *What do you actually know*, una pregunta por mensaje, *Play it back*, *Lay out the approaches*, *Size the work*, HARD-GATE, red flags, builder check. Cambian: *Look Before You Ask* + recall (`mem_search`, `kanban_list_specs`); *The Written Design* → spec del kanban (no fichero en `docs/`, no commit); aprobación por tarjeta; decisiones → `mem_save`; *Spike* → panel dividido. Fuera: *Visual Companion* y `scripts/` (server.cjs, helper.js, frame-template, start/stop-server) + `visual-companion.md`. |
| `writing-plans` | **ADAPTAR** | *Save plans to* → tareas del kanban; cabecera → descripción del spec; *Task Structure* (Files, Interfaces, pasos TDD con Expected) → cuerpo de cada tarea; *Self-Review*, *Step Granularity*, *Task Right-Sizing* se quedan; *Execution Handoff* → `devia_plan_approve` (elección inline/subagentes dentro de la tarjeta/mensaje). |
| `executing-plans` | **REESCRIBIR** sobre kanban | Se quedan: continuous execution, *Rulings, not stalls* y las 4 paradas, TDD como compuerta por tarea, completion contract, final review, rationalizations. Fuera: workspace, ledger, `task-start`, `task-done`, plan file. |
| `subagent-driven-development` | **REESCRIBIR** sobre kanban | Igual + `kanban_record_subagent`. Se quedan `implementer-prompt`, `task-reviewer-prompt`, `re-review-prompt`, `references/{fix-loop,final-review,handling-reports,cannot-verify,batching,preflight}`; `resuming.md` desaparece (reanudar = `kanban_list`). `PLAN_FILE`→id de tarea; *Model Selection* abstracto. |
| `dispatching-parallel-agents` | **MANTENER + nota** | Añadir paneles de Devia (hasta 4, worktree propio) como paralelismo real. |
| `requesting-code-review` | **ADAPTAR** | Se quedan criterio y plantilla `code-reviewer.md`. Entra `devia_request_review` (revisión humana). Los SHAs ya no salen de rutas `docs/`. |
| `receiving-code-review` | **MANTENER** | Solo "your human partner" → "el usuario" y mención de comentarios `revisa:` con anclas. |
| `using-git-worktrees` | **REEMPLAZAR** → `isolating-work` | El aislamiento ES el panel dividido. Se conserva la *detección* (¿ya estoy en un worktree?). Fuera: creación manual, `.worktrees/`, gitignore. |
| `finishing-a-development-branch` | **REEMPLAZAR** → `finishing-work` | Verificar → commit → `devia_request_review` → `devia_pick` (dejar listo / push / PR). Cerrar tareas con commit; sugerir archivar spec. **Fuera:** merge local, `git branch -D`, `git worktree remove` (Step 6 borra todo lo que cuelga de `worktrees/`: habría borrado los worktrees de Devia en `<deviaDir>/worktrees/`). |
| `test-driven-development` (+`writing-good-tests`) | **MANTENER** | Solo "your human partner" → "el usuario" y referencias cruzadas sin prefijo de espacio de nombres. |
| `systematic-debugging` (+4 refs, `find-polluter.sh`, `condition-based-waiting-example.ts`) | **MANTENER + 1 línea** | Al cerrar un bug con causa raíz → `mem_save` tipo `bugfix`. Se descartan `CREATION-LOG` y `test-*` (ya excluidos del vendoring). |
| `verification-before-completion` | **MANTENER + 1 línea** | La evidencia va al comentario de cierre de la tarea y al `devia_todo`. |
| `writing-skills` (+refs, `render-graphs.js`) | **ADAPTAR (baja prioridad)** | Dónde viven las skills en Devia (gestor de Skills, `.agents/skills`); fuera lo específico de plugins de Claude y `anthropic-best-practices.md` (1 150 líneas) si no aporta. |
| skill de diagnóstico de upstream | **FUERA** | Lee transcripts de otros CLIs y puede abrir issues. Sustituto propio en backlog (T-429). |

## Scripts

| Script | Destino |
| --- | --- |
| `review-package` | **ADAPTAR**: `BASE HEAD [OUT]`, sin plan; salida en `.devia/review/` con `.gitignore` propio (`*`) |
| `task-done` | **ADAPTAR** → `task-verify`: corre el comando, guarda la salida completa, imprime la cola, sale con el código del comando; ya no escribe ledger |
| `task-brief`, `task-start`, `sdd-workspace` | **FUERA** |
| `find-polluter.sh` | **MANTENER** |
| `brainstorming/scripts/*`, `render-graphs.js` | **FUERA** |

## Lo que upstream NO tiene y Devia aporta

Memoria persistente entre sesiones (recall al empezar, decisiones y bugs al cerrar), tablero visible para el usuario, handoff
entre agentes, paneles paralelos aislados, tarjetas de decisión, vista de revisión con comentarios por línea, stepper de progreso,
aprobación de plan con paso a apply. El método los usa en cada fase en vez de reinventarlos con ficheros.

## Riesgos específicos detectados

1. `executing-plans` pide *no detenerse* entre tareas; Devia en modo apply con permisos puede lanzar cambios grandes sin paradas:
   las 4 condiciones de parada (destructivo, seguridad, efecto fuera del worktree, plan roto) se conservan y se enlazan a `devia_confirm`.
2. El *Model Selection* de SDD asume que el controlador elige modelo por subagente; en Devia el modelo lo fija el usuario por agente:
   se abstrae ("la opción más capaz disponible") y se deja de exigir `model:` explícito.
3. Descripciones de skills largas e imperativas (`brainstorming`: "You MUST…") consumen contexto en cada turno de Claude (todas las
   descripciones viven en el prompt): se reescriben como disparadores cortos.
4. El arranque de upstream fuerza invocar skills *antes de cualquier respuesta, incluso preguntas aclaratorias*: se mantiene pero con la
   excepción explícita de petición trivial y totalmente especificada (la excepción que ya cita brainstorming).
