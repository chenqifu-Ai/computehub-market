#!/usr/bin/env python3
"""
calibrate-cache-price.py — 上游缓存价校准工具

用途：对某个上游渠道（默认啊翀 / transit.wingspire-ai.com:9021）的模型，
发两发相同长 prompt 逼出缓存命中，从上游用量接口反推真实 cached（缓存读）单价，
并与本地 pricing.json 对比，给出校准建议（可选 --apply 直接改价，按 --mark 保本倍率）。

背景：gpt-reserve 等模型的 cached 价最初是推断的（未观测到真实缓存命中）。
一旦上游有真实命中，用本工具即可校准。

用法：
  python3 calibrate-cache-price.py --channel 8                # 只校准该渠道全部模型
  python3 calibrate-cache-price.py --channel 8 --models gpt-reserve
  python3 calibrate-cache-price.py --channel 8 --apply --mark 1.02

上游账号（取用量用，非渠道 key）：
  email/password 从环境变量 SUB2_EMAIL / SUB2_PASS 读取，缺省用已记录账号。
"""
import json, os, sys, time, sqlite3, subprocess, argparse, urllib.request

API_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(API_DIR, 'api.db')
PRICING = os.path.join(API_DIR, 'pricing.json')

# 已知上游面板（Sub2API）：渠道 base_url → 面板根地址
# 凭据从环境变量（SUB2_EMAIL / SUB2_PASS）或本地未入库文件 api/.sub2-credentials.json 读取
PANEL = {
    'http://transit.wingspire-ai.com:9021': {
        'panel': 'http://transit.wingspire-ai.com:9021',
        'cred_id': 'transit.wingspire-ai.com:9021',
    },
}
CRED_FILE = os.path.join(API_DIR, '.sub2-credentials.json')


def load_cred(cred_id):
    email = os.environ.get('SUB2_EMAIL')
    password = os.environ.get('SUB2_PASS')
    if email and password:
        return email, password
    try:
        data = json.load(open(CRED_FILE))
        c = data.get(cred_id) or {}
        return c.get('email'), c.get('password')
    except Exception:
        return None, None


def q(sql, args=()):
    db = sqlite3.connect(f'file:{DB_PATH}?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    try:
        return [dict(r) for r in db.execute(sql, args)]
    finally:
        db.close()


def raw_db():
    return sqlite3.connect(DB_PATH)


def post_json(url, payload, headers=None, timeout=30):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, method='POST',
                                 headers={'Content-Type': 'application/json', **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def get_json(url, headers=None, timeout=30):
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def curl_chat(base, key, model, prompt, max_tokens=3, timeout=120):
    body = json.dumps({'model': model, 'messages': [{'role': 'user', 'content': prompt}],
                       'max_tokens': max_tokens, 'stream': False})
    out = subprocess.run(['curl', '-s', '--max-time', str(timeout),
                          base.rstrip('/') + '/v1/chat/completions',
                          '-H', 'Authorization: Bearer ' + key,
                          '-H', 'Content-Type: application/json', '-d', body],
                         capture_output=True, text=True).stdout
    try:
        j = json.loads(out)
        if 'error' in j:
            return None, str(j['error'])[:160]
        return j.get('usage') or {}, None
    except Exception:
        return None, out[:160]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--channel', type=int, default=8, help='渠道 id（默认 8 = 啊翀）')
    ap.add_argument('--models', default='', help='逗号分隔；缺省 = 该渠道全部模型')
    ap.add_argument('--apply', action='store_true', help='把测得的 cached 价写回 pricing.json')
    ap.add_argument('--mark', type=float, default=1.02, help='保本倍率（默认 1.02）')
    ap.add_argument('--rounds', type=int, default=3, help='每模型重复轮数（逼缓存）')
    args = ap.parse_args()

    ch = q('SELECT id,name,base_url,api_key,models FROM channels WHERE id=?', (args.channel,))
    if not ch:
        print(f'❌ 渠道 {args.channel} 不存在'); sys.exit(1)
    ch = ch[0]
    base, key = ch['base_url'], ch['api_key']
    conf = PANEL.get(base.rstrip('/')) or PANEL.get(base)
    if not conf:
        print(f'❌ 未知上游面板（{base}），无法读用量。请在脚本 PANEL 里登记。'); sys.exit(1)
    email, password = load_cred(conf['cred_id'])
    if not email or not password:
        print('❌ 缺少上游账号。设环境变量 SUB2_EMAIL/SUB2_PASS，或在 ' + CRED_FILE + ' 写入：')
        print('   {"%s": {"email": "...", "password": "..."}}' % conf['cred_id'])
        sys.exit(1)

    models = [m.strip() for m in (args.models.split(',') if args.models else (ch['models'] or '').split(',')) if m.strip()]
    print(f'渠道 #{ch["id"]} {ch["name"]}  模型 {len(models)} 个 → 缓存价校准\n')

    # 1) 登录上游拿用量 token
    try:
        j = post_json(conf['panel'] + '/api/v1/auth/login',
                      {'email': email, 'password': password})
        tok = j['data']['access_token']
        print(f'✓ 上游登录成功（余额 ${j["data"]["user"]["balance"]}）')
    except Exception as e:
        print(f'❌ 上游登录失败: {e}'); sys.exit(1)

    # 2) 逐模型打两发长 prompt，逼缓存命中
    filler = ('You are a meticulous assistant that always answers concisely. ' * 400).strip()
    prompt = filler + '\n\nReply with the single word: ok'
    print('\n逼缓存命中…')
    for m in models:
        g1, e1 = curl_chat(base, key, m, prompt)
        time.sleep(1.5)
        g2, e2 = curl_chat(base, key, m, prompt)
        det = (g2 or {}).get('prompt_tokens_details') or {}
        hit = det.get('cached_tokens')
        print(f'  {m:24s} {"✓ 命中 " + str(hit) if hit else ("✗ " + str(e1 or e2 or "未命中"))}')
        time.sleep(1.2)

    # 3) 拉上游用量，反推 cached 单价
    time.sleep(6)
    try:
        items = []
        for page in range(1, 8):
            jj = get_json(f'{conf["panel"]}/api/v1/usage?page={page}&page_size=100',
                          {'Authorization': 'Bearer ' + tok})
            its = (jj.get('data') or {}).get('items') or []
            if not its:
                break
            items += its
    except Exception as e:
        print(f'❌ 读用量失败: {e}'); sys.exit(1)

    measured = {}
    for x in items:
        m = x.get('model')
        if m not in models or m in measured:
            continue
        cr = x.get('cache_read_tokens') or 0
        cc = float(x.get('cache_read_cost') or 0)
        inp = x.get('input_tokens') or 0
        inc = float(x.get('input_cost') or 0)
        out_t = x.get('output_tokens') or 0
        outc = float(x.get('output_cost') or 0)
        if cr > 0 and cc > 0:
            measured[m] = {
                'cached': round(cc / cr * 1e6, 6),
                'input': round(inc / inp * 1e6, 6) if inp else None,
                'output': round(outc / out_t * 1e6, 6) if out_t else None,
            }

    print('\n=== 实测上游费率（有缓存命中的模型）===')
    if not measured:
        print('  （本轮无缓存命中，无法校准缓存价）'); sys.exit(0)

    pr = json.load(open(PRICING))
    mark = args.mark
    print(f'{"模型":24s} {"上游cached":>12s} {"本地cached":>12s} {"建议(×%.2f)" % mark:>14s}')
    changes = {}
    for m, v in measured.items():
        cur = (pr.get(m) or {}).get('cached')
        sug = round(v['cached'] * mark, 6)
        print(f'  {m:24s} {v["cached"]:12.6f} {str(cur):>12s} {sug:14.6f}')
        if cur is None or abs(cur - sug) > 1e-9:
            changes[m] = sug

    if not changes:
        print('\n✅ 本地 cached 价与上游一致，无需校准。'); return

    print(f'\n待校准 {len(changes)} 个: ' + ', '.join(changes))
    if not args.apply:
        print('（未加 --apply，仅预览。加 --apply 写回 pricing.json）'); return

    for m, sug in changes.items():
        pr.setdefault(m, {})
        pr[m]['cached'] = sug
    json.dump(pr, open(PRICING, 'w'), ensure_ascii=False, indent=2)
    open(PRICING, 'a').write('\n')
    print(f'✓ 已写回 {PRICING}（重启/热重载后生效）')


if __name__ == '__main__':
    main()
