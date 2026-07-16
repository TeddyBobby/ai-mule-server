import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * 路径解析服务
 *
 * 用于解析配置中的路径模板，支持占位符替换
 *
 * 支持的占位符：
 * - ${rootDir}: 工作空间根目录
 * - ${projectId}: 项目ID
 * - ${userId}: 用户ID
 * - ${workspaceId}: 工作空间ID
 * - ${containerId}: 容器ID
 */
@Injectable()
export class PathResolverService {
  private readonly rootDir: string;

  constructor(private configService: ConfigService) {
    // 缓存 rootDir，避免重复读取配置
    this.rootDir = this.configService.get<string>('workspace.rootDir', '/data/workspaces');
  }

  /**
   * 解析路径模板
   *
   * @param pathTemplate 路径模板字符串
   * @param variables 变量映射表
   * @returns 解析后的路径
   *
   * @example
   * resolvePath('${rootDir}/users/${userId}', { userId: 'user-123' })
   * // 返回: '/data/workspaces/users/user-123'
   */
  resolvePath(pathTemplate: string, variables: Record<string, string> = {}): string {
    let resolved = pathTemplate;

    // 1. 替换 rootDir
    resolved = resolved.replace(/\$\{rootDir\}/g, this.rootDir);

    // 2. 替换其他变量
    for (const [key, value] of Object.entries(variables)) {
      const regex = new RegExp(`\\$\\{${key}\\}`, 'g');
      resolved = resolved.replace(regex, value);
    }

    return resolved;
  }

  /**
   * 从配置中获取并解析路径
   *
   * @param configKey 配置键名
   * @param defaultValue 默认值
   * @param variables 变量映射表
   * @returns 解析后的路径
   *
   * @example
   * getPath('workspace.paths.systemPorts')
   * // 返回: '/data/workspaces/system/ports'
   */
  getPath(
    configKey: string,
    defaultValue?: string,
    variables: Record<string, string> = {},
  ): string {
    const template = this.configService.get<string>(configKey, defaultValue || '');
    return this.resolvePath(template, variables);
  }

  /**
   * 获取系统相关路径
   */
  getSystemPath(subPath: 'ports' | 'locks' | 'nginx' | 'metrics' | 'audit'): string {
    const pathMap = {
      ports: 'workspace.paths.systemPorts',
      locks: 'workspace.paths.systemLocks',
      nginx: 'workspace.paths.systemNginx',
      metrics: 'workspace.paths.systemMetrics',
      audit: 'workspace.paths.systemAudit',
    };

    return this.getPath(pathMap[subPath]);
  }

  /**
   * 获取项目相关路径
   */
  getProjectPath(
    projectId: string,
    type: 'base' | 'baseRepo' | 'templates' | 'sharedCache',
  ): string {
    const pathMap = {
      base: 'workspace.paths.projects',
      baseRepo: 'workspace.paths.projectBaseRepo',
      templates: 'workspace.paths.projectTemplates',
      sharedCache: 'workspace.paths.projectSharedCache',
    };

    return this.getPath(pathMap[type], undefined, { projectId });
  }

  /**
   * 获取用户相关路径
   */
  getUserPath(
    userId: string,
    type: 'base' | 'config' | 'ssh' | 'workspaces' | 'cache' | 'temp',
  ): string {
    const pathMap = {
      base: 'workspace.paths.userBase',
      config: 'workspace.paths.userConfig',
      ssh: 'workspace.paths.userSsh',
      workspaces: 'workspace.paths.userWorkspaces',
      cache: 'workspace.paths.userCache',
      temp: 'workspace.paths.userTemp',
    };

    return this.getPath(pathMap[type], undefined, { userId });
  }

  /**
   * 获取工作空间相关路径
   */
  getWorkspacePath(
    userId: string,
    workspaceId: string,
    type: 'base' | 'code' | 'metadata' | 'devServer' | 'builds' | 'logs' | 'snapshots',
  ): string {
    const pathMap = {
      base: 'workspace.paths.workspace',
      code: 'workspace.paths.workspaceCode',
      metadata: 'workspace.paths.workspaceMetadata',
      devServer: 'workspace.paths.workspaceDevServer',
      builds: 'workspace.paths.workspaceBuilds',
      logs: 'workspace.paths.workspaceLogs',
      snapshots: 'workspace.paths.workspaceSnapshots',
    };

    return this.getPath(pathMap[type], undefined, { userId, workspaceId });
  }

  /**
   * 获取容器相关路径
   */
  getContainerPath(containerId?: string): string {
    const basePath = this.getPath('workspace.paths.containers');

    if (containerId) {
      return this.resolvePath(`${basePath}/container-\${containerId}`, { containerId });
    }

    return basePath;
  }

  /**
   * 获取根目录
   */
  getRootDir(): string {
    return this.rootDir;
  }
}