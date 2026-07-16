import { registerAs } from '@nestjs/config';
import * as fs from 'fs';
import * as os from 'os';

function resolveDockerSocket(): string {
  if (process.env.DOCKER_SOCKET) {
    return process.env.DOCKER_SOCKET;
  }

  const socketCandidates = [
    '/var/run/docker.sock',
    `${os.homedir()}/.docker/run/docker.sock`,
  ];

  const existingSocket = socketCandidates.find(candidate =>
    fs.existsSync(candidate),
  );

  return existingSocket || socketCandidates[0];
}

export default registerAs('container', () => ({
  // Docker Socket 路径
  dockerSocket: resolveDockerSocket(),

  // 默认镜像
  defaultImage: process.env.CONTAINER_DEFAULT_IMAGE || 'node:18-slim',

  // 端口范围
  portRange: {
    start: parseInt(process.env.PORT_RANGE_START || '13000', 10),
    end: parseInt(process.env.PORT_RANGE_END || '13999', 10),
  },

  // 资源限制
  limits: {
    memory: process.env.CONTAINER_MEMORY || '2g',
    cpus: process.env.CONTAINER_CPUS || '1.0',
    pidsLimit: parseInt(process.env.CONTAINER_PIDS_LIMIT || '100', 10),
  },

  // 健康检查
  healthCheck: {
    interval: parseInt(process.env.HEALTH_CHECK_INTERVAL || '30000', 10), // 30s
    timeout: parseInt(process.env.HEALTH_CHECK_TIMEOUT || '10000', 10), // 10s
    retries: parseInt(process.env.HEALTH_CHECK_RETRIES || '3', 10),
    startPeriod: parseInt(process.env.HEALTH_CHECK_START_PERIOD || '60000', 10), // 60s
  },

  // 清理配置
  cleanup: {
    // 定期清理停止的容器
    cleanupInterval: parseInt(
      process.env.CONTAINER_CLEANUP_INTERVAL || '300000',
      10,
    ), // 5分钟
  },
}));
