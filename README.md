# LLMCraft

> Agent vs Agent 即时战略游戏 - 人类编写 Prompt，AI 生成代码来对战

![Version](https://img.shields.io/badge/version-0.1.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)

## 简介

LLMCraft 是一个最小可行产品 (MVP)，展示两个 AI Agent 在即时战略游戏中对战的场景。每个玩家通过 Prompt 控制 AI，AI 生成代码来指挥单位移动、攻击和生产。

## 技术栈

- **前端**: React + TypeScript + Vite + Canvas
- **后端**: Node.js + TypeScript + WebSocket
- **沙箱**: vm2（AI 代码隔离执行）
- **AI**: OpenAI API 兼容接口
- **包管理**: pnpm workspace

## 快速开始

### 环境要求

- Node.js 18+
- pnpm

### 安装

```bash
# 克隆仓库
git clone <repository-url>
cd llmcraft

# 安装依赖
pnpm install

# 配置环境变量
cp packages/server/.env.example packages/server/.env
# 编辑 .env 填入你的 API Key
```

### 配置说明

编辑 `packages/server/.env`:

```env
# 必填: API 密钥
OPENAI_API_KEY=your-api-key

# 可选: 模型名称 (默认: gpt-4o-mini)
OPENAI_MODEL=gpt-4o-mini

# 可选: 自定义 API 地址 (兼容 OpenAI API 格式的服务)
# OPENAI_BASE_URL=https://api.yourservice.com/v1

# 服务器端口 (默认: 3001)
PORT=3001
```

支持任意兼容 OpenAI API 格式的服务（Azure、本地模型、第三方代理等）。

### 运行

```bash
# 同时启动前后端
pnpm dev

# 访问 http://localhost:3000
# 点击"开始"按钮观看 AI 对战
```

或分开启动：

```bash
# 终端 1 - 后端
pnpm dev:server

# 终端 2 - 前端
pnpm dev:client
```

### 测试

```bash
# 运行单元测试
pnpm test
```

### 构建

```bash
# 构建所有包
pnpm build

# 单独构建
pnpm build:shared
pnpm --filter @llmcraft/server build
pnpm --filter @llmcraft/client build
```

## 游戏机制

### 地图

- 20×20 格子
- 对称布局的障碍物和资源点

### 单位

| 类型 | HP | 速度 | 攻击 | 造价 | 攻击范围 |
|-----|----|------|-----|------|---------|
| Worker | 50 | 1 | 5 | 50 | 0 (不能攻击) |
| Soldier | 100 | 1 | 15 | 80 | 1 (近战) |
| Scout | 30 | 2 | 5 | 30 | 0 (不能攻击) |

### 建筑

| 类型 | HP | 造价 | 功能 |
|-----|----|------|-----|
| HQ | 1000 | - | 核心建筑，被摧毁则失败 |
| Generator | 200 | 100 | 每 tick 生产 5 能量 |
| Barracks | 300 | 150 | 生产士兵 |

### 游戏流程

1. 双方各有一个 HQ、2 个 Worker、1 个 Soldier
2. 每 500ms 执行一个游戏 tick
3. AI 每 5 ticks 思考一次，生成代码
4. AI 代码在沙箱中执行，产生命令
5. 命令加入队列，在下一 tick 执行
6. 一方 HQ 被摧毁则游戏结束

### AI API

AI 可以通过全局对象控制游戏：

```javascript
// 移动单位
me.soldiers.forEach(s => s.moveTo({x: 10, y: 10}));

// 生产单位
if (me.resources.energy > 150) {
  const barracks = me.buildings.find(b => b.type === "barracks");
  if (barracks) barracks.spawnUnit("soldier");
}

// 攻击敌人
const nearestEnemy = utils.findClosestByRange(soldier, enemies);
if (nearestEnemy && utils.inRange(soldier, nearestEnemy, 1)) {
  soldier.attack(nearestEnemy.id);
}
```

## 项目结构

```
llmcraft/
├── packages/
│   ├── shared/          # 共享类型和常量
│   ├── server/          # Node.js 游戏服务器
│   └── client/          # React 前端
├── logs/                # 游戏回放日志
├── docs/                # 设计文档
├── package.json         # pnpm workspace 配置
├── pnpm-workspace.yaml  # pnpm workspace 定义
└── README.md            # 本文件
```

## 开发计划

- [x] MVP 核心游戏逻辑
- [x] AI 沙箱和 OpenAI 集成
- [x] WebSocket 实时通信
- [x] Canvas 可视化
- [ ] 回放系统
- [ ] 更多单位和建筑类型
- [ ] 地图编辑器
- [ ] 多人在线对战

## 贡献

欢迎提交 Issue 和 PR！

## License

MIT
