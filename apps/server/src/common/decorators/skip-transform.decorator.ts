import { SetMetadata } from '@nestjs/common';

/**
 * 跳过响应转换装饰器
 * 用于标记不需要统一响应格式包装的接口
 *
 * @example
 * @SkipTransform()
 * @Get('ping')
 * ping() {
 *   return { status: 'ok' };
 * }
 */
export const SKIP_TRANSFORM_KEY = 'skipTransform';
export const SkipTransform = () => SetMetadata(SKIP_TRANSFORM_KEY, true);
