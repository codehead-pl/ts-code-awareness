import { PrismaService } from "@split/db";

/** A consumer package with all the call sites: it declares no `@prisma/client`
 *  and owns no schema — it reaches the client only through `@split/db`. */
export class OffersService {
  constructor(private readonly prisma: PrismaService) {}

  async find(email: string, tag: string) {
    // `tag` is intentionally not (yet) a User field — argFields intersects with
    // the real schema, so it is excluded until the schema adds it. The
    // incremental battery adds it and asserts the fragment picks it up.
    return this.prisma.user.findMany({ where: { email, tag } });
  }

  async create(title: string, authorId: number) {
    return this.prisma.post.create({ data: { title, authorId } });
  }

  async similar(title: string) {
    return this.prisma
      .$queryRaw`SELECT id FROM "Post" WHERE similarity(title, ${title}) > 0.3`;
  }
}
