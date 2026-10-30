import type { ConfigRepository } from '../../../shared/ports';
import type { DeviaConfigView } from '../../../../shared/domain/config';

export class GetConfigUseCase {
  constructor(private readonly config: ConfigRepository) {}

  execute(): DeviaConfigView {
    return {
      ...this.config.get(),
      configPath: this.config.configPath(),
      hasWorkspace: this.config.hasWorkspace(),
    };
  }
}
