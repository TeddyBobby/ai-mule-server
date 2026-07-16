import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Inject,
} from '@nestjs/common';
import { Response } from 'express';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';
import { BusinessException } from '../exceptions/business.exception';

/**
 * 全局异常过滤器
 * 统一处理所有异常并返回标准格式
 * 异常响应: { status: 非0, message: '错误信息' }
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  constructor(
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest();

    let errorResponse: { status: number; message: string };

    // 处理业务异常
    if (exception instanceof BusinessException) {
      const exceptionResponse = exception.getResponse() as any;
      errorResponse = {
        status: exceptionResponse.status,
        message: exceptionResponse.message,
      };

      // 记录业务异常日志（info 级别）
      this.logger.info(`Business Exception: ${JSON.stringify(errorResponse)}`, {
        context: 'ExceptionFilter',
        path: request.url,
        method: request.method,
      });
    }
    // 处理 HTTP 异常
    else if (exception instanceof HttpException) {
      const httpStatus = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      // 提取错误消息
      let message: string;
      if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
      } else if (typeof exceptionResponse === 'object' && exceptionResponse !== null) {
        const errorObj = exceptionResponse as any;
        if (Array.isArray(errorObj.message)) {
          message = errorObj.message.join('; ');
        } else {
          message = errorObj.message || 'Unknown error';
        }
      } else {
        message = 'Unknown error';
      }

      // 业务状态码映射（HTTP状态码转业务状态码）
      const statusCodeMap: Record<number, number> = {
        400: 400, // Bad Request
        401: 401, // Unauthorized
        403: 403, // Forbidden
        404: 404, // Not Found
        409: 409, // Conflict
        422: 422, // Unprocessable Entity
        500: 500, // Internal Server Error
      };

      errorResponse = {
        status: statusCodeMap[httpStatus] || httpStatus,
        message,
      };

      // 记录 HTTP 异常日志
      this.logger.warn(`HTTP Exception: ${JSON.stringify(errorResponse)}`, {
        context: 'ExceptionFilter',
        path: request.url,
        method: request.method,
        httpStatus,
      });
    }
    // 处理未知异常
    else {
      errorResponse = {
        status: 500,
        message: exception instanceof Error ? exception.message : 'Internal server error',
      };

      // 记录未知异常日志（error 级别）
      this.logger.error(`Unknown Exception: ${JSON.stringify(errorResponse)}`, {
        context: 'ExceptionFilter',
        path: request.url,
        method: request.method,
        stack: exception instanceof Error ? exception.stack : undefined,
      });
    }

    // 始终返回 HTTP 200，业务状态码在 response body 中
    response.status(HttpStatus.OK).json(errorResponse);
  }
}
