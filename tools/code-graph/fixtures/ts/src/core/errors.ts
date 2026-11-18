export class DomainError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
  }
}

export class NotFoundError extends DomainError {
  constructor(what: string) {
    super(`${what} not found`, 'NOT_FOUND');
  }
}

export function isDomainError(err: unknown): err is DomainError {
  return err instanceof DomainError;
}
