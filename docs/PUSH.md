# 怎么把它推上 GitHub

> 仓库已经在你本地初始化好并提交了一次（`publish/` 目录）。
> 剩下两步：在 GitHub 建空仓库，然后把本地推上去。

## 第 1 步：在 GitHub 建一个空仓库

1. 打开 https://github.com/new
2. Repository name 填个名字，比如 `wechat-qq-ai-assistant`
3. **不要**勾选 "Add a README file" / "Add .gitignore" / "Choose a license"（本地已经有了，勾了会冲突）
4. 点 **Create repository**

## 第 2 步：把本地推上去

打开 PowerShell，进到发布副本目录：

```powershell
cd "C:\Users\吴唐明\微信群聊deepseek\publish"

git remote add origin https://github.com/你的用户名/wechat-qq-ai-assistant.git
git branch -M main
git push -u origin main
```

第一次 push 会弹浏览器让你登录 GitHub 授权，按提示点就行。

## 如果 push 被拒绝

| 报错 | 原因 | 解决 |
|---|---|---|
| `remote: Permission denied` | 登录的账号没权限写这个仓库 | 确认仓库是你的，或换账号授权 |
| `failed to push some refs` | 远端不是空仓库 | 换一个新的空仓库，或先 `git pull --rebase` |
| `Authentication failed` | 凭据过期 | 在 Windows「凭据管理器」里删掉 git 的 GitHub 凭据，重新 push |

## 以后更新内容

```powershell
cd "C:\Users\吴唐明\微信群聊deepseek"
# 1. 重新生成脱敏副本（会覆盖 publish/ 里的文件，但 .git 保留）
& "D:\PyBot\python.exe" tools\make-publish.py

cd publish
git add -A
git commit -m "chore: 同步更新"
git push
```

> ⚠️ `make-publish.py` 会重建 `publish/` 目录（包括删掉 `.git`）。
> 如果不想丢提交历史，跑之前先把 `.git` 挪出去，跑完再放回来：
>
> ```powershell
> Move-Item publish\.git .git-tmp
> & "D:\PyBot\python.exe" tools\make-publish.py
> Move-Item .git-tmp publish\.git
> ```

## 发布前必查（每次都要）

```powershell
node tools\publish-audit2.mjs
```

它会把真实姓名、群名、QQ/微信号、API Key、音色 ID 全部列出来。
**必须是「✅ 没有发现真实敏感值」才能推。**

## 已经替你做过的脱敏

| 原值 | 替换成 |
|---|---|
| 真实姓名 | 你的名字 |
| 微信名 | 你的微信名 |
| 对方昵称 | 她 |
| 群名（3 个） | 群A / 群B |
| 微信号 / QQ 号 | `<YOUR_WECHAT_ID>` / `<YOUR_QQ_ID>` |
| 机器人 QQ 号 | `<BOT_QQ_ID>` |
| 豆包 API Key | `<YOUR_DOUBAO_API_KEY>` |
| 复刻音色 ID | `<YOUR_VOICE_ID>` |
| 机器人昵称 | 小助手 |

另外这些**没有**进仓库：

```
.env                     DeepSeek Key
data/                    聊天记录、记忆库、媒体
tools/secrets.local.ps1  豆包 Key
tools/plugins/           第三方插件包
tools/napcat/ tools/ffmpeg/ tools/mingw/ tools/python/   大体积依赖
参考音频/                 B 站音源
```
