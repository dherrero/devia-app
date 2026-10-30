import { describe, it, expect } from 'vitest';
import { buildDiagnosticBundle, bundleToClipboardText } from './diagnostic-bundle';
import type { ChatError } from '../../../../shared/domain/chat-error';

// AC5: diagnostic bundle contains run id, provider id, timestamps, error metadata
describe('buildDiagnosticBundle (AC5)', () => {
  it('includes runId, providerId, and generatedAt', () => {
    const bundle = buildDiagnosticBundle({ runId: 'run-1', providerId: 'claude' });
    expect(bundle.runId).toBe('run-1');
    expect(bundle.providerId).toBe('claude');
    expect(bundle.generatedAt).toBeGreaterThan(0);
    expect(bundle.schemaVersion).toBe(1);
  });

  it('includes startedAt and endedAt when provided', () => {
    const bundle = buildDiagnosticBundle({
      runId: 'r', providerId: 'codex',
      startedAt: 1000, endedAt: 2000,
    });
    expect(bundle.startedAt).toBe(1000);
    expect(bundle.endedAt).toBe(2000);
  });

  it('includes error code and message', () => {
    const error: ChatError = { code: 'AUTH_REQUIRED', message: 'Sign in needed', recoverable: true, retryable: false };
    const bundle = buildDiagnosticBundle({ runId: 'r', providerId: 'claude', error });
    expect(bundle.error?.code).toBe('AUTH_REQUIRED');
    expect(bundle.error?.message).toBe('Sign in needed');
  });

  // Redaction: credential fields
  it('redacts credential-shaped keys in details', () => {
    const error: ChatError = {
      code: 'INTERNAL',
      message: 'err',
      recoverable: false,
      retryable: false,
      details: { api_key: 'sk-super-secret', model: 'claude-sonnet' },
    };
    const bundle = buildDiagnosticBundle({ runId: 'r', providerId: 'c', error });
    expect(bundle.error?.details?.['api_key']).toBe('[REDACTED]');
    expect(bundle.error?.details?.['model']).toBe('claude-sonnet'); // not redacted
  });

  it('redacts credential-shaped keys in extra', () => {
    const bundle = buildDiagnosticBundle({
      runId: 'r', providerId: 'c',
      extra: { token: 'abc123', runMode: 'apply' },
    });
    expect(bundle.extra?.['token']).toBe('[REDACTED]');
    expect(bundle.extra?.['runMode']).toBe('apply');
  });

  it('redacts absolute file paths', () => {
    const bundle = buildDiagnosticBundle({
      runId: 'r', providerId: 'c',
      extra: { cwd: '/home/user/secret-project', relative: 'src/main.ts' },
    });
    expect(bundle.extra?.['cwd']).toBe('[PATH_REDACTED]');
    expect(bundle.extra?.['relative']).toBe('src/main.ts'); // not absolute
  });

  it('redacts Windows absolute paths', () => {
    const bundle = buildDiagnosticBundle({
      runId: 'r', providerId: 'c',
      extra: { path: 'C:\\Users\\user\\Documents\\project' },
    });
    expect(bundle.extra?.['path']).toBe('[PATH_REDACTED]');
  });

  it('truncates long strings', () => {
    const longString = 'x'.repeat(1000);
    const bundle = buildDiagnosticBundle({
      runId: 'r', providerId: 'c',
      extra: { longField: longString },
    });
    const truncated = bundle.extra?.['longField'] as string;
    expect(truncated.length).toBeLessThanOrEqual(530); // 512 + '…[truncated]'.length
    expect(truncated).toContain('[truncated]');
  });

  it('does not include prompt text or chat history', () => {
    const bundle = buildDiagnosticBundle({ runId: 'r', providerId: 'c' });
    const keys = Object.keys(bundle);
    expect(keys).not.toContain('prompt');
    expect(keys).not.toContain('history');
    expect(keys).not.toContain('messages');
  });

  it('bundleToClipboardText returns valid JSON', () => {
    const bundle = buildDiagnosticBundle({ runId: 'r', providerId: 'c' });
    const text = bundleToClipboardText(bundle);
    expect(() => JSON.parse(text)).not.toThrow();
  });
});
