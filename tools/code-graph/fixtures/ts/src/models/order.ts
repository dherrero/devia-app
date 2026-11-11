import type { User } from './user';

export type OrderStatus = 'open' | 'paid' | 'shipped';

export interface OrderLine {
  sku: string;
  quantity: number;
  unitPrice: number;
}

export class Order {
  private lines: OrderLine[] = [];
  status: OrderStatus = 'open';

  constructor(readonly id: string, readonly owner: User) {}

  addLine(line: OrderLine): void {
    this.lines.push(line);
  }

  total(): number {
    return this.lines.reduce((sum, l) => sum + lineTotal(l), 0);
  }

  markPaid(): void {
    this.status = 'paid';
  }
}

export function lineTotal(line: OrderLine): number {
  return line.quantity * line.unitPrice;
}
