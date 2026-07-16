import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { WorkspaceService } from './workspace.service';
import { WorkspaceController } from './workspace.controller';
import { Workspace } from './entities/workspace.entity';
import { PreviewEnvironmentModule } from '../preview-environment/preview-environment.module';
import { FileModule } from '../file/file.module';
import { WebSocketModule } from '../websocket/websocket.module';
import { ProjectModule } from '../project/project.module';
import { FileWatcherService } from './services/file-watcher.service';
import { GitModule } from '../git/git.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Workspace]),
    ConfigModule,
    forwardRef(() => PreviewEnvironmentModule),
    FileModule,
    WebSocketModule,
    ProjectModule,
    GitModule,
  ],
  controllers: [WorkspaceController],
  providers: [WorkspaceService, FileWatcherService],
  exports: [WorkspaceService, FileWatcherService],
})
export class WorkspaceModule {}
