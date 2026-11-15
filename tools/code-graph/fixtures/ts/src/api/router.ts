import { handlePay, handleRegister, type Response } from './handlers';
import type { OrderService, UserService } from '../services';

type Route = (args: string[]) => Response;

export function buildRoutes(users: UserService, orders: OrderService): Map<string, Route> {
  const routes = new Map<string, Route>();
  routes.set('register', ([name = '', email = '']) => handleRegister(users, name, email));
  routes.set('pay', ([id = '']) => handlePay(orders, id));
  return routes;
}

export function dispatch(routes: Map<string, Route>, command: string, args: string[]): Response {
  const route = routes.get(command);
  return route ? route(args) : notFound(command);
}

const notFound = (command: string): Response => ({ status: 404, body: command });
