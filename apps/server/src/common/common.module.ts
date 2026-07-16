import { Module, Global } from '@nestjs/common';
import { PathResolverService } from './services/path-resolver.service';
import { NetworkUtilsService } from './utils/network-utils.service';

/**
 * 通用模块
 *
 * 提供全局共享的服务，如路径解析、网络工具等
 */
@Global()
@Module({
  providers: [PathResolverService, NetworkUtilsService],
  exports: [PathResolverService, NetworkUtilsService],
})
export class CommonModule {}