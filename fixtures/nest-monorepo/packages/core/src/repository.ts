import { Id } from './types';

/**
 * Generic persistence contract. Implementers live in other packages
 * (see `@fixture/worker` -> InMemoryUserRepository) so the analysis
 * engine can resolve cross-package interface implementers.
 */
export interface Repository<T> {
  findById(id: Id): Promise<T | null>;
  save(entity: T): Promise<T>;
}

/** Optional extension contract for repositories that support listing. */
export interface ListableRepository<T> extends Repository<T> {
  findAll(): Promise<T[]>;
}
