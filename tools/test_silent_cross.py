#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
验证"纯 UIA 静默切群"：当前在 A 群，往 B 群发消息。
检查点：鼠标零位移、前台窗口零变化、B 群收到消息。
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


import wechatauto as wa

wx = wa.WeChat()
if wx.ChatInfo().get("chat_name") != "群B":
    # 只为了把场景设成"当前 A，要发 B"
    from wechatauto.uia_driver import WeChatUIA

    ui = WeChatUIA()
    ui.wake()
    ui.ensure_window()
    print("（先把当前会话设为 群B）")
    try:
        wx.ChatWith("群B")
        time.sleep(1.0)
    except Exception as exc:
        print("  设置失败:", exc)
print("当前会话:", wx.ChatInfo().get("chat_name"))

pos0, fg0 = snap()
print(f"发送前：鼠标={pos0}  前台={fg0}")

body = json.dumps({
    "kind": "text",
    "chat": "群A",
    "text": "[纯UIA跨群] " + time.strftime("%H:%M:%S"),
}).encode()
req = urllib.request.Request(
    "http://127.0.0.1:8899/send", data=body, headers={"Content-Type": "application/json"}
)
t0 = time.time()
try:
    with urllib.request.urlopen(req, timeout=120) as r:
        print("响应:", r.read().decode(), f"耗时 {time.time()-t0:.1f}s")
except Exception as exc:
    print("失败:", exc, f"耗时 {time.time()-t0:.1f}s")

time.sleep(1.2)
pos1, fg1 = snap()
print(f"发送后：鼠标={pos1}  前台={fg1}")
print("鼠标:", "✔ 完全没动" if pos1 == pos0 else f"✖ 动了 {pos0}→{pos1}")
print("前台:", "✔ 没被抢" if fg1 == fg0 else "✖ 变了")

db = wa.WeChatDB()
uname = db.username_by_nickname("群A")
hits = [m for m in db.get_messages(uname, limit=20) if "纯UIA跨群" in str(m.get("content"))]
print("群A收到:", len(hits), "条")
for m in hits[-1:]:
    print("  ", str(m.get("content")).replace("\n", " ")[:50])
