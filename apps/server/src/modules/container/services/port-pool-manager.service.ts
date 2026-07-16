import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import * as net from 'net';
import { PortAllocation } from '../entities/port-allocation.entity';

@Injectable()
export class PortPoolManagerService {
  private readonly logger = new Logger(PortPoolManagerService.name);
  /** 可分配的端口池（扁平化列表） */
  private readonly availablePorts: number[];

  constructor(
    @InjectRepository(PortAllocation)
    private portAllocationRepository: Repository<PortAllocation>,
    private configService: ConfigService,
  ) {
    // 可分配的端口范围: 2000-3000, 4000-5000, 6000-6100, 7000-9999
    this.availablePorts = this.buildPortPool();
    this.logger.log(
      `Port pool initialized with ${this.availablePorts.length} ports`,
    );
  }

  /**
   * 构建端口池
   * 可分配范围: 2000-3000, 4000-5000, 6000-6100, 7000-9999
   */
  private buildPortPool(): number[] {
    const ports: number[] = [];

    // 端口范围
    const ranges: [number, number][] = [
      [2000, 3000],
      [4000, 5000],
      [6000, 6100],
      [7000, 9999],
    ];

    for (const [start, end] of ranges) {
      for (let port = start; port <= end; port++) {
        ports.push(port);
      }
    }

    return ports;
  }

  /**
   * 分配端口
   */
  async allocatePort(workspaceId: string): Promise<number> {
    // 防御性检查：确保同一个 workspace 没有未释放的端口
    const existingAllocations = await this.portAllocationRepository.find({
      where: { workspaceId, isDeleted: false },
    });

    if (existingAllocations.length > 0) {
      const ports = existingAllocations.map((a) => a.port).join(', ');
      throw new Error(
        `Workspace ${workspaceId} already has allocated ports: ${ports}. Please release them first.`,
      );
    }

    // 从端口池中寻找未使用的端口
    const availablePort = await this.findAvailablePort();
    if (!availablePort) {
      throw new Error('端口池已耗尽');
    }

    // 记录端口分配
    await this.recordAllocation(availablePort, workspaceId);
    this.logger.log(
      `Allocated port ${availablePort} for workspace ${workspaceId}`,
    );

    return availablePort;
  }

  /**
   * 释放端口（软删除）
   */
  async releasePort(port: number): Promise<void> {
    // 标记为已删除（软删除）
    await this.portAllocationRepository.update({ port }, { isDeleted: true });

    this.logger.log(`Released port ${port}`);
  }

  /**
   * 根据 workspace ID 获取端口分配信息
   */
  async getPortByWorkspace(
    workspaceId: string,
  ): Promise<{ port: number; containerId: string | null } | null> {
    const allocation = await this.portAllocationRepository.findOne({
      where: { workspaceId, isDeleted: false },
    });

    if (!allocation) {
      return null;
    }

    return {
      port: allocation.port,
      containerId: allocation.containerId,
    };
  }

  /**
   * 根据 workspace ID 释放端口
   */
  async releasePortByWorkspace(workspaceId: string): Promise<void> {
    const allocations = await this.portAllocationRepository.find({
      where: { workspaceId, isDeleted: false },
    });

    if (allocations.length === 0) {
      this.logger.warn(`No port allocation found for workspace ${workspaceId}`);
      return;
    }

    for (const allocation of allocations) {
      await this.releasePort(allocation.port);
      this.logger.log(
        `Released port ${allocation.port} for workspace ${workspaceId}`,
      );
    }

    // 防御性检查：如果发现多个端口分配，记录警告
    if (allocations.length > 1) {
      this.logger.warn(
        `Found ${allocations.length} port allocations for workspace ${workspaceId}, released all`,
      );
    }
  }

  /**
   * 更新端口的容器 ID
   */
  async updatePortContainer(port: number, containerId: string): Promise<void> {
    const now = new Date();

    const result = await this.portAllocationRepository.update(
      { port, isDeleted: false },
      { containerId, lastUsedAt: now },
    );

    if (result.affected === 0) {
      throw new Error(`Port ${port} allocation not found or already deleted`);
    }

    this.logger.log(`Updated container ID for port ${port}: ${containerId}`);
  }

  /**
   * 检查端口是否正在使用
   */
  private async isPortInUse(port: number): Promise<boolean> {
    try {
      // 尝试绑定端口
      const server = net.createServer();
      const isAvailable = await new Promise<boolean>((resolve) => {
        server.once('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'EADDRINUSE') {
            resolve(true); // 端口被占用
          } else {
            resolve(false);
          }
        });

        server.once('listening', () => {
          server.close();
          resolve(false); // 端口可用
        });

        server.listen(port);
      });

      return isAvailable;
    } catch (error) {
      this.logger.warn(`Error checking port ${port}: ${error.message}`);
      return true; // 出错时保守认为端口不可用
    }
  }

  /**
   * 查找可用端口（顺序轮询）
   */
  private async findAvailablePort(): Promise<number | null> {
    // 1. 获取上次分配的端口，用于轮询优化
    const lastAllocation = await this.portAllocationRepository.findOne({
      where: { isDeleted: false },
      order: { createdAt: 'DESC' },
    });

    // 计算起始索引
    let startIndex = 0;
    if (lastAllocation) {
      const lastIndex = this.availablePorts.indexOf(lastAllocation.port);
      if (lastIndex !== -1) {
        startIndex = (lastIndex + 1) % this.availablePorts.length;
      }
    }

    // 2. 获取所有已分配的端口（未删除）
    const allocatedPorts = await this.portAllocationRepository.find({
      where: { isDeleted: false },
      select: { port: true, workspaceId: true } as any,
    });

    const allocatedPortSet = new Set(allocatedPorts.map((a) => a.port));

    // 3. 从起始索引轮询查找可用端口
    for (let i = 0; i < this.availablePorts.length; i++) {
      const index = (startIndex + i) % this.availablePorts.length;
      const port = this.availablePorts[index];

      // 跳过数据库中已分配的端口（未删除）
      if (allocatedPortSet.has(port)) {
        continue;
      }

      // 检查端口是否真的可用
      if (!(await this.isPortInUse(port))) {
        return port;
      }
    }

    return null; // 端口池已耗尽
  }

  /**
   * 记录端口分配
   */
  private async recordAllocation(
    port: number,
    workspaceId: string,
  ): Promise<void> {
    const now = new Date();

    // 检查是否存在已软删除的记录
    const existingRecord = await this.portAllocationRepository.findOne({
      where: { port },
    });

    if (existingRecord) {
      // 如果存在记录（可能是软删除的），重新激活它
      this.logger.log(
        `Port ${port} has existing record (isDeleted=${existingRecord.isDeleted}), reactivating`,
      );
      await this.portAllocationRepository.update(
        { port },
        {
          workspaceId,
          containerId: null,
          isDeleted: false,
          lastUsedAt: now,
        },
      );
    } else {
      // 如果不存在记录，创建新记录
      const allocation = this.portAllocationRepository.create({
        port,
        workspaceId,
        containerId: null,
        createdAt: now,
        lastUsedAt: now,
      });
      await this.portAllocationRepository.save(allocation);
    }
  }

  /**
   * 更新端口使用时间
   */
  private async updatePortUsage(
    port: number,
    workspaceId: string,
  ): Promise<void> {
    const now = new Date();

    await this.portAllocationRepository.update({ port }, { lastUsedAt: now });
  }

  /**
   * 获取端口池使用率
   */
  async getPortPoolUsage(): Promise<{
    total: number;
    allocated: number;
    available: number;
    usageRate: number;
  }> {
    const total = this.availablePorts.length;
    const allocated = await this.portAllocationRepository.count({
      where: { isDeleted: false },
    });
    const available = total - allocated;
    const usageRate = (allocated / total) * 100;

    return {
      total,
      allocated,
      available,
      usageRate: parseFloat(usageRate.toFixed(2)),
    };
  }

  /**
   * 清理无效的端口分配记录（定期任务）
   */
  async cleanupInvalidAllocations(): Promise<number> {
    const allocations = await this.portAllocationRepository.find({
      where: { isDeleted: false },
    });
    let cleanedCount = 0;

    for (const allocation of allocations) {
      // 如果端口实际上没有被使用，释放它
      if (!(await this.isPortInUse(allocation.port))) {
        await this.releasePort(allocation.port);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      this.logger.log(`Cleaned up ${cleanedCount} invalid port allocations`);
    }

    return cleanedCount;
  }
}
