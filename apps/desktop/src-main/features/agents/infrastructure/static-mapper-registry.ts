import type { RuntimeAgentDef } from '../../cli-adapters/domain/runtime-agent-def';
import type { AgentMapper, MapperRegistry } from '../domain';
import { ClaudeMapper } from '../claude/mapper';
import { PiMapper } from '../pi/mapper';
import { OpencodeMapper } from '../opencode/mapper';
import { LegacyMapper } from './legacy/legacy-mapper';
import type { MapperDeps } from './mapper-deps';

/** Builds the dedicated mapper for one agent from its def. */
export type MapperFactory = (def: RuntimeAgentDef, deps: MapperDeps) => AgentMapper;

/** Agents with their own mapper (S-30 phase 1); every other def runs on `LegacyMapper`. */
export const DEDICATED_MAPPERS: Readonly<Record<string, MapperFactory>> = {
  claude: (def, deps) => new ClaudeMapper(def, deps),
  pi: (def, deps) => new PiMapper(def, deps),
  opencode: (def, deps) => new OpencodeMapper(def, deps),
};

/**
 * Agent id → mapper. Dedicated mappers register a factory; any other def
 * (including user-supplied ones) falls back to `LegacyMapper`. Mappers are
 * cached per def instance, so a def re-registered at runtime gets a fresh one.
 */
export class StaticMapperRegistry implements MapperRegistry {
  private readonly cache = new WeakMap<RuntimeAgentDef, AgentMapper>();

  constructor(
    private readonly deps: MapperDeps,
    private readonly dedicated: Readonly<Record<string, MapperFactory>> = DEDICATED_MAPPERS,
  ) {}

  forDef(def: RuntimeAgentDef): AgentMapper {
    const cached = this.cache.get(def);
    if (cached) return cached;
    const factory = this.dedicated[def.id];
    const mapper = factory ? factory(def, this.deps) : new LegacyMapper(def, this.deps);
    this.cache.set(def, mapper);
    return mapper;
  }
}
