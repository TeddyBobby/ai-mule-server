import { SetMetadata } from '@nestjs/common';

/**
 * 公开接口装饰器
 * 标记不需要认证的接口
 */
export const Public = () => SetMetadata('isPublic', true);
