import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs-extra';
import * as path from 'path';
import { Project } from '../project/entities/project.entity';
import { PathResolverService } from '../../common/services/path-resolver.service';
import { IdentityService } from '../identity/identity.service';
import { GitErrorParser } from '../../common/utils/git-error-parser';
import { query } from '@anthropic-ai/claude-agent-sdk';

const execAsync = promisify(exec);
const shared_git_name = 'bone';
const shared_git_email = 'ai-mule@local.dev';

/**
 * Git 克隆选项
 */
export interface CloneOptions {
  userId: string;
  targetDir: string;
  branch?: string;
  useReference?: boolean;
}

/**
 * Git 克隆结果
 */
export interface CloneResult {
  success: boolean;
  targetDir: string;
  branch: string;
  error?: string;
  skipped?: boolean; // 如果目录已存在且是有效的 git 仓库，则跳过克隆
  initialized?: boolean; // 是否初始化了本地仓库
}

/**
 * Git 提交选项
 */
export interface CommitOptions {
  workspaceDir: string;
  message: string;
  push?: boolean; // 是否推送到远程
  userId?: string; // 用于 SSH 认证
}

/**
 * Git 提交结果
 */
export interface CommitResult {
  success: boolean;
  commitHash?: string;
  message?: string;
  error?: string;
}

/**
 * Git 分支信息
 */
export interface BranchInfo {
  name: string;
  current: boolean;
  remote: boolean;
}

/**
 * 创建 MR 选项
 */
export interface CreateMROptions {
  workspaceDir: string;
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description?: string;
  userId: string;
}

/**
 * Git 仓库管理服务
 *
 * 职责:
 * - Git 仓库克隆操作
 * - 基础仓库管理 (项目级共享)
 * - Git 引用优化 (--reference)
 * - Git 错误处理和解析
 */
@Injectable()
export class GitService {
  private readonly logger = new Logger(GitService.name);
  private readonly lastFetchMap = new Map<string, number>(); // 防抖: projectId -> lastFetchTime
  private readonly localGitUserName = 'AI Mule Local';
  private readonly localGitUserEmail = 'local-dev@example.com';

  constructor(
    @InjectRepository(Project)
    private readonly projectRepository: Repository<Project>,
    private readonly pathResolver: PathResolverService,
    private readonly identityService: IdentityService,
  ) {}

  /**
   * 获取或初始化项目基础仓库
   */
  async getOrInitializeBaseRepo(projectId: string): Promise<string> {
    const project = await this.projectRepository.findOne({
      where: { projectId, isDeleted: false },
    });

    if (!project) {
      throw new NotFoundException(`Project not found: ${projectId}`);
    }

    const baseRepoDir = this.pathResolver.getProjectPath(projectId, 'baseRepo');

    // 检查基础仓库是否已存在
    // 注意: bare 仓库没有 .git 子目录,直接检查 HEAD 文件
    const isExisting = await fs.pathExists(path.join(baseRepoDir, 'HEAD'));

    if (isExisting) {
      // 检查是否需要 fetch (防抖: 5分钟内不重复 fetch)
      const lastFetch = this.lastFetchMap.get(projectId) || 0;
      const now = Date.now();

      if (now - lastFetch > 5 * 60 * 1000) {
        await this.updateBaseRepo(projectId, baseRepoDir);
        this.lastFetchMap.set(projectId, now);
      }

      return baseRepoDir;
    }

    // 初始化基础仓库
    await this.cloneBaseRepo(projectId, project.gitUrl, baseRepoDir);
    this.lastFetchMap.set(projectId, Date.now());

    return baseRepoDir;
  }

  /**
   * 克隆基础仓库 (项目级共享)
   */
  private async cloneBaseRepo(
    projectId: string,
    gitUrl: string,
    targetDir: string,
  ): Promise<void> {
    await fs.ensureDir(targetDir);

    try {
      // 使用 bare clone (不包含工作目录,仅作为引用)
      await execAsync(`git clone --bare "${gitUrl}" "${targetDir}"`, {
        timeout: 5 * 60 * 1000, // 5 分钟超时
      });

      this.logger.log(`Base repo cloned for project: ${projectId}`);
    } catch (error) {
      this.logger.error(
        `Failed to clone base repo for project ${projectId}: ${error.message}`,
      );
      // 清理失败的克隆
      await fs.remove(targetDir);
      throw new BadRequestException(
        `Failed to clone repository: ${error.message}`,
      );
    }
  }

  /**
   * 更新基础仓库 (fetch)
   */
  private async updateBaseRepo(
    projectId: string,
    baseRepoDir: string,
  ): Promise<void> {
    try {
      await execAsync('git fetch --all', {
        cwd: baseRepoDir,
        timeout: 2 * 60 * 1000, // 2 分钟超时
      });

      this.logger.log(`Base repo updated for project: ${projectId}`);
    } catch (error) {
      this.logger.warn(
        `Failed to update base repo for project ${projectId}: ${error.message}`,
      );
      // 不抛出异常,允许继续使用旧版本
    }
  }

  /**
   * 检查远程分支是否存在
   */
  async checkBranchExists(
    gitUrl: string,
    branch: string,
    sshKeyPath: string,
  ): Promise<boolean> {
    try {
      const env = {
        ...process.env,
        GIT_SSH_COMMAND: `ssh -i ${sshKeyPath} -o StrictHostKeyChecking=yes`,
      };

      // 使用 git ls-remote 检查分支
      const { stdout } = await execAsync(
        `git ls-remote --heads "${gitUrl}" "${branch}"`,
        {
          env,
          timeout: 30 * 1000, // 30 秒超时
        },
      );

      return !!stdout.trim();
    } catch (error) {
      this.logger.warn(`Failed to check branch existence: ${error.message}`);
      // 检查失败时不阻止克隆，让 git clone 自己报错
      return true;
    }
  }

  /**
   * 初始化工作空间代码目录
   *
   * 当前产品流程统一改为创建本地项目，不再从远程仓库拉取代码。
   */
  async initializeWorkspaceRepository(
    targetDir: string,
    branch?: string,
  ): Promise<CloneResult> {
    return this.initializeLocalRepository(targetDir, branch);
  }

  /**
   * 初始化项目到工作空间
   *
   * 为兼容现有调用方，保留原方法名，但内部统一走本地仓库初始化。
   */
  async cloneToWorkspace(
    projectId: string,
    options: CloneOptions,
  ): Promise<CloneResult> {
    const { targetDir, branch } = options;

    // 1. 获取项目信息
    const project = await this.projectRepository.findOne({
      where: { projectId, isDeleted: false },
    });

    if (!project) {
      throw new NotFoundException(`Project not found: ${projectId}`);
    }

    this.logger.log(
      `Creating local workspace project for ${projectId}: ${project.name} -> ${targetDir}`,
    );

    return this.initializeWorkspaceRepository(targetDir, branch);
  }

  private async getCurrentBranch(repoDir: string): Promise<string> {
    const { stdout } = await execAsync('git rev-parse --abbrev-ref HEAD', {
      cwd: repoDir,
    });

    return stdout.trim();
  }

  private async checkoutOrCreateBranch(
    repoDir: string,
    branch: string,
  ): Promise<void> {
    const currentBranch = await this.getCurrentBranch(repoDir);
    if (currentBranch === branch) {
      return;
    }

    try {
      await execAsync(`git checkout "${branch}"`, { cwd: repoDir });
    } catch {
      await execAsync(`git checkout -b "${branch}"`, { cwd: repoDir });
    }
  }

  private async initializeLocalRepository(
    targetDir: string,
    branch?: string,
  ): Promise<CloneResult> {
    const initialBranch = 'main';
    const targetBranch = branch?.trim() || initialBranch;

    if (await fs.pathExists(targetDir)) {
      const gitDir = path.join(targetDir, '.git');
      if (await fs.pathExists(gitDir)) {
        await this.checkoutOrCreateBranch(targetDir, targetBranch);
        return {
          success: true,
          targetDir,
          branch: targetBranch,
          skipped: true,
        };
      }

      await fs.remove(targetDir);
    }

    await fs.ensureDir(targetDir);

    try {
      await execAsync(`git init -b "${initialBranch}" "${targetDir}"`);

      const gitEnv = {
        ...process.env,
        GIT_AUTHOR_NAME: this.localGitUserName,
        GIT_AUTHOR_EMAIL: this.localGitUserEmail,
        GIT_COMMITTER_NAME: this.localGitUserName,
        GIT_COMMITTER_EMAIL: this.localGitUserEmail,
      };

      const readmeContent = `# Local Workspace\n\nThis repository was initialized by AI Mule for local development.\n`;
      const gitignoreContent = `node_modules/\ndist/\n.env\n.DS_Store\n`;

      await fs.writeFile(path.join(targetDir, 'README.md'), readmeContent);
      await fs.writeFile(path.join(targetDir, '.gitignore'), gitignoreContent);

      await execAsync('git add README.md .gitignore', { cwd: targetDir });
      await execAsync('git commit -m "chore: initialize local workspace"', {
        cwd: targetDir,
        env: gitEnv,
      });

      if (targetBranch !== initialBranch) {
        await execAsync(`git checkout -b "${targetBranch}"`, { cwd: targetDir });
      }

      return {
        success: true,
        targetDir,
        branch: targetBranch,
        initialized: true,
      };
    } catch (error) {
      await fs.remove(targetDir).catch(() => {});
      return {
        success: false,
        targetDir,
        branch: targetBranch,
        error:
          error instanceof Error ? error.message : '初始化本地仓库失败',
      };
    }
  }

  /**
   * 提交代码到 Git 仓库
   */
  async commitCode(options: CommitOptions): Promise<CommitResult> {
    const { workspaceDir, message, push = true, userId } = options;
    this.logger.log(`options: ${options}`);
    // 检查工作目录是否存在
    if (!(await fs.pathExists(workspaceDir))) {
      return {
        success: false,
        error: `Workspace directory not found: ${workspaceDir}`,
      };
    }

    try {
      // 1. 获取用户 Git 身份信息
      let gitEnv = process.env;
      if (userId) {
        try {
          const identity = await this.identityService.getIdentity(userId);
          gitEnv = {
            ...process.env,
            GIT_AUTHOR_NAME: identity.userName,
            GIT_AUTHOR_EMAIL: identity.userEmail,
            GIT_COMMITTER_NAME: identity.userName,
            GIT_COMMITTER_EMAIL: identity.userEmail,
          };
        } catch (error) {
          this.logger.warn(`Failed to get personal Git identity for user ${userId}: ${error.message}`);
          // 回退到使用 userId 作为提交者信息
          gitEnv = {
            ...process.env,
            GIT_AUTHOR_NAME: shared_git_name,
            GIT_AUTHOR_EMAIL: shared_git_email,
            GIT_COMMITTER_NAME: shared_git_name,
            GIT_COMMITTER_EMAIL: shared_git_email,
          };
          this.logger.log(`Using fallback Git identity: ${shared_git_email}`);
        }
      }

      // 2. 检查是否有待提交的更改
      const { stdout: statusOutput } = await execAsync('git status --porcelain', {
        cwd: workspaceDir,
      });

      if (!statusOutput.trim()) {
        this.logger.log('No changes to commit');
        return {
          success: true,
          message: 'No changes to commit',
        };
      }

      // 3. 添加所有更改到暂存区
      await execAsync('git add .', {
        cwd: workspaceDir,
        timeout: 30 * 1000, // 30秒超时
      });

      // 4. 提交代码（使用 Git 身份环境变量）
      await execAsync(`git commit -m "${message.replace(/"/g, '\\"')}"`, {
        cwd: workspaceDir,
        env: gitEnv,
        timeout: 30 * 1000,
      });

      // 5. 获取提交 hash
      const { stdout: commitHash } = await execAsync('git rev-parse HEAD', {
        cwd: workspaceDir,
      });

      this.logger.log(`Code committed: ${commitHash.trim()}`);

      // 6. 推送到远程（如果需要）
      if (push && userId) {
        const { stdout: remoteOutput } = await execAsync(
          'git remote get-url origin',
          { cwd: workspaceDir },
        ).catch(() => ({ stdout: '' }));

        if (!remoteOutput.trim()) {
          this.logger.log('No remote origin configured, skipping push');
          return {
            success: true,
            commitHash: commitHash.trim(),
            message: 'Code committed locally',
          };
        }

        const sshKeyPath = await this.identityService.getUserSshKeyPath(userId);
        const env = {
          ...process.env,
          GIT_SSH_COMMAND: `ssh -i ${sshKeyPath} -o StrictHostKeyChecking=yes`,
        };

        // 获取当前分支
        const { stdout: currentBranch } = await execAsync(
          'git rev-parse --abbrev-ref HEAD',
          { cwd: workspaceDir },
        );

        const branch = currentBranch.trim();

        // 推送代码
        await execAsync(`git push origin "${branch}"`, {
          cwd: workspaceDir,
          env,
          timeout: 2 * 60 * 1000, // 2分钟超时
        });

        this.logger.log(`Code pushed to remote: ${branch}`);
      }

      return {
        success: true,
        commitHash: commitHash.trim(),
        message: 'Code committed successfully',
      };
    } catch (error) {
      this.logger.error(`Failed to commit code: ${error.message}`);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * 获取所有分支列表
   */
  async getBranches(
    workspaceDir: string,
    userId: string,
  ): Promise<BranchInfo[]> {
    try {
      // 先获取用户 SSH Key 路径
      const sshKeyPath = await this.identityService.getUserSshKeyPath(userId);
      const env = {
        ...process.env,
        GIT_SSH_COMMAND: `ssh -i ${sshKeyPath} -o StrictHostKeyChecking=yes`,
      };

      // 先 fetch 最新的远程分支信息
      await execAsync('git fetch origin', {
        cwd: workspaceDir,
        env,
        timeout: 60 * 1000, // 60秒超时
      });

      // 获取所有分支（本地 + 远程）
      const { stdout } = await execAsync('git branch -a', {
        cwd: workspaceDir,
        timeout: 30 * 1000,
      });

      const branches: BranchInfo[] = [];
      const lines = stdout.split('\n').filter((line) => line.trim());

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // 跳过 HEAD 引用
        if (trimmed.includes('HEAD ->')) continue;

        // 判断是否为当前分支（以 * 开头）
        const current = trimmed.startsWith('*');
        // 移除 * 标记
        let branchName = trimmed.replace(/^\*\s+/, '');

        // 判断是否为远程分支
        const isRemote = branchName.startsWith('remotes/');
        if (isRemote) {
          // 移除 remotes/origin/ 前缀
          branchName = branchName.replace(/^remotes\/origin\//, '');
        }

        // 避免重复添加（本地和远程同名分支）
        const exists = branches.some(
          (b) => b.name === branchName && b.remote === isRemote,
        );
        if (!exists) {
          branches.push({
            name: branchName,
            current,
            remote: isRemote,
          });
        }
      }

      // 识别项目的主分支（默认分支）
      let mainBranchName = '';
      try {
        // 尝试获取远程的默认分支（HEAD 指向的分支）
        const { stdout: headRef } = await execAsync(
          'git symbolic-ref refs/remotes/origin/HEAD',
          {
            cwd: workspaceDir,
            timeout: 10 * 1000,
          },
        );
        // 输出格式：refs/remotes/origin/master
        mainBranchName = headRef.trim().replace('refs/remotes/origin/', '');
        this.logger.log(`Detected main branch: ${mainBranchName}`);
      } catch (error) {
        // 如果获取失败，尝试常见的主分支名
        const commonMainBranches = ['master', 'main'];
        mainBranchName = branches.find((b) =>
          commonMainBranches.includes(b.name),
        )?.name || '';
        this.logger.warn(
          `Failed to detect main branch via HEAD, using fallback: ${mainBranchName}`,
        );
      }

      // 将主分支排到最前面
      if (mainBranchName) {
        branches.sort((a, b) => {
          const isAMain = a.name === mainBranchName;
          const isBMain = b.name === mainBranchName;

          // 如果 a 是主分支，排在前面
          if (isAMain && !isBMain) return -1;
          // 如果 b 是主分支，排在前面
          if (!isAMain && isBMain) return 1;
          // 都是主分支或都不是，保持原顺序
          return 0;
        });
      }

      return branches;
    } catch (error) {
      this.logger.error(`Failed to get branches: ${error.message}`);
      throw new BadRequestException(`Failed to get branches: ${error.message}`);
    }
  }

  /**
   * 确保分支已推送到远程
   * 如果分支不存在于远程，会先推送一次
   */
  async ensureBranchOnRemote(
    workspaceDir: string,
    branch: string,
    userId: string,
  ): Promise<{ success: boolean; message?: string; error?: string }> {
    try {
      // 1. 获取用户 Git 身份信息
      let gitEnv = process.env;
      try {
        const identity = await this.identityService.getIdentity(userId);
        gitEnv = {
          ...process.env,
          GIT_AUTHOR_NAME: identity.userName,
          GIT_AUTHOR_EMAIL: identity.userEmail,
          GIT_COMMITTER_NAME: identity.userName,
          GIT_COMMITTER_EMAIL: identity.userEmail,
        };
      } catch (error) {
        this.logger.warn(`Failed to get personal Git identity for user ${userId}: ${error.message}`);
        // 回退到使用共享账户
        gitEnv = {
          ...process.env,
          GIT_AUTHOR_NAME: shared_git_name,
          GIT_AUTHOR_EMAIL: shared_git_email,
          GIT_COMMITTER_NAME: shared_git_name,
          GIT_COMMITTER_EMAIL: shared_git_email,
        };
        this.logger.log(`Using fallback Git identity: ${shared_git_email}`);
      }

      // 2. 获取 SSH Key 并添加到环境变量
      const sshKeyPath = await this.identityService.getUserSshKeyPath(userId);
      const env = {
        ...gitEnv,
        GIT_SSH_COMMAND: `ssh -i ${sshKeyPath} -o StrictHostKeyChecking=yes`,
      };

      // 3. 先 fetch 最新的远程分支信息
      await execAsync('git fetch origin', {
        cwd: workspaceDir,
        env,
        timeout: 60 * 1000,
      });

      // 4. 检查分支是否存在于远程
      const { stdout: remoteBranches } = await execAsync('git branch -r', {
        cwd: workspaceDir,
        timeout: 30 * 1000,
      });

      const branchExists = remoteBranches
        .split('\n')
        .some((line) => line.trim() === `origin/${branch}`);

      // 5. 如果分支不存在于远程，先推送一次
      if (!branchExists) {
        this.logger.log(`Branch "${branch}" not found on remote, pushing first...`);

        await execAsync(`git push origin "${branch}"`, {
          cwd: workspaceDir,
          env,
          timeout: 2 * 60 * 1000,
        });

        this.logger.log(`Branch pushed to remote successfully: ${branch}`);
        return {
          success: true,
          message: `Branch "${branch}" pushed to remote successfully`,
        };
      } else {
        this.logger.log(`Branch already exists on remote: ${branch}`);
        return {
          success: true,
          message: `Branch "${branch}" already exists on remote`,
        };
      }
    } catch (error) {
      this.logger.error(`Failed to ensure branch on remote: ${error.message}`);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * 创建 Merge Request (支持 GitLab)
   */
  async createMergeRequest(options: CreateMROptions): Promise<any> {
    const {
      workspaceDir,
      sourceBranch,
      targetBranch,
      title,
      description = '',
      userId,
    } = options;

    try {
      // 1. 获取用户 Git 身份信息
      let gitEnv = process.env;
      try {
        const identity = await this.identityService.getIdentity(userId);
        gitEnv = {
          ...process.env,
          GIT_AUTHOR_NAME: identity.userName,
          GIT_AUTHOR_EMAIL: identity.userEmail,
          GIT_COMMITTER_NAME: identity.userName,
          GIT_COMMITTER_EMAIL: identity.userEmail,
        };
      } catch (error) {
        this.logger.warn(`Failed to get personal Git identity for user ${userId}: ${error.message}`);
        // 回退到使用 userId 作为提交者信息
        gitEnv = {
          ...process.env,
          GIT_AUTHOR_NAME: shared_git_name,
          GIT_AUTHOR_EMAIL: shared_git_email,
          GIT_COMMITTER_NAME: shared_git_name,
          GIT_COMMITTER_EMAIL: shared_git_email,
        };
        this.logger.log(`Using fallback Git identity: ${userId}@local.dev`);
      }

      // 2. 获取 SSH Key 并添加到环境变量
      const sshKeyPath = await this.identityService.getUserSshKeyPath(userId);
      const env = {
        ...gitEnv,
        GIT_SSH_COMMAND: `ssh -i ${sshKeyPath} -o StrictHostKeyChecking=yes`,
      };

      // 3. 先 fetch 最新的远程分支信息
      await execAsync('git fetch origin', {
        cwd: workspaceDir,
        env,
        timeout: 60 * 1000,
      });

      // 4. 验证目标分支在远程是否存在
      const { stdout: remoteBranches } = await execAsync('git branch -r', {
        cwd: workspaceDir,
        timeout: 30 * 1000,
      });

      const targetBranchExists = remoteBranches
        .split('\n')
        .some((line) => line.trim() === `origin/${targetBranch}`);

      if (!targetBranchExists) {
        return {
          success: false,
          error: `目标分支 "${targetBranch}" 在远程仓库中不存在，请确认分支名称是否正确`,
        };
      }

      // 5. 切换到源分支
      await execAsync(`git checkout "${sourceBranch}"`, {
        cwd: workspaceDir,
      });

      // 6. 检查源分支是否存在于远程
      const sourceBranchExists = remoteBranches
        .split('\n')
        .some((line) => line.trim() === `origin/${sourceBranch}`);

      // 7. 如果源分支不存在于远程，先推送一次让 GitLab 注册分支
      if (!sourceBranchExists) {
        this.logger.log(`Source branch not found on remote, pushing first...`);
        await execAsync(`git push origin "${sourceBranch}"`, {
          cwd: workspaceDir,
          env,
          timeout: 2 * 60 * 1000,
        });
        this.logger.log(`Source branch pushed to remote: ${sourceBranch}`);
      }

      // 8. 创建一个空 commit 以触发 push（确保 push options 生效）
      // 注意：如果本地和远程完全一致，git push 不会真正发送数据，导致 push options 不生效
      try {
        // 使用符合 conventional commits 规范的格式，避免被 commitlint 拒绝
        await execAsync(
          `git commit --allow-empty -m "fix: trigger MR creation [skip ci]"`,
          {
            cwd: workspaceDir,
            env,  // 使用包含 Git 身份的环境变量
            timeout: 30 * 1000,
          },
        );
        this.logger.log('Created empty commit to trigger MR creation');
      } catch (error) {
        this.logger.warn(`Failed to create empty commit: ${error.message}`);
        // 如果创建空 commit 失败（比如已经有未推送的 commit），继续执行
      }

      this.logger.log(
        `Both branches verified on remote: ${sourceBranch} -> ${targetBranch}`,
      );

      // 9. 使用 git push 的 -o 选项创建 MR (GitLab 11.10+)
      // 这是一种轻量级的创建 MR 方式，不需要 GitLab API Token
      // 参考: https://docs.gitlab.com/ee/user/project/push_options.html

      // 转义函数：用单引号包裹整个参数，并转义内部的单引号
      const escapeShellArg = (arg: string): string => {
        // 将单引号替换为 '\''（结束引号，转义单引号，开始新引号）
        return `'${arg.replace(/'/g, "'\\''")}'`;
      };

      const pushOptions = [
        `-o merge_request.create`,
        `-o ${escapeShellArg(`merge_request.target=${targetBranch}`)}`,
        `-o ${escapeShellArg(`merge_request.title=${title}`)}`,
      ];

      if (description) {
        pushOptions.push(`-o ${escapeShellArg(`merge_request.description=${description}`)}`);
      }

      const pushCmd = `git push origin "${sourceBranch}" ${pushOptions.join(' ')}`;

      this.logger.log(`Executing push command: ${pushCmd.substring(0, 150)}...`);

      const { stdout, stderr } = await execAsync(pushCmd, {
        cwd: workspaceDir,
        env,
        timeout: 2 * 60 * 1000,
      });

      // 10. 打印完整输出用于调试
      this.logger.log(`Git push stdout: ${stdout}`);
      this.logger.log(`Git push stderr: ${stderr}`);

      // 11. 从输出中提取 MR URL
      const output = stdout + stderr;
      const mrUrlMatch = output.match(/https?:\/\/[^\s]+\/merge_requests\/\d+/);

      // 12. 检查是否真的创建了 MR
      // GitLab 成功创建 MR 时会输出类似这样的信息：
      // "remote: To create a merge request for feature, visit:"
      // "remote:   https://gitlab.com/xxx/merge_requests/new?merge_request[source_branch]=feature"
      const hasCreateMessage = output.includes('merge request') || output.includes('merge_request');

      if (!hasCreateMessage && !mrUrlMatch) {
        this.logger.warn(
          `Push succeeded but no MR creation confirmation found in output`,
        );
        return {
          success: false,
          error: 'GitLab 没有返回 MR 创建确认信息。可能的原因：1) GitLab 版本不支持 push options；2) 权限不足；3) 该分支已经有打开的 MR',
        };
      }

      this.logger.log(
        `Merge request created: ${sourceBranch} -> ${targetBranch}`,
      );

      return {
        success: true,
        sourceBranch,
        targetBranch,
        title,
        description,
        mrUrl: mrUrlMatch ? mrUrlMatch[0] : null,
        message: 'Merge request created successfully',
      };
    } catch (error) {
      this.logger.error(`Failed to create merge request: ${error.message}`);

      // 如果推送选项不支持，返回友好的错误信息
      if (error.message.includes('push option')) {
        return {
          success: false,
          error:
            'GitLab push options not supported. Please create MR manually or use GitLab API.',
        };
      }

      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * 使用 AI 生成 commit message 并提交代码
   */
  async commitWithAI(options: {
    workspaceDir: string;
    userId: string;
    push?: boolean;
  }): Promise<CommitResult> {
    const { workspaceDir, userId, push = false } = options;

    // 检查工作目录是否存在
    if (!(await fs.pathExists(workspaceDir))) {
      return {
        success: false,
        error: `Workspace directory not found: ${workspaceDir}`,
      };
    }

    try {
      // 1. 检查是否有待提交的更改
      const { stdout: statusOutput } = await execAsync(
        'git status --porcelain',
        {
          cwd: workspaceDir,
        },
      );

      if (!statusOutput.trim()) {
        this.logger.log('No changes to commit');
        return {
          success: true,
          message: 'No changes to commit',
        };
      }

      // 2. 获取 git diff (包括未暂存的更改)
      const { stdout: diffOutput } = await execAsync(
        'git diff HEAD',
        {
          cwd: workspaceDir,
          maxBuffer: 10 * 1024 * 1024, // 10MB buffer
        },
      );

      if (!diffOutput.trim()) {
        // 如果没有 diff，可能是新文件，获取新文件的内容
        const { stdout: diffCached } = await execAsync(
          'git diff --cached',
          {
            cwd: workspaceDir,
            maxBuffer: 10 * 1024 * 1024,
          },
        );

        if (!diffCached.trim()) {
          this.logger.log('No meaningful changes to commit');
          return {
            success: true,
            message: 'No meaningful changes to commit',
          };
        }
      }

      // 3. 获取最近的 commit 信息（用于学习项目的 commit 规范）
      let recentCommits = '';
      try {
        const { stdout: commits } = await execAsync(
          'git log -10 --pretty=format:"%s"',
          {
            cwd: workspaceDir,
          },
        );
        recentCommits = commits;
      } catch (error) {
        // 如果是新仓库可能没有 commit 历史
        this.logger.warn('No commit history found, will use default format');
      }

      // 4. 调用 AI 生成 commit message
      const aiGeneratedMessage = await this.generateCommitMessage(
        diffOutput || statusOutput,
        recentCommits,
      );

      // 5. 在 commit message 后面添加提交者信息
      const commitMessage = `${aiGeneratedMessage}（代码提交者：${userId}）`;

      this.logger.log(`Generated commit message: ${commitMessage}`);

      // 6. 获取用户 Git 身份信息
      let gitEnv = process.env;
      try {
        const identity = await this.identityService.getIdentity(userId);
        gitEnv = {
          ...process.env,
          GIT_AUTHOR_NAME: identity.userName,
          GIT_AUTHOR_EMAIL: identity.userEmail,
          GIT_COMMITTER_NAME: identity.userName,
          GIT_COMMITTER_EMAIL: identity.userEmail,
        };
      } catch (error) {
        this.logger.warn(`Failed to get personal Git identity for user ${userId}: ${error.message}`);
        // 回退到使用 userId 作为提交者信息
        gitEnv = {
          ...process.env,
          GIT_AUTHOR_NAME: shared_git_name,
          GIT_AUTHOR_EMAIL: shared_git_email,
          GIT_COMMITTER_NAME: shared_git_name,
          GIT_COMMITTER_EMAIL: shared_git_email,
        };
        this.logger.log(`Using fallback Git identity: ${shared_git_email}`);
      }

      // 7. 添加所有更改到暂存区
      await execAsync('git add .', {
        cwd: workspaceDir,
        timeout: 30 * 1000,
      });

      // 8. 提交代码（使用 Git 身份环境变量）
      await execAsync(`git commit -m "${commitMessage.replace(/"/g, '\\"')}"`, {
        cwd: workspaceDir,
        env: gitEnv,
        timeout: 30 * 1000,
      });

      // 9. 获取提交 hash
      const { stdout: commitHash } = await execAsync('git rev-parse HEAD', {
        cwd: workspaceDir,
      });

      this.logger.log(`Code committed with AI-generated message: ${commitHash.trim()}`);

      // 10. 推送到远程（如果需要）
      if (push) {
        const sshKeyPath = await this.identityService.getUserSshKeyPath(userId);
        const env = {
          ...process.env,
          GIT_SSH_COMMAND: `ssh -i ${sshKeyPath} -o StrictHostKeyChecking=yes`,
        };

        const { stdout: currentBranch } = await execAsync(
          'git rev-parse --abbrev-ref HEAD',
          { cwd: workspaceDir },
        );

        const branch = currentBranch.trim();

        await execAsync(`git push origin "${branch}"`, {
          cwd: workspaceDir,
          env,
          timeout: 2 * 60 * 1000,
        });

        this.logger.log(`Code pushed to remote: ${branch}`);
      }

      return {
        success: true,
        commitHash: commitHash.trim(),
        message: commitMessage,
      };
    } catch (error) {
      this.logger.error(`Failed to commit with AI: ${error.message}`);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * 生成 MR 的 title
   */
  async generateMRTitle(
    workspaceDir: string,
    sourceBranch: string,
    targetBranch: string,
  ): Promise<string> {
    try {
      // 1. 获取 git diff (源分支与目标分支的差异)
      const { stdout: diffOutput } = await execAsync(
        `git diff "${targetBranch}...${sourceBranch}"`,
        {
          cwd: workspaceDir,
          maxBuffer: 10 * 1024 * 1024, // 10MB buffer
        },
      );

      // 2. 获取源分支的 commit 历史（相对于目标分支）
      const { stdout: commitLog } = await execAsync(
        `git log "${targetBranch}..${sourceBranch}" --pretty=format:"%s"`,
        {
          cwd: workspaceDir,
        },
      );

      // 3. 使用 AI 生成 MR title
      return await this.generateMRTitleWithAI(
        diffOutput,
        commitLog,
        sourceBranch,
        targetBranch,
      );
    } catch (error) {
      this.logger.error(`Failed to generate MR title: ${error.message}`);
      // 如果生成失败，返回默认标题
      return `Merge ${sourceBranch} into ${targetBranch}`;
    }
  }

  /**
   * 使用 AI 生成 MR 的 title
   */
  private async generateMRTitleWithAI(
    diff: string,
    commitLog: string,
    sourceBranch: string,
    targetBranch: string,
  ): Promise<string> {
    let tempDir: string | null = null;

    try {
      // 构建 prompt
      const prompt = this.buildMRPrompt(
        diff,
        commitLog,
        sourceBranch,
        targetBranch,
      );

      // 创建临时目录
      tempDir = path.join('/tmp', `mr-gen-${Date.now()}`);
      await fs.ensureDir(tempDir);

      // 初始化为 git 仓库
      try {
        await execAsync('git init', { cwd: tempDir });
        await execAsync('git config user.name "AI Mule"', { cwd: tempDir });
        await execAsync('git config user.email "ai@mule.local"', {
          cwd: tempDir,
        });
      } catch (error) {
        this.logger.warn('Failed to init git in temp dir, continuing anyway');
      }

      this.logger.log('Calling Claude SDK query() to generate MR content...');

      // 使用 Claude Agent SDK
      const queryInstance = query({
        prompt: prompt,
        options: {
          cwd: tempDir,
          maxTurns: 1,
          disallowedTools: ['*'],
          env: process.env as Record<string, string>,
          stderr: (message: string) => {
            this.logger.debug(`[SDK stderr] ${message}`);
          },
        },
      });

      // 收集响应内容
      let responseText = '';
      for await (const message of queryInstance) {
        if (message.type === 'assistant') {
          const assistantMsg = message as any;
          const content = assistantMsg.message?.content || assistantMsg.content;

          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'text' && block.text) {
                responseText += block.text;
              }
            }
          }
        }

        if (message.type === 'result') {
          const result = message as any;
          if (result.error) {
            throw new Error(
              `SDK error: ${result.error.message || JSON.stringify(result.error)}`,
            );
          }
        }
      }

      // 解析响应
      if (!responseText.trim()) {
        throw new Error('No response from AI');
      }

      // 尝试从响应中提取 title
      const titleMatch = responseText.match(/title:\s*(.+?)(?:\n|$)/i);

      const title =
        titleMatch?.[1]?.trim() ||
        responseText.split('\n')[0].trim() ||
        `Merge ${sourceBranch} into ${targetBranch}`;

      this.logger.log(`Generated MR title: ${title}`);

      return title;
    } catch (error) {
      this.logger.error(
        `Failed to generate MR title with AI: ${error.message}`,
      );
      // 返回默认标题
      return `Merge ${sourceBranch} into ${targetBranch}`;
    } finally {
      // 清理临时目录
      if (tempDir) {
        await fs.remove(tempDir).catch(() => {});
      }
    }
  }

  /**
   * 构建 MR 生成的 prompt
   */
  private buildMRPrompt(
    diff: string,
    commitLog: string,
    sourceBranch: string,
    targetBranch: string,
  ): string {
    // 限制 diff 长度
    const maxDiffLength = 8000;
    const truncatedDiff =
      diff.length > maxDiffLength
        ? diff.substring(0, maxDiffLength) + '\n\n... (diff truncated)'
        : diff;

    return `你是一个专业的代码审查助手。请根据以下信息为这个 Merge Request 生成一个简洁的标题。

## 分支信息
- 源分支: ${sourceBranch}
- 目标分支: ${targetBranch}

## Commit 历史
${commitLog || '无 commit 记录'}

## 代码变更
\`\`\`diff
${truncatedDiff}
\`\`\`

## 要求
生成一行简洁的标题（不超过20字），概括本次变更的核心内容。

## 输出格式
title: 你的标题

请直接输出结果：`;
  }

  /**
   * 使用 Claude AI 生成 commit message
   * 使用 Claude Agent SDK 的 query() 函数（和 Agent 对话一样的方式）
   */
  private async generateCommitMessage(
    diff: string,
    recentCommits: string,
  ): Promise<string> {
    let tempDir: string | null = null;

    try {
      // 构建 prompt
      const prompt = this.buildCommitMessagePrompt(diff, recentCommits);

      // 创建临时目录（SDK 需要 cwd）
      tempDir = path.join('/tmp', `commit-gen-${Date.now()}`);
      await fs.ensureDir(tempDir);

      // 初始化为 git 仓库（SDK 可能需要）
      try {
        await execAsync('git init', { cwd: tempDir });
        await execAsync('git config user.name "AI Mule"', { cwd: tempDir });
        await execAsync('git config user.email "ai@mule.local"', {
          cwd: tempDir,
        });
      } catch (error) {
        this.logger.warn('Failed to init git in temp dir, continuing anyway');
      }

      this.logger.log('Calling Claude SDK query()...');

      // 使用 Claude Agent SDK 的 query() 函数
      // 这和 ClaudeAdapter.sendMessage() 内部的实现完全一样
      // 环境变量（ANTHROPIC_API_KEY、ANTHROPIC_BASE_URL、NODE_TLS_REJECT_UNAUTHORIZED）会自动继承
      const queryInstance = query({
        prompt: prompt,
        options: {
          cwd: tempDir,
          // 不指定 model，使用 SDK 默认配置（和 Agent 对话保持一致）
          maxTurns: 1, // 只需要一轮对话，不需要工具调用
          disallowedTools: ['*'], // 禁用所有工具，只需要文本响应
          env: process.env as Record<string, string>, // 传递完整环境变量
          // 捕获 stderr 输出用于调试
          stderr: (message: string) => {
            this.logger.debug(`[SDK stderr] ${message}`);
          },
        },
      });

      // 收集响应内容
      let commitMessage = '';
      for await (const message of queryInstance) {
        // 记录所有消息类型以便调试
        this.logger.debug(`[SDK message] type=${message.type}`);

        // 处理 assistant 消息（包含 AI 的响应）
        if (message.type === 'assistant') {
          const assistantMsg = message as any;

          // content 在 message.content 里面（SDK 的消息结构）
          const content = assistantMsg.message?.content || assistantMsg.content;

          if (Array.isArray(content)) {
            this.logger.debug(`[SDK content array] length=${content.length}`);
            for (const block of content) {
              this.logger.debug(`[SDK content block] type=${block.type}`);
              if (block.type === 'text' && block.text) {
                commitMessage += block.text;
                this.logger.debug(`[SDK text] ${block.text}`);
              }
            }
          } else {
            this.logger.warn(`[SDK assistant] content is not an array: ${typeof content}`);
          }
        }

        // 如果是错误消息
        if (message.type === 'result') {
          const result = message as any;
          this.logger.debug(`[SDK result] ${JSON.stringify(result)}`);
          if (result.error) {
            this.logger.error(`[SDK error] ${JSON.stringify(result.error)}`);
            throw new Error(`SDK error: ${result.error.message || JSON.stringify(result.error)}`);
          }
        }
      }

      // 检查是否成功提取到 commit message
      if (!commitMessage.trim()) {
        this.logger.warn('No commit message extracted from SDK response');
        throw new Error('Failed to extract commit message from AI response');
      }

      // 清理可能的 markdown 格式
      const cleanMessage = commitMessage
        .trim()
        .replace(/^```.*\n/, '')
        .replace(/\n```$/, '');

      this.logger.log(`Generated commit message: ${cleanMessage}`);
      return cleanMessage;
    } catch (error) {
      this.logger.error(
        `Failed to generate commit message with AI: ${error.message}`,
      );
      // 如果 AI 生成失败，返回默认的 commit message
      return 'feat: mule update code';
    } finally {
      // 清理临时目录
      if (tempDir) {
        await fs.remove(tempDir).catch(() => {});
      }
    }
  }

  /**
   * 构建 commit message 生成的 prompt
   */
  private buildCommitMessagePrompt(
    diff: string,
    recentCommits: string,
  ): string {
    // 限制 diff 长度，避免 token 过多
    const maxDiffLength = 8000;
    const truncatedDiff = diff.length > maxDiffLength
      ? diff.substring(0, maxDiffLength) + '\n\n... (diff truncated)'
      : diff;

    return `你是一个专业的 Git commit message 生成助手。请根据以下代码变更生成一个简洁、规范的 commit message。

## 项目最近的 commit 记录（用于参考项目的 commit 规范）：
${recentCommits || '无历史记录'}

## 本次代码变更：
\`\`\`diff
${truncatedDiff}
\`\`\`

## 要求：
1. 遵循 Conventional Commits 规范 (type: description)
2. type 使用: feat, fix
3. 如果项目有特定的 commit 风格，请参考上面的历史记录保持一致
4. description 使用中文，简洁明了（不超过30字）
5. 只输出 commit message 本身，不要有其他解释或格式标记
6. 不要使用 markdown 代码块包裹

示例格式：
- feat: 添加用户登录功能
- fix: 修复数据加载失败的问题

请直接输出 commit message：`;
  }
}
