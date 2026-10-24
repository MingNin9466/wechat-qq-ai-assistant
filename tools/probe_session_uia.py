#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
用强类型 UIA 查询（而不是裸遍历）找会话列表：
  mmui::ChatMasterView → mmui::XTableView → ListItem(mmui::ChatSessionCell)
目标是拿到 ListItem，用 SelectionItem.Select() 静默切群（不移动鼠标）。
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
hs = []


def cb(h, _):
    cls = ctypes.create_unicode_buffer(128)
    user32.GetClassNameW(h, cls, 128)
    if "QWindowIcon" in cls.value:
        t = ctypes.create_unicode_buffer(64)
        user32.GetWindowTextW(h, t, 64)
        if t.value == "微信":
            hs.append(h)
    return True


user32.EnumWindows(EP(cb), 0)
print("主窗口候选:", hs)
if not hs:
    sys.exit("找不到标题为『微信』的窗口")
hwnd = hs[0]
user32.ShowWindow(hwnd, 9)
user32.SetForegroundWindow(hwnd)
time.sleep(0.8)

from wechatauto.uia_driver import WeChatUIA  # noqa: E402
from wechatauto import uia  # noqa: E402

u = WeChatUIA()
try:
    u.wake()
except Exception:
    pass
print("ensure_window:", u.ensure_window())
time.sleep(0.5)

main = uia.ControlFromHandle(hwnd)
print("main:", main.ClassName, main.Name)

print("\n--- 强类型查找 ---")
for label, fn in [
    ("MainTabBar", lambda m: m.ToolBarControl(ClassName="mmui::MainTabBar")),
    ("ChatMasterView", lambda m: m.GroupControl(ClassName="mmui::ChatMasterView")),
    ("ChatInputField", lambda m: m.EditControl(ClassName="mmui::ChatInputField")),
]:
    try:
        ctl = fn(main)
        print(f"  {label}: {'OK' if ctl else 'None'}")
    except Exception as exc:
        print(f"  {label}: 异常 {type(exc).__name__} {exc}")

print("\n--- 从 ChatMasterView 往下找 XTableView ---")
try:
    master = main.GroupControl(ClassName="mmui::ChatMasterView")
    print("  master:", master)
    if master:
        table = master.ListControl(ClassName="mmui::XTableView")
        print("  table:", table)
        if table:
            kids = table.GetChildren()
            print(f"  行数: {len(kids)}")
            for k in kids[:10]:
                nm = (k.Name or "").split("\n")[0]
                pats = []
                for p in ("SelectionItem", "Invoke", "ScrollItem"):
                    try:
                        if getattr(k, "Get" + p + "Pattern")() is not None:
                            pats.append(p)
                    except Exception:
                        pass
                print(f"    {k.ControlTypeName:<18} {k.ClassName:<28} {nm!r:<20} {pats}")
except Exception as exc:
    print("  失败:", type(exc).__name__, exc)

print("\n--- 整个主窗口元素总数（深度 15）---")
cnt = 0
stack = [(main, 0)]
while stack and cnt < 30000:
    node, d = stack.pop()
    cnt += 1
    if d < 15:
        try:
            for k in node.GetChildren():
                stack.append((k, d + 1))
        except Exception:
            pass
print("  元素数:", cnt)
