# prisma-split fixture

A pnpm-workspace monorepo exercising the **split** Prisma layout that
`fixtures/nest-monorepo` does not: the schema and the `@prisma/client`
dependency live in **one** package (`@split/db`), and every client **call site**
lives in a **different** package (`@split/api`) that reaches the client only
transitively through a workspace dependency.

This is the shape that broke the model↔code bridge: the schema-owning package
has zero `prisma.model.op()` / `$queryRaw` call sites, and the package full of
call sites was never scanned. The Prisma adapter now activates on consumer
packages via the dependency closure and attributes each access/raw fragment to
the package whose source it was found in.

Also seeds the regression cases:

- `packages/db/src/index.ts` `formatLocalDateTime` — a `x.toLocaleString("sv-SE", …)`
  decoy that must **not** be captured as a `$executeRaw` write.
- `packages/db/prisma/migrations/20240201000000_add_role_value` — an
  `ALTER TYPE … ADD VALUE` migration whose operation must be classified.
