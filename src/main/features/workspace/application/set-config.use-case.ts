import type { ConfigRepository } from '../../../shared/ports';
import type { DeviaConfig, DeviaConfigView } from '../../../../shared/domain/config';

export class SetConfigUseCase {
  constructor(private readonly config: ConfigRepository) {}

  execute(partial: Partial<DeviaConfig>): DeviaConfigView {
    this.config.set(partial ?? {});
    return {
      ...this.config.get(),
      configPath: this.config.configPath(),
      hasWorkspace: this.config.hasWorkspace(),
    };
  }
}
