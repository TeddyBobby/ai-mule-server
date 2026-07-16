import { Injectable, Logger } from '@nestjs/common';
import chokidar, { FSWatcher } from 'chokidar';
import * as path from 'path';
import { AppWebSocketGateway } from '../../websocket/websocket.gateway';

/**
 * 文件监听服务
 * 监听工作空间文件变化并通过 WebSocket 推送通知
 */
@Injectable()
export class FileWatcherService {
  private readonly logger = new Logger(FileWatcherService.name);
  private watchers = new Map<string, FSWatcher>();

  constructor(private readonly wsGateway: AppWebSocketGateway) {}

  /**
   * 开始监听工作空间目录
   * @param workspaceId 工作空间ID
   * @param workspaceDir 工作空间代码目录路径
   */
  startWatching(workspaceId: string, workspaceDir: string): void {
    // 如果已经在监听，先停止
    if (this.watchers.has(workspaceId)) {
      this.logger.warn(`Workspace ${workspaceId} is already being watched`);
      this.stopWatching(workspaceId);
    }

    this.logger.log(
      `Starting to watch workspace ${workspaceId} at ${workspaceDir}`,
    );

    // 验证目录路径
    if (!workspaceDir || workspaceDir.trim() === '') {
      this.logger.error(
        `Cannot start watching: invalid directory path for workspace ${workspaceId}`,
      );
      return;
    }

    try {
      const watcher = chokidar.watch(workspaceDir, {
        ignored: [
          /(^|[\/\\])\../, // 忽略隐藏文件
          '**/node_modules/**', // 忽略 node_modules
          '**/dist/**', // 忽略构建产物
          '**/build/**', // 忽略构建目录
          '**/.git/**', // 忽略 git 目录
          '**/coverage/**', // 忽略测试覆盖率
          '**/*.log', // 忽略日志文件
          '**/tmp/**', // 忽略临时文件
          '**/temp/**',
          '**/.cache/**',
          '**/public/**', // 忽略公共资源
          '**/assets/**', // 忽略静态资源
          '**/.vscode/**',
          '**/.idea/**',
        ],
        persistent: true,
        ignoreInitial: true, // 忽略初始扫描
        awaitWriteFinish: {
          stabilityThreshold: 300, // 文件稳定后才触发事件
          pollInterval: 200,
        },
        // 使用轮询模式避免 EMFILE 错误
        usePolling: true, // 使用轮询而不是原生 watch
        interval: 1000, // 轮询间隔 1 秒
        binaryInterval: 2000, // 二进制文件轮询间隔
        depth: 8, // 限制目录深度
        ignorePermissionErrors: true,
      });

      // 监听文件添加
      watcher.on('add', (filePath) => {
        const relativePath = path.relative(workspaceDir, filePath);
        this.logger.debug(
          `File added: ${relativePath} in workspace ${workspaceId}`,
        );
        this.emitFileChange(workspaceId, relativePath, 'add');
      });

      // 监听文件修改
      watcher.on('change', (filePath) => {
        const relativePath = path.relative(workspaceDir, filePath);
        this.logger.debug(
          `File changed: ${relativePath} in workspace ${workspaceId}`,
        );
        this.emitFileChange(workspaceId, relativePath, 'change');
      });

      // 监听文件删除
      watcher.on('unlink', (filePath) => {
        const relativePath = path.relative(workspaceDir, filePath);
        this.logger.debug(
          `File deleted: ${relativePath} in workspace ${workspaceId}`,
        );
        this.emitFileChange(workspaceId, relativePath, 'unlink');
      });

      // 监听错误
      watcher.on('error', (error) => {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        const errorStack = error instanceof Error ? error.stack : undefined;
        this.logger.error(
          `Watcher error for workspace ${workspaceId}: ${errorMessage}`,
          errorStack,
        );
      });

      this.watchers.set(workspaceId, watcher);
      this.logger.log(`Successfully started watching workspace ${workspaceId}`);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      this.logger.error(
        `Failed to start watching workspace ${workspaceId}: ${errorMessage}`,
        errorStack,
      );
    }
  }

  /**
   * 停止监听工作空间
   * @param workspaceId 工作空间ID
   */
  async stopWatching(workspaceId: string): Promise<void> {
    const watcher = this.watchers.get(workspaceId);
    if (watcher) {
      this.logger.log(`Stopping watch for workspace ${workspaceId}`);
      await watcher.close();
      this.watchers.delete(workspaceId);
    }
  }

  /**
   * 通过 WebSocket 推送文件变化事件
   * @param workspaceId 工作空间ID
   * @param filePath 文件相对路径
   * @param changeType 变化类型
   */
  private emitFileChange(
    workspaceId: string,
    filePath: string,
    changeType: 'add' | 'change' | 'unlink',
  ): void {
    const event = {
      workspaceId,
      filePath,
      changeType,
      timestamp: new Date().toISOString(),
    };

    // 广播给所有订阅该工作空间的客户端
    this.wsGateway.broadcastMessage('file-changed', event);
    this.logger.debug(`Emitted file-changed event:`, event);
  }

  /**
   * 停止所有监听
   */
  async stopAll(): Promise<void> {
    this.logger.log('Stopping all watchers');
    const promises = Array.from(this.watchers.keys()).map((workspaceId) =>
      this.stopWatching(workspaceId),
    );
    await Promise.all(promises);
  }

  /**
   * 获取当前监听的工作空间数量
   */
  getWatchedCount(): number {
    return this.watchers.size;
  }
}
