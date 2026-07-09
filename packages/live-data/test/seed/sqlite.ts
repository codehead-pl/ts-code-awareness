// SQLite seed (reference engine, built-in node:sqlite — zero native deps).
import { DatabaseSync } from "node:sqlite";
import { rmSync } from "node:fs";
import { USERS, SESSIONS } from "./data.ts";

export function seedSqlite(path: string): void {
  rmSync(path, { force: true });
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, name TEXT, role TEXT);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, userId TEXT);
  `);
  const u = db.prepare("INSERT INTO users (id, email, name, role) VALUES (?, ?, ?, ?)");
  for (const r of USERS) u.run(r.id, r.email, r.name, r.role);
  const s = db.prepare("INSERT INTO sessions (id, userId) VALUES (?, ?)");
  for (const r of SESSIONS) s.run(r.id, r.userId);
  db.close();
}
