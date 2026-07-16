/**
 * Git 错误解析工具
 *
 * 提供统一的 Git 错误信息解析和用户友好的错误提示
 */
export class GitErrorParser {
  /**
   * 解析 Git 操作错误信息
   */
  static parseGitError(errorMessage: string, gitlabHost?: string): string {
    // SSH 权限相关错误
    if (errorMessage.includes('Permission denied')) {
      return 'SSH Key 权限被拒绝。请确保已将公钥添加到 GitLab 账户中,并配置了正确的 Git 身份。';
    }

    // 主机密钥验证失败
    if (errorMessage.includes('Host key verification failed')) {
      return 'SSH 主机密钥验证失败。请检查 known_hosts 配置。';
    }

    // 仓库不存在或无权访问
    if (errorMessage.includes('Repository not found')) {
      return '仓库不存在或无访问权限。请检查 Git URL 和用户权限。';
    }

    // 主机名解析失败
    if (errorMessage.includes('Could not resolve hostname')) {
      const hostInfo = gitlabHost ? ` ${gitlabHost}` : '';
      return `无法解析主机名${hostInfo}。请检查网络连接和 GitLab 地址配置。`;
    }

    // 连接超时
    if (errorMessage.includes('timeout')) {
      return '操作超时。请检查网络连接或稍后重试。';
    }

    // 目标目录已存在
    if (errorMessage.includes('already exists')) {
      return '目标目录已存在。请使用不同的工作空间或删除现有目录。';
    }

    // 认证失败
    if (errorMessage.includes('Authentication failed')) {
      return '身份认证失败。请检查 SSH Key 配置和 GitLab 账户权限。';
    }

    // 网络连接问题
    if (
      errorMessage.includes('Connection refused') ||
      errorMessage.includes('Connection timed out')
    ) {
      return '无法连接到 Git 服务器。请检查网络连接和 GitLab 服务状态。';
    }

    // 返回通用错误信息
    return `Git 操作失败: ${errorMessage}`;
  }

  /**
   * 解析克隆错误
   */
  static parseCloneError(errorMessage: string): string {
    if (errorMessage.includes('Permission denied')) {
      return 'SSH Key 权限被拒绝。请确保已配置正确的 Git 身份。';
    }

    if (errorMessage.includes('Repository not found')) {
      return '仓库不存在或无访问权限。请检查 Git URL 和用户权限。';
    }

    // 分支不存在
    if (
      errorMessage.includes('Remote branch') &&
      errorMessage.includes('not found')
    ) {
      const branchMatch = errorMessage.match(/Remote branch (\S+) not found/);
      const branchName = branchMatch ? branchMatch[1] : '指定的分支';
      return `分支 "${branchName}" 在远程仓库中不存在。请检查分支名称是否正确，或留空使用默认分支。`;
    }

    // 另一种分支不存在的错误格式
    if (errorMessage.includes('did not match any file(s) known to git')) {
      return '指定的分支或引用不存在。请检查分支名称是否正确，或留空使用默认分支。';
    }

    if (errorMessage.includes('timeout')) {
      return '克隆超时。请检查网络连接或稍后重试。';
    }

    if (errorMessage.includes('already exists')) {
      return '目标目录已存在。请使用不同的工作空间或删除现有目录。';
    }

    return `克隆失败: ${errorMessage}`;
  }

  /**
   * 解析连接验证错误
   */
  static parseConnectionError(
    errorMessage: string,
    gitlabHost?: string,
  ): string {
    if (errorMessage.includes('Permission denied')) {
      return 'SSH Key 权限被拒绝。请确保已将公钥添加到 GitLab 账户中。';
    }

    if (errorMessage.includes('Host key verification failed')) {
      return 'SSH 主机密钥验证失败。请检查 known_hosts 配置。';
    }

    if (errorMessage.includes('Could not resolve hostname')) {
      const hostInfo = gitlabHost ? ` ${gitlabHost}` : '';
      return `无法解析主机名${hostInfo}。请检查网络连接和 GitLab 地址配置。`;
    }

    if (errorMessage.includes('timeout')) {
      return '连接超时。请检查网络连接和 GitLab 服务状态。';
    }

    return `Git 连接失败: ${errorMessage}`;
  }
}
