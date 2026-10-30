import { describe, expect, it } from 'vitest';
import { engramErrorKey } from './engram-error-key';

describe('engramErrorKey (S-1 pure logic)', () => {
  it('maps engram-binary-missing', () => {
    expect(engramErrorKey('engram-binary-missing')).toBe('modals.engram_import.error_binary_missing');
  });
  it('maps engram-export-timeout', () => {
    expect(engramErrorKey('engram-export-timeout')).toBe('modals.engram_import.error_timeout');
  });
  it('maps engram-export-failed', () => {
    expect(engramErrorKey('engram-export-failed')).toBe('modals.engram_import.error_export_failed');
  });
  it('maps engram-parse-error', () => {
    expect(engramErrorKey('engram-parse-error')).toBe('modals.engram_import.error_parse');
  });
});
