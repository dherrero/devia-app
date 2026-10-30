import { describe, expect, it } from 'vitest';

import { UI_TOOL_NAMES } from '../../../../shared/domain/ui-tools';
import { resolveAdvertisedUiTools } from '../../../../shared/domain/ui-tools-policy';
import { advertisedUiTools } from './tool-registry';

/**
 * `devia-ui` is delivered to EVERY run, so its advertised schemas sit in the
 * agent's cached prompt prefix on every single turn. This test is the guard
 * that stops a new tool from quietly inflating that prefix.
 *
 * Measured in characters of the serialised `tools/list` payload, which is what
 * actually travels. The rule of thumb used to set the caps is ~3.5 chars per
 * token — the same order of magnitude confirmed empirically in S-16 T-189,
 * where `--disallowedTools` was shown to exclude a tool's DEFINITION (not just
 * its use) and dropping `Workflow` saved ~4.5k tokens per turn.
 *
 * If a change trips one of these, the answer is to narrow the default policy
 * (`ui-tools-policy.ts`), not to raise the cap without a note saying why.
 */
const CAPS = {
  /** Measured at introduction: 2891 chars (~830 tokens); 3056 at S-32. */
  plan: 3_200,
  /**
   * Plan mode WITH a connected chat (S-32): 3494 chars measured. `send_file`
   * is kept in plan mode on purpose — sending a file that already exists is
   * read-only, and "send me that report" is the main remote use case — so it
   * gets its own cap instead of bending `plan`. Its schema costs ~438 chars
   * (~125 tokens), paid ONLY on runs that relay to a chat (remote runs or the
   * desktop mirror with the bot connected); every other plan run is unchanged.
   */
  planWithSendFile: 3_600,
  /** Measured at introduction: 4180 chars (~1200 tokens). */
  apply: 4_800,
  /**
   * Everything at once — never advertised in practice, but the ceiling.
   * Measured at S-32: 4982 chars without `send_file`, 5420 with it (+438
   * chars, its schema is kept bare).
   */
  all: 5_500,
} as const;

function payloadSize(names: readonly (typeof UI_TOOL_NAMES)[number][]): number {
  return JSON.stringify(advertisedUiTools(names)).length;
}

describe('advertised tool-schema budget', () => {
  it.each([
    ['plan', CAPS.plan],
    ['apply', CAPS.apply],
  ] as const)('%s stays under %i chars', (mode, cap) => {
    const size = payloadSize(resolveAdvertisedUiTools({ mode, isRemote: false, delivered: true }));
    expect(size).toBeLessThanOrEqual(cap);
  });

  it('apply with a connected chat (send_file) still fits the apply cap', () => {
    const size = payloadSize(
      resolveAdvertisedUiTools({ mode: 'apply', isRemote: false, delivered: true, canSendFiles: true }),
    );
    expect(size).toBeLessThanOrEqual(CAPS.apply);
  });

  it('plan with a connected chat (send_file) fits its own explicit cap', () => {
    const tools = resolveAdvertisedUiTools({ mode: 'plan', isRemote: false, delivered: true, canSendFiles: true });
    expect(tools).toContain('send_file');
    expect(payloadSize(tools)).toBeLessThanOrEqual(CAPS.planWithSendFile);
    // The tool is the only difference from a plain plan run: ~438 chars today.
    const plain = resolveAdvertisedUiTools({ mode: 'plan', isRemote: false, delivered: true });
    expect(payloadSize(tools) - payloadSize(plain)).toBeLessThanOrEqual(500);
  });

  it('the whole surface stays under the ceiling', () => {
    expect(payloadSize([...UI_TOOL_NAMES])).toBeLessThanOrEqual(CAPS.all);
  });

  it('a remote run pays only for the three non-interactive tools', () => {
    const remote = resolveAdvertisedUiTools({ mode: 'apply', isRemote: true, delivered: true });
    const desktop = resolveAdvertisedUiTools({ mode: 'apply', isRemote: false, delivered: true });
    expect(payloadSize(remote)).toBeLessThan(payloadSize(desktop) / 2);
  });

  it('an undelivered run costs nothing at all', () => {
    expect(payloadSize(resolveAdvertisedUiTools({ mode: 'apply', isRemote: false, delivered: false })))
      .toBe('[]'.length);
  });
});

describe('advertisedUiTools', () => {
  it('is stable under caller reordering', () => {
    expect(advertisedUiTools(['todo', 'ask_user'])).toEqual(advertisedUiTools(['ask_user', 'todo']));
  });

  it('deduplicates a repeated name', () => {
    expect(advertisedUiTools(['todo', 'todo'])).toHaveLength(1);
  });

  it('exposes every tool with a name, a description and a schema', () => {
    for (const tool of advertisedUiTools([...UI_TOOL_NAMES])) {
      expect(tool.name).toMatch(/^devia_/);
      expect(tool.description.length).toBeGreaterThan(40);
      expect(tool.inputSchema['type']).toBe('object');
    }
  });
});
