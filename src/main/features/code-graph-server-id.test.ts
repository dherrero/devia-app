import { describe, expect, it } from 'vitest';
import { CODE_GRAPH_SERVER_ID as nativeConfigId } from './agents/shared/native-config-mcp';
import { DEVIA_MCP_SERVER_IDS } from './agents/pi/rpc-driver';
import { CODE_GRAPH_SERVER_ID as runnerId } from './claude-runner/application/run-instruction.use-case';
import { CODE_GRAPH_SERVER_ID as geminiId } from './cli-adapters/infrastructure/defs/gemini';
import { CODE_GRAPH_SERVER_ID as injectorId } from './code-graph';
import { BUNDLED_SERVER_IDS } from './mcp/infrastructure/marker-merge';

// Features never import each other, so the code-graph server id is copied
// into every feature that has to recognise it. A rename in the injector alone
// would silently drop the prompt block, the Gemini plan-mode rule and the
// stale native-config cleanup of graph runs; this test makes it loud.
describe('code-graph MCP server id copies', () => {
  it.each([
    ['claude-runner run-instruction', runnerId],
    ['agents native-config-mcp', nativeConfigId],
    ['cli-adapters gemini', geminiId],
  ])('%s matches the injector id', (_where, id) => {
    expect(id).toBe(injectorId);
  });

  it('is listed among the bundled server ids (Pi RPC driver and marker merge)', () => {
    expect(DEVIA_MCP_SERVER_IDS).toContain(injectorId);
    expect(BUNDLED_SERVER_IDS.has(injectorId)).toBe(true);
  });
});
