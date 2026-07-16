# AI Mule Server 🧠

云端 AI 代码修改平台后端服务 — 基于 NestJS，支持 Claude Agent SDK 驱动的代码分析和修改。

> A cloud-based AI code modification platform backend. Built with NestJS, powered by Claude Agent SDK.

## ✨ 核心能力

- **预览环境创建** — Git 克隆 → 依赖安装 → 容器启动 → Nginx 配置 → 预览 URL
- **AI Agent 集成** — Claude Agent SDK，支持 SSE 流式对话和工具调用
- **容器化隔离** — Docker 容器管理，多用户资源隔离
- **Git 身份管理** — SSH Key 管理，支持私有仓库克隆
- **动态端口分配** — 端口池管理
- **Nginx 动态配置** — 自动生成反向代理配置

## 🏗️ 技术栈

| 类别 | 技术 |
|------|------|
| 框架 | NestJS 11 |
| 数据库 | MySQL + TypeORM |
| 缓存 | Redis + ioredis |
| 容器 | Docker + dockerode |
| AI | Claude Agent SDK |
| 日志 | Winston |
| 文档 | Swagger |
| WebSocket | Socket.IO |
| 前端 | Vue 3 |

## 🚀 快速开始

### 环境要求

- Node.js 20+
- pnpm 9+
- Docker Desktop

### 安装

```bash
# 安装依赖
pnpm install

# 配置环境变量
cp .env.example .env
# 编辑 .env，设置 ANTHROPIC_API_KEY

# 创建 Docker 网络
docker network create ai-mule-network

# 启动基础服务（MySQL + Redis + Nginx）
docker compose up -d

# 启动后端
pnpm dev:server

# 启动前端（新终端）
pnpm dev:web
```

### 验证

```bash
# 健康检查
curl http://localhost:8080/ai_mule/web_api/v1/health

# API 文档
open http://localhost:3000/ai_mule/web_api/v1/docs
```

## 📁 项目结构

```
apps/
├── server/          # NestJS 后端
│   └── src/
│       ├── modules/
│       │   ├── agent/              # AI Agent 模块
│       │   ├── workspace/          # 工作空间管理
│       │   ├── container/          # 容器管理
│       │   ├── preview-environment/ # 预览环境
│       │   ├── project/            # 项目管理
│       │   ├── identity/           # Git 身份管理
│       │   ├── git/                # Git 操作
│       │   ├── server-manager/     # 服务管理（Nginx + Dev Server）
│       │   └── ...
│       └── config/
└── web/             # Vue 3 前端
```

## 📄 License

MIT
