import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import { ButtonComponent } from '../../forms/button';
import { PricingPlan, PricingFeature } from './pricing-table.interfaces';

@Component({
  selector: 'dv-pricing-table',
  imports: [ButtonComponent],
  templateUrl: './component.html',
  styleUrl: './component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PricingTableComponent {
  readonly plans = input<PricingPlan[]>([]);
  readonly features = input<PricingFeature[]>([]);
  readonly ctaClick = output<number>();
}
