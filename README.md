# 微信群 / QQ 双平台 AI 助手（DeepSeek 驱动）

> 一个跑在自己群里的 AI 助手：能聊天、看懂图片和视频、联网查资料、刷 B 站学习、
> 有长期记忆和日记、能发语音和表情包，**微信和 QQ 双平台同一个大脑**。
>
> An AI assistant living in your own WeChat / QQ groups — vision, video understanding,
> web search, long-term memory, voice, stickers, and one shared brain across both platforms.

---

## 这个项目能做什么

| 能力 | 说明 |
|---|---|
| **群聊 + 私聊** | 微信群、微信私聊、QQ 群、QQ 私聊，统一进同一个调度器 |
| **一个大脑** | 同一套人格、同一份记忆库，按 `chat_id` 隔离，互不串味 |
| **看图** | 图片/表情包识别，能说出画面内容 |
| **看视频** | B 站链接 → 抽帧 + 字幕/ASR → 总结 |
| **联网** | 需要时走 DeepSeek 官方搜索接口 |
| **长期记忆** | 分层记忆（消息 → 摘要 → 记忆），支持核心记忆、共享记忆、人工确认 |
| **日记** | 每天 23:30 自动生成群日记 |
| **语音** | 豆包（火山引擎）TTS，支持音色复刻；QQ 发**原生语音条** |
| **表情包** | 自动收集群友表情、后台管理（上传/勾选批量删除/回收站）、回复时随机发 |
| **B 站学习** | 定时刷视频、写感想进记忆，评论区顺带收表情包 |
| **管理后台** | 设定、人格、日志、记忆、日记、表情包、调试、用量统计（按会话算钱） |

## 架构

```
 微信（4.1.x）                         QQ（NapCat / OneBot 11）
      │                                      │
      │ wechatauto 桥接（UIA 自动化）          │ HTTP 上报 / API
      ▼                                      ▼
 bridge/wechat_bridge.py  ◄── 8899 ──►  src/adapters/onebot.ts
      │                                      │
      └──────────────┬───────────────────────┘
                     ▼
            src/core/dispatcher.ts  ← 同一套人格 + 记忆 + 规则
                     ▼
              data/bot.sqlite（按 chat_id 隔离）
                     ▼
        DeepSeek API / 豆包 TTS / B 站 API
```

**发送消息不移动鼠标、不抢键盘**：文本走 UIA 写入 + PostMessage 回车；
图片/语音走剪贴板粘贴，遇到 Windows 前台锁先按一下 Alt 解锁。

## 环境要求

- Windows 10/11
- Node.js **24+**（直接运行 TypeScript，无需构建）
- Python 3.10+（桥接与工具脚本）
- 微信桌面版 4.1.x（登录一个小号）
- 可选：NapCat（QQ 协议端）、ffmpeg、yt-dlp

## 快速开始

```powershell
# 1. 安装依赖
npm install

# 2. 配置（复制模板，填自己的 Key）
Copy-Item env.example .env
notepad .env

# 3. 自检（会告诉你还缺什么）
npm run doctor

# 4. 本地试聊（不连微信、不花钱）
npm run demo

# 5. 正式启动
npm start -- --chat 群名A --chat 群名B --self-name 机器人昵称
```

启动前需要在微信里把目标群**右键 → 在独立窗口中打开**（每个要自动回复的群都要开一次）。

## 配置项（`.env`）

| 变量 | 作用 |
|---|---|
| `DEEPSEEK_API_KEY` | DeepSeek API Key（必填） |
| `DB_FILE` / `DATA_DIR` | 数据目录 |
| `ADMIN_PORT` | 管理后台端口（默认 8898） |
| `BRIDGE_URL` | 桥接地址（默认 127.0.0.1:8899） |
| `QQ_ENABLED` / `QQ_API_BASE` / `QQ_LISTEN_PORT` | QQ 接入（NapCat 的 API 与上报端口） |
| `PYTHON_PATH` | Python 解释器路径（TTS/工具用） |

本地密钥放 `tools/secrets.local.ps1`（**已被 .gitignore 排除**）：

```powershell
$env:DOUBAO_API_KEY = '你的火山引擎 Key'
$env:DOUBAO_VOICE = '你的复刻音色 ID'
$env:DOUBAO_RESOURCE = 'volc.seedicl.default'
```

## 管理后台

`http://127.0.0.1:8898`（或双击 `打开后台.cmd`）

| 页签 | 内容 |
|---|---|
| 概览 | 运行状态、快捷开关、按会话用量与花费、对话热度 |
| 设定 | 32+ 项：触发模式、关键词触发、防刷屏、限流、语音、记忆、表情包、随机插话、静默时段、安全 |
| 人格 | 按会话设置名字/风格/规则，可一键应用到所有会话 |
| 日志 | 实时查看 |
| 记忆 | 查看/编辑/设为核心/删除、共享候选确认（含 B 站与养鱼日记） |
| 日记 | 每日群日记 |
| 表情包 | 网格预览、上传、勾选批量删除、回收站恢复 |
| 调试 | 手动发文字/语音/表情包、刷视频学习、同步 B 站/养鱼数据、桥接状态 |

## 常用脚本

| 脚本 | 作用 |
|---|---|
| `一键重启.cmd` | 停旧进程 → 清停止标记 → 起机器人 → 起 QQ 协议端 |
| `停止运行.cmd` | 停止并写 `STOP.flag`，看门狗不会再拉起（打游戏/睡觉用） |
| `恢复运行.cmd` | 删标记并启动 |
| `打开后台.cmd` | 打开管理后台（没启动就先启动） |
| `启动QQ.cmd` | 启动 NapCat（需要管理员权限，会弹 UAC） |
| `设置常驻运行.cmd` | 关闭睡眠/休眠，让机器人 7×24 跑着 |

## 已实现的安全措施

- **单实例保护**：端口被占用时第二个实例直接退出，避免「一条消息回两次」
- **防刷屏**：同一人 2 分钟内重复内容只回一次
- **防泄露过滤器**：回复里出现「设定/提示词/任务」等词时整句删掉并换成自然岔开
- **图片/语音发送兜底**：前台锁住时先按 Alt 解锁，再退到 PostMessage
- **看门狗静默**：计划任务用 VBS 隐藏窗口启动，不会在游戏时弹黑框

## 已知限制

- 微信**没有**面向个人群的官方机器人接口，本项目用 UI 自动化接入，**有封号风险**，请用专用小号
- 微信语音只能发 mp3 **文件**（原生语音条需要微信内部接口，UI 自动化做不到）；**QQ 侧是真语音条**
- 每个要自动回复的群必须开独立窗口；微信主窗口不能最小化（现在会自动恢复）
- B 站接口随时可能变；AI 视频创作者的"真人感"音色依赖各家 TTS 服务

## 文档

- [`docs/00-方案与功能设计.md`](docs/00-方案与功能设计.md)
- [`docs/02-微信接入-wechatauto.md`](docs/02-微信接入-wechatauto.md)
- [`docs/PLUGINS.md`](docs/PLUGINS.md) —— 可选插件清单与用途
- [`docs/ACKNOWLEDGEMENTS.md`](docs/ACKNOWLEDGEMENTS.md) —— 致谢

## 许可证

[MIT](LICENSE)。第三方插件、模型、音色、B 站内容各有其许可与版权，**不随本项目授权**。

---

# English

An AI assistant for **WeChat and QQ groups**, powered by DeepSeek.

## Features

- **One brain, two platforms** — WeChat groups/private chats and QQ groups/private chats share
  the same dispatcher, persona and memory database, isolated per `chat_id`.
- **Vision & video** — understands images/stickers, extracts frames + subtitles from Bilibili links.
- **Long-term memory** — layered memory (messages → summaries → memories) with pinned core
  memories, an opt-in shared pool, and a human-review queue.
- **Voice** — Doubao (Volcengine) TTS with voice cloning; QQ sends **native voice messages**,
  WeChat sends mp3 files.
- **Sticker library** — auto-collects stickers people send, admin grid with upload / bulk delete /
  trash restore, random sticker replies.
- **Admin panel** — settings, personas, logs, memories, diaries, sticker manager, debug tools,
  and per-chat token/cost accounting.
- **No mouse hijacking** — messages are typed via UI Automation + `PostMessage`; images/audio use
  the clipboard with an Alt-key foreground unlock fallback.

## Requirements

Windows 10/11 · Node.js 24+ · Python 3.10+ · WeChat 4.1.x (use a spare account) ·
optional NapCat for QQ, ffmpeg, yt-dlp.

## Quick start

```powershell
npm install
Copy-Item env.example .env   # then fill DEEPSEEK_API_KEY
npm run doctor               # check what is missing
npm run demo                 # local dry run, no WeChat involved
npm start -- --chat "Group A" --self-name "MyBot"
```

Open each target group in a **separate detached window** once (right-click → open in separate window).

## License

MIT. Third-party plugins, models, voices and platform content keep their own licenses.

## Acknowledgements

See [`docs/ACKNOWLEDGEMENTS.md`](docs/ACKNOWLEDGEMENTS.md) — this project stands on the shoulders
of several excellent open-source projects and plugin authors.
