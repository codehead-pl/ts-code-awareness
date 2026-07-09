import { NestFactory } from '@nestjs/core';
import { ValidationPipe, CanActivate } from '@nestjs/common';
import { AppModule } from './app.module';
import { SomeGuard } from './common/guards/some.guard';

/**
 * Factory that builds a guard at runtime. Because the guard instance is
 * produced dynamically (behind a function), the engine cannot statically
 * resolve which class is registered here -> should be flagged `unresolved`.
 */
function buildDynamicGuard(): CanActivate {
  const registry: Record<string, () => CanActivate> = {
    some: () => new SomeGuard(),
  };
  const selected = process.env.GLOBAL_GUARD ?? 'some';
  return registry[selected]();
}

/**
 * Registers the bootstrap-level global guards/pipes. Extracted from
 * `bootstrap()` so the runtime pipeline oracle
 * (packages/adapter-nest/test/nest-runtime.e2e.ts) can replay the *exact*
 * registrations against a recorder and derive the real effective chain —
 * including that the "dynamic" guard resolves to a concrete instance at
 * runtime, which static analysis honestly reports as `unresolved`.
 */
export function registerGlobals(app: {
  useGlobalGuards: (...guards: CanActivate[]) => unknown;
  useGlobalPipes: (...pipes: unknown[]) => unknown;
}): void {
  // Resolved bootstrap globals:
  app.useGlobalGuards(new SomeGuard());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  // Unresolved bootstrap global: instance comes from a factory, not a literal `new X()`.
  const dynamicGuard = buildDynamicGuard();
  app.useGlobalGuards(dynamicGuard);
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  registerGlobals(app);
  await app.listen(3000);
}

// Only self-boot when executed as the entrypoint (`node main.js`). Importing
// this module (e.g. from the runtime pipeline test) must not start a server.
declare const require: { main?: unknown } | undefined;
declare const module: unknown;
if (typeof require !== 'undefined' && require.main === module) {
  void bootstrap();
}
