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
| **控制台** | 仪表盘/令牌/模型/日志/充值/邀请/个人设置/渠道/用户/设置/文档 |
| **Excel 导出** | 使用日志导出 `.xlsx`（明细 + 按模型汇总双 sheet），管理员可导全站 |
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
| GET  | `/api/log/export` | **导出 Excel**（双 sheet：明细 + 按模型汇总）；`?all=1` 仅管理员可导全站 |
| GET  | `/api/models` | 公开模型目录 |
| GET  | `/api/pricing` | 模型目录价格（含真实 input/output/cached + priced 标志 + default 价） |
| POST | `/api/pricing/update` | **改价**（仅管理员）`{model,input,output,cached?,peak?}` → 写 pricing.json + **热重载，无需重启**；cached 缺省=input×0.1；peak=true 启用默认高峰窗口(9-12/14-18 ×2) |

| POST | `/api/pricing/delete` | 删除某模型定价（仅管理员），回落 default |
| GET  | `/api/pricing/all` | 全部价格表（仅管理员，含未上架模型） |
| GET  | `/api/channel/` | 渠道列表（仅管理员） |
| POST | `/api/channel/models` | 探测上游可用模型：`{base_url, api_key}` 纯探测不落库；`{id, persist?}` 用渠道已存 key 探测并**覆盖写入该渠道 models**（仅管理员） |
| GET  | `/api/admin/stats` | 全站统计（仅管理员） |

---

## 💰 计费规则

- 基准：**`quota = 美元 × 500000`**（New-API 惯例）
  - ⚠️ **记账货币口径**：本平台 500000 quota = **$1 USD**（老大 2026-10-17 拍板，继续记 $）
  - 上游 SLCH 同样是 500000 quota，但记的是 **¥ 人民币** → 比价时 SLCH 成本需 **÷ 7.3** 折回 USD
- 单价表：**`pricing.json`**（单位 **USD / 1M tokens**，key = 对外模型名；未列出的走 `default`）
- **改价方式**：
  1. **控制台**（推荐）：模型目录页 → 每行「改价」按钮，或「+ 新增/修改定价」→ **立即生效，无需重启**
  2. **改文件**：编辑 `pricing.json` 后 `systemctl restart computehub-api`（启动时读盘）
  3. **API**：`POST /api/pricing/update {model,input,output,cached?}`（仅管理员，落盘 + 热重载）
- **三档计价**（对齐上游 SLCH）：`input`（非缓存输入）/ `output`（补全）/ `cached`（缓存读）
  - `quota = ((输入−缓存)×input价 + 补全×output价 + 缓存×cached价) / 1e6 × 500000`
  - 缓存读通常只占输入价的 2%~10%，**漏算缓存会导致对账两边偏差数十倍**
- **✅ 时段倍率（时变定价）**：对齐上游 SLCH，`deepseek-v4.1-flash` 等模型在 **9:00-12:00 / 14:00-18:00（Asia/Shanghai）按 ×2 计费**
  - 配置：`pricing.json` 里该模型加 `"peak": { "windows": [[9,12],[14,18]], "multiplier": 2 }`
  - 控制台「改价」弹窗可勾选「高峰时段倍率」，无需改文件
  - 计费时按**请求开始时刻**（Asia/Shanghai）自动选倍率；实测高峰保本比 1.019 ✅
  - ⚠️ 只有上游 expr 里带 `hour()` 的模型才有倍率（目前仅 `deepseek-v4.1-flash`），其他模型恒定价
- **优先采用上游返回的真实 `usage`**（含 `prompt_tokens_details.cached_tokens`）；上游不给 usage 时按字符估算兜底
  - 中文 ≈ 1 token/字，英文 ≈ 1 token/4 字符
- 扣费三方同步：用户余额 → 令牌用量 → 渠道用量，并写入 `logs`

### 📊 使用日志 Excel 导出

`GET /api/log/export` 返回 `.xlsx`（双 sheet，结构与 New-API/SLCH 导出对齐）：

- **Sheet1 使用日志**（明细，冻结首行）
  `时间 | 类型 | 用户 | 用户ID | 令牌名称 | 模型 | 输入token数 | 输出token数 | 花费金额 | 用时(秒) | 流式`
- **Sheet2 按模型汇总**
  `用户 | 用户ID | 令牌名称 | 令牌ID | 模型 | 请求次数 | 输入token数 | 输出token数 | 总token数 | 消费金额` + **合计行**

参数：`?days=N` 仅导最近 N 天；`?all=1` 导全站（**仅管理员**，非管理员自动降级为仅自己）。

> 通过 `lib/xlsx.js` 零依赖生成（zlib deflateRaw + 手写 ZIP），无需任何 npm 包。

---

## 📥 历史数据导入（从 SLCH / New-API 迁移）

```bash
# 干跑预览（不写库）
node import-logs.js /path/usage-logs-xxx.xlsx --dry-run

# 正式导入
node import-logs.js /path/usage-logs-xxx.xlsx

# 选项
node import-logs.js file.xlsx --user 指定用户名   # 强制归属某个用户
node import-logs.js file.xlsx --db /path/api.db   # 指定目标库
node import-logs.js file.xlsx --tag my-import     # 来源标记
```

**特性**：
- 保留**原始时间戳**（时间线连续）、**类型**（消费/充值/系统/管理）
- **幂等**：按 `(用户, 时间, 模型, 输入, 输出, 类型)` 去重，可重复执行
- 自动创建缺失的用户/令牌（自动建的用户**不可登录**，需管理员重置密码）
- 导入后**重算**用户 `used_quota` / `request_count`
- 导入记录标记 `channel_name='（历史导入）'` + `source=<tag>`，可追溯

> 导入前建议先备份：`cp api.db /tmp/api.db.bak-$(date +%Y%m%d-%H%M%S)`

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

### 💹 定价管理（控制台 UI）

模型目录页（`page-models`）既是**对外报价单**也是**改价入口**：

| 操作 | 说明 |
|------|------|
| **价格列** | 每行显示 `输入 $/1M` + `输出 $/1M`（取自 `pricing.json`，非 $0） |
| **定价状态** | 「已定价」= 显式定价；「默认价」= 未定价，按 `default` 算，悬停告知 |
| **改价**（管理员） | 行内按钮 → 改 input/output/cached → **立即生效，无需重启** |
| **去定价**（管理员） | 删除该模型显式价，回落 default |
| **+ 新增/修改定价** | 给任意模型（含未上架）定价，直接输模型名 |
| **查看全部价格表** | 列出 `pricing.json` 全部条目（62 条）+ default 价 |

> 💡 改价走 `POST /api/pricing/update`，内部 `billing.setPrice()` 写盘 `pricing.json` 并**热重载内存表**，不用重启服务。
> ⚠️ 手改 `pricing.json` 文件则需 `systemctl restart computehub-api` 才生效（启动时读盘）。

### 🚨 未定价模型告警（防静默亏损）

模型目录页顶部**自动比对**「在售模型」与「已定价模型」：

- 任何在售但**无显式定价**的模型 → 走 `default` 价 → **红色告警条 + 模型行标红闪烁「未定价」**
- 点「仅看未定价」一键筛出，逐个改价
- 接口：`GET /api/pricing` 返回 `alert: {unpriced_count, unpriced[], default}`

> 背景：新增上游渠道/模型后若不及时定价，会**静默按默认价计费造成亏损**（例：啊翀 9 个模型漏定价 → 单渠道单日净亏 $22.26）。
> 硬性建议：**新增渠道后立即为全部模型定价**，红标清零再收工。

### 🧪 上游缓存价校准工具

`scripts/calibrate-cache-price.py` —— 对指定上游渠道发长 prompt 逼出真实缓存命中，从上游用量接口反推 `cached` 单价并与本地对比（可 `--apply` 写回）：

```bash
python3 scripts/calibrate-cache-price.py --channel 8                     # 仅预览
python3 scripts/calibrate-cache-price.py --channel 8 --apply --mark 1.02 # 写回
```
凭据从环境变量 `SUB2_EMAIL`/`SUB2_PASS` 或本地（不入库）`.sub2-credentials.json` 读取。

### 🖥️ 渠道管理（控制台 UI）

渠道页支持：

| 操作 | 说明 |
|------|------|
| **新建渠道** | 弹窗填写；「模型列表」**可为空**（建完再同步），但为空时该渠道的模型不会出现在对外目录 |
| **🔍 探测上游并填充** | 弹窗内按钮：拉取上游 `/models` 并**回填到模型列表输入框**（不自动保存） |
| **编辑** | 弹窗编辑名称/地址/模型/优先级/权重/映射；**API Key 留空 = 不修改**（列表展示的是脱敏串） |
| **同步模型** | 列表按钮：用渠道已存 key 探测上游 `/models`，**直接覆盖落库**该渠道 models（有变化立即生效，无需重启） |
| 测试 / 启用禁用 / 删除 | 探活单个渠道（`/models` 探活 + 写 `tested_at`）/ 人工开关 / 删除 |

> 💡 **新建渠道后看不到模型？** 说明「模型列表」留空了 —— 点该行「同步模型」一键补齐即可。
> ⚠️ 「模型列表」留空的渠道在 `channelsForModel()` 里会被当成“通吃”所有模型，而在对外目录 `publicModelCatalog()` 里却**不可见**，两边逻辑不一致，建议始终填满。

---

## 📁 目录结构

```
api/
├── server.js             # 入口：路由 + 控制台 API + 静态服务
├── lib/
│   ├── store.js          # SQLite 数据层（users/tokens/channels/logs/redemptions/settings/checkins）
│   ├── relay.js          # 中继核心（鉴权/渠道路由/转发/流式/计费/返利）
│   ├── billing.js        # 计费引擎（价格表/token 估算/quota 计算）
│   ├── ratelimit.js      # 令牌级滑动窗口限流
│   ├── health.js         # 渠道健康检查 + 自动熔断 + 主动探活
│   ├── xlsx.js           # 零依赖 Excel 生成/读取器（手写 zip+XML）
├── public/               # 控制台前端（原生 HTML/CSS/JS）
│   ├── index.html
│   ├── app.js
│   └── style.css
├── channels.json         # 渠道配置（含密钥，gitignored）
├── channels.example.json # 渠道配置模板
├── pricing.json          # 价格表
├── gen-channels.py       # 渠道配置生成脚本
├── import-logs.js        # 【历史数据导入】把 SLCH/New-API usage-logs .xlsx 灌入本平台
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

### 🏢 代理指定渠道供应商（控制台 UI）

「代理管理」页每个用户点「设置」可选择**指定渠道供应商**：
- 该代理**及其名下所有成员**（沿上下级继承，取最近一个设了渠道的代理）的请求**强制走该渠道**
- 渠道不支持所请求模型 / 已禁用 / 熔断 → 直接 `503 channel_pinned_unavailable`（**不回退**到其他渠道）
- 选「不指定」= 走通用路由（优先级 + 权重 + 故障转移）

字段：`users.agent_channel_id`（0=不指定）；接口 `POST /api/admin/agent/set {user_id, agent_channel_id}`
