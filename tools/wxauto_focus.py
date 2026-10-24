#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""强制把微信窗口提到前台（AttachThreadInput 技巧），再试 wxauto。"""
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
wins = []


def cb(hwnd, _l):
    if user32.IsWindowVisible(hwnd):
        cls = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(hwnd, cls, 256)
        if "QWindowIcon" in cls.value:
            t = ctypes.create_unicode_buffer(64)
            user32.GetWindowTextW(hwnd, t, 64)
            wins.append((hwnd, cls.value, t.value))
    return True


user32.EnumWindows(EnumWindowsProc(cb), 0)
if not wins:
    print("✖ 没找到微信窗口")
    sys.exit(1)

hwnd = wins[0][0]
fg = user32.GetForegroundWindow()
print(f"微信窗口={hwnd}  当前前台={fg}")

tid_fg = user32.GetWindowThreadProcessId(fg, None)
tid_self = ctypes.windll.kernel32.GetCurrentThreadId()
tid_wx = user32.GetWindowThreadProcessId(hwnd, None)
print(f"线程: fg={tid_fg}  self={tid_self}  wx={tid_wx}")

user32.ShowWindow(hwnd, 9)
for attach in (tid_fg,):
    user32.AttachThreadInput(tid_self, attach, True)
user32.BringWindowToTop(hwnd)
ok = user32.SetForegroundWindow(hwnd)
for attach in (tid_fg,):
    user32.AttachThreadInput(tid_self, attach, False)
time.sleep(1.0)
print(f"SetForegroundWindow={ok}  现在前台={user32.GetForegroundWindow()}  目标={hwnd}")

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
            ss = wx.GetSession()
            print(f"会话数: {len(ss)}")
            for s in list(ss)[:5]:
                print("  -", getattr(s, "info", s))
        except Exception as e:
            print("GetSession 失败:", e)
    except Exception as e:
        print(f"✖ {type(e).__name__}: {e}")
except Exception as e:
    print("导入失败:", e)
