#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
实验 2：会话列表能否用 UIA 直接切换（不点击、不抢焦点）。
只读 + 只查询模式能力，不实际切换。
"""
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

from wechatauto.uia_driver import WeChatUIA  # noqa: E402

u = WeChatUIA()
print("窗口就绪:", u.ensure_window())
print("当前会话:", u.current_chat())

# 找主窗口根
win = u._find_main() if hasattr(u, "_find_main") else None
print("主窗口:", win)

if win is None:
    print("✖ 拿不到主窗口")
    sys.exit(1)


def walk(e, depth=0, out=None):
    if out is None:
        out = []
    if depth > 6:
        return out
    try:
        cls = e.ClassName or ""
        if "ChatMasterView" in cls or "SessionCell" in cls or "ListItem" in (e.ControlTypeName or ""):
            out.append((depth, cls, e.ControlTypeName, (e.Name or "")[:20], e))
    except Exception:
        pass
    try:
        for c in e.GetChildren():
            walk(c, depth + 1, out)
    except Exception:
        pass
    return out


nodes = walk(win)
print(f"\n找到 {len(nodes)} 个可能的会话项节点")
for depth, cls, ct, name, e in nodes[:12]:
    pats = []
    for pname in ("GetInvokePattern", "GetSelectionItemPattern", "GetLegacyIAccessiblePattern", "GetValuePattern"):
        try:
            if getattr(e, pname)() is not None:
                pats.append(pname.replace("Get", "").replace("Pattern", ""))
        except Exception:
            pass
    print(f"  d{depth} {ct:<18} cls={cls:<34} name={name!r:<22} 模式={pats}")

print("\n说明：如果会话项支持 Invoke 或 SelectionItem，就能用 UIA 静默切换会话。")
