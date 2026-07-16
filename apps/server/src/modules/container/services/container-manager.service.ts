import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Docker = require('dockerode');
import * as fs from 'fs-extra';
import * as path from 'path';
import { PortPoolManagerService } from './port-pool-manager.service';
import { PathResolverService } from '../../../common/services/path-resolver.service';

export interface DockerfileConfig {
  /** Dockerfile 所在的构建上下文目录 */
  context: string;
  /** Dockerfile 文件路径(相对于 context,默认为 'Dockerfile') */
  dockerfilePath?: string;
  /** 构建参数 */
  buildArgs?: Record<string, string>;
  /** 构建的镜像标签(如果不提供,会自动生成) */
  tag?: string;
}

export interface ContainerConfig {
  workspaceId: string;
  userId: string;
  workspaceCodeDir: string;
  userCacheDir: string;
  hostPort: number; // 宿主机映射端口
  internalPort?: number; // 容器内部端口(默认3000)
  /** 方式1: 从 Dockerfile 构建(优先级最高) */
  dockerfile?: DockerfileConfig;
  /** 方式2: 使用现有镜像 */
  image?: string;
  environment?: Record<string, string>;
  cmd?: string[];
}

export interface ContainerMetadata {
  containerId: string;
  workspaceId: string;
  userId: string;
  port: number;
  /** 容器名称（用于 Docker DNS 服务发现） */
  containerName: string;
  /** 容器内部端口 */
  internalPort: number;
  image: string;
  status: string;
  createdAt: string;
  startedAt?: string;
}

@Injectable()
export class ContainerManagerService {
  private readonly logger = new Logger(ContainerManagerService.name);
  private readonly docker: Docker;
  private readonly defaultImage: string;
  private readonly containerMetadataDir: string;
  private readonly dockerNetwork: string;
  private readonly globalCacheDir: string;

  constructor(
    private portPoolManager: PortPoolManagerService,
    private configService: ConfigService,
    private pathResolver: PathResolverService,
  ) {
    // 初始化 Docker 客户端
    const dockerSocketPath = this.configService.get<string>(
      'container.dockerSocket',
      '/var/run/docker.sock',
    );
    this.docker = new Docker({ socketPath: dockerSocketPath });

    // 默认镜像（自定义镜像已配置 npm/pnpm 双源）
    this.defaultImage = this.configService.get<string>(
      'container.defaultImage',
      'ai-mule/workspace:latest',
    );

    // Docker 网络名称（与 docker-compose 中的 external 网络一致）
    this.dockerNetwork = this.configService.get<string>(
      'container.dockerNetwork',
      'ai-mule-network',
    );

    // 使用 PathResolverService 解析容器元数据目录
    this.containerMetadataDir = this.pathResolver.getContainerPath();

    // 全局缓存目录（所有容器共享，用于 pnpm store / npm cache / yarn cache）
    this.globalCacheDir = this.pathResolver.getPath(
      'workspace.paths.globalCache',
    );
  }

  /**
   * 创建并启动容器
   */
  async createContainer(config: ContainerConfig): Promise<ContainerMetadata> {
    const {
      workspaceId,
      userId,
      workspaceCodeDir,
      userCacheDir,
      hostPort,
      internalPort = 3000,
      environment,
      cmd,
      dockerfile,
    } = config;

    this.logger.log(
      `Creating container for workspace ${workspaceId} (host:${hostPort} -> container:${internalPort})`,
    );

    // 1. 确定使用的镜像（优先级: dockerfile > image）
    let image: string;

    if (dockerfile) {
      // 从 Dockerfile 构建镜像（如果已存在则跳过）
      if (dockerfile.tag) {
        const exists = await this.imageExists(dockerfile.tag);
        if (exists) {
          this.logger.log(`Image ${dockerfile.tag} already exists, skipping build`);
          image = dockerfile.tag;
        } else {
          this.logger.log(`Building image from Dockerfile for workspace ${workspaceId}`);
          image = await this.buildImageFromDockerfile(dockerfile, workspaceId);
        }
      } else {
        this.logger.log(`Building image from Dockerfile for workspace ${workspaceId}`);
        image = await this.buildImageFromDockerfile(dockerfile, workspaceId);
      }
    } else if (config.image) {
      // 使用指定的镜像
      image = config.image;
      await this.ensureImage(image);
    } else {
      // 使用默认镜像
      image = this.defaultImage;
      await this.ensureImage(image);
    }

    // 2. 容器名称（用于 Docker DNS 服务发现）
    const containerName = `workspace-${workspaceId}`;

    // 3. 构建 HostConfig
    // 统一使用 Bind Mount，Docker 和本地环境都使用相同的宿主机路径
    // 这样 workspaceCodeDir 在所有环境中保持一致
    const absCodeDir = path.resolve(workspaceCodeDir);
    const hostConfig: Docker.HostConfig = {
      NetworkMode: this.dockerNetwork,
      // Bind Mount: 直接挂载宿主机目录到容器
      Binds: [
        `${absCodeDir}:/workspace/code:rw`,
        `${userCacheDir}:/cache:rw`,
        `${this.globalCacheDir}:/global-cache:rw`,
      ],
      // 端口映射：将容器内部端口映射到宿主机端口（用于外部 Nginx 访问）
      PortBindings: {
        [`${internalPort}/tcp`]: [{ HostPort: hostPort.toString() }],
      },
      // 资源限制
      Memory: this.parseMemory(
        this.configService.get('container.limits.memory', '2g'),
      ),
      NanoCpus: this.parseCpu(
        this.configService.get('container.limits.cpus', '1.0'),
      ),
      PidsLimit: this.configService.get<number>(
        'container.limits.pidsLimit',
        100,
      ),
      // 安全选项
      SecurityOpt: ['no-new-privileges'],
      ReadonlyRootfs: false, // 开发服务器需要写入临时文件
      // 自动删除
      AutoRemove: false,
      // 重启策略
      RestartPolicy: {
        Name: 'unless-stopped',
      },
    };

    this.logger.log(`Using Bind mounts: ${workspaceCodeDir}:/workspace/code`);

    // 4. 创建容器配置
    const containerConfig: Docker.ContainerCreateOptions = {
      Image: image,
      name: containerName,
      WorkingDir: '/workspace',
      Env: this.buildEnvironmentVariables(environment),
      ExposedPorts: {
        [`${internalPort}/tcp`]: {},
      },
      Cmd: cmd, // 添加自定义命令
      HostConfig: hostConfig,
      Labels: {
        'com.ai-code-platform.workspace-id': workspaceId,
        'com.ai-code-platform.user-id': userId,
        'com.ai-code-platform.type': 'dev-server',
        'com.ai-code-platform.container-name': containerName,
        'com.ai-code-platform.internal-port': internalPort.toString(),
      },
    };

    // 4. 创建容器
    const container = await this.docker.createContainer(containerConfig);
    const containerId = container.id;

    // 5. 启动容器
    await container.start();

    // 6. 更新端口的容器 ID（保留端口池管理，用于追踪）
    await this.portPoolManager.updatePortContainer(hostPort, containerId);

    // 7. 保存容器元数据
    const metadata: ContainerMetadata = {
      containerId,
      workspaceId,
      userId,
      port: hostPort, // 保留用于追踪
      containerName, // 新增：容器名称
      internalPort, // 新增：内部端口
      image,
      status: 'running',
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
    };

    await this.saveContainerMetadata(containerId, metadata);

    this.logger.log(
      `Container ${containerName} (${containerId}) created and started for workspace ${workspaceId}`,
    );

    return metadata;
  }

  /**
   * 停止容器
   */
  async stopContainer(containerId: string): Promise<void> {
    this.logger.log(`Stopping container ${containerId}`);

    const container = this.docker.getContainer(containerId);
    await container.stop();

    // 更新元数据
    const metadata = await this.getContainerMetadata(containerId);
    if (metadata) {
      metadata.status = 'stopped';
      await this.saveContainerMetadata(containerId, metadata);
    }

    this.logger.log(`Container ${containerId} stopped`);
  }

  /**
   * 启动已停止的容器
   */
  async startContainer(containerId: string): Promise<void> {
    this.logger.log(`Starting container ${containerId}`);

    const container = this.docker.getContainer(containerId);
    await container.start();

    // 更新元数据
    const metadata = await this.getContainerMetadata(containerId);
    if (metadata) {
      metadata.status = 'running';
      metadata.startedAt = new Date().toISOString();
      await this.saveContainerMetadata(containerId, metadata);
    }

    this.logger.log(`Container ${containerId} started`);
  }

  /**
   * 删除容器
   */
  async removeContainer(containerId: string): Promise<void> {
    this.logger.log(`Removing container ${containerId}`);

    try {
      const container = this.docker.getContainer(containerId);

      // 如果容器在运行，先停止
      const info = await container.inspect();
      if (info.State.Running) {
        await container.stop();
      }

      // 删除容器
      await container.remove();

      // 删除元数据
      const metadataDir = this.getContainerMetadataDir(containerId);
      await fs.remove(metadataDir);

      this.logger.log(`Container ${containerId} removed`);
    } catch (error) {
      this.logger.error(
        `Failed to remove container ${containerId}: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * 获取容器状态
   */
  async getContainerStatus(containerId: string): Promise<string> {
    const container = this.docker.getContainer(containerId);
    const info = await container.inspect();

    return info.State.Status;
  }

  /**
   * 检查容器是否存在
   */
  async containerExists(containerId: string): Promise<boolean> {
    try {
      const container = this.docker.getContainer(containerId);
      await container.inspect();
      return true;
    } catch (error) {
      if (error.statusCode === 404) {
        return false;
      }
      throw error;
    }
  }

  /**
   * 根据 workspace ID 查找容器
   */
  async findContainerByWorkspace(workspaceId: string): Promise<string | null> {
    const containers = await this.docker.listContainers({ all: true });

    const found = containers.find(
      (c) => c.Labels['com.ai-code-platform.workspace-id'] === workspaceId,
    );

    return found ? found.Id : null;
  }

  /**
   * 执行容器内命令
   */
  async execCommand(
    containerId: string,
    cmd: string[],
  ): Promise<{ stdout: string; stderr: string }> {
    const container = this.docker.getContainer(containerId);

    const exec = await container.exec({
      Cmd: cmd,
      AttachStdout: true,
      AttachStderr: true,
    });

    const stream = await exec.start({ Detach: false });

    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';

      stream.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        // Docker 多路复用格式处理
        if (chunk[0] === 1) {
          stdout += text.slice(8);
        } else if (chunk[0] === 2) {
          stderr += text.slice(8);
        } else {
          stdout += text;
        }
      });

      stream.on('end', () => {
        resolve({ stdout, stderr });
      });

      stream.on('error', reject);
    });
  }

  /**
   * 获取容器日志
   */
  async getContainerLogs(containerId: string, tail?: number): Promise<string> {
    const container = this.docker.getContainer(containerId);

    const logs = await container.logs({
      stdout: true,
      stderr: true,
      tail: tail || 100,
      timestamps: true,
    });

    return logs.toString();
  }

  /**
   * 清理停止的容器（定期任务）
   */
  async cleanupStoppedContainers(): Promise<number> {
    this.logger.log('Cleaning up stopped containers');

    const containers = await this.docker.listContainers({
      all: true,
      filters: {
        status: ['exited'],
        label: ['com.ai-code-platform.type=dev-server'],
      },
    });

    let cleanedCount = 0;

    for (const containerInfo of containers) {
      try {
        const container = this.docker.getContainer(containerInfo.Id);
        await container.remove();
        cleanedCount++;

        // 删除元数据
        const metadataDir = this.getContainerMetadataDir(containerInfo.Id);
        await fs.remove(metadataDir);
      } catch (error) {
        this.logger.error(
          `Failed to remove container ${containerInfo.Id}: ${error.message}`,
        );
      }
    }

    if (cleanedCount > 0) {
      this.logger.log(`Cleaned up ${cleanedCount} stopped containers`);
    }

    return cleanedCount;
  }

  // ==================== 私有方法 ====================

  /**
   * 确保镜像存在
   */
  private async imageExists(image: string): Promise<boolean> {
    try {
      await this.docker.getImage(image).inspect();
      return true;
    } catch {
      return false;
    }
  }

  private async ensureImage(image: string): Promise<void> {
    try {
      await this.docker.getImage(image).inspect();
      this.logger.log(`Image ${image} already exists`);
    } catch (error) {
      if (error.statusCode === 404) {
        this.logger.log(`Pulling image ${image}...`);
        await this.pullImage(image);
      } else {
        throw error;
      }
    }
  }

  /**
   * 拉取镜像
   */
  private async pullImage(image: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.docker.pull(image, (err: Error, stream: NodeJS.ReadableStream) => {
        if (err) {
          reject(err);
          return;
        }

        this.docker.modem.followProgress(stream, (err: Error) => {
          if (err) {
            reject(err);
          } else {
            this.logger.log(`Image ${image} pulled successfully`);
            resolve();
          }
        });
      });
    });
  }

  /**
   * 从 Dockerfile 构建镜像
   */
  private async buildImageFromDockerfile(
    dockerfileConfig: DockerfileConfig,
    workspaceId: string,
  ): Promise<string> {
    const { context, dockerfilePath, buildArgs, tag } = dockerfileConfig;

    // 1. 验证构建上下文目录存在
    if (!(await fs.pathExists(context))) {
      throw new Error(`Build context directory not found: ${context}`);
    }

    // 2. 验证 Dockerfile 存在
    const dockerfile = dockerfilePath || 'Dockerfile';
    const dockerfileFull = path.join(context, dockerfile);
    if (!(await fs.pathExists(dockerfileFull))) {
      throw new Error(`Dockerfile not found: ${dockerfileFull}`);
    }

    // 3. 生成镜像标签(如果未提供)
    const imageTag = tag || `workspace-${workspaceId}:latest`;

    this.logger.log(`Building image from Dockerfile: ${dockerfileFull}`);
    this.logger.log(`Image tag: ${imageTag}`);

    const buildContextEntries = await fs.readdir(context);
    const buildSrc = Array.from(
      new Set([
        dockerfile,
        ...buildContextEntries.filter((entry) => entry !== dockerfile),
      ]),
    );

    // 4. 构建镜像
    return new Promise((resolve, reject) => {
      // 创建构建流
      const tarStream = this.docker.buildImage(
        {
          context,
          src: buildSrc,
        },
        {
          t: imageTag,
          dockerfile,
          buildargs: {
            ...buildArgs,
            HTTP_PROXY: process.env.HTTP_PROXY || '',
            HTTPS_PROXY: process.env.HTTPS_PROXY || '',
            http_proxy: process.env.HTTP_PROXY || '',
            https_proxy: process.env.HTTPS_PROXY || '',
          },
          // 不使用缓存，确保构建最新代码
          nocache: false,
          // 删除中间容器
          rm: true,
          // 强制删除中间容器
          forcerm: true,
        },
        (err: Error, stream: NodeJS.ReadableStream) => {
          if (err) {
            reject(err);
            return;
          }

          // 监听构建进度
          let buildOutput = '';
          stream.on('data', (chunk: Buffer) => {
            const text = chunk.toString();
            buildOutput += text;

            // 解析 JSON 格式的构建输出
            try {
              const lines = text.trim().split('\n');
              lines.forEach((line) => {
                const json = JSON.parse(line);
                if (json.stream) {
                  this.logger.debug(json.stream.trim());
                }
                if (json.error) {
                  this.logger.error(json.error);
                }
              });
            } catch (e) {
              // 忽略解析错误
            }
          });

          stream.on('end', () => {
            // 检查是否有错误
            if (buildOutput.includes('"error":')) {
              reject(new Error(`Docker build failed: ${buildOutput}`));
            } else {
              this.logger.log(`Image ${imageTag} built successfully`);
              resolve(imageTag);
            }
          });

          stream.on('error', (err: Error) => {
            reject(err);
          });
        },
      );
    });
  }

  /**
   * 构建环境变量数组
   */
  private buildEnvironmentVariables(env?: Record<string, string>): string[] {
    const defaultEnv = {
      NODE_ENV: 'development',
    };

    const merged = { ...defaultEnv, ...env };
    return Object.entries(merged).map(([key, value]) => `${key}=${value}`);
  }

  /**
   * 解析内存限制
   */
  private parseMemory(memory: string): number {
    const match = memory.match(/^(\d+)([kmg]?)$/i);
    if (!match) {
      throw new Error(`Invalid memory format: ${memory}`);
    }

    const value = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();

    switch (unit) {
      case 'k':
        return value * 1024;
      case 'm':
        return value * 1024 * 1024;
      case 'g':
        return value * 1024 * 1024 * 1024;
      default:
        return value;
    }
  }

  /**
   * 解析 CPU 限制
   */
  private parseCpu(cpus: string): number {
    const value = parseFloat(cpus);
    return value * 1e9; // 转换为纳秒
  }

  /**
   * 获取容器元数据目录
   */
  private getContainerMetadataDir(containerId: string): string {
    return path.join(this.containerMetadataDir, `container-${containerId}`);
  }

  /**
   * 保存容器元数据
   */
  private async saveContainerMetadata(
    containerId: string,
    metadata: ContainerMetadata,
  ): Promise<void> {
    const metadataDir = this.getContainerMetadataDir(containerId);
    await fs.ensureDir(metadataDir);

    const metadataPath = path.join(metadataDir, 'metadata.json');
    await fs.writeJSON(metadataPath, metadata, { spaces: 2 });
  }

  /**
   * 获取容器元数据
   */
  private async getContainerMetadata(
    containerId: string,
  ): Promise<ContainerMetadata | null> {
    const metadataPath = path.join(
      this.getContainerMetadataDir(containerId),
      'metadata.json',
    );

    if (await fs.pathExists(metadataPath)) {
      return await fs.readJSON(metadataPath);
    }

    return null;
  }
}
