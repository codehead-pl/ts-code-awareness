// Shared seed data for the live-data acceptance suite. Every engine is seeded
// with the SAME logical rows so the parameterized suite (SQLite/Postgres/MySQL)
// makes identical assertions regardless of driver.
//
// Layout mirrors the Prisma fixture on purpose so drift reconciliation has a
// real signal:
//   - `users`   matches the `User` model (@@map("users")) column-for-column →
//               so the suite asserts *no* column drift on users.
//   - `sessions` exists only live (no Prisma model) → asserts a "table in DB not
//               in schema" drift.
//   - `Post`    model exists only in the schema (no table here) → asserts a
//               "model in schema not in DB" drift.
export interface SeedUser {
  id: string;
  email: string;
  name: string;
  role: "ADMIN" | "USER";
}

export const USERS: SeedUser[] = [
  { id: "1", email: "a@x.com", name: "Ann", role: "ADMIN" },
  { id: "2", email: "b@x.com", name: "Bo", role: "USER" },
  { id: "3", email: "c@x.com", name: "Cy", role: "USER" },
  { id: "4", email: "d@x.com", name: "Di", role: "USER" },
  { id: "5", email: "e@x.com", name: "Ed", role: "USER" },
];

export const SESSIONS = [
  { id: "s1", userId: "1" },
  { id: "s2", userId: "2" },
];

/** Dynamic import via a *variable* specifier so tsc treats the result as `any`
 *  and never tries to resolve type declarations for the optional peer dep. */
export async function loadModule(name: string): Promise<any> {
  return import(name);
}
