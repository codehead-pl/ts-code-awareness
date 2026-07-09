import { Id, Role } from './types';

/**
 * Abstract service base. `describe()` is concrete and calls the abstract
 * `resourceName()` + `count()` methods, giving the engine contract call
 * edges (concrete -> abstract) plus override edges from subclasses.
 */
export abstract class BaseService {
  /** Subclasses declare which resource they manage. */
  protected abstract resourceName(): string;

  /** Subclasses report how many entities they currently hold. */
  abstract count(): Promise<number>;

  /** Concrete method that depends on the abstract contract above. */
  async describe(): Promise<string> {
    const name = this.resourceName();
    const total = await this.count();
    return `${name}: ${total} record(s)`;
  }

  /** Concrete helper reused by subclasses. */
  protected makeKey(id: Id): string {
    return `${this.resourceName()}:${id}`;
  }

  /**
   * Default authorization role for entities this service manages. Exercises two
   * `references` edges: the return-type annotation `Role` (a type used in a
   * signature) and the enum-member read `Role.User` (a value-position use).
   */
  defaultRole(): Role {
    return Role.User;
  }
}
