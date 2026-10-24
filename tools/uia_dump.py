#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用 UIAutomationCore 直接读微信窗口的 UIA 属性，对比 wxauto 期望的类名。"""
import ctypes
import ctypes.wintypes as wt
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

import comtypes.client

comtypes.client.GetModule("UIAutomationCore.dll")
from comtypes.gen.UIAutomationClient import (  # noqa: E402
    CUIAutomation,
    IUIAutomation,
    TreeScope_Children,
)

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
    print("✖ 找不到微信窗口")
    sys.exit(1)

uia = comtypes.client.CreateObject(CUIAutomation, interface=IUIAutomation)

print(f"Windows 里看到的窗口类名: {wins[0][1]!r}  标题: {wins[0][2]!r}")
print("wxauto 期望的窗口类名:    'Qt51514QWindowIcon'  /  UIA ClassName 'mmui::MainWindow'\n")

for hwnd, cls, title in wins:
    el = uia.ElementFromHandle(hwnd)
    if not el:
        continue
    print(f"HWND={hwnd}  Win32Class={cls}  Title={title!r}")
    print(f"  UIA Name        = {el.CurrentName!r}")
    print(f"  UIA ClassName   = {el.CurrentClassName!r}   <-- wxauto 要的是 mmui::MainWindow")
    print(f"  UIA ControlType = {el.CurrentControlType}")
    print(f"  UIA AutomationId= {el.CurrentAutomationId!r}")

    try:
        cond = uia.CreateTrueCondition()
        children = el.FindAll(TreeScope_Children, cond)
        print(f"  直接子元素 {children.Length} 个：")
        for i in range(min(children.Length, 15)):
            c = children.GetElement(i)
            print(f"    [{i}] Class={c.CurrentClassName!r:<40} Name={c.CurrentName!r:<20} Type={c.CurrentControlType}")
    except Exception as exc:
        print("  枚举子元素失败:", exc)

    # 再往下挖两层，找聊天区域
    print("\n  子元素（深度 2）：")
    try:
        cond = uia.CreateTrueCondition()
        lvl1 = el.FindAll(TreeScope_Children, cond)
        for i in range(min(lvl1.Length, 10)):
            c1 = lvl1.GetElement(i)
            print(f"    - {c1.CurrentClassName!r}")
            try:
                lvl2 = c1.FindAll(TreeScope_Children, cond)
                for j in range(min(lvl2.Length, 8)):
                    c2 = lvl2.GetElement(j)
                    print(f"        └ {c2.CurrentClassName!r}  Name={c2.CurrentName!r}")
            except Exception:
                pass
    except Exception as exc:
        print("  失败:", exc)
