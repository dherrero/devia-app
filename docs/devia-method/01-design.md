# Devia Method — diseño (S-39)

Decisiones D1–D5 aprobadas el 2026-11-04. Ver `00-audit.md` para la matriz skill a skill.

## D1 · Procedencia: literal vendorizado + propio con rastro

```
resources/kits/devia-method/
  kit.json                  id, version, bootstrap, índice de skills (nombre + disparador), disposición
  UPSTREAM.md               por skill: ruta upstream, sha al hacer el fork, disposición, qué cambia y por qué
  LICENSE                   la licencia MIT del proyecto de partida; NOTICE raíz con la atribución
  skills/<nombre>/…         literales (copiadas del pin, hash verificado) y propias (su procedencia queda en `UPSTREAM.md`, generado desde `kit.json`)
  VERSION.json              pin del upstream de las literales
```

- Las **literales** se regeneran con `npm run vendor:upstream` y su hash se verifica; subir de versión es un re-vendor.
- Las **propias** nunca se pisan. `npm run kit:upstream-diff -- --tag vX` compara upstream en el sha del fork con el tag nuevo para
  cada skill propia y enseña el diff, para portar mejoras a mano (con criterio, no a ciegas).

## D2 · Nombre y licencia

"Devia Method", kit `devia-method`. Los nombres de skill se mantienen llanos (`brainstorming`, `writing-plans`…) salvo los
reemplazos (`using-devia`, `isolating-work`, `finishing-work`). MIT exige conservar copyright y licencia en copias y obras
derivadas: `LICENSE` del kit + `NOTICE` raíz. El producto final es de Devia y no se presenta como el proyecto original.

## D3 · Un solo camino de bootstrap

El bootstrap (`using-devia`) llega por el **prompt de sistema de Devia para todos los agentes**, Claude incluido. Claude conserva
`--plugin-dir` solo para el descubrimiento nativo de skills (su tool `Skill` + descripciones), **sin `hooks/`**. Un único camino
da comportamiento uniforme, es testeable por igual en los cinco agentes y elimina el riesgo de doble inyección.

## D4 · El kanban como estado

Spec = diseño aprobado. Tareas = plan. Hilo de la tarea = ledger. `kanban_close_task(commit)` = "tarea completa". La memoria guarda
decisiones y bugs. `devia_todo` es la vista en vivo. No hay ficheros de plan ni de ledger. Reanudar (tras compactar o con otro
agente) es `kanban_list` + `git log`.

## D5 · Una sola secuencia en plan mode

Con el método activo, el protocolo de plan de Devia deja de ordenar "explorar → persistir" por su cuenta y delega en la secuencia
del método: `brainstorming` → diseño aprobado → plan en el kanban → `devia_plan_approve` → apply. Sin método, queda como hoy
(byte-idéntico). Esto sustituye a la tabla de traducción de S-38, que dejaba dos instrucciones compitiendo.

## Calidad

1. **Lint del kit** (barato, en `npm test`): las skills propias no contienen `TodoWrite`, `AskUserQuestion`, `PLAN_FILE`, rutas de
   plan en `docs/`, prefijos de espacio de nombres ni el nombre del proyecto de partida; toda herramienta `devia_*`/`kanban_*`/`mem_*` que nombran existe en los registros de
   Devia; el manifiesto cubre todas las skills y viceversa; las literales siguen coincidiendo con su pin.
2. **Evals de comportamiento** (T-426): multi-turno con usuario simulado y aserciones sobre llamadas a herramientas; nunca en CI.

## Qué no cambia de S-38

Materializador por versión, puerto `StarterKitsPort`, detección de instalación nativa, entrega por agente, `devia_skill` con
ficheros de apoyo y directorio de la skill, arreglo de Gemini, `readDirs` de OpenCode, UI de Ajustes.
