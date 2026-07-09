/**
 * Shared primitive types and enums used across packages.
 */

/** Branded-ish alias for entity identifiers. */
export type Id = string;

/** Timestamp expressed as an ISO-8601 string. */
export type IsoDateString = string;

/** Coarse-grained authorization role. */
export enum Role {
  Admin = 'ADMIN',
  User = 'USER',
}

/** Anything that can be persisted has a stable identifier. */
export interface Entity {
  id: Id;
}

/** Minimal user shape shared between library and app layers. */
export interface User extends Entity {
  email: string;
  name?: string;
  role: Role;
}
