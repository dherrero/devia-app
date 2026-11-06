import { createHash } from 'node:crypto';
import type { NodeKind } from '../../../../../shared/domain/code-graph';

export function makeNodeId(
  filePath: string,
  kind: NodeKind,
  qualifiedName: string,
  startLine: number,
): string {
  const normalised = filePath.replace(/\\/g, '/');
  const digest = createHash('sha256')
    .update(`${normalised}\0${kind}\0${qualifiedName}\0${startLine}`)
    .digest('hex')
    .slice(0, 32);
  return `${kind}:${digest}`;
}
