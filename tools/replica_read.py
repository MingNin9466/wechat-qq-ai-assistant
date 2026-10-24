#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""验证：读取指定会话的最近消息（只读）。"""
import sys
import traceback

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

import wechatauto as wa

db = wa.WeChatDB()
chats = db.list_message_chats()
print("有消息的会话数:", len(chats))

# 选一个群聊（@chatroom）
group = next((c for c in chats if str(c.get("username", "")).endswith("@chatroom")), chats[0])
print(f"\n目标会话: {group.get('name')}  ({group.get('username')})  共 {group.get('message_count')} 条")

username = group["username"]
print("\n=== 最近 8 条消息 ===")
try:
    msgs = db.get_messages(username, limit=8)
    print("拿到", len(msgs), "条")
    for m in msgs:
        if isinstance(m, dict):
            keys = ["local_id", "create_time", "type", "content", "sender", "is_sender", "sender_username"]
            info = {k: m.get(k) for k in keys if k in m}
            print("  -", info)
        else:
            print("  -", repr(m)[:200])
except Exception as exc:
    print("失败:", type(exc).__name__, exc)
    traceback.print_exc()

print("\n=== 我的信息 ===")
try:
    print(db.get_self_info())
except Exception as exc:
    print("失败:", exc)
