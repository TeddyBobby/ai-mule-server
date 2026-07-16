#!/bin/bash
# ============================================
# 工作空间环境初始化脚本
# 用法: docker exec <container> bash /entrypoint.sh <code_dir> [package_manager] [node_version]
# 参数:
#   code_dir        - 项目代码目录（如 /workspace/code）
#   package_manager - 包管理器（如 pnpm@9、pnpm@8、pnpm、yarn、npm）
#   node_version    - Node 版本（如 20、20.19.4，优先于代码检测）
# ============================================

set -e

source "$NVM_DIR/nvm.sh"

CODE_DIR=${1:-/workspace/code}
PKG_MGR_ARG=${2:-}
NODE_VER_ARG=${3:-}

echo "=== 初始化工作空间环境 ==="
echo "项目目录: $CODE_DIR"
[ -n "$PKG_MGR_ARG" ] && echo "指定包管理器: $PKG_MGR_ARG"
[ -n "$NODE_VER_ARG" ] && echo "指定 Node 版本: $NODE_VER_ARG"

# 辅助函数：优先使用已安装版本，不存在时才下载
nvm_use_or_install() {
  local ver="$1"
  # 兼容 v24 / V24 这类写法，统一转换为 24
  ver=$(printf '%s' "$ver" | sed -E 's/^[[:space:]]+|[[:space:]]+$//g; s/^[vV]([0-9].*)$/\1/')

  if [ -z "$ver" ]; then
    echo "Node 版本为空，跳过 nvm 切换"
    return
  fi

  if nvm use "$ver" 2>/dev/null; then
    echo "已切换到已安装的 Node $ver"
  else
    echo "Node $ver 未安装，正在下载..."
    nvm install "$ver"
  fi
}

# 辅助函数：确保包管理器已安装且版本匹配
# 参数: pkg_spec（如 pnpm@9、pnpm@8、pnpm、yarn）
ensure_package_manager() {
  local pkg_spec="$1"
  # 解析名称和版本（pnpm@9 → name=pnpm, version=9）
  local pkg_name="${pkg_spec%%@*}"
  local pkg_version="${pkg_spec#*@}"
  # 如果没有 @ 则 pkg_version == pkg_spec（无版本指定）
  [ "$pkg_version" = "$pkg_spec" ] && pkg_version=""

  if [ "$pkg_name" = "npm" ]; then
    echo "使用内置 npm"
    return
  fi

  # 检查是否已安装
  if command -v "$pkg_name" >/dev/null 2>&1; then
    local current_ver
    current_ver=$("$pkg_name" --version 2>/dev/null || true)
    local current_major="${current_ver%%.*}"

    if [ -z "$pkg_version" ]; then
      # 没指定版本，已安装就行
      echo "$pkg_name 已安装: v$current_ver"
      return
    elif [ "$current_major" = "$pkg_version" ]; then
      # 大版本匹配
      echo "$pkg_name@$pkg_version 已安装: v$current_ver"
      return
    else
      echo "$pkg_name 当前版本 v$current_ver，需要 @$pkg_version，重新安装..."
    fi
  else
    echo "$pkg_name 未安装，正在安装..."
  fi

  # 安装指定版本
  if [ -n "$pkg_version" ]; then
    npm install -g "${pkg_name}@${pkg_version}"
  else
    npm install -g "$pkg_name"
  fi
}

# ============================================
# 1. 检测并安装 Node 版本
# ============================================
NODE_INSTALLED=false

if [ -n "$NODE_VER_ARG" ]; then
  echo "使用传入的 Node 版本: $NODE_VER_ARG"
  nvm_use_or_install "$NODE_VER_ARG"
  NODE_INSTALLED=true
elif [ -f "$CODE_DIR/.nvmrc" ]; then
  echo "检测到 .nvmrc: $(cat "$CODE_DIR/.nvmrc")"
  cd "$CODE_DIR" && nvm_use_or_install "$(cat .nvmrc)"
  NODE_INSTALLED=true
elif [ -f "$CODE_DIR/.node-version" ]; then
  echo "检测到 .node-version: $(cat "$CODE_DIR/.node-version")"
  nvm_use_or_install "$(cat "$CODE_DIR/.node-version")"
  NODE_INSTALLED=true
elif [ -f "$CODE_DIR/package.json" ]; then
  # 从 engines.node 提取主版本号（>=18.19.0 → 18, ^20.0.0 → 20, ~16.14.0 → 16）
  NODE_VER=$(node -e "
    try {
      const v = require('$CODE_DIR/package.json').engines?.node;
      if (v) {
        const m = v.match(/(\d+)/);
        if (m) console.log(m[1]);
      }
    } catch(e) {}
  " 2>/dev/null || true)
  if [ -n "$NODE_VER" ]; then
    echo "检测到 package.json engines.node: $NODE_VER"
    nvm_use_or_install "$NODE_VER"
    NODE_INSTALLED=true
  fi
fi

if [ "$NODE_INSTALLED" = false ]; then
  echo "未检测到 Node 版本要求，使用默认版本: $(node --version)"
fi

# ============================================
# 2. 配置 npm 源和缓存路径
# ============================================
echo "配置 npm 镜像源和缓存..."
npm config set registry https://registry.npmmirror.com/
# 配置 npm 镜像源
npm config set registry https://registry.npmmirror.com
npm config set strict-ssl false

# 配置全局缓存目录（/global-cache 是宿主机持久化挂载，所有容器共享）
if [ -d "/global-cache" ]; then
  npm config set cache /global-cache/npm-cache
  echo "npm cache → /global-cache/npm-cache"
fi

# ============================================
# 3. 安装包管理器
# ============================================
if [ -n "$PKG_MGR_ARG" ]; then
  # 使用传入的包管理器参数
  ensure_package_manager "$PKG_MGR_ARG"
elif [ -f "$CODE_DIR/pnpm-lock.yaml" ]; then
  # 从 lockfileVersion 推断 pnpm 大版本
  LOCKFILE_VER=$(node -e "
    const fs = require('fs');
    const content = fs.readFileSync('$CODE_DIR/pnpm-lock.yaml', 'utf8');
    const m = content.match(/lockfileVersion:\\s*['\"]?(\\d+)/);
    if (m) console.log(m[1]);
  " 2>/dev/null || true)
  case "$LOCKFILE_VER" in
    9)  PNPM_MAJOR=9 ;;
    6|5) PNPM_MAJOR=8 ;;
    *)  PNPM_MAJOR=9 ;;
  esac
  echo "检测到 pnpm-lock.yaml (lockfileVersion=$LOCKFILE_VER)"
  ensure_package_manager "pnpm@$PNPM_MAJOR"
elif [ -f "$CODE_DIR/yarn.lock" ]; then
  ensure_package_manager "yarn"
else
  echo "使用默认包管理器: npm"
fi

# ============================================
# 4. 输出环境信息
# ============================================
echo ""
echo "=== 环境初始化完成 ==="
echo "Node: $(node --version)"
echo "npm:  $(npm --version)"
command -v pnpm >/dev/null 2>&1 && echo "pnpm: $(pnpm --version)" || true
command -v yarn >/dev/null 2>&1 && echo "yarn: $(yarn --version)" || true
