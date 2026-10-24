#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""验证安全跨群发送：当前会话是 A，往 B 发一条，确认 B 收到、且没有按键注入。"""
import sys
import time
import json
import urllib.request

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

import wechatauto as wa

wx = wa.WeChat()
print("当前会话:", wx.ChatInfo())

# 确保当前在 A 群
try:
    if wx.ChatInfo().get("chat_name") != "群B":
        wx.ChatWith("群B")
        time.sleep(0.8)
    print("已停在:", wx.ChatInfo().get("chat_name"))
except Exception as exc:
    print("切换失败:", exc)

body = json.dumps({
    "kind": "text",
    "chat": "群A",
    "text": "[安全跨群测试] " + time.strftime("%H:%M:%S"),
}).encode()
req = urllib.request.Request(
    "http://127.0.0.1:8899/send", data=body, headers={"Content-Type": "application/json"}
)
t0 = time.time()
try:
    with urllib.request.urlopen(req, timeout=180) as r:
        print("响应:", r.read().decode(), f"耗时 {time.time()-t0:.1f}s")
except Exception as exc:
    print("失败:", exc, f"耗时 {time.time()-t0:.1f}s")

time.sleep(1.5)
db = wa.WeChatDB()
u = db.username_by_nickname("群A")
hits = [m for m in db.get_messages(u, limit=20) if "安全跨群测试" in str(m.get("content"))]
print("群A里找到:", len(hits), "条")
for m in hits[-1:]:
    print("  ", str(m.get("content")).replace("\n", " ")[:50])
