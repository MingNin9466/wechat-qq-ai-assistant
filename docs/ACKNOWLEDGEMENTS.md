# 致谢 / Acknowledgements

这个项目不是我一个人从零写出来的。它站在很多开源项目和作者的肩膀上。

## 核心依赖

| 项目 | 作者 / 组织 | 用在哪 |
|---|---|---|
| [DeepSeek API](https://platform.deepseek.com/) | 深度求索 | 对话、识图、思考模式 |
| [Node.js](https://nodejs.org/) | OpenJS Foundation | 运行时（24+，直接跑 TypeScript） |
| [`node:sqlite`](https://nodejs.org/api/sqlite.html) | Node.js 官方 | 记忆库与日志存储（FTS5 trigram） |
| [Python](https://www.python.org/) | Python Software Foundation | 桥接、TTS 调度、工具脚本 |
| [ffmpeg](https://ffmpeg.org/) | FFmpeg 团队 | 视频抽帧、音频转码、变调 |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | yt-dlp 贡献者 | 下载 B 站音视频 |
| [Pillow](https://python-pillow.org/) / [PyAudioWPatch](https://github.com/s0d3s/PyAudioWPatch) | — | 图片处理、WASAPI 回环录音 |

## 微信接入

| 项目 | 作者 | 说明 |
|---|---|---|
| [`wechatauto`](https://github.com/) | wechatauto 作者 | UI Automation 读写微信 4.x（数据库解密 + 独立窗口发送） |
| [WeChatFerry](https://github.com/lich0821/WeChatFerry) | lich0821 | 早期 hook 路线的参考（本项目最终未采用，版本门禁已失效） |
| [wxauto](https://github.com/cluic/wxauto) | cluic | UI 自动化的思路来源 |

## QQ 接入

| 项目 | 作者 | 说明 |
|---|---|---|
| [NapCatQQ](https://github.com/NapNeko/NapCatQQ) | NapNeko | QQ 协议端，提供 OneBot 11 接口 |
| [OneBot 11](https://github.com/botuniverse/onebot-11) | Bot Universe | 机器人应用层协议标准 |

## 语音合成

| 项目 | 作者 | 说明 |
|---|---|---|
| [火山引擎 / 豆包语音](https://www.volcengine.com/product/voice-tech) | 字节跳动 | TTS 与声音复刻 |
| [edge-tts](https://github.com/rany2/edge-tts) | rany2 | 免费的微软 TTS 兜底 |
| [faster-whisper](https://github.com/SYSTRAN/faster-whisper) | SYSTRAN | 本地语音识别（无字幕视频转写） |
| [MSST](https://github.com/Anjok07/ultimatevocalremovergui) / [DDSP-SVC](https://github.com/yxlllc/DDSP-SVC) | 各自作者 | 人声分离与换声（翻唱流水线用） |

## B 站数据

| 项目 | 说明 |
|---|---|
| [Bilibili 开放接口](https://api.bilibili.com/) | 视频信息、字幕、评论区图片（WBI 签名） |
| B 站 UP 主们 | 提供学习素材；本项目只读取公开内容，不搬运、不二次分发 |

## DSH 插件作者

这些插件的作者把功能做得很细，我从中学习了很多（尤其是"默认保守、只读优先、写入要人确认"的设计）：

- **Yuuyuko-uu** — [`dsh-bili-whale`](https://github.com/Yuuyuko-uu/dsh-bili-whale)、[`dsh-fish-memory`](https://github.com/Yuuyuko-uu/dsh-fish-memory)、[`dsh-tts-bridge`](https://github.com/Yuuyuko-uu/dsh-tts-bridge)、[`dsh-speak-up`](https://github.com/Yuuyuko-uu/dsh-speak-up)、[`dsh-qq-bridge`](https://github.com/Yuuyuko-uu/dsh-qq-bridge)
- **InariNGT-Ofiicial** — [`dsh-bili-humanism`](https://github.com/InariNGT-Ofiicial/dsh-bili-humanism)、[`dsh-cover-pipeline`](https://github.com/InariNGT-Ofiicial/dsh-cover-pipeline)、[`dsh-train-pipeline`](https://github.com/InariNGT-Ofiicial/dsh-train-pipeline)
- [`dsh-xiaomi-tts`](https://github.com/ppy-web/dsh-plugin-xiaomi-mimo-tts) 的作者 ppy-web
- DeepSeek Harness 本体及其插件生态的各位作者

## 特别感谢

- **DeepSeek** —— 一个普通学生也用得起的强模型，这个项目能成立全靠它
- **所有把微信自动化经验写出来的前人** —— 独立窗口、UIA 写入、前台锁这些坑，
  都是别人踩过、写下来，我才少走了很多弯路
- **B 站的 UP 主们** —— 情感、生活、梗、技术，构成了这个助手"理解人类"的全部素材

## 一句话

> 如果这个仓库对你有用，功劳大部分属于上面这些项目；
> 剩下的坑，是我踩出来的。

---

# Acknowledgements (English)

This project stands on the shoulders of giants: **DeepSeek** (the model), **Node.js** (runtime +
`node:sqlite`), **ffmpeg**, **yt-dlp**, **wechatauto** / **wxauto** (WeChat UI automation),
**NapCatQQ** + **OneBot 11** (QQ), **Volcengine/Doubao TTS** and **edge-tts** (speech),
**faster-whisper** (ASR), and the DSH plugin authors **Yuuyuko-uu**, **InariNGT-Ofiicial** and
**ppy-web**, whose work is listed in [`PLUGINS.md`](PLUGINS.md).

Thank you all.
