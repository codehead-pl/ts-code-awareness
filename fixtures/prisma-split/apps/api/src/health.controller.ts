import { PrismaService } from "@split/db";

export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  async check() {
    await this.prisma.$queryRaw`SELECT 1`;
    return { ok: true };
  }
}
