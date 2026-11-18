import { EventBus, Logger } from '@core';
import { Order, type OrderLine } from '../models';
import { formatMoney } from '@utils';
import { InMemoryRepository } from './repository';
import { UserService } from './user-service';

export interface OrderEvent {
  orderId: string;
  kind: 'created' | 'paid';
}

export class OrderService {
  readonly events = new EventBus<OrderEvent>();
  private readonly repo = new InMemoryRepository<Order>();

  constructor(private readonly users: UserService, private readonly log: Logger) {}

  open(orderId: string, userId: string, lines: OrderLine[]): Order {
    const owner = this.users.find(userId);
    const order = new Order(orderId, owner);
    lines.forEach((line) => order.addLine(line));
    this.repo.save(order);
    this.events.publish({ orderId, kind: 'created' });
    return order;
  }

  pay(orderId: string): string {
    const order = this.repo.get(orderId);
    order.markPaid();
    this.events.publish({ orderId, kind: 'paid' });
    const amount = formatMoney(order.total());
    this.log.warn(`paid ${amount}`);
    return amount;
  }
}
