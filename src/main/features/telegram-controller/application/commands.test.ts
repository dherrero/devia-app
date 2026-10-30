import { describe, it, expect } from 'vitest';
import { REMOTE_COMMANDS, HELP_TEXT, BOT_COMMANDS } from './commands';

// Telegram setMyCommands rules: command must be 1-32 chars, lowercase letters
// + digits + underscores; description 1-256 chars. Source: Bot API docs.
const COMMAND_RE = /^[a-z][a-z0-9_]{0,31}$/;

describe('REMOTE_COMMANDS — canonical list', () => {
  it('uses Telegram-valid command names (lowercase, ≤32, no slash)', () => {
    for (const c of REMOTE_COMMANDS) {
      expect(c.command, `command "${c.command}"`).toMatch(COMMAND_RE);
      expect(c.command.startsWith('/')).toBe(false);
    }
  });

  it('has unique command names', () => {
    const seen = new Set<string>();
    for (const c of REMOTE_COMMANDS) {
      expect(seen.has(c.command), `duplicate "${c.command}"`).toBe(false);
      seen.add(c.command);
    }
  });

  it('keeps every description within Telegram\'s 256-char limit', () => {
    for (const c of REMOTE_COMMANDS) {
      expect(c.description.length, `description for /${c.command}`).toBeGreaterThan(0);
      expect(c.description.length).toBeLessThanOrEqual(256);
    }
  });
});

describe('HELP_TEXT — /help reply', () => {
  it('includes the intro header and the Comandos section', () => {
    expect(HELP_TEXT).toContain('control remoto');
    expect(HELP_TEXT).toContain('*Comandos*');
  });

  it('lists every canonical command with its description', () => {
    for (const c of REMOTE_COMMANDS) {
      expect(HELP_TEXT, `/${c.command}`).toContain(`/${c.command}`);
      expect(HELP_TEXT, `description of /${c.command}`).toContain(c.description);
    }
  });

  it('wraps argument hints in backticks for Markdown rendering', () => {
    const withArgs = REMOTE_COMMANDS.filter((c) => c.args);
    expect(withArgs.length).toBeGreaterThan(0);
    for (const c of withArgs) {
      expect(HELP_TEXT, `\`${c.args}\` for /${c.command}`).toContain(`\`${c.args}\``);
    }
  });
});

describe('BOT_COMMANDS — Telegram menu payload', () => {
  it('mirrors REMOTE_COMMANDS one-to-one and in the same order', () => {
    expect(BOT_COMMANDS).toHaveLength(REMOTE_COMMANDS.length);
    BOT_COMMANDS.forEach((b, i) => {
      expect(b.command).toBe(REMOTE_COMMANDS[i]?.command);
    });
  });

  it('never includes leading slashes in command names', () => {
    for (const b of BOT_COMMANDS) {
      expect(b.command.startsWith('/')).toBe(false);
    }
  });

  it('keeps every description within Telegram\'s 256-char limit', () => {
    for (const b of BOT_COMMANDS) {
      expect(b.description.length).toBeGreaterThan(0);
      expect(b.description.length).toBeLessThanOrEqual(256);
    }
  });

  it('prepends the argument hint to the description when the command takes args', () => {
    for (const c of REMOTE_COMMANDS) {
      const entry = BOT_COMMANDS.find((b) => b.command === c.command);
      expect(entry, `entry for /${c.command}`).toBeDefined();
      if (c.args) {
        expect(entry?.description.startsWith(`${c.args} — `)).toBe(true);
      } else {
        expect(entry?.description).toBe(c.description);
      }
    }
  });
});
