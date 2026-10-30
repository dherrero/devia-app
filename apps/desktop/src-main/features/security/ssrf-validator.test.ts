import { describe, it, expect } from 'vitest';
import { SsrfValidator } from './ssrf-validator';

function mockResolver(map: Record<string, string[]>) {
  return async (hostname: string): Promise<string[]> => {
    return map[hostname] ?? [];
  };
}

describe('SsrfValidator', () => {
  // AC3: host resolving to loopback is rejected
  it('rejects host resolving to 127.0.0.1 (AC3)', async () => {
    const v = new SsrfValidator(mockResolver({ 'localhost': ['127.0.0.1'] }));
    const result = await v.validate('http://localhost/api');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('private_address');
    expect(result.resolvedAddress).toBe('127.0.0.1');
  });

  it('rejects host resolving to IPv4 link-local (169.254.x.x)', async () => {
    const v = new SsrfValidator(mockResolver({ 'metadata.local': ['169.254.169.254'] }));
    const result = await v.validate('http://metadata.local/latest');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('private_address');
  });

  it('rejects host resolving to private 10.x.x.x', async () => {
    const v = new SsrfValidator(mockResolver({ 'internal': ['10.0.0.1'] }));
    const result = await v.validate('http://internal/path');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('private_address');
  });

  it('rejects host resolving to private 192.168.x.x', async () => {
    const v = new SsrfValidator(mockResolver({ 'router': ['192.168.1.1'] }));
    const result = await v.validate('http://router/');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('private_address');
  });

  it('rejects host resolving to private 172.16-31.x.x', async () => {
    const v = new SsrfValidator(mockResolver({ 'corp': ['172.16.0.1'] }));
    const result = await v.validate('http://corp/');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('private_address');
  });

  it('rejects IPv6 loopback ::1', async () => {
    const v = new SsrfValidator(mockResolver({ 'v6host': ['::1'] }));
    const result = await v.validate('http://v6host/');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('private_address');
  });

  it('allows host resolving to public IP', async () => {
    const v = new SsrfValidator(mockResolver({ 'example.com': ['93.184.216.34'] }));
    const result = await v.validate('http://example.com/api');
    expect(result.ok).toBe(true);
    expect(result.resolvedAddress).toBe('93.184.216.34');
  });

  it('rejects unresolvable host', async () => {
    const v = new SsrfValidator(mockResolver({}));
    const result = await v.validate('http://no-such-host.invalid/');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unresolvable');
  });

  it('rejects disallowed scheme (ftp)', async () => {
    const v = new SsrfValidator(mockResolver({ 'ftp.example.com': ['1.2.3.4'] }));
    const result = await v.validate('ftp://ftp.example.com/file');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('disallowed_scheme');
  });

  it('rejects malformed URL', async () => {
    const v = new SsrfValidator(mockResolver({}));
    const result = await v.validate('not-a-url');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unresolvable');
  });

  it('allows explicitly allowed hosts without DNS lookup', async () => {
    const v = new SsrfValidator(
      // Resolver that would reject the host if called
      mockResolver({ 'allowed-internal.local': ['10.0.0.1'] }),
      ['allowed-internal.local'],
    );
    const result = await v.validate('http://allowed-internal.local/api');
    expect(result.ok).toBe(true);
  });

  it('caches DNS results to avoid redundant lookups', async () => {
    let callCount = 0;
    const resolver = async (): Promise<string[]> => {
      callCount++;
      return ['93.184.216.34'];
    };
    const v = new SsrfValidator(resolver);
    await v.validate('http://example.com/a');
    await v.validate('http://example.com/b');
    expect(callCount).toBe(1); // second call used cache
  });

  it('clearCache forces fresh DNS lookup', async () => {
    let callCount = 0;
    const resolver = async (): Promise<string[]> => {
      callCount++;
      return ['93.184.216.34'];
    };
    const v = new SsrfValidator(resolver);
    await v.validate('http://example.com/a');
    v.clearCache();
    await v.validate('http://example.com/b');
    expect(callCount).toBe(2);
  });
});
