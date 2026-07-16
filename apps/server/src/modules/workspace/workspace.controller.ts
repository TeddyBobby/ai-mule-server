import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { WorkspaceService } from './workspace.service';
import { CreateWorkspaceDto } from './dto/create-workspace.dto';
import { WorkspaceResponseDto } from './dto/workspace-response.dto';
import { AuthGuard, User } from '../../common/guards/auth.guard';
import { PreviewEnvironmentService } from '../preview-environment/preview-environment.service';
import { GitService } from '../git/git.service';

interface AuthenticatedRequest {
  user: User;
}

@ApiTags('工作空间管理')
@Controller('workspaces')
@UseGuards(AuthGuard)
@ApiBearerAuth()
export class WorkspaceController {
  constructor(
    private readonly workspaceService: WorkspaceService,
    private readonly previewEnvironmentService: PreviewEnvironmentService,
    private readonly gitService: GitService,
  ) {}

  @Post()
  @ApiOperation({
    summary: '创建工作空间',
    description: '创建一个新的本地项目工作空间，并初始化空仓库',
  })
  @ApiResponse({
    status: 201,
    description: '工作空间创建成功',
    type: WorkspaceResponseDto,
  })
  async createWorkspace(
    @Request() req: AuthenticatedRequest,
    @Body() createDto: CreateWorkspaceDto,
  ): Promise<WorkspaceResponseDto> {
    const userId = req.user.username;

    return this.workspaceService.createWorkspace(userId, createDto);
  }

  @Get()
  @ApiOperation({ summary: '获取用户的所有工作空间' })
  @ApiQuery({ name: 'projectId', required: false, description: '按项目ID过滤' })
  @ApiResponse({
    status: 200,
    description: '工作空间列表',
    type: [WorkspaceResponseDto],
  })
  async listWorkspaces(
    @Request() req: AuthenticatedRequest,
    @Query('projectId') projectId?: string,
  ): Promise<WorkspaceResponseDto[]> {
    const userId = req.user.username;
    return this.workspaceService.listUserWorkspaces(userId, projectId);
  }

  @Get(':id')
  @ApiOperation({ summary: '获取工作空间详情' })
  @ApiResponse({
    status: 200,
    description: '工作空间详情',
  })
  async getWorkspace(@Param('id') id: string) {
    return this.workspaceService.getWorkspaceMetadata(id);
  }

  @Delete(':id')
  @ApiOperation({ summary: '删除工作空间' })
  @ApiResponse({
    status: 200,
    description: '工作空间删除成功',
  })
  async deleteWorkspace(
    @Request() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<{ message: string }> {
    const userId = req.user.username;

    // 检查用户权限
    await this.workspaceService.checkWorkspaceOwnership(id, userId);

    await this.workspaceService.deleteWorkspace(id);
    return { message: 'Workspace deleted successfully' };
  }

  @Post(':id/archive')
  @ApiOperation({ summary: '归档工作空间' })
  @ApiResponse({
    status: 200,
    description: '工作空间归档成功',
  })
  async archiveWorkspace(
    @Request() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<{ message: string }> {
    const userId = req.user.username;

    // 检查用户权限
    await this.workspaceService.checkWorkspaceOwnership(id, userId);

    await this.workspaceService.archiveWorkspace(id);
    return { message: 'Workspace archived successfully' };
  }

  @Post(':id/restore')
  @ApiOperation({ summary: '恢复工作空间' })
  @ApiResponse({
    status: 200,
    description: '工作空间恢复成功',
  })
  async restoreWorkspace(
    @Request() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<{ message: string }> {
    const userId = req.user.username;

    // 检查用户权限
    await this.workspaceService.checkWorkspaceOwnership(id, userId);

    await this.workspaceService.restoreWorkspace(id);
    return { message: 'Workspace restored successfully' };
  }

  @Post(':id/access')
  @ApiOperation({ summary: '标记工作空间访问' })
  @ApiResponse({
    status: 200,
    description: '访问标记成功',
  })
  async markAccess(@Param('id') id: string): Promise<{ message: string }> {
    await this.workspaceService.markWorkspaceAccess(id);
    return { message: 'Access marked successfully' };
  }

  @Post(':id/retry')
  @ApiOperation({
    summary: '重试创建预览环境（异步）',
    description: '重新创建预览环境，返回新的 taskId 用于查询进度',
  })
  @ApiResponse({
    status: 200,
    description: '重试任务已启动，返回 taskId 用于查询进度',
  })
  async retryPreviewEnvironment(
    @Request() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<{ taskId: string; workspaceId: string }> {
    const userId = req.user.username;

    // 1. 为重试创建新的 taskId
    const taskId = await this.workspaceService.createRetryTask(id);

    // 2. 获取工作空间信息
    const workspace = await this.workspaceService.getWorkspaceMetadata(id);

    // 3. 异步启动预览环境创建（不等待完成）
    this.previewEnvironmentService
      .executeCreateWithProgress(taskId, id, {
        userId,
        projectId: workspace.projectId,
        branch: workspace.branch,
        requirement: workspace.requirement,
      })
      .catch((error) => {
        console.error(
          `[WorkspaceController] Retry preview creation failed: ${error.message}`,
        );
      });

    return { taskId, workspaceId: id };
  }

  @Get(':id/validate')
  @ApiOperation({ summary: '验证工作空间是否存在' })
  @ApiResponse({
    status: 200,
    description: '验证结果',
  })
  async validateWorkspace(
    @Param('id') id: string,
  ): Promise<{ valid: boolean }> {
    const valid = await this.workspaceService.validateWorkspace(id);
    return { valid };
  }

  @Post(':id/commit')
  @ApiOperation({
    summary: '使用 AI 生成 commit message 并提交代码',
    description:
      '自动获取代码更改，由 AI 分析并生成符合规范的 commit message，然后提交代码。Commit message 格式：AI生成的内容（代码提交者：userId）',
  })
  @ApiQuery({
    name: 'push',
    required: false,
    type: Boolean,
    description: '是否推送到远程仓库（默认 false）',
  })
  @ApiResponse({
    status: 200,
    description: 'Commit 执行结果',
  })
  async commitCode(
    @Request() req: AuthenticatedRequest,
    @Param('id') workspaceId: string,
    @Query('push') push?: string,
  ): Promise<{
    success: boolean;
    commitHash?: string;
    message?: string;
    error?: string;
  }> {
    const userId = req.user.username;

    // 检查用户权限
    await this.workspaceService.checkWorkspaceOwnership(workspaceId, userId);

    // 获取工作空间代码目录
    const workspaceDir = this.workspaceService.getWorkspaceCodeDir(
      userId,
      workspaceId,
    );

    // 调用 GitService 进行 AI commit
    const result = await this.gitService.commitWithAI({
      workspaceDir,
      userId,
      push: push === 'true',
    });

    return result;
  }

  @Get(':id/branches')
  @ApiOperation({
    summary: '获取工作空间的所有分支列表',
    description: '获取工作空间 Git 仓库的所有分支（本地 + 远程），会先 fetch 最新的远程分支信息',
  })
  @ApiResponse({
    status: 200,
    description: '分支列表',
  })
  async getBranches(
    @Request() req: AuthenticatedRequest,
    @Param('id') workspaceId: string,
  ): Promise<{
    branches: Array<{ name: string; current: boolean; remote: boolean }>;
  }> {
    const userId = req.user.username;

    // 检查用户权限
    await this.workspaceService.checkWorkspaceOwnership(workspaceId, userId);

    // 获取工作空间代码目录
    const workspaceDir = this.workspaceService.getWorkspaceCodeDir(
      userId,
      workspaceId,
    );

    // 调用 GitService 获取分支列表
    const branches = await this.gitService.getBranches(workspaceDir, userId);

    return { branches };
  }

  @Post(':id/merge-request')
  @ApiOperation({
    summary: '创建 Merge Request',
    description:
      '使用 AI 自动生成 MR 的 title 和 description，然后创建 Merge Request',
  })
  @ApiResponse({
    status: 200,
    description: 'MR 创建结果',
  })
  async createMergeRequest(
    @Request() req: AuthenticatedRequest,
    @Param('id') workspaceId: string,
    @Body() body: { targetBranch: string },
  ): Promise<{
    success: boolean;
    sourceBranch?: string;
    targetBranch?: string;
    title?: string;
    description?: string;
    mrUrl?: string;
    message?: string;
    error?: string;
  }> {
    const userId = req.user.username;
    const { targetBranch } = body;

    // 检查用户权限
    await this.workspaceService.checkWorkspaceOwnership(workspaceId, userId);

    // 获取工作空间代码目录
    const workspaceDir = this.workspaceService.getWorkspaceCodeDir(
      userId,
      workspaceId,
    );

    // 获取当前分支作为源分支
    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);
    const { stdout: sourceBranch } = await execAsync(
      'git rev-parse --abbrev-ref HEAD',
      { cwd: workspaceDir },
    );

    const currentBranch = sourceBranch.trim();

    // 1. 检查是否有未提交的代码
    const { stdout: statusOutput } = await execAsync('git status --porcelain', {
      cwd: workspaceDir,
    });

    if (statusOutput.trim()) {
      return {
        success: false,
        error: '存在未提交的代码更改，请先提交代码后再创建 MR',
      };
    }

    // 2. 使用 AI 生成 MR 标题
    const title = await this.gitService.generateMRTitle(
      workspaceDir,
      currentBranch,
      targetBranch,
    );

    // 3. 清理特殊字符和 Markdown 格式（git push -o 不支持换行，MR title 也不需要格式）
    const cleanText = (text: string): string => {
      return text
        .replace(/[\r\n]+/g, ' ')  // 换行替换为空格
        .replace(/\t+/g, ' ')       // 制表符替换为空格
        .replace(/\*\*/g, '')       // 移除 Markdown 加粗符号 **
        .replace(/\*/g, '')         // 移除 Markdown 斜体符号 *
        .replace(/^#+\s*/g, '')     // 移除 Markdown 标题符号 #
        .replace(/^[-*]\s+/gm, '')  // 移除 Markdown 列表符号 - 或 *
        .replace(/\s+/g, ' ')       // 多个空格压缩为一个
        .trim();                     // 去除首尾空格
    };

    const cleanedTitle = cleanText(title);

    // 4. 创建 MR（描述末尾加上创建者信息）
    const description = `（创建者：${userId}）`;

    const result = await this.gitService.createMergeRequest({
      workspaceDir,
      sourceBranch: currentBranch,
      targetBranch,
      title: cleanedTitle,
      description,
      userId,
    });

    return result;
  }

  @Get(':id/files')
  @ApiOperation({ summary: '获取工作空间文件列表' })
  @ApiResponse({
    status: 200,
    description: '文件列表',
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string', example: 'src/App.vue' },
          type: { type: 'string', enum: ['file', 'folder'] },
        },
      },
    },
  })
  async getWorkspaceFiles(
    @Param('id') id: string,
  ): Promise<Array<{ path: string; type: 'file' | 'folder' }>> {
    return this.workspaceService.getWorkspaceFiles(id);
  }

  @Get(':id/file')
  @ApiOperation({ summary: '获取文件内容' })
  @ApiQuery({
    name: 'path',
    required: true,
    description: '文件相对路径（如 src/App.vue）',
    example: 'src/App.vue',
  })
  @ApiResponse({
    status: 200,
    description: '文件内容',
    schema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '文件内容' },
      },
    },
  })
  async getFileContent(
    @Param('id') id: string,
    @Query('path') filePath: string,
  ): Promise<{ content: string }> {
    const content = await this.workspaceService.getFileContent(id, filePath);
    return { content };
  }

  @Post(':id/file')
  @ApiOperation({ summary: '保存文件内容' })
  @ApiResponse({
    status: 200,
    description: '保存成功',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
      },
    },
  })
  async updateFileContent(
    @Request() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: { path: string; content: string },
  ): Promise<{ success: boolean }> {
    const userId = req.user.username;

    // 检查用户权限
    await this.workspaceService.checkWorkspaceOwnership(id, userId);

    await this.workspaceService.updateFileContent(id, body.path, body.content);
    return { success: true };
  }
}
