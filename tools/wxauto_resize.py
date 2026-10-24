#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把微信窗口调整到正常大小并置前，再试 wxauto。"""
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

hwnd, cls, title = wins[0]
r = wt.RECT()
user32.GetWindowRect(hwnd, ctypes.byref(r))
print(f"窗口 {hwnd}  {cls}  {title!r}  原尺寸 {r.right-r.left}x{r.bottom-r.top}")

# 1) 恢复 + 调整到 1100x760
user32.ShowWindow(hwnd, 9)  # SW_RESTORE
ctypes.set_last_error(0)
ok = user32.MoveWindow(hwnd, 60, 40, 1100, 760, True)
err = ctypes.get_last_error()
print(f"MoveWindow: {'成功' if ok else f'失败 (err={err})'}")

user32.GetWindowRect(hwnd, ctypes.byref(r))
print(f"现在尺寸 {r.right-r.left}x{r.bottom-r.top}")

# 2) 尝试提到最前
ctypes.set_last_error(0)
user32.BringWindowToTop(hwnd)
print(f"BringWindowToTop err={ctypes.get_last_error()}")
time.sleep(1.5)

# 3) 再试 wxauto
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
