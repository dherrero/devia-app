/**
 * Single source of truth for the Telegram bot's command surface.
 *
 * Both `/help` (the in-chat help text) and the native Telegram menu (the
 * suggestion list that appears when the user taps `/`, registered via
 * `setMyCommands` on bot startup) are derived from `REMOTE_COMMANDS`, so the
 * two surfaces cannot drift apart: changing this list updates both.
 *
 * Telegram constraints (Bot API `setMyCommands`):
 *   - `command`: 1-32 chars, lowercase letters / digits / underscores only,
 *                no leading slash.
 *   - `description`: 1-256 chars, plain text (Markdown is shown literally in
 *                the menu, so we keep these plain).
 */

import type { BotCommand } from '../infrastructure/telegram-client';

export interface RemoteCommandSpec {
  /** Bare command name without the leading slash, e.g. `'projects'`. */
  readonly command: string;
  /** Optional argument hint (e.g. `<ruta>` or `plan|apply|yolo`). Rendered in
   *  `/help` wrapped in backticks; prepended to the menu description. */
  readonly args?: string;
  /** Plain-text description shared by `/help` and the Telegram menu. */
  readonly description: string;
}

export const REMOTE_COMMANDS: readonly RemoteCommandSpec[] = [
  { command: 'projects',                            description: 'Lista los proyectos (entra en una carpeta para ver lo que contiene)' },
  { command: 'use',      args: '[ruta]',            description: 'Elige el proyecto o carpeta activa (sin argumento: vuelve a la raíz)' },
  { command: 'status',                              description: 'Proyecto activo, rama, ejecución en curso, agente y modo' },
  { command: 'stop',     args: '[proyecto]',        description: 'Detiene la ejecución en curso' },
  { command: 'clean',    args: '[proyecto]',        description: 'Reinicia la sesión del agente' },
  { command: 'sync',                                description: 'Cambia el proyecto a su rama principal y hace pull (requiere árbol limpio y no estar ya en ella)' },
  { command: 'mode',     args: 'plan|apply|yolo',   description: 'Modo de permisos de las ejecuciones' },
  { command: 'agent',                               description: 'Muestra el agente activo' },
  { command: 'exec',     args: '<comando>',         description: 'Ejecuta un comando de shell (alias: !<comando>, si está habilitado)' },
  { command: 'help',                                description: 'Muestra esta ayuda' },
];

function buildHelpText(): string {
  const lines: string[] = [
    '*Devia — control remoto*',
    '',
    'Escribe cualquier texto y se ejecutará como instrucción en el proyecto activo.',
    'La conversación se refleja en la app y te devuelvo aquí la respuesta del agente.',
    '',
    '*Comandos*',
  ];
  for (const c of REMOTE_COMMANDS) {
    const head = c.args ? `/${c.command} \`${c.args}\`` : `/${c.command}`;
    lines.push(`${head} — ${c.description}`);
  }
  return lines.join('\n');
}

function buildBotCommands(): readonly BotCommand[] {
  return REMOTE_COMMANDS.map<BotCommand>((c) => ({
    command: c.command,
    description: c.args ? `${c.args} — ${c.description}` : c.description,
  }));
}

/** Multi-line Markdown reply for `/help` and `/start`. */
export const HELP_TEXT: string = buildHelpText();

/** Payload for `TelegramClient.setMyCommands` — same content as `HELP_TEXT`,
 *  formatted for the native Telegram menu. */
export const BOT_COMMANDS: readonly BotCommand[] = buildBotCommands();
