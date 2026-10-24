#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
纯 UIA 静默跨群发送验证（完全不使用 ChatWith）。
连续两次发送：先确保切到 A，再往 B 发，全程监测鼠标/前台。
"""
import ctypes
import ctypes.wintypes as wt
import json
import sys
import time
import urllib.request

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

u = ctypes.windll.user32


def snap():
    pt = wt.POINT()
    u.GetCursorPos(ctypes.byref(pt))
    return (pt.x, pt.y), u.GetForegroundWindow()


def send(chat, text):
    body = json.dumps({"kind": "text", "chat": chat, "text": text}).encode()
    req = urllib.request.Request(
        "http://127.0.0.1:8899/send", data=body, headers={"Content-Type": "application/json"}
    )
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.read().decode(), time.time() - t0
    except Exception as exc:
        return f"ERR {exc}", time.time() - t0


mark = time.strftime("%H%M%S")

pos0, fg0 = snap()
print(f"基线：鼠标={pos0} 前台={fg0}\n")

print("① 先往「群B」发（必要时静默切过去）…")
res, dt = send("群B", f"[静默测试A] {mark}")
pos_a, fg_a = snap()
print(f"   {res}  {dt:.1f}s")
print(f"   鼠标 {'✔ 没动' if pos_a == pos0 else f'✖ 动了 {pos0}→{pos_a}'}   "
      f"前台 {'✔ 没变' if fg_a == fg0 else '✖ 变了'}")

print("\n② 再往「群A」发（跨群，纯 UIA 切）…")
res2, dt2 = send("群A", f"[静默测试B] {mark}")
pos_b, fg_b = snap()
print(f"   {res2}  {dt2:.1f}s")
print(f"   鼠标 {'✔ 没动' if pos_b == pos_a else f'✖ 动了 {pos_a}→{pos_b}'}   "
      f"前台 {'✔ 没变' if fg_b == fg_a else '✖ 变了'}")

print("\n③ 核对数据库")
import wechatauto as wa  # noqa: E402

db = wa.WeChatDB()
for name, tag in (("群B", "[静默测试A]"), ("群A", "[静默测试B]")):
    uname = db.username_by_nickname(name)
    hits = [m for m in db.get_messages(uname, limit=20) if tag in str(m.get("content"))]
    print(f"   {name}: {len(hits)} 条")
