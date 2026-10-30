import { Directive, inject, input, TemplateRef } from '@angular/core';

@Directive({
  selector: '[dvTableCell]',
  standalone: true,
})
export class DvTableCellDirective {
  readonly column = input.required<string>({ alias: 'dvTableCell' });
  readonly template = inject(TemplateRef);
}
