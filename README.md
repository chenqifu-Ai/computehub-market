# 算力商城 (Compute Market)

分布式算力交易平台前端工程。独立 Node.js 服务，带用户注册/登录。

## 技术栈

- **后端**: Node.js 22（纯内置模块，零 npm 依赖）
  - `node:http` HTTP 服务
  - `node:sqlite` SQLite 存储（用户 + 会话）
  - `node:crypto` scrypt 密码哈希 + 随机 token
- **前端**: 原生 HTML/CSS/JS（`public/` 静态文件）

## 目录结构

```
market/
├── server.js          # 后端入口（注册/登录/会话 + 静态文件服务）
├── market.db          # SQLite 数据库（首次启动自动创建）
├── public/            # 前端静态文件
│   ├── index.html     # 登录/注册 + 主界面
│   ├── app.js         # 前端逻辑
│   └── style.css      # 样式
├── package.json
└── README.md
```

## 启动

```bash
node server.js
# 默认端口 5800，可用 PORT 环境变量覆盖
# PORT=8080 node server.js
```

访问 `http://127.0.0.1:5800`

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /api/register | 注册 `{username, password}` |
| POST | /api/login | 登录 `{username, password}` → 返回 token |
| GET | /api/me | 校验 token → 返回当前用户 |
| POST | /api/logout | 注销会话 |

## 安全说明

- 密码用 scrypt + 随机盐哈希，不存明文
- 会话 token 用 crypto.randomBytes 生成，存库可撤销
- 当前为 MVP：无 HTTPS、无限流、无邮件验证，上线公网前需补全
