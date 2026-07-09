-- Enable trigram search used by the raw dedup queries.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- AlterEnum: extend the Role enum (Prisma emits ALTER TYPE ... ADD VALUE).
ALTER TYPE "Role" ADD VALUE 'GUEST';
