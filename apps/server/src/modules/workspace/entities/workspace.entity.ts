import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export enum WorkspaceStatus {
  CREATING = 'creating', // 创建中（预览环境正在初始化）
  ACTIVE = 'active', // 活跃使用中
  RUNNING = 'running', // 运行中(预览环境已启动)
  IDLE = 'idle', // 30分钟无操作
  SUSPENDED = 'suspended', // 2小时无操作 (容器停止)
  ARCHIVED = 'archived', // 3天无操作 (文件删除)
  ERROR = 'error', // 错误状态
}

@Entity('workspaces')
export class Workspace {
  @PrimaryGeneratedColumn({ type: 'int', comment: '自增主键' })
  id: number;

  @Column({ type: 'varchar', length: 255, name: 'workspace_id', unique: true })
  @Index('idx_workspace_id')
  workspaceId: string;

  @Column({ type: 'varchar', length: 255, name: 'user_id' })
  @Index('idx_user_id')
  userId: string;

  @Column({ type: 'varchar', length: 255, name: 'project_id' })
  @Index('idx_project_id')
  projectId: string;

  @Column({ type: 'varchar', length: 255 })
  branch: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  requirement?: string;

  @Column({ type: 'varchar', length: 64, name: 'task_id', nullable: true })
  taskId?: string;

  @Column({
    type: 'enum',
    enum: WorkspaceStatus,
    default: WorkspaceStatus.ACTIVE,
  })
  status: WorkspaceStatus;

  @CreateDateColumn({ name: 'ctime' })
  createdAt: Date;

  @Column({ type: 'timestamp', name: 'last_access_at' })
  lastAccessAt: Date;

  @Column({
    type: 'timestamp',
    name: 'preview_activated_at',
    nullable: true,
    comment: '预览环境最后的激活时间（逻辑上的容器激活时间，类似心跳时间，用于自动清理）',
  })
  @Index('idx_preview_activated_at')
  previewActivatedAt: Date | null;

  @UpdateDateColumn({ name: 'mtime' })
  @Index('idx_mtime')
  updatedAt: Date;

  @Column({ type: 'boolean', name: 'is_deleted', default: false })
  @Index('idx_is_deleted')
  isDeleted: boolean;
}
