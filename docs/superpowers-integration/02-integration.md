# Superpowers × Devia — integración (S-38)

Resumen de lo construido y de cómo se verificó. Diseño de referencia para mantenedores: sección "Starter kits" de `AGENTS.md`.

## Idea

Devia es el volante; los agentes, los motores; Superpowers, parte del sistema eléctrico. Devia no instala un plugin en cada
agente: **entrega el kit en cada run por su propio harness**, igual para todos, sin escribir en repos ni en la home del usuario.

```
resources/kits/superpowers (pin v7.0.1)  ──app──▶  <deviaDir>/kits/superpowers/<tag>-<hash>/  (solo lectura)
                                                          │
                              StarterKitsPort.resolve ────┤  (activado · sin Superpowers nativo en ese agente)
                                                          ▼
   core (agnóstico) ──▶ harness.kit + readDirs + skills del kit servidas por devia_skill
                    ──▶ mapper.resolveDelivery.kit:  Claude = native (--plugin-dir)   resto = prompt
```

| Superpowers pide… | En Devia |
| --- | --- |
| `brainstorming` (preguntar una cosa cada vez) | modo plan + `devia_ask_user` |
| design doc `docs/superpowers/specs/…` | spec del kanban |
| plan `docs/superpowers/plans/…` | tareas del kanban con `dependsOn` |
| aprobar diseño / plan | `devia_plan_approve` |
| `TodoWrite` | `devia_todo` (stepper) |
| tool `Skill` / `superpowers:<x>` | `devia_skill` (Claude: su Skill nativa) |
| ficheros y scripts de una skill | `devia_skill` `<skill>/<fichero>` · `bash <kit>/skills/<skill>/scripts/x` |
| worktrees / terminar rama | los gestiona Devia: el kit tiene prohibido crearlos, cambiarlos o borrarlos |

## Verificación

**Prueba de aceptación de Superpowers** ("Let's make a react todo list", modo plan, pipeline real de Devia con `tools/agent-e2e`,
escenario `kit`): la skill `brainstorming` debe dispararse ANTES de escribir código.

| Agente | Canal | Resultado |
| --- | --- | --- |
| claude (haiku) | `--plugin-dir` + mapeo | PASS 2/2 — carga brainstorming, pregunta, 0 código |
| pi | prompt + `devia_skill` | PASS |
| opencode | prompt + `devia_skill` + `external_directory` | PASS |
| codex | prompt + `devia_skill` | PASS |
| gemini | prompt + `devia_skill` | PASS (tras corregir T-416) |

Modelos pequeños (haiku) son sensibles al orden de instrucciones: el mapeo va el último del prompt y fija "brainstorming primero".

## Bugs de Devia encontrados (todos en S-38)

- **Corregidos:** `devia_skill` no veía skills instaladas como symlink (T-406) · Gemini rechazaba la config MCP de Devia y no recibía
  ninguna tool (T-416) · `rm -rf ~/.devia-app` fallaba con un kit de directorios de solo lectura (visto en el harness).
- **Pendientes (backlog):** nombres de tool MCP de Gemini/otros sin canonizar (T-417) · acceso de Gemini al dir del kit y error de
  `mem_search` en el E2E (T-418).

## No verificado

La UI (Ajustes › Kit inicial y la tarjeta de primer arranque) compila, pasa lint, i18n y tests, pero **no se ha visto en la app real**:
requiere un smoke test manual. Tampoco se probó el empaquetado en Windows/Linux (en Windows los bits de ejecución se restauran al
materializar el kit).

## Mantenimiento

- Subir de versión: `npm run vendor:superpowers -- --tag vX.Y.Z` (clona el tag, actualiza `VERSION.json`) → `npm test` → E2E `kit`.
- `npm run check:kits` (y el test `tools/vendor-superpowers.test.ts`) fallan si alguien edita el kit a mano.
