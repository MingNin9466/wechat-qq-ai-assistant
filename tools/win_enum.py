#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""列出微信窗口的属主进程、路径、尺寸，用来判断是登录窗还是主窗口。"""
import ctypes
import ctypes.wintypes as wt
import os
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32
EnumWindowsProc = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000


def proc_name(pid: int) -> str:
    h = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not h:
        return "(无权限)"
    try:
        buf = ctypes.create_unicode_buffer(1024)
        size = wt.DWORD(1024)
        if kernel32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
            return buf.value
        return "(查询失败)"
    finally:
        kernel32.CloseHandle(h)


rows = []


def cb(hwnd, _lparam):
    if user32.IsWindowVisible(hwnd):
        n = user32.GetWindowTextLengthW(hwnd)
        buf = ctypes.create_unicode_buffer(n + 1)
        user32.GetWindowTextW(hwnd, buf, n + 1)
        title = buf.value.strip()
        if title:
            cls = ctypes.create_unicode_buffer(256)
            user32.GetClassNameW(hwnd, cls, 256)
            pid = wt.DWORD(0)
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            rect = wt.RECT()
            user32.GetWindowRect(hwnd, ctypes.byref(rect))
            w = rect.right - rect.left
            h = rect.bottom - rect.top
            rows.append((hwnd, cls.value, title, pid.value, w, h))
    return True


user32.EnumWindows(EnumWindowsProc(cb), 0)

print(f"{'HWND':<9} {'尺寸':<11} {'PID':<7} {'类名':<26} 标题")
print("-" * 110)
for hwnd, cls, title, pid, w, h in rows:
    print(f"{hwnd:<9} {f'{w}x{h}':<11} {pid:<7} {cls:<26} {title}")

print("\n--- 标题含“微信”的窗口详情 ---")
for hwnd, cls, title, pid, w, h in rows:
    if "微信" in title:
        print(f"HWND={hwnd}  {w}x{h}  class={cls}")
        print(f"  PID={pid}  exe={proc_name(pid)}")
        try:
            import win32api  # pywin32 已装

            print(f"  文件版本: {win32api.GetFileVersionInfo(proc_name(pid), chr(92) + 'FileVersion')}")
        except Exception as exc:
            print(f"  版本查询失败: {exc}")
