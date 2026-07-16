import { Injectable, NotFoundException, Logger, BadRequestException, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { generateId } from '../../common/utils/id-generator';
import * as fs from 'fs-extra';
import * as path from 'path';
import { Workspace, WorkspaceStatus } from './entities/workspace.entity';
import { CreateWorkspaceDto } from './dto/create-workspace.dto';
import {
  WorkspaceResponseDto,
  WorkspaceMetadataDto,
} from './dto/workspace-response.dto';
import { PathResolverService } from '../../common/services/path-resolver.service';
import { TaskProgressService } from '../task-progress/task-progress.service';
import { FileService } from '../file/file.service';
import { FileWatcherService } from './services/file-watcher.service';
import { GitService } from '../git/git.service';

@Injectable()
export class WorkspaceService implements OnModuleDestroy {
  private readonly logger = new Logger(WorkspaceService.name);

  constructor(
    @InjectRepository(Workspace)
    private workspaceRepository: Repository<Workspace>,
    private pathResolver: PathResolverService,
    private taskProgressService: TaskProgressService,
    private fileService: FileService,
    private fileWatcherService: FileWatcherService,
    private gitService: GitService,
  ) {
    // 服务启动时，为所有 running/active 的工作空间启动文件监听
    this.initFileWatchers();
  }

  /**
   * 初始化文件监听器（服务启动时调用）
   */
  private async initFileWatchers() {
    try {
      const activeWorkspaces = await this.workspaceRepository.find({
        where: [
          { status: WorkspaceStatus.RUNNING, isDeleted: false },
          { status: WorkspaceStatus.ACTIVE, isDeleted: false },
        ],
      });

      this.logger.log(
        `Initializing file watchers for ${activeWorkspaces.length} active workspaces`,
      );

      for (const workspace of activeWorkspaces) {
        const codeDir = this.getWorkspaceCodeDir(
          workspace.userId,
          workspace.workspaceId,
        );
        if (await fs.pathExists(codeDir)) {
          this.fileWatcherService.startWatching(workspace.workspaceId, codeDir);
          this.logger.log(
            `Started file watching for workspace ${workspace.workspaceId}`,
          );
        }
      }
    } catch (error) {
      this.logger.error('Failed to initialize file watchers', error);
    }
  }

  /**
   * 模块销毁时停止所有文件监听
   */
  async onModuleDestroy() {
    await this.fileWatcherService.stopAll();
  }

  // ==================== 路径管理 ====================

  /**
   * 获取工作空间代码目录
   */
  getWorkspaceCodeDir(userId: string, workspaceId: string): string {
    return this.pathResolver.getWorkspacePath(userId, workspaceId, 'code');
  }

  /**
   * 获取用户配置目录
   */
  getUserConfigDir(userId: string): string {
    return this.pathResolver.getUserPath(userId, 'config');
  }

  /**
   * 获取用户缓存目录
   */
  getUserCacheDir(userId: string): string {
    return this.pathResolver.getUserPath(userId, 'cache');
  }

  /**
   * 获取项目基础仓库目录
   */
  getProjectBaseRepoDir(projectId: string): string {
    return this.pathResolver.getProjectPath(projectId, 'baseRepo');
  }

  /**
   * 获取容器元数据目录
   */
  getContainerMetadataDir(containerId: string): string {
    return this.pathResolver.getContainerPath(containerId);
  }

  /**
   * 获取工作空间根目录
   */
  getWorkspaceDir(userId: string, workspaceId: string): string {
    return this.pathResolver.getWorkspacePath(userId, workspaceId, 'base');
  }

  /**
   * 获取工作空间元数据文件路径
   */
  getWorkspaceMetadataPath(userId: string, workspaceId: string): string {
    return this.pathResolver.getWorkspacePath(userId, workspaceId, 'metadata');
  }

  // ==================== 生命周期管理 ====================

  /**
   * 创建工作空间（异步模式：立即返回 taskId，后台创建预览环境）
   */
  async createWorkspace(
    userId: string,
    createDto: CreateWorkspaceDto,
  ): Promise<WorkspaceResponseDto> {
    const { projectId, requirement } = createDto;
    const branch = createDto.branch?.trim() || 'main';
    const workspaceId = generateId();
    const codeDir = this.getWorkspaceCodeDir(userId, workspaceId);

    // 1. 创建目录结构
    await this.initializeWorkspaceStructure(userId, workspaceId);

    // 2. 初始化本地项目目录
    const initResult = await this.gitService.initializeWorkspaceRepository(
      codeDir,
      branch,
    );
    if (!initResult.success) {
      throw new BadRequestException(initResult.error || '初始化项目失败');
    }

    // 3. 创建元数据（状态为 ACTIVE，预览环境按需手动启动）
    const now = new Date();
    const metadata: WorkspaceMetadataDto = {
      workspaceId,
      userId,
      projectId,
      branch,
      requirement,
      createdAt: now.toISOString(),
      lastAccessAt: now.toISOString(),
      status: WorkspaceStatus.ACTIVE,
    };

    await this.saveWorkspaceMetadata(userId, workspaceId, metadata);

    // 4. 保存到数据库（状态为 ACTIVE）
    const workspace = this.workspaceRepository.create({
      workspaceId,
      userId,
      projectId,
      branch,
      requirement,
      status: WorkspaceStatus.ACTIVE,
      createdAt: now,
      lastAccessAt: now,
    });

    await this.workspaceRepository.save(workspace);
    this.fileWatcherService.startWatching(workspaceId, codeDir);

    this.logger.log(
      `Workspace created: ${workspaceId} for user ${userId}, project ${projectId}`,
    );

    return {
      workspaceId,
      metadata,
      codeDir,
    };
  }

  /**
   * 初始化工作空间目录结构
   */
  private async initializeWorkspaceStructure(
    userId: string,
    workspaceId: string,
  ): Promise<void> {
    try {
      const dirs = [
        this.getWorkspaceDir(userId, workspaceId),
        this.getWorkspaceCodeDir(userId, workspaceId),
        this.pathResolver.getWorkspacePath(userId, workspaceId, 'devServer'),
        this.pathResolver.getWorkspacePath(userId, workspaceId, 'builds'),
        this.pathResolver.getWorkspacePath(userId, workspaceId, 'logs'),
        this.pathResolver.getWorkspacePath(userId, workspaceId, 'snapshots'),
      ];

      for (const dir of dirs) {
        await fs.ensureDir(dir);
      }

      this.logger.log(`Workspace structure initialized: ${workspaceId}`);
    } catch (error) {
      this.logger.error(
        `Failed to initialize workspace structure ${workspaceId}: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * 删除工作空间（软删除）
   */
  async deleteWorkspace(workspaceId: string): Promise<void> {
    // 1. 获取工作空间信息
    const workspace = await this.workspaceRepository.findOne({
      where: { workspaceId, isDeleted: false },
    });

    if (!workspace) {
      throw new NotFoundException(`Workspace not found: ${workspaceId}`);
    }

    // 2. 标记为已删除（软删除）
    await this.workspaceRepository.update(
      { workspaceId },
      { isDeleted: true, status: WorkspaceStatus.ARCHIVED },
    );

    // 3. 删除文件系统（可选：也可以延迟删除）
    const workspaceDir = this.getWorkspaceDir(workspace.userId, workspaceId);
    await fs.remove(workspaceDir);

    this.logger.log(`Workspace soft deleted: ${workspaceId}`);
  }

  /**
   * 物理删除工作空间（仅用于清理任务）
   */
  async hardDeleteWorkspace(workspaceId: string): Promise<void> {
    // 1. 获取工作空间信息
    const workspace = await this.workspaceRepository.findOne({
      where: { workspaceId },
    });

    if (!workspace) {
      throw new NotFoundException(`Workspace not found: ${workspaceId}`);
    }

    // 2. 删除文件系统
    const workspaceDir = this.getWorkspaceDir(workspace.userId, workspaceId);
    await fs.remove(workspaceDir);

    // 3. 物理删除数据库记录
    await this.workspaceRepository.delete({ workspaceId });

    this.logger.log(`Workspace hard deleted: ${workspaceId}`);
  }

  /**
   * 归档工作空间（删除代码文件，保留元数据）
   */
  async archiveWorkspace(workspaceId: string): Promise<void> {
    const workspace = await this.workspaceRepository.findOne({
      where: { workspaceId },
    });

    if (!workspace) {
      throw new NotFoundException(`Workspace not found: ${workspaceId}`);
    }

    // 1. 删除代码文件 (保留元数据)
    const codeDir = this.getWorkspaceCodeDir(workspace.userId, workspaceId);
    await fs.remove(codeDir);

    // 2. 更新状态
    await this.updateWorkspaceStatus(workspaceId, WorkspaceStatus.ARCHIVED);

    this.logger.log(`Workspace archived: ${workspaceId}`);
  }

  /**
   * 恢复工作空间
   */
  async restoreWorkspace(workspaceId: string): Promise<void> {
    const workspace = await this.workspaceRepository.findOne({
      where: { workspaceId },
    });

    if (!workspace) {
      throw new NotFoundException(`Workspace not found: ${workspaceId}`);
    }

    if (workspace.status !== WorkspaceStatus.ARCHIVED) {
      throw new Error(`Workspace is not archived: ${workspaceId}`);
    }

    // 重新初始化目录结构
    await this.initializeWorkspaceStructure(workspace.userId, workspaceId);

    // 更新状态
    await this.updateWorkspaceStatus(workspaceId, WorkspaceStatus.ACTIVE);

    this.logger.log(`Workspace restored: ${workspaceId}`);
  }

  // ==================== 状态管理 ====================

  /**
   * 获取工作空间状态
   */
  async getWorkspaceStatus(workspaceId: string): Promise<WorkspaceStatus> {
    const workspace = await this.workspaceRepository.findOne({
      where: { workspaceId },
      select: ['status'],
    });

    if (!workspace) {
      throw new NotFoundException(`Workspace not found: ${workspaceId}`);
    }

    return workspace.status;
  }

  /**
   * 更新工作空间状态
   */
  async updateWorkspaceStatus(
    workspaceId: string,
    status: WorkspaceStatus,
  ): Promise<void> {
    // 获取旧状态用于日志
    const workspace = await this.workspaceRepository.findOne({
      where: { workspaceId },
    });
    const oldStatus = workspace?.status;

    await this.workspaceRepository.update({ workspaceId }, { status });

    // 同时更新文件系统中的元数据
    if (workspace) {
      const metadataPath = this.getWorkspaceMetadataPath(
        workspace.userId,
        workspaceId,
      );
      if (await fs.pathExists(metadataPath)) {
        const metadata = await fs.readJSON(metadataPath);
        metadata.status = status;
        await fs.writeJSON(metadataPath, metadata, { spaces: 2 });
      }

      this.logger.log(
        `Workspace status updated: ${workspaceId} (${oldStatus} -> ${status})`,
      );

      // 根据状态变化管理文件监听
      const activeStatuses = [WorkspaceStatus.RUNNING, WorkspaceStatus.ACTIVE];
      const wasActive = oldStatus && activeStatuses.includes(oldStatus);
      const isActive = activeStatuses.includes(status);

      if (isActive && !wasActive) {
        // 工作空间变为活跃状态，启动文件监听
        const codeDir = this.getWorkspaceCodeDir(workspace.userId, workspaceId);
        if (await fs.pathExists(codeDir)) {
          this.fileWatcherService.startWatching(workspaceId, codeDir);
          this.logger.log(`Started file watching for workspace ${workspaceId}`);
        }
      } else if (!isActive && wasActive) {
        // 工作空间变为非活跃状态，停止文件监听
        await this.fileWatcherService.stopWatching(workspaceId);
        this.logger.log(`Stopped file watching for workspace ${workspaceId}`);
      }
    }
  }

  /**
   * 为重试创建新的任务
   * 创建新 taskId，更新工作空间状态为 CREATING
   */
  async createRetryTask(workspaceId: string): Promise<string> {
    const workspace = await this.workspaceRepository.findOne({
      where: { workspaceId, isDeleted: false },
    });

    if (!workspace) {
      throw new NotFoundException(`Workspace not found: ${workspaceId}`);
    }

    // 生成新的 taskId
    const taskId = generateId();

    // 创建异步任务记录
    await this.taskProgressService.createTask(taskId);

    // 更新工作空间状态和 taskId
    await this.workspaceRepository.update(
      { workspaceId },
      {
        taskId,
        status: WorkspaceStatus.CREATING,
      },
    );

    // 同时更新文件系统中的元数据
    const metadataPath = this.getWorkspaceMetadataPath(
      workspace.userId,
      workspaceId,
    );
    if (await fs.pathExists(metadataPath)) {
      const metadata = await fs.readJSON(metadataPath);
      metadata.taskId = taskId;
      metadata.status = WorkspaceStatus.CREATING;
      await fs.writeJSON(metadataPath, metadata, { spaces: 2 });
    }

    this.logger.log(
      `Retry task created for workspace ${workspaceId}: taskId=${taskId}`,
    );

    return taskId;
  }

  /**
   * 标记工作空间访问
   */
  async markWorkspaceAccess(workspaceId: string): Promise<void> {
    const now = new Date();

    await this.workspaceRepository.update(
      { workspaceId },
      { lastAccessAt: now },
    );

    // 如果是 IDLE 状态,恢复为 ACTIVE
    const status = await this.getWorkspaceStatus(workspaceId);
    if (status === WorkspaceStatus.IDLE) {
      await this.updateWorkspaceStatus(workspaceId, WorkspaceStatus.ACTIVE);
    }
  }

  // ==================== 权限检查 ====================

  /**
   * 检查用户是否是工作空间的创建者（owner）
   * @param workspaceId 工作空间 ID
   * @param userId 用户 ID
   * @returns 是否是创建者
   * @throws NotFoundException 如果工作空间不存在
   * @throws ForbiddenException 如果用户不是创建者
   */
  async checkWorkspaceOwnership(
    workspaceId: string,
    userId: string,
  ): Promise<void> {
    const workspace = await this.workspaceRepository.findOne({
      where: { workspaceId, isDeleted: false },
      select: ['userId', 'workspaceId'],
    });

    if (!workspace) {
      throw new NotFoundException(`Workspace ${workspaceId} not found`);
    }

    if (workspace.userId !== userId) {
      this.logger.warn(
        `Permission denied: User ${userId} attempted to access workspace ${workspaceId} owned by ${workspace.userId}`,
      );
      throw new BadRequestException(
        `You do not have permission to modify this workspace`,
      );
    }
  }

  // ==================== 查询 ====================

  /**
   * 列出用户的所有工作空间（不包括已删除）
   */
  async listUserWorkspaces(
    userId: string,
    projectId?: string,
  ): Promise<WorkspaceResponseDto[]> {
    // 如果指定了 projectId，返回该项目下的所有需求（不限制用户）
    // 如果没有指定 projectId，返回该用户的所有需求
    const workspaces = await this.workspaceRepository.find({
      where: projectId
        ? { projectId, isDeleted: false }
        : { userId, isDeleted: false },
      order: { lastAccessAt: 'DESC' },
    });

    return Promise.all(
      workspaces.map(async (ws) => ({
        workspaceId: ws.workspaceId,
        metadata: {
          workspaceId: ws.workspaceId,
          userId: ws.userId,
          projectId: ws.projectId,
          branch: ws.branch,
          requirement: ws.requirement,
          createdAt: ws.createdAt.toISOString(),
          lastAccessAt: ws.lastAccessAt.toISOString(),
          status: ws.status,
          taskId: ws.taskId,
        },
        codeDir: this.getWorkspaceCodeDir(ws.userId, ws.workspaceId),
      })),
    );
  }

  /**
   * 获取工作空间元数据（不包括已删除）
   */
  async getWorkspaceMetadata(
    workspaceId: string,
  ): Promise<WorkspaceMetadataDto> {
    const workspace = await this.workspaceRepository.findOne({
      where: { workspaceId, isDeleted: false },
    });

    if (!workspace) {
      throw new NotFoundException(`Workspace not found: ${workspaceId}`);
    }

    return {
      workspaceId: workspace.workspaceId,
      userId: workspace.userId,
      projectId: workspace.projectId,
      branch: workspace.branch,
      requirement: workspace.requirement,
      createdAt: workspace.createdAt.toISOString(),
      lastAccessAt: workspace.lastAccessAt.toISOString(),
      status: workspace.status,
      taskId: workspace.taskId,
    };
  }

  /**
   * 根据 workspaceId 查找工作空间（不包括已删除）
   * 返回 null 而不是抛异常
   */
  async findByWorkspaceId(workspaceId: string): Promise<Workspace | null> {
    return this.workspaceRepository.findOne({
      where: { workspaceId, isDeleted: false },
    });
  }

  /**
   * 根据 taskId 查找工作空间（不包括已删除）
   * 返回 null 而不是抛异常
   */
  async findByTaskId(taskId: string): Promise<Workspace | null> {
    return this.workspaceRepository.findOne({
      where: { taskId, isDeleted: false },
    });
  }

  /**
   * 验证工作空间是否存在（不包括已删除）
   */
  async validateWorkspace(workspaceId: string): Promise<boolean> {
    const workspace = await this.workspaceRepository.findOne({
      where: { workspaceId, isDeleted: false },
    });

    if (!workspace) {
      return false;
    }

    // 验证文件系统是否存在
    const workspaceDir = this.getWorkspaceDir(workspace.userId, workspaceId);
    return await fs.pathExists(workspaceDir);
  }

  /**
   * 查找已存在的工作空间（用于幂等性判断）
   * 根据 userId + projectId + branch + requirement 组合查找活跃的工作空间
   */
  async findExistingWorkspace(
    userId: string,
    projectId: string,
    branch: string,
    requirement?: string,
  ): Promise<Workspace | null> {
    return this.workspaceRepository.findOne({
      where: {
        userId,
        projectId,
        branch,
        requirement: requirement || '',
        isDeleted: false,
        // 只查找活跃或运行中的工作空间
        status: WorkspaceStatus.RUNNING,
      },
    });
  }

  /**
   * 校验工作空间是否属于指定用户
   * @param workspaceId 工作空间 ID
   * @param userId 用户 ID
   * @returns true 表示该工作空间属于该用户，false 表示不属于或工作空间不存在
   */
  async isWorkspaceOwnedByUser(
    workspaceId: string,
    userId: string,
  ): Promise<boolean> {
    const workspace = await this.workspaceRepository.findOne({
      where: { workspaceId, isDeleted: false },
    });

    if (!workspace) {
      return false;
    }

    return workspace.userId === userId;
  }

  // ==================== 元数据管理 ====================

  /**
   * 保存工作空间元数据到文件
   */
  private async saveWorkspaceMetadata(
    userId: string,
    workspaceId: string,
    metadata: WorkspaceMetadataDto,
  ): Promise<void> {
    try {
      const metadataPath = this.getWorkspaceMetadataPath(userId, workspaceId);
      await fs.writeJSON(metadataPath, metadata, { spaces: 2 });
    } catch (error) {
      this.logger.error(
        `Failed to save workspace metadata ${workspaceId}: ${error.message}`,
      );
      throw error;
    }
  }

  // ==================== 预览环境时间管理 ====================

  /**
   * 更新预览环境激活时间（心跳）
   * 只更新处于 RUNNING 状态的工作空间
   */
  async updatePreviewActivatedAt(
    workspaceId: string,
    activatedAt: Date = new Date(),
  ): Promise<void> {
    const result = await this.workspaceRepository.update(
      {
        workspaceId,
        status: WorkspaceStatus.RUNNING, // 只更新运行中的工作空间
        isDeleted: false,
      },
      { previewActivatedAt: activatedAt },
    );

    if (result.affected && result.affected > 0) {
      this.logger.log(
        `Preview activated time updated for workspace ${workspaceId}: ${activatedAt.toISOString()}`,
      );
    } else {
      this.logger.debug(
        `Skip heartbeat update for workspace ${workspaceId}: not in RUNNING state or not found`,
      );
    }
  }

  /**
   * 清除预览环境激活时间（容器停止时）
   */
  async clearPreviewActivatedAt(workspaceId: string): Promise<void> {
    await this.workspaceRepository.update(
      { workspaceId },
      { previewActivatedAt: null },
    );

    this.logger.log(
      `Preview activated time cleared for workspace ${workspaceId}`,
    );
  }

  // ==================== 文件操作 ====================

  /**
   * 获取工作空间的所有文件和文件夹
   * @param workspaceId 工作空间 ID
   * @returns 文件列表
   */
  async getWorkspaceFiles(
    workspaceId: string,
  ): Promise<Array<{ path: string; type: 'file' | 'folder' }>> {
    const workspace = await this.getWorkspaceMetadata(workspaceId);
    const codeDir = this.getWorkspaceCodeDir(workspace.userId, workspaceId);

    // 检查代码目录是否存在
    if (!(await fs.pathExists(codeDir))) {
      this.logger.warn(
        `Code directory not found for workspace ${workspaceId}: ${codeDir}`,
      );
      return [];
    }

    // 递归扫描目录
    const files = await this.scanDirectory(codeDir, codeDir);
    this.logger.log(
      `Found ${files.length} files in workspace ${workspaceId}`,
    );
    return files;
  }

  /**
   * 获取文件内容
   * @param workspaceId 工作空间 ID
   * @param filePath 相对路径（如 src/App.vue）
   * @returns 文件内容
   */
  async getFileContent(
    workspaceId: string,
    filePath: string,
  ): Promise<string> {
    const workspace = await this.getWorkspaceMetadata(workspaceId);
    const codeDir = this.getWorkspaceCodeDir(workspace.userId, workspaceId);
    const fullPath = path.resolve(path.join(codeDir, filePath));

    // 安全检查：防止路径穿越攻击
    if (!fullPath.startsWith(codeDir)) {
      this.logger.error(
        `Path traversal attack detected: ${filePath} -> ${fullPath}`,
      );
      throw new BadRequestException('Invalid file path');
    }

    // 检查文件是否存在
    if (!(await fs.pathExists(fullPath))) {
      throw new NotFoundException(`File not found: ${filePath}`);
    }

    this.logger.log(`Reading file: ${fullPath}`);
    return await this.fileService.readFile(fullPath);
  }

  /**
   * 更新文件内容
   * @param workspaceId 工作空间 ID
   * @param filePath 相对路径
   * @param content 文件内容
   */
  async updateFileContent(
    workspaceId: string,
    filePath: string,
    content: string,
  ): Promise<void> {
    const workspace = await this.getWorkspaceMetadata(workspaceId);
    const codeDir = this.getWorkspaceCodeDir(workspace.userId, workspaceId);
    const fullPath = path.resolve(path.join(codeDir, filePath));

    // 安全检查：防止路径穿越攻击
    if (!fullPath.startsWith(codeDir)) {
      this.logger.error(
        `Path traversal attack detected: ${filePath} -> ${fullPath}`,
      );
      throw new BadRequestException('Invalid file path');
    }

    this.logger.log(`Writing file: ${fullPath}`);
    await this.fileService.writeFile(fullPath, content);
  }

  /**
   * 递归扫描目录（私有方法）
   * @param dir 当前目录
   * @param baseDir 基础目录（用于计算相对路径）
   * @returns 文件列表
   */
  private async scanDirectory(
    dir: string,
    baseDir: string,
  ): Promise<Array<{ path: string; type: 'file' | 'folder' }>> {
    const results: Array<{ path: string; type: 'file' | 'folder' }> = [];

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        // 跳过隐藏文件、node_modules 等
        if (
          entry.name.startsWith('.') ||
          entry.name === 'node_modules' ||
          entry.name === 'dist' ||
          entry.name === 'build'
        ) {
          continue;
        }

        const fullPath = path.join(dir, entry.name);
        const relativePath = path.relative(baseDir, fullPath);

        if (entry.isDirectory()) {
          results.push({ path: relativePath, type: 'folder' });
          // 递归扫描子目录
          const subFiles = await this.scanDirectory(fullPath, baseDir);
          results.push(...subFiles);
        } else if (entry.isFile()) {
          results.push({ path: relativePath, type: 'file' });
        }
      }
    } catch (error) {
      this.logger.error(`Failed to scan directory ${dir}: ${error.message}`);
    }

    return results;
  }
}
