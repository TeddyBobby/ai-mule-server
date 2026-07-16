import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs-extra';
import * as path from 'path';

const execAsync = promisify(exec);

/**
 * 依赖管理服务
 *
 * 职责:
 * - 检测项目使用的包管理器 (npm/pnpm/yarn)
 * - 安装项目依赖
 * - 处理依赖安装错误
 */
@Injectable()
export class DependencyService {
  private readonly logger = new Logger(DependencyService.name);

  /**
   * 检测包管理器
   */
  async detectPackageManager(projectDir: string): Promise<string> {
    // 1. 检查 lock 文件
    if (await fs.pathExists(path.join(projectDir, 'pnpm-lock.yaml'))) {
      return 'pnpm';
    }

    if (await fs.pathExists(path.join(projectDir, 'yarn.lock'))) {
      return 'yarn';
    }

    if (await fs.pathExists(path.join(projectDir, 'package-lock.json'))) {
      return 'npm';
    }

    // 2. 检查 package.json 的 packageManager 字段
    const packageJsonPath = path.join(projectDir, 'package.json');
    if (await fs.pathExists(packageJsonPath)) {
      const packageJson = await fs.readJSON(packageJsonPath);
      if (packageJson.packageManager) {
        const pmSpec = packageJson.packageManager.split('@')[0];
        return pmSpec; // pnpm, yarn, npm
      }
    }

    // 3. 默认使用 npm
    return 'npm';
  }

  /**
   * 安装依赖
   */
  async installDependencies(
    projectDir: string,
    packageManager?: string,
  ): Promise<void> {
    // 检测包管理器
    const pm = packageManager || (await this.detectPackageManager(projectDir));

    this.logger.log(`Installing dependencies using ${pm} in ${projectDir}`);

    try {
      // 执行安装命令
      const installCmd = pm === 'yarn' ? 'yarn install' : `${pm} install`;

      await execAsync(installCmd, {
        cwd: projectDir,
        timeout: 10 * 60 * 1000, // 10 分钟超时
      });

      this.logger.log(`Dependencies installed successfully in ${projectDir}`);
    } catch (error) {
      this.logger.error(
        `Failed to install dependencies in ${projectDir}: ${error.message}`,
      );
      throw new BadRequestException(
        `Failed to install dependencies: ${error.message}`,
      );
    }
  }
}
