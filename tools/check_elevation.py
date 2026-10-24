#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""检查微信进程与当前 Python 的完整性级别（是否管理员），排查 UIPI 隔离。"""
import ctypes
import ctypes.wintypes as wt
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32
advapi32 = ctypes.windll.advapi32

EnumWindowsProc = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
TOKEN_QUERY = 0x0008
TokenElevation = 20


def elevation_of(pid: int) -> str:
    h = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not h:
        return f"无法打开进程 (err={ctypes.get_last_error()})"
    try:
        token = wt.HANDLE()
        if not advapi32.OpenProcessToken(h, TOKEN_QUERY, ctypes.byref(token)):
            return "无法读取令牌"
        try:
            val = wt.DWORD()
            size = wt.DWORD()
            if advapi32.GetTokenInformation(token, TokenElevation, ctypes.byref(val), ctypes.sizeof(val), ctypes.byref(size)):
                return "已提权（管理员）" if val.value else "普通权限"
            return "GetTokenInformation 失败"
        finally:
            kernel32.CloseHandle(token)
    finally:
        kernel32.CloseHandle(h)


targets = []


def cb(hwnd, _l):
    if user32.IsWindowVisible(hwnd):
        cls = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(hwnd, cls, 256)
        if "QWindowIcon" in cls.value:
            n = user32.GetWindowTextLengthW(hwnd)
            buf = ctypes.create_unicode_buffer(n + 1)
            user32.GetWindowTextW(hwnd, buf, n + 1)
            pid = wt.DWORD(0)
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            targets.append((hwnd, cls.value, buf.value, pid.value))
    return True


user32.EnumWindows(EnumWindowsProc(cb), 0)

print("当前 Python：", sys.executable)
print("自身提权：  ", elevation_of(kernel32.GetCurrentProcessId()))
print()

if not targets:
    print("没有找到 QWindowIcon 窗口")
for hwnd, cls, title, pid in targets:
    print(f"窗口 {hwnd}  class={cls}  title={title!r}  pid={pid}")
    print(f"  微信进程权限: {elevation_of(pid)}")
