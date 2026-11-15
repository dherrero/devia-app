export type Handler<T> = (payload: T) => void;

export class EventBus<T> {
  private handlers: Handler<T>[] = [];

  subscribe(handler: Handler<T>): () => void {
    this.handlers.push(handler);
    return () => this.unsubscribe(handler);
  }

  unsubscribe(handler: Handler<T>): void {
    this.handlers = this.handlers.filter((h) => h !== handler);
  }

  publish(payload: T): void {
    for (const handler of this.handlers) handler(payload);
  }
}
