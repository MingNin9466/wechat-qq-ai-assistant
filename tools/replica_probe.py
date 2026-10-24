#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""探针：wechatauto（wechatauto_replica）能否识别并读取本机微信 4.1.15 的数据库。"""
import inspect
import sys
import traceback

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

import wechatauto as wa

print("=" * 60)
print("wechatauto 版本:", getattr(wa, "PROJECT_NAME", "?"))
print("=" * 60)

print("\n--- 关键函数签名 ---")
for name in ("auto_detect_db_dir", "WeChatDB", "WeChat", "Listener"):
    obj = getattr(wa, name, None)
    if obj is None:
        print(f"{name}: 不存在")
        continue
    try:
        print(f"{name}{inspect.signature(obj)}")
    except Exception as exc:
        print(f"{name}: 无法获取签名（{exc}）")

print("\n--- 自动探测数据库目录 ---")
try:
    d = wa.auto_detect_db_dir()
    print("db dir:", d)
except Exception as exc:
    print("探测失败:", type(exc).__name__, exc)
    traceback.print_exc()

print("\n--- 尝试打开数据库 ---")
try:
    db = wa.WeChatDB()
    print("WeChatDB 创建成功:", db)
    methods = [m for m in dir(db) if not m.startswith("_")]
    print("可用方法:", methods[:40])
except Exception as exc:
    print("WeChatDB 失败:", type(exc).__name__, exc)
    traceback.print_exc()

print("\n--- 尝试创建 WeChat 实例 ---")
try:
    wx = wa.WeChat()
    print("WeChat 创建成功:", wx)
    for m in ("ChatWith", "GetSession", "ChatInfo", "GetAllMessage", "SendMsg"):
        print(f"  有 {m}:", hasattr(wx, m))
except Exception as exc:
    print("WeChat 失败:", type(exc).__name__, exc)
    traceback.print_exc()
