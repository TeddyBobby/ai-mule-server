import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import configuration from './config/configuration';
import workspaceConfig from './config/workspace.config';
import containerConfig from './config/container.config';

// Core Modules
import { LoggerModule } from './modules/logger/logger.module';
import { DatabaseModule } from './modules/database/database.module';
import { RedisModule } from './modules/redis/redis.module';
import { TaskProgressModule } from './modules/task-progress/task-progress.module';

// Feature Modules
import { AuthModule } from './modules/auth/auth.module';
import { HealthModule } from './modules/health/health.module';
import { FileModule } from './modules/file/file.module';
import { WebSocketModule } from './modules/websocket/websocket.module';

// Business Modules
import { UserModule } from './modules/user/user.module';
import { ProjectModule } from './modules/project/project.module';
import { WorkspaceModule } from './modules/workspace/workspace.module';
import { ContainerModule } from './modules/container/container.module';
import { ServerManagerModule } from './modules/server-manager/server-manager.module';
import { PreviewEnvironmentModule } from './modules/preview-environment/preview-environment.module';
import { IdentityModule } from './modules/identity/identity.module';
import { AgentModule } from './modules/agent/agent.module';

// Common
import { CommonModule } from './common/common.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';

import { AppController } from './app.controller';
import { AppService } from './app.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration, workspaceConfig, containerConfig],
      envFilePath: ['../../.env', '.env'],
    }),
    CommonModule,
    LoggerModule,
    DatabaseModule,
    RedisModule,
    TaskProgressModule,
    AuthModule,
    HealthModule,
    FileModule,
    WebSocketModule,
    UserModule,
    IdentityModule,
    ProjectModule,
    WorkspaceModule,
    ContainerModule,
    ServerManagerModule,
    PreviewEnvironmentModule,
    AgentModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
    { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
  ],
})
export class AppModule {}
