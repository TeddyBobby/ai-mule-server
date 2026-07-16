import { Injectable, Logger } from '@nestjs/common';
import {
  NginxConfigService,
  ProjectConfig,
  ContainerInfo,
} from './services/nginx-config.service';
import {
  DevServerManagerService,
  DevServerConfig,
  DevServerStatus,
} from './services/dev-server-manager.service';
import { NetworkUtilsService } from '../../common/utils/network-utils.service';
import { NetworkType } from '../project/entities/project.entity';

export interface StartServerOptions {
  workspaceId: string;
  workspaceCodeDir: string;
  port: number; // 宿主机端口（本地开发用）
  containerPort?: number; // 容器内端口(默认3000)
  projectConfig: ProjectConfig;
  devCommand?: string;
  nodeVersion?: string; // 如 20、20.19.4
  packageManager?: string; // 如 npm、pnpm、pnpm@9、pnpm@8、yarn
  containerId?: string; // 如果提供,则在容器内启动开发服务器
  /** 容器信息（用于 Docker 网络模式） */
  containerInfo?: ContainerInfo;
  hostIp?: string; // 宿主机 IP 地址
}

export interface ServerInfo {
  workspaceId: string;
  previewUrl: string;
  port: number;
  devServerStatus: DevServerStatus;
  nginxConfigGenerated: boolean;
  projectConfig: ProjectConfig;
}

/**
 * 服务器管理服务
 *
 * 职责:
 * - 启动和停止开发服务器
 * - 生成和管理 Nginx 配置
 * - 构建预览 URL
 */
@Injectable()
export class ServerManagerService {
  private readonly logger = new Logger(ServerManagerService.name);
  private readonly previewDomain: string;

  constructor(
    private nginxConfigService: NginxConfigService,
    private devServerManager: DevServerManagerService,
    private networkUtils: NetworkUtilsService,
  ) {
    // 可以从配置中读取
    this.previewDomain = process.env.PREVIEW_DOMAIN || 'localhost';
  }

  /**
   * 启动服务器(开发服务器 + Nginx)
   */
  async startServer(options: StartServerOptions): Promise<ServerInfo> {
    const {
      workspaceId,
      workspaceCodeDir,
      port,
      containerPort,
      projectConfig,
      devCommand,
      nodeVersion,
      packageManager,
      containerId,
      containerInfo,
      hostIp,
    } = options;

    this.logger.log(`Starting preview for workspace ${workspaceId}`);

    try {
      // 1. 启动开发服务器
      const devServerConfig: DevServerConfig = {
        workspaceId,
        workspaceCodeDir,
        port, // 宿主机端口
        containerPort, // 容器内端口
        command: devCommand,
        nodeVersion,
        packageManager: packageManager || 'auto',
        containerId, // 传递容器ID
      };

      const devServerStatus =
        await this.devServerManager.startDevServer(devServerConfig);

      // 2. 生成 Nginx 配置
      // 使用容器信息（Docker 网络模式）或端口（本地开发模式）
      const effectiveContainerInfo: ContainerInfo = containerInfo || {
        containerName: `workspace-${workspaceId}`,
        internalPort: containerPort || 3000,
      };

      await this.nginxConfigService.generateWorkspaceConfig(
        workspaceId,
        effectiveContainerInfo,
        projectConfig,
        port, // 传递宿主机端口作为备选（本地开发模式）
      );

      // 3. 构建预览 URL
      const resolvedHostIp = hostIp || this.networkUtils.getHostIp();
      const previewUrl = this.buildPreviewUrl(
        projectConfig,
        port,
        resolvedHostIp,
      );

      this.logger.log(
        `Preview started for workspace ${workspaceId}: ${previewUrl}`,
      );

      return {
        workspaceId,
        previewUrl,
        port,
        devServerStatus,
        nginxConfigGenerated: true,
        projectConfig,
      };
    } catch (error) {
      this.logger.error(
        `Failed to start preview for workspace ${workspaceId}: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * 停止服务器
   */
  async stopServer(workspaceId: string): Promise<void> {
    this.logger.log(`Stopping server for workspace ${workspaceId}`);

    try {
      // 1. 停止开发服务器
      await this.devServerManager.stopDevServer(workspaceId);

      // 2. 删除 Nginx 配置
      await this.nginxConfigService.removeWorkspaceConfig(workspaceId);

      this.logger.log(`Server stopped for workspace ${workspaceId}`);
    } catch (error) {
      this.logger.error(
        `Failed to stop server for workspace ${workspaceId}: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * 获取服务器状态
   * @param containerPort 容器内部端口（dev server 监听的端口）
   * @param projectConfig 项目配置（用于构建正确的 previewUrl）
   */
  async getServerStatus(
    workspaceId: string,
    workspaceCodeDir: string,
    containerPort?: number,
    projectConfig?: ProjectConfig,
  ): Promise<ServerInfo | null> {
    try {
      // 获取开发服务器状态
      const devServerStatus = await this.devServerManager.getDevServerStatus(
        workspaceId,
        workspaceCodeDir,
        containerPort,
      );

      if (!devServerStatus.running) {
        return null;
      }

      // 检查 Nginx 配置是否存在
      const configs = await this.nginxConfigService.listWorkspaceConfigs();
      const nginxConfigGenerated = configs.includes(workspaceId);

      // 使用传入的 projectConfig，或者使用默认值
      const config: ProjectConfig = projectConfig || {
        projectId: 'unknown',
        hasPathPrefix: false,
        prefixSource: 'unknown',
        network: NetworkType.INTRANET_ONLY,
      };

      return {
        workspaceId,
        previewUrl: this.buildPreviewUrl(
          config,
          devServerStatus.port || 0,
          this.networkUtils.getHostIp(),
        ),
        port: devServerStatus.port || 0,
        devServerStatus,
        nginxConfigGenerated,
        projectConfig: config,
      };
    } catch (error) {
      this.logger.error(
        `Failed to get preview status for workspace ${workspaceId}: ${error.message}`,
      );
      return null;
    }
  }

  /**
   * 检查预览服务健康状态
   */
  async checkHealth(workspaceId: string, port: number): Promise<boolean> {
    try {
      return await this.devServerManager.checkHealth(port);
    } catch (error) {
      this.logger.error(
        `Health check failed for workspace ${workspaceId}: ${error.message}`,
      );
      return false;
    }
  }

  /**
   * 获取开发服务器日志
   */
  async getDevServerLogs(
    workspaceCodeDir: string,
    lines: number = 100,
  ): Promise<{ stdout: string; stderr: string }> {
    return await this.devServerManager.getDevServerLogs(
      workspaceCodeDir,
      lines,
    );
  }

  /**
   * 重新生成 Nginx 配置（用于配置更新）
   */
  async regenerateNginxConfig(
    workspaceId: string,
    port: number,
    projectConfig: ProjectConfig,
    containerInfo?: ContainerInfo,
  ): Promise<void> {
    this.logger.log(`Regenerating Nginx config for workspace ${workspaceId}`);

    const effectiveContainerInfo: ContainerInfo = containerInfo || {
      containerName: `workspace-${workspaceId}`,
      internalPort: 3000,
    };

    await this.nginxConfigService.generateWorkspaceConfig(
      workspaceId,
      effectiveContainerInfo,
      projectConfig,
      port,
    );

    this.logger.log(`Nginx config regenerated for workspace ${workspaceId}`);
  }

  // ==================== 私有方法 ====================

  /**
   * 构建预览 URL（本地开发模式）
   */
  private buildPreviewUrl(
    projectConfig: ProjectConfig,
    port: number,
    hostIp: string,
  ): string {
    const protocol = 'http'; // 生产环境使用 HTTPS
    const { hasPathPrefix, pathPrefix, network } = projectConfig;

    this.logger.debug(
      `Building preview URL with config: hasPathPrefix=${hasPathPrefix}, ` +
        `pathPrefix=${pathPrefix}, network=${network}, port=${port}, hostIp=${hostIp}`,
    );
    // 根据 network 类型选择域名：外网项目使用 .com，其余使用 .co
    const domain = this.previewDomain;

    // 构建路径部分
    let path = '';
    if (hasPathPrefix && pathPrefix) {
      const normalizedPrefix = pathPrefix.startsWith('/')
        ? pathPrefix.slice(1) // 移除开头的 /
        : pathPrefix;
      path = `/${normalizedPrefix}`;
    }

    // 构建查询参数
    const params = new URLSearchParams({
      _port_: port.toString(),
      _ip_: hostIp,
      _apiEnv_: 'uat',
    });

    // 组装完整的 URL
    return `${protocol}://${domain}${path}/?${params.toString()}#/`;
  }

  /**
   * 初始化服务
   */
  async onModuleInit(): Promise<void> {
    await this.nginxConfigService.initialize();
    this.logger.log('Preview service initialized');
  }

  /**
   * 清理服务
   */
  async onModuleDestroy(): Promise<void> {
    await this.devServerManager.cleanup();
    this.logger.log('Preview service cleaned up');
  }
}
