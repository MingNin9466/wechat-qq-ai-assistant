#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
逐个试发送方式，找出真正能把消息发出去的那一种。
每种方式都检查"输入框是否被清空"（清空 = 微信接受了发送）。
"""
import sys
import time

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

import wechatauto as wa
from wechatauto.uia_driver import WeChatUIA

u = WeChatUIA()
try:
    u.wake()
except Exception:
    pass
print("ensure_window:", u.ensure_window())
time.sleep(0.4)

el = u._chat_input()
print("输入框 Name:", el.Name if el else None)
if el is None:
    sys.exit("没有输入框")


def find_send_button():
    node = el
    for _ in range(4):
        p = node.GetParentControl()
        if p is None:
            break
        node = p
    stack = [(node, 0)]
    while stack:
        e, d = stack.pop()
        try:
            if e.ControlTypeName == "ButtonControl" and (e.Name or "").strip() == "发送":
                return e
            if d < 8:
                for k in e.GetChildren():
                    stack.append((k, d + 1))
        except Exception:
            continue
    return None


btn = find_send_button()
print("发送按钮:", btn.ClassName if btn else None, "enabled=", btn.IsEnabled if btn else None)

vp = el.GetValuePattern()


def set_text(t):
    vp.SetValue("")
    time.sleep(0.1)
    vp.SetValue(t)
    time.sleep(0.4)
    return (vp.Value or "").strip()


def cleared(timeout=3.0):
    end = time.time() + timeout
    while time.time() < end:
        try:
            if not (vp.Value or "").strip():
                return True
        except Exception:
            return False
        time.sleep(0.1)
    return False


# 清空遗留内容
set_text("")
time.sleep(0.3)
print("清空后 Value:", repr(vp.Value))

marker = time.strftime("%H%M%S")

# 方式 A：直接 Invoke
text_a = f"[A-Invoke] {marker}"
set_text(text_a)
print(f"\nA) 写入 {text_a!r}，按钮 enabled={btn.IsEnabled}")
try:
    btn.GetInvokePattern().Invoke()
except Exception as exc:
    print("   Invoke 异常:", exc)
print("   清空了吗:", cleared())

# 方式 B：先 SetFocus 再 Invoke
if not cleared(0.1):
    text_b = f"[B-Focus+Invoke] {marker}"
    set_text(text_b)
    try:
        el.SetFocus()
        time.sleep(0.2)
    except Exception as exc:
        print("   SetFocus 异常:", exc)
    print(f"\nB) 写入 {text_b!r}，按钮 enabled={btn.IsEnabled}")
    try:
        btn.GetInvokePattern().Invoke()
    except Exception as exc:
        print("   Invoke 异常:", exc)
    print("   清空了吗:", cleared())

# 方式 C：SetFocus 后 SendKeys 回车（会抢焦点，仅作诊断参照）
if not cleared(0.1):
    text_c = f"[C-Enter] {marker}"
    set_text(text_c)
    try:
        el.SetFocus()
        time.sleep(0.2)
        el.SendKeys("{Enter}", waitTime=0.05)
    except Exception as exc:
        print("   SendKeys 异常:", exc)
    print(f"\nC) 写入 {text_c!r} 后按回车")
    print("   清空了吗:", cleared())

print("\n=== 最终检查 ===")
print("输入框当前值:", repr(vp.Value))
try:
    db = wa.WeChatDB()
    uname = db.username_by_nickname("群B")
    msgs = db.get_messages(uname, limit=6)
    print("群里最近消息：")
    for m in msgs[-6:]:
        c = str(m.get("content") or "").replace("\n", " ")
        print("   ", c[:70])
except Exception as exc:
    print("读库失败:", exc)
