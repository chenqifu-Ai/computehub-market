# 算力商城 · AI 模型聚合网关 (ComputeHub API)

New-API 式中转站：**一个 OpenAI 兼容的 API 网关**，把多个上游模型源（SLCH / Ollama / 本地 GPU 节点…）
聚合在统一入口后面，配套 **多用户 + 令牌 + 渠道池 + 模型路由 + 计费 + 控制台**。

零 npm 依赖 —— 纯 Node.js 内置模块（`http` / `sqlite` / `crypto` / `fetch`）。

---

## ✨ 功能总览

| 模块 | 能力 |
|------|------|
| **推理中继** | `/v1/chat/completions` `/v1/completions` `/v1/embeddings` `/v1/audio/*`，支持 SSE 流式 |
| **多用户** | 注册/登录/会话（scrypt+盐）、角色（用户/管理员）、封禁、备注 |
| **令牌** | `sk-` 令牌：状态开关、金额额度、模型白名单、IP 白名单、过期时间、明文查看 |
| **渠道池** | 优先级 + 权重分流，**失败自动故障转移**，模型名映射 |
| **健康熔断** | 连续失败自动熔断 + 冷却 + half-open 探测；每 5min 主动探活 |
| **计费** | USD/1M tokens 价格表，优先上游真实 `usage`，扣费三方同步 |
| **限流** | 每令牌每分钟滑窗限流（可配），429 带 `Retry-After`，管理员豁免 |
| **充值** | 兑换码生成/兑换/禁用、每日签到 |
| **邀请返利** | 邀请码绑定，被邀请人消费按比例回馈邀请人 |
| **控制台** | 仪表盘/令牌/模型/日志(CSV导出)/充值/邀请/渠道/用户/设置/文档 |
| **系统设置** | 站点名、注册赠送、签到额度、限流阈值、返利比例、公告 |

---

## 🚀 快速开始

```bash
# 开发
PORT=58881 HOST=0.0.0.0 node server.js

# 生产（systemd，已配置开机自启）
sudo systemctl status  computehub-api
sudo systemctl restart computehub-api
```

**访问地址**

| 环境 | 地址 |
|------|------|
| 控制台 | `http://36.250.122.43:58881/` |
| API 根 | `http://36.250.122.43:58881/v1` |
| 本机   | `http://127.0.0.1:58881/` |

端口 `58881` 落在 PORT-STD-001 预留段 `58000-59000` 内，ufw 已整段放行。

**首个注册用户自动成为管理员**（赠 $5）。

---

## 🔑 接入方式（OpenAI 兼容，改 base_url 即可）

```bash
curl http://36.250.122.43:58881/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-你的令牌" \
  -d '{
    "model": "deepseek-v4-flash",
    "messages": [{"role":"user","content":"你好"}],
    "stream": false
  }'
```

```python
from openai import OpenAI
client = OpenAI(base_url="http://36.250.122.43:58881/v1", api_key="sk-你的令牌")
r = client.chat.completions.create(
    model="deepseek-v4-flash",
    messages=[{"role": "user", "content": "你好"}],
)
print(r.choices[0].message.content)
```

---

## 📡 端点

### OpenAI 兼容（需 `sk-` 令牌）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET  | `/v1/models` | 列出令牌可见模型 |
| POST | `/v1/chat/completions` | 对话补全（支持 `stream`） |
| POST | `/v1/completions` | 文本补全 |
| POST | `/v1/embeddings` | 向量 |
| POST | `/v1/audio/*` | 语音（透传） |

### 控制台 API（需登录会话）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/user/register` | 注册（**首个用户自动成为管理员**，赠 $5） |
| POST | `/api/user/login` | 登录 → 会话 token |
| GET  | `/api/user/self` | 当前用户信息 + 余额 |
| GET  | `/api/user/dashboard` | 仪表盘统计 |
| GET/POST | `/api/token/` | 列出 / 新建令牌 |
| POST | `/api/token/delete` | 删除令牌 |
| GET  | `/api/token/key?id=` | 查看令牌明文 Key |
| GET  | `/api/log/self` | 使用日志（分页） |
| GET  | `/api/log/model` | 按模型统计 |
| GET  | `/api/models` | 公开模型目录 |
| GET  | `/api/pricing` | 模型价格表 |
| GET  | `/api/channel/` | 渠道列表（仅管理员） |
| POST | `/api/channel/models` | 探测上游可用模型 |
| GET  | `/api/admin/stats` | 全站统计（仅管理员） |

---

## 💰 计费规则

- 基准：**`quota = 美元 × 500000`**（New-API 惯例）
- 单价表：`pricing.json`，单位 **USD / 1M tokens**，未列出的模型走 `default`
- **优先采用上游返回的真实 `usage`**；上游不给 usage 时按字符估算兜底
  - 中文 ≈ 1 token/字，英文 ≈ 1 token/4 字符
- 扣费三方同步：用户余额 → 令牌用量 → 渠道用量，并写入 `logs`

---

## 🔌 渠道池（channels.json）

每个渠道一条记录，`priority` 越大越优先，同一优先级内按 `weight` 随机分流；**失败自动故障转移到下一个渠道**。

```json
{
  "name": "SLCH 主站",
  "base_url": "https://www.slch.com/v1",
  "api_key": "sk-...",
  "models": ["deepseek-v4-flash", "Qwen3.8-27B"],
  "priority": 100,
  "weight": 3,
  "status": 1
}
```

**模型名映射**：若对外名与上游名不一致，用 `model_mapping`：
```json
"model_mapping": { "对外名": "上游真实名" }
```

**熔断参数**（环境变量）：
| 变量 | 默认 | 说明 |
|------|------|------|
| `CIRCUIT_FAILS` | 3 | 连续失败几次熔断 |
| `CIRCUIT_COOLDOWN_MS` | 60000 | 熔断冷却时长 |
| `CHANNEL_PROBE_MS` | 300000 | 主动探活间隔 |

**重新生成渠道配置**（会实时探测各上游可用模型）：
```bash
python3 gen-channels.py
sudo systemctl restart computehub-api
```

> ⚠️ `channels.json` 含真实密钥，已加入 `.gitignore`，**不入库**。
> 入库的是 `channels.example.json`（占位符）。

---

## 📁 目录结构

```
api/
├── server.js             # 入口：路由 + 控制台 API + 静态服务
├── lib/
│   ├── store.js          # SQLite 数据层（users/tokens/channels/logs）
│   ├── relay.js          # 中继核心（鉴权/渠道路由/转发/流式/计费）
│   └── billing.js        # 计费引擎（价格表/token 估算/quota 计算）
├── public/               # 控制台前端（原生 HTML/CSS/JS）
│   ├── index.html
│   ├── app.js
│   └── style.css
├── channels.json         # 渠道配置（含密钥，gitignored）
├── channels.example.json # 渠道配置模板
├── pricing.json          # 价格表
├── gen-channels.py       # 渠道配置生成脚本
├── start.sh              # 启动脚本
└── api.db                # SQLite（gitignored）
```

---

## 🛡️ 安全

- 密码 `scrypt` + 随机盐；会话 token `crypto.randomBytes`，7 天 TTL，可撤销
- 令牌以 `sha256(key)` 入库，明文仅在创建/查看时返回
- 令牌支持：状态开关、金额额度、模型白名单、IP 白名单、过期时间
- 用户维度：余额、分组、角色（1 用户 / 100 管理员）、封禁

### ⚠️ 上线公网前需补全

- [ ] HTTPS（当前 HTTP 明文）
- [ ] 登录/注册限流（当前限流仅作用于 `/v1/*`）
- [ ] 邮件验证 / 找回密码
- [ ] `channels.json` 密钥加密存储
- [ ] 在线支付充值（当前仅兑换码）
- [ ] 分组倍率（当前单 `default` 组）
