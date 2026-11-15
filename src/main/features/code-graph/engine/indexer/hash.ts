import { createHash } from 'node:crypto';

export function contentHash(buf: Buffer): string {
  return createHash('sha1').update(buf).digest('hex');
}
