import { describe, it, expect } from 'vitest';
import { ConcreteToolTokenIssuer } from './tool-token-issuer';

describe('ConcreteToolTokenIssuer', () => {
  it('mints a token with correct metadata', () => {
    const issuer = new ConcreteToolTokenIssuer();
    const token = issuer.mint({
      runId: 'run-1',
      allowedEndpoints: ['read'],
      allowedOperations: ['open'],
    });
    expect(token.token).toHaveLength(64); // 32 bytes = 64 hex chars
    expect(token.runId).toBe('run-1');
    expect(token.expiresAt).toBeGreaterThan(Date.now());
  });

  it('respects custom TTL', () => {
    const issuer = new ConcreteToolTokenIssuer();
    const before = Date.now();
    const token = issuer.mint({ runId: 'r', allowedEndpoints: [], allowedOperations: [], ttlMs: 1000 });
    expect(token.expiresAt).toBeGreaterThanOrEqual(before + 900);
    expect(token.expiresAt).toBeLessThanOrEqual(before + 2000);
  });

  it('validates a fresh token successfully', () => {
    const issuer = new ConcreteToolTokenIssuer();
    const { token } = issuer.mint({
      runId: 'run-2',
      allowedEndpoints: ['file://'],
      allowedOperations: ['read'],
    });
    const result = issuer.validate(token, 'file://', 'read');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.runId).toBe('run-2');
  });

  it('returns unknown for unrecognized token', () => {
    const issuer = new ConcreteToolTokenIssuer();
    const result = issuer.validate('not-a-real-token', 'ep', 'op');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unknown');
  });

  // AC4: token bound to run A fails for run B check (scope mismatch on runId)
  it('scope: token bound to run A, validate with different runId not possible (AC4 note)', () => {
    // The validator does not accept a runId argument — it returns the stored runId.
    // This test verifies the token cannot be "confused" into another run by
    // checking that validation returns the original runId, not any caller-supplied value.
    const issuer = new ConcreteToolTokenIssuer();
    const { token } = issuer.mint({ runId: 'run-A', allowedEndpoints: [], allowedOperations: [] });
    const result = issuer.validate(token, '', '');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.runId).toBe('run-A');
  });

  it('scope: endpoint not in allowedEndpoints returns scope error', () => {
    const issuer = new ConcreteToolTokenIssuer();
    const { token } = issuer.mint({
      runId: 'r',
      allowedEndpoints: ['allowed-endpoint'],
      allowedOperations: ['op'],
    });
    const result = issuer.validate(token, 'other-endpoint', 'op');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('scope');
  });

  it('scope: operation not in allowedOperations returns scope error', () => {
    const issuer = new ConcreteToolTokenIssuer();
    const { token } = issuer.mint({
      runId: 'r',
      allowedEndpoints: ['ep'],
      allowedOperations: ['allowed-op'],
    });
    const result = issuer.validate(token, 'ep', 'other-op');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('scope');
  });

  it('empty allowedEndpoints means all endpoints allowed', () => {
    const issuer = new ConcreteToolTokenIssuer();
    const { token } = issuer.mint({ runId: 'r', allowedEndpoints: [], allowedOperations: [] });
    const result = issuer.validate(token, 'any-endpoint', 'any-op');
    expect(result.ok).toBe(true);
  });

  it('revoke makes token invalid', () => {
    const issuer = new ConcreteToolTokenIssuer();
    const { token } = issuer.mint({ runId: 'r', allowedEndpoints: [], allowedOperations: [] });
    issuer.revoke(token, 'manual');
    const result = issuer.validate(token, '', '');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('revoked');
  });

  it('revoke is idempotent', () => {
    const issuer = new ConcreteToolTokenIssuer();
    const { token } = issuer.mint({ runId: 'r', allowedEndpoints: [], allowedOperations: [] });
    issuer.revoke(token, 'manual');
    expect(() => issuer.revoke(token, 'manual')).not.toThrow();
  });

  it('revokeByRunId revokes all tokens for a run', () => {
    const issuer = new ConcreteToolTokenIssuer();
    const { token: t1 } = issuer.mint({ runId: 'run-X', allowedEndpoints: [], allowedOperations: [] });
    const { token: t2 } = issuer.mint({ runId: 'run-X', allowedEndpoints: [], allowedOperations: [] });
    const { token: t3 } = issuer.mint({ runId: 'run-Y', allowedEndpoints: [], allowedOperations: [] });

    issuer.revokeByRunId('run-X', 'run_end');

    expect(issuer.validate(t1, '', '').ok).toBe(false);
    expect(issuer.validate(t2, '', '').ok).toBe(false);
    expect(issuer.validate(t3, '', '').ok).toBe(true); // different run unaffected
  });

  it('expired token returns expired reason', async () => {
    const issuer = new ConcreteToolTokenIssuer();
    const { token } = issuer.mint({ runId: 'r', allowedEndpoints: [], allowedOperations: [], ttlMs: 1 });
    // Wait for expiry
    await new Promise((r) => setTimeout(r, 10));
    const result = issuer.validate(token, '', '');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('expired');
  });
});
