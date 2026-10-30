import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildUpgradeUrl } from './index';

describe('buildUpgradeUrl', () => {
  let original: string | undefined;

  beforeEach(() => {
    original = process.env['DEVIA_SAAS_URL'];
  });

  afterEach(() => {
    if (original === undefined) delete process.env['DEVIA_SAAS_URL'];
    else process.env['DEVIA_SAAS_URL'] = original;
  });

  it('returns null when the env var is unset or blank', () => {
    delete process.env['DEVIA_SAAS_URL'];
    expect(buildUpgradeUrl('pinned')).toBeNull();
    process.env['DEVIA_SAAS_URL'] = '   ';
    expect(buildUpgradeUrl('pinned')).toBeNull();
  });

  it('honours an env-supplied origin verbatim', () => {
    process.env['DEVIA_SAAS_URL'] = 'https://saas.example.com';
    expect(buildUpgradeUrl('pinned')).toBe(
      'https://saas.example.com/upgrade?feature=pinned',
    );
  });

  it('strips a trailing slash on the configured origin', () => {
    process.env['DEVIA_SAAS_URL'] = 'https://saas.example.com/';
    expect(buildUpgradeUrl('pinned')).toBe(
      'https://saas.example.com/upgrade?feature=pinned',
    );
  });

  it('encodes feature slugs with spaces and unicode', () => {
    process.env['DEVIA_SAAS_URL'] = 'https://saas.example.com';
    expect(buildUpgradeUrl('multi execution')).toBe(
      'https://saas.example.com/upgrade?feature=multi%20execution',
    );
  });
});
