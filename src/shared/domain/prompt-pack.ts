/**
 * Reusable system-prompt addendum that the user can apply per-project or
 * per-turn (REV-AGENT-CORE-003).
 *
 * Each pack is a Markdown file with optional YAML-ish frontmatter:
 *
 *   ---
 *   name: TDD First
 *   description: Always write a failing test before the code that satisfies it.
 *   triggers: [tdd, test-first]
 *   ---
 *   <body of the prompt pack>
 *
 * The use case concatenates the bodies of selected packs after the project's
 * tech-detected baseline system prompt, separated by `---` dividers.
 */
export interface PromptPack {
  id: string;
  name: string;
  description: string;
  /** Markdown body inserted into the system prompt. */
  body: string;
  /** Optional trigger keywords for future @-mention popover filtering. */
  triggers?: string[];
  /** Where this pack came from. User packs win on id collision. */
  source: 'built-in' | 'user';
}

/** Renderer-facing summary — body omitted to keep IPC payloads small. */
export interface PromptPackSummary {
  id: string;
  name: string;
  description: string;
  triggers?: string[];
  source: 'built-in' | 'user';
}
