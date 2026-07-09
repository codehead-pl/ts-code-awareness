// Minimal, tolerant schema.prisma parser.
// We parse the source directly — the generated client is never read (huge, may
// be absent/stale, lives outside source roots). Line-based and
// forgiving: unknown blocks/attributes are skipped rather than erroring.

const SCALARS = new Set(["String", "Boolean", "Int", "BigInt", "Float", "Decimal", "DateTime", "Json", "Bytes"]);

export interface PrismaField {
  name: string;
  type: string; // base type (scalar / model / enum name), list/optional stripped
  isList: boolean;
  optional: boolean;
  isId: boolean;
  isUnique: boolean;
  default: string | null; // rendered @default(...) inner text
  dbType: string | null; // @db.X native type
  column: string | null; // @map("col")
  relationFromFields: string[] | null; // @relation(fields: [...])
  line: number;
}

export interface PrismaRelation {
  name: string; // relation field name
  target: string; // target model
  kind: "one-to-many" | "many-to-one" | "one-to-one";
  fk: string | null; // owning FK field, when this side holds it
}

export interface PrismaModel {
  name: string;
  table: string; // @@map(...) or the model name (Prisma default)
  fields: PrismaField[];
  relations: PrismaRelation[];
  indexes: string[][]; // @@index([...])
  uniques: string[][]; // @@unique([...]) + field-level @unique (single-col)
  idFields: string[]; // @id fields (or @@id([...]))
  line: number;
}

export interface PrismaEnum {
  name: string;
  members: string[];
  line: number;
}

export interface ParsedSchema {
  models: PrismaModel[];
  enums: PrismaEnum[];
}

interface Block {
  keyword: string;
  name: string;
  body: Array<{ text: string; line: number }>;
  line: number;
}

function stripComment(line: string): string {
  const i = line.indexOf("//");
  return i >= 0 ? line.slice(0, i) : line;
}

function splitBlocks(text: string): Block[] {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  let cur: Block | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const raw = stripComment(lines[i]).trimEnd();
    const trimmed = raw.trim();
    if (!cur) {
      const m = trimmed.match(/^(model|enum|datasource|generator|type)\s+([A-Za-z_]\w*)\s*\{/);
      if (m) cur = { keyword: m[1], name: m[2], body: [], line: i + 1 };
    } else if (trimmed === "}") {
      blocks.push(cur);
      cur = null;
    } else if (trimmed) {
      cur.body.push({ text: trimmed, line: i + 1 });
    }
  }
  if (cur) blocks.push(cur);
  return blocks;
}

export function parseSchema(text: string): ParsedSchema {
  const blocks = splitBlocks(text);
  const modelNames = new Set(blocks.filter((b) => b.keyword === "model").map((b) => b.name));
  const models: PrismaModel[] = [];
  const enums: PrismaEnum[] = [];

  for (const b of blocks) {
    if (b.keyword === "enum") {
      enums.push({ name: b.name, members: b.body.map((l) => l.text.split(/\s+/)[0]).filter(Boolean), line: b.line });
    } else if (b.keyword === "model") {
      models.push(parseModel(b, modelNames));
    }
  }
  return { models, enums };
}

function parseModel(b: Block, modelNames: Set<string>): PrismaModel {
  const fields: PrismaField[] = [];
  const relations: PrismaRelation[] = [];
  const indexes: string[][] = [];
  const uniques: string[][] = [];
  const idFields: string[] = [];
  let table = b.name;

  for (const { text, line } of b.body) {
    if (text.startsWith("@@")) {
      const map = text.match(/@@map\("([^"]+)"\)/);
      if (map) table = map[1];
      const idx = text.match(/@@index\(\s*\[([^\]]*)\]/);
      if (idx) indexes.push(idList(idx[1]));
      const uniq = text.match(/@@unique\(\s*\[([^\]]*)\]/);
      if (uniq) uniques.push(idList(uniq[1]));
      const id = text.match(/@@id\(\s*\[([^\]]*)\]/);
      if (id) idFields.push(...idList(id[1]));
      continue;
    }
    const parts = text.split(/\s+/);
    if (parts.length < 2) continue;
    const name = parts[0];
    const rawType = parts[1];
    if (!/^[A-Za-z_]/.test(name)) continue;
    const attrs = text.slice(text.indexOf(rawType) + rawType.length);
    const isList = rawType.includes("[]");
    const optional = rawType.includes("?");
    const base = rawType.replace(/[\[\]?]/g, "");
    const isId = /@id\b/.test(attrs);
    const isUnique = /@unique\b/.test(attrs);
    if (isId) idFields.push(name);
    if (isUnique) uniques.push([name]);
    const def = attrs.match(/@default\(([^)]*)\)/);
    const dbType = attrs.match(/@db\.(\w+)/);
    const column = attrs.match(/@map\("([^"]+)"\)/);
    const relFields = attrs.match(/@relation\([^)]*fields:\s*\[([^\]]*)\]/);

    const field: PrismaField = {
      name,
      type: base,
      isList,
      optional,
      isId,
      isUnique,
      default: def ? def[1].trim() : null,
      dbType: dbType ? dbType[1] : null,
      column: column ? column[1] : null,
      relationFromFields: relFields ? idList(relFields[1]) : null,
      line,
    };
    fields.push(field);

    if (modelNames.has(base)) {
      const kind: PrismaRelation["kind"] = isList ? "one-to-many" : field.relationFromFields ? "many-to-one" : "one-to-one";
      relations.push({ name, target: base, kind, fk: field.relationFromFields?.[0] ?? null });
    }
  }

  return { name: b.name, table, fields, relations, indexes, uniques, idFields, line: b.line };
}

function idList(inner: string): string[] {
  return inner.split(",").map((s) => s.trim()).filter(Boolean);
}

export function isScalar(type: string): boolean {
  return SCALARS.has(type);
}
