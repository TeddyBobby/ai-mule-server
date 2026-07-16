/**
 * 业务状态码常量
 * status = 0 表示成功
 * status > 0 表示各种业务异常
 */

export const StatusCode = {
  // 成功
  SUCCESS: 0,

  // 通用错误 (1xxx)
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  INTERNAL_ERROR: 500,

  // 用户相关错误 (10xx)
  USER_NOT_FOUND: 1001,
  USER_ALREADY_EXISTS: 1002,
  USER_DISABLED: 1003,
  INVALID_PASSWORD: 1004,
  TOKEN_EXPIRED: 1005,
  TOKEN_INVALID: 1006,

  // 项目相关错误 (20xx)
  PROJECT_NOT_FOUND: 2001,
  PROJECT_ALREADY_EXISTS: 2002,
  PROJECT_PERMISSION_DENIED: 2003,

  // Agent 相关错误 (30xx)
  AGENT_NOT_FOUND: 3001,
  AGENT_ALREADY_EXISTS: 3002,
  AGENT_DISABLED: 3003,

  // 文件相关错误 (40xx)
  FILE_NOT_FOUND: 4001,
  FILE_UPLOAD_FAILED: 4002,
  FILE_TOO_LARGE: 4003,
  INVALID_FILE_TYPE: 4004,
} as const;

export type StatusCodeType = (typeof StatusCode)[keyof typeof StatusCode];
