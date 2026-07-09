import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { BaseService, Repository, User } from '@fixture/core';
import { PrismaService } from '../prisma/prisma.service';
import { CreateUserDto } from './dto/create-user.dto';

/** DI token for the injected cross-package repository. */
export const USER_REPOSITORY = 'USER_REPOSITORY';

/**
 * Business service. Extends the abstract `BaseService` from `@fixture/core`
 * (override + contract edges) and constructor-injects both a `PrismaService`
 * and a `@fixture/core` `Repository<User>` (DI + cross-package).
 */
@Injectable()
export class UsersService extends BaseService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(USER_REPOSITORY)
    private readonly repository: Repository<User>,
  ) {
    super();
  }

  protected resourceName(): string {
    return 'user';
  }

  async count(): Promise<number> {
    // prisma:access read
    return this.prisma.user.count();
  }

  async findAll(): Promise<User[]> {
    // prisma:access read
    return this.prisma.user.findMany({ orderBy: { email: 'asc' } });
  }

  async findOne(id: string): Promise<User> {
    // prisma:access read
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) {
      throw new NotFoundException(`User ${id} not found`);
    }
    return user;
  }

  async create(dto: CreateUserDto): Promise<User> {
    // prisma:access write
    const created = await this.prisma.user.create({
      data: { email: dto.email, name: dto.name, role: dto.role },
    });
    // Also mirror into the injected in-memory repository.
    await this.repository.save(created);
    return created;
  }

  async searchByEmailDomain(domain: string): Promise<User[]> {
    // prisma:access raw
    return this.prisma.$queryRaw<User[]>`
      SELECT * FROM "users" WHERE email LIKE ${'%@' + domain}
    `;
  }
}
