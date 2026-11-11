import { isDomainError } from '@core/errors';
import type { OrderService, UserService } from '../services';
import * as strings from '../utils/strings';

export interface Response {
  status: number;
  body: string;
}

export function handleRegister(users: UserService, name: string, email: string): Response {
  return guard(() => strings.capitalise(users.register(name, email).name));
}

export function handlePay(orders: OrderService, orderId: string): Response {
  return guard(() => orders.pay(orderId));
}

function guard(work: () => string): Response {
  try {
    return { status: 200, body: work() };
  } catch (err) {
    if (isDomainError(err)) return { status: 404, body: err.code };
    throw err;
  }
}
