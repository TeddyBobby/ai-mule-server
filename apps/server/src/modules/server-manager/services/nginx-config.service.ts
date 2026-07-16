import { Injectable, Logger } from '@nestjs/common';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as lockfile from 'proper-lockfile';
import { PathResolverService } from '../../../common/services/path-resolver.service';
import { NetworkType } from 'src/modules/project/entities/project.entity';

const execAsync = promisify(exec);

export interface ProjectConfig {
  projectId: string;
  hasPathPrefix: boolean;
  pathPrefix?: string;
  prefixSource: string;
  network: NetworkType;
}

export interface ContainerInfo {
  /** 容器名称（用于 Docker DNS 服务发现） */
  containerName: string;
  /** 容器内部端口 */
  internalPort: number;
}

interface ReloadQueueItem {
  workspaceId: string;
  timestamp: number;
}

@Injectable()
export class NginxConfigService {
  private readonly logger = new Logger(NginxConfigService.name);
  private readonly nginxConfigDir: string;
  private readonly nginxWorkspacesDir: string;
  private readonly lockFilePath: string;
  private reloadQueue: Map<string, ReloadQueueItem> = new Map();
  private reloadTimer: NodeJS.Timeout | null = null;

  constructor(private pathResolver: PathResolverService) {
    // 支持通过环境变量自定义 Nginx 配置目录
    // 优先使用 NGINX_WORKSPACES_DIR, 否则使用项目默认路径
    const customNginxDir = process.env.NGINX_WORKSPACES_DIR;

    if (customNginxDir) {
      this.nginxWorkspacesDir = customNginxDir;
      this.nginxConfigDir = path.dirname(customNginxDir);
      this.logger.log(
        `Using custom Nginx workspaces directory: ${customNginxDir}`,
      );
    } else {
      this.nginxConfigDir = this.pathResolver.getSystemPath('nginx');
      this.nginxWorkspacesDir = path.join(this.nginxConfigDir, 'workspaces');
      this.logger.log(
        `Using default Nginx workspaces directory: ${this.nginxWorkspacesDir}`,
      );
    }

    const systemLocksDir = this.pathResolver.getSystemPath('locks');
    this.lockFilePath = path.join(systemLocksDir, 'nginx.lock');
  }

  /**
   * 初始化 Nginx 配置目录
   */
  async initialize(): Promise<void> {
    await fs.ensureDir(this.nginxConfigDir);
    await fs.ensureDir(this.nginxWorkspacesDir);
    await fs.ensureDir(path.dirname(this.lockFilePath));

    // 创建锁文件
    if (!(await fs.pathExists(this.lockFilePath))) {
      await fs.writeFile(this.lockFilePath, '');
    }

    this.logger.log(`Nginx config directories initialized`);
  }

  /**
   * 生成工作空间的 Nginx 配置文件
   * @param workspaceId 工作空间ID
   * @param containerInfo 容器信息（用于 Docker 网络模式）
   * @param projectConfig 项目配置
   * @param port 可选的宿主机端口（用于本地开发模式）
   */
  async generateWorkspaceConfig(
    workspaceId: string,
    containerInfo: ContainerInfo,
    projectConfig: ProjectConfig,
    port?: number,
  ): Promise<void> {
    const { hasPathPrefix, pathPrefix, prefixSource } = projectConfig;
    const { containerName, internalPort } = containerInfo;

    // 根据环境选择代理目标
    // Docker 环境: 使用容器名称（Docker DNS 服务发现）
    // 本地开发: 使用 host.docker.internal:port（让 Docker 内的 Nginx 访问宿主机）
    const isDockerEnv = process.env.DOCKER_ENV === 'true';
    const proxyTarget = isDockerEnv
      ? `http://${containerName}:${internalPort}`
      : `http://host.docker.internal:${port}`;

    this.logger.log(
      `Generating Nginx config with proxy target: ${proxyTarget}`,
    );

    let locationBlock: string;
    let redirectBlocks = '';

    if (hasPathPrefix && pathPrefix) {
      // 场景二: 有路径前缀
      locationBlock = this.generateLocationBlockWithPrefix(
        workspaceId,
        proxyTarget,
        pathPrefix,
      );

      // 添加重定向规则
      redirectBlocks = this.generateRedirectBlocks(workspaceId, pathPrefix);
    } else {
      // 场景一: 无路径前缀
      locationBlock = this.generateLocationBlockWithoutPrefix(
        workspaceId,
        proxyTarget,
      );
    }

    const configContent = `
# Auto-generated config for workspace ${workspaceId}
# Generated at: ${new Date().toISOString()}
# Project: ${projectConfig.projectId}
# Path prefix: ${hasPathPrefix ? pathPrefix : 'none'}
# Prefix source: ${prefixSource}
${locationBlock}
${redirectBlocks}
`;

    const configPath = path.join(
      this.nginxWorkspacesDir,
      `${workspaceId}.conf`,
    );
    await fs.writeFile(configPath, configContent);

    this.logger.log(
      `Generated Nginx config for workspace ${workspaceId} (prefix: ${pathPrefix || 'none'})`,
    );

    // 调度 Nginx reload
    this.scheduleReload(workspaceId);
  }

  /**
   * 删除工作空间的 Nginx 配置文件
   */
  async removeWorkspaceConfig(workspaceId: string): Promise<void> {
    const configPath = path.join(
      this.nginxWorkspacesDir,
      `${workspaceId}.conf`,
    );

    if (await fs.pathExists(configPath)) {
      await fs.unlink(configPath);
      this.logger.log(`Removed Nginx config for workspace ${workspaceId}`);

      // 调度 Nginx reload
      this.scheduleReload(workspaceId);
    }
  }

  /**
   * 获取 nginx 命令（统一通过 docker exec 在 nginx 容器中执行）
   * @param cmd nginx 命令，如 'nginx -t' 或 'nginx -s reload'
   */
  private getNginxCommand(cmd: string): string {
    const nginxContainer =
      process.env.NGINX_CONTAINER_NAME || 'ai-mule-server-nginx-1';
    return `docker exec ${nginxContainer} ${cmd}`;
  }

  /**
   * 测试 Nginx 配置是否有效
   */
  async testNginxConfig(): Promise<boolean> {
    try {
      const testCmd = this.getNginxCommand('nginx -t');
      const { stdout, stderr } = await execAsync(`${testCmd} 2>&1`);
      const output = stdout + stderr;
      this.logger.debug(`Nginx config test output: ${output}`);

      // Nginx -t 的成功输出通常包含这些关键字
      const isSuccess =
        output.includes('syntax is ok') ||
        output.includes('test is successful') ||
        (output.includes('configuration file') &&
          output.includes('test is successful'));

      if (isSuccess) {
        this.logger.log('Nginx configuration test passed');
      } else {
        this.logger.warn(`Nginx configuration test unclear: ${output}`);
      }

      return isSuccess;
    } catch (error: unknown) {
      const err = error as Error & { stdout?: string; stderr?: string };
      // 记录完整错误信息
      this.logger.error(`Nginx config test error: ${err.message}`);
      if (err.stdout) {
        this.logger.error(`stdout: ${err.stdout}`);
      }
      if (err.stderr) {
        this.logger.error(`stderr: ${err.stderr}`);
      }

      // 检查是否是 Nginx 未安装
      if (
        err.message.includes('command not found') ||
        err.message.includes('ENOENT')
      ) {
        this.logger.warn(
          'Nginx command not found. Skipping configuration test in development mode.',
        );
        // 在开发环境中,如果 Nginx 未安装,可以跳过测试
        if (
          process.env.NODE_ENV === 'development' ||
          process.env.NODE_ENV === 'local'
        ) {
          return true;
        }
      }

      return false;
    }
  }

  /**
   * 重载 Nginx 配置（优雅重载）
   */
  async reloadNginx(): Promise<void> {
    // 先测试配置
    const isValid = await this.testNginxConfig();

    if (!isValid) {
      const error = new Error('Nginx config test failed');

      // 在开发环境中,允许 Nginx 配置测试失败
      if (
        process.env.NODE_ENV === 'development' ||
        process.env.NODE_ENV === 'local'
      ) {
        this.logger.warn(
          'Nginx config test failed in development mode, but continuing anyway',
        );
      } else {
        throw error;
      }
    }

    // 优雅重载（不中断现有连接）
    try {
      const reloadCmd = this.getNginxCommand('nginx -s reload');
      await execAsync(reloadCmd);
      this.logger.log('Nginx configuration reloaded successfully');
    } catch (error: unknown) {
      const err = error as Error;
      this.logger.error(`Nginx reload failed: ${err.message}`);

      // 在开发环境中,允许 Nginx reload 失败
      if (
        process.env.NODE_ENV === 'development' ||
        process.env.NODE_ENV === 'local'
      ) {
        this.logger.warn(
          'Nginx reload failed in development mode, but continuing anyway',
        );
        return;
      }

      throw error;
    }
  }

  /**
   * 调度 Nginx reload（批量 + 防抖）
   */
  private scheduleReload(workspaceId: string): void {
    this.reloadQueue.set(workspaceId, {
      workspaceId,
      timestamp: Date.now(),
    });

    // 延迟 3 秒后执行 reload（防止频繁 reload）
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
    }

    this.reloadTimer = setTimeout(() => {
      this.executeReload().catch((error: unknown) => {
        const err = error as Error;
        this.logger.error(`Failed to reload Nginx: ${err.message}`);
      });
    }, 3000);
  }

  /**
   * 执行 Nginx reload
   */
  private async executeReload(): Promise<void> {
    if (this.reloadQueue.size === 0) return;

    const release = await this.acquireLock();

    try {
      const workspaceCount = this.reloadQueue.size;
      await this.reloadNginx();
      this.logger.log(`Nginx reloaded for ${workspaceCount} workspace(s)`);
      this.reloadQueue.clear();
    } finally {
      await release();
    }
  }

  /**
   * 生成无路径前缀的 location 块
   * @param workspaceId 工作空间ID
   * @param proxyTarget 代理目标地址（如 http://workspace-xxx:3000 或 http://127.0.0.1:13000）
   */
  private generateLocationBlockWithoutPrefix(
    workspaceId: string,
    proxyTarget: string,
  ): string {
    return `
# 主 location: 去除 workspaceId, 直接代理到开发服务器根路径
location /${workspaceId}/ {
    rewrite ^/${workspaceId}/(.*)$ /$1 break;

    # 使用 Docker DNS resolver，允许容器不存在时跳过
    resolver 127.0.0.11 valid=10s ipv6=off;
    set $backend "${proxyTarget}";
    proxy_pass $backend;

    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection 'upgrade';
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_cache_bypass $http_upgrade;

    proxy_connect_timeout 60s;
    proxy_send_timeout 60s;
    proxy_read_timeout 60s;

    # WebSocket 支持
    proxy_set_header Sec-WebSocket-Extensions $http_sec_websocket_extensions;
    proxy_set_header Sec-WebSocket-Key $http_sec_websocket_key;
    proxy_set_header Sec-WebSocket-Version $http_sec_websocket_version;
}`;
  }

  /**
   * 生成有路径前缀的 location 块
   * @param workspaceId 工作空间ID
   * @param proxyTarget 代理目标地址（如 http://workspace-xxx:3000 或 http://127.0.0.1:13000）
   * @param pathPrefix 路径前缀
   */
  private generateLocationBlockWithPrefix(
    workspaceId: string,
    proxyTarget: string,
    pathPrefix: string,
  ): string {
    // 确保路径前缀以 / 开头
    const normalizedPrefix = pathPrefix.startsWith('/')
      ? pathPrefix
      : `/${pathPrefix}`;

    return `
# 主 location: 保留路径前缀, 去除 workspaceId
location /${workspaceId}${normalizedPrefix}/ {
    rewrite ^/${workspaceId}(${normalizedPrefix}/.*)$ $1 break;

    # 使用 Docker DNS resolver，允许容器不存在时跳过
    resolver 127.0.0.11 valid=10s ipv6=off;
    set $backend "${proxyTarget}";
    proxy_pass $backend;

    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection 'upgrade';
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_cache_bypass $http_upgrade;

    proxy_connect_timeout 60s;
    proxy_send_timeout 60s;
    proxy_read_timeout 60s;

    # WebSocket 支持
    proxy_set_header Sec-WebSocket-Extensions $http_sec_websocket_extensions;
    proxy_set_header Sec-WebSocket-Key $http_sec_websocket_key;
    proxy_set_header Sec-WebSocket-Version $http_sec_websocket_version;
}`;
  }

  /**
   * 生成重定向规则
   */
  private generateRedirectBlocks(
    workspaceId: string,
    pathPrefix: string,
  ): string {
    const normalizedPrefix = pathPrefix.startsWith('/')
      ? pathPrefix
      : `/${pathPrefix}`;

    return `
# 重定向: 访问 /${workspaceId}/ 自动跳转到路径前缀
location = /${workspaceId} {
    return 301 $scheme://$host/${workspaceId}${normalizedPrefix}/;
}

location = /${workspaceId}/ {
    return 301 $scheme://$host/${workspaceId}${normalizedPrefix}/;
}`;
  }

  /**
   * 获取文件锁
   */
  private async acquireLock(): Promise<() => Promise<void>> {
    await fs.ensureFile(this.lockFilePath);

    const release = (await lockfile.lock(this.lockFilePath, {
      retries: {
        retries: 10,
        minTimeout: 100,
        maxTimeout: 1000,
      },
    })) as () => Promise<void>;

    return release;
  }

  /**
   * 获取所有工作空间配置列表
   */
  async listWorkspaceConfigs(): Promise<string[]> {
    const files = await fs.readdir(this.nginxWorkspacesDir);
    return files
      .filter((file) => file.endsWith('.conf'))
      .map((file) => file.replace('.conf', ''));
  }
}
