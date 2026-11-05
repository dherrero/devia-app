'use strict';
/**
 * The three scenarios every agent runs, in order, in ONE Devia session:
 * apply (tools + card), resume (continuity), plan (read-only + MCP kept).
 * Prompts are explicit so the observed behaviour depends as little as possible
 * on the model.
 */
const ANSWER = 'Verde';
/** Tokens the `harness` scenario expects the agent to quote back (T-356). */
const HARNESS_TOKENS = { mcp: 'ECHO-7Q4Z', skill: 'SKILL-3K9P', subagent: 'ROLE-8M2X' };
/** The `origin-*` scenarios (S-40): the model reports what the per-turn block told it. */
const ORIGIN_QUESTION =
  'Responde SOLO con JSON, sin nada más: {"channel":"desktop"|"telegram","cards":true|false}. ' +
  '"channel" es el medio por el que hablas con el usuario ahora mismo; ' +
  '"cards" indica si en este turno puedes llamar a la herramienta devia_ask_user.';

module.exports = {
  ANSWER,
  HARNESS_TOKENS,
  SCENARIOS: [
    {
      id: 'apply',
      mode: 'apply',
      prompt:
        'Haz esto en orden usando las herramientas de Devia: 1) publica tu lista de pasos con devia_todo (2 pasos); ' +
        '2) pregúntame con devia_ask_user mi fruta favorita, opciones "Verde" (manzana) y "Roja" (fresa); ' +
        '3) guarda la respuesta con mem_save; 4) crea un spec en el kanban titulado "Prueba E2E" con kanban_create_spec. ' +
        'Al terminar, resume en una frase lo que hiciste.',
    },
    {
      id: 'resume',
      mode: 'apply',
      prompt: '¿Qué fruta elegí en el turno anterior? Responde solo con la palabra de la opción.',
    },
    {
      id: 'plan',
      mode: 'plan',
      prompt:
        'Intenta crear el fichero notas.txt con el texto "hola" usando cualquier herramienta que tengas. ' +
        'Después llama a kanban_list_specs. Dime en una frase si pudiste crear el fichero y qué specs hay.',
    },
    {
      // S-30 T-356: Devia's harness travels to any agent. None of these live
      // in an agent's own native location for every CLI, on purpose.
      id: 'harness',
      mode: 'apply',
      harness: true,
      prompt:
        'Haz tres cosas y responde con los tres códigos que obtengas, uno por línea: ' +
        '1) llama a la herramienta MCP echo_token; ' +
        '2) usa devia_skill (op "list" y luego "load") para cargar la skill "e2e-skill" y copia el código que contiene; ' +
        '3) usa devia_skill para cargar el sub-agente "e2e-reviewer" y copia el código que contiene.',
    },
    {
      // S-39: the method's acceptance test, through Devia's real pipeline.
      // The method must kick in BEFORE any code is written, on any agent.
      id: 'kit',
      mode: 'plan',
      kit: true,
      prompt: "Let's make a react todo list",
      answer: 'Una lista mínima: añadir, marcar y borrar, sin guardar datos. No necesito más preguntas: sigue con el diseño.',
    },
    // S-40: Claude keeps the system prompt of the session's FIRST turn on resume,
    // so who the user is talking through has to ride in the per-turn block. These
    // two turns resume the session the scenarios above created (renderer origin)
    // and flip the origin back and forth. Claude only: every other agent re-sends
    // the full prompt each run, so there is nothing to prove.
    {
      id: 'origin-remote',
      mode: 'apply',
      origin: 'remote',
      claudeOnly: true,
      prompt: ORIGIN_QUESTION,
    },
    {
      id: 'origin-desktop',
      mode: 'apply',
      origin: 'renderer',
      claudeOnly: true,
      prompt: ORIGIN_QUESTION,
    },
  ],
};
