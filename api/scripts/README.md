# scripts/

| 脚本 | 用途 |
|------|------|
| `gen-channels.py` | 从 OpenClaw 配置 + 各上游实时探测，生成 `channels.json`（渠道清单，不含价格） |
| `slch-cost-calibration.py` | **SLCH 真实进货价标定**：三法互验（账单日志回归 / 三点实验 / billing_expr 反解），输出成本对照表 |
| `slch_cost_calibration.json` | 标定结果：各模型 SLCH 进价（USD/1M）vs 平台售价 + 回收率 |
| `calibrate-cost.py` | 三点标定实验脚本（对任意 OpenAI 兼容上游实测单价） |

## 标定方法（slch-cost-calibration）

1. **账单日志回归**（免费、样本大）：`GET /api/log/self` 拉全量账单，按模型对 `(prompt, completion) → quota` 做最小二乘 → 每 token 单价，R² 常达 1.000
2. **三点标定实验**：`max_tokens=1`，只变 prompt 长度，三点解输入/输出单价（三点全部命中）
3. **公式反解**：`GET /api/pricing` 的 `billing_expr`（如 `glm-5.2 = p*8 + c*28`）直接给每 1M 单价

## 记账单位（关键）

| | quota → 钱 | 说明 |
|--|--|--|
| **SLCH** | `500000 quota = ¥1` | 控制台余额 ¥937.49 对 quota 468,747,655 实证；微信充值 ¥100 记录 |
| **本平台** | `500000 quota = $1` | New-API 惯例 |

⚠️ 两边同为 500000 记账，但 **SLCH 记人民币、我们记美元**，币种口径差 7.3 倍（¥7.3=$1）。比价时必须换算。

## 注意

- SLCH 对本账号有 **agent 渠道折扣**（0.65 / 0.88 等），标定结果是**实付净价**
- `deepseek-v4.1-flash` 有**时段倍率**：9:00-12:00、14:00-18:00（Asia/Shanghai）翻倍
- `Qwen3.8-27B` 等模型 SLCH **未定价**，调用不计费（不能当便宜渠道长期用）
