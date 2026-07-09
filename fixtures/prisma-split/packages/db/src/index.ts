import { PrismaClient } from "@prisma/client";

const APP_TIMEZONE = "Europe/Warsaw";

/** The client the consumer packages inject. Its heritage reaches PrismaClient,
 *  so receivers typed as `PrismaService` in *other* packages must be recognized
 *  as `typed` — the closure-wide client-heritage fixpoint. */
export class PrismaService extends PrismaClient {}

/** Decoy: a `.foo("bar")` call that is NOT a Prisma raw query. It must never be
 *  captured as an `$executeRaw`, even though the first argument is a string
 *  literal ("sv-SE"). */
export function formatLocalDateTime(d: Date): string {
  return d
    .toLocaleString("sv-SE", { timeZone: APP_TIMEZONE, hour12: false })
    .slice(0, 16);
}
