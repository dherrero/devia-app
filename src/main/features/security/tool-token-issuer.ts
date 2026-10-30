import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

/** Default TTL for tool tokens: 30 minutes. */
const DEFAULT_TTL_MS = 30 * 60 * 1000;

export interface ToolToken {
  /** The raw token value — shown once at mint time, never stored in plaintext. */
  token: string;
  runId: string;
  allowedEndpoints: ReadonlyArray<string>;
  allowedOperations: ReadonlyArray<string>;
  expiresAt: number;
}

export type ToolTokenValidationResult =
  | { ok: true; runId: string }
  | { ok: false; reason: 'expired' | 'revoked' | 'scope' | 'unknown' };

export interface ToolTokenIssuer {
  /**
   * Mint a new short-lived token. The raw token value is returned once;
   * subsequent lookups use the hash stored internally.
   */
  mint(
    input: Omit<ToolToken, 'token' | 'expiresAt'> & { ttlMs?: number },
  ): ToolToken;

  /**
   * Validate a token against an endpoint and operation.
   * Lookup is constant-time against the stored hash.
   */
  validate(
    token: string,
    endpoint: string,
    operation: string,
  ): ToolTokenValidationResult;

  /**
   * Revoke a token explicitly. Idempotent — revoking an already-expired or
   * unknown token is a no-op.
   */
  revoke(token: string, reason: 'run_end' | 'manual' | 'shutdown'): void;

  /**
   * Revoke all tokens issued for a given runId. Called when a run ends.
   */
  revokeByRunId(runId: string, reason: 'run_end' | 'shutdown'): void;
}

interface StoredToken {
  hash: Buffer;
  runId: string;
  allowedEndpoints: ReadonlyArray<string>;
  allowedOperations: ReadonlyArray<string>;
  expiresAt: number;
  revoked: boolean;
}

function hashToken(raw: string): Buffer {
  return createHash('sha256').update(raw, 'utf8').digest();
}

export class ConcreteToolTokenIssuer implements ToolTokenIssuer {
  private readonly store = new Map<string, StoredToken>();

  private now(): number {
    return Date.now();
  }

  mint(
    input: Omit<ToolToken, 'token' | 'expiresAt'> & { ttlMs?: number },
  ): ToolToken {
    const raw = randomBytes(32).toString('hex'); // 256 bits
    const hash = hashToken(raw);
    const expiresAt = this.now() + (input.ttlMs ?? DEFAULT_TTL_MS);

    const stored: StoredToken = {
      hash,
      runId: input.runId,
      allowedEndpoints: input.allowedEndpoints,
      allowedOperations: input.allowedOperations,
      expiresAt,
      revoked: false,
    };

    // Key by a hex fingerprint of the hash for fast lookup
    this.store.set(hash.toString('hex'), stored);

    return {
      token: raw,
      runId: input.runId,
      allowedEndpoints: input.allowedEndpoints,
      allowedOperations: input.allowedOperations,
      expiresAt,
    };
  }

  validate(
    token: string,
    endpoint: string,
    operation: string,
  ): ToolTokenValidationResult {
    const hash = hashToken(token);
    const key = hash.toString('hex');
    const stored = this.store.get(key);

    if (!stored) return { ok: false, reason: 'unknown' };

    // Constant-time comparison between the stored hash and the derived hash
    if (!timingSafeEqual(stored.hash, hash)) {
      return { ok: false, reason: 'unknown' };
    }

    if (stored.revoked) return { ok: false, reason: 'revoked' };
    if (this.now() > stored.expiresAt) return { ok: false, reason: 'expired' };

    const endpointAllowed =
      stored.allowedEndpoints.length === 0 ||
      stored.allowedEndpoints.includes(endpoint);
    const operationAllowed =
      stored.allowedOperations.length === 0 ||
      stored.allowedOperations.includes(operation);

    if (!endpointAllowed || !operationAllowed) {
      return { ok: false, reason: 'scope' };
    }

    return { ok: true, runId: stored.runId };
  }

  revoke(token: string, reason: 'run_end' | 'manual' | 'shutdown'): void {
    void reason;
    const key = hashToken(token).toString('hex');
    const stored = this.store.get(key);
    if (stored) stored.revoked = true;
  }

  revokeByRunId(runId: string, reason: 'run_end' | 'shutdown'): void {
    for (const stored of this.store.values()) {
      if (stored.runId === runId) {
        this.revoke(
          // We don't have the raw token here; mark revoked directly
          '', // token won't be used below since we set revoked directly
          reason,
        );
        stored.revoked = true;
      }
    }
  }
}
