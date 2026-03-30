<p align="center">
  <img src="https://img.shields.io/badge/TeamSpeak_3-音乐机器人-blue?style=for-the-badge&logo=teamspeak" alt="TSMusicBot" />
</p>

<h1 align="center">TSMusicBot</h1>

<p align="center">
  <strong>TeamSpeak 3 音乐机器人</strong> — 网易云音乐 + QQ 音乐 + 哔哩哔哩 三平台，YesPlayMusic 风格 WebUI 控制面板
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-20+-339933?logo=nodedotjs&logoColor=white" />
  <img src="https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white" />
  <img src="https://img.shields.io/badge/Vue-3-4FC08D?logo=vuedotjs&logoColor=white" />
  <img src="https://img.shields.io/badge/许可证-MIT-green" />
  <img src="https://img.shields.io/badge/FFmpeg-已内置-orange?logo=ffmpeg" />
  <img src="https://img.shields.io/badge/Docker-支持-2496ED?logo=docker&logoColor=white" />
  <img src="https://img.shields.io/badge/BiliBili-支持-00a1d6?logo=bilibili&logoColor=white" />
</p>

---

## 功能特性

- **三平台音源** — 网易云音乐 + QQ 音乐 + 哔哩哔哩，统一搜索，结果标注来源
- **真实 TS3 客户端协议** — 机器人在 TeamSpeak 中可见（非 ServerQuery 隐身模式），兼容 TS3/TS5/TS6 服务器
- **YesPlayMusic 风格 WebUI** — 精美界面，支持深色/浅色主题切换
- **完整播放控制** — 播放/暂停/上一首/下一首/进度跳转/音量调节
- **四种播放模式** — 顺序播放/循环播放/随机播放/随机循环
- **实时歌词同步** — 歌词滚动显示，支持翻译歌词，服务端帧计数精确同步
- **歌单管理** — 推荐歌单/我的歌单/每日推荐/私人FM，点击播放全部
- **音质选择** — 标准(128k) / 较高(192k) / 极高(320k) / 无损(FLAC) / Hi-Res / 超清母带
- **B站视频音频提取** — 搜索B站视频，自动提取DASH最高码率音频流播放
- **B站热门推荐** — 首页展示B站热门视频和个性化推荐（登录后更准确）
- **QR码登录** — 扫码登录网易云/QQ音乐/哔哩哔哩账号，Cookie 自动持久化
- **多实例管理** — 同时管理多个机器人，连接不同 TS 服务器
- **播放历史** — 自动记录所有播放过的歌曲
- **懒加载机制** — 歌单只存储元数据，播放时才获取链接（避免链接过期）
- **一键部署** — FFmpeg 内置，Windows 双击运行 / Linux systemd / Docker

## 截图

> *截图即将添加*

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
git clone https://github.com/YOUR_USERNAME/tsmusicbot.git
cd tsmusicbot

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
git clone https://github.com/YOUR_USERNAME/tsmusicbot.git
cd tsmusicbot/scripts/docker
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

## 使用说明

### 首次配置

1. 打开 **http://localhost:3000/setup** 进入设置向导
2. 填写 TeamSpeak 服务器地址（默认端口：9987）
3. 设置机器人昵称
4. （可选）扫码登录网易云/QQ音乐账号以播放 VIP 歌曲

### WebUI 页面说明

| 页面 | 功能 |
|------|------|
| **首页** | 推荐歌单、每日推荐、私人FM、我的歌单 |
| **搜索** | 三平台统一搜索，结果标注网易云/QQ/B站来源 |
| **歌单** | 查看歌单详情，播放全部（根据当前播放模式选择首歌） |
| **歌词** | 全屏歌词页，实时同步滚动，模糊专辑封面背景 |
| **历史** | 播放历史记录 |
| **设置** | 主题切换、机器人管理、三平台账号登录、音质选择、命令前缀 |

### TeamSpeak 文字命令

在 TeamSpeak 频道中发送文字消息控制机器人：

| 命令 | 说明 |
|------|------|
| `!play <歌名>` | 搜索并播放 |
| `!play -q <歌名>` | 从 QQ 音乐搜索 |
| `!play -b <关键词>` | 从哔哩哔哩搜索视频并播放音频 |
| `!add <歌名>` | 添加到播放队列 |
| `!pause` / `!resume` | 暂停 / 恢复播放 |
| `!next` / `!prev` | 下一首 / 上一首 |
| `!stop` | 停止播放并清空队列 |
| `!vol <0-100>` | 设置音量 |
| `!queue` | 查看播放队列 |
| `!mode <seq\|loop\|random\|rloop>` | 切换播放模式 |
| `!playlist <ID>` | 加载歌单 |
| `!album <ID>` | 加载专辑 |
| `!fm` | 私人 FM（网易云） |
| `!lyrics` | 显示当前歌词 |
| `!now` | 当前播放信息 |
| `!vote` | 投票跳过当前歌曲 |
| `!move <频道名>` | 移动到指定频道 |
| `!help` | 显示帮助信息 |

> 命令前缀默认为 `!`，可在设置页面修改。支持别名：`!p` = `!play`，`!s` = `!skip`，`!n` = `!next`

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
tsmusicbot/
├── src/                        # 后端源码 (TypeScript)
│   ├── audio/                  # 音频管线：FFmpeg → PCM → Opus → 20ms 帧
│   │   ├── encoder.ts          # Opus 编码器 (@discordjs/opus)
│   │   ├── player.ts           # FFmpeg 播放器（内置 ffmpeg-static，帧计数进度追踪）
│   │   └── queue.ts            # 播放队列（4种模式，懒加载URL）
│   ├── bot/                    # 机器人核心
│   │   ├── commands.ts         # 文字命令解析器（前缀、别名、权限）
│   │   ├── instance.ts         # Bot 实例（绑定 TS3 + 播放器 + 音源）
│   │   └── manager.ts          # 多实例生命周期管理
│   ├── data/                   # 数据层
│   │   ├── config.ts           # JSON 配置文件
│   │   └── database.ts         # SQLite 数据库（播放历史、实例持久化）
│   ├── music/                  # 音源服务
│   │   ├── provider.ts         # 统一 MusicProvider 接口
│   │   ├── netease.ts          # 网易云音乐适配器
│   │   ├── qq.ts               # QQ 音乐适配器
│   │   ├── bilibili.ts         # 哔哩哔哩适配器（视频音频提取）
│   │   ├── auth.ts             # Cookie 持久化存储
│   │   └── api-server.ts       # 嵌入式 API 服务（自动启动）
│   ├── ts-protocol/            # TS3 客户端协议
│   │   └── client.ts           # 完整客户端（ECDH + AES-EAX 加密协议）
│   ├── web/                    # Web 后端
│   │   ├── server.ts           # Express + WebSocket 服务
│   │   ├── websocket.ts        # 实时状态广播
│   │   └── api/                # REST API 路由
│   │       ├── bot.ts          # 机器人管理 CRUD
│   │       ├── music.ts        # 搜索/歌单/歌词/音质
│   │       ├── player.ts       # 播放控制/队列/历史/跳转
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
├── data/                       # 运行时数据（自动创建，不上传）
│   ├── tsmusicbot.db           # SQLite 数据库
│   ├── cookies/                # 登录 Cookie
│   └── logs/                   # 日志文件
└── config.json                 # 配置文件（首次运行自动生成，不上传）
```

## 技术栈

| 层级 | 技术 |
|------|------|
| **运行时** | Node.js 20+, TypeScript 5 |
| **后端框架** | Express 4, WebSocket (ws) |
| **数据库** | better-sqlite3 (SQLite) |
| **音频处理** | FFmpeg (ffmpeg-static 内置), @discordjs/opus |
| **TS 协议** | @honeybbq/teamspeak-client（完整客户端协议，兼容 TS3/TS5/TS6） |
| **网易云 API** | NeteaseCloudMusicApi |
| **QQ 音乐 API** | @sansenjian/qq-music-api |
| **哔哩哔哩** | BiliBili Web API（搜索、DASH 音频流、QR 登录） |
| **前端框架** | Vue 3, Vite 5, Pinia, Vue Router 4 |
| **界面样式** | SCSS（YesPlayMusic 设计风格） |
| **图标** | @iconify/vue |
| **日志** | pino |

## 配置文件

`config.json` 在首次运行时自动生成，可手动编辑：

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
  "autoPauseOnEmpty": true
}
```

## 常见问题

**Q：机器人连接了但 TeamSpeak 中听不到音乐？**
A：确保机器人和你在同一个频道。检查音量（`!vol 75`）。部分 VIP 歌曲需要先登录账号。

**Q：提示"无法获取播放链接"？**
A：在设置页面扫码登录音乐账号。许多歌曲需要登录后才能播放。

**Q：如何更换机器人所在频道？**
A：使用 `!move <频道名>` 命令，或在设置页面创建机器人时指定默认频道。

**Q：可以同时运行多个机器人吗？**
A：可以。在设置页面创建多个实例，分别连接不同的 TS 服务器或频道。

**Q：端口 3200 被占用？**
A：QQ 音乐 API 启动时自动监听 3200 端口。如果之前的进程还在运行，程序会自动复用。如需重启可手动结束 `node` 进程。

**Q：Docker 构建失败？**
A：原生模块（opus、sqlite3）需要编译工具，Dockerfile 已包含。确保 Docker 有足够内存（建议 2GB+）。

**Q：B站视频搜索不到结果？**
A：B站搜索需要 buvid3 匿名 Cookie（程序启动时自动获取）。如果失败，重启程序即可。登录B站账号后搜索效果更好。

**Q：如何更新到新版本？**
A：`git pull` 拉取最新代码，然后 `npm install && npm run build && npm start` 重新构建启动。Docker 用户执行 `docker-compose up -d --build`。

## 参与贡献

1. Fork 本仓库
2. 创建功能分支 (`git checkout -b feature/新功能`)
3. 提交更改 (`git commit -m 'feat: 添加新功能'`)
4. 推送分支 (`git push origin feature/新功能`)
5. 提交 Pull Request

## 致谢

感谢以下项目和开发者：

| 项目 | 说明 |
|------|------|
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

## 开源许可

[MIT](LICENSE)
