// MySQL seed. Uses a raw mysql2 connection (test fixture — the only writer).
// Column names are lowercase to match the Prisma `users` model columns; the
// suite lowercases identifiers before comparing, so table-name casing across
// platforms (lower_case_table_names) is irrelevant to the assertions.
import { USERS, SESSIONS, loadModule } from "./data.ts";

export async function seedMysql(url: string): Promise<void> {
  const mysql = await loadModule("mysql2/promise");
  const conn = await mysql.createConnection({ uri: url, multipleStatements: false });
  try {
    await conn.query("DROP TABLE IF EXISTS sessions");
    await conn.query("DROP TABLE IF EXISTS users");
    await conn.query("CREATE TABLE users (id varchar(64) PRIMARY KEY, email varchar(255), name varchar(255), role varchar(32))");
    await conn.query("CREATE TABLE sessions (id varchar(64) PRIMARY KEY, userId varchar(64))");
    for (const r of USERS) {
      await conn.query("INSERT INTO users (id, email, name, role) VALUES (?, ?, ?, ?)", [r.id, r.email, r.name, r.role]);
    }
    for (const r of SESSIONS) {
      await conn.query("INSERT INTO sessions (id, userId) VALUES (?, ?)", [r.id, r.userId]);
    }
  } finally {
    await conn.end();
  }
}
