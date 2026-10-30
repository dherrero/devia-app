import { promises as dns } from 'node:dns';

export type UrlValidationReason =
  | 'unresolvable'
  | 'private_address'
  | 'disallowed_scheme'
  | 'redirect_loop';

export interface UrlValidationResult {
  ok: boolean;
  reason?: UrlValidationReason;
  resolvedAddress?: string;
}

/** Resolver type — injectable for testing with mocked DNS. */
export type DnsResolver = (hostname: string) => Promise<string[]>;

/** Default TTL for cached DNS resolutions (5 seconds). */
const CACHE_TTL_MS = 5_000;

interface CacheEntry {
  addresses: string[];
  expiresAt: number;
}

// ── Private address range checks ──────────────────────────────────────────────

function isPrivateIPv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p))) return false;
  const [a, b] = parts as [number, number, number, number];

  return (
    a === 127 ||                          // loopback
    a === 10 ||                           // RFC 1918
    (a === 172 && b >= 16 && b <= 31) ||  // RFC 1918
    (a === 192 && b === 168) ||           // RFC 1918
    (a === 169 && b === 254) ||           // link-local
    a === 0                               // "this" network
  );
}

function isLoopbackOrPrivate(address: string): boolean {
  if (address === '::1' || address === '0:0:0:0:0:0:0:1') return true;
  if (address.startsWith('fe80:') || address.startsWith('FE80:')) return true;
  if (address.startsWith('fc') || address.startsWith('fd')) return true;
  return isPrivateIPv4(address);
}

const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

// ── Validator ─────────────────────────────────────────────────────────────────

export class SsrfValidator {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly allowedHosts: ReadonlySet<string>;

  constructor(
    private readonly resolver: DnsResolver = defaultResolver,
    allowedHosts: readonly string[] = [],
  ) {
    this.allowedHosts = new Set(allowedHosts);
  }

  async validate(rawUrl: string): Promise<UrlValidationResult> {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return { ok: false, reason: 'unresolvable' };
    }

    if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
      return { ok: false, reason: 'disallowed_scheme' };
    }

    const { hostname } = parsed;

    if (this.allowedHosts.has(hostname)) {
      return { ok: true };
    }

    const addresses = await this.resolveWithCache(hostname);
    if (addresses.length === 0) {
      return { ok: false, reason: 'unresolvable' };
    }

    for (const addr of addresses) {
      if (isLoopbackOrPrivate(addr)) {
        return { ok: false, reason: 'private_address', resolvedAddress: addr };
      }
    }

    const addr = addresses[0];
    return addr !== undefined ? { ok: true, resolvedAddress: addr } : { ok: true };
  }

  private async resolveWithCache(hostname: string): Promise<string[]> {
    const now = Date.now();
    const cached = this.cache.get(hostname);
    if (cached && now < cached.expiresAt) {
      return cached.addresses;
    }

    let addresses: string[];
    try {
      addresses = await this.resolver(hostname);
    } catch {
      addresses = [];
    }

    this.cache.set(hostname, { addresses, expiresAt: now + CACHE_TTL_MS });
    return addresses;
  }

  /** Clear the DNS cache — useful after a redirect that may change resolution. */
  clearCache(): void {
    this.cache.clear();
  }
}

async function defaultResolver(hostname: string): Promise<string[]> {
  const results = await dns.lookup(hostname, { all: true });
  return results.map((r) => r.address);
}

export function createSsrfValidator(
  resolver?: DnsResolver,
  allowedHosts?: readonly string[],
): SsrfValidator {
  return new SsrfValidator(resolver, allowedHosts);
}
