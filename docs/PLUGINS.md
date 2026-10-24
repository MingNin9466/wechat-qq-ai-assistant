# 可选插件清单

本项目**不依赖**这些插件也能跑（核心功能全在自己代码里）。
它们是我在实际使用中挑出来、装了确实有用的，列在这里供你参考。

> ⚠️ 这些是 **DeepSeek Harness（DSH）桌面助手** 的插件，不是本仓库的一部分，
> 也不会自动增强本项目的机器人群助手。装不装都不影响仓库代码运行。

安装方式（DSH 自带 CLI）：

```powershell
dsh plugin --profile desktop add <包名或本地 tgz>
```

---

## B 站内容学习（二选一或都装）

### 1. `dsh-bili-whale` —「养一条有日子的鱼」

- 仓库：https://github.com/Yuuyuko-uu/dsh-bili-whale
- 作者：Yuuyuko-uu
- 干什么：让 DSH 里的 agent **按作息自己刷 B 站**、看懂视频、写两本日记、把值得的 @ 你；
  有 27 项设置页（她是谁 / 你 / 口味 / 作息 / 分享 / 监听 / 日记推送 / 工具链）
- 我用它做什么：让它替我"看视频学人类"，再把这些日记/口味同步到机器人记忆（走人工确认队列）
- 注意：默认配置很保守（长时间高频轮询是小号被风控的头号原因），别急着调小间隔

### 2. `dsh-bili-humanism` —「用人类世界训练人格」

- 仓库：https://github.com/InariNGT-Ofiicial/dsh-bili-humanism
- 作者：InariNGT-Ofiicial
- 干什么：读 B 站视频的字幕与抽样画面，写成可追问、可修正的**信笺**，沉淀成 `human-world.md`
- 特点：只读不写、不评论、不私信，写入开关（历史/收藏/点赞/投币）默认全关

---

## 语音相关

### 3. `dsh-tts-bridge` —「朗读桥」

- 仓库：https://github.com/Yuuyuko-uu/dsh-tts-bridge
- 作者：Yuuyuko-uu
- 干什么：把 DSH 会话里的话交给 **DeepSeek 网页端朗读**，声音从你自己的音箱出来
- 组成：DSH 插件 + 浏览器扩展（Chrome/Edge 的「扩展程序 → 加载已解压」）
- 我用它做什么：试过用它 + 录音箱输出拿音色，后来改用豆包 TTS（更快、更可控）

### 4. `dsh-xiaomi-tts` —「小米 MiMo / 豆包语音朗读」

- npm：`dsh-xiaomi-tts`
- 干什么：接入小米 MiMo TTS 与豆包（火山引擎）语音，支持内置音色、音色设计、**声音复刻**
- 我用它做什么：先在它那里确认复刻音色能通，再把同一套接口直连进机器人
  （`src/integrations/doubao.ts`，见仓库里的实现）

### 5. `dsh-speak-up` —「没人说话时主动搭话」

- 仓库：https://github.com/Yuuyuko-uu/dsh-speak-up
- 作者：Yuuyuko-uu
- 干什么：本地掷骰子，掷中就让 agent 主动发起一轮对话

---

## 记忆相关

### 6. `dsh-fish-memory` —「鱼的记忆」

- 仓库：https://github.com/Yuuyuko-uu/dsh-fish-memory
- 作者：Yuuyuko-uu
- 干什么：给会话一份**会淡忘的**长期记忆，每条带时间；支持"这条被新事实取代"的可撤销更新

---

## 语音训练 / 翻唱（重型，看需不需要）

### 7. `dsh-cover-pipeline` —「本地 AI 翻唱流水线」

- 仓库：https://github.com/InariNGT-Ofiicial/dsh-cover-pipeline
- 作者：InariNGT-Ofiicial
- 干什么：分离 → 换声 → 移调 → 混音 → 验收，9 个工具串起来
- 依赖：MSST + DDSP-SVC 两套 Python 工程与音色权重（约 5GB，需自行下载）
- 我用它做什么：**没有真正跑通**——它的音色包里没有我要的角色，且训练需要额外素材；
  如果你要"用某角色声线翻唱"，它是对的工具

### 8. `dsh-train-pipeline` —「本地音色训练」

- 仓库：https://github.com/InariNGT-Ofiicial/dsh-train-pipeline
- 作者：InariNGT-Ofiicial
- 干什么：galgame 素材解包 → 角色盘点 → 数据集整理 → DDSP Reflow 训练 → 注册进音色库
- 依赖：同上（DDSP 工程 + GPU）

---

## 其他

### 9. `dsh-qq-bridge` — 通到 QQ

- 仓库：https://github.com/Yuuyuko-uu/dsh-qq-bridge
- 干什么：DSH 说完自动发 QQ，QQ 说的转进 DSH（OneBot 11，NapCat / SnowLuma 都行）
- 说明：本仓库的 QQ 接入是自己写的（`src/adapters/onebot.ts`），不依赖这个插件；
  但如果你想让 **DSH 助手本身**也通 QQ，它很有用

---

## 挑选插件的标准

我自己的经验（也是这个仓库作者的建议）：

1. **看更新频率**——半年没更新的，接口大概率已经失效
2. **看 star / 下载量 / 是否有真实 issue 讨论**
3. **看它要不要注入宿主的会话文件**——只读的最安全
4. **看默认开关**——好的插件默认保守（不自动写入、不自动点赞）

---

## 致谢

见 [`ACKNOWLEDGEMENTS.md`](ACKNOWLEDGEMENTS.md)。
