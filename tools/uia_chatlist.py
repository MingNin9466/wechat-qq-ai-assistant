#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""深挖：找到 mmui::ChatMasterView（会话列表），检查会话项的模式。"""
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

found = []


def walk(e, depth=0):
    if depth > 12:
        return
    try:
        cls = e.ClassName or ""
    except Exception:
        return
    if "ChatMasterView" in cls or "Session" in cls or "ChatSession" in cls:
        found.append((depth, e))
    try:
        for c in e.GetChildren():
            walk(c, depth + 1)
    except Exception:
        pass


walk(win)
print(f"命中 {len(found)} 个相关节点")

for depth, e in found[:3]:
    print(f"\n=== depth={depth} {e.ControlTypeName} {e.ClassName} name={e.Name!r} ===")
    kids = []
    try:
        kids = e.GetChildren()
    except Exception:
        pass
    print("  子节点数:", len(kids))
    for k in kids[:10]:
        pats = []
        for p in ("Invoke", "SelectionItem", "Value", "LegacyIAccessible", "ScrollItem"):
            try:
                if getattr(k, "Get" + p + "Pattern")() is not None:
                    pats.append(p)
            except Exception:
                pass
        print(f"    {k.ControlTypeName:<16} {k.ClassName:<32} {(k.Name or '')[:24]!r:<26} {','.join(pats)}")
