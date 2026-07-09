import { Repository, User, Id } from '@fixture/core';

/**
 * Cross-package interface implementer: implements `Repository<User>`
 * declared in `@fixture/core`. The analysis engine should link this
 * class back to the interface across the package boundary via the
 * tsconfig path alias `@fixture/core`.
 */
export class InMemoryUserRepository implements Repository<User> {
  private readonly store = new Map<Id, User>();

  async findById(id: Id): Promise<User | null> {
    return this.store.get(id) ?? null;
  }

  async save(entity: User): Promise<User> {
    this.store.set(entity.id, entity);
    return entity;
  }

  /** Non-interface helper used by WorkerService. */
  size(): number {
    return this.store.size;
  }
}
