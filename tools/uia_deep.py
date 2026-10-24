#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""递归 dump 微信窗口的 UIA 树，找 mmui::* 控件是否还存在。"""
import ctypes
import ctypes.wintypes as wt
import sys
import time

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

import comtypes.client

comtypes.client.GetModule("UIAutomationCore.dll")
from comtypes.gen.UIAutomationClient import CUIAutomation, IUIAutomation, TreeScope_Children  # noqa: E402

user32 = ctypes.windll.user32
EnumWindowsProc = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
wins = []


def cb(hwnd, _l):
    if user32.IsWindowVisible(hwnd):
        cls = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(hwnd, cls, 256)
        if "QWindowIcon" in cls.value:
            wins.append(hwnd)
    return True


user32.EnumWindows(EnumWindowsProc(cb), 0)
hwnd = wins[0]
uia = comtypes.client.CreateObject(CUIAutomation, interface=IUIAutomation)
root = uia.ElementFromHandle(hwnd)

# 给 Qt 一点时间构建无障碍树
time.sleep(2)

found = []
counter = {"n": 0}
cond = uia.CreateTrueCondition()


def walk(el, depth, prefix=""):
    if depth > 5 or counter["n"] > 400:
        return
    counter["n"] += 1
    try:
        cls = el.CurrentClassName
        name = el.CurrentName
        typ = el.CurrentControlType
    except Exception:
        return
    if cls:
        found.append(cls)
    mark = " ★" if "mmui" in (cls or "").lower() or "main" in (cls or "").lower() else ""
    print(f"{prefix}[{depth}] {cls!r:<42} Name={name!r:<24} Type={typ}{mark}")
    if depth == 5:
        return
    try:
        ch = el.FindAll(TreeScope_Children, cond)
    except Exception:
        return
    for i in range(min(ch.Length, 12)):
        try:
            walk(ch.GetElement(i), depth + 1, prefix + "  ")
        except Exception:
            pass


walk(root, 0)

print("\n=== 汇总 ===")
print("元素总数:", counter["n"])
mmui = sorted({c for c in found if "mmui" in c.lower()})
print("mmui::* 类名:", mmui if mmui else "（一个都没有）")
print("所有不同类名:", sorted(set(found)))
