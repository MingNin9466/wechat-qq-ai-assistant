#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
探针：免费版 wxauto4 到底认不认你现在这个微信版本。

用法（微信必须已登录并保持窗口打开）：
    D:\\PyBot\\python.exe tools\\wxauto_probe.py

结果怎么读：
  - 打印「初始化成功」+ 会话列表 → 免费版可用，不需要降级微信
  - 抛「版本不支持 / 版本过低 / 未找到窗口」 → 需要把微信降到 4.1.8.107
"""
import sys
import traceback

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def main() -> int:
    print("=" * 50)
    print("wxauto4（免费版）兼容性探针")
    print("=" * 50)
    print("Python:", sys.version.split()[0], f"({sys.executable})")

    try:
        from importlib.metadata import version

        print("wxauto4 版本:", version("wxauto4"))
    except Exception as exc:
        print("wxauto4 未安装或无法读取版本:", exc)
        return 1

    try:
        from wxauto4 import WeChat
    except Exception as exc:
        print("✖ 导入 wxauto4 失败:", exc)
        return 1

    print("\n正在连接微信窗口…（微信需要已登录，并且不要最小化到托盘）")
    try:
        wx = WeChat()
    except Exception as exc:
        print(f"✖ 初始化失败：{type(exc).__name__}: {exc}")
        print("\n常见原因：")
        print("  1. 微信没登录 / 窗口被关掉")
        print("  2. 微信版本比免费版支持的 4.1.8.107 新 → 需要降级")
        print("  3. 微信还在启动动画中，稍等几秒再试")
        traceback.print_exc()
        return 2

    print("✔ 初始化成功")

    try:
        info = wx.ChatInfo()
        print("当前会话:", info)
    except Exception as exc:
        print("△ ChatInfo 调用失败:", exc)

    try:
        sessions = wx.GetSession()
        print(f"会话数量: {len(sessions)}")
        for s in list(sessions)[:8]:
            print("  -", getattr(s, "info", s))
    except Exception as exc:
        print("△ GetSession 调用失败:", exc)

    print("\n结论：免费版能连上，可以继续。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
