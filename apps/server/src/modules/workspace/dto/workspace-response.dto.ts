import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { WorkspaceStatus } from '../entities/workspace.entity';

export class WorkspaceMetadataDto {
  @ApiProperty({ description: '工作空间ID' })
  workspaceId: string;

  @ApiProperty({ description: '用户ID' })
  userId: string;

  @ApiProperty({ description: '项目ID' })
  projectId: string;

  @ApiProperty({ description: '分支名称' })
  branch: string;

  @ApiPropertyOptional({ description: '需求ID' })
  requirement?: string;

  @ApiProperty({ description: '创建时间' })
  createdAt: string;

  @ApiProperty({ description: '最后访问时间' })
  lastAccessAt: string;

  @ApiProperty({ enum: WorkspaceStatus, description: '工作空间状态' })
  status: WorkspaceStatus;

  @ApiPropertyOptional({ description: '异步任务 ID（创建中状态时使用）' })
  taskId?: string;

  @ApiPropertyOptional({ description: '容器信息' })
  container?: {
    id: string;
    imageId: string;
    ports: Record<string, number>;
  };

  @ApiPropertyOptional({ description: '开发服务器信息' })
  devServer?: {
    pid: number;
    port: number;
    status: string;
  };
}

export class WorkspaceResponseDto {
  @ApiProperty({ description: '工作空间ID' })
  workspaceId: string;

  @ApiProperty({ description: '工作空间元数据' })
  metadata: WorkspaceMetadataDto;

  @ApiProperty({ description: '代码目录路径' })
  codeDir: string;
}
