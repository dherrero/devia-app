import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { NgIf, NgFor } from '@angular/common';

export interface BreadcrumbItem {
  label: string;
  href?: string;
  routerLink?: string | string[];
}

@Component({
  selector: 'dv-breadcrumb',
  templateUrl: './component.html',
  styleUrl: './component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
})
export class BreadcrumbComponent {
  readonly items = input<BreadcrumbItem[]>([]);
}
