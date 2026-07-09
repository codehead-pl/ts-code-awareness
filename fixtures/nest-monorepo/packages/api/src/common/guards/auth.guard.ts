import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';

/**
 * Route/controller-level guard applied via `@UseGuards(AuthGuard)`.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const header = request.headers?.authorization as string | undefined;
    if (!header) {
      throw new UnauthorizedException('Missing authorization header');
    }
    return header.startsWith('Bearer ');
  }
}
