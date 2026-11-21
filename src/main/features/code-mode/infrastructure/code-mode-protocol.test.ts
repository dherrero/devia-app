import { describe, expect, it } from 'vitest';

import { codeModeProtocol } from './code-mode-protocol';

describe('codeModeProtocol', () => {
  it('is silent when the gateway did not reach this run', () => {
    expect(codeModeProtocol({ serverIds: ['tiendas'], delivered: false })).toBeNull();
  });

  it('is silent when no server is behind the gateway', () => {
    expect(codeModeProtocol({ serverIds: [], delivered: true })).toBeNull();
  });

  it('names the servers and the two tools when it applies', () => {
    const text = codeModeProtocol({ serverIds: ['tiendas', 'financiera'], delivered: true });
    expect(text).toContain('`tiendas`');
    expect(text).toContain('`financiera`');
    expect(text).toContain('search_tools');
    expect(text).toContain('run_script');
  });
});
