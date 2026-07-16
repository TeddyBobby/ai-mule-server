import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Inject,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';

/**
 * 日志拦截器
 * 记录所有请求和响应
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  constructor(
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const { method, url, ip } = request;
    const userAgent = request.get('user-agent') || '';
    const now = Date.now();

    this.logger.info(`Incoming Request: ${method} ${url}`, {
      context: 'HTTP',
      ip,
      userAgent,
    });

    return next.handle().pipe(
      tap({
        next: (data) => {
          const response = context.switchToHttp().getResponse();
          const { statusCode } = response;
          const delay = Date.now() - now;

          this.logger.info(
            `Outgoing Response: ${method} ${url} ${statusCode} - ${delay}ms`,
            {
              context: 'HTTP',
              statusCode,
              delay: `${delay}ms`,
            },
          );
        },
        error: (error) => {
          const delay = Date.now() - now;
          this.logger.error(
            `Request Error: ${method} ${url} - ${delay}ms`,
            {
              context: 'HTTP',
              error: error.message,
              stack: error.stack,
              delay: `${delay}ms`,
            },
          );
        },
      }),
    );
  }
}
