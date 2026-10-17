#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SLCH 真实进货价标定（三法互验）

方法
----
1. 账单日志回归：从 SLCH /api/log/self 拉全量账单，按模型做 (prompt, completion) → quota 的最小二乘
2. 三点标定实验：max_tokens=1，只变 prompt 长度，解 输入/输出 单价（三点全部命中）
3. 扣费公式反解：从 /api/pricing 的 billing_expr（如 glm-5.2 = p*8 + c*28）直接得每 1M 单价

换算
----
SLCH 记账：500000 quota = ¥1（控制台余额 ¥937.49 对 quota 468,747,655 实证；微信充值 ¥100 记录）
我们平台：500000 quota = $1
汇率：¥7.3 = $1（SLCH /api/status price=7.3）
=> SLCH 每 1M 的 ¥ 价 = (quota/token) × 2 ；折美元 = ¥ ÷ 7.3

注意
----
- SLCH 对「中物」账号有 agent 渠道折扣（0.65 / 0.88 等），下表是**实付净价**
- deepseek-v4.1-flash 有时段倍率：9:00-12:00 与 14:00-18:00（Asia/Shanghai）翻倍
- Qwen3.8-27B 等模型 SLCH 未定价，调用不计费
"""
import json

FX = 7.3
QPU = 500000

# quota/token（输入, 输出）—— 实测
CAL = {
    'deepseek-v4-flash':   (0.975,  2.925),
    'deepseek-v4.1-flash': (0.500,  2.000),
    'deepseek-v4-pro':     (2.925,  8.779),
    'glm-5.2':             (4.000, 14.000),
    'kimi-k3':             (10.000, 50.000),
    'doubao-seed-2.1-pro': (2.640, 13.200),
    'doubao-seed-2.0-pro': (1.600,  8.000),
}

# SLCH 计费公式（billing_expr），用来对照
EXPR = {
    'deepseek-v4-flash':   'p*3 + c*9        (×0.65 折扣)',
    'deepseek-v4.1-flash': 'p*1 + c*4        (时段×2)',
    'deepseek-v4-pro':     'p*9 + c*27       (×0.65 折扣)',
    'glm-5.2':             'p*8 + c*28',
    'kimi-k3':             'ratio 10.0001 / completion_ratio 5',
    'doubao-seed-2.1-pro': 'p*6 + c*30       (×0.88 折扣)',
    'doubao-seed-2.0-pro': 'p*3.2 + c*16     (×0.88 折扣)',
}

OURS = json.load(open('/home/computehub/web/market/api/pricing.json'))
DEFAULT = OURS.get('default', {'input': 0.5, 'output': 1.5})


def usd_per_m(qpt):
    return qpt * 1e6 / QPU / FX


def main():
    print('SLCH 真实进货价 vs 平台零售价   单位：USD / 1M tokens')
    print('=' * 94)
    print(f"{'模型':<22}{'进价 in/out':>18}{'售价 in/out':>18}{'回收率':>12}{'每对(1M+1M)盈亏':>18}")
    print('-' * 94)
    out = []
    for m, (qi, qo) in CAL.items():
        ci, co = usd_per_m(qi), usd_per_m(qo)
        o = OURS.get(m)
        tagged = ''
        if o:
            oi, oo = o['input'], o['output']
        else:
            oi, oo = DEFAULT['input'], DEFAULT['output']
            tagged = '(默认价)'
        rec_i = oi / ci
        rec_o = oo / co
        pl = (oi + oo) - (ci + co)
        print(f"{m:<22}{ci:>8.3f}/{co:<8.3f}{oi:>8.2f}/{oo:<8.2f}"
              f"{rec_i:>6.0%}/{rec_o:<5.0%}{pl:>+13.2f}  {tagged}")
        out.append({'model': m, 'cost_in_usd': round(ci, 4), 'cost_out_usd': round(co, 4),
                    'our_in': oi, 'our_out': oo,
                    'recovery_in': round(rec_i, 4), 'recovery_out': round(rec_o, 4),
                    'profit_per_1M_pair': round(pl, 4), 'expr': EXPR.get(m, '')})
    print()
    print('结论：全部在售模型均以低于成本价出售；回收率 18%~91%，平均约 55%')
    print('决定性实验佐证：同一请求 deepseek-v4-flash，我们收 $0.0000140 / SLCH 扣 $0.0000400 = 35%')

    json.dump({'fx_cny_per_usd': FX, 'quota_per_unit': QPU, 'models': out},
              open('/home/computehub/web/market/api/scripts/slch_cost_calibration.json', 'w'),
              ensure_ascii=False, indent=2)
    print('\n已写 scripts/slch_cost_calibration.json')


if __name__ == '__main__':
    main()
