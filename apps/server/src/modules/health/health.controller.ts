import { Controller, Get } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  // TypeOrmHealthIndicator,
  MemoryHealthIndicator,
  DiskHealthIndicator,
} from '@nestjs/terminus';
import { Public } from '../../common/decorators/public.decorator';
import { SkipTransform } from '../../common/decorators/skip-transform.decorator';
import { ApiTags, ApiOperation } from '@nestjs/swagger';

@ApiTags('健康检查')
@Controller('health')
export class HealthController {
  constructor(
    private health: HealthCheckService,
    // private db: TypeOrmHealthIndicator,
    private memory: MemoryHealthIndicator,
    private disk: DiskHealthIndicator,
  ) {}

  @Get()
  @Public()
  @HealthCheck()
  @ApiOperation({ summary: '完整健康检查' })
  check() {
    return this.health.check([
      // 数据库健康检查
      // () => this.db.pingCheck('database'),
      // 内存健康检查（堆内存不超过 300MB）
      () => this.memory.checkHeap('memory_heap', 300 * 1024 * 1024),
      // RSS 内存检查（不超过 300MB）
      () => this.memory.checkRSS('memory_rss', 300 * 1024 * 1024),
      // 磁盘健康检查（磁盘使用率不超过 80%）
      () =>
        this.disk.checkStorage('disk', {
          path: '/',
          thresholdPercent: 0.8,
        }),
    ]);
  }

  @Get('ping')
  @Public()
  @SkipTransform()
  @ApiOperation({ summary: '简单心跳检查' })
  ping() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }
}
