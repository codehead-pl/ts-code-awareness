import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

/** Global guard registered in bootstrap via `app.useGlobalGuards(new SomeGuard())`. */
@Injectable()
export class SomeGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    return true;
  }
}
