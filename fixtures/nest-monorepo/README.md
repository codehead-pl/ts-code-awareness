# nest-monorepo (golden test fixture)

A small but structurally rich **nx / pnpm-workspace** monorepo containing a
**NestJS + Prisma** app plus two shared library packages. It is **test data**
for the static-analysis engine: every file is meant to be *parsed*, never
*executed*.

> **Do not `pnpm install` here.** There is intentionally no `node_modules`.
> External imports (`@nestjs/*`, `@prisma/client`, `class-validator`) are
> expected to be unresolved — that is fine and by design. Cross-package
> imports (`@fixture/core`, `@fixture/worker`) resolve via the tsconfig path
> aliases in `tsconfig.base.json`.

## Layout

```
nest-monorepo/
├── pnpm-workspace.yaml            # packages: ['packages/*']
├── nx.json                        # nx target defaults / named inputs
├── package.json                   # private root, workspace scripts
├── tsconfig.base.json             # path aliases @fixture/core, @fixture/worker
├── README.md
└── packages/
    ├── core/                      # @fixture/core — shared library
    │   ├── package.json
    │   ├── tsconfig.json
    │   └── src/
    │       ├── index.ts           # barrel re-exports
    │       ├── repository.ts       # Repository<T>, ListableRepository<T>
    │       ├── base-service.ts     # abstract BaseService (+ concrete describe())
    │       └── types.ts            # Id, IsoDateString, Role enum, Entity, User
    ├── worker/                    # @fixture/worker — depends on core
    │   ├── package.json           # @fixture/core: workspace:*
    │   ├── tsconfig.json
    │   └── src/
    │       ├── index.ts
    │       ├── in-memory-user-repository.ts  # implements Repository<User> (cross-pkg)
    │       └── worker-service.ts             # extends BaseService (cross-pkg)
    └── api/                       # @fixture/api — NestJS app
        ├── package.json           # nest, prisma, class-validator, core, worker
        ├── tsconfig.json          # experimentalDecorators + emitDecoratorMetadata
        ├── prisma/
        │   ├── schema.prisma      # datasource, generator, User/Post, Role, @@map
        │   └── migrations/
        │       ├── migration_lock.toml
        │       └── 20240101000000_init/migration.sql
        └── src/
            ├── main.ts            # NestFactory + bootstrap globals (resolved + unresolved)
            ├── app.module.ts      # @Module importing UsersModule
            ├── prisma/
            │   └── prisma.service.ts     # PrismaService extends PrismaClient
            ├── common/guards/
            │   ├── some.guard.ts         # global guard (bootstrap)
            │   ├── auth.guard.ts         # @UseGuards route/controller guard
            │   └── roles.guard.ts        # APP_GUARD (DI-global)
            └── users/
                ├── users.module.ts       # controller + providers + APP_GUARD + DI variants
                ├── users.controller.ts   # @Controller('users') + routes + guards
                ├── users.service.ts      # @Injectable, Prisma access, DI, extends BaseService
                └── dto/create-user.dto.ts # class-validator DTO
```

## Feature-coverage table

Use this to know what each future analysis phase should assert against.

| Feature | Where in the fixture |
| --- | --- |
| **Workspace discovery (pnpm)** | `pnpm-workspace.yaml` (`packages/*`), root `package.json` (private + workspace scripts) |
| **Workspace discovery (nx)** | `nx.json` (targetDefaults, namedInputs, cacheableOperations) |
| **Path-alias resolution** | `tsconfig.base.json` `paths`: `@fixture/core` → `packages/core/src/index.ts`, `@fixture/worker` → `packages/worker/src/index.ts` |
| **Cross-package imports** | `worker` imports `@fixture/core`; `api` imports both `@fixture/core` and `@fixture/worker` (`users.module.ts`, `users.service.ts`, `create-user.dto.ts`, `roles.guard.ts`) |
| **Generic interface** | `Repository<T>` in `packages/core/src/repository.ts` (`findById`, `save`); extended by `ListableRepository<T>` |
| **Interface implementer (cross-package)** | `InMemoryUserRepository implements Repository<User>` in `packages/worker` — implementer resolves across the package boundary via path alias |
| **Abstract class + overrides** | `BaseService` (abstract `resourceName`, `count`) overridden by `WorkerService` (worker) and `UsersService` (api) |
| **Contract call edges** | `BaseService.describe()` (concrete) calls abstract `resourceName()` + `count()`; `makeKey()` calls `resourceName()` |
| **Nest module graph** | `AppModule` imports `UsersModule` (`app.module.ts`, `users.module.ts`) |
| **Nest routes** | `UsersController` `@Controller('users')`: `@Get()`, `@Get(':id')` + `@Param('id')`, `@Post()` + `@Body() CreateUserDto` |
| **Nest DI — constructor injection** | `UsersService` injects `PrismaService` and `@Inject(USER_REPOSITORY) Repository<User>` |
| **Nest DI — useClass** | `{ provide: APP_GUARD, useClass: RolesGuard }` and `{ provide: USER_REPOSITORY, useClass: InMemoryUserRepository }` (`users.module.ts`) |
| **Nest DI — useValue** | `{ provide: 'USERS_PAGE_SIZE', useValue: 25 }` |
| **Nest DI — useFactory** | `{ provide: 'USERS_FEATURE_FLAGS', useFactory: () => ... }` |
| **Guard/pipe pipeline — L1 bootstrap global (resolved)** | `main.ts`: `app.useGlobalGuards(new SomeGuard())`, `app.useGlobalPipes(new ValidationPipe())` |
| **Guard/pipe pipeline — bootstrap global (unresolved)** | `main.ts`: `app.useGlobalGuards(dynamicGuard)` where `dynamicGuard = buildDynamicGuard()` (factory, not a `new X()` literal) → flag `unresolved` |
| **Guard/pipe pipeline — DI-global** | `RolesGuard` via `APP_GUARD` in `users.module.ts` |
| **Guard/pipe pipeline — controller-level** | `@UseGuards(AuthGuard)` on `UsersController` |
| **Guard/pipe pipeline — method-level** | `@UseGuards(AuthGuard)` on `UsersController.create()` |
| **CanActivate implementers** | `SomeGuard`, `AuthGuard`, `RolesGuard` all `implements CanActivate` |
| **Prisma models + relations** | `schema.prisma`: `User` 1—* `Post` via `@relation(fields:[authorId], references:[id])` |
| **Prisma enum** | `enum Role { ADMIN USER }` in `schema.prisma` (mirrors `Role` in core, though core uses string values) |
| **Prisma @@map** | `User` model mapped to table `users` via `@@map("users")` |
| **Prisma datasource + generator** | `schema.prisma`: `datasource db` (postgresql) + `generator client` |
| **prisma:access — read** | `users.service.ts`: `this.prisma.user.count()`, `findMany(...)`, `findUnique({ where: { id } })` |
| **prisma:access — write** | `users.service.ts`: `this.prisma.user.create({ data })` |
| **prisma:access — raw** | `users.service.ts`: `this.prisma.$queryRaw\`SELECT * FROM "users" ...\`` |
| **PrismaService bridge** | `PrismaService extends PrismaClient` (`prisma.service.ts`) — links `this.prisma.<model>` calls to models |
| **Migrations** | `prisma/migrations/20240101000000_init/migration.sql` (CREATE TYPE/TABLE/INDEX + FK), `migration_lock.toml` |
| **class-validator DTO** | `CreateUserDto` with `@IsEmail`, `@IsOptional`, `@IsString`, `@MinLength`, `@IsEnum(Role)` |

## Notes on intentional edge cases

- The **unresolved global guard** in `main.ts` is deliberate: the guard
  instance is produced by `buildDynamicGuard()` (a factory reading
  `process.env`), so a static pass cannot bind it to a concrete class.
- `Role` exists in **two forms**: a TypeScript enum in `@fixture/core`
  (string-valued `'ADMIN'`/`'USER'`) and a Prisma enum in `schema.prisma`.
  This lets the engine test cross-representation reconciliation.
- `USER_REPOSITORY` uses a **string DI token** with `@Inject`, while
  `PrismaService` uses **class-based** injection — two DI resolution styles.
