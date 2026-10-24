#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""wxauto4 深度排查：进程列表 + 前台激活 + debug 模式。"""
import ctypes
import ctypes.wintypes as wt
import os
import sys
import time
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

user32 = ctypes.windll.user32
EnumWindowsProc = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)

# 1) 找出所有 Weixin.exe / WeChat.exe 进程
print("=== 微信相关进程 ===")
try:
    import psutil

    found = False
    for p in psutil.process_iter(["pid", "name", "exe"]):
        name = (p.info.get("name") or "").lower()
        if "weixin" in name or "wechat" in name:
            print(f"  pid={p.info['pid']:<7} {p.info['name']:<16} {p.info.get('exe')}")
            found = True
    if not found:
        print("  (没有 Weixin.exe 进程)")
except Exception as exc:
    print("  进程枚举失败:", exc)

# 2) 找窗口并尝试激活
print("\n=== 微信窗口 ===")
wins = []


def cb(hwnd, _l):
    if user32.IsWindowVisible(hwnd):
        cls = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(hwnd, cls, 256)
        if "QWindowIcon" in cls.value:
            n = user32.GetWindowTextLengthW(hwnd)
            buf = ctypes.create_unicode_buffer(n + 1)
            user32.GetWindowTextW(hwnd, buf, n + 1)
            r = wt.RECT()
            user32.GetWindowRect(hwnd, ctypes.byref(r))
            pid = wt.DWORD(0)
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            wins.append((hwnd, cls.value, buf.value, pid.value, r.right - r.left, r.bottom - r.top))
    return True


user32.EnumWindows(EnumWindowsProc(cb), 0)
for w in wins:
    print(f"  hwnd={w[0]} class={w[1]} title={w[2]!r} pid={w[3]} size={w[4]}x{w[5]}")

if wins:
    hwnd = wins[0][0]
    print("\n=== 尝试激活窗口 ===")
    user32.ShowWindow(hwnd, 9)  # SW_RESTORE
    user32.SetForegroundWindow(hwnd)
    time.sleep(1.5)
    print("已调用 SetForegroundWindow")

# 3) wxauto4 debug 模式
print("\n=== wxauto4 debug 模式 ===")
os.environ["PYTHONIOENCODING"] = "utf-8"
try:
    from wxauto4 import WeChat

    for kwargs in ({"debug": True}, {}):
        label = "debug=True" if kwargs else "默认参数"
        print(f"\n-- 尝试 {label} --")
        try:
            wx = WeChat(**kwargs)
            print("✔ 成功")
            try:
                print("  ChatInfo:", wx.ChatInfo())
            except Exception as e:
                print("  ChatInfo 失败:", e)
            break
        except Exception as e:
            print(f"✖ {type(e).__name__}: {e}")
except Exception as e:
    print("导入失败:", e)

# 4) 找 wxauto 的日志文件
print("\n=== 可能的日志文件 ===")
for base in (Path(os.environ.get("TEMP", "")), Path.cwd(), Path.home(), Path("D:/PyBot")):
    try:
        for f in base.rglob("*wxauto*"):
            if f.is_file() and f.suffix in (".log", ".txt", ".json"):
                print(" ", f)
    except Exception:
        pass
