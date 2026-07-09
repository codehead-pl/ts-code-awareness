import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@fixture/core';

/**
 * DI-global guard registered via `{ provide: APP_GUARD, useClass: RolesGuard }`
 * in UsersModule. Reads required roles off route metadata.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.get<Role[]>('roles', context.getHandler());
    if (!required || required.length === 0) {
      return true;
    }
    const request = context.switchToHttp().getRequest();
    const role = request.user?.role as Role | undefined;
    return role !== undefined && required.includes(role);
  }
}
