import type {
  DiscoverSkillsRequest,
  DiscoverSkillsResult,
} from '../../../../shared/domain/skill';
import type { SkillDiscoverer } from '../infrastructure/skill-discoverer';

export class DiscoverSkillsUseCase {
  constructor(private readonly discoverer: SkillDiscoverer) {}
  execute(req: DiscoverSkillsRequest): Promise<DiscoverSkillsResult> {
    return this.discoverer.discover(req);
  }
}
