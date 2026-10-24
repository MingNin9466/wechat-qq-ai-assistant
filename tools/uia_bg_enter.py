#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
找"不抢焦点也能发出去"的回车方式。

测三种：
  D) UIA el.SendKeys("{Enter}")            —— 不显式 SetFocus
  E) PostMessage 主窗口 WM_KEYDOWN/UP VK_RETURN
  F) PostMessage 主窗口 WM_CHAR '\\r'
每种都记录前台窗口/鼠标是否变化。
"""
import ctypes
import ctypes.wintypes as wt
import sys
import time

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

import wechatauto as wa
from wechatauto.uia_driver import WeChatUIA

user32 = ctypes.windll.user32
WM_KEYDOWN = 0x0100
WM_KEYUP = 0x0101
WM_CHAR = 0x0102
VK_RETURN = 0x0D


def snap():
    pt = wt.POINT()
    user32.GetCursorPos(ctypes.byref(pt))
    return user32.GetForegroundWindow(), (pt.x, pt.y)


def report(tag, before, after):
    print(f"   焦点: {'✔ 没变' if before[0] == after[0] else '✖ 变了'}   "
          f"鼠标: {'✔ 没动' if before[1] == after[1] else '✖ 动了'}")


u = WeChatUIA()
try:
    u.wake()
except Exception:
    pass
print("ensure_window:", u.ensure_window())
time.sleep(0.4)

el = u._chat_input()
if el is None:
    sys.exit("没有输入框")
print("输入框会话:", el.Name)
vp = el.GetValuePattern()

main = u._find_main()
print("主窗口 Handle:", hex(main.NativeWindowHandle) if main else None)
hwnd = main.NativeWindowHandle if main else 0


def set_text(t):
    vp.SetValue("")
    time.sleep(0.1)
    vp.SetValue(t)
    time.sleep(0.4)


def cleared(timeout=3.0):
    end = time.time() + timeout
    while time.time() < end:
        try:
            if not (vp.Value or "").strip():
                return True
        except Exception:
            return False
        time.sleep(0.1)
    return False


marker = time.strftime("%H%M%S")

# ---- D: SendKeys，不显式 SetFocus
set_text(f"[D-SendKeys] {marker}")
b = snap()
try:
    el.SendKeys("{Enter}", waitTime=0.05)
except Exception as exc:
    print("D) SendKeys 异常:", exc)
time.sleep(0.6)
a = snap()
print(f"\nD) SendKeys 回车  清空={cleared()}  ")
report("D", b, a)

# ---- E: PostMessage WM_KEYDOWN/UP
if not cleared(0.2):
    set_text(f"[E-PostKey] {marker}")
    b = snap()
    try:
        user32.PostMessageW(hwnd, WM_KEYDOWN, VK_RETURN, 0x001C0001)
        time.sleep(0.05)
        user32.PostMessageW(hwnd, WM_KEYUP, VK_RETURN, 0xC01C0001)
    except Exception as exc:
        print("E) PostMessage 异常:", exc)
    time.sleep(0.8)
    a = snap()
    print(f"\nE) PostMessage WM_KEYDOWN  清空={cleared()}  ")
    report("E", b, a)

# ---- F: PostMessage WM_CHAR
if not cleared(0.2):
    set_text(f"[F-PostChar] {marker}")
    b = snap()
    try:
        user32.PostMessageW(hwnd, WM_CHAR, 0x0D, 0x001C0001)
    except Exception as exc:
        print("F) PostMessage 异常:", exc)
    time.sleep(0.8)
    a = snap()
    print(f"\nF) PostMessage WM_CHAR  清空={cleared()}  ")
    report("F", b, a)

print("\n=== 群里最近消息 ===")
try:
    db = wa.WeChatDB()
    uname = db.username_by_nickname("群B")
    for m in db.get_messages(uname, limit=5):
        print("  ", str(m.get("content") or "").replace("\n", " ")[:70])
except Exception as exc:
    print("读库失败:", exc)
