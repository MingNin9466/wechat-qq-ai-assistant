#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""打印微信主窗口 UIA 树骨架（深度 4），找会话列表节点。"""
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

from wechatauto.uia_driver import WeChatUIA  # noqa: E402

u = WeChatUIA()
u.ensure_window()
win = u._find_main()
print("当前会话:", u.current_chat())
print("主窗口:", win.Name, win.ClassName)
print()

count = {"n": 0}


def walk(e, depth=0):
    if depth > 4 or count["n"] > 120:
        return
    count["n"] += 1
    try:
        cls = e.ClassName or ""
        name = (e.Name or "")[:26]
        ct = e.ControlTypeName or ""
    except Exception:
        return
    pats = []
    for p in ("Invoke", "SelectionItem", "Value", "LegacyIAccessible", "ScrollItem"):
        try:
            if getattr(e, "Get" + p + "Pattern")() is not None:
                pats.append(p)
        except Exception:
            pass
    print(f"{'  ' * depth}[{depth}] {ct:<18} {cls:<38} {name!r:<28} {','.join(pats)}")
    try:
        for c in e.GetChildren():
            walk(c, depth + 1)
    except Exception:
        pass


walk(win)
print("\n节点数:", count["n"])
