# DEMO 演示环境（算力商城 · 模拟数据）

> ⚠️ **本目录是独立的演示/压测环境，与生产库 `../api/api.db` 完全隔离。**
> 所有账号（`DEMO-*`）与调用日志都是**模拟数据**，不参与真实结算、不代表真实业绩。

## 为什么单独建一套

生产账号（如 `sutoukeji006`）的真实注册时间是 2026-10-16，如果把历史调用记录回填到
2026-06，日志时间就会早于账号创建时间 —— 无论怎么"拟真"，这在审计上就是伪造痕迹。
所以演示数据一律放在这套独立环境里：注册时间是演示设定、账号名带 `DEMO-` 前缀、
页面和导出文件都带 DEMO 水印，任何人拿到数据第一眼就知道是模拟的。

## 组成

| 项 | 值 |
|---|---|
| 端口 | `58883`（生产 58881，商城 58880） |
| 数据库 | `demo/api/demo.db`（生产是 `market/api/api.db`） |
| 服务 | `computehub-api-demo.service` |
| 账号 | `DEMO-admin`(管理员) / `DEMO-006`(演示主账号) / `DEMO-渠道A` / `DEMO-渠道B` / `DEMO-总部` |
| 统一密码 | `Demo!2026#demo` |
| 上游 key | **全部清空**（渠道仅用于展示模型目录，发起真实调用会失败） |
| 数据量（mid 档） | 580,728 单消费 + 1,742,184 行返佣，合计 232 万行 / 约 490MB |
| 时间跨度 | 2026-06-01 → 现在（143 天） |
| 累计消费 | $12,298.25（kimi-k3 70% / deepseek 系 20% / 其他 10%） |

## 生成 / 清除

```bash
cd /home/computehub/web/market/demo/api

# 只看测算，不写库
node scripts/gen-demo.js

# 写库（默认 mid = 58.5 万单）
node scripts/gen-demo.js --apply

# 其他档位
node scripts/gen-demo.js --apply --scale small    # 24 万单
node scripts/gen-demo.js --apply --scale large    # 96 万单（对标 005）

# 清空所有 source='demo' 的数据（保留账号）
node scripts/gen-demo.js --purge
```

脚本里有硬保险：`DB_PATH` 一旦指向生产库就直接 `exit 1`。

## 与生产的隔离点

1. **物理隔离**：独立目录、独立 db 文件、独立 systemd 服务、独立端口。
2. **数据标记**：每条日志 `source='demo'`，每笔流水 `request_id` 以 `demo:` 开头。
3. **视觉标记**：页面顶部橙色横幅、`<title>` 前缀 `DEMO · `、站名 `DEMO · 算力商城演示环境`、公告说明。
4. **导出标记**：文件名 `DEMO-*.xlsx`，汇总 sheet 首行 `DEMO 演示数据 · 非真实业务`，明细表头 `时间[DEMO演示数据]`。
5. **账号标记**：用户名 `DEMO-*`，`remark` 写明"演示种子账号，注册时间为演示设定"。
6. **无真实出账**：渠道 `api_key` 全空，`/v1/*` 调用必然失败，不会产生真实上游费用。

## 常用操作

```bash
sudo systemctl status  computehub-api-demo
sudo systemctl restart computehub-api-demo
tail -f logs/demo-server.log

# 登录拿 token
curl -s -X POST http://127.0.0.1:58883/api/user/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"DEMO-006","password":"Demo!2026#demo"}'
```

## 访问

- 本机：http://127.0.0.1:58883/
- 公网：http://36.250.122.43:58883/（ufw 已放行，标注 `DEMO api (simulation)`）

## 生成参数（可调）

| 参数 | 位置 | 说明 |
|---|---|---|
| 总单量 | `SCALES` | small/mid/large |
| 月度爬坡 | `MONTH_W` | 6月12% → 9-10月23% |
| 模型配比 | `MIX` | kimi-k3 70% / deepseek 20% / 其他 10% |
| 输入/输出/缓存 | `MIX[].in/ctx/h/out` | 单轮 token 与命中率 |
| 时段分布 | `HOUR_W` | 双峰 9-12 / 14-18，凌晨 0.3~0.6% |
| 工作日/周末 | `DOW_F` | 周末系数 0.42~0.58 |

期初充值额由消费额自动推算（111%），保证期末余额为正、账目自洽。
