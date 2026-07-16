import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { SKIP_TRANSFORM_KEY } from '../decorators/skip-transform.decorator';

/**
 * 统一响应格式接口
 */
export interface Response<T> {
  status: number;
  message: string;
  data: T;
}

/**
 * 响应转换拦截器
 * 将所有成功响应转换为统一格式
 * 成功响应: { status: 0, message: 'ok', data: ... }
 * 使用 @SkipTransform() 装饰器可以跳过转换
 */
@Injectable()
export class TransformInterceptor<T> implements NestInterceptor<T, any> {
  constructor(private reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    // 检查是否跳过转换
    const skipTransform = this.reflector.getAllAndOverride<boolean>(
      SKIP_TRANSFORM_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (skipTransform) {
      // 跳过转换，直接返回原始数据
      return next.handle();
    }

    // 应用统一响应格式
    return next.handle().pipe(
      map((data) => ({
        status: 0,
        message: 'ok',
        data,
      })),
    );
  }
}
