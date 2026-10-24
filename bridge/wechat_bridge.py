#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
微信桥接进程（Python 侧）— 基于 wechatauto（wechatauto_replica）。

职责：只用 wechatauto 做「收发消息」，通过本地 HTTP 暴露给 Node 主程序。
所有业务逻辑（记忆、指令、人格、风控、LLM）都在 Node 侧。

为什么用 wechatauto 而不是 wxauto：
  - 微信 4.1.15 已经不自绘界面的 UIA 控件了（实测 UIA 树只有 4 个元素），wxauto4 直接失效
  - wechatauto 收消息走「本地数据库解密」（SQLCipher 4），不依赖 UIA
  - 发消息走「UIA + OCR 混合驱动」，UIA 不可用时自动降级到截图定位
  - 官方验证过微信 4.1.15.53，本项目实测 4.1.15.56 可用

HTTP 接口（默认 127.0.0.1:8899）：
  GET  /health                      状态
  POST /target   {chat}             指定要盯的群/联系人
  GET  /poll                        拉新消息
  POST /send     {chat, kind, ...}  发文本/图片/文件
  GET  /sessions                    会话列表（调试用）
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
import traceback
from collections import OrderedDict, deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

# ---------------------------------------------------------------- 基础

ENGINE = None
LOCK = threading.Lock()

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
    except Exception:
        pass


def log(*args):
    try:
        print("[bridge]", *args, flush=True)
    except Exception:
        pass


def window_state() -> dict:
    """微信主窗口状态：最小化 / 在屏幕外 / 正常。"""
    try:
        import ctypes
        import ctypes.wintypes as wt

        user32 = ctypes.windll.user32
        EP = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
        cands = []

        def cb(h, _):
            cls = ctypes.create_unicode_buffer(128)
            user32.GetClassNameW(h, cls, 128)
            if "QWindowIcon" not in cls.value:
                return True
            t = ctypes.create_unicode_buffer(64)
            user32.GetWindowTextW(h, t, 64)
            r = wt.RECT()
            user32.GetWindowRect(h, ctypes.byref(r))
            area = max(0, r.right - r.left) * max(0, r.bottom - r.top)
            cands.append({
                "h": h,
                "title": t.value,
                "rect": (r.left, r.top, r.right - r.left, r.bottom - r.top),
                "iconic": bool(user32.IsIconic(h)),
                "visible": bool(user32.IsWindowVisible(h)),
                "area": area,
            })
            return True

        user32.EnumWindows(EP(cb), 0)
        if not cands:
            return {"ok": False, "minimized": True, "offscreen": True, "rect": None}

        # 选主窗口：标题是"微信"优先，其次面积最大
        main = None
        for c in cands:
            if c["title"] == "微信":
                main = c
                break
        if main is None:
            main = max(cands, key=lambda c: c["area"])

        left, top, w, hgt = main["rect"]
        # Windows 把最小化窗口放到 (-32000, -32000)
        minimized = main["iconic"] or left <= -30000 or top <= -30000
        sw = user32.GetSystemMetrics(0)
        sh = user32.GetSystemMetrics(1)
        offscreen = (main["rect"][0] + w <= 0 or main["rect"][1] + hgt <= 0
                     or left >= sw or top >= sh or w <= 0 or hgt <= 0)
        return {
            "ok": True,
            "minimized": bool(minimized),
            "offscreen": bool(offscreen),
            "hwnd": main["h"],
            "rect": [left, top, w, hgt],
            "screen": [sw, sh],
            "title": main["title"],
            "candidates": len(cands),
        }
    except Exception as exc:
        return {"ok": False, "minimized": False, "offscreen": False, "error": str(exc)}


def foreground_info() -> dict:
    """
    当前前台窗口信息 + 是否全屏。
    全屏时（游戏/视频）绝对不能做任何窗口操作，否则会把游戏最小化、抢走鼠标。
    """
    try:
        import ctypes
        import ctypes.wintypes as wt

        user32 = ctypes.windll.user32
        kernel32 = ctypes.windll.kernel32
        hwnd = user32.GetForegroundWindow()
        if not hwnd:
            return {"ok": True, "fullscreen": False, "title": "", "exe": ""}

        n = user32.GetWindowTextLengthW(hwnd)
        buf = ctypes.create_unicode_buffer(n + 1)
        user32.GetWindowTextW(hwnd, buf, n + 1)
        title = buf.value

        cls = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(hwnd, cls, 256)

        rect = wt.RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(rect))

        MONITOR_DEFAULTTONEAREST = 2
        class MONITORINFO(ctypes.Structure):
            _fields_ = [
                ("cbSize", wt.DWORD),
                ("rcMonitor", wt.RECT),
                ("rcWork", wt.RECT),
                ("dwFlags", wt.DWORD),
            ]

        hmon = user32.MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST)
        mi = MONITORINFO()
        mi.cbSize = ctypes.sizeof(MONITORINFO)
        user32.GetMonitorInfoW(hmon, ctypes.byref(mi))
        mon = mi.rcMonitor

        covers = (
            rect.left <= mon.left + 2
            and rect.top <= mon.top + 2
            and rect.right >= mon.right - 2
            and rect.bottom >= mon.bottom - 2
        )
        shell = cls.value in ("Progman", "WorkerW", "Shell_TrayWnd", "Windows.UI.Core.CoreWindow")

        pid = wt.DWORD(0)
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        exe = ""
        try:
            h = kernel32.OpenProcess(0x1000, False, pid.value)
            if h:
                try:
                    b = ctypes.create_unicode_buffer(1024)
                    size = wt.DWORD(1024)
                    if kernel32.QueryFullProcessImageNameW(h, 0, b, ctypes.byref(size)):
                        exe = b.value
                finally:
                    kernel32.CloseHandle(h)
        except Exception:
            pass

        return {
            "ok": True,
            "fullscreen": bool(covers and not shell),
            "title": title,
            "class": cls.value,
            "exe": exe,
            "rect": [rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top],
        }
    except Exception as exc:
        return {"ok": False, "fullscreen": False, "error": str(exc)}



KIND_MAP = {
    "文本": "text",
    "图片": "image",
    "语音": "voice",
    "视频": "video",
    "文件/链接/卡片": "link",
    "文件": "file",
    "链接": "link",
    "动画表情": "image",
    "表情": "emoticon",
    "系统": "system",
    "位置": "other",
    "名片": "other",
    "合并转发": "other",
    "引用": "text",
}


# ---------------------------------------------------------------- 真实引擎

class UiaSender:
    """
    纯 UIA 发送：切会话 + 写输入框 + 点发送，全程不抢焦点、不动键鼠。

    依据（实测）：
      - 会话列表 ListItemControl(mmui::ChatSessionCell) 支持 SelectionItem/Invoke
      - 输入框 EditControl(mmui::ChatInputField) 支持 ValuePattern.SetValue，且真的写进客户端
      - 发送按钮 ButtonControl(name='发送') 支持 Invoke

    如果 UIA 不可用（树没物化 / 控件改名），调用方会退回原来的
    "激活窗口 + 剪贴板 + 回车" 方式（会抢键鼠）。
    """

    def __init__(self):
        self._u = None
        self._ready = False

    @property
    def u(self):
        if self._u is None:
            from wechatauto.uia_driver import WeChatUIA

            self._u = WeChatUIA()
        return self._u

    def available(self) -> bool:
        try:
            # wake() 负责把微信里关闭 UIA 的 gate 从 0 改成 1；
            # 窗口重建后 gate 会被重置，所以每次物化前都先 wake。
            self.u.wake()
        except Exception as exc:
            log("wake 失败（继续尝试）：", exc)
        try:
            return bool(self.u.ensure_window())
        except Exception as exc:
            log("UIA 不可用：", exc)
            return False

    def current_chat(self) -> str:
        try:
            return self.u.current_chat() or ""
        except Exception:
            return ""

    def _walk(self, el, depth=0, limit=8):
        """广度优先遍历，返回生成器（带深度限制，防止卡死）。"""
        stack = [(el, depth)]
        while stack:
            node, d = stack.pop()
            yield node, d
            if d >= limit:
                continue
            try:
                kids = node.GetChildren()
            except Exception:
                continue
            for k in kids:
                stack.append((k, d + 1))

    def switch_chat(self, chat_name: str, timeout: float = 4.0) -> bool:
        """
        纯 UIA 静默切群：在会话列表里选中对应 ListItem。
        全程不移动鼠标、不注入按键、不抢焦点。
        """
        if self.current_chat() == chat_name:
            return True
        deadline = time.time() + timeout
        while time.time() < deadline:
            table = self._session_table()
            if table is None:
                log("切群：会话表未找到（UIA 可能未物化）")
            else:
                try:
                    items = table.GetChildren()
                except Exception:
                    items = []
                if not items:
                    log("切群：会话表为 0 行（可能被遮挡或树未物化）")
                names = []
                for item in items:
                    try:
                        names.append((item.Name or "").split("\n")[0].strip())
                    except Exception:
                        continue
                if names:
                    log(f"切群：会话表 {len(names)} 行 → {names[:6]}")
                for item in items:
                    try:
                        first = (item.Name or "").split("\n")[0].strip()
                    except Exception:
                        continue
                    if first != chat_name:
                        continue
                    try:
                        sel = item.GetSelectionItemPattern()
                        if sel is not None:
                            sel.Select()
                        else:
                            inv = item.GetInvokePattern()
                            if inv is None:
                                return False
                            inv.Invoke()
                    except Exception as exc:
                        log("选中会话失败：", exc)
                        return False
                    for _ in range(25):
                        if self.current_chat() == chat_name:
                            return True
                        time.sleep(0.1)
                    return self.current_chat() == chat_name
            time.sleep(0.25)
        return False

    def _session_table(self):
        """会话列表：必须用强类型查询才物化（裸遍历拿不到）。"""
        try:
            win = self.u._find_main()
            if win is None:
                return None
            master = win.GroupControl(ClassName="mmui::ChatMasterView")
            if not master:
                return None
            return master.ListControl(ClassName="mmui::XTableView")
        except Exception:
            return None

    def _detached_hwnd(self, chat_name: str):
        """
        查找目标群的「独立聊天窗口」HWND（类名 mmui::ChatSingleWindow）。
        优先用 AutomationId 里的 chatroom/wxid 匹配（窗口标题会变，不可靠），
        拿不到 username 时再退回按 Name 匹配。
        """
        try:
            import ctypes
            import ctypes.wintypes as wt
            from wechatauto import uia

            # 独立窗口也要先把 UIA 树物化，否则 ControlFromHandle 拿不到 ClassName
            if not self._ready:
                if not self.available():
                    return None
                self._ready = True

            username = ""
            try:
                if self.db is not None:
                    username = self.db.username_by_nickname(chat_name) or ""
            except Exception:
                username = ""

            user32 = ctypes.windll.user32
            EP = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
            cands = []

            def cb(h, _):
                cls = ctypes.create_unicode_buffer(128)
                user32.GetClassNameW(h, cls, 128)
                if "QWindowIcon" in cls.value and user32.IsWindowVisible(h):
                    cands.append(h)
                return True

            user32.EnumWindows(EP(cb), 0)
            for h in cands:
                try:
                    root = uia.ControlFromHandle(h)
                except Exception:
                    continue
                if root is None:
                    continue
                try:
                    if (root.ClassName or "") != "mmui::ChatSingleWindow":
                        continue
                    name = (root.Name or "").strip()
                    auto = (root.AutomationId or "").strip()
                    # 1) 最可靠：AutomationId == "ChatSingleWindow<username>"
                    if username and auto.endswith(username):
                        return h
                    # 2) 退回标题匹配
                    if name == chat_name:
                        return h
                except Exception:
                    continue
        except Exception as exc:
            log("查找独立窗口失败：", exc)
        return None

    def detached_list(self) -> list[dict]:
        """列出所有独立聊天窗口（调试用）。"""
        out = []
        try:
            import ctypes
            import ctypes.wintypes as wt
            from wechatauto import uia

            if not self._ready:
                if not self.available():
                    return out
                self._ready = True

            user32 = ctypes.windll.user32
            EP = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
            cands = []

            def cb(h, _):
                cls = ctypes.create_unicode_buffer(128)
                user32.GetClassNameW(h, cls, 128)
                if "QWindowIcon" in cls.value and user32.IsWindowVisible(h):
                    cands.append(h)
                return True

            user32.EnumWindows(EP(cb), 0)
            for h in cands:
                try:
                    root = uia.ControlFromHandle(h)
                    if root is not None and (root.ClassName or "") == "mmui::ChatSingleWindow":
                        out.append({"hwnd": h, "chat": (root.Name or "").strip(),
                                    "automation": root.AutomationId})
                except Exception:
                    continue
        except Exception as exc:
            log("枚举独立窗口失败：", exc)
        return out

    def _find_detached_input(self, root):
        try:
            edit = root.GroupControl(ClassName="mmui::ChatInputView").EditControl(
                ClassName="mmui::ChatInputField", searchDepth=6
            )
            if edit:
                return edit
        except Exception:
            pass
        stack = [(root, 0)]
        while stack:
            n, d = stack.pop()
            try:
                if (n.ClassName or "") == "mmui::ChatInputField":
                    return n
            except Exception:
                pass
            if d < 12:
                try:
                    for k in n.GetChildren():
                        stack.append((k, d + 1))
                except Exception:
                    pass
        return None

    def _send_via_detached(self, hwnd, text: str) -> bool:
        """
        往独立聊天窗口自己的输入框写内容并发送。
        2026-10-23 实测：SetValue 会让该窗口获得前台，PostMessage 回车可送达，
        发送后把前台还给原窗口 —— 全程鼠标零移动、焦点零残留。
        """
        try:
            import ctypes

            from wechatauto import uia

            user32 = ctypes.windll.user32
            WM_KEYDOWN, WM_KEYUP, VK_RETURN = 0x0100, 0x0101, 0x0D
            prev_fg = user32.GetForegroundWindow()
            cleared = False
            try:
                root = uia.ControlFromHandle(hwnd)
                if root is None:
                    return False
                edit = self._find_detached_input(root)
                if edit is None:
                    log("独立窗口里找不到输入框")
                    return False
                vp = edit.GetValuePattern()
                if vp is None:
                    return False
                vp.SetValue("")
                time.sleep(0.03)
                vp.SetValue(text)
                for _ in range(24):
                    try:
                        if (vp.Value or "").strip():
                            break
                    except Exception:
                        break
                    time.sleep(0.03)
                user32.PostMessageW(hwnd, WM_KEYDOWN, VK_RETURN, 0x001C0001)
                time.sleep(0.03)
                user32.PostMessageW(hwnd, WM_KEYUP, VK_RETURN, 0xC01C0001)
                for _ in range(40):
                    try:
                        if not (vp.Value or "").strip():
                            cleared = True
                            break
                    except Exception:
                        cleared = True
                        break
                    time.sleep(0.03)
            finally:
                # 把前台还给用户原来的窗口，不留下焦点残留
                if prev_fg:
                    try:
                        user32.SetForegroundWindow(prev_fg)
                    except Exception:
                        pass
            return cleared
        except Exception as exc:
            log("独立窗口写入异常：", exc)
            return False

    def _chat_input(self):
        return self.u._chat_input()

    def _find_send_button(self, edit_el):
        node = edit_el
        for _ in range(4):
            try:
                p = node.GetParentControl()
            except Exception:
                p = None
            if p is None:
                break
            node = p
        for el, _d in self._walk(node, limit=8):
            try:
                if el.ControlTypeName != "ButtonControl":
                    continue
                name = (el.Name or "").strip()
            except Exception:
                continue
            if name in ("发送", "发送(S)", "Send"):
                return el
        return None

    def send_text(self, chat_name: str, text: str) -> bool:
        """
        发送文本（纯 UIA，不抢键鼠）。
          - 当前会话就是目标 → 直接写输入框 + 回车发出
          - 不是目标 → 尝试 UIA 切会话；切不过去返回 False
        注意：库里的 current_chat() 不稳定（有时返回 None），
        用输入框元素的 Name 判断当前会话更可靠。
        """
        # 窗口被最小化/藏托盘/在屏幕外时，UIA 定位必然失败
        state = window_state()
        if state.get("minimized"):
            # 尝试自动恢复（不移动鼠标，只是把窗口从最小化状态拉回来）
            try:
                import ctypes

                u32 = ctypes.windll.user32
                SW_RESTORE = 9
                main = state.get("hwnd") or u32.FindWindowW("WeChatMainWndForPC", None)
                if main:
                    u32.ShowWindow(main, SW_RESTORE)
                    time.sleep(0.7)
                state = window_state()
            except Exception as exc:
                log("恢复最小化窗口失败：", exc)
            if state.get("minimized"):
                log("微信窗口仍是最小化，这次发不出去（请把微信从任务栏恢复）")
                return False
            log("已自动把微信窗口从最小化恢复")
        if state.get("offscreen"):
            log(f"微信窗口在屏幕外 {state.get('rect')}，跳过发送（请拖回屏幕内）")
            return False

        # 首选：独立聊天窗口（把群单独开成窗口）。它有自己独立的输入框，
        # 直接写进去即可 —— 不切群、不移动鼠标、不注入按键。
        hwnd = self._detached_hwnd(chat_name)
        if hwnd is not None:
            if self._send_via_detached(hwnd, text):
                return True
            log(f"独立窗口发送失败，回退到主窗口路径（{chat_name}）")
        # 物化只需要做一次：ensure_window() 会把微信切到前台，
        # 成功之后就不再重复调用，避免每条消息都跳窗口。
        if not self._ready:
            if not self.available():
                return False
            self._ready = True

        el = self._chat_input()
        if el is None:
            # 树被回收了（比如窗口重建），重新物化一次再试
            self._ready = False
            if not self.available():
                return False
            self._ready = True
            time.sleep(0.3)
            el = self._chat_input()
        if el is None:
            log("拿不到聊天输入框（UIA 未物化）")
            return False
        try:
            current = (el.Name or "").strip()
        except Exception:
            current = ""

        # 输入框的 Name 有时会带提示文字，例如 "群B长按鼠标 语音输入"，
        # 所以用前缀匹配而不是全等。
        same_chat = bool(current) and (current == chat_name or current.startswith(chat_name))
        if not same_chat:
            if not self.switch_chat(chat_name):
                log(f"UIA 无法静默切到「{chat_name}」（输入框 Name={current!r}）")
                return False
            el = self._chat_input()
            if el is None:
                return False

        try:
            vp = el.GetValuePattern()
            if vp is None:
                return False
            vp.SetValue("")
            time.sleep(0.05)
            vp.SetValue(text)
        except Exception as exc:
            log("UIA 写入输入框失败：", exc)
            return False

        # 等输入框真的拿到内容（避免发出空消息）
        written = False
        for _ in range(20):
            try:
                if (vp.Value or "").strip() == text.strip():
                    written = True
                    break
            except Exception:
                pass
            time.sleep(0.05)
        if not written:
            log("UIA 写入未生效，放弃（不回车，避免发空消息）")
            return False

        # 发送：给输入框发回车。
        # 实测（2026-10-23）：
        #   - 发送按钮的 InvokePattern 是空实现，点了不发
        #   - 输入框的 SendKeys("{Enter}") 能真正发出，且不改变前台窗口
        try:
            el.SendKeys("{Enter}", waitTime=0.05)
        except Exception as exc:
            log("发送回车失败：", exc)
            return False

        # 只有输入框被清空才算真的发出去了
        for _ in range(30):
            try:
                if not (vp.Value or "").strip():
                    return True
            except Exception:
                break
            time.sleep(0.1)
        log("回车后输入框未清空，判定未发出")
        return False


class ReplicaEngine:
    """wechatauto：数据库收消息（支持同时盯多个会话）+ UIA 发消息。"""

    def __init__(self, chats, self_name: str, media_dir: Path, send_mode: str = "uia",
                 fallback_focus: bool = False):
        # 去重保序
        self.chat_names = [c for c in dict.fromkeys(chats or []) if c]
        self.chat_name = self.chat_names[0] if self.chat_names else ""
        self.self_name = self_name
        self.media_dir = media_dir
        self.send_mode = send_mode
        self.fallback_focus = fallback_focus
        self.db = None
        self.wx = None
        self.uia_sender = UiaSender()
        self.recent_delivered: "deque[dict]" = deque(maxlen=400)
        self._db_born = 0.0
        self.db_refresh_sec = float(os.environ.get("BRIDGE_DB_REFRESH", "3"))
        # name -> {username, is_group, last_seq}
        self.targets: dict[str, dict] = {}
        self.self_wxid = ""
        self.nick_cache: dict[str, str] = {}
        self.package = "wechatauto"
        self.plus = True
        self.media_dir.mkdir(parents=True, exist_ok=True)

    # -- 初始化 ----------------------------------------------------------
    def connect(self) -> None:
        import wechatauto as wa

        self.db = wa.WeChatDB()
        self._db_born = time.time()
        me = self.db.get_self_info() or {}
        self.self_wxid = me.get("username", "")
        if not self.self_name:
            self.self_name = me.get("nick_name", "")
        log(f"数据库已连接，本人：{me.get('nick_name')} ({self.self_wxid})")

        # 关键安全补丁：库默认会把所有挡在微信前面的窗口"最小化"（连 Chrome 都算），
        # 这会在用户打游戏/看视频时把窗口全收了。我们把它禁掉——
        # 宁可这次发送失败（库还有"落点不属于微信就拒发"的安全检查），也绝不动用户的窗口。
        try:
            from wechatauto.guia import WeChatGUI

            WeChatGUI._minimize_blockers = lambda self: 0  # type: ignore[method-assign]
            log("已禁用「自动最小化遮挡窗口」")
        except Exception as exc:
            log("禁用自动最小化失败（继续）：", exc)

        # ===== 安全模式（2026-10-23 事故后加）=====
        # 事故：库在"清空搜索框"时会发 Ctrl+A + Delete。当焦点不在微信上时，
        # 这两个键落到桌面 => 全选并删除，用户桌面 81 个快捷方式进了回收站。
        # 现在：彻底禁用「全局按键注入」和「搜索框切群」。
        # 代价：跨群自动回复不再可用（它必须靠打字切群），只在目标群已是当前会话时才发。
        try:
            from wechatauto import WinInput

            def _blocked_key(self, *a, **k):
                log("⛔ 安全模式：拦截了一次全局按键注入（Ctrl+A/Delete 之类）")
                return None

            WinInput.key = _blocked_key  # type: ignore[method-assign]
            log("安全模式：已禁用全局按键注入")
        except Exception as exc:
            log("禁用全局按键失败（危险）：", exc)

        try:
            WeChatGUI._search_chat = lambda self, name: False  # type: ignore[method-assign]
            log("安全模式：已禁用「搜索框切群」")
        except Exception as exc:
            log("禁用搜索切群失败（继续）：", exc)

        self.wx = wa.WeChat()
        log("GUI 驱动已就绪")

        # 启动时就把 UIA 树物化一次（会短暂把微信窗口带到前台），
        # 避免把这次"抖动"算到第一条用户消息头上。
        try:
            if self.uia_sender.available():
                log("UIA 树已物化（启动阶段完成）")
            else:
                log("UIA 物化失败，将在首次发送时重试")
        except Exception as exc:
            log("启动物化异常（继续）：", exc)

        for name in self.chat_names:
            try:
                self.open_chat(name)
            except Exception as exc:
                log(f"盯住「{name}」失败：{exc}")
        if not self.targets:
            log("⚠ 没有任何会话在监听，请检查 --chat 名称")

    def _resolve(self, name: str):
        """把显示名解析成 username（先精确查，再在会话列表里模糊找）。"""
        username = ""
        try:
            username = self.db.username_by_nickname(name) or ""
        except Exception:
            username = ""
        real = name
        if not username:
            try:
                for s in self.db.get_sessions(limit=300):
                    u = str(s.get("username") or "")
                    if not u:
                        continue
                    n = self._nick(u)
                    if n == name or name in n:
                        username, real = u, n
                        break
            except Exception:
                pass
        return username, real

    def open_chat(self, chat: str) -> str:
        username, real = self._resolve(chat)
        if not username:
            raise RuntimeError(
                f"找不到会话「{chat}」。请把微信里显示的群名/备注名原样传进来；"
                "可以先 GET /sessions 看现有会话。"
            )
        is_group = username.endswith("@chatroom")
        self.targets[real] = {
            "username": username,
            "is_group": is_group,
            "last_seq": self._latest_seq(username),
        }
        if not self.chat_name:
            self.chat_name = real
        log(f"开始盯：{real} ({username}) group={is_group} 基线 seq={self.targets[real]['last_seq']}")
        return real

    def _latest_seq(self, username: str) -> int:
        try:
            msgs = self.db.get_messages(username, limit=1)
            if msgs:
                m = msgs[-1]
                # 游标必须用 sort_seq：get_new_messages(since_seq=...) 是按它过滤的
                return int(m.get("sort_seq") or m.get("local_id") or 0)
        except Exception as exc:
            log("建立基线失败：", exc)
        return 0

    def _nick(self, wxid: str) -> str:
        if not wxid:
            return ""
        if wxid in self.nick_cache:
            return self.nick_cache[wxid]
        name = wxid
        try:
            name = self.db.get_nickname(wxid) or wxid
        except Exception:
            pass
        self.nick_cache[wxid] = name
        if len(self.nick_cache) > 3000:
            self.nick_cache.clear()
        return name

    # -- 媒体 ------------------------------------------------------------
    def _download_sticker(self, username: str, local_id: int) -> str | None:
        """
        表情包（动画表情）不在图片表里，但消息 XML 里带 cdnurl 直链。
        实测 CDN 返回的就是明文 PNG，不需要解密。
        """
        try:
            import html as html_mod
            import re
            import urllib.request

            rows = self.db.get_message_rows_for_media(username, int(local_id)) or []
            xml = ""
            for r in rows:
                c = str(r.get("content") or "")
                if "cdnurl" in c:
                    xml = c
                    break
            if not xml:
                # 回退：直接按 local_id 在最近消息里找（表情包常不在 media 行里）
                try:
                    for r in self.db.get_messages(username, limit=400) or []:
                        if int(r.get("local_id") or -1) != int(local_id):
                            continue
                        c = str(r.get("content") or "")
                        if "cdnurl" in c:
                            xml = c
                            break
                except Exception:
                    pass
            if not xml:
                log(f"表情包 {local_id}：没找到 cdnurl（可能不是表情或已过期）")
                return None
            m = re.search(r'cdnurl\s*=\s*"([^"]+)"', xml)
            if not m:
                # type=2 的表情可能只有 encrypturl
                m = re.search(r'encrypturl\s*=\s*"([^"]+)"', xml)
            if not m:
                return None
            url = html_mod.unescape(m.group(1))
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=25) as resp:
                data = resp.read()
            if not data:
                return None
            magic = data[:4]
            ext = ".png"
            if magic[:3] == b"\xff\xd8\xff":
                ext = ".jpg"
            elif magic[:3] == b"GIF":
                ext = ".gif"
            elif magic[:4] != b"\x89PNG":
                # 其它格式：可能是加密的 dat，交给解密器
                tmp = self.media_dir / f"sticker_{local_id}.dat"
                tmp.write_bytes(data)
                import wechatauto as wa

                dl = wa.MediaDownloader(self.db, save_dir=str(self.media_dir))
                try:
                    pt = dl.decrypt_image(str(tmp))
                    data = pt
                    ext = ".png" if pt[:4] == b"\x89PNG" else (".gif" if pt[:3] == b"GIF" else ".jpg")
                except Exception:
                    return None
            # 以最终字节的真实格式决定扩展名（CDN 有时返回 JPEG 而不是 PNG）
            if data[:4] == b"\x89PNG":
                ext = ".png"
            elif data[:3] == b"\xff\xd8\xff":
                ext = ".jpg"
            elif data[:3] == b"GIF":
                ext = ".gif"
            out = self.media_dir / f"sticker_{username.split('@')[0]}_{local_id}{ext}"
            out.write_bytes(data)
            log(f"表情包已下载：{out} ({len(data)} 字节)")
            return str(out)
        except Exception as exc:
            log("表情包下载失败：", exc)
            return None

    def download_media(self, chat_name: str, local_id: int) -> dict:
        """按需下载并解密图片/视频/语音/表情包，返回本地路径（供 Node 侧识图用）。"""
        try:
            import wechatauto as wa

            username = ""
            state = self.targets.get(chat_name)
            if state:
                username = state["username"]
            if not username:
                username = self.db.username_by_nickname(chat_name) or ""
            if not username:
                return {"ok": False, "error": f"找不到会话「{chat_name}」"}
            save_dir = str(self.media_dir)
            dl = wa.MediaDownloader(self.db, save_dir=save_dir)
            path = dl.download_media(username, int(local_id), save_dir=save_dir)
            if not path:
                path = self._download_sticker(username, int(local_id))
            if not path:
                return {"ok": False, "error": "下载失败（可能已过期或未解密）"}
            log(f"媒体已下载：{path}")
            return {"ok": True, "path": path}
        except Exception as exc:
            log("媒体下载异常：", exc)
            return {"ok": False, "error": str(exc)}

    # -- 收消息 ----------------------------------------------------------
    def _maybe_refresh_db(self) -> None:
        """
        库把微信数据库解密到 %TEMP%\\wechatauto_db 下的副本，长驻实例不会自动看到新消息。
        实测重新构造 WeChatDB() 只要 0.5s，所以按固定间隔重建一次。
        """
        if self.db is None:
            return
        now = time.time()
        if now - self._db_born < self.db_refresh_sec:
            return
        try:
            import wechatauto as wa

            self.db = wa.WeChatDB()
            self._db_born = now
        except Exception as exc:
            log("刷新数据库失败（继续用旧实例）：", exc)

    def poll(self) -> list[dict]:
        if not self.targets or self.db is None:
            return []
        self._maybe_refresh_db()
        out: list[dict] = []
        stats_line = []
        for name, state in list(self.targets.items()):
            try:
                msgs = self.db.get_new_messages(state["username"], since_seq=state["last_seq"], limit=100)
            except Exception as exc:
                log(f"读「{name}」失败：", exc)
                continue
            got = 0
            for m in msgs or []:
                try:
                    seq = int(m.get("sort_seq") or 0)
                    if seq <= state["last_seq"]:
                        continue
                    state["last_seq"] = seq
                    got += 1
                    item = self._convert(m, name, state["is_group"])
                    if item:
                        out.append(item)
                except Exception:
                    log("单条解析失败：\n" + traceback.format_exc())
            if got:
                stats_line.append(f"{name}+{got}")
        if stats_line:
            log("新消息 " + " ".join(stats_line) + f"（投递 {len(out)} 条）")
        out.sort(key=lambda x: x["ts"])
        # 记住最近投递过的消息：客户端如果因为网络/超时没拿到，可以按时间补拉
        for item in out:
            self.recent_delivered.append(item)
        return out

    def replay_since(self, ts: int) -> list[dict]:
        """返回 ts 之后投递过的消息（补发用）。"""
        try:
            return [m for m in list(self.recent_delivered) if int(m.get("ts") or 0) > ts]
        except Exception:
            return []

    def _convert(self, m: dict, chat_name: str, is_group: bool) -> dict | None:
        mtype = str(m.get("type") or "")
        kind = KIND_MAP.get(mtype, "other")
        if kind == "system":
            return None

        content = str(m.get("content") or "")
        sender_wxid = str(m.get("sender_username") or "")
        is_self = bool(sender_wxid) and sender_wxid == self.self_wxid

        text = content
        for prefix in (f"{sender_wxid}:\n", f"{sender_wxid}:"):
            if sender_wxid and text.startswith(prefix):
                text = text[len(prefix):]
                break

        is_at = False
        if is_group and not is_self and self.self_name:
            token = "@" + self.self_name
            if text.startswith(token):
                is_at = True
                text = text[len(token):].lstrip("\u2005 ")

        sender_name = "我" if is_self else (self._nick(sender_wxid) or "群友")

        # 图片/表情/视频的正文是 XML（含 md5、尺寸等），喂给模型会污染上下文，
        # 换成占位符；真正的画面由 Node 侧识图后单独注入。
        if kind in ("image", "emoticon", "video", "voice", "file"):
            text = {
                "image": "[图片]",
                "emoticon": "[表情]",
                "video": "[视频]",
                "voice": "[语音]",
                "file": "[文件]",
            }[kind]

        return {
            "id": f"{chat_name}:{m.get('local_id')}",
            "chatId": chat_name,
            "chatName": chat_name,
            "senderId": sender_wxid or "unknown",
            "senderName": sender_name,
            "isGroup": is_group,
            "isSelf": is_self,
            "isAtMe": is_at,
            "kind": kind,
            "text": (text or "").strip(),
            "rawType": mtype,
            "mediaPath": None,
            "ts": int(m.get("create_time") or time.time()) * 1000,
        }

    # -- 发消息 ----------------------------------------------------------
    def send(self, payload: dict) -> dict:
        kind = payload.get("kind", "text")
        who = payload.get("chat") or self.chat_name

        if kind == "text":
            text = (payload.get("text") or "").strip()
            if not text:
                return {"ok": False, "error": "empty text"}

            if self.send_mode == "uia":
                try:
                    if self.uia_sender.send_text(who, text):
                        return {"ok": True, "via": "uia"}
                except Exception as exc:
                    log("UIA 发送异常：", exc)
                # 不再用 ChatWith（它会移动鼠标点击）。切群已在 send_text 内部用
                # UIA SessionItem.Select() 完成，纯 UIA、不动鼠标。
                return {
                    "ok": False,
                    "error": (
                        "UIA 发送失败：切群失败或窗口被遮挡/最小化。"
                        "请保持微信窗口可见，或把目标群点开为当前会话。"
                    ),
                }

            if self.wx is None:
                return {"ok": False, "error": "GUI 未初始化"}
            # 显式切前台：库里的 ChatWith 靠"搜索框 + 点选"，没有前台焦点会静默失败
            activated = False
            try:
                activated = self.uia_sender.available()
            except Exception as exc:
                log("切前台失败：", exc)
            log(f"跨群发送：先激活微信窗口({activated})，目标={who}")
            res = self.wx.SendMsg(text, who=who)
            ok = bool(getattr(res, "is_success", False)) if res is not None else True
            if not ok:
                return {"ok": False, "error": str(getattr(res, "message", res))}
            return {"ok": True, "via": "input"}

        if kind in ("image", "file"):
            path = payload.get("path")
            if not path or not Path(path).exists():
                return {"ok": False, "error": f"文件不存在: {path}"}
            if self.wx is None:
                return {"ok": False, "error": "GUI 未初始化"}
            res = self.wx.SendFiles(path, who=who)
            ok = bool(getattr(res, "is_success", False)) if res is not None else True
            if not ok:
                return {"ok": False, "error": str(getattr(res, "message", res))}
            return {"ok": True, "via": "input"}

        if kind == "link":
            url = payload.get("url") or ""
            if not url:
                return {"ok": False, "error": "empty url"}
            title = payload.get("title") or ""
            return self.send({"kind": "text", "chat": who, "text": f"{title}\n{url}".strip()})

        return {"ok": False, "error": f"unsupported kind {kind}"}

    def set_clipboard_files(self, paths: list[str]) -> bool:
        """把一批文件放进剪贴板（CF_HDROP），粘贴到微信会变成文件消息。"""
        import subprocess

        items = ";".join(f"'{p}'" for p in paths)
        ps = (
            "Add-Type -AssemblyName System.Windows.Forms;"
            "$c=New-Object System.Collections.Specialized.StringCollection;"
            f"@({items}) | ForEach-Object {{ [void]$c.Add($_) }};"
            "[System.Windows.Forms.Clipboard]::SetFileDropList($c);"
            "Write-Output 'ok'"
        )
        try:
            r = subprocess.run(
                ["powershell.exe", "-NoProfile", "-STA", "-Command", ps],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=25,
            )
            return r.returncode == 0
        except Exception as exc:
            log("设置文件剪贴板失败：", exc)
            return False


    def _input_field_hwnd(self, hwnd: int):
        """拿到独立窗口里输入框的窗口句柄（用来直接发粘贴消息，不用抢前台）。"""
        try:
            import ctypes
            from wechatauto import uia
            root = uia.ControlFromHandle(hwnd)
            view = root.GroupControl(ClassName="mmui::ChatInputView")
            field = view.EditControl(ClassName="mmui::ChatInputField", searchDepth=6)
            h = int(getattr(field, "NativeWindowHandle", 0) or 0)
            return h or None
        except Exception:
            return None

    def _paste_without_focus(self, hwnd: int, chat_name: str) -> bool:
        """前台被锁时的兜底：先按 Alt 解锁前台抢焦点，再 Ctrl+V；都不行才直接发粘贴消息。"""
        import ctypes
        user32 = ctypes.windll.user32
        VK_MENU, VK_CONTROL, VK_V, VK_RETURN = 0x12, 0x11, 0x56, 0x0D
        KEYUP = 0x0002
        # 1) Alt 解锁 + 抢前台 + Ctrl+V（最可靠）
        try:
            user32.keybd_event(VK_MENU, 0, 0, 0)
            time.sleep(0.06)
            user32.keybd_event(VK_MENU, 0, KEYUP, 0)
            time.sleep(0.06)
            user32.SetForegroundWindow(hwnd)
            time.sleep(0.55)
            if user32.GetForegroundWindow() == hwnd:
                for vk, fl in ((VK_CONTROL, 0), (VK_V, 0), (VK_V, KEYUP), (VK_CONTROL, KEYUP)):
                    user32.keybd_event(vk, 0, fl, 0)
                    time.sleep(0.03)
                time.sleep(1.5)
                user32.PostMessageW(hwnd, 0x0100, VK_RETURN, 0)
                time.sleep(0.05)
                user32.PostMessageW(hwnd, 0x0101, VK_RETURN, 0)
                time.sleep(0.8)
                log(f"Alt 解锁前台后粘贴成功 -> {chat_name}")
                return True
        except Exception as exc:
            log("Alt 解锁失败：", exc)
        # 2) 兜底：直接给输入框发 WM_PASTE
        try:
            WM_PASTE = 0x0302
            fh = self._input_field_hwnd(hwnd)
            user32.PostMessageW(fh or hwnd, WM_PASTE, 0, 0)
            time.sleep(1.8)
            user32.PostMessageW(hwnd, 0x0100, VK_RETURN, 0)
            time.sleep(0.05)
            user32.PostMessageW(hwnd, 0x0101, VK_RETURN, 0)
            time.sleep(0.8)
            log(f"WM_PASTE 发送尝试完成 -> {chat_name}")
            return True
        except Exception as exc:
            log("WM_PASTE 失败：", exc)
            return False

    def send_file(self, chat_name: str, path: str) -> dict:
        """发一个文件（音频等）：剪贴板放文件 → 聚焦 → 粘贴 → 回车。不动鼠标。"""
        import ctypes
        from pathlib import Path

        p = Path(path)
        if not p.exists():
            return {"ok": False, "error": f"文件不存在: {path}"}
        hwnd = self.uia_sender._detached_hwnd(chat_name)
        if hwnd is None:
            return {"ok": False, "error": "该群没有独立窗口，发文件需要先开独立窗口"}

        user32 = ctypes.windll.user32
        prev = user32.GetForegroundWindow()
        if not self.set_clipboard_files([str(p)]):
            return {"ok": False, "error": "设置文件剪贴板失败"}
        try:
            user32.SetForegroundWindow(hwnd)
            time.sleep(0.45)
            if user32.GetForegroundWindow() != hwnd:
                # 切不到前台（Windows 前台锁）→ 直接给输入框发粘贴消息，不需要焦点
                if self._paste_without_focus(hwnd, chat_name):
                    return {"ok": True, "via": "post-paste"}
                return {"ok": False, "error": "无法把独立窗口切到前台"}
            VK_CONTROL, VK_V, VK_RETURN = 0x11, 0x56, 0x0D
            KEYUP = 0x0002
            for vk, flags in ((VK_CONTROL, 0), (VK_V, 0), (VK_V, KEYUP), (VK_CONTROL, KEYUP)):
                user32.keybd_event(vk, 0, flags, 0)
                time.sleep(0.03)
            time.sleep(1.2)
            user32.keybd_event(VK_RETURN, 0, 0, 0)
            time.sleep(0.05)
            user32.keybd_event(VK_RETURN, 0, KEYUP, 0)
            time.sleep(0.6)
            log(f"文件已发送：{p.name} -> {chat_name}")
            return {"ok": True, "via": "clipboard-file"}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}
        finally:
            if prev:
                try:
                    user32.SetForegroundWindow(prev)
                except Exception:
                    pass

    # -- 发表情/图片 ------------------------------------------------------
    def set_clipboard_image(self, path: str) -> tuple[bool, str]:
        """把图片放进 Windows 剪贴板（PowerShell + System.Drawing 最稳，不用额外库）。"""
        import subprocess

        ps = (
            "Add-Type -AssemblyName System.Windows.Forms,System.Drawing;"
            f"$img=[System.Drawing.Image]::FromFile('{path}');"
            "[System.Windows.Forms.Clipboard]::SetImage($img);"
            "$img.Dispose();"
            "Write-Output 'ok'"
        )
        try:
            r = subprocess.run(
                ["powershell.exe", "-NoProfile", "-STA", "-Command", ps],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=25,
            )
            return (r.returncode == 0, f"rc={r.returncode}")
        except Exception as exc:
            return (False, str(exc))

    def send_image(self, chat_name: str, path: str) -> dict:
        """
        发一张图（表情包）：图片进剪贴板 → 聚焦目标窗口 → Ctrl+V → 回车。
        全程不移动鼠标；焦点会短暂跳到微信窗口，发完立即还原。
        """
        import ctypes
        from pathlib import Path

        p = Path(path)
        if not p.exists():
            return {"ok": False, "error": f"文件不存在: {path}"}
        if p.stat().st_size > 8 * 1024 * 1024:
            return {"ok": False, "error": "图片太大（>8MB）"}

        hwnd = self.uia_sender._detached_hwnd(chat_name)
        if hwnd is None:
            return {"ok": False, "error": "该群没有独立窗口，发图需要先开独立窗口"}

        user32 = ctypes.windll.user32
        prev = user32.GetForegroundWindow()
        ok_clip, detail = self.set_clipboard_image(str(p))
        if not ok_clip:
            return {"ok": False, "error": f"设置剪贴板失败（{detail}）"}

        try:
            user32.SetForegroundWindow(hwnd)
            time.sleep(0.45)
            if user32.GetForegroundWindow() != hwnd:
                # 切不到前台（Windows 前台锁）→ 直接给输入框发粘贴消息，不需要焦点
                if self._paste_without_focus(hwnd, chat_name):
                    return {"ok": True, "via": "post-paste"}
                return {"ok": False, "error": "无法把独立窗口切到前台"}

            VK_CONTROL, VK_V, VK_RETURN = 0x11, 0x56, 0x0D
            KEYUP = 0x0002
            for vk, flags in ((VK_CONTROL, 0), (VK_V, 0), (VK_V, KEYUP), (VK_CONTROL, KEYUP)):
                user32.keybd_event(vk, 0, flags, 0)
                time.sleep(0.03)
            time.sleep(0.9)  # 等图片进入输入框
            user32.keybd_event(VK_RETURN, 0, 0, 0)
            time.sleep(0.05)
            user32.keybd_event(VK_RETURN, 0, KEYUP, 0)
            time.sleep(0.5)
            log(f"图片已发送：{p.name} -> {chat_name}")
            return {"ok": True, "via": "clipboard"}
        except Exception as exc:
            log("发图异常：", exc)
            return {"ok": False, "error": str(exc)}
        finally:
            if prev:
                try:
                    user32.SetForegroundWindow(prev)
                except Exception:
                    pass

    # -- 调试 ------------------------------------------------------------
    def sessions(self) -> list[dict]:
        rows = []
        try:
            for s in self.db.get_sessions(limit=200):
                u = str(s.get("username") or "")
                rows.append({
                    "username": u,
                    "name": self._nick(u),
                    "unread": s.get("unread"),
                    "last_time": s.get("last_time"),
                    "summary": (s.get("summary") or "")[:40],
                    "watching": any(v["username"] == u for v in self.targets.values()),
                })
        except Exception as exc:
            log("get_sessions 失败：", exc)
        return rows



# ---------------------------------------------------------------- mock 引擎

class MockEngine:
    def __init__(self, chat: str, self_name: str):
        self.chat = chat
        self.chat_name = chat
        self.self_name = self_name
        self.package = "mock"
        self.plus = False
        self.pending: list[dict] = []
        self.sent: list[dict] = []
        self._seq = 0

    def connect(self) -> None:
        log("mock 模式：不连接微信")

    def open_chat(self, chat: str) -> None:
        self.chat = chat
        self.chat_name = chat

    def poll(self) -> list[dict]:
        with LOCK:
            out, self.pending = self.pending, []
        return out

    def inject(self, payload: dict) -> dict:
        self._seq += 1
        text = str(payload.get("text") or "")
        sender = str(payload.get("sender") or "测试同学")
        msg = {
            "id": f"mock-{self._seq}",
            "chatId": self.chat,
            "chatName": self.chat,
            "senderId": sender,
            "senderName": sender,
            "isGroup": True,
            "isSelf": False,
            "isAtMe": bool(payload.get("isAtMe", True)),
            "kind": payload.get("kind", "text"),
            "text": text,
            "rawType": "text",
            "mediaPath": None,
            "ts": int(time.time() * 1000),
        }
        with LOCK:
            self.pending.append(msg)
        return {"ok": True, "id": msg["id"]}

    def send(self, payload: dict) -> dict:
        with LOCK:
            self.sent.append(payload)
        log(f"[mock 发送] {(payload.get('text') or payload.get('kind'))!s:.80}")
        return {"ok": True}

    def sessions(self) -> list[dict]:
        return [{"username": self.chat, "name": self.chat, "unread": 0, "last_time": 0, "summary": ""}]


# ---------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        return

    def _json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self) -> dict:
        try:
            n = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(n) if n else b"{}"
            return json.loads(raw.decode("utf-8") or "{}")
        except Exception:
            return {}

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/foreground":
            return self._json(foreground_info())
        if u.path == "/health":
            eng = ENGINE
            targets = getattr(eng, "targets", None)
            chats = list(targets.keys()) if isinstance(targets, dict) else [getattr(eng, "chat_name", "")]
            return self._json({
                "ok": True,
                "package": getattr(eng, "package", "unknown"),
                "plus": bool(getattr(eng, "plus", False)),
                "chat": getattr(eng, "chat_name", None),
                "chats": [c for c in chats if c],
                "self": getattr(eng, "self_name", ""),
                "send_mode": getattr(eng, "send_mode", None),
            })
        if u.path == "/poll":
            try:
                qs = parse_qs(u.query or "")
                since = qs.get("since", [""])[0]
                if since:
                    # 客户端"上次只收到这个时间点之前"，把之后投递过的补发一遍
                    miss = ENGINE.replay_since(int(since))
                    ENGINE.poll()  # 顺便推进游标
                    return self._json({"ok": True, "messages": miss, "replay": len(miss)})
                return self._json({"ok": True, "messages": ENGINE.poll()})
            except Exception as exc:
                log("poll 异常：\n" + traceback.format_exc())
                return self._json({"ok": False, "error": str(exc)}, 500)
        if u.path == "/sessions":
            try:
                return self._json({"ok": True, "sessions": ENGINE.sessions()})
            except Exception as exc:
                return self._json({"ok": False, "error": str(exc)}, 500)
        if u.path == "/window":
            return self._json(window_state())
        if u.path == "/detached":
            try:
                return self._json({"ok": True, "windows": ENGINE.uia_sender.detached_list()})
            except Exception as exc:
                return self._json({"ok": False, "error": str(exc)}, 500)
        if u.path == "/sent":
            if not isinstance(ENGINE, MockEngine):
                return self._json({"ok": False, "error": "仅 mock 模式可用"}, 400)
            return self._json({"ok": True, "sent": ENGINE.sent})
        return self._json({"ok": False, "error": "not found"}, 404)

    def do_POST(self):
        u = urlparse(self.path)
        payload = self._body()
        if u.path == "/target":
            chat = payload.get("chat")
            if not chat:
                return self._json({"ok": False, "error": "chat required"}, 400)
            try:
                ENGINE.open_chat(chat)
                return self._json({"ok": True, "chat": getattr(ENGINE, "chat_name", chat)})
            except Exception as exc:
                return self._json({"ok": False, "error": str(exc)}, 500)
        if u.path == "/media":
            chat = str(payload.get("chat") or "")
            mid = str(payload.get("id") or "")
            local_id = payload.get("local_id")
            if local_id is None and ":" in mid:
                local_id = mid.rsplit(":", 1)[1]
            try:
                local_id = int(local_id)
            except Exception:
                return self._json({"ok": False, "error": "需要 local_id 或形如 chat:local_id 的 id"}, 400)
            if not chat:
                return self._json({"ok": False, "error": "chat required"}, 400)
            if isinstance(ENGINE, MockEngine):
                return self._json({"ok": False, "error": "mock 模式无媒体"}, 400)
            try:
                return self._json(ENGINE.download_media(chat, local_id))
            except Exception as exc:
                log("media 异常：\n" + traceback.format_exc())
                return self._json({"ok": False, "error": str(exc)}, 500)
        if u.path == "/send-file":
            chat = str(payload.get("chat") or "")
            path = str(payload.get("path") or "")
            if not chat or not path:
                return self._json({"ok": False, "error": "需要 chat 和 path"}, 400)
            if isinstance(ENGINE, MockEngine):
                return self._json({"ok": False, "error": "mock 模式不支持发文件"}, 400)
            try:
                return self._json(ENGINE.send_file(chat, path))
            except Exception as exc:
                log("send-file 异常：\n" + traceback.format_exc())
                return self._json({"ok": False, "error": str(exc)}, 500)
        if u.path == "/send-image":
            chat = str(payload.get("chat") or "")
            path = str(payload.get("path") or "")
            if not chat or not path:
                return self._json({"ok": False, "error": "需要 chat 和 path"}, 400)
            if isinstance(ENGINE, MockEngine):
                return self._json({"ok": False, "error": "mock 模式不支持发图"}, 400)
            try:
                return self._json(ENGINE.send_image(chat, path))
            except Exception as exc:
                log("send-image 异常：\n" + traceback.format_exc())
                return self._json({"ok": False, "error": str(exc)}, 500)
        if u.path == "/send":
            try:
                return self._json(ENGINE.send(payload))
            except Exception as exc:
                log("send 异常：\n" + traceback.format_exc())
                return self._json({"ok": False, "error": str(exc)}, 500)
        if u.path == "/inject":
            if not isinstance(ENGINE, MockEngine):
                return self._json({"ok": False, "error": "仅 mock 模式可用"}, 400)
            return self._json(ENGINE.inject(payload))
        return self._json({"ok": False, "error": "not found"}, 404)


# ---------------------------------------------------------------- 自检

def preflight() -> int:
    print("=" * 50)
    print("微信桥接 · 环境自检（wechatauto 版）")
    print("=" * 50)
    print(f"Python      : {sys.version.split()[0]}  ({sys.executable})")

    ok = True
    try:
        from importlib.metadata import version

        print(f"wechatauto  : ✔ v{version('wechatauto_replica')}")
    except Exception as exc:
        ok = False
        print(f"wechatauto  : ✖ {exc}")
        print("  安装：D:\\PyBot\\python.exe -m pip install wechatauto_replica")

    try:
        import wechatauto as wa

        d = wa.auto_detect_db_dir()
        print(f"数据库目录  : {d or '✖ 未找到'}")
        if not d:
            ok = False
    except Exception as exc:
        ok = False
        print(f"数据库探测  : ✖ {exc}")

    print("=" * 50)
    print("结论：" + ("可以启动桥接" if ok else "环境不完整"))
    return 0 if ok else 1


def main() -> int:
    global ENGINE
    ap = argparse.ArgumentParser(description="微信桥接进程（wechatauto）")
    ap.add_argument("--port", type=int, default=int(os.environ.get("BRIDGE_PORT", "8899")))
    ap.add_argument("--chat", action="append", default=[], help="要盯的群名/备注名（可重复，盯多个群）")
    ap.add_argument("--chats", default=os.environ.get("BRIDGE_CHATS", ""), help="逗号分隔的多个群名")
    ap.add_argument("--self-name", default=os.environ.get("BOT_NAME", ""), help="机器人微信昵称（@ 检测用）")
    ap.add_argument("--media-dir", default=os.environ.get("BRIDGE_MEDIA", "data/media"))
    ap.add_argument(
        "--send-mode",
        choices=("uia", "input"),
        default=os.environ.get("BRIDGE_SEND_MODE", "uia"),
        help="uia=纯 UIA 后台发送（不抢键鼠）；input=模拟输入（会抢焦点）",
    )
    ap.add_argument(
        "--fallback-focus",
        action="store_true",
        help="UIA 发送失败时，允许回退到模拟输入（会短暂抢键鼠）。默认关闭。",
    )
    ap.add_argument("--mock", action="store_true", help="不连微信，联调用")
    ap.add_argument("--check", action="store_true", help="只做环境自检")
    args = ap.parse_args()

    if args.check:
        return preflight()

    chats = list(args.chat)
    if args.chats:
        chats += [c.strip() for c in args.chats.split(",") if c.strip()]
    if not chats and os.environ.get("BRIDGE_CHAT"):
        chats = [os.environ["BRIDGE_CHAT"]]

    if args.mock:
        ENGINE = MockEngine(chats[0] if chats else "测试群", args.self_name or "小深")
    else:
        ENGINE = ReplicaEngine(
            chats,
            args.self_name,
            Path(args.media_dir).resolve(),
            args.send_mode,
            args.fallback_focus,
        )

    try:
        ENGINE.connect()
    except Exception as exc:
        log("连接失败：", exc)
        log(traceback.format_exc())
        return 2

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    log(f"监听 http://127.0.0.1:{args.port}  engine={getattr(ENGINE, 'package', '?')}  chat={getattr(ENGINE, 'chat_name', '')}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("退出")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
