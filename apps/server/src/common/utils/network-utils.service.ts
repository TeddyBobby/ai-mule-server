import { Injectable, Logger } from '@nestjs/common';
import * as os from 'os';

/**
 * 网络工具服务
 *
 * 提供网络相关的工具方法，如获取宿主机 IP 地址等
 */
@Injectable()
export class NetworkUtilsService {
  private readonly logger = new Logger(NetworkUtilsService.name);

  /**
   * 获取宿主机 IP 地址
   * 用于 Docker 容器内的 HMR WebSocket 连接、预览 URL 等
   *
   * 优先级:
   * 1. 环境变量 HOST_IP（Docker 环境必须配置）
   * 2. 内网 IP (10.x.x.x, 192.168.x.x, 172.16-31.x.x)
   * 3. 第一个非内部的 IPv4 地址
   * 4. 降级到 localhost
   */
  getHostIp(): string {
    // 1. 优先使用环境变量（Docker 环境必须配置）
    const envHostIp = process.env.HOST_IP;
    if (envHostIp) {
      this.logger.log(`Using HOST_IP from environment: ${envHostIp}`);
      return envHostIp;
    }

    const interfaces = os.networkInterfaces();

    // 打印所有网络接口信息，方便排查
    const allAddresses: string[] = [];
    for (const [name, iface] of Object.entries(interfaces)) {
      if (!iface) continue;
      for (const config of iface) {
        allAddresses.push(
          `${name}: ${config.address} (family=${config.family}, internal=${config.internal})`,
        );
      }
    }
    this.logger.log(`All network interfaces:\n  ${allAddresses.join('\n  ')}`);

    // 优先查找内网 IP (10.x.x.x, 192.168.x.x, 172.16-31.x.x)
    for (const name of Object.keys(interfaces)) {
      const iface = interfaces[name];
      if (!iface) continue;

      for (const config of iface) {
        // 跳过内部回环地址和 IPv6
        if (config.family === 'IPv4' && !config.internal) {
          const ip = config.address;

          // 检查是否为内网 IP
          if (
            ip.startsWith('10.') ||
            ip.startsWith('192.168.') ||
            /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ip)
          ) {
            this.logger.log(
              `Selected host IP (private): ${ip} (interface: ${name})`,
            );
            return ip;
          }
        }
      }
    }

    // 如果没有找到内网 IP，返回第一个非内部的 IPv4 地址
    for (const name of Object.keys(interfaces)) {
      const iface = interfaces[name];
      if (!iface) continue;

      for (const config of iface) {
        if (config.family === 'IPv4' && !config.internal) {
          this.logger.log(
            `Selected host IP (non-internal): ${config.address} (interface: ${name})`,
          );
          return config.address;
        }
      }
    }

    // 降级到 localhost
    this.logger.warn(
      'Could not detect host IP, falling back to localhost. Set HOST_IP env var to fix this.',
    );
    return 'localhost';
  }
}
