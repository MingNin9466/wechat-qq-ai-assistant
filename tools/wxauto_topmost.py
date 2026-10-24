#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把微信窗口置顶（不抢焦点），再尝试 wxauto。
依据：wxauto4 的 param.py 注释——4.x 客户端只有"显示的部分"才注册 UIA 控件。
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
EnumWindowsProc = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)

SWP_NOSIZE = 0x0001
SWP_NOMOVE = 0x0002
SWP_SHOWWINDOW = 0x0040
HWND_TOPMOST = -1
HWND_NOTOPMOST = -2

wins = []


def cb(hwnd, _l):
    if user32.IsWindowVisible(hwnd):
        cls = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(hwnd, cls, 256)
        if "QWindowIcon" in cls.value:
            title_len = user32.GetWindowTextLengthW(hwnd)
            buf = ctypes.create_unicode_buffer(title_len + 1)
            user32.GetWindowTextW(hwnd, buf, title_len + 1)
            wins.append((hwnd, cls.value, buf.value))
    return True


user32.EnumWindows(EnumWindowsProc(cb), 0)
if not wins:
    print("✖ 没找到微信窗口")
    sys.exit(1)

hwnd, cls, title = wins[0]
print(f"窗口: hwnd={hwnd} class={cls} title={title!r}")

user32.ShowWindow(hwnd, 9)  # SW_RESTORE
ok = user32.SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW)
print("置顶:", "成功" if ok else "失败")
time.sleep(1.5)

try:
    from wxauto4 import WeChat

    print("\n尝试 WeChat() …")
    try:
        wx = WeChat()
        print("✔ 成功！")
        try:
            print("ChatInfo:", wx.ChatInfo())
        except Exception as e:
            print("ChatInfo 失败:", e)
        try:
            sessions = wx.GetSession()
            print(f"会话数: {len(sessions)}")
            for s in list(sessions)[:5]:
                print("  -", getattr(s, "info", s))
        except Exception as e:
            print("GetSession 失败:", e)
    except Exception as e:
        print(f"✖ {type(e).__name__}: {e}")
finally:
    user32.SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE)
    print("\n已取消置顶")
