#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
实验：能否用纯 UIA（ValuePattern.SetValue + Invoke）发消息，完全不抢键鼠。

只做"写入输入框 + 找发送按钮"这两步，不按任何键。
看输出判断可行性。
"""
import sys
import time

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

from wechatauto.uia_driver import WeChatUIA  # noqa: E402
import wechatauto.uia as uia_mod  # noqa: E402

u = WeChatUIA()
print("窗口就绪:", u.ensure_window())
print("当前会话:", u.current_chat())

el = u._chat_input()
print("\n输入框元素:", el)
if el is None:
    print("✖ 没找到聊天输入框")
    sys.exit(1)

print("  控件类型:", el.ControlTypeName, " 类名:", el.ClassName, " 名称:", el.Name)

# 1) 看有没有 ValuePattern
try:
    vp = el.GetValuePattern()
    print("  ValuePattern:", "有" if vp else "无")
    if vp:
        print("  当前值:", repr(vp.Value)[:80])
except Exception as exc:
    vp = None
    print("  ValuePattern 异常:", exc)

# 2) 尝试写入
if vp:
    probe = "[UIA后台测试] 不要按回车"
    try:
        vp.SetValue(probe)
        time.sleep(0.4)
        back = ""
        try:
            back = vp.Value
        except Exception:
            pass
        print(f"\n  写入后回读: {back!r}")
        print("  写入是否生效:", "✔ 生效" if probe in (back or "") else "✖ 未生效（UIA 只改了缓存）")
    except Exception as exc:
        print("  SetValue 异常:", exc)

# 3) 找发送按钮
print("\n=== 找发送按钮 ===")
cands = []


def walk(e, depth=0):
    if depth > 12 or len(cands) > 40:
        return
    try:
        ct = e.ControlTypeName
        nm = (e.Name or "").strip()
        aid = ""
        try:
            aid = e.AutomationId or ""
        except Exception:
            pass
        if "Button" in ct or nm in ("发送", "发送(S)", "Send") or "send" in aid.lower():
            cands.append((ct, nm, aid, e))
    except Exception:
        pass
    try:
        for c in e.GetChildren():
            walk(c, depth + 1)
    except Exception:
        pass


# 从输入框往上找两层的兄弟，再往下搜
try:
    node = el
    for _ in range(3):
        p = node.GetParentControl()
        if p:
            node = p
    walk(node)
except Exception as exc:
    print("遍历失败:", exc)

for ct, nm, aid, e in cands[:20]:
    can_invoke = False
    try:
        ip = e.GetInvokePattern()
        can_invoke = ip is not None
    except Exception:
        pass
    print(f"  {ct:<22} name={nm!r:<14} aid={aid!r:<18} Invoke={can_invoke}")

print("\n提示：输入框里现在可能留着测试文字，请手动删掉（不要按回车）。")
