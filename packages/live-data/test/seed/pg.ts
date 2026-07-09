// Postgres seed. Uses a *raw* pg client (not the guarded SqliteDriver/PgDriver
// read surface) — seeding is a test fixture concern and is the only place we
// write. Identifiers are lowercase so information_schema introspection matches
// the Prisma `users` columns without quoting games.
import { USERS, SESSIONS, loadModule } from "./data.ts";

export async function seedPg(url: string): Promise<void> {
  const pg = await loadModule("pg");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("DROP TABLE IF EXISTS sessions");
    await client.query("DROP TABLE IF EXISTS users");
    await client.query("CREATE TABLE users (id text PRIMARY KEY, email text, name text, role text)");
    await client.query('CREATE TABLE sessions (id text PRIMARY KEY, "userId" text)');
    for (const r of USERS) {
      await client.query("INSERT INTO users (id, email, name, role) VALUES ($1, $2, $3, $4)", [r.id, r.email, r.name, r.role]);
    }
    for (const r of SESSIONS) {
      await client.query('INSERT INTO sessions (id, "userId") VALUES ($1, $2)', [r.id, r.userId]);
    }
  } finally {
    await client.end();
  }
}
