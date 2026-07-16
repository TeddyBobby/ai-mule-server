import {
  Injectable,
  CanActivate,
  ExecutionContext,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

export interface User {
  id: string;
  username: string;
  nickname: string;
  avatar: string;
}

/**
 * 认证守卫
 * 当前默认直接放行，并注入本地开发用户
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);

  constructor(private reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();

    // 检查是否有 @Public() 装饰器，如果有则跳过认证
    const isPublic = this.reflector.getAllAndOverride<boolean>('isPublic', [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    request.user = {
      id: process.env.LOCAL_DEV_USER_ID || 'local-dev',
      username: process.env.LOCAL_DEV_USERNAME || 'local-dev',
      nickname: process.env.LOCAL_DEV_NICKNAME || '本地开发者',
      avatar: '',
    } as User;

    this.logger.debug('Authentication bypassed, using local dev user');
    return true;
  }
}
