import { describe, expect, it } from 'vitest';

import { exposureChoice, isExposureChoice } from './mcp-exposure.model';

describe('exposureChoice', () => {
  it('shows a server with no exposure as direct', () => {
    expect(exposureChoice({})).toBe('direct');
    expect(exposureChoice({ exposure: undefined })).toBe('direct');
  });

  it('shows codemode as code mode', () => {
    expect(exposureChoice({ exposure: 'codemode' })).toBe('codemode');
  });

  it('shows the other catalog exposures as direct, since the gateway does not use them', () => {
    expect(exposureChoice({ exposure: 'direct' })).toBe('direct');
    expect(exposureChoice({ exposure: 'deferred' })).toBe('direct');
    expect(exposureChoice({ exposure: 'hidden' })).toBe('direct');
  });
});

describe('isExposureChoice', () => {
  it('accepts only the two choices the selector offers', () => {
    expect(isExposureChoice('direct')).toBe(true);
    expect(isExposureChoice('codemode')).toBe(true);
    expect(isExposureChoice('hidden')).toBe(false);
    expect(isExposureChoice('')).toBe(false);
  });
});
