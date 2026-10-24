#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""测试 UIA 后台发送：发一条消息，并对比前后前台窗口和鼠标位置。"""
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


def snapshot():
    fg = u.GetForegroundWindow()
    pt = wt.POINT()
    u.GetCursorPos(ctypes.byref(pt))
    return fg, (pt.x, pt.y)


fg0, pos0 = snapshot()
print(f"发送前：前台窗口={fg0}  鼠标={pos0}")

body = json.dumps({
    "kind": "text",
    "chat": "文件传输助手",
    "text": "[UIA后台] 不抢键鼠测试 " + time.strftime("%H:%M:%S"),
}).encode("utf-8")

req = urllib.request.Request(
    "http://127.0.0.1:8906/send", data=body, headers={"Content-Type": "application/json"}
)
t0 = time.time()
try:
    with urllib.request.urlopen(req, timeout=120) as r:
        print(f"响应：{r.read().decode()}  耗时 {time.time() - t0:.1f}s")
except Exception as exc:
    print(f"请求失败：{exc}  耗时 {time.time() - t0:.1f}s")

time.sleep(1.0)
fg1, pos1 = snapshot()
print(f"发送后：前台窗口={fg1}  鼠标={pos1}")
print("焦点：", "✔ 没被抢" if fg1 == fg0 else "✖ 被抢走了")
print("鼠标：", "✔ 没动" if pos1 == pos0 else "✖ 移动了")
