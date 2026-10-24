#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
测试：向"独立聊天窗口"发送消息（不切会话、不动鼠标）。
微信 4.x 里把某个群单独开成窗口后，该窗口有自己的输入框。
"""
import ctypes
import ctypes.wintypes as wt
import sys
import time

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

user32 = ctypes.windll.user32


def snap():
    pt = wt.POINT()
    user32.GetCursorPos(ctypes.byref(pt))
    return (pt.x, pt.y), user32.GetForegroundWindow()


import wechatauto as wa  # noqa: E402

pos0, fg0 = snap()
print(f"发送前：鼠标={pos0} 前台={fg0}")

wx = wa.WeChat()
print("主窗口当前会话:", wx.ChatInfo())

try:
    cw = wx.ChatWnd()
except Exception as exc:
    print("ChatWnd 失败:", type(exc).__name__, exc)
    sys.exit(1)

print("独立窗口对象:", cw)
for attr in ("nickname", "name", "chat_name"):
    try:
        print(f"  {attr} = {getattr(cw, attr)!r}")
    except Exception:
        pass

msg = "[独立窗口测试] " + time.strftime("%H:%M:%S")
print(f"\n发送: {msg}")
t0 = time.time()
try:
    res = cw.SendMsg(msg)
    print(f"  返回: {res}  耗时 {time.time()-t0:.2f}s")
except Exception as exc:
    print("  异常:", type(exc).__name__, exc)

pos1, fg1 = snap()
print(f"\n发送后：鼠标={pos1} 前台={fg1}")
print("鼠标:", "✔ 完全没动" if pos1 == pos0 else f"✖ 动了 {pos0}→{pos1}")
print("前台:", "✔ 没被抢" if fg1 == fg0 else "✖ 变了")

time.sleep(1.5)
db = wa.WeChatDB()
uname = db.username_by_nickname("群A")
hits = [m for m in db.get_messages(uname, limit=15) if "独立窗口测试" in str(m.get("content"))]
print("群A里找到:", len(hits), "条")
for m in hits[-1:]:
    print("  ", str(m.get("content")).replace("\n", " ")[:60])
