import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/**
 * 路径前缀来源枚举
 */
export enum PrefixSource {
  PLATFORM_CONFIG = 'platform-config',
  MANUAL = 'manual',
  VITE = 'vite',
  WEBPACK = 'webpack',
  NEXTJS = 'nextjs',
  PACKAGE_JSON = 'package-json',
  ENV = 'env',
  DEFAULT = 'default',
}

/**
 * 包管理器枚举
 */
export enum PackageManager {
  NPM = 'npm',
  PNPM = 'pnpm',
  YARN = 'yarn',
  AUTO = 'auto',
}

/**
 * 内外网枚举
 */
export enum NetworkType {
  INTRANET_ONLY = 'intranet-only',
  EXTRANET_ONLY = 'extranet-only',
  BOTH = 'both',
}

/**
 * 项目实体
 */
@Entity('projects')
export class Project {
  @PrimaryGeneratedColumn({ type: 'int', comment: '自增主键' })
  id: number;

  @Column({ type: 'varchar', length: 255, name: 'project_id', unique: true })
  @Index('idx_project_id')
  projectId: string;

  @Column({ type: 'varchar', length: 255 })
  @Index('idx_name')
  name: string;

  @Column({ type: 'varchar', length: 255, name: 'git_url' })
  @Index('idx_git_url')
  gitUrl: string;

  @Column({
    type: 'varchar',
    length: 255,
    name: 'tree_node',
    comment: '项目节点标识',
  })
  @Index('idx_tree_node')
  treeNode: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  // 路径前缀配置（核心字段）
  @Column({
    type: 'boolean',
    name: 'has_path_prefix',
    default: false,
    comment: '是否有路径前缀',
  })
  @Index('idx_has_path_prefix')
  hasPathPrefix: boolean;

  @Column({
    type: 'varchar',
    length: 255,
    name: 'path_prefix',
    nullable: true,
    comment: '路径前缀（如 /brand）',
  })
  pathPrefix?: string;

  @Column({
    type: 'enum',
    enum: PrefixSource,
    name: 'prefix_source',
    default: PrefixSource.DEFAULT,
    comment: '前缀来源',
  })
  prefixSource: PrefixSource;

  @Column({
    type: 'varchar',
    length: 255,
    name: 'detected_prefix',
    nullable: true,
    comment: '自动检测到的前缀（保留用于对比）',
  })
  detectedPrefix?: string;

  // 开发服务器配置
  @Column({
    type: 'varchar',
    length: 255,
    name: 'dev_command',
    default: 'npm run dev',
    comment: '开发服务器启动命令',
  })
  devCommand: string;

  @Column({
    type: 'varchar',
    length: 32,
    name: 'node_version',
    nullable: true,
    comment: 'Node 版本（如 20 或 20.11.1）',
  })
  nodeVersion?: string;

  @Column({
    type: 'int',
    name: 'dev_port_default',
    nullable: true,
    comment: '默认开发端口',
  })
  devPortDefault?: number;

  // 构建配置
  @Column({
    type: 'varchar',
    length: 255,
    name: 'build_command',
    nullable: true,
    comment: '构建命令',
  })
  buildCommand?: string;

  @Column({
    type: 'varchar',
    length: 255,
    name: 'build_output',
    nullable: true,
    comment: '构建输出目录',
  })
  buildOutput?: string;

  // 包管理器
  @Column({
    type: 'varchar',
    length: 255,
    name: 'package_manager',
    default: 'auto',
    comment: '包管理器',
  })
  packageManager: string;

  // 内外网配置
  @Column({
    type: 'enum',
    enum: NetworkType,
    default: NetworkType.INTRANET_ONLY,
    comment: '内外网类型：仅内网、仅外网、内外网',
  })
  network: NetworkType;

  // 时间字段（符合公司规范）
  @CreateDateColumn({ name: 'ctime' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'mtime' })
  @Index('idx_mtime')
  updatedAt: Date;

  // 软删除标记
  @Column({ type: 'boolean', name: 'is_deleted', default: false })
  @Index('idx_is_deleted')
  isDeleted: boolean;
}
