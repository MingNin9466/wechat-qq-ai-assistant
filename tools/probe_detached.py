#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
探测"独立聊天窗口"：微信 4.x 可以把某个聊天单独开一个窗口。
如果每个窗口都有自己的 ChatInputField，就能直接往里写，完全不用切会话。
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

rows = []


def cb(h, _):
    cls = ctypes.create_unicode_buffer(128)
    user32.GetClassNameW(h, cls, 128)
    if "QWindowIcon" not in cls.value:
        return True
    t = ctypes.create_unicode_buffer(128)
    user32.GetWindowTextW(h, t, 128)
    r = wt.RECT()
    user32.GetWindowRect(h, ctypes.byref(r))
    rows.append((h, t.value, r.right - r.left, r.bottom - r.top,
                 bool(user32.IsWindowVisible(h)), bool(user32.IsIconic(h))))
    return True


user32.EnumWindows(EP(cb), 0)
print(f"QWindowIcon 窗口 {len(rows)} 个：")
for h, t, w, hh, vis, icon in rows:
    print(f"  hwnd={h} {w}x{hh} visible={vis} iconic={icon} title={t!r}")

from wechatauto.uia_driver import WeChatUIA  # noqa: E402
from wechatauto import uia  # noqa: E402

u = WeChatUIA()
try:
    u.wake()
except Exception:
    pass
u.ensure_window()

print("\n各窗口里的聊天输入框：")
for h, t, w, hh, vis, icon in rows:
    try:
        root = uia.ControlFromHandle(h)
    except Exception as exc:
        print(f"  hwnd={h} 取根失败: {exc}")
        continue
    if root is None:
        print(f"  hwnd={h} root=None")
        continue
    try:
        edit = root.EditControl(ClassName="mmui::ChatInputField")
    except Exception as exc:
        print(f"  hwnd={h} 查询异常: {type(exc).__name__} {exc}")
        continue
    name = None
    if edit:
        try:
            name = edit.Name
        except Exception:
            name = "?"
    print(f"  hwnd={h} title={t!r} 输入框={'有' if edit else '无'} 会话名={name!r}")

print("\n提示：如果某个独立窗口能查到输入框，就能直接往它写，不需要切会话。")
