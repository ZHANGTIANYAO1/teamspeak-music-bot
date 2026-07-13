<p align="center">
  <img src="https://img.shields.io/badge/TeamSpeak-音乐机器人-blue?style=for-the-badge&logo=teamspeak" alt="TSMusicBot" />
</p>

<h1 align="center">TSMusicBot</h1>

<p align="center">
  <strong>TeamSpeak 音乐机器人</strong> — 网易云音乐 + QQ 音乐 + 酷狗音乐 + 哔哩哔哩 + YouTube（可选），YesPlayMusic 风格 WebUI 控制面板
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-20+-339933?logo=nodedotjs&logoColor=white" />
  <img src="https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white" />
  <img src="https://img.shields.io/badge/Vue-3-4FC08D?logo=vuedotjs&logoColor=white" />
  <img src="https://img.shields.io/badge/许可证-MIT-green" />
  <img src="https://img.shields.io/badge/FFmpeg-已内置-orange?logo=ffmpeg" />
  <img src="https://img.shields.io/badge/Docker-支持-2496ED?logo=docker&logoColor=white" />
  <img src="https://img.shields.io/badge/酷狗音乐-支持-2ca2f9" />
  <img src="https://img.shields.io/badge/BiliBili-支持-00a1d6?logo=bilibili&logoColor=white" />
  <img src="https://img.shields.io/badge/YouTube-可选-FF0000?logo=youtube&logoColor=white" />
  <img src="https://img.shields.io/badge/Spotify-可选-1DB954?logo=spotify&logoColor=white" />
  <img src="https://img.shields.io/badge/TS3-支持-2580C3?logo=teamspeak&logoColor=white" />
  <img src="https://img.shields.io/badge/TS6-支持-2580C3?logo=teamspeak&logoColor=white" />
</p>

## 功能特性

- **WebUI 鉴权与细粒度权限（必选）** — 用户名 + 密码登录，多用户、两种角色（管理员 / 成员）；成员可进一步配置**细粒度能力**（播放控制 / 队列管理 / 机器人管理 / 平台登录 / 音质）和**按机器人授权白名单**，所有变更操作由后端逐请求强制校验。bcrypt 加密、HttpOnly 会话 Cookie，CSRF 防护，WebSocket 同样鉴权。首次访问引导创建管理员。从无鉴权旧版本升级时请参阅 [更新升级](#更新升级) 章节
- **游客模式（免登录点歌，默认关闭）** — 管理员可选择允许访客**无需账号密码**进入 WebUI 点歌，并逐项配置游客权限（8 个开关，默认仅「添加到队列末尾」开启）与可控机器人白名单；游客无法查看 / 修改任何设置、管理机器人或访问用户管理。开启后登录页出现 **「以游客身份进入」**。详见下文 **「游客模式 / Guest mode」** 小节
- **本地收藏歌单** — 在首页 / 搜索 / 歌单页一键收藏，收藏内容按用户存储，登录后跨设备同步
- **本地音频上传播放** — 在搜索页拖拽或选择本地音频上传，上传后可直接播放 / 下一首播放 / 加入队列；管理员可在 设置 → 行为设置 开关此功能，播放结束或停止/清空/替换队列时会清理服务端接收的本地文件
- **专属链接（单机器人锁定）** — 通过 `/bot/<id>` 专属链接打开 WebUI 时锁定到单个机器人，刷新后保持，适合把某台机器人的控制页分享给特定用户
- **频道无人时自动暂停** — 机器人所在频道没有其他人时自动暂停播放，有人加入后自动恢复（**默认关闭**，可在设置中开启）
- **多平台音源** — 网易云音乐 + QQ 音乐 + 酷狗音乐 + 哔哩哔哩（默认内置），YouTube 可选启用（通过 yt-dlp），**Spotify（实验性）** 可选启用（需 Premium + 自建开发者应用，默认关闭，详见 [Spotify 音源（实验性）](#spotify-音源实验性)），统一搜索（歌曲 / 歌单 / 专辑均支持翻页「加载更多」），结果标注来源
- **真实客户端协议 (TS3/TS6 双协议)** — 机器人在 TeamSpeak 中可见（非 ServerQuery 隐身模式），自动检测并适配 TS3 和 TS6 服务器，支持 TS6 HTTP Query API
- **YesPlayMusic 风格 WebUI** — 精美界面，支持深色/浅色主题切换
- **完整播放控制** — 播放/暂停/上一首/下一首/进度跳转/音量调节
- **四种播放模式** — 顺序播放/循环播放/随机播放/随机循环
- **实时歌词同步** — 歌词滚动显示，支持翻译歌词，服务端帧计数精确同步
- **歌单管理** — 推荐歌单/我的歌单/每日推荐/私人FM，点击播放全部；私人 FM 支持网易云、**QQ 音乐雷达推荐**（`!fm -q`）与**酷狗私人电台**（`!fm -k`）。网易云、QQ、酷狗均提供登录后的推荐歌单 / 每日推荐 / 我的歌单
- **音质选择** — 标准(128k) / 较高(192k) / 极高(320k) / 无损(FLAC) / Hi-Res / 超清母带
- **B站视频音频提取** — 搜索B站视频，自动提取DASH最高码率音频流播放
- **B站热门推荐** — 首页展示B站热门视频和个性化推荐（登录后更准确）
- **QR码登录** — 扫码登录网易云/QQ音乐/酷狗音乐/哔哩哔哩账号，Cookie 自动持久化
- **机器人形象自动更新** — 播放时自动更新头像（专辑封面）、昵称（当前歌曲）、描述、Away 状态、频道描述，停止时恢复默认值。每项功能独立可配置，权限不足时自动降级
- **多机器人独立播放** — 多个机器人同时在不同服务器或频道播放不同音乐，每个机器人独立的播放队列、进度和音量，WebUI 一键切换控制
- **播放历史** — 自动记录所有播放过的歌曲
- **懒加载机制** — 歌单只存储元数据，播放时才获取链接（避免链接过期）
- **一键部署** — FFmpeg 内置，Windows 双击运行 / Linux systemd / Docker

## 截图

> <img width="2568" height="1408" alt="musicbot1" src="https://github.com/user-attachments/assets/47ba4f62-fae3-4c17-a7f7-b53f00885672" />
> <img width="2568" height="1408" alt="musicbot2" src="https://github.com/user-attachments/assets/42f4bef7-d41b-49e3-8c13-b4ce6c822dba" />

## 快速开始

### 方式一：Windows 一键部署（最简单）

只需电脑有网络连接，其他一切自动安装。

```
1. 下载或 clone 本项目
2. 双击 scripts\setup.bat      （首次安装，自动安装 Node.js 和所有依赖）
3. 双击 scripts\start.bat      （启动机器人）
4. 浏览器打开 http://localhost:3000
```

> `setup.bat` 会自动通过 winget 安装 Node.js（如果未安装），运行 `npm install` 安装所有依赖（包括内置 FFmpeg），最后构建项目。之后每次只需双击 `start.bat` 启动。

### 方式二：手动安装（所有系统）

**前置条件：** [Node.js 20+](https://nodejs.org/) 和一个 TeamSpeak 服务器（TS3/TS5/TS6 均可）。
FFmpeg **已自动内置**，无需手动安装。

```bash
# 下载项目
git clone https://github.com/ZHANGTIANYAO1/teamspeak-music-bot.git
cd teamspeak-music-bot

# 安装依赖
npm install
cd web && npm install && cd ..

# 构建
npm run build

# 启动
npm start
```

打开浏览器访问 **http://localhost:3000**，按照设置向导完成配置。

### 方式三：Docker 一键部署

所有依赖已内置（Node.js、FFmpeg、Opus 编码器），无需安装任何额外软件。

```bash
git clone https://github.com/ZHANGTIANYAO1/teamspeak-music-bot.git
cd teamspeak-music-bot/scripts/docker
docker-compose up -d
```

打开浏览器访问 **http://localhost:3000**

<details>
<summary>Docker 详细说明</summary>

- 首次构建需要几分钟（编译原生模块）
- 默认使用 `host` 网络模式，机器人可直接连接局域网 TS3 服务器
- 数据持久化在 Docker 命名卷 `tsmusicbot-data` 中（数据库、Cookie、日志）
- 内置健康检查（`/api/health`），支持 Docker 自动重启

```bash
docker logs -f tsmusicbot          # 查看日志
docker-compose down                # 停止
docker-compose up -d --build       # 代码更新后重新构建
```

如果 TS3 服务器在其他机器上，编辑 `docker-compose.yml`：
```yaml
# 将 network_mode: host 替换为：
ports:
  - "3000:3000"
```

</details>

### 方式四：Linux 一键安装

```bash
chmod +x scripts/install.sh
sudo ./scripts/install.sh
```

自动安装 Node.js 和依赖，配置 systemd 服务，支持开机自启。

## 更新升级

> **⚠️ 从使用 `@honeybbq/teamspeak-client 0.1.x` 的旧版本升级时的重要变更**
>
> 本项目已将底层 TeamSpeak 协议库升级到 `0.2.x` 并移除了内置的 TS6 兼容层，改用库自带的通用 `clientinit` 协议。这涉及一次**数据库迁移**：
>
> **旧的身份（identity）不兼容新的加密握手路径。** `0.1.0` 版本的库在生成 TS 客户端身份时存在 P-256 公钥 DER 编码错误，该 bug 在 `0.1.1` 中由本项目维护者 [ZHANGTIANYAO1](https://github.com/HoneyBBQ/teamspeak-js/pull/5) 修复并合并到上游。`0.1.0` 生成的身份与 `0.2.x` 修复后的握手路径**不兼容**：升级后用旧身份连接会卡在 `received initivexpand2` 直到 15 秒超时。
>
> **解决办法**：升级后清空受影响机器人的 `identity` 字段，下次启动时程序会自动生成新身份并持久化。
>
> ```bash
> # 对每个需要迁移的机器人执行（替换 <bot-id> 为实际 UUID）：
> python -c "import sqlite3; db=sqlite3.connect('data/tsmusicbot.db'); \
>   db.execute(\"UPDATE bot_instances SET identity=NULL WHERE id='<bot-id>'\"); \
>   db.commit()"
>
> # 或者清空所有机器人的身份：
> python -c "import sqlite3; db=sqlite3.connect('data/tsmusicbot.db'); \
>   db.execute('UPDATE bot_instances SET identity=NULL'); db.commit()"
> ```
>
> **影响范围**：
> - ✅ TS3 服务器 + 旧身份：在多数情况下仍可正常工作（TS3 对 legacy 编码更宽容），可选择不清空
> - ❌ TS6 服务器 + 旧身份：**必须**清空身份才能连接
> - ⚠️ 清空身份后，TS 服务器会把机器人识别为**全新的客户端**。之前手动赋予机器人的**服务器组需要用新 UID 重新授予一次**，之后每次重启都会自动保留
>
> **如何判断是否需要迁移**：如果你是全新安装，或者你的机器人数据库中 `identity` 字段已经是空的，则**无需任何操作**。完成上述步骤后，按下面对应的系统升级步骤执行即可。

### 从 WebUI 无鉴权版本升级（重要）

本次更新引入了**强制 WebUI 鉴权**。从无鉴权旧版本升级后，**WebUI 必须先创建管理员账号才能使用**。所有 `/api/*` 端点（除少量公共白名单）和 `/ws` 现在都需要登录。

**升级行为**：

- 启动时数据库自动迁移：新增 `users`、`sessions`、`user_audit` 三张表；旧的 `bot_instances`、`play_history` 数据**完全保留**。
- 第一次打开 WebUI 自动跳转到 `/first-run` 引导创建首位管理员（角色固定为 `admin`）。
- 之后访问任何页面都会校验登录态，未登录跳转 `/login`。

**会话与 Cookie**：

- 登录态保存 7 天，每次请求滚动续期（活跃用户不会被踢出）。
- 同一账号最多保持 10 个并发会话（超过自动剔除最旧的）。
- Cookie 设置为 `HttpOnly; SameSite=Lax`，HTTPS 部署需配合 `trustProxy: true`（详见 [反向代理部署注意事项](#反向代理部署注意事项)）。

**多用户与角色**：

- 角色 `admin`：完整权限（用户管理、审计、机器人、音乐平台、播放控制）。
- 角色 `member`：除"用户管理"和"操作审计"外的所有功能（适合给团队成员开通播放权）。
- 在 **设置 → 用户管理**（仅管理员）中添加 / 删除 / 重置密码 / 切换角色。
- 至少保留一个管理员：系统会阻止删除或降级最后一位管理员。

**游客模式 / Guest mode**：

让访客**无需账号密码**即可进入 WebUI 点歌，同时严格限制其可用能力。该功能**默认关闭**，只有管理员能开启。

- **开启方式**：管理员在 **设置 → 游客模式** 打开「允许游客访问」（仅管理员可见此区块）。开启后登录页会出现 **「以游客身份进入」** 按钮，访客点击即可创建游客会话，无需任何凭据。游客共享同一匿名身份、会话有效期较短（约 1 天）。关闭游客模式（或缩小机器人作用域）后立即生效，所有在线游客会话——包括正在连接的实时 WebSocket——会被立刻断开 / 重新限制。
- **逐项权限（8 个开关，管理员配置）**：除「添加到队列末尾」外**全部默认关闭**，按需逐项放开。

  | 开关 | 字段 | 默认 |
  |------|------|------|
  | 添加到队列末尾 | `addToQueue` | **开** |
  | 添加到下一首 | `playNext` | 关 |
  | 立即播放（不清空队列） | `playNow` | 关 |
  | 跳过当前歌曲 | `skip` | 关 |
  | 暂停/继续/进度/音量 | `transport` | 关 |
  | 移除/清空队列 | `removeClear` | 关 |
  | 切换播放模式 / FM | `playMode` | 关 |
  | 播放整个歌单/专辑 | `playCollection` | 关 |

- **按机器人授权（游客作用域）**：可选择「全部机器人」或指定一份机器人白名单。作用域之外的机器人对游客**不可见、不可控**。
- **游客始终被禁止**：查看或修改任何设置、管理机器人、设置音乐平台账号 / 凭据、修改音质、收藏歌单、修改密码、访问用户管理与操作审计，以及读取机器人主人的私人歌单 / 私人 FM / 每日推荐等平台账号数据。这些限制不受上面 8 个开关影响，**永远锁死**。
- **复现 issue #83 的「下一首 only」需求**：在 **设置 → 游客模式** 中关闭「添加到队列末尾」并打开「添加到下一首」，游客便只能把歌曲加到下一首播放。

**如何重置忘记的管理员密码**：

如果你忘记了管理员密码，可以直接编辑 SQLite 数据库 `data/tsmusicbot.db`：

```bash
# 方案 1：清空所有用户，重新进入 first-run 流程
sqlite3 data/tsmusicbot.db "DELETE FROM users; DELETE FROM sessions;"
# 然后重启机器人，浏览器再次访问会自动进入 /first-run

# 方案 2：把指定用户重置为已知密码（密码 'changeme-now' 的 bcrypt 哈希示例如下）
# 先用 node 生成哈希：
node -e "console.log(require('bcryptjs').hashSync('changeme-now', 12))"
# 把输出贴到 SQL 里：
sqlite3 data/tsmusicbot.db "UPDATE users SET passwordHash='<paste-hash-here>' WHERE username='你的用户名';"
```

**反向代理用户特别注意**：如果通过 nginx / Caddy / Cloudflare 暴露 WebUI，**必须**在 `config.json` 中设置 `"trustProxy": true`，否则 Cookie 不会带 `Secure` 标志，且登录限流会把所有用户合并到同一个桶。详见下方 [反向代理部署注意事项](#反向代理部署注意事项)。

**`config.adminGroups`（现已启用）**：用于限制管理类聊天命令（`stop`/`clear`/`remove`/`move`/`vol`/`mode`）只能由指定 TeamSpeak 服务器组的成员运行；为空时不做任何限制（向后兼容）。详见 [TeamSpeak 命令权限](#teamspeak-命令权限管理类命令限制)。`config.adminPassword` 则是旧版预留字段，当前版本未使用，保留以兼容旧 `config.json`，可以放心忽略。

### Windows 用户

```
1. 双击 scripts\stop.bat 停止运行中的机器人（或手动关闭窗口）
2. 在项目目录打开命令行，执行 git pull
3. 双击 scripts\setup.bat 重新安装依赖并构建
4. 双击 scripts\start.bat 启动
```

### 手动安装用户（所有系统）

```bash
# 停止当前运行的机器人（Ctrl+C 或 kill 进程）

# 拉取最新代码
git pull

# 重新安装依赖（如有新增依赖）
npm install
cd web && npm install && cd ..

# 重新构建
npm run build

# 启动
npm start
```

### Docker 用户

```bash
cd scripts/docker

# 拉取最新代码
git pull

# 重新构建并启动（数据自动保留）
docker-compose up -d --build
```

> 数据（数据库、Cookie、日志）保存在 Docker 命名卷 `tsmusicbot-data` 中，更新不会丢失。

### Linux systemd 用户

```bash
# 停止服务
sudo systemctl stop tsmusicbot

# 拉取最新代码
git pull

# 重新安装依赖并构建
npm install
cd web && npm install && cd ..
npm run build

# 重新启动服务
sudo systemctl start tsmusicbot
```

> **提示：** 更新不会影响你的 `config.json` 配置文件、数据库和登录 Cookie，所有数据会自动保留。但请注意本节开头关于 **身份迁移** 的警告——从 0.1.x 版本升级时需要手动清空旧身份。

## 使用说明

### 首次配置

1. 启动机器人后打开 **http://localhost:3000/**
   - 全新部署：自动跳转 `/first-run`，填写用户名（3-32 字符）和密码（≥8 位）创建首位**管理员**账号
   - 之后所有 WebUI 操作都需要登录，登录态保持 7 天（活动会滚动续期）
2. 在 **设置 → 机器人管理** 中点击"创建新实例"，填写：
   - TeamSpeak 服务器地址（无端口，仅主机名，例如 `ts.example.com`）
   - 端口（默认 9987，自托管或非标准端口请填写实际值）
   - 机器人昵称
   - 可选：服务器密码、默认频道
3. 在 **设置 → 音乐账号** 扫码登录网易云 / QQ 音乐 / 酷狗音乐 / B 站账号（可选，登录后可播放 VIP 歌曲、获取每日推荐 / 我的歌单等）
4. 在 **设置 → 用户管理**（仅管理员可见）按需添加成员。成员默认可控制播放但无法管理其他用户；管理员还可为每个成员单独配置**能力**（播放控制 / 队列 / 机器人管理 / 平台登录 / 音质）和**可操作的机器人白名单**，未授权的机器人对该成员不可见、不可控

### WebUI 页面说明

| 页面 | 功能 |
|------|------|
| **首页** | 推荐歌单、每日推荐、私人FM（网易云 / QQ 雷达 / 酷狗电台）、我的歌单、收藏的歌单（各源带标签切换） |
| **搜索** | 四平台统一搜索，结果标注网易云/QQ/酷狗/B站来源，可一键收藏歌单 |
| **歌单** | 查看歌单详情，播放全部（根据当前播放模式选择首歌），一键收藏 |
| **歌词** | 全屏歌词页，实时同步滚动，模糊专辑封面背景 |
| **历史** | 播放历史记录 |
| **设置** | 账户（修改自己密码） / 主题切换 / 机器人管理 / 行为设置（空闲超时、频道无人自动暂停） / 多平台账号登录（网易云 / QQ / 酷狗 / B站） / 音质选择 / 命令前缀 / 用户管理（仅管理员，含成员能力与机器人白名单）/ 操作审计（仅管理员） |

### TeamSpeak 文字命令

在 TeamSpeak 频道中发送文字消息控制机器人：

| 命令 | 说明 |
|------|------|
| `!play <歌名>` | 搜索并播放（取最热门的匹配项） |
| `!play -q <歌名>` | 从 QQ 音乐搜索 |
| `!play -k <歌名>` | 从酷狗音乐搜索 |
| `!play -b <关键词>` | 从哔哩哔哩搜索视频并播放音频 |
| `!play -y <关键词>` | 从 YouTube 搜索并播放（需要安装 [yt-dlp](#可选youtube-音源)）|
| `!search <歌名> [-q\|-k\|-b\|-y]` | 列出前若干个匹配结果（含序号与 id），用于挑选同名歌曲；可加平台标志切换音源 |
| `!play #<序号>` | 播放上一次 `!search` 结果中的第 N 项（区分同名歌曲） |
| `!play id:<id>` | 按歌曲 id 播放精确的某首歌（也支持直接粘贴网易云 / QQ / B站 歌曲链接） |
| `!add <歌名>` | 添加到播放队列（同样支持 `#序号` / `id:<id>` / 链接） |
| `!pause` / `!resume` | 暂停 / 恢复播放 |
| `!next` / `!prev` | 下一首 / 上一首 |
| `!stop` | 停止播放并清空队列 |
| `!vol <0-100>` | 设置音量 |
| `!queue` | 查看播放队列 |
| `!remove <位置>` | 从队列中删除指定位置的歌曲（位置从 1 开始，见 `!queue`） |
| `!mode <seq\|loop\|random\|rloop>` | 切换播放模式 |
| `!playlist <歌单名或ID>` | 加载歌单（支持名称模糊搜索和 ID） |
| `!playlist -q <歌单名>` | 从 QQ 音乐搜索并加载歌单 |
| `!album <ID>` | 加载专辑 |
| `!artist <歌手名>` | 按歌手循环播放（支持 `-q`/`-k`/`-b`/`-y`） |
| `!fm` | 私人 FM（网易云，自动续播） |
| `!fm -q` | QQ 音乐雷达 / 猜你喜欢 FM（自动续播） |
| `!fm -k` | 酷狗私人电台 / 个性化推荐 FM（自动续播） |
| `!lyrics` | 显示当前完整歌词（自动分多条消息发送，不再只显示开头几行） |
| `!now` | 当前播放信息 |
| `!vote` | 投票跳过当前歌曲 |
| `!move <频道名>` | 移动到指定频道 |
| `!help` | 显示帮助信息 |

> 命令前缀默认为 `!`，可在设置页面修改。支持别名：`!p` = `!play`，`!s` = `!skip`，`!n` = `!next`

### TeamSpeak 命令权限（管理类命令限制）

默认情况下，频道里任何人都能运行所有聊天命令。你可以把一组「管理类」命令限制为只有特定 TeamSpeak 服务器组的成员才能运行：

- 受限命令：`stop`、`clear`、`remove`、`move`、`vol`、`mode`
- 其余命令（点歌、队列、跳过、歌词等）始终对所有人开放
- **默认不限制**：管理服务器组列表为空时，所有命令对所有人开放（向后兼容）

**配置方式**

- 网页端：设置 → 命令权限，填写允许的服务器组 ID（逗号分隔），保存即时生效。
- 或编辑 `config.json` 的 `adminGroups`（数字数组），例如 `"adminGroups": [6, 8]`。

填入任意服务器组 ID 后，限制立即开启：只有属于这些组之一的用户才能运行受限命令，其他人会收到「⛔ 需要管理员权限（该命令仅限管理员服务器组）」的提示。

> 提示（fail-closed）：当受限命令来自一个机器人当前看不到其服务器组的发送者（例如不在机器人所在频道的私聊），机器人会尝试查询其分组；若仍无法确定，则拒绝执行。

**如何查看服务器组 ID**

在 TeamSpeak 客户端中打开「权限 → 服务器组」（Permissions → Server Groups）对话框，选中某个组后，其 ID 会显示在标题栏/状态栏；或在服务器组管理界面中查看每个组对应的数字 ID。把需要授权的组 ID 填入上面的设置即可。

### 音质等级

| 等级 | 码率 | 格式 | 说明 |
|------|------|------|------|
| 标准 | 128kbps | MP3 | 免费可用 |
| 较高 | 192kbps | MP3 | 免费可用 |
| **极高** | **320kbps** | **MP3** | **默认选择** |
| 无损 | ~900kbps | FLAC | 需要 VIP |
| Hi-Res | ~1500kbps | FLAC | 需要 VIP |
| 超清母带 | ~4000kbps | FLAC | 需要黑胶 VIP |

在设置页面选择音质，立即生效（影响后续播放的歌曲）。

## 项目架构

```
teamspeak-music-bot/
├── src/                        # 后端源码 (TypeScript)
│   ├── audio/                  # 音频管线：FFmpeg → PCM → Opus → 20ms 帧
│   │   ├── encoder.ts          # Opus 编码器 (@discordjs/opus)
│   │   ├── player.ts           # FFmpeg 播放器（内置 ffmpeg-static，帧计数进度追踪）
│   │   └── queue.ts            # 播放队列（4种模式，懒加载URL）
│   ├── bot/                    # 机器人核心
│   │   ├── commands.ts         # 文字命令解析器（前缀、别名、权限）
│   │   ├── instance.ts         # Bot 实例（绑定 TS3 + 播放器 + 音源）
│   │   ├── manager.ts          # 多实例生命周期管理
│   │   ├── auto-pause.ts       # 频道无人自动暂停/恢复的决策逻辑
│   │   └── profile.ts          # 机器人形象管理（头像/昵称/描述/Away/频道描述）
│   ├── data/                   # 数据层
│   │   ├── config.ts           # JSON 配置文件（持久化到 data/config.json）
│   │   ├── permissions.ts      # 细粒度能力 + 按机器人授权白名单
│   │   └── database.ts         # SQLite 数据库（播放历史、实例、收藏、权限持久化）
│   ├── music/                  # 音源服务
│   │   ├── provider.ts         # 统一 MusicProvider 接口
│   │   ├── netease.ts          # 网易云音乐适配器
│   │   ├── qq.ts               # QQ 音乐适配器
│   │   ├── bilibili.ts         # 哔哩哔哩适配器（视频音频提取）
│   │   ├── kugou.ts            # 酷狗音乐适配器（直连 API，无 npm 依赖 / 无内嵌服务）
│   │   ├── youtube.ts          # YouTube 适配器（可选，依赖 yt-dlp）
│   │   ├── auth.ts             # Cookie 持久化存储
│   │   └── api-server.ts       # 嵌入式 API 服务（自动启动）
│   ├── ts-protocol/            # TeamSpeak 客户端协议（TS3/TS6 双协议）
│   │   ├── client.ts           # 完整客户端（ECDH + AES-EAX 加密协议）
│   │   ├── protocol-detect.ts  # 服务器协议自动检测（TS3 vs TS6）
│   │   ├── http-query.ts       # TS6 HTTP Query 客户端（替代 TS3 ServerQuery）
│   │   └── ts6-compat.ts       # TS6 兼容中间件（版本升级 + 签名）
│   ├── web/                    # Web 后端
│   │   ├── server.ts           # Express + WebSocket 服务
│   │   ├── websocket.ts        # 实时状态广播
│   │   ├── middleware/         # requireAuth / requireAdmin / requirePermission / CSRF
│   │   └── api/                # REST API 路由
│   │       ├── bot.ts          # 机器人管理 CRUD
│   │       ├── music.ts        # 搜索/歌单/歌词/音质
│   │       ├── player.ts       # 播放控制/队列/历史/跳转/FM
│   │       ├── favorites.ts    # 本地收藏歌单 CRUD
│   │       ├── users.ts        # 用户管理 + 成员权限
│   │       └── auth.ts         # QR登录/Cookie/SMS
│   └── index.ts                # 入口（启动所有服务）
├── web/src/                    # 前端源码 (Vue 3)
│   ├── components/             # Player, Navbar, Queue, CoverArt, SongCard
│   ├── views/                  # Home, Search, Playlist, Lyrics, History, Settings, Setup
│   ├── stores/                 # Pinia 状态管理（含服务端时间同步）
│   ├── composables/            # WebSocket 自动重连
│   └── styles/                 # SCSS 主题变量（深色/浅色）
├── scripts/                    # 部署脚本
│   ├── setup.bat               # Windows 首次安装
│   ├── start.bat               # Windows 启动脚本
│   ├── install.sh              # Linux 一键安装 + systemd 服务
│   └── docker/                 # Docker 部署文件
│       ├── Dockerfile
│       └── docker-compose.yml
└── data/                       # 运行时数据（自动创建，不上传）
    ├── config.json             # 配置文件（首次运行自动生成，可手动编辑）
    ├── tsmusicbot.db           # SQLite 数据库
    ├── cookies/                # 登录 Cookie
    └── logs/                   # 日志文件
```

## 技术栈

| 层级 | 技术 |
|------|------|
| **运行时** | Node.js 20+, TypeScript 5 |
| **后端框架** | Express 4, WebSocket (ws) |
| **数据库** | better-sqlite3 (SQLite) |
| **音频处理** | FFmpeg (ffmpeg-static 内置), @discordjs/opus |
| **TS 协议** | @honeybbq/teamspeak-client（完整客户端协议）+ 自研 TS6 协议适配层 |
| **网易云 API** | NeteaseCloudMusicApi |
| **QQ 音乐 API** | @sansenjian/qq-music-api（锁定 `~2.4.0`，需 Node ≥ 20.17） |
| **哔哩哔哩** | BiliBili Web API（搜索、DASH 音频流、QR 登录） |
| **酷狗音乐** | 酷狗公开 API（直连，无 npm 依赖 / 无内嵌服务；请求签名 / KRC 歌词解码 / 设备注册移植自 MIT 的 MakcRe/KuGouMusicApi，改用 Node 内置 crypto + zlib） |
| **前端框架** | Vue 3, Vite 5, Pinia, Vue Router 4 |
| **界面样式** | SCSS（YesPlayMusic 设计风格） |
| **图标** | @iconify/vue |
| **日志** | pino |

## 可选：YouTube 音源

YouTube 是**可选**的音源，默认**未启用**，需要安装 [yt-dlp](https://github.com/yt-dlp/yt-dlp) 才能使用。启用后可通过聊天命令 `!play -y <关键词>` 或 WebUI 的 YouTube 平台选项搜索/播放 YouTube 视频的音频流。

### 启用方式（任选其一）

**方式一：项目本地 `bin/` 目录（推荐）**

将 `yt-dlp` 可执行文件放到项目根目录下的 `bin/` 文件夹，程序会优先使用此路径。该目录已被 `.gitignore` 忽略，不会影响代码更新。

```bash
# Windows（PowerShell 或 Git Bash）
mkdir bin
curl -L -o bin/yt-dlp.exe https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe

# Linux / macOS
mkdir -p bin
curl -L -o bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp
chmod +x bin/yt-dlp
```

**方式二：系统级安装（让 `yt-dlp` 在 `PATH` 中可用）**

```bash
# Windows
winget install yt-dlp

# macOS
brew install yt-dlp

# Debian/Ubuntu
sudo apt install yt-dlp

# 通用（Python 环境下）
pip install -U yt-dlp
```

### 验证是否可用

重启机器人程序，在 WebUI 或 `!play -y lofi` 测试搜索。若 `bin/` 和 `PATH` 中都找不到 `yt-dlp`，YouTube 搜索会静默返回空结果（不会影响其他音源），其余功能正常。

### 注意事项

- YouTube 音源通过 `yt-dlp` 本地调用实现，不依赖 API Key，也无需登录
- 播放的是视频的最佳音频流（`bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio`），由 FFmpeg 解码
- 音质由源视频决定，不受音质设置影响
- 受 YouTube 风控/地域限制，部分视频可能无法播放
- `yt-dlp` 更新较频繁，如果播放失败，先尝试升级 `yt-dlp` 到最新版本

## Spotify 音源（实验性）

> **⚠️ 实验性功能，启用前请务必读完本节**
>
> - **需要 Spotify Premium 账号。** 免费账号无法通过 Spotify Connect 输出音频，无法使用本功能。
> - **使用你自己在 Spotify Developer Dashboard 注册的应用（Client ID）。** 本项目**不内置任何共享凭据**，也不会替你代管账号。
> - Spotify 官方并未开放第三方播放的公开授权，本功能处于 **Spotify 服务条款的灰色地带**，是否使用请自行评估，**风险自负**。
> - 该音源**默认关闭**（`spotify.enabled = false`），需要手动开启并完成授权。
> - 这**不是** YouTube 那样的「免登录回退音源」，而是**真正的 Spotify 音频**，必须有 Premium 才能出声；音频链路依赖第三方开源解码器（librespot / go-librespot），本项目仅在本地作为独立子进程调用，**播放效果不做保证**，也未在本仓库端到端测试。

### 工作原理（简述）

1. `librespot`（Rust）或 `go-librespot`（Linux）作为**独立子进程**登录 Spotify Connect 并解码音频，输出原始 **PCM**。
2. 本项目用内置 **ffmpeg** 把 PCM 重采样到 **48kHz**。
3. 重采样后的音频接入**现有的 Opus 编码 / 发送管线**（与其它音源共用），推送到 TeamSpeak。
4. 歌名、歌手、封面等**元数据来自 Spotify Web API**。

### 平台矩阵

后端由配置项 `spotify.backend` 决定，可选 `auto`（默认）/ `go-librespot` / `librespot`：

| 平台 | 默认后端（`auto`） | 说明 |
|------|------|------|
| Windows | `librespot`（Rust） | 不支持 go-librespot（FIFO 仅限 POSIX，且官方无 Windows 资产） |
| Linux / Docker | `go-librespot`（可回退 `librespot`） | `auto` 优先 go-librespot，未检测到时自动改用 librespot |
| macOS | `librespot`（Rust） | 与 Windows 同，仅支持 Rust 版 |

> `auto` 会按平台与二进制可用性自动选择：优先 `go-librespot`（若可用），否则 `librespot`。若显式指定 `go-librespot` 或 `librespot` 但对应二进制不存在，则该音源保持不可用。

### 获取二进制

程序会先在项目根目录的 `bin/` 中查找，找不到再回退到系统 `PATH`。`bin/` 已被 `.gitignore` 忽略，不影响代码更新。

**Rust librespot（librespot-org，全平台）** — 官方**没有预编译发布包**，需自行获取（任选其一）：

```bash
# 方式 1：用 Cargo 编译安装（需要 Rust 工具链）
cargo install librespot

# 方式 2（Windows）：scoop / choco
scoop install librespot        # 或：choco install librespot

# 方式 3：把可执行文件放到项目 bin/ 目录
#   Windows:      bin/librespot.exe
#   Linux/macOS:  bin/librespot
```

或直接把 `librespot` 加入系统 `PATH`。

**go-librespot（仅 Linux）** — 官方仅提供 **Linux** 预编译资产：

```bash
# 从 Release 页下载对应架构的二进制：
#   https://github.com/devgianlu/go-librespot/releases
# 放到项目 bin/ 目录（或加入系统 PATH）：
#   bin/go-librespot
```

> **Windows 不支持 go-librespot**：它依赖 POSIX FIFO（`mkfifo`），官方也只发布 Linux 资产。Windows / macOS 请使用 Rust `librespot`。

### 注册 Spotify 开发者应用 + 回调地址

1. 打开 [Spotify Developer Dashboard](https://developer.spotify.com/dashboard)，新建一个应用，记下 **Client ID**。
2. 在应用设置里添加 **Redirect URI（回调地址）**，精确填写：

   ```
   http://127.0.0.1:<webPort>/api/spotify/callback
   ```

   其中 `<webPort>` 与本项目设置里的 Web 端口一致（默认 `3000`，即 `http://127.0.0.1:3000/api/spotify/callback`）。回调路径必须精确为 `/api/spotify/callback`。
3. 本项目使用 **Authorization Code + PKCE** 流程，**不需要 Client Secret**（配置里的 `clientSecret` 可留空）。
4. 授权时请求的权限范围（scope）：

   ```
   streaming user-read-playback-state user-modify-playback-state user-read-currently-playing playlist-read-private
   ```

### 启用步骤

1. 进入**设置页**的「连接 Spotify」卡片。
2. 填入 **Client ID**、选择**后端**（`auto` / `go-librespot` / `librespot`）、打开**开关**。
3. 点击**保存**。
4. 点击「**连接 Spotify**」，在弹出的 Spotify 页面完成 **OAuth 授权**。

> 仅当 **`enabled = true`** + **已完成 OAuth 授权** + **检测到可用的后端二进制** 三者同时满足时，Spotify 音源才可播放。任一条件不满足，该音源保持**不可用**（点播会被跳过，播放队列照常前进，不影响其它音源）。

对应的配置块（`data/config.json`）：

```json
{
  "spotify": {
    "enabled": false,
    "backend": "auto",
    "clientId": "",
    "clientSecret": "",
    "deviceName": "TSMusicBot",
    "bitrate": 320
  }
}
```

OAuth 相关端点：`/api/spotify/login`、`/api/spotify/callback`、`/api/spotify/status`。

### 许可与来源

- **go-librespot** 采用 **GPL-3.0** 许可。本项目**仅将其作为独立子进程调用**（mere aggregation / 独立聚合），**不链接、不打包**其代码，因此**不影响本项目自身的 MIT 许可**。
  - 源码与许可：<https://github.com/devgianlu/go-librespot>（GPL-3.0；如需其对应源码请前往该仓库获取 —— source offer）。
- **Rust librespot** 采用 **MIT** 许可：<https://github.com/librespot-org/librespot>。

### 故障排查

| 现象 | 处理 |
|------|------|
| 提示「未检测到 librespot / go-librespot」 | 检查项目 `bin/` 目录里是否放了可执行文件，或该命令是否在系统 `PATH` 中；Rust 版可用 `cargo install librespot` 安装 |
| 提示「未授权 / 需要连接 Spotify」 | 在设置页「连接 Spotify」卡片点击「连接 Spotify」完成 OAuth 授权 |
| Windows 上无法使用 go-librespot | 属预期行为（FIFO 仅限 POSIX，官方无 Windows 资产）；请把 `backend` 设为 `librespot` 或 `auto` |
| 完全没有声音 | 确认账号为 **Spotify Premium**；免费账号无法通过 Spotify Connect 输出音频 |

### 已知限制

- 在多租户/共享主机上，librespot 通过命令行参数接收访问令牌，同机其他本地进程理论上可读取（令牌约 1 小时有效，需本地访问权限）。
- Spotify 连续播放（gapless spotify→spotify）时，网页进度条的"已播放时间"可能不准确（以后端上报的播放进度为准）。
- 运行多个启用 Spotify 的 bot 时，若两个 bot 的 id 端口哈希发生冲突（同一 % 1000 桶），第二个 go-librespot 边车会因端口占用而启动失败、该 bot 的 Spotify 不可用（后续将改为按需分配空闲端口）。
- **一个 Spotify Premium 账号只支持「一路」正在播放的音频流**。因此若要同时运行**多个**启用 Spotify 的 bot 并让它们各自独立播放，必须为**每个 bot 配置独立的 Spotify 账号**。在 Rust（librespot）后端上，本机制已把播放控制（暂停/继续/跳转）限定到 bot 自己的设备，并在读取播放状态时忽略其它设备的状态，以避免多 bot 之间互相抢占、来回抖动（cross-control/thrash）；但受 Spotify 平台限制，**共用同一账号无法实现多路同时播放**（第二个 bot 开始播放会夺走该账号唯一的活跃会话）。go-librespot 后端为每个边车独立的本地 REST API，不受此账号级抢占影响。

## 配置文件

配置文件位于 **`data/config.json`**（与数据库、Cookie、日志同在持久化的 `data/` 目录，Docker 部署对应挂载卷），首次运行时自动生成，可手动编辑：

```json
{
  "webPort": 3000,
  "locale": "zh",
  "theme": "dark",
  "commandPrefix": "!",
  "commandAliases": { "p": "play", "s": "skip", "n": "next" },
  "neteaseApiPort": 3001,
  "qqMusicApiPort": 3200,
  "adminPassword": "",
  "adminGroups": [],
  "autoReturnDelay": 300,
  "autoPauseOnEmpty": false,
  "idleTimeoutMinutes": 0,
  "publicUrl": "",
  "trustProxy": false
}
```

> **配置文件位置变更**：旧版本把 `config.json` 写在项目根目录（不在 Docker 挂载卷内，导致重启丢失、手动编辑不生效）。现在统一放在 `data/config.json`。升级时若检测到根目录存在旧的 `config.json`，会在首次启动时自动迁移到 `data/` 并保留你的设置，无需手动操作。

> **关于 `adminPassword` 和 `adminGroups`**：`adminGroups` 现已启用，用于限制管理类聊天命令只能由指定 TeamSpeak 服务器组运行（为空 = 不限制），详见 [TeamSpeak 命令权限](#teamspeak-命令权限管理类命令限制)。`adminPassword` 仍为旧版预留字段、当前版本未使用——WebUI 鉴权改为基于数据库的用户账号系统（见 [首次配置](#首次配置)），无需在 `config.json` 中设置密码。

### 反向代理部署注意事项

当 WebUI 部署在反向代理（nginx / Caddy / Cloudflare 等）之后时，请务必在 `config.json` 中设置 `"trustProxy": true`：

- **Cookie Secure 标志**：未启用 `trustProxy` 时，Express 无法从 `X-Forwarded-Proto` 正确判断请求实际是否为 HTTPS，会话 cookie 不会被标记为 `Secure`。
- **登录限流**：登录限流以 `req.ip` 为键，未启用 `trustProxy` 时所有请求都会被识别为代理本身的 IP，单个攻击者会拖累所有合法用户共用同一个限流桶。
- **审计日志的客户端 IP**（如果未来添加该字段）也需要 `trustProxy` 才能正确记录。

直接暴露端口（无代理）时无需启用该选项。

## 常见问题

**Q：支持 TeamSpeak 6 Server 吗？**
A：支持。本项目内置 TS3/TS6 双协议支持，连接时会自动检测服务器类型。如果自动检测失败（例如 Query 端口被防火墙屏蔽），可以在创建机器人时手动指定 `serverProtocol: "ts6"`。TS6 Server 的 HTTP Query API（端口 10080）也已适配，需要时可配置 `ts6ApiKey`。

**Q：机器人连接了但 TeamSpeak 中听不到音乐？**
A：确保机器人和你在同一个频道。检查音量（`!vol 75`）。部分 VIP 歌曲需要先登录账号。

**Q：提示"无法获取播放链接"？**
A：在设置页面扫码登录音乐账号。许多歌曲需要登录后才能播放。

**Q：同名歌曲 `!play` 只能播到最热门的那首，怎么播放指定的版本？**
A：`!play <歌名>` 默认取最热门的匹配项。要播放同名的另一首，有三种方式：(1) 先 `!search <歌名>` 列出带序号的结果，再 `!play #序号` 选择；(2) `!play id:<歌曲id>` 按 id 精确播放；(3) 直接粘贴歌曲链接，如 `!play https://music.163.com/song?id=442867526`（也支持 QQ / B站 链接）。在 WebUI 中则可直接在搜索结果列表里点选任意同名歌曲。

**Q：如何更换机器人所在频道？**
A：使用 `!move <频道名>` 命令，或在设置页面创建机器人时指定默认频道。

**Q：可以同时运行多个机器人吗？**
A：可以。在设置页面创建多个实例，分别连接不同的 TS 服务器或频道。

**Q：端口 3200 被占用？**
A：QQ 音乐 API 启动时自动监听 3200 端口。如果之前的进程还在运行，程序会自动复用。如需重启可手动结束 `node` 进程。

**Q：QQ 音乐二维码不弹 / 扫码登录失败 / cookie 无法使用？**
A：通常是内置的 QQ 音乐 API 服务没起来——它一旦没监听 3200 端口，机器人去取二维码就会拿到 `ECONNREFUSED 127.0.0.1:3200`，于是二维码不显示，登录和 cookie 也全失效。先看日志里 QQ API 的启动报错：
- 报 `ERR_REQUIRE_ESM`：装到了不兼容的 `@sansenjian/qq-music-api` 版本。本项目把它锁在 **`~2.4.0`**（需要 **Node ≥ 20.17 / 22.9**）；务必用 `npm ci` 或 `npm install` 让版本与锁文件一致，**不要**手动 `npm update` 把它升级或降级到不兼容的中间版本（2.3.0/2.3.1 是纯 ESM、会触发此错）。
- 报 Node 版本不满足：升级 Node 到 ≥ 20.17，或将该依赖降到 `~2.2.10`（无此 Node 要求）后重装。
修好版本后重新 `npm install && npm run build` 并重启即可。

**Q：播放歌曲时报 FFmpeg EACCES 错误？**
A：`ffmpeg-static` 内置的 FFmpeg 二进制文件缺少执行权限。程序已自动尝试修复，如果仍然失败，请手动执行：
```bash
chmod +x node_modules/ffmpeg-static/ffmpeg
```
或者确保系统已安装 FFmpeg（`apt install ffmpeg` / `brew install ffmpeg`），程序会自动回退使用系统版本。

**Q：Docker 构建失败？**
A：原生模块（opus、sqlite3）需要编译工具，Dockerfile 已包含。确保 Docker 有足够内存（建议 2GB+）。

**Q：B站视频搜索不到结果？**
A：B站搜索需要 buvid3 匿名 Cookie（程序启动时自动获取）。如果失败，重启程序即可。登录B站账号后搜索效果更好。

**Q：YouTube 平台搜索返回空结果？**
A：YouTube 是可选音源，需要手动安装 `yt-dlp`。详见 [可选：YouTube 音源](#可选youtube-音源) 章节。快速验证：在项目根目录执行 `bin/yt-dlp --version`（或系统 `yt-dlp --version`），能打印版本号即可。若 yt-dlp 已安装但仍搜索失败，通常是网络/地域问题或 yt-dlp 版本过旧（执行 `yt-dlp -U` 升级）。

**Q：如何更新到新版本？**
A：`git pull` 拉取最新代码，然后 `npm install && npm run build && npm start` 重新构建启动。Docker 用户执行 `docker-compose up -d --build`。

**Q：忘记管理员密码怎么办？**
A：直接操作 SQLite 数据库。最简单的办法是清空 `users` 表然后重新进入 first-run 流程：`sqlite3 data/tsmusicbot.db "DELETE FROM users; DELETE FROM sessions;"`，重启后浏览器会自动跳转 `/first-run` 让你重新创建管理员。详细方法见 [从 WebUI 无鉴权版本升级](#从-webui-无鉴权版本升级重要)。

**Q：成员（member）能做什么？不能做什么？**
A：成员默认可以：管理机器人（启动/停止/创建/编辑）、控制播放（搜索/播放/队列）、登录音乐平台账号、修改自己的密码。成员**始终不能**：管理其他用户、查看操作审计日志、降级或删除管理员。此外管理员可在 **设置 → 用户管理** 为每个成员单独**收紧权限**：勾选允许的能力（播放控制 / 队列 / 机器人管理 / 平台登录 / 音质）以及可操作的机器人白名单——未授权的能力会返回 403，未授权的机器人对该成员不可见也不可控。管理员不受任何限制。

**Q：收藏的歌单存在哪里？其他用户能看到吗？**
A：收藏按用户存储在本地 SQLite 数据库（`favorite_playlists` 表），仅本人可见，登录后跨设备同步。在首页、搜索结果或歌单页点击收藏图标即可增删。

**Q：什么是"专属链接"？怎么用？**
A：通过 `/bot/<机器人ID>` 打开 WebUI 会把界面锁定到该机器人（顶部显示"专属模式"，刷新后保持），适合把单台机器人的控制页分享给特定用户。点击"退出"可返回多机器人视图。注意：专属链接只是 UI 层的锁定，真正的访问控制由成员权限（机器人白名单）在后端强制。

**Q：机器人播放时突然自动暂停了？**
A：这是"频道无人时自动暂停"功能：当机器人所在频道没有其他人时会自动暂停，有人加入后自动恢复，避免空播。该功能**默认关闭**，仅在你于 **设置 → 行为设置** 开启后生效；如需停用，在同一页面关闭即可。（占用检测依赖 TeamSpeak 的 `clientlist` 命令，部分服务器在频道有其他人时可能查询失败——此时机器人会按"占用情况未知"处理，不会误暂停。）

**Q：如何把某个用户从成员升级为管理员？**
A：管理员登录后进入 **设置 → 用户管理**，点击对应用户的"提升管理员"按钮即可。降级同理（"降为成员"按钮）。系统会阻止降级最后一位管理员。

**Q：登录之后多久会自动退出？**
A：登录态有效期 7 天，活跃使用会滚动续期（每次受保护请求都会刷新过期时间）。同一账号最多保持 10 个并发会话（多设备登录时超过的会自动剔除最旧的会话）。

**Q：部署到公网后如何防止暴力登录？**
A：本项目内置 `/login` 限流（每 IP 每分钟 5 次），但生产部署建议同时在反向代理（nginx `limit_req` / Caddy 等）层加一层限流，并启用 HTTPS。反向代理部署务必设置 `"trustProxy": true`（详见 [反向代理部署注意事项](#反向代理部署注意事项)）。

## 参与贡献

1. Fork 本仓库
2. 创建功能分支 (`git checkout -b feature/新功能`)
3. 提交更改 (`git commit -m 'feat: 添加新功能'`)
4. 推送分支 (`git push origin feature/新功能`)
5. 提交 Pull Request

## 更新日志

> 完整历史请查看 [git log](https://github.com/ZHANGTIANYAO1/teamspeak-music-bot/commits/main) 或 [Releases](https://github.com/ZHANGTIANYAO1/teamspeak-music-bot/releases)。这里只列出重要变更和面向用户的破坏性改动。

### 最新版本

**功能增强：Spotify 音源（实验性）/ 搜索结果翻页 / 细粒度权限 / 本地收藏 / 本地音频上传 / 专属链接 / 自动暂停 / QQ 雷达 FM**

- **细粒度账号权限**（叠加在 admin / member 之上）：管理员可为每个成员勾选 5 项能力（`player.control` / `player.queue` / `bot.manage` / `platform.auth` / `quality`）和按机器人授权白名单；所有变更路由由后端 `requirePermission` / `requireBotAccess` 中间件逐请求强制校验，未授权返回 403，未授权的机器人对成员不可见（列表过滤，无 403-vs-404 枚举泄漏）。已有成员经一次性迁移获得全部能力，新成员默认基础能力。
- **本地收藏歌单**：按用户存储的收藏（`favorite_playlists` 表 + `/api/favorites`），首页 / 搜索 / 歌单页一键收藏，跨设备同步。
- **本地音频上传播放**：搜索页支持拖拽 / 选择本地音频上传（保存到 `data/local-audio`），上传后可像普通歌曲一样播放、下一首播放或加入队列；设置 → 行为设置 中新增「本地音频播放」开关，关闭后拒绝新的本地上传和本地歌曲播放请求。播放结束或停止 / 清空 / 替换队列时会从服务端删除已接收文件并更新索引。
- **专属链接（单机器人锁定）**：`/bot/<id>` 打开时锁定到单台机器人，`?bot=<id>` 随刷新保持；与权限白名单组合，机器人下拉只显示"作用域 ∩ 可控"的机器人。
- **频道无人时自动暂停**：机器人所在频道清空时暂停、有人加入时恢复（区分用户手动暂停，不会误恢复）；可在 设置 → 行为设置 开关（默认关闭）。占用检测在 `clientlist` 查询失败时按"未知"处理而非"无人"，避免有人在听时被误暂停。
- **QQ 音乐雷达 / 私人 FM**：`!fm -q` 或 WebUI 启动 QQ 雷达推荐流（失败回退"猜你喜欢"），FM 自动续播现支持任意平台。
- **#112 Spotify 音源（实验性）**：新增 Spotify 作为可选音源，默认关闭、需 Premium + 自建开发者应用（PKCE，无需 Client Secret）。采用混合 librespot 后端（Linux/Docker 用 go-librespot，Windows 用 Rust librespot），元数据走 Spotify Web API，可与现有音源混排入队。为 ToS 灰色地带的实验特性，详见 [Spotify 音源（实验性）](#spotify-音源实验性)。
- **#115 搜索结果翻页**：WebUI 搜索现按来源、按分类（歌曲 / 歌单 / 专辑）提供「加载更多」，服务端新增 `offset` 分页，不再固定只返回首页 20 首 / 10 个歌单 / 10 张专辑。

**Bug 修复**

- **#116 `!lyrics` 只显示开头几行**：聊天命令曾把歌词截断为前 10 行，且长消息未分片会触及 TeamSpeak 单条约 1 KB 上限。现发送完整歌词，并按 UTF-8 字节安全地分割成多条消息（长回复通用分片，不再截断）。
- **#86 config.json 未在首次运行生成**：配置文件改放到持久化的 `data/config.json`（旧版写在项目根目录，不在 Docker 卷内，导致重启丢失、手动编辑不生效）；升级时自动把根目录旧配置迁移到 `data/` 并保留你的设置。
- **#89 B站长音频约 16 分钟被暂停且无法继续**：ffmpeg 增加 `-reconnect_at_eof`（B站 CDN 会在 token/会话到期时提前关闭连接造成 EOF），并新增"远离结尾的卡死看门狗"——彻底卡死的流会自动推进到下一首而不是永久静音。
- **#84 音量曲线不顺滑**：0–100 改为连续单调曲线 `0.2x + 0.8x^8`（消除 80–99 的"死区"与 100 处的突跳，满响度仍保留在 100）。

**WebUI 鉴权与权限系统**

- **首次运行强制创建管理员账号**：浏览器打开 WebUI 自动跳转 `/first-run`；之后所有 `/api/*`（除少量公共白名单：`/api/health`、`/api/config/public-url`、`/api/session/*`）和 `/ws` 都需要登录。详见 [更新升级 → 从 WebUI 无鉴权版本升级](#从-webui-无鉴权版本升级重要)。
- **两种角色：admin / member**。`member` 可以管理机器人、控制播放、登录音乐平台账号、修改自己密码，但不能管理其他用户或查看审计日志。`admin` 拥有全部权限。
- **用户管理 UI**：管理员在 设置 → 用户管理 可以增删用户、切换角色、重置密码。系统强制保留至少一位管理员。
- **操作审计日志**：管理员在 设置 → 操作审计 可以查看用户管理相关事件（创建、删除、密码重置、角色变更、首位管理员创建、自助修改密码）。
- **自助修改密码**：所有用户都可在 设置 → 账户 修改自己密码。
- **会话存储**：服务端 SQLite 表 `sessions`，存储 sha256(token)；浏览器只持有原始 token cookie。7 天 TTL，每小时滚动续期。同账号最多 10 个并发会话（超出剔除最旧）。
- **登录限流**：每 IP 每分钟 5 次 `/login` + 3 次 `/setup`，命中返回 429 + `Retry-After`。
- **CSRF & 安全头**：所有 mutating 请求强制 `Origin`/`Referer` 同源；响应携带 `X-Frame-Options: DENY` 和 `Content-Security-Policy: frame-ancestors 'none'`（防点击劫持）。
- **配置变更**：反向代理部署务必 `"trustProxy": true`（详见 [反向代理部署注意事项](#反向代理部署注意事项)）。`config.adminGroups` 现已启用，用于限制管理类聊天命令只能由指定 TeamSpeak 服务器组运行（为空 = 不限制，详见 [TeamSpeak 命令权限](#teamspeak-命令权限管理类命令限制)）；`config.adminPassword` 仍为旧版预留字段，保留以兼容旧 `config.json`，当前未使用。

### v0.x — Bot Profile 自动更新与协议层升级

**机器人形象自动更新（Bot Profile）**

- **播放时自动更新 TS 形象**：头像（专辑封面缩略图）、昵称（`♪ 歌名 - 歌手 - 原昵称`）、描述（歌曲信息）、Away 状态、频道描述、"正在播放"频道消息，全部随歌曲切换自动更新。
- **停止播放时恢复默认**：头像清除、昵称恢复、Away 显示"等待播放"、描述和频道描述清空。
- **权限安全**：每项功能独立检测权限，权限不足时自动禁用该功能（不影响其他功能和播放），重连后重试。
- **独立可配置**：6 项功能可通过 REST API（`GET/PUT /api/player/:botId/profile`）独立开关，配置持久化到数据库。
- **竞争条件防护**：generation 计数器防止快速切歌时旧头像覆盖新头像；UTF-8 字节长度截断中文昵称；文件传输操作带超时保护。
- **TS3 适配**：描述通过 `clientedit`（非 `clientupdate`）设置，需要 `b_client_modify_description` 权限；昵称和 Away 通过合并的单条 `clientupdate` 避免命令队列超时。

**新命令 & FM 修复**

- **新增 `!artist <歌手名>` 命令**：搜索指定歌手的歌曲并循环播放，支持 `-q`（QQ 音乐）/ `-b`（B站）/ `-y`（YouTube）平台切换。一次加载最多 50 首，自动按歌手名过滤并设为 Loop 模式。
- **歌单模糊搜索**：`!playlist` 现在支持歌单名称模糊搜索（如 `!playlist 华语经典`），自动匹配公开歌单 + 个人歌单（网易云 + QQ）。纯数字 ID 和 URL 解析保持兼容。
- **修复 `!fm` 播放中断**：私人 FM 几首歌后静音的 bug 已修复。新增自动续播机制（队列低位自动拉取新歌），播放器健康帧追踪防止临时 URL 失败导致永久静音。
- **QQ 音乐个人歌单**：QQ Music provider 新增 `getUserPlaylists` 支持，登录后可通过 `!playlist -q <名称>` 模糊搜索个人歌单。

**协议层 & 稳定性**

- **升级 `@honeybbq/teamspeak-client` 到 `0.2.1`**，移除内置 TS6 兼容层（`ts6-compat.ts`），改用库自带的通用 `clientinit` 协议（`3.?.? [Build: 5680278000]`），TS3/TS6 单一代码路径。
  - ⚠️ **破坏性**：`0.1.0` 生成的旧身份与新握手路径不兼容，升级时需要迁移。详见 [更新升级](#更新升级) 章节顶部的警告。
- **修复 `startBot` 与 `stopBot` 之间的竞态**：mid-handshake 被替换的 BotInstance 不再泄漏 TS 会话，`disconnect()` 被 `connect()` 的 await 插队时不再错误地把 `connected` 翻回 `true`。
- **修复播放条自动刷新 bug**：BotManager 现在在创建新 BotInstance 时 emit `botInstance` 事件，WebSocket 监听器会立即重新挂接到新实例，播放状态变化无需手动刷新页面。
- **`connect()` 增加 15 秒超时**：握手卡住时会清理掉挂起的实例并返回 500，不再无限阻塞 HTTP 请求和 UI。
- **识别持久化修复**：`startBot` 现在会从数据库读取 `identity` 传给新 BotInstance，服务器组在机器人重启后能保留。

**HTTP API 加固**

- 新增输入校验，拒绝无效值并返回 **400**（之前会返回 200 包装 usage-text 字符串）：
  - `/volume`：非数字、`NaN`/`Infinity`、超出 `[0,100]`
  - `/mode`：不在 `{seq, loop, random, rloop}` 中的值
  - `/seek`：`NaN`/`Infinity`、负数、字符串
  - `/play-at`：索引越界（**先**校验再停止当前播放，避免误杀正在播的歌）
- **修复 YouTube 平台路由**：`/play`、`/add`、`/playlist`、`/play-by-id`、`/add-by-id`、`/play-playlist` 现在都正确处理 `platform=youtube`（之前会静默回退到网易云）。
- **修复 `/auth/status?platform=youtube` 数据泄漏**：之前会回退到网易云并返回网易云用户的昵称 + 头像 URL，现在正确路由到 YouTube provider 并报告 `yt-dlp` 的实际可用状态。
- **`/auth/cookie` 拒绝 `platform=youtube`**，防止意外覆盖网易云 cookie。

**连接状态一致性**

- 断开连接时，音频命令（`play`/`add`/`next`/`prev`/`playlist`/`album`/`fm`）返回 **400 "Bot is not connected to TeamSpeak"**；配置类命令（`volume`/`mode`/`clear`/`stop`/`queue`/`now`/`lyrics`）仍可正常工作，保持 UI 可用。
- `resolveAndPlay` 在网络请求（URL 解析）前后都会检查 `this.connected`，防止在解析期间被 `stop()` 中断后仍然启动 ffmpeg。
- `tsClient` 的 `disconnected` 事件处理器现在总是清理播放器状态，不再因为 `connect()` 从未完成而遗留 `playing=true` 的僵尸状态。

**功能改进**

- **YouTube 音源（可选）**：新增基于 `yt-dlp` 的 YouTube provider，通过 `!play -y <关键词>` 或 WebUI 平台选项使用。未安装 `yt-dlp` 时静默降级、返回空结果，不影响其他音源。详见 [可选：YouTube 音源](#可选youtube-音源)。
- **Bot Selector UI**：
  - 始终可见（不再只有 ≥2 个机器人时才显示）
  - 尺寸放大（更大的按钮、字体、状态图标）
  - 每行增加 **电源按键**（一键启动/停止对应机器人，带禁用态与播放状态高亮）
  - 每行增加 **链接按钮**（复制机器人专属 URL）
  - 新路由 `/bot/:id`，打开后自动切换到对应机器人
- **服务器密码登录**：`serverPassword` 字段已加入数据库与 Settings UI，支持加入需要密码的 TS 服务器。
- **`!add` 一键开播**：在连接状态下向空队列 `!add` 歌曲时自动开始播放（之前只会入队，需要再 `!play` 或 `!next`）。
- **WebSocket 新增 `botRemoved` 事件**：删除机器人后 UI 会立即从列表中移除（之前需要手动刷新页面）。

**内部修复**

- **`PlayQueue.remove()` 当前歌曲移除 bug**：移除正在播放的歌曲时，`next()` 不再跳过紧跟其后的那首歌。
- **投票跳过**：需要的票数现在至少为 1（避免 `needed=0` 时单人"全票通过"的边界情况）；投票计数会在每首新歌开始时自动清零，不再跨歌曲泄漏。
- 多处输入边界修复：`seek` 防止 `NaN` 毒化 `seekOffset` 导致 `getElapsed()` 永久返回 `NaN`；`play-at` 越界时不再误杀当前播放。

### 历史重要变更

更早的变更请查阅 git log。主要里程碑：

- **初始 TS3/TS6 双协议支持**：自动协议检测（TS3 port 10011 vs TS6 port 10080）、TS6 HTTP Query 客户端、数据库持久化 `serverProtocol` / `ts6ApiKey`。
- **多机器人架构**：支持同一进程中运行多个机器人实例，独立队列、进度、音量；WebUI 一键切换。
- **网易云 / QQ 音乐 / 哔哩哔哩**：三平台原生音源，QR 码登录，Cookie 持久化。
- **酷狗音乐音源**：第四个原生音源（直连 API，无 npm 依赖 / 无内嵌服务），覆盖搜索 / 播放 / KRC 歌词 / 专辑 / QR 登录，登录后支持每日推荐 / 推荐歌单 / 我的歌单 / 私人电台与歌曲封面。
- **Docker & systemd 部署**：一键部署脚本，数据卷持久化，自动重启支持。

## 致谢

感谢以下项目和开发者：

| 项目 | 说明 |
|------|------|
| [yichen11818/NeteaseTSBot](https://github.com/yichen11818/NeteaseTSBot) | TS6 协议兼容参考（vendored tsproto 补丁） |
| [Splamy/TS3AudioBot](https://github.com/Splamy/TS3AudioBot) | 优秀的 TeamSpeak 音频机器人框架 |
| [TS3AudioBot-BiliBiliPlugin](https://github.com/xxmod/TS3AudioBot-BiliBiliPlugin) | 提供插件开发参考 |
| [TS3AudioBot-NetEaseCloudmusic-plugin](https://github.com/ZHANGTIANYAO1/TS3AudioBot-NetEaseCloudmusic-plugin) | 提供插件开发参考和懒加载设计参考 |
| [TS3AudioBot-CloudMusic-plugin](https://github.com/577fkj/TS3AudioBot-Cloudmusic-plugin) | 提供插件开发参考 |
| [TS3AudioBot-Plugin-Netease-QQ](https://github.com/RayQuantum/TS3AudioBot-Plugin-Netease-QQ) | 提供插件开发参考 |
| [YesPlayMusic](https://github.com/qier222/YesPlayMusic) | UI 设计灵感 |
| [NeteaseCloudMusicApi](https://github.com/Binaryify/NeteaseCloudMusicApi) | 网易云音乐 API 项目 |
| [QQMusicApi](https://github.com/jsososo/QQMusicApi) | QQ 音乐 API 项目 |
| [@sansenjian/qq-music-api](https://github.com/sansenjian/qq-music-api) | QQ 音乐 API 活跃维护版本 |
| [@honeybbq/teamspeak-client](https://www.npmjs.com/package/@honeybbq/teamspeak-client) | TS3 完整客户端协议实现 |
| [bilibili-API-collect](https://github.com/SocialSisterYi/bilibili-API-collect) | 哔哩哔哩 API 文档 |
| [MakcRe/KuGouMusicApi](https://github.com/MakcRe/KuGouMusicApi) | 酷狗音乐 API 参考（请求签名 / KRC 歌词解码 / 设备注册移植来源，MIT 许可） |

## 开源许可

[MIT](LICENSE)
