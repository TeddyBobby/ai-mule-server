import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import * as lockfile from 'proper-lockfile';
import { GitIdentity } from './entities/git-identity.entity';
import { CreateIdentityDto } from './dto/create-identity.dto';
import {
  IdentityResponseDto,
  GitVerificationResultDto,
} from './dto/identity-response.dto';
import { PathResolverService } from '../../common/services/path-resolver.service';
import { GitErrorParser } from '../../common/utils/git-error-parser';

const execAsync = promisify(exec);

@Injectable()
export class IdentityService {
  private readonly logger = new Logger(IdentityService.name);
  private readonly globalGitConfigPath: string;
  private readonly gitConfigLockPath: string;
  private readonly gitlabHost: string;

  constructor(
    @InjectRepository(GitIdentity)
    private gitIdentityRepository: Repository<GitIdentity>,
    private configService: ConfigService,
    private pathResolver: PathResolverService,
  ) {
    this.globalGitConfigPath = path.join(os.homedir(), '.gitconfig');
    const systemLocksDir = this.pathResolver.getSystemPath('locks');
    this.gitConfigLockPath = path.join(systemLocksDir, 'gitconfig.lock');
    this.gitlabHost =
      this.configService.get<string>('GITLAB_HOST') || 'github.com';
  }

  /**
   * 初始化全局 Git 配置
   */
  async initializeGlobalGitConfig(): Promise<void> {
    if (!(await fs.pathExists(this.globalGitConfigPath))) {
      const defaultConfig = `[init]
    defaultBranch = main

[safe]
    directory = ${this.pathResolver.getRootDir()}
`;
      await fs.writeFile(this.globalGitConfigPath, defaultConfig);
      await fs.chmod(this.globalGitConfigPath, 0o644);
      this.logger.log('Global .gitconfig initialized');
    }
  }

  /**
   * 创建用户 Git 身份
   */
  async createIdentity(
    createDto: CreateIdentityDto,
  ): Promise<IdentityResponseDto> {
    const { userId, userEmail } = createDto;
    const userName = userId; // userId 就是 username

    // 1. 检查是否已存在（包括软删除的记录）
    const existing = await this.gitIdentityRepository.findOne({
      where: { userId, isDeleted: false },
    });

    if (existing) {
      throw new BadRequestException(
        `Git identity already exists for user: ${userId}`,
      );
    }

    // 检查是否有被软删除的记录，如果有则硬删除后重新创建
    const softDeleted = await this.gitIdentityRepository.findOne({
      where: { userId, isDeleted: true },
    });

    if (softDeleted) {
      this.logger.log(`Found soft-deleted identity for user: ${userId}, removing it`);
      await this.gitIdentityRepository.remove(softDeleted);
    }

    // 2. 确保用户目录存在
    const userConfigDir = this.pathResolver.getUserPath(userId, 'config');
    const userSshDir = this.pathResolver.getUserPath(userId, 'ssh');
    await fs.ensureDir(userConfigDir);
    await fs.ensureDir(userSshDir);

    // 3. 生成 SSH Key
    const sshKeyPath = path.join(userSshDir, 'id_rsa');
    const sshPublicKeyPath = `${sshKeyPath}.pub`;

    try {
      // 如果已存在则先删除，避免 ssh-keygen 等待用户确认覆盖
      if (await fs.pathExists(sshKeyPath)) {
        this.logger.warn(`SSH key already exists, removing: ${sshKeyPath}`);
        await fs.remove(sshKeyPath);
        await fs.remove(sshPublicKeyPath);
      }

      this.logger.log(`Generating SSH key for user: ${userId}`);
      await execAsync(
        `ssh-keygen -t rsa -b 4096 -f "${sshKeyPath}" -N "" -C "${userEmail}"`,
        { timeout: 30000 },
      );
      await fs.chmod(sshKeyPath, 0o600);
      await fs.chmod(sshPublicKeyPath, 0o644);
      this.logger.log(`SSH key generated for user: ${userId}`);
    } catch (error) {
      this.logger.error(`Failed to generate SSH key: ${error.message}`);
      throw new BadRequestException('Failed to generate SSH key');
    }

    // 4. 读取公钥
    const sshPublicKey = await fs.readFile(sshPublicKeyPath, 'utf-8');

    // 5. 创建用户 .gitconfig
    const userGitConfigPath = path.join(userConfigDir, '.gitconfig');
    const gitConfig = `[user]
    name = ${userName}
    email = ${userEmail}

[core]
    sshCommand = ssh -i ${sshKeyPath} -o StrictHostKeyChecking=yes

[credential]
    helper = store
`;
    await fs.writeFile(userGitConfigPath, gitConfig);
    await fs.chmod(userGitConfigPath, 0o600);
    this.logger.log(`Git config created for user: ${userId}`);

    // 6. 初始化 known_hosts
    await this.initializeKnownHosts(userSshDir);

    // 7. 更新全局 .gitconfig (添加 includeIf 规则)
    await this.updateGlobalGitConfig(userId, userGitConfigPath);

    // 8. 保存到数据库
    const gitIdentity = this.gitIdentityRepository.create({
      userId,
      userName,
      userEmail,
      sshPublicKey: sshPublicKey.trim(),
      sshPrivateKeyPath: sshKeyPath,
      gitConfigPath: userGitConfigPath,
    });

    await this.gitIdentityRepository.save(gitIdentity);

    return {
      userId,
      userName,
      userEmail,
      sshPublicKey: sshPublicKey.trim(),
      configurationGuide: this.generateConfigurationGuide(sshPublicKey.trim()),
    };
  }

  /**
   * 初始化 known_hosts
   */
  private async initializeKnownHosts(userSshDir: string): Promise<void> {
    const knownHostsPath = path.join(userSshDir, 'known_hosts');

    try {
      // 添加 10 秒超时，避免网络不通时无限等待
      const { stdout } = await execAsync(
        `ssh-keyscan -T 5 ${this.gitlabHost}`,
        { timeout: 10000 },
      );
      await fs.writeFile(knownHostsPath, stdout);
      await fs.chmod(knownHostsPath, 0o644);
      this.logger.log(`Known hosts initialized for ${this.gitlabHost}`);
    } catch (error) {
      this.logger.warn(
        `Failed to initialize known_hosts: ${error.message}. Will continue anyway.`,
      );
      // 创建空的 known_hosts 文件，避免后续报错
      await fs.ensureFile(knownHostsPath);
    }
  }

  /**
   * 更新全局 .gitconfig (添加 includeIf 规则)
   */
  private async updateGlobalGitConfig(
    userId: string,
    userGitConfigPath: string,
  ): Promise<void> {
    // 确保锁文件存在
    await fs.ensureFile(this.gitConfigLockPath);

    // 获取文件锁
    const release = await lockfile.lock(this.gitConfigLockPath, {
      retries: {
        retries: 10,
        minTimeout: 100,
        maxTimeout: 1000,
      },
    });

    try {
      // 读取现有配置
      let content = '';
      if (await fs.pathExists(this.globalGitConfigPath)) {
        content = await fs.readFile(this.globalGitConfigPath, 'utf-8');
      }

      // 检查是否已存在该用户的 includeIf 规则
      const userWorkspaceDir = this.pathResolver.getUserPath(userId, 'base');
      const includeIfPattern = `gitdir:${userWorkspaceDir}`;

      if (content.includes(includeIfPattern)) {
        this.logger.log(`includeIf rule already exists for user: ${userId}`);
        return;
      }

      // 追加新的 includeIf 规则
      const includeIfRule = `\n[includeIf "${includeIfPattern}"]\n    path = ${userGitConfigPath}\n`;
      await fs.appendFile(this.globalGitConfigPath, includeIfRule);

      this.logger.log(`Added includeIf rule for user: ${userId}`);
    } finally {
      await release();
    }
  }

  /**
   * 验证 Git 连接
   */
  async verifyGitConnection(
    userId: string,
    testRepoUrl?: string,
  ): Promise<GitVerificationResultDto> {
    const identity = await this.gitIdentityRepository.findOne({
      where: { userId, isDeleted: false },
    });

    if (!identity) {
      throw new NotFoundException(`Git identity not found for user: ${userId}`);
    }

    // 默认测试仓库 (可以配置一个公开的测试仓库)
    const repoUrl =
      testRepoUrl ||
      `git@${this.gitlabHost}:test/test-repo.git`;

    try {
      // 设置环境变量以使用正确的 SSH Key
      const env = {
        ...process.env,
        GIT_SSH_COMMAND: `ssh -i ${identity.sshPrivateKeyPath} -o StrictHostKeyChecking=yes`,
      };

      // 执行 git ls-remote 测试连接
      const { stdout, stderr } = await execAsync(`git ls-remote "${repoUrl}"`, {
        env,
        timeout: 30000,
      });

      this.logger.log(`Git connection verified for user: ${userId}`);

      return {
        success: true,
        message: 'Git connection successful',
        details: `Successfully connected to ${repoUrl}`,
      };
    } catch (error) {
      this.logger.error(
        `Git connection failed for user ${userId}: ${error.message}`,
      );

      return {
        success: false,
        message: 'Git connection failed',
        details: GitErrorParser.parseConnectionError(error.message, this.gitlabHost),
      };
    }
  }

  /**
   * 获取用户 Git 身份
   */
  async getIdentity(userId: string): Promise<IdentityResponseDto> {
    const identity = await this.gitIdentityRepository.findOne({
      where: { userId, isDeleted: false },
    });

    if (!identity) {
      throw new NotFoundException(`Git identity not found for user: ${userId}`);
    }

    return {
      userId: identity.userId,
      userName: identity.userName,
      userEmail: identity.userEmail,
      sshPublicKey: identity.sshPublicKey,
    };
  }

  /**
   * 获取用户 SSH Key 路径
   * 优先使用用户个人身份，如果没有则回退到共享身份
   */
  async getUserSshKeyPath(userId: string): Promise<string> {
    // 1. 先尝试获取用户个人身份
    const identity = await this.gitIdentityRepository.findOne({
      where: { userId, isDeleted: false },
    });

    if (identity) {
      return identity.sshPrivateKeyPath;
    }

    // 2. 回退到共享身份（仅共用 SSH Key，不共用目录）
    const sharedKeyPath = this.getSharedSshKeyPath();
    if (sharedKeyPath) {
      this.logger.log(`Using shared Git identity for user: ${userId}`);
      return sharedKeyPath;
    }

    // 3. 都没有则抛出异常
    throw new NotFoundException(`Git identity not found for user: ${userId}`);
  }

  /**
   * 获取共享身份 SSH Key 路径
   * 会验证文件存在性和权限
   */
  getSharedSshKeyPath(): string | null {
    if (!this.isSharedIdentityEnabled()) return null;

    const keyPath = this.configService.get<string>('SHARED_GIT_SSH_KEY_PATH');
    if (!keyPath) {
      this.logger.warn(
        'SHARED_GIT_IDENTITY_ENABLED is true but SHARED_GIT_SSH_KEY_PATH is not set',
      );
      return null;
    }

    return keyPath;
  }

  /**
   * 验证共享 SSH Key 配置
   * 检查文件存在性和权限
   */
  async validateSharedSshKey(): Promise<{
    valid: boolean;
    error?: string;
  }> {
    const keyPath = this.getSharedSshKeyPath();
    if (!keyPath) {
      return { valid: false, error: 'Shared SSH key not configured' };
    }

    // 检查文件是否存在
    if (!(await fs.pathExists(keyPath))) {
      return { valid: false, error: `SSH key file not found: ${keyPath}` };
    }

    // 检查文件权限（应该是 600 或更严格）
    try {
      const stats = await fs.stat(keyPath);
      const mode = stats.mode & 0o777;
      if (mode > 0o600) {
        return {
          valid: false,
          error: `SSH key file permissions too open: ${mode.toString(8)}. Should be 600 or stricter.`,
        };
      }
    } catch (err) {
      const error = err as Error;
      return {
        valid: false,
        error: `Cannot check file permissions: ${error.message}`,
      };
    }

    return { valid: true };
  }

  /**
   * 检查用户是否有个人 Git 身份
   */
  async hasPersonalIdentity(userId: string): Promise<boolean> {
    const identity = await this.gitIdentityRepository.findOne({
      where: { userId, isDeleted: false },
    });
    return !!identity;
  }

  /**
   * 检查是否启用共享身份
   */
  isSharedIdentityEnabled(): boolean {
    const value = this.configService.get<string>('SHARED_GIT_IDENTITY_ENABLED');
    return value === 'true' || value === '1';
  }

  /**
   * 获取共享身份状态
   */
  getSharedIdentityStatus(): { enabled: boolean; configured: boolean } {
    const enabled = this.isSharedIdentityEnabled();
    const keyPath = this.configService.get<string>('SHARED_GIT_SSH_KEY_PATH');
    return {
      enabled,
      configured: enabled && !!keyPath,
    };
  }

  /**
   * 生成配置指南
   */
  private generateConfigurationGuide(publicKey: string): string {
    return `
请按照以下步骤配置 GitLab SSH Key:

1. 登录 GitLab: https://${this.gitlabHost}
2. 进入 "用户设置" -> "SSH Keys"
3. 将以下公钥粘贴到 "Key" 输入框:

${publicKey}

4. 设置一个便于识别的 Title (例如: "AI Code Server")
5. 点击 "Add key" 保存

完成后,请调用验证接口测试 Git 连接是否正常。
`;
  }

  /**
   * 删除用户 Git 身份 (软删除)
   */
  async deleteIdentity(userId: string): Promise<void> {
    const identity = await this.gitIdentityRepository.findOne({
      where: { userId, isDeleted: false },
    });

    if (!identity) {
      throw new NotFoundException(`Git identity not found for user: ${userId}`);
    }

    // 软删除
    await this.gitIdentityRepository.update({ userId }, { isDeleted: true });

    this.logger.log(`Git identity soft deleted for user: ${userId}`);
  }

  /**
   * 健康检查: 验证全局 .gitconfig 完整性
   */
  async validateGlobalGitConfig(): Promise<{
    isValid: boolean;
    missingUsers: string[];
  }> {
    const allIdentities = await this.gitIdentityRepository.find({
      where: { isDeleted: false },
    });

    const configContent = await fs.readFile(
      this.globalGitConfigPath,
      'utf-8',
    );

    const missingUsers: string[] = [];

    for (const identity of allIdentities) {
      const userWorkspaceDir = this.pathResolver.getUserPath(
        identity.userId,
        'base',
      );
      if (!configContent.includes(`gitdir:${userWorkspaceDir}`)) {
        missingUsers.push(identity.userId);
      }
    }

    return {
      isValid: missingUsers.length === 0,
      missingUsers,
    };
  }

  /**
   * 修复缺失的 includeIf 规则
   */
  async repairGlobalGitConfig(): Promise<number> {
    const { missingUsers } = await this.validateGlobalGitConfig();

    for (const userId of missingUsers) {
      const identity = await this.gitIdentityRepository.findOne({
        where: { userId, isDeleted: false },
      });

      if (identity) {
        await this.updateGlobalGitConfig(userId, identity.gitConfigPath);
        this.logger.warn(`Repaired missing includeIf rule for user: ${userId}`);
      }
    }

    return missingUsers.length;
  }
}
