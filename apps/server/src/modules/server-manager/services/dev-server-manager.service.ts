import { Injectable, Logger } from '@nestjs/common';
import { spawn, ChildProcess, exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as net from 'net';
import { NetworkUtilsService } from '../../../common/utils/network-utils.service';
import { ContainerManagerService } from '../../container/services/container-manager.service';

const execAsync = promisify(exec);

export interface DevServerConfig {
  workspaceId: string;
  workspaceCodeDir: string;
  port: number; // 宿主机端口
  containerPort?: number; // 容器内端口(默认3000)
  command?: string; // 默认: npm run dev
  nodeVersion?: string; // 如 20、20.19.4（优先于代码内 .nvmrc 等检测）
  packageManager?: string; // 如 npm、pnpm、pnpm@9、pnpm@8、yarn、auto
  containerId?: string; // 如果提供,则在容器内执行命令
  hostIp?: string; // 宿主机IP地址(用于HMR WebSocket连接)
  env?: Record<string, string>; // 额外的环境变量
}

export interface DevServerStatus {
  workspaceId: string;
  running: boolean;
  pid?: number;
  port?: number;
  startedAt?: string;
  command?: string;
}

interface PackageJsonWithPackageManager {
  packageManager?: unknown;
}

@Injectable()
export class DevServerManagerService {
  private readonly logger = new Logger(DevServerManagerService.name);
  private readonly processes = new Map<string, ChildProcess>();

  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private getStringProperty(obj: unknown, key: 'stdout' | 'stderr'): string {
    if (obj && typeof obj === 'object' && key in obj) {
      const value = obj[key as keyof typeof obj];
      if (typeof value === 'string') {
        return value;
      }
    }

    return '';
  }

  /**
   * 从包管理器字符串提取基础名称（pnpm@9 → pnpm）
   */
  private getPMName(pm: string): 'npm' | 'pnpm' | 'yarn' {
    const name = pm.split('@')[0] as 'npm' | 'pnpm' | 'yarn';
    return ['npm', 'pnpm', 'yarn'].includes(name) ? name : 'npm';
  }

  /**
   * 规范化包管理器规格（去掉 corepack hash 后缀）
   * 示例: pnpm@9.15.9+sha512.xxx -> pnpm@9.15.9
   */
  private normalizePackageManagerSpec(pm: string): string {
    const trimmed = pm.trim();
    const normalized = trimmed.split('+')[0];

    if (/^(npm|pnpm|yarn)(@[\w.-]+)?$/.test(normalized)) {
      return normalized;
    }

    this.logger.warn(
      `Invalid package manager spec: "${pm}", fallback to base name`,
    );
    return this.getPMName(pm);
  }

  /**
   * 规范化 Node 版本字符串，兼容 v24 -> 24
   */
  private normalizeNodeVersion(version: string): string {
    const trimmed = version.trim();
    return trimmed.replace(/^v(?=\d)/i, '');
  }

  /**
   * 解析容器内应使用的 Node 版本
   * 优先级: project 配置 > .nvmrc > .node-version > package.json engines.node
   */
  private async resolveNodeVersion(
    preferredNodeVersion: string | undefined,
    codeDir: string,
  ): Promise<string | undefined> {
    const normalizedPreferredNodeVersion = preferredNodeVersion
      ? this.normalizeNodeVersion(preferredNodeVersion)
      : undefined;
    if (normalizedPreferredNodeVersion) {
      return normalizedPreferredNodeVersion;
    }

    const nvmrcPath = path.join(codeDir, '.nvmrc');
    if (await fs.pathExists(nvmrcPath)) {
      const version = this.normalizeNodeVersion(
        await fs.readFile(nvmrcPath, 'utf-8'),
      );
      if (version) return version;
    }

    const nodeVersionPath = path.join(codeDir, '.node-version');
    if (await fs.pathExists(nodeVersionPath)) {
      const version = this.normalizeNodeVersion(
        await fs.readFile(nodeVersionPath, 'utf-8'),
      );
      if (version) return version;
    }

    const packageJsonPath = path.join(codeDir, 'package.json');
    if (await fs.pathExists(packageJsonPath)) {
      const packageJson = (await fs.readJSON(packageJsonPath)) as {
        engines?: { node?: unknown };
      };
      const engineNode = packageJson.engines?.node;
      if (typeof engineNode === 'string') {
        const m = engineNode.match(/(\d+)/);
        if (m?.[1]) return m[1];
      }
    }

    return undefined;
  }

  /**
   * 根据 pnpm lockfileVersion 推断 pnpm 大版本
   */
  private async resolvePnpmMajorFromLockfile(
    codeDir: string,
  ): Promise<8 | 9 | undefined> {
    const lockfilePath = path.join(codeDir, 'pnpm-lock.yaml');
    if (!(await fs.pathExists(lockfilePath))) {
      return undefined;
    }

    const lockContent = await fs.readFile(lockfilePath, 'utf-8');
    const match = lockContent.match(/lockfileVersion:\s*['"]?(\d+)/);
    const lockMajor = Number.parseInt(match?.[1] || '', 10);

    if (lockMajor === 9) return 9;
    if (lockMajor === 6 || lockMajor === 5) return 8;
    return undefined;
  }

  /**
   * 解析包管理器（保留版本信息）
   */
  private async resolvePackageManagerSpec(
    codeDir: string,
    packageManager?: string,
  ): Promise<string> {
    if (packageManager && packageManager !== 'auto') {
      return this.normalizePackageManagerSpec(packageManager);
    }

    // lockfile 优先
    if (await fs.pathExists(path.join(codeDir, 'pnpm-lock.yaml'))) {
      const pnpmMajor = await this.resolvePnpmMajorFromLockfile(codeDir);
      return pnpmMajor ? `pnpm@${pnpmMajor}` : 'pnpm@9';
    }
    if (await fs.pathExists(path.join(codeDir, 'yarn.lock'))) {
      return 'yarn';
    }
    if (await fs.pathExists(path.join(codeDir, 'package-lock.json'))) {
      return 'npm';
    }

    // package.json packageManager 次优先
    const packageJsonPath = path.join(codeDir, 'package.json');
    if (await fs.pathExists(packageJsonPath)) {
      const packageJson = (await fs.readJSON(packageJsonPath)) as {
        packageManager?: unknown;
      };
      if (typeof packageJson.packageManager === 'string') {
        return this.normalizePackageManagerSpec(packageJson.packageManager);
      }
    }

    return 'npm';
  }

  private getDevServerDir(workspaceCodeDir: string): string {
    return path.join(workspaceCodeDir, '..', '.dev-server');
  }

  /**
   * 构建容器内运行前缀：使用已初始化好的运行时环境
   */
  private buildContainerRuntimePrefix(
    codePathInContainer: string,
    nodeVersion: string | undefined,
  ): string {
    const nodeSetup = nodeVersion
      ? `nvm use ${nodeVersion} >/dev/null 2>&1`
      : 'nvm use default >/dev/null 2>&1';

    return `source /root/.nvm/nvm.sh && ${nodeSetup} && cd ${codePathInContainer} &&`;
  }

  constructor(
    private readonly networkUtils: NetworkUtilsService,
    private readonly containerManager: ContainerManagerService,
  ) {}

  /**
   * 启动开发服务器
   */
  async startDevServer(config: DevServerConfig): Promise<DevServerStatus> {
    const { workspaceId, containerId } = config;

    this.logger.log(
      `Starting dev server for workspace ${workspaceId}${containerId ? ' (in container)' : ''}`,
    );

    // 如果指定了容器ID,在容器内启动开发服务器
    if (containerId) {
      return await this.startDevServerInContainer(config, containerId);
    }

    // 否则在宿主机上启动
    return await this.startDevServerOnHost(config);
  }

  /**
   * 在宿主机上启动开发服务器
   */
  private async startDevServerOnHost(
    config: DevServerConfig,
  ): Promise<DevServerStatus> {
    const { workspaceId, workspaceCodeDir, port, packageManager } = config;

    // 检测包管理器
    const detectedPM =
      packageManager === 'auto'
        ? await this.detectPackageManager(workspaceCodeDir)
        : packageManager || 'npm';

    // 获取启动命令并解析脚本名称
    // config.command 可能是完整命令(如 "npm run dev")或脚本名称(如 "dev")
    const pmName = this.getPMName(detectedPM);
    const command = this.parseScriptName(config.command || 'npm run dev');
    this.logger.log(
      `Parsed script name: "${command}" from command: "${config.command}"`,
    );

    const fullCommand = this.buildCommand(pmName, command);

    // 检查端口是否可用
    const isPortAvailable = await this.checkPortAvailable(port);
    if (!isPortAvailable) {
      throw new Error(`Port ${port} is already in use`);
    }

    // 启动进程
    const proc = spawn(fullCommand.cmd, fullCommand.args, {
      cwd: workspaceCodeDir,
      env: {
        ...process.env,
        PORT: port.toString(),
        HOST: '0.0.0.0',
        ...config.env, // 合并额外的环境变量
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // 保存进程引用
    this.processes.set(workspaceId, proc);

    // 保存进程信息到文件
    const devServerDir = path.join(workspaceCodeDir, '..', '.dev-server');
    await fs.ensureDir(devServerDir);

    const pidFile = path.join(devServerDir, 'pid');
    const portFile = path.join(devServerDir, 'port');
    const commandFile = path.join(devServerDir, 'command');
    const stdoutLog = path.join(devServerDir, 'stdout.log');
    const stderrLog = path.join(devServerDir, 'stderr.log');

    await fs.writeFile(pidFile, proc.pid!.toString());
    await fs.writeFile(portFile, port.toString());
    await fs.writeFile(
      commandFile,
      `${fullCommand.cmd} ${fullCommand.args.join(' ')}`,
    );

    // 日志重定向
    const stdoutStream = fs.createWriteStream(stdoutLog, { flags: 'a' });
    const stderrStream = fs.createWriteStream(stderrLog, { flags: 'a' });

    proc.stdout?.pipe(stdoutStream);
    proc.stderr?.pipe(stderrStream);

    // 监听进程事件
    proc.on('exit', (code) => {
      this.logger.log(
        `Dev server for workspace ${workspaceId} exited with code ${code}`,
      );
      this.processes.delete(workspaceId);

      // 清理 pid 文件
      fs.remove(pidFile).catch((err) =>
        this.logger.error(
          `Failed to remove pid file: ${this.getErrorMessage(err)}`,
        ),
      );
    });

    proc.on('error', (error) => {
      this.logger.error(
        `Dev server error for workspace ${workspaceId}: ${error.message}`,
      );
    });

    // 等待服务器启动（检测端口）
    await this.waitForServerReady(port, 60000); // 最多等待 60 秒

    const status: DevServerStatus = {
      workspaceId,
      running: true,
      pid: proc.pid,
      port,
      startedAt: new Date().toISOString(),
      command: `${fullCommand.cmd} ${fullCommand.args.join(' ')}`,
    };

    this.logger.log(
      `Dev server started for workspace ${workspaceId} on port ${port}`,
    );

    return status;
  }

  /**
   * 在容器内启动开发服务器
   */
  private async startDevServerInContainer(
    config: DevServerConfig,
    containerId: string,
  ): Promise<DevServerStatus> {
    const {
      workspaceId,
      port,
      containerPort = 3000,
      packageManager,
      nodeVersion: preferredNodeVersion,
    } = config;

    // 获取或检测宿主机 IP
    const hostIp = config.hostIp || this.networkUtils.getHostIp();

    this.logger.log(
      `Starting dev server in container ${containerId} for workspace ${workspaceId}`,
    );
    this.logger.log(
      `Container port from config: ${config.containerPort}, resolved containerPort: ${containerPort}`,
    );

    // 容器内代码路径统一为 /workspace/code（通过 Bind Mount 挂载）
    const codePathInContainer = '/workspace/code';

    this.logger.log(`Code path in container: ${codePathInContainer}`);
    this.logger.log(`Host IP for HMR: ${hostIp}`);

    const nodeVersion = await this.resolveNodeVersion(
      preferredNodeVersion,
      config.workspaceCodeDir,
    );
    const packageManagerSpec = await this.resolvePackageManagerSpec(
      config.workspaceCodeDir,
      packageManager,
    );

    // 获取启动命令并解析脚本名称
    // config.command 可能是完整命令(如 "npm run dev")或脚本名称(如 "dev")
    const pmName = this.getPMName(packageManagerSpec);
    const command = this.parseScriptName(config.command || 'npm run dev');
    this.logger.log(
      `Resolved runtime versions: node=${nodeVersion || 'default'}, packageManager=${packageManagerSpec}`,
    );
    this.logger.log(
      `Parsed script name: "${command}" from command: "${config.command}"`,
    );

    try {
      // Step 1: 验证代码目录和依赖是否存在
      this.logger.log('Step 1: Verifying code directory and dependencies...');
      const checkDirCmd = `docker exec ${containerId} sh -c "ls -la ${codePathInContainer}"`;
      const { stdout: dirList } = await execAsync(checkDirCmd);
      this.logger.log(`Code directory contents:\n${dirList}`);

      // 所有 docker exec 命令统一使用固定 Node 与固定包管理器版本
      const runtimePrefix = this.buildContainerRuntimePrefix(
        codePathInContainer,
        nodeVersion,
      );

      // Step 2: 初始化环境（每次执行，确保 Node 与包管理器版本对齐）
      this.logger.log('Step 2: Initializing workspace environment...');
      try {
        const nodeVersionArg = nodeVersion || '';
        const { stdout: envOutput } = await execAsync(
          `docker exec ${containerId} bash /entrypoint.sh ${codePathInContainer} ${packageManagerSpec} ${nodeVersionArg}`,
          { maxBuffer: 10 * 1024 * 1024, timeout: 300000 }, // 5分钟超时（可能需要下载 Node）
        );
        this.logger.log(`Environment init output:\n${envOutput}`);
      } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : String(error);
        this.logger.error(`Environment init failed: ${errMsg}`);
        throw new Error(
          `Failed to initialize workspace environment: ${errMsg}`,
        );
      }

      // Step 3: 每次都安装依赖（稳定策略）
      this.logger.log('Step 3: Installing dependencies in container...');

      // 缓存目录: /global-cache 是宿主机持久化挂载（全局共享），所有用户的工作空间共享缓存
      let installCmd: string;
      if (pmName === 'pnpm') {
        // pnpm: 使用全局持久化 store，避免每次容器重建都重新下载
        installCmd = `docker exec ${containerId} bash -c "${runtimePrefix} CI=true ${pmName} install --no-frozen-lockfile --store-dir /global-cache/pnpm-store"`;
      } else if (pmName === 'yarn') {
        // yarn: 指定缓存目录到全局持久化挂载
        installCmd = `docker exec ${containerId} bash -c "${runtimePrefix} CI=true ${pmName} install --cache-folder /global-cache/yarn-cache"`;
      } else {
        // npm: 指定缓存目录到全局持久化挂载
        installCmd = `docker exec ${containerId} bash -c "${runtimePrefix} CI=true ${pmName} install --cache /global-cache/npm-cache"`;
      }

      this.logger.log(`Install command: ${installCmd}`);

      try {
        const { stdout, stderr } = await execAsync(installCmd, {
          maxBuffer: 50 * 1024 * 1024, // 50MB buffer (增加到50MB)
          timeout: 600000, // 10分钟超时
        });

        if (stdout) {
          this.logger.log(`Install stdout: ${stdout.substring(0, 1000)}...`);
        }
        if (stderr) {
          this.logger.warn(`Install stderr: ${stderr.substring(0, 1000)}...`);
        }

        this.logger.log('✓ Dependencies installed successfully');
      } catch (error: unknown) {
        const errorMessage = this.getErrorMessage(error);
        const installStdout = this.getStringProperty(error, 'stdout');
        const installStderr = this.getStringProperty(error, 'stderr');

        this.logger.error(`Install error: ${errorMessage}`);
        if (installStdout) {
          this.logger.error(
            `Install stdout (last 2000 chars): ${installStdout.substring(Math.max(0, installStdout.length - 2000))}`,
          );
        }
        if (installStderr) {
          this.logger.error(
            `Install stderr (last 2000 chars): ${installStderr.substring(Math.max(0, installStderr.length - 2000))}`,
          );
        }
        throw new Error(`Failed to install dependencies: ${errorMessage}`);
      }

      // Step 5: 启动开发服务器 (使用 -d 后台运行)
      this.logger.log(
        `Step 5: Starting dev server on port ${containerPort}...`,
      );
      // 关键环境变量配置:
      // Vite 项目:
      // - VITE_HOST=0.0.0.0: 强制 Vite 绑定到所有网络接口
      // - VITE_HMR_HOST=localhost: 强制客户端 WebSocket 连接到 localhost
      // - VITE_HMR_PORT=${port}: 强制客户端使用宿主机端口(而非容器端口)
      // Webpack (Vue CLI) 项目:
      // - WDS_SOCKET_HOST=${hostIp}: Webpack Dev Server WebSocket 连接到宿主机 IP
      // - WDS_SOCKET_PORT=${port}: Webpack Dev Server WebSocket port
      // - CHOKIDAR_USEPOLLING=true: 启用文件监听 polling 模式（Docker 容器中必需）
      const startCmd = `docker exec -d ${containerId} bash -c "${runtimePrefix} CHOKIDAR_USEPOLLING=true VITE_HOST=0.0.0.0 VITE_HMR_HOST=localhost VITE_HMR_PORT=${port} WDS_SOCKET_HOST=${hostIp} WDS_SOCKET_PORT=${port} PORT=${containerPort} AI_MULE_PREVIEW=true ${pmName} run ${command} > /tmp/dev-server.log 2>&1"`;
      this.logger.log(`Dev server start command: ${startCmd}`);
      await execAsync(startCmd);

      this.logger.log('Dev server start command sent');

      // Step 6: 等待服务器启动 (检测容器内端口)
      // 在 Docker 环境中，工作空间容器没有映射端口到宿主机，需要通过 Docker 网络检测
      this.logger.log(
        `Step 6: Waiting for server to be ready on container port ${containerPort}...`,
      );
      await this.waitForContainerPortReady(containerId, containerPort, 60000);

      // Step 7: 保存宿主机端口到 .dev-server 目录（用于服务重启后的状态恢复）
      const devServerDir = this.getDevServerDir(config.workspaceCodeDir);
      await fs.ensureDir(devServerDir);
      await fs.writeFile(path.join(devServerDir, 'port'), port.toString());
      this.logger.log(`Saved port info to ${devServerDir}: port=${port}`);

      const status: DevServerStatus = {
        workspaceId,
        running: true,
        port,
        startedAt: new Date().toISOString(),
        command: `docker exec: PORT=${containerPort} ${pmName} run ${command}`,
      };

      this.logger.log(
        `✓ Dev server started successfully in container for workspace ${workspaceId} (host:${port} -> container:${containerPort})`,
      );

      return status;
    } catch (error: unknown) {
      const errorMessage = this.getErrorMessage(error);
      this.logger.error(
        `Failed to start dev server in container: ${errorMessage}`,
      );
      throw new Error(
        `Failed to start dev server in container: ${errorMessage}`,
      );
    }
  }

  /**
   * 停止开发服务器
   */
  async stopDevServer(workspaceId: string): Promise<void> {
    this.logger.log(`Stopping dev server for workspace ${workspaceId}`);

    const proc = this.processes.get(workspaceId);

    if (proc) {
      // 优雅关闭
      proc.kill('SIGTERM');

      // 等待 5 秒
      await this.sleep(5000);

      // 如果还在运行，强制关闭
      if (!proc.killed) {
        proc.kill('SIGKILL');
      }

      this.processes.delete(workspaceId);
    }

    this.logger.log(`Dev server stopped for workspace ${workspaceId}`);
  }

  /**
   * 获取开发服务器状态
   * @param containerPort 容器内部端口（dev server 监听的端口），用于检测服务是否运行
   */
  async getDevServerStatus(
    workspaceId: string,
    workspaceCodeDir: string,
    containerPort?: number,
  ): Promise<DevServerStatus> {
    const devServerDir = path.join(workspaceCodeDir, '..', '.dev-server');
    const pidFile = path.join(devServerDir, 'pid');
    const portFile = path.join(devServerDir, 'port');

    // 检查进程是否在内存中
    const proc = this.processes.get(workspaceId);
    if (proc && !proc.killed) {
      return {
        workspaceId,
        running: true,
        pid: proc.pid,
        port: parseInt(await fs.readFile(portFile, 'utf-8'), 10),
      };
    }

    // 检查 pid 文件
    if (await fs.pathExists(pidFile)) {
      const pid = parseInt(await fs.readFile(pidFile, 'utf-8'), 10);
      const isRunning = this.isProcessRunning(pid);

      if (isRunning) {
        return {
          workspaceId,
          running: true,
          pid,
          port: parseInt(await fs.readFile(portFile, 'utf-8'), 10),
        };
      } else {
        // 进程已停止，清理 pid 文件
        await fs.remove(pidFile);
      }
    }

    // 检查 Docker 容器状态（服务重启后内存状态丢失，但容器可能仍在运行）
    const containerId =
      await this.containerManager.findContainerByWorkspace(workspaceId);
    if (containerId) {
      try {
        const containerStatus =
          await this.containerManager.getContainerStatus(containerId);
        if (containerStatus === 'running') {
          // 从 port 文件读取端口
          let port: number | undefined;
          if (await fs.pathExists(portFile)) {
            port = parseInt(await fs.readFile(portFile, 'utf-8'), 10);
          }
          // 检测容器内端口是否在监听
          const checkPort = containerPort || 3000;
          const isDevServerRunning = await this.checkContainerPortListening(
            containerId,
            checkPort,
          );

          if (isDevServerRunning) {
            this.logger.log(
              `Found running dev server in container ${containerId} for workspace ${workspaceId} on port ${checkPort}`,
            );

            return {
              workspaceId,
              running: true,
              port,
              command: `docker container: ${containerId.substring(0, 12)}`,
            };
          } else {
            this.logger.log(
              `Container ${containerId} is running but dev server is not listening on port ${checkPort}`,
            );
          }
        }
      } catch (error: unknown) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `Failed to check container status for workspace ${workspaceId}: ${errorMessage}`,
        );
      }
    }

    return {
      workspaceId,
      running: false,
    };
  }

  /**
   * 检查开发服务器健康状态
   */
  async checkHealth(port: number): Promise<boolean> {
    return (await this.checkPortAvailable(port)) === false; // 端口被占用说明服务正在运行
  }

  /**
   * 获取开发服务器日志
   */
  async getDevServerLogs(
    workspaceCodeDir: string,
    lines: number = 100,
  ): Promise<{ stdout: string; stderr: string }> {
    const devServerDir = path.join(workspaceCodeDir, '..', '.dev-server');
    const stdoutLog = path.join(devServerDir, 'stdout.log');
    const stderrLog = path.join(devServerDir, 'stderr.log');

    const stdout = await this.readLastLines(stdoutLog, lines);
    const stderr = await this.readLastLines(stderrLog, lines);

    return { stdout, stderr };
  }

  // ==================== 私有方法 ====================

  /**
   * 检测包管理器
   */
  private async detectPackageManager(
    codeDir: string,
  ): Promise<'npm' | 'pnpm' | 'yarn'> {
    // 检查 lock 文件
    if (await fs.pathExists(path.join(codeDir, 'pnpm-lock.yaml'))) {
      return 'pnpm';
    }
    if (await fs.pathExists(path.join(codeDir, 'yarn.lock'))) {
      return 'yarn';
    }
    if (await fs.pathExists(path.join(codeDir, 'package-lock.json'))) {
      return 'npm';
    }

    // 检查 package.json 的 packageManager 字段
    const packageJsonPath = path.join(codeDir, 'package.json');
    if (await fs.pathExists(packageJsonPath)) {
      const packageJson = (await fs.readJSON(
        packageJsonPath,
      )) as PackageJsonWithPackageManager;
      if (typeof packageJson.packageManager === 'string') {
        if (packageJson.packageManager.startsWith('pnpm')) return 'pnpm';
        if (packageJson.packageManager.startsWith('yarn')) return 'yarn';
      }
    }

    // 默认使用 npm
    return 'npm';
  }

  /**
   * 构建启动命令
   */
  private buildCommand(
    packageManager: 'npm' | 'pnpm' | 'yarn',
    command: string,
  ): { cmd: string; args: string[] } {
    // 将提取出的 "dev --port 3000" 拆分成 ["dev", "--port", "3000"]
    // 以防止 spawn 将其视为单个参数而导致找不到脚本
    const commandArgs = command.trim().split(/\s+/).filter(Boolean);

    switch (packageManager) {
      case 'pnpm':
        return { cmd: 'pnpm', args: [...commandArgs] };
      case 'yarn':
        return { cmd: 'yarn', args: [...commandArgs] };
      case 'npm':
      default:
        return { cmd: 'npm', args: ['run', ...commandArgs] };
    }
  }

  /**
   * 解析脚本名称
   * 从完整命令中提取脚本名称
   *
   * @param fullCommand - 完整命令(如 "npm run dev")或脚本名称(如 "dev")
   * @returns 脚本名称(如 "dev")
   *
   * @example
   * parseScriptName("npm run dev") // => "dev"
   * parseScriptName("pnpm dev") // => "dev"
   * parseScriptName("yarn dev") // => "dev"
   * parseScriptName("dev") // => "dev"
   */
  private parseScriptName(fullCommand: string): string {
    // 如果是简单的脚本名称(不包含空格),直接返回
    if (!fullCommand.includes(' ')) {
      return fullCommand;
    }

    // 1. 尝试匹配 "xxx run yyy" 格式 (支持 npm/pnpm/yarn)
    // 必须最先匹配，防止 "yarn run dev" 被下面的逻辑匹配成 "run"
    // 使用 .+ 捕获后续所有参数
    const runMatch = fullCommand.match(/(?:npm|pnpm|yarn)\s+run\s+(.+)/);
    if (runMatch) {
      return runMatch[1].trim();
    }

    // 2. 尝试匹配 "xxx yyy" 格式 (支持 npm/pnpm/yarn，如 "yarn dev", "npm start")
    const simpleMatch = fullCommand.match(/(?:npm|pnpm|yarn)\s+(.+)/);
    if (simpleMatch) {
      const script = simpleMatch[1].trim();
      // 避免误匹配 "run" (理论上第一步已经处理了 run，双重保险)
      if (script !== 'run' && !script.startsWith('run ')) {
        return script;
      }
    }

    // 如果都不匹配,返回原始命令(可能用户自定义了命令格式)
    this.logger.warn(
      `Unable to parse script name from command: "${fullCommand}", using as-is`,
    );
    return fullCommand;
  }

  /**
   * 检查端口是否可用
   */
  private async checkPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer();

      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          resolve(false); // 端口被占用
        } else {
          resolve(true);
        }
      });

      server.once('listening', () => {
        server.close();
        resolve(true); // 端口可用
      });

      server.listen(port);
    });
  }

  /**
   * 等待服务器就绪
   */
  private async waitForServerReady(
    port: number,
    timeout: number = 60000,
  ): Promise<void> {
    const startTime = Date.now();
    const checkInterval = 1000; // 每秒检查一次

    while (Date.now() - startTime < timeout) {
      const isReady = await this.checkHealth(port);
      if (isReady) {
        return;
      }
      await this.sleep(checkInterval);
    }

    throw new Error(`Dev server did not start within ${timeout}ms`);
  }

  /**
   * 检查容器内端口是否在监听（单次检测，不等待）
   * 用于快速判断开发服务器是否在运行
   */
  private async checkContainerPortListening(
    containerId: string,
    containerPort: number,
  ): Promise<boolean> {
    try {
      const checkCmd = `docker exec ${containerId} nc -z 127.0.0.1 ${containerPort}`;
      await execAsync(checkCmd, { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 等待容器内端口就绪（通过 docker exec 检测）
   * 用于 Docker 环境中检测未映射到宿主机的容器端口
   */
  private async waitForContainerPortReady(
    containerId: string,
    containerPort: number,
    timeout: number = 60000,
  ): Promise<void> {
    const startTime = Date.now();
    const checkInterval = 1000; // 每秒检查一次

    while (Date.now() - startTime < timeout) {
      try {
        // 使用 netcat 检测端口是否在监听（需要在 Dockerfile 中安装 netcat-openbsd）
        const checkCmd = `docker exec ${containerId} nc -z 127.0.0.1 ${containerPort}`;
        await execAsync(checkCmd, { timeout: 5000 });
        // nc -z 成功返回 exit code 0，表示端口在监听
        this.logger.log(`Container port ${containerPort} is ready`);
        return;
      } catch (error: unknown) {
        // 检测失败，继续等待
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        this.logger.debug(`Port check failed, retrying... (${errorMessage})`);
      }

      await this.sleep(checkInterval);
    }

    // 超时时，尝试获取 dev-server.log 的内容以便调试
    try {
      const logCmd = `docker exec ${containerId} sh -c "cat /tmp/dev-server.log 2>/dev/null | tail -50"`;
      const { stdout: logContent } = await execAsync(logCmd, { timeout: 5000 });
      if (logContent.trim()) {
        this.logger.error(`Dev server log (last 50 lines):\n${logContent}`);
      }
    } catch {
      this.logger.warn('Could not read dev-server.log');
    }

    throw new Error(`Dev server did not start within ${timeout}ms`);
  }

  /**
   * 检查进程是否在运行
   */
  private isProcessRunning(pid: number): boolean {
    try {
      // 发送信号 0 检查进程是否存在
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 读取文件的最后 N 行
   */
  private async readLastLines(
    filePath: string,
    lines: number,
  ): Promise<string> {
    if (!(await fs.pathExists(filePath))) {
      return '';
    }

    const content = await fs.readFile(filePath, 'utf-8');
    const allLines = content.split('\n');
    const lastLines = allLines.slice(-lines);
    return lastLines.join('\n');
  }

  /**
   * 睡眠
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * 清理所有开发服务器
   */
  async cleanup(): Promise<void> {
    this.logger.log('Cleaning up all dev servers');

    const workspaceIds = Array.from(this.processes.keys());

    for (const workspaceId of workspaceIds) {
      await this.stopDevServer(workspaceId);
    }

    this.logger.log('All dev servers cleaned up');
  }
}
