import { Logger } from '@core';
import { OrderService, UserService } from '../services';
import { buildRoutes, dispatch } from '../api/router';
import { slugify as toSlug } from '@utils';
import defaultGreeting from './greeting';

export function main(argv: string[]): number {
  const log = new Logger('cli');
  const users = new UserService(log.child('users'));
  const orders = new OrderService(users, log.child('orders'));
  orders.events.subscribe((e) => log.info(`${e.kind} ${e.orderId}`));
  const routes = buildRoutes(users, orders);
  const [command = 'help', ...rest] = argv;
  log.info(defaultGreeting(toSlug(command)));
  return dispatch(routes, command, rest).status;
}
