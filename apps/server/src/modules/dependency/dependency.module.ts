import { Module } from '@nestjs/common';
import { DependencyService } from './dependency.service';

/**
 * 依赖管理模块
 *
 * 职责:
 * - 提供包管理器检测服务
 * - 提供依赖安装服务
 * - 支持 npm/pnpm/yarn
 */
@Module({
  providers: [DependencyService],
  exports: [DependencyService],
})
export class DependencyModule {}
