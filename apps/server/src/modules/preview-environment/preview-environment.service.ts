import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs-extra';
import { WorkspaceService } from '../workspace/workspace.service';
import { ProjectService } from '../project/project.service';
import { ProjectResponseDto } from '../project/dto/project-response.dto';
import { ContainerManagerService } from '../container/services/container-manager.service';
import { PortPoolManagerService } from '../container/services/port-pool-manager.service';
import { ServerManagerService } from '../server-manager/server-manager.service';
import { GitService } from '../git/git.service';
import { DependencyService } from '../dependency/dependency.service';
import { CreatePreviewEnvironmentDto } from './dto/create-preview-environment.dto';
import { PreviewEnvironmentResponseDto } from './dto/preview-environment-response.dto';
import { WorkspaceStatus } from '../workspace/entities/workspace.entity';
import {
  TaskProgressService,
  TaskStatus,
  PROGRESS_STEPS,
} from '../task-progress';
import { NetworkUtilsService } from 'src/common/utils/network-utils.service';
import { ProjectConfig } from '../server-manager/services/nginx-config.service';
import { Workspace } from '../workspace/entities/workspace.entity';
import * as path from 'path';

// 通用工作空间镜像（内置 nvm + corepack，根据项目配置自动切换 Node 版本和包管理器）
// 构建命令：docker build -t ai-mule/workspace:latest -f docker/workspace/Dockerfile .
const WORKSPACE_IMAGE = 'ai-mule/workspace:latest';
const WORKSPACE_DOCKERFILE = {
  context: path.resolve(process.cwd(), '../..'),
  dockerfilePath: 'docker/workspace/Dockerfile',
  tag: WORKSPACE_IMAGE,
} as const;

/**
 * 核心创建流程的内部结果
 */
interface CreateResult {
  workspaceId: string;
  codeDir: string;
  containerId: string;
  hostPort: number;
  internalPort: number;
  previewUrl: string;
  packageManager: string;
  branch: string;
}

/**
 * 核心创建流程的选项
 */
interface DoCreateOptions {
  /** 任务 ID，有则更新进度 */
  taskId?: string;
  /** 项目信息（避免重复查询） */
  project?: ProjectResponseDto;
}

/**
 * 预览环境服务 - 高层编排服务
 *
 * 职责:
 * - 编排多个底层服务创建完整的预览环境
 * - 处理预览环境的生命周期管理
 * - 错误处理和资源清理
 */
@Injectable()
export class PreviewEnvironmentService {
  private readonly logger = new Logger(PreviewEnvironmentService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly workspaceService: WorkspaceService,
    private readonly projectService: ProjectService,
    private readonly gitService: GitService,
    private readonly dependencyService: DependencyService,
    private readonly containerManager: ContainerManagerService,
    private readonly portPoolManager: PortPoolManagerService,
    private readonly serverManagerService: ServerManagerService,
    private readonly taskProgressService: TaskProgressService,
    private readonly networkUtils: NetworkUtilsService,
  ) {}

  /**
   * 创建完整的预览环境（同步方式）
   *
   * 此方法调用统一的 doCreate 核心逻辑，并将结果转换为 PreviewEnvironmentResponseDto。
   * 支持幂等性检查：如果预览环境已在运行，直接返回现有环境信息。
   */
  async create(
    dto: CreatePreviewEnvironmentDto & { userId: string },
  ): Promise<PreviewEnvironmentResponseDto> {
    const { userId, workspaceId, projectId, branch } = dto;
    const targetBranch = branch || 'main';

    this.logger.log(
      `[create] Creating preview environment for workspace ${workspaceId}`,
    );

    // 获取已有工作空间信息
    const existingWorkspace =
      await this.workspaceService.findByWorkspaceId(workspaceId);

    if (!existingWorkspace) {
      throw new Error(`Workspace not found: ${workspaceId}`);
    }

    // 检查工作空间是否已有运行中的预览环境（幂等性）
    // 注意：使用 workspace 的真正所有者 userId，而不是当前请求的 userId
    const existingCodeDir = this.workspaceService.getWorkspaceCodeDir(
      existingWorkspace.userId,
      workspaceId,
    );
    const existingContainerId =
      await this.containerManager.findContainerByWorkspace(workspaceId);

    // 获取项目配置用于构建正确的 previewUrl
    const project = await this.projectService.findOne(projectId);
    const projectConfig = {
      projectId: project.projectId,
      hasPathPrefix: project.hasPathPrefix,
      pathPrefix: project.pathPrefix,
      prefixSource: project.prefixSource,
      network: project.network,
    };

    const existingServerInfo = await this.serverManagerService.getServerStatus(
      workspaceId,
      existingCodeDir,
      project.devPortDefault,
      projectConfig,
    );

    // 如果预览环境已经在运行，直接返回
    if (
      existingServerInfo?.devServerStatus?.running &&
      existingServerInfo?.previewUrl
    ) {
      this.logger.log(
        `[create] Preview environment already running for workspace: ${workspaceId}`,
      );

      // 记录预览环境激活时间
      await this.workspaceService.updatePreviewActivatedAt(workspaceId);

      return {
        userId,
        projectId,
        branch: targetBranch,
        workspaceId,
        gitCloneSuccess: true,
        dependenciesInstalled: true,
        containerCreated: !!existingContainerId,
        containerId: existingContainerId || undefined,
        devServerStarted: true,
        nginxConfigured: true,
        status: existingWorkspace.status,
        workspaceDir: this.workspaceService.getWorkspaceDir(
          existingWorkspace.userId,
          workspaceId,
        ),
        codeDir: existingCodeDir,
        previewUrl: existingServerInfo.previewUrl,
        hostPort: existingServerInfo.port,
        createdAt: existingWorkspace.createdAt.toISOString(),
        nextSteps: [
          '✅ 使用已存在的预览环境',
          `🔗 预览地址: ${existingServerInfo.previewUrl}`,
        ],
      };
    }

    try {
      // 调用统一的核心创建逻辑，传入已获取的 project 避免重复查询
      // 注意：使用 workspace 的真正所有者 userId，而不是当前请求的 userId
      const result = await this.doCreate(workspaceId, {
        ...dto,
        userId: existingWorkspace.userId,
      }, { project });

      // 转换为 PreviewEnvironmentResponseDto
      return {
        userId,
        projectId,
        branch: result.branch,
        workspaceId: result.workspaceId,
        gitCloneSuccess: true,
        dependenciesInstalled: true,
        containerCreated: true,
        containerId: result.containerId,
        devServerStarted: true,
        nginxConfigured: true,
        status: WorkspaceStatus.RUNNING,
        workspaceDir: this.workspaceService.getWorkspaceDir(
          existingWorkspace.userId,
          workspaceId,
        ),
        codeDir: result.codeDir,
        previewUrl: result.previewUrl,
        hostPort: result.hostPort,
        internalPort: result.internalPort,
        packageManager: result.packageManager,
        createdAt: existingWorkspace.createdAt.toISOString(),
        nextSteps: [
          '✅ 预览环境创建成功!',
          `🔗 预览地址: ${result.previewUrl}`,
          `📁 代码目录: ${result.codeDir}`,
          `🐳 容器 ID: ${result.containerId}`,
          `🔌 端口映射: ${result.hostPort}(宿主机) -> ${result.internalPort}(容器内)`,
        ],
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(`[create] Failed: ${errorMessage}`);

      // 返回错误响应
      return {
        userId,
        projectId,
        branch: targetBranch,
        workspaceId,
        gitCloneSuccess: false,
        dependenciesInstalled: false,
        containerCreated: false,
        devServerStarted: false,
        nginxConfigured: false,
        status: WorkspaceStatus.ERROR,
        workspaceDir: this.workspaceService.getWorkspaceDir(
          userId,
          workspaceId,
        ),
        codeDir: existingCodeDir,
        createdAt: existingWorkspace.createdAt.toISOString(),
        nextSteps: [`❌ 预览环境创建失败: ${errorMessage}`],
      };
    }
  }

  /**
   * 检查预览环境状态（快速，用于幂等性判断）
   */
  async getStatus(
    userId: string,
    workspaceId: string,
  ): Promise<{
    running: boolean;
    previewUrl?: string;
    port?: number;
  }> {
    // 获取 workspace 关联的 project，从中获取容器内端口和路径前缀配置
    let containerPort: number | undefined;
    let projectConfig: ProjectConfig | undefined;
    let workspace: Workspace | null;
    let codeDir = '';

    try {
      workspace = await this.workspaceService.findByWorkspaceId(workspaceId);
      codeDir = this.workspaceService.getWorkspaceCodeDir(
        workspace?.userId || userId,
        workspaceId,
      );
      if (workspace?.projectId) {
        const project = await this.projectService.findOne(workspace.projectId);
        containerPort = project?.devPortDefault;
        // 构建 projectConfig 用于生成正确的 previewUrl
        if (project) {
          projectConfig = {
            projectId: project.projectId,
            hasPathPrefix: project.hasPathPrefix,
            pathPrefix: project.pathPrefix,
            prefixSource: project.prefixSource,
            network: project.network,
          };
        }
      }
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Failed to get project config for workspace ${workspaceId}: ${errorMessage}`,
      );
    }

    const serverInfo = await this.serverManagerService.getServerStatus(
      workspaceId,
      codeDir,
      containerPort,
      projectConfig,
    );

    if (serverInfo?.devServerStatus?.running && serverInfo?.previewUrl) {
      // 记录预览环境激活时间
      await this.workspaceService.updatePreviewActivatedAt(workspaceId);
      return {
        running: true,
        previewUrl: serverInfo.previewUrl,
        port: serverInfo.port,
      };
    }

    return { running: false };
  }

  /**
   * 销毁预览环境
   */
  async destroy(workspaceId: string, userId: string): Promise<void> {
    this.logger.log(`Destroying preview environment: ${workspaceId}`);

    // 1. 验证工作空间所有权
    const isOwner = await this.workspaceService.isWorkspaceOwnedByUser(
      workspaceId,
      userId,
    );
    if (!isOwner) {
      throw new ForbiddenException(
        `User ${userId} does not have permission to access workspace ${workspaceId}`,
      );
    }

    // 验证工作空间存在
    const workspace =
      await this.workspaceService.getWorkspaceMetadata(workspaceId);

    // 1. 停止预览服务
    try {
      await this.serverManagerService.stopServer(workspaceId);
    } catch (error) {
      this.logger.warn(`Failed to stop preview service: ${error.message}`);
    }

    // 2. 停止并删除容器
    try {
      const containerId =
        await this.containerManager.findContainerByWorkspace(workspaceId);

      if (containerId) {
        await this.containerManager.stopContainer(containerId);
        await this.containerManager.removeContainer(containerId);
      }
    } catch (error) {
      this.logger.warn(`Failed to remove container: ${error.message}`);
    }

    // 3. 释放端口
    try {
      await this.portPoolManager.releasePortByWorkspace(workspaceId);
    } catch (error) {
      this.logger.warn(`Failed to release port: ${error.message}`);
    }

    // 4. 删除工作空间
    await this.workspaceService.deleteWorkspace(workspaceId);

    this.logger.log(`Preview environment destroyed: ${workspaceId}`);
  }

  /**
   * 基于已有的工作空间创建预览环境
   *
   * 流程:
   * 1. 验证工作空间所有权
   * 2. 获取现有工作空间信息
   * 3. 检测包管理器 (如果需要)
   * 4. 创建容器并分配端口
   * 5. 启动开发服务器
   * 6. 配置 Nginx
   *
   * @param workspaceId 已存在的工作空间 ID
   * @param userId 当前用户 ID
   * @param options 启动选项 (可选)
   */
  async startPreviewFromWorkspace(
    workspaceId: string,
    userId: string,
    options?: {
      devCommand?: string;
    },
  ): Promise<PreviewEnvironmentResponseDto> {
    this.logger.log(
      `Starting preview environment from existing workspace: ${workspaceId} for user: ${userId}`,
    );

    // 1. 验证工作空间所有权
    const isOwner = await this.workspaceService.isWorkspaceOwnedByUser(
      workspaceId,
      userId,
    );
    if (!isOwner) {
      throw new ForbiddenException(
        `User ${userId} does not have permission to access workspace ${workspaceId}`,
      );
    }

    // 2. 获取工作空间信息
    const workspaceMetadata =
      await this.workspaceService.getWorkspaceMetadata(workspaceId);
    const project = await this.projectService.findOne(
      workspaceMetadata.projectId,
    );

    const codeDir = this.workspaceService.getWorkspaceCodeDir(
      workspaceMetadata.userId,
      workspaceId,
    );

    const response: PreviewEnvironmentResponseDto = {
      userId: userId, // 使用传入的 userId 参数保持一致性
      projectId: workspaceMetadata.projectId,
      branch: workspaceMetadata.branch,
      workspaceId: workspaceId,
      gitCloneSuccess: true, // 假设代码已存在
      dependenciesInstalled: false,
      containerCreated: false,
      devServerStarted: false,
      nginxConfigured: false,
      status: WorkspaceStatus.ACTIVE,
      workspaceDir: this.workspaceService.getWorkspaceDir(
        workspaceMetadata.userId,
        workspaceId,
      ),
      codeDir: codeDir,
      createdAt: new Date().toISOString(),
      nextSteps: [],
    };

    try {
      // Step 1: 检测包管理器
      // 优先级: project 实体配置 > 自动检测
      this.logger.log(`Step 1/3: Detecting package manager`);
      const detectedPackageManager =
        await this.dependencyService.detectPackageManager(response.codeDir);
      const projectPM = project.packageManager; // 数据库项目配置（如 pnpm@8）
      if (projectPM && projectPM !== 'auto') {
        response.packageManager = projectPM;
      } else {
        response.packageManager = detectedPackageManager;
      }
      this.logger.log(
        `Package manager: ${response.packageManager} (project config: ${projectPM})`,
      );

      // Step 2: 创建容器并分配端口
      this.logger.log(`Step 2/3: Creating container and allocating port`);
      let allocatedPort: number | undefined;
      try {
        allocatedPort = await this.portPoolManager.allocatePort(workspaceId);
        const containerPortValue = project.devPortDefault || 3000;

        this.logger.log(
          `Port allocation: hostPort=${allocatedPort}, containerPort=${containerPortValue}`,
        );

        const containerConfig = {
          workspaceId: workspaceId,
          userId: workspaceMetadata.userId,
          workspaceCodeDir: response.codeDir,
          userCacheDir: this.workspaceService.getUserCacheDir(
            workspaceMetadata.userId,
          ),
          hostPort: allocatedPort,
          internalPort: containerPortValue,
          dockerfile: WORKSPACE_DOCKERFILE,
          cmd: ['tail', '-f', '/dev/null'],
        };

        const containerResult =
          await this.containerManager.createContainer(containerConfig);

        response.containerCreated = true;
        response.containerId = containerResult.containerId;
        response.internalPort = containerPortValue;
        response.hostPort = allocatedPort;
      } catch (error) {
        this.logger.error(`Container creation failed: ${error.message}`);
        response.containerError = error.message;
        response.status = WorkspaceStatus.ERROR;
        response.nextSteps.push('⚠️ 容器创建失败: ' + error.message);

        // 释放已分配的端口（如果端口已分配）
        if (allocatedPort !== undefined) {
          try {
            await this.portPoolManager.releasePortByWorkspace(workspaceId);
            this.logger.log(
              `Released port ${allocatedPort} after container creation failure`,
            );
          } catch (releaseError) {
            this.logger.error(
              `Failed to release port ${allocatedPort}: ${releaseError.message}`,
            );
          }
        }

        throw error;
      }

      // Step 3: 启动预览服务
      this.logger.log(`Step 3/3: Starting preview services`);
      try {
        const containerPortValue = project.devPortDefault || 3000;
        const hostIp = this.networkUtils.getHostIp();

        const previewOptions = {
          workspaceId: workspaceId,
          workspaceCodeDir: response.codeDir,
          port: response.hostPort,
          containerPort: containerPortValue,
          projectConfig: {
            projectId: project.projectId,
            hasPathPrefix: project.hasPathPrefix,
            pathPrefix: project.pathPrefix,
            prefixSource: project.prefixSource,
            network: project.network,
          },
          devCommand: options?.devCommand || project.devCommand,
          nodeVersion: project.nodeVersion,
          packageManager: response.packageManager,
          containerId: response.containerId,
          hostIp,
        };

        const serverInfo =
          await this.serverManagerService.startServer(previewOptions);

        response.devServerStarted = serverInfo.devServerStatus.running;
        response.nginxConfigured = serverInfo.nginxConfigGenerated;
        response.previewUrl = serverInfo.previewUrl;
      } catch (error) {
        this.logger.error(`Preview service start failed: ${error.message}`);
        response.devServerError = error.message;
        response.status = WorkspaceStatus.ERROR;
        response.nextSteps.push('⚠️ 预览服务启动失败: ' + error.message);

        // 清理容器和端口（内部清理，不需要权限验证）
        await this.stopPreviewInternal(workspaceId);
        throw error;
      }

      // 更新工作空间状态为运行中
      await this.workspaceService.updateWorkspaceStatus(
        workspaceId,
        WorkspaceStatus.RUNNING,
      );
      response.status = WorkspaceStatus.RUNNING;

      // 记录预览环境激活时间
      await this.workspaceService.updatePreviewActivatedAt(workspaceId);

      // 成功提示
      response.nextSteps.push('✅ 预览环境启动成功!');
      response.nextSteps.push(`🔗 预览地址: ${response.previewUrl}`);
      response.nextSteps.push(`📁 代码目录: ${response.codeDir}`);
      response.nextSteps.push(`🐳 容器 ID: ${response.containerId}`);
      response.nextSteps.push(
        `🔌 端口映射: ${response.hostPort}(宿主机) -> ${response.internalPort}(容器内)`,
      );

      this.logger.log(
        `Preview environment started from workspace: ${workspaceId}`,
      );

      return response;
    } catch (error) {
      this.logger.error(
        `Failed to start preview from workspace: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * 停止预览环境但保留工作空间（公开方法，带权限验证）
   *
   * 此方法供 API 调用，会验证用户是否有权限停止该工作空间的预览环境
   *
   * @param workspaceId 工作空间 ID
   * @param userId 当前用户 ID
   */
  async stopPreviewKeepWorkspace(
    workspaceId: string,
    userId: string,
  ): Promise<void> {
    this.logger.log(
      `Stopping preview environment but keeping workspace: ${workspaceId} for user: ${userId}`,
    );

    // 验证工作空间所有权
    const isOwner = await this.workspaceService.isWorkspaceOwnedByUser(
      workspaceId,
      userId,
    );
    if (!isOwner) {
      throw new ForbiddenException(
        `User ${userId} does not have permission to access workspace ${workspaceId}`,
      );
    }

    // 调用内部方法执行实际的停止逻辑
    await this.stopPreviewInternal(workspaceId);
  }

  /**
   * 停止预览环境但保留工作空间（内部方法，无权限验证）
   *
   * 此方法供系统内部调用（定时任务、清理流程等），不验证权限
   *
   * 流程:
   * 1. 停止预览服务 (开发服务器 + Nginx)
   * 2. 停止并删除容器
   * 3. 释放端口
   * 4. 更新工作空间状态为 IDLE
   *
   * 注意: 不会删除工作空间及其代码文件
   *
   * @param workspaceId 工作空间 ID
   */
  private async stopPreviewInternal(workspaceId: string): Promise<void> {
    // 验证工作空间存在
    await this.workspaceService.getWorkspaceMetadata(workspaceId);

    // 1. 停止预览服务
    try {
      await this.serverManagerService.stopServer(workspaceId);
      this.logger.log(`Preview service stopped for workspace: ${workspaceId}`);
    } catch (error) {
      this.logger.warn(`Failed to stop preview service: ${error.message}`);
    }

    // 2. 停止并删除容器
    try {
      const containerId =
        await this.containerManager.findContainerByWorkspace(workspaceId);

      if (containerId) {
        await this.containerManager.stopContainer(containerId);
        await this.containerManager.removeContainer(containerId);
        this.logger.log(`Container removed for workspace: ${workspaceId}`);
      }
    } catch (error) {
      this.logger.warn(`Failed to remove container: ${error.message}`);
    }

    // 3. 释放端口
    try {
      await this.portPoolManager.releasePortByWorkspace(workspaceId);
      this.logger.log(`Port released for workspace: ${workspaceId}`);
    } catch (error) {
      this.logger.warn(`Failed to release port: ${error.message}`);
    }

    // 4. 更新工作空间状态为 IDLE (保留工作空间和代码)
    try {
      await this.workspaceService.updateWorkspaceStatus(
        workspaceId,
        WorkspaceStatus.IDLE,
      );
      this.logger.log(`Workspace status updated to IDLE: ${workspaceId}`);
    } catch (error) {
      this.logger.warn(`Failed to update workspace status: ${error.message}`);
    }

    this.logger.log(
      `Preview environment stopped, workspace preserved: ${workspaceId}`,
    );
  }

  /**
   * 清理失败的预览环境
   */
  private async cleanup(
    workspaceId: string,
    containerId?: string,
  ): Promise<void> {
    this.logger.log(`Cleaning up failed preview environment: ${workspaceId}`);

    // 停止预览服务
    try {
      await this.serverManagerService.stopServer(workspaceId);
    } catch (error) {
      this.logger.warn(`Failed to stop preview service: ${error.message}`);
    }

    // 删除容器（可通过环境变量 DEBUG_SKIP_CONTAINER_CLEANUP=true 跳过）
    const skipCleanup =
      this.configService.get<string>('DEBUG_SKIP_CONTAINER_CLEANUP') === 'true';
    if (containerId) {
      if (skipCleanup) {
        this.logger.log(
          `[DEBUG] Skipping container cleanup (DEBUG_SKIP_CONTAINER_CLEANUP=true). containerId: ${containerId}`,
        );
      } else {
        try {
          await this.containerManager.stopContainer(containerId);
          await this.containerManager.removeContainer(containerId);
          this.logger.log(`Container cleaned up: ${containerId}`);
        } catch (error: unknown) {
          const errMsg = error instanceof Error ? error.message : String(error);
          this.logger.warn(`Failed to remove container: ${errMsg}`);
        }
      }
    }

    // 释放端口
    try {
      await this.portPoolManager.releasePortByWorkspace(workspaceId);
      this.logger.log(`Port released for workspace: ${workspaceId}`);
    } catch (error) {
      this.logger.warn(`Failed to release port: ${error.message}`);
    }

    // 注意：不删除工作空间记录，保留以便用户查看错误状态和重试
    // 工作空间状态已在 catch 块中更新为 ERROR
  }

  /**
   * 核心创建流程（统一逻辑）
   *
   * 此方法包含预览环境创建的所有核心步骤：
   * 1. 获取项目信息
   * 2. 准备工作空间目录（包括重试时清理已存在的目录）
   * 3. 初始化项目目录
   * 4. 检测包管理器
   * 5. 创建容器
   * 6. 启动开发服务器
   *
   * @param workspaceId 工作空间 ID
   * @param dto 创建参数
   * @param options 可选配置（taskId 用于进度更新）
   */
  private async doCreate(
    workspaceId: string,
    dto: Omit<CreatePreviewEnvironmentDto, 'workspaceId'> & { userId: string },
    options?: DoCreateOptions,
  ): Promise<CreateResult> {
    const { userId, projectId, branch, devCommand } = dto;
    const targetBranch = branch || 'main';
    const { taskId, project: cachedProject } = options || {};

    this.logger.log(
      `[doCreate] Starting: workspaceId=${workspaceId}, taskId=${taskId || 'none'}`,
    );

    let containerId: string | undefined;
    let allocatedPort: number | undefined;

    // 进度更新辅助函数
    const updateProgress = async (
      step: { name: string; percent: number },
      message: string,
    ) => {
      if (taskId) {
        await this.taskProgressService.updateProgress(taskId, {
          status: TaskStatus.RUNNING,
          step: step.name,
          percent: step.percent,
          message,
        });
      }
    };

    try {
      // Step 1: 获取项目信息（复用已缓存的 project，避免重复查询）
      await updateProgress(PROGRESS_STEPS.GET_PROJECT, '正在获取项目配置...');
      const project =
        cachedProject || (await this.projectService.findOne(projectId));
      this.logger.log(
        `[doCreate] Project fetched: ${project.name}${cachedProject ? ' (cached)' : ''}`,
      );

      // Step 2: 准备工作空间目录
      await updateProgress(
        PROGRESS_STEPS.CREATE_WORKSPACE,
        '正在准备工作空间目录...',
      );
      const codeDir = this.workspaceService.getWorkspaceCodeDir(
        userId,
        workspaceId,
      );

      // 检查工作空间状态（用于日志）
      const workspace =
        await this.workspaceService.findByWorkspaceId(workspaceId);
      this.logger.log(
        `[doCreate] Workspace status: ${workspace?.status}, codeDir exists: ${await fs.pathExists(codeDir)}`,
      );

      // 注意：不再强制删除已存在的目录
      // git.service.ts 的 cloneToWorkspace 方法会智能处理：
      // - 如果目录是有效的 git 仓库，跳过克隆
      // - 如果目录存在但不是 git 仓库，删除后重新克隆

      // Step 3: 初始化项目目录
      await updateProgress(
        PROGRESS_STEPS.CLONE_REPO,
        `正在初始化项目目录 ${codeDir}...`,
      );
      const cloneResult = await this.gitService.cloneToWorkspace(projectId, {
        userId,
        targetDir: codeDir,
        branch: targetBranch,
        useReference: true,
      });

      if (!cloneResult.success) {
        throw new Error(cloneResult.error || '项目初始化失败');
      }

      // 如果目录已存在，更新进度消息
      if (cloneResult.skipped) {
        this.logger.log(
          `[doCreate] Project initialization skipped (directory already exists)`,
        );
        await updateProgress(
          PROGRESS_STEPS.CLONE_REPO,
          `项目目录已存在，跳过初始化步骤`,
        );
      } else {
        this.logger.log(`[doCreate] Project initialized successfully`);
      }

      // Step 4: 检测包管理器
      await updateProgress(
        PROGRESS_STEPS.DETECT_PACKAGE_MANAGER,
        '正在检测项目使用的包管理器...',
      );
      const detectedPackageManager =
        await this.dependencyService.detectPackageManager(codeDir);
      // 优先级: project 实体配置 > 自动检测
      const projectPM = project.packageManager;
      let finalPackageManager: string;
      if (projectPM && projectPM !== 'auto') {
        finalPackageManager = projectPM;
      } else {
        finalPackageManager = detectedPackageManager;
      }
      this.logger.log(
        `[doCreate] Package manager: ${finalPackageManager} (project config: ${projectPM})`,
      );

      // Step 5: 创建容器（智能判断：如果容器已存在则复用）
      await updateProgress(
        PROGRESS_STEPS.CREATE_CONTAINER,
        '正在检查/创建 Docker 容器...',
      );

      const containerPortValue = project.devPortDefault || 3000;

      // 检查是否已有运行中的容器
      const existingContainerId =
        await this.containerManager.findContainerByWorkspace(workspaceId);

      if (existingContainerId) {
        try {
          const containerStatus =
            await this.containerManager.getContainerStatus(existingContainerId);

          if (containerStatus === 'running') {
            // 容器已在运行，复用它
            containerId = existingContainerId;
            this.logger.log(
              `[doCreate] Reusing existing running container: ${containerId}`,
            );

            // 获取已分配的端口
            const portInfo =
              await this.portPoolManager.getPortByWorkspace(workspaceId);
            if (portInfo) {
              allocatedPort = portInfo.port;
              this.logger.log(
                `[doCreate] Reusing existing port: ${allocatedPort}`,
              );
            } else {
              // 端口信息丢失，重新分配
              allocatedPort =
                await this.portPoolManager.allocatePort(workspaceId);
              this.logger.log(
                `[doCreate] Port info lost, reallocated: ${allocatedPort}`,
              );
            }

            await updateProgress(
              PROGRESS_STEPS.CREATE_CONTAINER,
              '容器已存在，复用现有容器',
            );
          } else {
            // 容器存在但未运行，先清理再重新创建
            this.logger.log(
              `[doCreate] Container exists but not running (${containerStatus}), removing...`,
            );
            await this.containerManager.removeContainer(existingContainerId);
            await this.portPoolManager.releasePortByWorkspace(workspaceId);
            containerId = undefined;
          }
        } catch (error: unknown) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          this.logger.warn(
            `[doCreate] Failed to check existing container: ${errorMessage}, will create new one`,
          );
        }
      }

      // 如果没有可用的容器，创建新的
      if (!containerId) {
        // 防御性检查：如果有孤立的端口分配（容器已删除但端口未释放），先释放
        const existingPort =
          await this.portPoolManager.getPortByWorkspace(workspaceId);
        if (existingPort) {
          this.logger.warn(
            `[doCreate] Found orphaned port allocation (${existingPort.port}), releasing it`,
          );
          await this.portPoolManager.releasePortByWorkspace(workspaceId);
        }

        allocatedPort = await this.portPoolManager.allocatePort(workspaceId);

        const containerResult = await this.containerManager.createContainer({
          workspaceId,
          userId,
          workspaceCodeDir: codeDir,
          userCacheDir: this.workspaceService.getUserCacheDir(userId),
          hostPort: allocatedPort,
          internalPort: containerPortValue,
          dockerfile: WORKSPACE_DOCKERFILE,
          cmd: ['tail', '-f', '/dev/null'],
        });

        containerId = containerResult.containerId;
        this.logger.log(`[doCreate] Container created: ${containerId}`);
      }

      // Step 6: 安装依赖（在容器内，由 startServer 处理）
      await updateProgress(
        PROGRESS_STEPS.INSTALL_DEPENDENCIES,
        '正在安装项目依赖...',
      );

      // Step 7: 启动开发服务器
      await updateProgress(
        PROGRESS_STEPS.START_DEV_SERVER,
        '正在启动开发服务器...',
      );

      const hostIp = this.networkUtils.getHostIp();
      this.logger.log(`Host IP: ${hostIp}`);

      // 确保端口已分配
      if (!allocatedPort) {
        throw new Error('Port allocation failed: no port available');
      }

      // 调试日志：检查 project 对象
      this.logger.log(
        `[doCreate] Project path prefix info: hasPathPrefix=${project.hasPathPrefix} (type: ${typeof project.hasPathPrefix}), pathPrefix=${project.pathPrefix}`,
      );

      const serverInfo = await this.serverManagerService.startServer({
        workspaceId,
        workspaceCodeDir: codeDir,
        port: allocatedPort,
        containerPort: containerPortValue,
        projectConfig: {
          projectId: project.projectId,
          hasPathPrefix: project.hasPathPrefix,
          pathPrefix: project.pathPrefix,
          prefixSource: project.prefixSource,
          network: project.network,
        },
        devCommand: devCommand || project.devCommand,
        nodeVersion: project.nodeVersion,
        packageManager: finalPackageManager,
        containerId,
        hostIp,
      });

      this.logger.log(
        `[doCreate] Dev server started: ${serverInfo.previewUrl}`,
      );

      // Step 8: 配置 Nginx（已在 startServer 中完成）
      await updateProgress(
        PROGRESS_STEPS.CONFIGURE_NGINX,
        '正在配置 Nginx 反向代理...',
      );

      // 更新工作空间状态为运行中
      await this.workspaceService.updateWorkspaceStatus(
        workspaceId,
        WorkspaceStatus.RUNNING,
      );

      // 记录预览环境激活时间
      await this.workspaceService.updatePreviewActivatedAt(workspaceId);

      this.logger.log(
        `[doCreate] Preview environment created successfully: ${workspaceId}`,
      );

      return {
        workspaceId,
        codeDir,
        containerId,
        hostPort: allocatedPort,
        internalPort: containerPortValue,
        previewUrl: serverInfo.previewUrl,
        packageManager: finalPackageManager,
        branch: targetBranch,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(`[doCreate] Failed: ${errorMessage}`);

      // 更新工作空间状态为错误
      await this.workspaceService.updateWorkspaceStatus(
        workspaceId,
        WorkspaceStatus.ERROR,
      );

      // 尝试清理资源
      try {
        await this.cleanup(workspaceId, containerId);
      } catch (cleanupError) {
        const cleanupMsg =
          cleanupError instanceof Error
            ? cleanupError.message
            : String(cleanupError);
        this.logger.error(`[doCreate] Cleanup failed: ${cleanupMsg}`);
      }

      throw error;
    }
  }

  /**
   * 异步创建预览环境（带进度更新）
   *
   * 此方法用于在后台异步创建预览环境，通过 taskId 更新进度。
   * 调用前需要先创建工作空间记录（状态为 CREATING）。
   *
   * @param taskId 任务 ID（用于进度更新）
   * @param workspaceId 工作空间 ID
   * @param dto 创建参数
   */
  async executeCreateWithProgress(
    taskId: string,
    workspaceId: string,
    dto: Omit<CreatePreviewEnvironmentDto, 'workspaceId'> & { userId: string },
  ): Promise<void> {
    this.logger.log(
      `[executeCreateWithProgress] Starting: taskId=${taskId}, workspaceId=${workspaceId}`,
    );

    try {
      // 调用统一的核心创建逻辑（带进度更新）
      const result = await this.doCreate(workspaceId, dto, { taskId });

      // 完成任务
      await this.taskProgressService.completeTask(taskId, {
        workspaceId: result.workspaceId,
        previewUrl: result.previewUrl,
        codeDir: result.codeDir,
        containerId: result.containerId,
        hostPort: result.hostPort,
      });

      this.logger.log(
        `[executeCreateWithProgress] Completed: ${workspaceId}, previewUrl: ${result.previewUrl}`,
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        `[executeCreateWithProgress] Task ${taskId} failed: ${errorMessage}`,
      );

      // 标记任务失败（doCreate 已经更新了工作空间状态和清理资源）
      await this.taskProgressService.failTask(taskId, errorMessage);
    }
  }
}
