# 🐵 Claude Key Proxy

**一个 Claude API Key 负载均衡代理，帮你管理多个 API Key，自动切换，榨干每一分额度。**

---

## 😤 解决什么问题？

用 Claude API 的人都遇到过：

- 一个 Key 用着用着突然 **429 限额了**，只能干等
- 手上有好几个 Key，但每次都要 **手动切换**，烦得要死
- 每天限额重置后，有的 Key 剩了一大堆没用完，**白白浪费**
- 想知道每个 Key 到底用了多少，**没有统一的地方看**

**Claude Key Proxy 一次性解决所有问题。**

---

## ✨ 核心功能

### 🔄 智能自动切换
- 优先使用 **剩余额度最少** 的 Key（避免日重置浪费）
- 遇到 429 限额 **自动秒切** 下一个 Key，调用方完全无感
- 所有 Key 都限额了？自动等待最快恢复的那个

### 📊 实时监控仪表盘
- Web 界面实时查看每个 Key 的 **消耗量、剩余额度、百分比进度条**
- 今日/总计 Token 消耗、费用估算、请求次数
- 每 5 分钟自动刷新额度数据，不用手动查
- 支持在线 **添加 / 删除 / 启用 / 禁用** Key

### 🎚️ 可视化额度控制
- 拖动滑块设置每个 Key 的 **日 Token 上限**
- 达到上限自动跳过，切到下一个 Key
- 方便测试和分配额度

### 🔐 安全认证
- 调用方需携带 `proxyToken` 才能使用代理
- 仪表盘有独立的 `adminToken` 登录保护
- API Key 不暴露给调用方，全部在代理端管理

---

## 🏗️ 架构

```
┌──────────────┐     ┌──────────────┐     ┌─────────────────┐
│  OpenClaw    │     │              │     │                 │
│  Claude Code │────▶│  Key Proxy   │────▶│  Anthropic API  │
│  其他工具    │     │  :9876       │     │                 │
└──────────────┘     └──────┬───────┘     └─────────────────┘
                            │
                     ┌──────┴───────┐
                     │   Dashboard  │
                     │   管理仪表盘  │
                     └──────────────┘
```

多台服务器 / 多台电脑都指向同一个代理，统一管理所有 Key。

---

## 🚀 快速开始

### 1. 安装

```bash
git clone https://github.com/你的用户名/claude-key-proxy.git
cd claude-key-proxy
npm install
```

### 2. 配置

编辑 `keys.json`：

```json
{
  "keys": [
    { "name": "账号1", "key": "sk-ant-api03-xxxx", "enabled": true },
    { "name": "账号2", "key": "sk-ant-api03-yyyy", "enabled": true },
    { "name": "账号3", "key": "sk-ant-api03-zzzz", "enabled": true }
  ],
  "settings": {
    "port": 9876,
    "adminToken": "你的管理密码",
    "proxyToken": "你的代理密码",
    "upstreamUrl": "https://api.anthropic.com"
  }
}
```

| 字段 | 说明 |
|------|------|
| `keys[].name` | Key 的名称（随便起，方便辨认） |
| `keys[].key` | Anthropic API Key（`sk-ant-api03-...`） |
| `keys[].enabled` | 是否启用 |
| `adminToken` | 登录仪表盘的密码 |
| `proxyToken` | 调用方认证密码（当作 API Key 用） |

### 3. 启动

```bash
# 直接运行
node server.js

# 或用 systemd（推荐生产环境）
sudo cp claude-key-proxy.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now claude-key-proxy
```

### 4. 访问仪表盘

打开 `http://你的服务器IP:9876/admin`，输入 `adminToken` 登录。

---

## 📡 接入方式

把原来指向 Anthropic 的地址改成代理地址，API Key 填 `proxyToken`。

### Claude Code

```bash
export ANTHROPIC_BASE_URL=http://你的服务器IP:9876
export ANTHROPIC_API_KEY=你的proxyToken
```

### OpenClaw

编辑 `~/.openclaw/config.yaml`：

```yaml
providers:
  anthropic:
    apiBase: http://你的服务器IP:9876
    apiKey: 你的proxyToken
```

### 其他兼容工具

任何支持自定义 Anthropic API Base URL 的工具都能直接接入：

- **Base URL**: `http://你的服务器IP:9876`
- **API Key**: `你的proxyToken`

---

## 📸 仪表盘截图

仪表盘功能：

- 📈 总览统计（今日请求、Token 消耗、费用估算）
- 🔑 每个 Key 的状态卡片（正常 / 限额中 / 已禁用）
- 📊 额度进度条（API 剩余额度 + 自定义日上限）
- 🎚️ 滑块设置日 Token 上限
- ➕ 在线添加 / 删除 Key
- 📋 最近请求日志

---

## 🔧 API 端点

| 端点 | 说明 |
|------|------|
| `GET /health` | 健康检查（无需认证） |
| `/*` | 代理到 Anthropic API（需 proxyToken） |
| `GET /admin` | 仪表盘页面 |
| `GET /admin/api/status` | Key 状态数据 |
| `GET /admin/api/logs` | 请求日志 |
| `POST /admin/api/keys` | 添加 Key |
| `PATCH /admin/api/keys/:name` | 修改 Key |
| `DELETE /admin/api/keys/:name` | 删除 Key |
| `POST /admin/api/probe` | 手动探测额度 |
| `POST /admin/api/reset` | 重置统计数据 |

Admin API 均需在 query 或 header 中携带 `adminToken`。

---

## 🧠 切换策略

```
1. 过滤掉已禁用、已限额、已达自定义上限的 Key
2. 从剩余额度已知的 Key 中，选 剩余最少 的（优先用尽，避免日重置浪费）
3. 如果没有额度数据，选今日消耗最少的
4. 所有 Key 都限额？等最快恢复的那个
5. 遇到 429 自动重试下一个 Key，调用方无感
```

---

## 📦 技术栈

- **Node.js** — 零框架，纯原生 `http` + `https` 模块
- **better-sqlite3** — 轻量持久化，无需外部数据库
- **单文件部署** — 一个 `server.js` + 一个 `dashboard.html`，没有构建步骤

---

## 📝 License

MIT
