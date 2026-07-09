// The SELECT-only guard. Absolute invariant: the
// live-data surface NEVER mutates the target DB. This guard is the enforcement
// point — it fails safe (rejects anything it can't prove is a single read-only
// statement). `data_explain --analyze` is the one place "never executes" is
// relaxed (opt-in, config-gated), and even there the inner statement must pass
// this guard so ANALYZE can only ever run a SELECT.

export interface GuardResult {
  ok: boolean;
  reason?: string;
}

// Statement leads we accept: all are read-only. Everything else (INSERT/UPDATE/
// DELETE/MERGE/CREATE/ALTER/DROP/TRUNCATE/GRANT/CALL/DO/COPY/SET/…) is rejected
// by omission — a whitelist, not a blacklist.
const ALLOWED_LEAD = new Set(["SELECT", "WITH", "VALUES", "TABLE"]);

// Tokens that must never appear in an accepted statement (data-modifying CTEs,
// SELECT INTO). Checked outside of string/comment/identifier context.
const FORBIDDEN_TOKENS = /\b(INSERT|UPDATE|DELETE|MERGE|UPSERT|REPLACE|INTO|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|CALL|EXECUTE|COPY|VACUUM|ATTACH|DETACH|PRAGMA|REINDEX)\b/i;

/** Split SQL into top-level statements with comments stripped, respecting
 *  string/identifier quoting. Returns null if an unsupported construct
 *  (dollar-quoting) is present — in which case the guard fails safe. */
function scrub(sql: string): { statements: string[]; unsupported?: string } {
  let out = "";
  const statements: string[] = [];
  let i = 0;
  const n = sql.length;
  const push = () => {
    const s = out.trim();
    if (s) statements.push(s);
    out = "";
  };
  while (i < n) {
    const c = sql[i];
    const c2 = sql[i + 1];
    // line comment
    if (c === "-" && c2 === "-") {
      while (i < n && sql[i] !== "\n") i += 1;
      out += " ";
      continue;
    }
    // block comment
    if (c === "/" && c2 === "*") {
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i += 1;
      i += 2;
      out += " ";
      continue;
    }
    // dollar-quote ($$ or $tag$) — unsupported, fail safe
    if (c === "$") {
      const m = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i));
      if (m) return { statements: [], unsupported: "dollar-quoted strings" };
    }
    // single-quoted string
    if (c === "'") {
      out += c;
      i += 1;
      while (i < n) {
        if (sql[i] === "\\" && i + 1 < n) { i += 2; continue; } // MySQL backslash escape
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; } // '' escape
        if (sql[i] === "'") { i += 1; break; }
        i += 1;
      }
      out += "'x'"; // collapse literal so its bytes never reach token checks
      continue;
    }
    // double-quoted / backtick identifier
    if (c === '"' || c === "`") {
      const q = c;
      i += 1;
      while (i < n) {
        if (sql[i] === q && sql[i + 1] === q) { i += 2; continue; }
        if (sql[i] === q) { i += 1; break; }
        i += 1;
      }
      out += " _id_ ";
      continue;
    }
    if (c === ";") {
      push();
      i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  push();
  return { statements };
}

/** True iff `sql` is a single, read-only statement safe to execute. */
export function guardSelectOnly(sql: string): GuardResult {
  if (typeof sql !== "string" || !sql.trim()) return { ok: false, reason: "empty statement" };
  if (sql.includes("\0")) return { ok: false, reason: "null byte in statement" };

  const { statements, unsupported } = scrub(sql);
  if (unsupported) return { ok: false, reason: `unsupported construct (${unsupported})` };
  if (statements.length === 0) return { ok: false, reason: "no statement after stripping comments" };
  if (statements.length > 1) return { ok: false, reason: "multiple statements are not allowed (one read-only statement only)" };

  let s = statements[0];
  // strip leading opening parens: ((SELECT 1)) is a valid read.
  const lead = s.replace(/^[(\s]+/, "").match(/^([A-Za-z_]+)/);
  if (!lead) return { ok: false, reason: "could not determine statement type" };
  const kw = lead[1].toUpperCase();
  if (!ALLOWED_LEAD.has(kw)) return { ok: false, reason: `only read-only SELECT/WITH/VALUES/TABLE statements are allowed (got ${kw})` };

  if (FORBIDDEN_TOKENS.test(s)) {
    const bad = FORBIDDEN_TOKENS.exec(s)?.[1]?.toUpperCase();
    return { ok: false, reason: `statement contains a disallowed keyword (${bad}) — data-modifying CTEs and SELECT…INTO are rejected` };
  }
  return { ok: true };
}
