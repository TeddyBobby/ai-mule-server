import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * 业务异常类
 * 用于抛出业务逻辑异常
 *
 * @example
 * throw new BusinessException(1001, '用户不存在');
 * throw new BusinessException(2001, '余额不足');
 */
export class BusinessException extends HttpException {
  public readonly businessStatus: number;
  public readonly businessMessage: string;

  constructor(status: number, message: string) {
    super(
      {
        status,
        message,
      },
      HttpStatus.OK, // HTTP 状态码始终返回 200
    );
    this.businessStatus = status;
    this.businessMessage = message;
  }
}
