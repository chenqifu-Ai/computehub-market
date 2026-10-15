# 算力商城 (Compute Market)

分布式算力交易平台前端工程。独立 Node.js 服务，带用户注册/登录。

## 技术栈

- **后端**: Node.js 22（纯内置模块，零 npm 依赖）
  - `node:http` HTTP 服务 + 反向代理（转发 `/api/v1/*` 到 ComputeHub Gateway）
  - `node:sqlite` SQLite 存储（用户 + 会话）
  - `node:crypto` scrypt 密码哈希 + 随机 token
- **前端**: 原生 HTML/CSS/JS（`public/` 静态文件）

## 目录结构

```
market/
├── server.js          # 后端入口（注册/登录/会话 + 反代 + 本地报价 + 静态文件）
├── start.sh           # 启动脚本（端口/上游环境变量）
├── market.db          # SQLite 数据库（首次启动自动创建）
├── logs/              # 运行日志
├── public/            # 前端静态文件
│   ├── index.html     # 登录/注册 + 主界面
│   ├── app.js         # 前端逻辑
│   └── style.css      # 样式
├── package.json
└── README.md
```

## 启动

```bash
./start.sh
# 或
PORT=58880 HOST=0.0.0.0 UPSTREAM=http://127.0.0.1:8282 node server.js
```

**端口**: `58880`（PORT-STD-001 预留段 `58000-59000`，ufw 已整段放行）

**访问**: `http://36.250.122.43:58880` （公网） / `http://127.0.0.1:58880` （本机）

### systemd 托管（生产）

```bash
sudo systemctl status  computehub-market     # 查看状态
sudo systemctl restart computehub-market     # 重启
sudo systemctl enable  computehub-market     # 开机自启（已启用）
```

单元文件: `/etc/systemd/system/computehub-market.service`

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `5800` | 监听端口（生产用 58880）|
| `HOST` | `127.0.0.1` | 监听地址（生产用 0.0.0.0）|
| `DB_PATH` | `./market.db` | SQLite 路径 |
| `UPSTREAM` | `http://127.0.0.1:8282` | ComputeHub Gateway 地址 |

## API

### 本服务自有

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /api/register | 注册 `{username, password}` |
| POST | /api/login | 登录 `{username, password}` → 返回 token |
| GET | /api/me | 校验 token → 返回当前用户 |
| POST | /api/logout | 注销会话 |
| GET | /api/health | 健康检查 |
| GET | /api/config | 返回当前上游/端口配置 |
| POST | /api/v1/tasks/estimate | **本地报价**（复刻 `kernel.EstimateTokens`，不依赖上游）|

### 反向代理到 ComputeHub Gateway

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/v1/nodes/list | 集群算力节点 |
| POST | /api/v1/tasks/submit | 下单派发任务 |
| GET | /api/v1/tasks/detail | 订单进度 / 结算 |

> 前端只与本服务同源通信，浏览器不需要直连 8282，规避跨域与硬编码端口。

## 计量规则（token）

`1 token = 1 核 CPU × 1 分钟`，系数：CPU `1.0` / GPU `10.0`（每卡·分钟）/ LLM `0.02`（每千输入 token）/ IO `0.1`（每 100MB）。
报价 = 中点 `mid`，区间 `0.7×mid ~ 1.8×mid`，置信度 `0.6`。

## 安全说明

- 密码用 scrypt + 随机盐哈希，不存明文
- 会话 token 用 crypto.randomBytes 生成，存库可撤销（7 天 TTL）
- 当前为 MVP：无 HTTPS、无限流、无邮件验证，上线公网前需补全
