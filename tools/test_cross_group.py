#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
验证跨群发送：先把当前会话切到 A 群，再让桥接往 B 群发一条，
看是否真的切过去发出去了。
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

import wechatauto as wa

u = ctypes.windll.user32
EP = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
hs = []


def cb(h, _):
    if u.IsWindowVisible(h):
        c = ctypes.create_unicode_buffer(128)
        u.GetClassNameW(h, c, 128)
        if "QWindowIcon" in c.value:
            hs.append(h)
    return True


u.EnumWindows(EP(cb), 0)
if hs:
    h = hs[0]
    u.ShowWindow(h, 9)
    u.SetForegroundWindow(h)
    time.sleep(0.4)

wx = wa.WeChat()
print("切到 A 群（群B）…")
try:
    wx.ChatWith("群B")
    time.sleep(1.2)
    print("  当前会话:", wx.ChatInfo())
except Exception as exc:
    print("  切换失败:", exc)

db = wa.WeChatDB()
before = len(db.get_messages(db.username_by_nickname("群A"), limit=30))

print("\n通过桥接往 B 群（群A）发一条…")
body = json.dumps({
    "kind": "text",
    "chat": "群A",
    "text": "[跨群发送测试] " + time.strftime("%H:%M:%S"),
}).encode()
req = urllib.request.Request(
    "http://127.0.0.1:8899/send", data=body, headers={"Content-Type": "application/json"}
)
t0 = time.time()
try:
    with urllib.request.urlopen(req, timeout=120) as r:
        print("  响应:", r.read().decode(), f"耗时 {time.time()-t0:.1f}s")
except Exception as exc:
    print("  失败:", exc, f"耗时 {time.time()-t0:.1f}s")

time.sleep(1.5)
after_msgs = db.get_messages(db.username_by_nickname("群A"), limit=30)
hits = [m for m in after_msgs if "跨群发送测试" in str(m.get("content"))]
print(f"\n群A里找到测试消息: {len(hits)} 条")
for m in hits[-1:]:
    text = str(m.get("content") or "").replace("\n", " ")
    print("  ", text[:60])
try:
    print("发完后当前会话:", wx.ChatInfo())
except Exception:
    pass
