# 微信接入：wechatauto（最新微信 4.1.x，不降级）

> **结论先行**：这条路已经在 2026-10-23 于本机实测跑通 —— 微信 **4.1.15.56**（最新），
> **不降级、不注入 hook、不花钱**，能正常收发群消息。

## 为什么是它

我们试过并淘汰的路线：

| 路线 | 为什么不行 |
|---|---|
| WeChatFerry（3.9 hook） | 腾讯服务器端封禁 3.9 登录（"版本过低"） |
| wxauto4 免费版 | 要求微信 ≤ 4.1.8.107 |
| wxauto Plus（¥200） | 同样依赖 UIA，而 4.1.15 的 UIA 树是空的 |
| 企业微信官方 | 进不了外部群（有微信用户的群） |

**根本原因**：微信 4.1.15 把界面改成纯自绘，UIA 无障碍树不注册控件了（实测只有 4 个元素）。
所有基于 UIA 的库全部失效。

**wechatauto（`wechatauto_replica`）怎么解决的**：

1. **收消息**：不解 UI，直接解密本地 SQLCipher 4 数据库
   （`Documents\xwechat_files\...\db_storage`），每 1 秒增量扫一次。
2. **发消息**：UIA + OCR 混合驱动，UIA 拿不到就截图定位。
3. **关键一步**：它会找到微信里关闭 UIA 的那个内存标志并**热激活**
   （日志：`热激活 UIA：PID=xxx Weixin.dll+0xb39c9d8: 0 -> 1`），把 UIA 树"物化"出来。

## 架构

```
微信 4.1.15（保持登录、窗口可见）
   ↑ 数据库解密（收）        ↑ UIA/OCR 驱动（发）
┌──┴────────────────────────┴──┐
│ bridge/wechat_bridge.py       │  Python：wechatauto
│ HTTP 127.0.0.1:8899           │
└──┬───────────────────────────┘
   │ JSON
┌──┴───────────────────────────┐
│ src/adapters/wxauto.ts        │  Node 适配器（接口没变）
└──┬───────────────────────────┘
   │
Dispatcher / 记忆 / LLM / 指令（完全复用，一行没改）
```

## 本机已装

| 项 | 值 |
|---|---|
| Python | 3.12.10 embeddable @ `D:\PyBot` |
| 包 | `wechatauto_replica 1.2.7.0` → 导入名 `wechatauto` |
| 依赖 | uiautomation 2.0.29、pyautogui、opencv-python、cryptography、zstandard、winsdk、numpy |
| 数据库 | 自动探测到 `C:\Users\你的名字\Documents\xwechat_files` |

## 启动

```powershell
# 1) 自检
D:\PyBot\python.exe bridge\wechat_bridge.py --check

# 2) 起桥接（--chat 填微信里显示的群名/备注名）
D:\PyBot\python.exe bridge\wechat_bridge.py --chat "你的群名" --self-name "机器人在群里的昵称"

# 3) 另开窗口起机器人
node src/main.ts --adapter=wxauto
```

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | `{ok, package, chat, self}` |
| GET | `/poll` | 拉新消息（增量） |
| GET | `/sessions` | 会话列表（调试用：填 --chat 前先看看确切名字） |
| POST | `/target` | `{chat}` 切换监听目标 |
| POST | `/send` | `{kind:'text'\|'image'\|'file'\|'link', chat, ...}` |

## 纯后台发送（不抢键鼠）—— 2026-10-23 实测通过 ✅

默认就是纯后台模式：**发消息不抢焦点、不动鼠标键盘。**

### 怎么做到的

微信 4.1.15 默认把 UIA 无障碍树关掉了（`Weixin.dll+0xb39c9d8` 那个开关是 0）。
`WeChatUIA.wake()` 把它改成 1，UIA 树就物化出来。然后：

| 环节 | 用的能力 | 抢键鼠？ |
|---|---|---|
| 写内容 | `EditControl(mmui::ChatInputField)` 的 `ValuePattern.SetValue()` | ❌ |
| 发出去 | 对该输入框 `SendKeys("{Enter}")` | ❌ |
| 切会话 | `ListItemControl(mmui::ChatSessionCell)` 的 `SelectionItem` | ❌（物化不稳定） |

### 踩过的三个坑

1. **发送按钮的 `Invoke()` 是空实现**：按钮 `IsEnabled=True`，但 `InvokePattern.Invoke()` 点了没反应、输入框也不清空。**真正有效的是给输入框发回车。**
2. **必须先 `wake()` 再 `ensure_window()`**：窗口重建后 gate 会重置回 0，只调 `ensure_window()` 会返回 False。
3. **判定"发出去了"要看输入框是否被清空**：早期版本无条件返回成功，造成"报 ok 但没发"的假成功。

### 实测结果

连续发 3 条，全部 `{"ok": true, "via": "uia"}`，**前台窗口全程没变**，数据库里 3 条都在：

```
【纯后台测试】第1条 16:39:40
【纯后台测试】第2条 16:39:43
【纯后台测试】第3条 16:39:48
```

### 仍然存在的限制

- **第一次发送会跳一次窗口**（UIA 物化需要激活一次微信），之后完全不打扰。
- **窗口必须在屏幕内**：跑到屏幕外（如 `left=-496`）控件定位会失效。
- **切会话还不稳**：会话列表的 UIA 物化时有时无。最稳的用法是**把机器人所在群保持为当前会话**，连切换都不用。
- 单条约 2~4 秒（库内部有节奏控制）。

## 实测记录（2026-10-23）

- 会话列表：179 个，名字全部正确解析
- 读消息：`26A2大数据` 群 7029 条历史消息可读，含发送人、类型、时间戳
- 发消息（模拟输入）：往「文件传输助手」发送成功
- 发消息（纯 UIA 后台）：测试群连发 3 条成功，前台焦点零变化
- 账号识别：`你的微信名 / wxid_p4ua3ldz2wcy22`（后来切到 `小助手`）

## 必须知道的限制

1. **发送方式可切换**：默认纯 UIA（不抢键鼠）；`--send-mode input` 才会走
   "切窗口 → 粘贴 → 回车"（抢焦点 1~2 秒）。UIA 失败时默认**不发**，
   除非显式加 `--fallback-focus`。
2. **微信窗口必须开着**：不能最小化到托盘、不能锁屏、**不能被挪到屏幕外**
   （踩过坑：窗口跑到 `left=-496` 或右边超出屏幕后，控件定位就失效了）。
3. **一次盯一个会话**：`--chat` 指定一个群。多群需要起多个桥接或扩展成多路轮询。
4. **没有链接卡片**：`SendUrlCard` 不存在，B 站分享会退化成"标题 + 链接"文本。
5. **封号风险 = 中低**：不注入、不改内存（除了那个 UIA 开关标志），比 hook 低，但不等于零。
6. **杀毒软件可能报警**：pyautogui / uiautomation 会被某些安全软件拦，加到白名单。

## 关于用哪个账号

`--chat` 和数据库都跟着**当前 PC 登录的微信号**走。所以：

- 用主号跑 → 机器人就是你自己在说话，且主号有风险
- 正确做法：**小号登录 PC 微信**，主号继续在手机上用，把机器人拉进群

## 排障

| 现象 | 原因 | 处理 |
|---|---|---|
| `/send` 超时 | 窗口被挡住/跑到屏幕外 | 把微信窗口摆回屏幕中央，别最小化 |
| `找不到会话「xxx」` | 群名和微信里显示的不一致 | `GET /sessions` 看确切名字 |
| 收不到消息 | 消息在子表需要时间落盘 | 等 1~2 秒；确认群名正确 |
| 启动报数据库错误 | 微信没登录 | 先登录再启动桥接 |
| 发送串字 | 发送瞬间你在打字 | 挂机时别用这台机器 |

---

## ⚠️ 安全模式（2026-10-23 事故后强制启用）

### 事故经过

库的 `_search_chat`（用搜索框切群）会调用 `WinInput.key()` 做**全局按键注入**：

```python
self._input.key(VK_A, ctrl=True)   # 全选
self._input.key(VK_DELETE)          # 删除
```

当微信窗口被遮挡/移出屏幕时，焦点在桌面或资源管理器上，这两个键就变成了
**桌面全选 + 删除** —— 用户桌面 81 个快捷方式被送进回收站（已用 Shell COM 全部还原）。

### 三道补丁（在创建 WeChat 实例之前执行）

```python
from wechatauto.guia import WeChatGUI
from wechatauto import WinInput

WeChatGUI._minimize_blockers = lambda self: 0            # 不再最小化用户窗口
WinInput.key = lambda self, *a, **k: None                # 禁所有全局按键注入
WeChatGUI._search_chat = lambda self, name: False        # 禁搜索框打字切群
```

补丁生效后启动日志会打印：

```
[桥接] 已禁用「自动最小化遮挡窗口」
[桥接] 安全模式：已禁用全局按键注入
[桥接] 安全模式：已禁用「搜索框切群」
```

### 打完补丁还能跨群吗？能

`wx.ChatWith(群名)` 走的是 **UIA/点击**路径（点击前会校验落点属于微信），
不依赖全局打字。所以跨群发送的实现是：

```
ChatWith(目标群) → 等 0.5s → UIA SetValue 写输入框 → SendKeys("{Enter}")
```

- 实测返回 `{"ok": true, "via": "uia+chatwith"}`
- 单条约 **10~20 秒**，会把微信窗口带到前台（这是唯一会抢焦点的地方）
- 同群回复仍是零打扰：不切窗口、不动鼠标

### 其他保护

| 保护 | 说明 |
|---|---|
| 全屏自动暂停 | 前台是全屏程序（游戏/视频）时不回复，见 `pauseWhenFullscreen` |
| 手动暂停 | 后台「设定 → 暂停」一键关闭 |
| 窗口状态检查 | 最小化/移出屏幕时直接跳过发送并说明原因 |
| 落点校验 | 库自带：点击落点不属于微信就放弃本次投递 |


---

## ✅ 跨群静默发送的最终方案：独立聊天窗口（2026-10-23 验证）

### 为什么需要它

跨群回复如果要求"不移动鼠标、不切换会话"，UIA 的 `SelectionItem.Select()` /
`Invoke()` 都是空实现（实测点了不动），切群只能靠点击，必然动鼠标。

### 解法

微信可以把**单个会话开成独立窗口**（右键会话 →「在独立窗口中打开」）。
这种窗口类名是 `mmui::ChatSingleWindow`，**自带独立的输入框**，
所以可以像主窗口一样用 UIA 直接写入——完全不需要切换会话。

### 实现

```python
# 1. 找到目标群的独立窗口
root = uia.ControlFromHandle(hwnd)          # ClassName == mmui::ChatSingleWindow
root.Name                                    # 就是群名

# 2. 找到它自己的输入框
edit = root.GroupControl(ClassName="mmui::ChatInputView") \
           .EditControl(ClassName="mmui::ChatInputField", searchDepth=6)

# 3. 写入 + 回车
prev = user32.GetForegroundWindow()
edit.GetValuePattern().SetValue(text)
user32.PostMessageW(hwnd, WM_KEYDOWN, VK_RETURN, 0x001C0001)
user32.PostMessageW(hwnd, WM_KEYUP,   VK_RETURN, 0xC01C0001)
user32.SetForegroundWindow(prev)            # 把前台还给用户
```

### 实测数据

| 指标 | 结果 |
|---|---|
| 鼠标移动 | **零** |
| 前台焦点 | 发送瞬间跳一下，**发送后立即归还** |
| 单条耗时 | **1.2 ~ 1.4 秒**（比切群方案快 10 倍） |
| 送达 | 3/3 全部成功 |

### 注意事项

1. **每个要自动回复的群，都要手动开一个独立窗口**（一次性操作）。
   没开独立窗口的群，仍然回退到主窗口路径——只有它正好是当前会话时才发得出去。
2. 桥接启动后**第一次**发往某个独立窗口时，会有一次光标跳动（该窗口首次被 UIA 访问的固有行为），之后全程静默。
3. 发送按钮 `mmui::XOutlineButton` 的 `Invoke` 也是空实现，**不要用**，必须走回车。
4. 独立窗口被关闭后会自动回退，重新打开即可恢复。

### 新增接口

```
GET /detached     → 列出当前所有独立聊天窗口
```

```json
{"ok": true, "windows": [{"hwnd": 921804, "chat": "群A", "automation": "ChatSingleWindow48470736338@chatroom"}]}
```