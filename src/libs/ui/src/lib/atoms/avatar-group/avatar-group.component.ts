import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import { AvatarComponent, AvatarSize } from '../avatar/component';

export interface AvatarData {
  id: string;
  name: string;
  avatarUrl?: string;
  initials?: string;
}

@Component({
  selector: 'dv-avatar-group',
  imports: [AvatarComponent],
  templateUrl: './avatar-group.component.html',
  styleUrl: './avatar-group.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class]': 'hostClass()',
    role: 'group',
    '[attr.aria-label]': 'ariaLabel()',
  },
})
export class AvatarGroupComponent {
  readonly avatars = input<AvatarData[]>([]);
  readonly maxVisible = input<number>(3);
  readonly size = input<AvatarSize>('md');

  protected readonly hostClass = computed(
    () => `dv-avatar-group dv-avatar-group--${this.size()}`,
  );

  protected readonly visibleAvatars = computed(() =>
    this.avatars().slice(0, this.maxVisible()),
  );

  protected readonly overflowCount = computed(() => {
    const total = this.avatars().length;
    const max = this.maxVisible();
    return total > max ? total - max : 0;
  });

  protected readonly ariaLabel = computed(() => {
    const names = this.visibleAvatars()
      .map((a) => a.name)
      .join(', ');
    const overflow = this.overflowCount();
    return overflow > 0 ? `${names} and ${overflow} more` : names;
  });
}
