#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
探测独立聊天窗口：如果某个群被单独开成窗口，它自己就有 ChatInputField，
可以往那个窗口直接写，完全不需要切换会话、不需要 hook。
用法: python tools/probe_detached2.py
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
EP = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)

wins = []


def cb(h, _):
    cls = ctypes.create_unicode_buffer(128)
    user32.GetClassNameW(h, cls, 128)
    if "QWindowIcon" not in cls.value and "Qt" not in cls.value:
        return True
    t = ctypes.create_unicode_buffer(256)
    user32.GetWindowTextW(h, t, 256)
    r = wt.RECT()
    user32.GetWindowRect(h, ctypes.byref(r))
    wins.append({
        "h": h,
        "title": t.value,
        "rect": (r.left, r.top, r.right - r.left, r.bottom - r.top),
        "visible": bool(user32.IsWindowVisible(h)),
        "iconic": bool(user32.IsIconic(h)),
    })
    return True


user32.EnumWindows(EP(cb), 0)
print(f"找到 {len(wins)} 个 Qt/QWindowIcon 顶层窗口\n")

from wechatauto.uia_driver import WeChatUIA  # noqa: E402
from wechatauto import uia  # noqa: E402

u = WeChatUIA()
try:
    u.wake()
except Exception:
    pass
u.ensure_window()
time.sleep(0.5)

for w in wins:
    root = None
    try:
        root = uia.ControlFromHandle(w["h"])
    except Exception as exc:
        print(f"hwnd={w['h']} 取根失败: {exc}")
        continue
    if root is None:
        continue

    edit = None
    try:
        edit = root.EditControl(ClassName="mmui::ChatInputField", searchDepth=20)
    except Exception:
        edit = None

    name = None
    if edit:
        try:
            name = edit.Name
        except Exception:
            name = "?"

    kind = "主窗口" if w["title"] == "微信" else ("独立会话窗口" if name else "其它")
    print(
        f"hwnd={w['h']:<8} {w['rect'][2]}x{w['rect'][3]:<5} visible={w['visible']} "
        f"title={w['title']!r:<12} 输入框={'有' if edit else '无'} 会话={name!r:<24} => {kind}"
    )

print("\n如果看到某个非主窗口带有 输入框=有 且 会话=群名，那就是独立会话窗口。")
