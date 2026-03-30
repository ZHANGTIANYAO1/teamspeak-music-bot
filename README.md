# TSMusicBot

TeamSpeak 3 音乐机器人，支持网易云音乐和 QQ 音乐，带有 YesPlayMusic 风格的 WebUI 控制面板。

## 功能特性

- **双音源支持** — 网易云音乐 + QQ 音乐，统一搜索，结果标注来源
- **真实 TS3 客户端协议** — 机器人在 TeamSpeak 中可见（非 ServerQuery 隐身模式）
- **WebUI 控制面板** — YesPlayMusic 风格界面，支持深色/浅色主题
- **播放控制** — 播放/暂停/上一首/下一首/进度跳转/音量调节
- **播放模式** — 顺序播放/循环播放/随机播放/随机循环
- **歌词同步** — 实时歌词滚动显示，支持翻译歌词，服务端帧计数精确同步
- **歌单管理** — 推荐歌单/我的歌单/每日推荐/私人FM，点击播放全部
- **播放队列** — 侧边栏队列面板，查看和管理当前队列
- **音质选择** — 标准(128k) / 较高(192k) / 极高(320k) / 无损(FLAC) / Hi-Res / 超清母带
- **QR码登录** — 扫码登录网易云/QQ音乐账号，Cookie 自动持久化
- **多实例** — 同时管理多个机器人实例，连接不同 TS 服务器
- **播放历史** — 自动记录所有播放过的歌曲
- **懒加载** — 歌单只存储元数据，播放时才获取链接（避免链接过期）
- **首页缓存** — 推荐数据 5 分钟缓存，返回首页无需重新加载
- **一键部署** — FFmpeg 内置，Windows 双击运行 / Linux systemd / Docker

## 快速开始

### Windows 一键部署

只需要安装 [Node.js 20+](https://nodejs.org/)，其他依赖（FFmpeg 等）全部自动安装。

```
1. 下载或 clone 本项目
2. 双击 scripts\setup.bat      （首次安装，自动安装 Node.js 和所有依赖）
3. 双击 scripts\start.bat      （启动机器人）
4. 浏览器打开 http://localhost:3000
```

> `setup.bat` 会自动通过 winget 安装 Node.js（如果未安装），然后运行 `npm install` 安装所有依赖（包括内置的 FFmpeg），最后构建项目。之后只需双击 `start.bat` 即可启动。

### 手动安装

#### 环境要求

- Node.js >= 20（[下载](https://nodejs.org/)）
- TeamSpeak 3 服务器
- FFmpeg — **已内置**，无需单独安装（通过 `ffmpeg-static` 自动包含）

#### 安装步骤

```bash
git clone <repo-url> tsmusicbot
cd tsmusicbot
npm install          # 安装后端依赖（包含 FFmpeg）
cd web && npm install && cd ..   # 安装前端依赖
npm run build        # 构建
```

#### 运行

```bash
# 开发模式（代码修改自动重载）
npm run dev

# 生产模式
npm run build
npm start
```

#### 访问

打开浏览器：
- **WebUI 控制面板:** http://localhost:3000
- **首次使用向导:** http://localhost:3000/setup

### Linux 一键安装

```bash
chmod +x scripts/install.sh
sudo ./scripts/install.sh
```

自动安装 Node.js、依赖，配置 systemd 服务，开机自启。

### Docker 一键部署

所有依赖已内置（Node.js、FFmpeg、Opus 编码器），无需安装任何额外软件。

```bash
cd scripts/docker
docker-compose up -d
```

访问 http://localhost:3000

**说明：**
- 首次构建需要几分钟（编译 native 模块）
- 使用 `host` 网络模式，机器人可直接连接局域网 TS3 服务器
- 数据持久化在 Docker named volume `tsmusicbot-data` 中（数据库、Cookie、日志）
- 内置健康检查（`/api/health`），支持 Docker 自动重启

```bash
# 查看日志
docker logs -f tsmusicbot

# 停止
docker-compose down

# 重新构建（代码更新后）
docker-compose up -d --build
```

如果 TS3 服务器不在同一台机器，可编辑 `docker-compose.yml` 将 `network_mode: host` 替换为端口映射：
```yaml
ports:
  - "3000:3000"
```

## 使用说明

### 首次配置

1. 打开 http://localhost:3000/setup 进入设置向导
2. 填写 TeamSpeak 服务器地址和端口（默认 9987）
3. 设置机器人昵称
4. （可选）扫码登录网易云/QQ音乐账号以播放 VIP 歌曲

### WebUI 功能

| 页面 | 功能 |
|------|------|
| **首页** | 推荐歌单、每日推荐、私人FM、我的歌单 |
| **搜索** | 双平台统一搜索，结果标注 网易云/QQ 来源 |
| **歌单** | 查看歌单详情，播放全部（根据播放模式选择首歌） |
| **歌词** | 全屏歌词页，实时同步滚动，支持翻译歌词 |
| **历史** | 播放历史记录 |
| **设置** | 主题切换、机器人管理、音乐账号登录、音质选择、命令前缀 |

### TS 文字命令

在 TeamSpeak 频道中发送文字消息控制机器人：

| 命令 | 说明 |
|------|------|
| `!play <歌名>` | 搜索并播放 |
| `!play -q <歌名>` | 从 QQ 音乐搜索 |
| `!add <歌名>` | 添加到队列 |
| `!pause` / `!resume` | 暂停 / 恢复 |
| `!next` / `!prev` | 下一首 / 上一首 |
| `!stop` | 停止并清空队列 |
| `!vol <0-100>` | 设置音量 |
| `!queue` | 查看播放队列 |
| `!mode <seq\|loop\|random\|rloop>` | 切换播放模式 |
| `!playlist <ID>` | 加载歌单 |
| `!album <ID>` | 加载专辑 |
| `!fm` | 私人 FM（网易云） |
| `!lyrics` | 显示当前歌词 |
| `!now` | 当前播放信息 |
| `!vote` | 投票跳过当前歌曲 |
| `!move <频道>` | 移动到指定频道 |
| `!help` | 帮助信息 |

> 命令前缀默认为 `!`，可在设置页面修改。支持别名：`!p` = `!play`，`!s` = `!skip`，`!n` = `!next`

### 音质等级

| 等级 | 码率 | 格式 | 说明 |
|------|------|------|------|
| 标准 | 128kbps | MP3 | 默认免费 |
| 较高 | 192kbps | MP3 | |
| 极高 | 320kbps | MP3 | **默认选择** |
| 无损 | ~900kbps | FLAC | 需要 VIP |
| Hi-Res | ~1500kbps | FLAC | 需要 VIP |
| 超清母带 | ~4000kbps | FLAC | 需要黑胶 VIP |

在设置页面选择音质，立即生效（影响后续播放的歌曲）。

## 项目架构

```
tsmusicbot/
├── src/                    # 后端源码 (TypeScript)
│   ├── audio/              # 音频引擎
│   │   ├── encoder.ts      # Opus 编码器 (@discordjs/opus)
│   │   ├── player.ts       # FFmpeg 播放器（内置 ffmpeg-static）
│   │   └── queue.ts        # 播放队列（顺序/循环/随机/随机循环）
│   ├── bot/                # 机器人核心
│   │   ├── commands.ts     # TS 文字命令解析（前缀、别名、权限）
│   │   ├── instance.ts     # Bot 实例（绑定 TS3 + 播放器 + 音源）
│   │   └── manager.ts      # 多实例生命周期管理
│   ├── data/               # 数据层
│   │   ├── config.ts       # JSON 配置（端口、前缀、音质等）
│   │   └── database.ts     # SQLite（播放历史、实例持久化）
│   ├── music/              # 音源服务
│   │   ├── provider.ts     # 统一 MusicProvider 接口
│   │   ├── netease.ts      # 网易云音乐适配器
│   │   ├── qq.ts           # QQ 音乐适配器
│   │   ├── auth.ts         # Cookie 持久化存储
│   │   └── api-server.ts   # 嵌入式 API 服务（自动启动）
│   ├── ts-protocol/        # TS3 客户端协议
│   │   ├── client.ts       # 完整客户端（ECDH + AES-EAX 加密）
│   │   ├── identity.ts     # Ed25519 身份生成
│   │   ├── commands.ts     # TS3 命令编解码
│   │   ├── connection.ts   # TCP ServerQuery 连接
│   │   └── voice.ts        # UDP 语音包发送
│   ├── web/                # Web 后端
│   │   ├── server.ts       # Express + WebSocket 服务
│   │   ├── websocket.ts    # 实时状态广播
│   │   └── api/            # REST API 路由
│   │       ├── bot.ts      # 机器人管理 CRUD
│   │       ├── music.ts    # 搜索/歌单/歌词/音质
│   │       ├── player.ts   # 播放控制/队列/历史/跳转
│   │       └── auth.ts     # QR登录/Cookie/SMS
│   └── index.ts            # 入口（启动所有服务）
├── web/src/                # 前端源码 (Vue.js)
│   ├── components/         # Player, Navbar, Queue, CoverArt, SongCard
│   ├── views/              # Home, Search, Playlist, Lyrics, History, Settings, Setup
│   ├── stores/             # Pinia 状态管理（含服务端时间同步）
│   ├── composables/        # WebSocket 自动重连
│   └── styles/             # SCSS 主题变量（深色/浅色）
├── scripts/                # 部署脚本
│   ├── setup.bat           # Windows 首次安装（自动装 Node.js + 依赖）
│   ├── start.bat           # Windows 启动脚本
│   ├── install.sh          # Linux 一键安装 + systemd 服务
│   └── docker/             # Docker 部署
│       ├── Dockerfile
│       └── docker-compose.yml
├── data/                   # 运行时数据（自动创建）
│   ├── tsmusicbot.db       # SQLite 数据库
│   ├── cookies/            # 登录 Cookie
│   └── logs/               # 日志文件
└── config.json             # 配置文件（首次运行自动生成）
```

## 技术栈

| 层级 | 技术 |
|------|------|
| **运行时** | Node.js 20+, TypeScript 5 |
| **后端框架** | Express 4, WebSocket (ws) |
| **数据库** | better-sqlite3 (SQLite) |
| **日志** | pino |
| **音频** | FFmpeg (ffmpeg-static), @discordjs/opus |
| **TS3 协议** | @honeybbq/teamspeak-client（完整客户端协议） |
| **网易云 API** | NeteaseCloudMusicApi |
| **QQ 音乐 API** | @sansenjian/qq-music-api |
| **前端框架** | Vue 3, Vite 5 |
| **状态管理** | Pinia |
| **路由** | Vue Router 4 |
| **样式** | SCSS（YesPlayMusic 设计风格） |
| **图标** | @iconify/vue |

## 致谢

- [YesPlayMusic](https://github.com/qier222/YesPlayMusic) — UI 设计灵感
- [TS3AudioBot](https://github.com/Splamy/TS3AudioBot) — 架构参考
- [TS3AudioBot-NetEaseCloudmusic-plugin](https://github.com/ZHANGTIANYAO1/TS3AudioBot-NetEaseCloudmusic-plugin) — 懒加载设计参考
- [NeteaseCloudMusicApi](https://github.com/Binaryify/NeteaseCloudMusicApi) — 网易云音乐 API
- [@sansenjian/qq-music-api](https://github.com/sansenjian/qq-music-api) — QQ 音乐 API
- [@honeybbq/teamspeak-client](https://www.npmjs.com/package/@honeybbq/teamspeak-client) — TS3 客户端协议

## License

MIT
