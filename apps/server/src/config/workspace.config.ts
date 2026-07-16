import { registerAs } from '@nestjs/config';

export default registerAs('workspace', () => ({
  // 根目录 (可通过环境变量覆盖)
  rootDir: process.env.WORKSPACE_ROOT || '/data/workspaces',

  // 超时配置
  timeouts: {
    idle: parseInt(process.env.WORKSPACE_IDLE_TIMEOUT || '1800000', 10), // 30分钟 -> IDLE
    suspend: parseInt(process.env.WORKSPACE_SUSPEND_TIMEOUT || '7200000', 10), // 2小时 -> SUSPENDED
    archive: parseInt(process.env.WORKSPACE_ARCHIVE_TIMEOUT || '259200000', 10), // 3天 -> ARCHIVED
  },

  // 限制
  limits: {
    maxPerUser: parseInt(process.env.WORKSPACE_MAX_PER_USER || '10', 10),
  },

  // 路径模板
  // 注意: ${projectId} 实际使用项目的 tree_node 字段值（如 sycpb.front.brand-fe）
  paths: {
    // 项目相关
    projects: '${rootDir}/projects',
    projectBaseRepo:
      '${rootDir}/projects/${projectId}/base-repo',
    projectTemplates:
      '${rootDir}/projects/${projectId}/templates',
    projectSharedCache:
      '${rootDir}/projects/${projectId}/shared-cache',

    // 用户相关
    users: '${rootDir}/users',
    userBase: '${rootDir}/users/${userId}',
    userConfig: '${rootDir}/users/${userId}/config',
    userSsh: '${rootDir}/users/${userId}/config/ssh',
    userWorkspaces: '${rootDir}/users/${userId}/workspaces',
    userCache: '${rootDir}/users/${userId}/cache',
    userTemp: '${rootDir}/users/${userId}/temp',

    // 工作空间相关
    workspace:
      '${rootDir}/users/${userId}/workspaces/workspace-${workspaceId}',
    workspaceCode:
      '${rootDir}/users/${userId}/workspaces/workspace-${workspaceId}/code',
    workspaceMetadata:
      '${rootDir}/users/${userId}/workspaces/workspace-${workspaceId}/metadata.json',
    workspaceDevServer:
      '${rootDir}/users/${userId}/workspaces/workspace-${workspaceId}/.dev-server',
    workspaceBuilds:
      '${rootDir}/users/${userId}/workspaces/workspace-${workspaceId}/builds',
    workspaceLogs:
      '${rootDir}/users/${userId}/workspaces/workspace-${workspaceId}/logs',
    workspaceSnapshots:
      '${rootDir}/users/${userId}/workspaces/workspace-${workspaceId}/snapshots',

    // 容器相关
    containers: '${rootDir}/containers',
    containerMetadata: '${rootDir}/containers/container-${containerId}',

    // 全局缓存（所有用户共享，用于 pnpm store / npm cache / yarn cache）
    globalCache: '${rootDir}/global-cache',

    // 系统相关
    system: '${rootDir}/system',
    systemNginx: '${rootDir}/system/nginx',
    systemPorts: '${rootDir}/system/ports',
    systemLocks: '${rootDir}/system/locks',
    systemMetrics: '${rootDir}/system/metrics',
    systemAudit: '${rootDir}/system/audit',
  },
}));
