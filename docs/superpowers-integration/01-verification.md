# Superpowers × Devia — verificación (S-38 / T-402)

Fecha: 2026-11-03/04. Superpowers v7.0.1 (`2ce8aa1`). CLIs: claude 2.1.x, codex 0.141.0, gemini 0.46.0, opencode 1.19.3, pi 1.3.0.
Método: directorio temporal vacío con `git init`, modo solo lectura, prompt `Let's make a react todo list`
(la prueba de aceptación de Superpowers: debe dispararse `brainstorming` ANTES de escribir código).

## 1. Bootstrap por prompt (cuerpo de `using-superpowers` + mapeo mínimo, ~900 tokens)

| Agente | Resultado | Notas |
| --- | --- | --- |
| claude | PASS | "Using brainstorming…", una pregunta, 0 código |
| codex | PASS | idem; ~25k tokens por run (incluye su prompt de sistema) |
| gemini | PASS | requiere `GEMINI_CLI_TRUST_WORKSPACE=true` (Devia ya lo fija) |
| pi | PASS | comportamiento correcto; no anuncia la skill |
| opencode | FAIL (permiso) | no pudo leer la skill: `external_directory … auto-rejecting` |

Conclusión: el bootstrap funciona donde el agente puede LEER el kit.

## 2. OpenCode y directorios externos

`permission.external_directory: { "<dir>/**": "allow" }` en el config por run (`OPENCODE_CONFIG`) lo resuelve
(verificado leyendo el kit sin prompt). Implementado en `agents/opencode/run-config.ts` vía `HarnessPlan.readDirs`.
El esquema también ofrece `skills.paths` (canal nativo de skills), sin probar.
`external_directory` concede acceso, no solo lectura: la protección de escritura debe venir de los permisos del
sistema de ficheros del kit (T-405).

## 3. Claude `--plugin-dir`

PASS. `claude -p … --plugin-dir <repo superpowers>`: el plugin carga solo en esa sesión (`source: superpowers@inline`),
el hook `SessionStart` se ejecuta en modo `-p` e inyecta el bootstrap, y el agente invoca `Skill superpowers:brainstorming`
sin escribir código. Implicaciones:
- El directorio debe ser un plugin completo: `.claude-plugin/plugin.json`, `hooks/` (con `run-hook.cmd` y `session-start`)
  además de `skills/`. **El vendoring de T-403 debe incluirlos** (hoy solo copia `skills/` + LICENSE).
- Para Claude hay DOS canales de bootstrap posibles (hook del plugin y pack body de Devia). **Usar solo uno** o se
  inyecta dos veces. Recomendación: `--plugin-dir` para Claude y pack body para el resto; el gating de T-407 debe
  saltarse el pack body cuando el mapper de Claude entrega el plugin.
- Los skills aparecen namespaced (`superpowers:brainstorming`); con `devia_skill` son nombres planos.
- El hook es un script bash: en Windows depende de Git Bash (el wrapper `run-hook.cmd` sale sin error si no lo encuentra).

## 4. Ficheros de apoyo y scripts fuera del cwd

Claude con `--add-dir <kit>`, modo `acceptEdits`, `--allowedTools Read "Bash(bash *)"`: PASS. Leyó
`systematic-debugging/root-cause-tracing.md` y ejecutó `bash <kit>/…/scripts/task-brief plan.md 1`, que escribió
`.superpowers/sdd/…` en el repo del proyecto (ignorado por git). Las skills invocan sus scripts relativos al dir de la skill
(`bash scripts/…`, `../subagent-driven-development/scripts/…`), así que el agente necesita la RUTA ABSOLUTA del kit
(T-406: `devia_skill load` antepone el dir; T-404: el mapeo lo explica).
Modos de ejecución exigen permiso de Bash: en `plan` Devia prohíbe Bash, así que los scripts solo aplican en apply.

## 5. Bug previo encontrado

`devia_skill` no ve skills instaladas como symlink: `run-instruction.use-case.ts:678` pasa el dirname del skill y
`scanSkillDirs` descarta `Dirent` symlink (`isDirectory()` es false). Afecta al instalador actual con cualquier skill.

## 6. Sin verificar (decisión: no bloquea)

- Scripts del kit y `external_directory` bajo el sandbox `workspace-write` de Codex, Gemini y pi.
- `skills.paths` de OpenCode, `--skill <dir>` de pi con las skills del kit, extensiones de Gemini.
- Coste de contexto medido con los tools reales de Devia (hay tests de presupuesto que revisar en T-406/T-407).

## Decisiones (go / no-go)

| Canal | Decisión |
| --- | --- |
| Pack body con `using-superpowers` + `devia-tools.md` | GO para codex, gemini, pi, opencode (y claude solo si no hay plugin) |
| Claude `--plugin-dir` | GO, con kit completo de plugin; excluye el pack body |
| OpenCode `readDirs` → `external_directory` | GO (hecho) |
| `devia_skill` + ficheros de apoyo | GO, tras arreglar el bug de symlinks |
| `--add-dir` / `--include-directories` para el kit | GO en Claude y Gemini; Codex/pi por verificar |
