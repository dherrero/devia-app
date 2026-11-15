import { Logger } from '@core/logger';
import { createUser, type User } from '@models/user';
import { slugify } from '@utils';
import { InMemoryRepository } from './repository';

export class UserService {
  private readonly repo = new InMemoryRepository<User>();

  constructor(private readonly log: Logger) {}

  register(name: string, email: string): User {
    const user = createUser(slugify(name), name, email);
    this.repo.save(user);
    this.log.info(`registered ${user.id}`);
    return user;
  }

  find(id: string): User {
    return this.repo.get(id);
  }
}
