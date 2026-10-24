#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
探测：聊天窗口标题栏的按钮（"更多/..."）以及它弹出的菜单项，
看能不能用 UIA Invoke 打开「独立窗口」——这样就不用切群了。
"""
import sys
import time

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

from wechatauto.uia_driver import WeChatUIA
from wechatauto import uia

u = WeChatUIA()
try:
    u.wake()
except Exception:
    pass
u.ensure_window()
time.sleep(0.5)

win = u._find_main()
print("主窗口:", win.Name)

# 标题栏
titlebar = win.ToolBarControl(ClassName="mmui::TitleBar")
print("TitleBar:", bool(titlebar))
if titlebar:
    try:
        kids = titlebar.GetChildren()
        print(f"标题栏子元素 {len(kids)} 个：")
        for k in kids:
            pats = []
            for p in ("Invoke", "ExpandCollapse", "SelectionItem"):
                try:
                    if getattr(k, "Get" + p + "Pattern")() is not None:
                        pats.append(p)
                except Exception:
                    pass
            print(f"  {k.ControlTypeName:<16} {k.ClassName:<28} {(k.Name or '')[:20]!r:<24} {pats}")
    except Exception as exc:
        print("  读取失败:", exc)

# 聊天页顶部的按钮（更多/...）
print("\n聊天区域里的按钮（名字含 更多/…/菜单）：")
found = []


def walk(el, depth=0):
    if depth > 14 or len(found) > 60:
        return
    try:
        if el.ControlTypeName == "ButtonControl":
            nm = (el.Name or "").strip()
            if nm:
                found.append((nm, el.ClassName, el))
    except Exception:
        pass
    try:
        for k in el.GetChildren():
            walk(k, depth + 1)
    except Exception:
        pass


walk(win)
for nm, cls, el in found[:25]:
    inv = False
    try:
        inv = el.GetInvokePattern() is not None
    except Exception:
        pass
    print(f"  {nm!r:<26} {cls:<26} Invoke={inv}")

# 试着点"更多"看菜单
cand = next((x for x in found if "更多" in x[0] or "…" in x[0] or "..." in x[0]), None)
print("\n候选 '更多' 按钮:", cand[0] if cand else None)
if cand:
    el = cand[2]
    try:
        inv = el.GetInvokePattern()
        if inv:
            inv.Invoke()
            time.sleep(1.2)
            print("已 Invoke，查找弹出的菜单项…")
            # 菜单通常是独立的 popup 窗口，枚举所有窗口找 MenuItem
            import ctypes
            import ctypes.wintypes as wt

            user32 = ctypes.windll.user32
            EP = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
            hs = []

            def cb(h, _):
                cls = ctypes.create_unicode_buffer(128)
                user32.GetClassNameW(h, cls, 128)
                if "QWindow" in cls.value and user32.IsWindowVisible(h):
                    hs.append(h)
                return True

            user32.EnumWindows(EP(cb), 0)
            print("新出现的可见窗口数:", len(hs))
            for h in hs:
                try:
                    root = uia.ControlFromHandle(h)
                    items = []
                    for k in root.GetChildren():
                        if "MenuItem" in (k.ControlTypeName or ""):
                            items.append((k.Name or ""))
                    if items:
                        print(f"  hwnd={h} 菜单项: {items}")
                except Exception:
                    pass
    except Exception as exc:
        print("Invoke 失败:", exc)
