#!/usr/bin/env python3
"""
gen-channels.py — 从本机 OpenClaw 配置 + 各上游实时探测，生成 channels.json
用法: python3 gen-channels.py
输出: channels.json（含真实密钥，已被 .gitignore 排除）
      channels.example.json（占位符，可入库）
"""
import json, urllib.request, os, sys

API_DIR = os.path.dirname(os.path.abspath(__file__))
OPENCLAW = os.path.expanduser('~/.openclaw/openclaw.json')


def get_json(url, headers=None, timeout=25):
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def bearer(key):
    return {'Authorization': 'Bearer ' + key} if key else {}


def main():
    cfg = json.load(open(OPENCLAW))
    prov = cfg.get('models', {}).get('providers', {})
    k = lambda n: (prov.get(n) or {}).get('apiKey') or ''

    channels = []
    log = []

    # 1) SLCH 主站（优先级最高）
    try:
        m = get_json('https://www.slch.com/v1/models', bearer(k('slch')))
        models = [x['id'] for x in m['data']]
        log.append(f"SLCH: {len(models)} 模型")
    except Exception as e:
        models = ['deepseek-v4-flash', 'deepseek-v4-pro', 'Qwen3.8-27B']
        log.append(f"SLCH 探测失败({e})，用默认清单")
    channels.append(dict(name='SLCH 主站', type=1, base_url='https://www.slch.com/v1',
                         api_key=k('slch'), models=models, priority=100, weight=3, status=1))

    # 2) Ollama 云端
    try:
        m = get_json('https://ollama.com/api/tags', bearer(k('ollama-cloud')))
        oc = sorted({x['name'] for x in m['models']})
        log.append(f"Ollama云端: {len(oc)} 模型")
    except Exception as e:
        oc = []; log.append(f"Ollama云端探测失败: {e}")
    if oc:
        channels.append(dict(name='Ollama 云端', type=1, base_url='https://ollama.com/v1',
                             api_key=k('ollama-cloud'), models=oc, priority=40, weight=2, status=1))

    # 3) 张拓科技（默认禁用，避免拖慢路由；有额度时改成 status=1）
    try:
        m = get_json('https://ai.zhangtuokeji.top:9090/v1/models', bearer(k('zhangtuo-ai')))
        zt = [x['id'] for x in m['data']]
        log.append(f"张拓: {len(zt)} 模型")
    except Exception as e:
        zt = []; log.append(f"张拓探测失败: {e}")
    if zt:
        channels.append(dict(name='张拓科技', type=1, base_url='https://ai.zhangtuokeji.top:9090/v1',
                             api_key=k('zhangtuo-ai'), models=zt, priority=20, weight=1, status=0))

    # 4) 本地算力节点（vnet 隧道端口，可能离线）
    for name, url, prio in [
        ('算力节点 work01 (GPU/RTX4060)', 'http://127.0.0.1:19023', 10),
        ('算力节点 work01 (Ollama)',      'http://127.0.0.1:18792', 9),
    ]:
        try:
            m = get_json(url + '/v1/models')
            ms = [x['id'] for x in m['data']]
        except Exception:
            try:
                m = get_json(url + '/api/tags')
                ms = sorted({x['name'] for x in m['models']})
            except Exception as e:
                ms = []; log.append(f"{name} 离线: {e}")
        if ms:
            channels.append(dict(name=name, type=1, base_url=url + '/v1',
                                 api_key='***', models=ms, priority=prio, weight=1, status=1))
            log.append(f"{name}: {len(ms)} 模型")

    out = os.path.join(API_DIR, 'channels.json')
    json.dump(channels, open(out, 'w'), ensure_ascii=False, indent=2)

    # 脱敏副本
    ex = json.loads(json.dumps(channels, ensure_ascii=False))
    KEYMAP = {'SLCH 主站': 'REPLACE_SLCH_KEY', 'Ollama 云端': 'REPLACE_OLLAMA_KEY', '张拓科技': 'REPLACE_ZHANGTUO_KEY'}
    for c in ex:
        if c['name'] in KEYMAP:
            c['api_key'] = KEYMAP[c['name']]
    json.dump(ex, open(os.path.join(API_DIR, 'channels.example.json'), 'w'), ensure_ascii=False, indent=2)

    for l in log:
        print(' -', l)
    print(f'\n✅ 写入 {out}')
    print(f'   渠道 {len(channels)} 个，对外模型 {len({m for c in channels if c["status"] == 1 for m in c["models"]})} 个')
    print('\n⚠️  新增/修改渠道后需重启本服务: sudo systemctl restart computehub-api')


if __name__ == '__main__':
    main()
