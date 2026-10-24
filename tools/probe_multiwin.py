#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
探测两条无需切换会话的发送路径：
  A) 会话列表 UIA 节点（SelectionItem.Select 静默切群）
  B) 独立聊天窗口（每个群一个 HWND，各自的 ChatInputField）
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

print("=== 所有 QWindowIcon 窗口 ===")
rows = []


def cb(h, _):
    cls = ctypes.create_unicode_buffer(128)
    user32.GetClassNameW(h, cls, 128)
    if "QWindowIcon" in cls.value:
        t = ctypes.create_unicode_buffer(128)
        user32.GetWindowTextW(h, t, 128)
        r = wt.RECT()
        user32.GetWindowRect(h, ctypes.byref(r))
        rows.append((h, t.value, r.right - r.left, r.bottom - r.top,
                     bool(user32.IsWindowVisible(h)), bool(user32.IsIconic(h))))
    return True


user32.EnumWindows(EP(cb), 0)
for h, t, w, hh, vis, icon in rows:
    print(f"  hwnd={h}  {w}x{hh}  visible={vis} iconic={icon}  title={t!r}")

# 激活一次，帮助 UIA 物化
if rows:
    h0 = rows[0][0]
    user32.ShowWindow(h0, 9)
    user32.SetForegroundWindow(h0)
    time.sleep(0.8)

from wechatauto.uia_driver import WeChatUIA  # noqa: E402

u = WeChatUIA()
try:
    u.wake()
except Exception:
    pass
print("\nensure_window:", u.ensure_window())

# A) 找会话列表节点
win = u._find_main()
print("主窗口:", win.Name, win.ClassName)

cells = []
stack = [(win, 0)]
n = 0
while stack and n < 20000:
    node, d = stack.pop()
    n += 1
    try:
        cls = node.ClassName or ""
    except Exception:
        continue
    if cls == "mmui::ChatSessionCell":
        cells.append(node)
        if len(cells) >= 5:
            break
    if d < 12:
        try:
            for k in node.GetChildren():
                stack.append((k, d + 1))
        except Exception:
            pass

print(f"\nA) 遍历 {n} 个节点，会话项 {len(cells)} 个")
for c in cells[:5]:
    nm = (c.Name or "").split("\n")[0]
    pats = []
    for p in ("SelectionItem", "Invoke"):
        try:
            if getattr(c, "Get" + p + "Pattern")() is not None:
                pats.append(p)
        except Exception:
            pass
    print(f"   {nm!r}  模式={pats}")

# B) 每个 QWindowIcon 窗口里找输入框
print("\nB) 各窗口的输入框：")
for h, t, w, hh, vis, icon in rows:
    try:
        ctl = u.IUIA.ElementFromHandle(h) if hasattr(u, "IUIA") else None
    except Exception:
        ctl = None
    # 用库自带的 anchor/desc 方式不方便，直接遍历该窗口
    try:
        from wechatauto import uia as uia_mod

        root = uia_mod.ControlFromHandle(h)
    except Exception as exc:
        print(f"   hwnd={h} 取控件失败: {exc}")
        continue
    found = []
    st = [(root, 0)]
    m = 0
    while st and m < 800:
        node, d = st.pop()
        m += 1
        try:
            cls = node.ClassName or ""
        except Exception:
            continue
        if cls == "mmui::ChatInputField":
            found.append(node)
        if d < 12:
            try:
                for k in node.GetChildren():
                    st.append((k, d + 1))
            except Exception:
                pass
    names = []
    for f in found:
        try:
            names.append(f.Name)
        except Exception:
            names.append("?")
    print(f"   hwnd={h} title={t!r} 输入框={len(found)} 名称={names[:3]}")
