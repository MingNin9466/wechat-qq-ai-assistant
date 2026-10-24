import os, re, sys
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
root = r"C:\Users\你的名字\微信群聊deepseek"
skip_dirs = {'.git', 'node_modules', 'data', 'tools\\plugins', 'tools\\napcat', 'tools\\ffmpeg', '.agent-teams'}
patterns = [
    ('DeepSeek key', re.compile(r'sk-[A-Za-z0-9]{16,}')),
    ('豆包/火山 key', re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')),
    ('SESSDATA', re.compile(r'SESSDATA')),
    ('sessdata=', re.compile(r'sessdata')),
    ('QQ号/微信号', re.compile(r'(<YOUR_QQ_ID>|<YOUR_WECHAT_ID>|<BOT_QQ_ID>)')),
    ('统一身份', re.compile(r'(wxid_|chatroom)')),
]
hits = []
for dirpath, dirnames, filenames in os.walk(root):
    dirnames[:] = [d for d in dirnames if d not in skip_dirs and not os.path.join(dirpath, d).lower().endswith(('\\data', '\\plugins', '\\napcat', '\\ffmpeg'))]
    if any(s in dirpath for s in skip_dirs):
        continue
    for fn in filenames:
        if not fn.endswith(('.ts', '.mjs', '.js', '.py', '.json', '.yml', '.yaml', '.cmd', '.ps1', '.html', '.md', '.env')):
            continue
        p = os.path.join(dirpath, fn)
        try:
            txt = open(p, encoding='utf-8', errors='ignore').read()
        except Exception:
            continue
        for name, rx in patterns:
            for m in rx.finditer(txt):
                hits.append((name, os.path.relpath(p, root), m.group(0)[:40]))
                break
seen = set()
for name, path, sample in hits:
    key = (name, path)
    if key in seen: continue
    seen.add(key)
    print(f"[{name}] {path}  e.g. {sample}")
print("\n合计", len(seen), "处")
