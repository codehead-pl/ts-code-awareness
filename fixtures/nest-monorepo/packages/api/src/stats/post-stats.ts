import { PrismaClient } from '@prisma/client';

/**
 * Standalone stats helpers that use a *local const* Prisma client — a
 * bare-identifier receiver (`db.post...`) rather than the Nest-injected
 * `this.prisma`. Exercises W7: because `db`'s initializer `new PrismaClient()`
 * provably reaches `PrismaClient`, the `prisma:access` below must resolve to
 * `typed` confidence, not `heuristic`.
 */
export async function listPostTitles(): Promise<string[]> {
  const db = new PrismaClient();
  // prisma:access read (bare-identifier local const client → typed)
  const posts = await db.post.findMany({ orderBy: { title: 'asc' } });
  return posts.map((p) => p.title);
}
