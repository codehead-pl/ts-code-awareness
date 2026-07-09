import { BaseService } from '@fixture/core';
import { InMemoryUserRepository } from './in-memory-user-repository';

/**
 * Subclass of the abstract `BaseService` from `@fixture/core`.
 * Overrides `resourceName()` and `count()`; inherits the concrete
 * `describe()` which calls those overrides (contract call edges).
 */
export class WorkerService extends BaseService {
  constructor(private readonly repo = new InMemoryUserRepository()) {
    super();
  }

  protected resourceName(): string {
    return 'user';
  }

  async count(): Promise<number> {
    return this.repo.size();
  }
}
