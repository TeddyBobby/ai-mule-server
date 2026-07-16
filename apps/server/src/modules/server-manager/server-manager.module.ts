import { Module } from '@nestjs/common';
import { ServerManagerService } from './server-manager.service';
import { NginxConfigService } from './services/nginx-config.service';
import { DevServerManagerService } from './services/dev-server-manager.service';
import { ContainerModule } from '../container/container.module';

/**
 * 服务器管理模块
 *
 * 职责:
 * - 管理开发服务器的生命周期
 * - 管理 Nginx 反向代理配置
 * - 提供统一的服务器启动/停止接口
 */
@Module({
  imports: [ContainerModule],
  providers: [ServerManagerService, NginxConfigService, DevServerManagerService],
  exports: [ServerManagerService, NginxConfigService, DevServerManagerService],
})
export class ServerManagerModule {}
