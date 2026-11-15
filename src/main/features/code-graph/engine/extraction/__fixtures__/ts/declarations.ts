export interface Shape extends Base {
  area(): number;
  name: string;
}

export type Id = string;

export enum Color {
  Red,
  Green = 2,
}

export namespace Geometry {
  export function area() {
    return 0;
  }
}

@Component({})
export class Widget {
  @Input() label = '';

  @HostListener('click')
  onClick() {}
}

const hidden = 1;
export { hidden as visible };
export * from './barrel';
