/**
 * Agent layer (S-30): per-agent mappers behind contract B.
 *
 *   render ──[shared/contracts]──▶ core (claude-runner) ──[AgentMapper]──▶ agents/<id> ──[wire]──▶ CLI
 */
export type * from './domain';
export { DEDICATED_MAPPERS, StaticMapperRegistry, type MapperFactory } from './infrastructure/static-mapper-registry';
export { LegacyMapper } from './infrastructure/legacy/legacy-mapper';
export type { MapperDeps } from './infrastructure/mapper-deps';
export { ClaudeMapper } from './claude/mapper';
export { PiMapper } from './pi/mapper';
export { OpencodeMapper } from './opencode/mapper';
export { NativeConfigMcpDelivery } from './shared/native-config-mcp';
