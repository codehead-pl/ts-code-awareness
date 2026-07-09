import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { InMemoryUserRepository } from '@fixture/worker';
import { PrismaService } from '../prisma/prisma.service';
import { RolesGuard } from '../common/guards/roles.guard';
import { UsersController } from './users.controller';
import { UsersService, USER_REPOSITORY } from './users.service';

@Module({
  controllers: [UsersController],
  providers: [
    UsersService,
    PrismaService,
    // DI-global guard (useClass).
    { provide: APP_GUARD, useClass: RolesGuard },
    // Cross-package Repository implementer bound to a token (useClass).
    { provide: USER_REPOSITORY, useClass: InMemoryUserRepository },
    // useValue example for the analysis engine.
    { provide: 'USERS_PAGE_SIZE', useValue: 25 },
    // useFactory example (dynamic provider).
    {
      provide: 'USERS_FEATURE_FLAGS',
      useFactory: () => ({ softDelete: process.env.SOFT_DELETE === 'true' }),
    },
  ],
})
export class UsersModule {}
