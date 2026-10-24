#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
诊断：SetValue 之后，"发送"按钮到底是不是被禁用。
同时尝试几种不同的写入方式，看哪种能让按钮变可用。
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
except Exception as exc:
    print("wake 失败:", exc)
print("ensure_window:", u.ensure_window())
time.sleep(0.5)

el = u._chat_input()
print("输入框:", el)
if el is None:
    sys.exit("✖ 没有输入框")

print("  当前会话(Name):", el.Name)


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
print("\n发送按钮:", btn)
if btn is None:
    sys.exit("✖ 没找到发送按钮")


def btn_state(tag):
    try:
        print(f"  [{tag}] IsEnabled={btn.IsEnabled}  IsOffscreen={btn.IsOffscreen}  "
              f"键盘可聚焦={btn.IsKeyboardFocusable}")
    except Exception as exc:
        print(f"  [{tag}] 读状态失败：{exc}")


print("\n--- 动作前 ---")
btn_state("空输入框")
try:
    vp = el.GetValuePattern()
    print("  ValuePattern 现值:", repr(vp.Value)[:60] if vp else None)
except Exception as exc:
    print("  ValuePattern 读取失败:", exc)

TEXT = "【UIA诊断】测试按钮状态 " + time.strftime("%H:%M:%S")

print(f"\n--- 方式 A：UIA ValuePattern.SetValue ---")
try:
    vp = el.GetValuePattern()
    vp.SetValue(TEXT)
    time.sleep(0.6)
    print("  回读:", repr(vp.Value)[:60])
    btn_state("SetValue 之后")
except Exception as exc:
    print("  失败:", exc)

print(f"\n--- 方式 B：LegacyIAccessible.SetValue ---")
try:
    la = el.GetLegacyIAccessiblePattern()
    print("  LegacyIAccessible:", la)
    if la:
        la.SetValue("")
        time.sleep(0.1)
        la.SetValue(TEXT)
        time.sleep(0.6)
        vp = el.GetValuePattern()
        print("  回读(UIA Value):", repr(vp.Value)[:60] if vp else None)
        btn_state("LegacyIAccessible 之后")
except Exception as exc:
    print("  失败:", exc)

print("\n--- 当前按钮状态（最终）---")
btn_state("最终")
print("\n如果 IsEnabled=False → 说明确实按钮被禁用，需要让微信感知到输入变更")
print("如果 IsEnabled=True  → 说明按钮可用，问题在别处（Invoke 没生效/点错了按钮）")
