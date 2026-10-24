#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""打印 ChatMasterView 子树（会话列表），检查会话项是否可 Invoke。"""
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

from wechatauto.uia_driver import WeChatUIA  # noqa: E402

u = WeChatUIA()
u.ensure_window()
win = u._find_main()

target = None


def find(e, depth=0):
    global target
    if depth > 12 or target is not None:
        return
    try:
        if "ChatMasterView" in (e.ClassName or ""):
            target = e
            return
    except Exception:
        return
    try:
        for c in e.GetChildren():
            find(c, depth + 1)
    except Exception:
        pass


find(win)
if target is None:
    print("没找到 ChatMasterView")
    sys.exit(1)

print("ChatMasterView 子树：\n")


def dump(e, depth=0):
    if depth > 6:
        return
    pats = []
    for p in ("Invoke", "SelectionItem", "Value", "ScrollItem", "LegacyIAccessible"):
        try:
            if getattr(e, "Get" + p + "Pattern")() is not None:
                pats.append(p)
        except Exception:
            pass
    try:
        print(f"{'  ' * depth}{e.ControlTypeName:<16} {(e.ClassName or ''):<34} {(e.Name or '')[:26]!r:<28} {','.join(pats)}")
    except Exception:
        return
    try:
        for c in e.GetChildren()[:6]:
            dump(c, depth + 1)
    except Exception:
        pass


dump(target)
