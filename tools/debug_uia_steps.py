#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""逐步定位 UIA 发送卡在哪一步。"""
import sys
import time

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

from wechatauto.uia_driver import WeChatUIA  # noqa: E402

t0 = time.time()


def step(msg):
    print(f"[{time.time() - t0:6.1f}s] {msg}", flush=True)


step("初始化 WeChatUIA")
u = WeChatUIA()
step("ensure_window")
ok = u.ensure_window()
step(f"ensure_window = {ok}")
step(f"current_chat = {u.current_chat()}")

step("find_main")
win = u._find_main()
step(f"main = {win}")

# 找 ChatSessionCell
step("开始找会话项（限时 15s）")
deadline = time.time() + 15
cell = None
count = 0
stack = [(win, 0)]
while stack and time.time() < deadline:
    node, d = stack.pop()
    count += 1
    try:
        cls = node.ClassName or ""
    except Exception:
        continue
    if cls == "mmui::ChatSessionCell":
        first = (node.Name or "").split("\n")[0].strip()
        if first == "文件传输助手":
            cell = node
            break
    if d < 8:
        try:
            for k in node.GetChildren():
                stack.append((k, d + 1))
        except Exception:
            pass
step(f"遍历 {count} 个节点，找到 cell = {cell is not None}")

if cell is not None:
    step(f"cell name = {(cell.Name or '')[:40]!r}")
    try:
        sel = cell.GetSelectionItemPattern()
        step(f"SelectionItem pattern = {sel}")
        if sel:
            sel.Select()
            step("已调 Select()")
    except Exception as exc:
        step(f"Select 异常: {exc}")

    time.sleep(1.0)
    step(f"切换后 current_chat = {u.current_chat()}")

    step("取聊天输入框")
    el = u._chat_input()
    step(f"input = {el}")
    if el is not None:
        try:
            vp = el.GetValuePattern()
            step(f"ValuePattern = {vp}")
            if vp:
                vp.SetValue("")
                time.sleep(0.1)
                src = "[UIA直发测试] " + time.strftime("%H:%M:%S")
                vp.SetValue(src)
                time.sleep(0.3)
                step(f"回读 = {(vp.Value or '')[:40]!r}")
        except Exception as exc:
            step(f"写入异常: {exc}")
