# ============================================
# 通用工作空间镜像
# 内置 nvm，根据项目配置自动切换 Node 版本和包管理器
# 构建: docker build -t ai-mule/workspace:latest -f docker/workspace/Dockerfile .
# ============================================

FROM debian:bookworm-slim

# 配置国内镜像源并安装基础工具
RUN sed -i 's/deb.debian.org/mirrors.aliyun.com/g' /etc/apt/sources.list.d/debian.sources && \
    apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    git \
    openssh-client \
    netcat-openbsd \
    bash \
    && rm -rf /var/lib/apt/lists/*

# 安装 nvm（显式使用 bash 并确保 NVM_DIR 目录存在）
ENV NVM_DIR=/root/.nvm
RUN mkdir -p "$NVM_DIR" && \
    curl -fsSL -k https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash && \
    [ -f "$NVM_DIR/nvm.sh" ] && echo "nvm.sh installed successfully" || (echo "nvm.sh NOT found!" && ls -la "$NVM_DIR/" && exit 1)

# 配置 nvm 使用国内 Node 镜像源
ENV NVM_NODEJS_ORG_MIRROR=https://npmmirror.com/mirrors/node

# 预装默认 Node 18（作为 fallback）
RUN bash -c "source $NVM_DIR/nvm.sh && nvm install 18 && nvm alias default 18"

# 配置 npm 镜像源
RUN bash -c "source $NVM_DIR/nvm.sh && \
    npm config set registry https://registry.npmmirror.com/ && \
    npm config set strict-ssl false"

# 预装常用包管理器（pnpm@9 + yarn）
RUN bash -c "source $NVM_DIR/nvm.sh && \
    npm install -g pnpm@9 && \
    npm install -g yarn && \
    yarn config set strict-ssl false"

# 配置 git 全局用户信息
RUN git config --global user.name "ai-mule" && \
    git config --global user.email "ai-mule@local.dev"

# 环境变量
ENV NODE_TLS_REJECT_UNAUTHORIZED=0
ENV NODE_ENV=development

WORKDIR /workspace

# 入口脚本（由 Server 在容器启动后调用，自动初始化项目环境）
COPY docker/workspace/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# 验证安装
RUN bash -c "source $NVM_DIR/nvm.sh && \
    echo 'nvm:' && nvm --version && \
    echo 'node:' && node --version && \
    echo 'npm:' && npm --version && \
    echo 'pnpm:' && pnpm --version && \
    echo 'yarn:' && yarn --version"

CMD ["bash"]
