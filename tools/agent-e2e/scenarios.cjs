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
  ],
};
