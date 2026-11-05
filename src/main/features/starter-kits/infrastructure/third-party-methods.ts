/**
 * Other people's installs of a development method that Devia must recognise, to avoid handing an agent two
 * methods at once. These are names on THEIR disk (a skill folder, a Claude Code plugin entry), so they are
 * data about someone else's software: this is the one place in Devia's code that spells them out.
 */
export const THIRD_PARTY_BOOTSTRAP_SKILLS: readonly string[] = ['using-superpowers'];

/** Marketplace plugin name Claude Code records under `~/.claude/plugins`. */
export const THIRD_PARTY_CLAUDE_PLUGIN = 'superpowers';
