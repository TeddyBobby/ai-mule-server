import { Injectable, Inject } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as path from 'path';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';

/**
 * 文件操作服务
 * 提供本地文件的读写操作
 */
@Injectable()
export class FileService {
  constructor(
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {}

  /**
   * 读取文件内容
   */
  async readFile(filePath: string): Promise<string> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      this.logger.info(`File read successfully: ${filePath}`, {
        context: 'FileService',
      });
      return content;
    } catch (error) {
      this.logger.error(`Failed to read file: ${filePath}`, {
        context: 'FileService',
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * 写入文件内容
   */
  async writeFile(filePath: string, content: string): Promise<void> {
    try {
      // 确保目录存在
      const dir = path.dirname(filePath);
      await fs.mkdir(dir, { recursive: true });

      await fs.writeFile(filePath, content, 'utf-8');
      this.logger.info(`File written successfully: ${filePath}`, {
        context: 'FileService',
      });
    } catch (error) {
      this.logger.error(`Failed to write file: ${filePath}`, {
        context: 'FileService',
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * 删除文件
   */
  async deleteFile(filePath: string): Promise<void> {
    try {
      await fs.unlink(filePath);
      this.logger.info(`File deleted successfully: ${filePath}`, {
        context: 'FileService',
      });
    } catch (error) {
      this.logger.error(`Failed to delete file: ${filePath}`, {
        context: 'FileService',
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * 检查文件是否存在
   */
  async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 创建目录
   */
  async createDirectory(dirPath: string): Promise<void> {
    try {
      await fs.mkdir(dirPath, { recursive: true });
      this.logger.info(`Directory created successfully: ${dirPath}`, {
        context: 'FileService',
      });
    } catch (error) {
      this.logger.error(`Failed to create directory: ${dirPath}`, {
        context: 'FileService',
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * 列出目录中的文件
   */
  async listFiles(dirPath: string): Promise<string[]> {
    try {
      const files = await fs.readdir(dirPath);
      return files;
    } catch (error) {
      this.logger.error(`Failed to list files in directory: ${dirPath}`, {
        context: 'FileService',
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * 获取文件信息
   */
  async getFileStats(filePath: string) {
    try {
      const stats = await fs.stat(filePath);
      return {
        size: stats.size,
        created: stats.birthtime,
        modified: stats.mtime,
        isFile: stats.isFile(),
        isDirectory: stats.isDirectory(),
      };
    } catch (error) {
      this.logger.error(`Failed to get file stats: ${filePath}`, {
        context: 'FileService',
        error: error.message,
      });
      throw error;
    }
  }
}
