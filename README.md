# TSMusicBot

TeamSpeak 3 音乐机器人，支持网易云音乐和 QQ 音乐，带有 YesPlayMusic 风格的 WebUI 控制面板。

## 功能特性

- **双音源支持** — 网易云音乐 + QQ 音乐，统一搜索，结果标注来源
- **真实 TS3 客户端协议** — 机器人在 TeamSpeak 中可见（非 ServerQuery）
- **WebUI 控制面板** — YesPlayMusic 风格界面，支持深色/浅色主题
- **播放控制** — 播放/暂停/上一首/下一首/进度跳转/音量调节
- **播放模式** — 顺序播放/循环播放/随机播放/随机循环
- **歌词同步** — 实时歌词滚动，支持翻译歌词
- **歌单管理** — 浏览推荐歌单/我的歌单/每日推荐/私人FM
- **播放队列** — 侧边栏查看和管理，支持拖动排序
- **音质选择** — 标准(128k) / 较高(192k) / 极高(320k) / 无损(FLAC) / Hi-Res / 超清母带
- **QR码登录** — 扫码登录网易云/QQ音乐账号
- **多实例** — 支持同时管理多个机器人实例
- **播放历史** — 记录所有播放过的歌曲
- **懒加载** — 歌单只存储元数据，播放时才获取链接（链接不过期）
- **一键部署** — Windows 批处理 / Linux systemd / Docker

## 快速开始

### 环境要求

- Node.js >= 20
- FFmpeg（[下载](https://www.gyan.dev/ffmpeg/builds/)）
- TeamSpeak 3 服务器

### 安装

```bash
git clone <repo-url> tsmusicbot
cd tsmusicbot
npm install
cd web && npm install && cd ..
```

### 运行

```bash
# 开发模式（自动重载）
npm run dev

# 生产模式
npm run build
npm start
```

### 访问

- WebUI: http://localhost:3000
- 首次使用: http://localhost:3000/setup

## 架构

```
src/
├── audio/          # 音频引擎（FFmpeg → Opus 编码 → 20ms 帧）
│   ├── encoder.ts  # Opus 编码器
│   ├── player.ts   # FFmpeg 播放器（懒加载URL，帧计数进度追踪）
│   └── queue.ts    # 播放队列（4种模式）
├── bot/            # 机器人核心
│   ├── commands.ts # 文字命令解析器
│   ├── instance.ts # Bot 实例（TS3 + 播放器 + 音源）
│   └── manager.ts  # 多实例管理
├── data/           # 数据层
│   ├── config.ts   # JSON 配置
│   └── database.ts # SQLite（播放历史、实例持久化）
├── music/          # 音源服务
│   ├── provider.ts # 统一接口
│   ├── netease.ts  # 网易云音乐
│   ├── qq.ts       # QQ 音乐
│   ├── auth.ts     # Cookie 持久化
│   └── api-server.ts # 嵌入式 API 服务
├── ts-protocol/    # TS3 客户端协议
│   ├── client.ts   # 完整客户端（ECDH + AES-EAX 加密）
│   ├── identity.ts # Ed25519 身份
│   ├── commands.ts # 命令编解码
│   ├── connection.ts # TCP 连接
│   └── voice.ts    # UDP 语音
├── web/            # Web 后端
│   ├── server.ts   # Express + WebSocket
│   ├── websocket.ts # 实时状态推送
│   └── api/        # REST API
└── index.ts        # 入口

web/src/            # Vue.js 前端
├── components/     # Player, Navbar, Queue, CoverArt, SongCard
├── views/          # Home, Search, Playlist, Lyrics, History, Settings, Setup
├── stores/         # Pinia 状态管理
├── composables/    # WebSocket 连接
└── styles/         # SCSS 主题变量
```

## TS 文字命令

在 TeamSpeak 中发送文字消息控制机器人：

| 命令 | 说明 |
|------|------|
| `!play <歌名>` | 搜索并播放 |
| `!play -q <歌名>` | 从 QQ 音乐搜索 |
| `!add <歌名>` | 添加到队列 |
| `!pause` / `!resume` | 暂停/恢复 |
| `!next` / `!prev` | 下一首/上一首 |
| `!stop` | 停止并清空队列 |
| `!vol <0-100>` | 设置音量 |
| `!queue` | 查看队列 |
| `!mode <seq\|loop\|random\|rloop>` | 播放模式 |
| `!playlist <ID>` | 加载歌单 |
| `!fm` | 私人 FM（网易云） |
| `!lyrics` | 显示歌词 |
| `!vote` | 投票跳过 |
| `!help` | 帮助 |

## Docker 部署

```bash
cd scripts/docker
docker-compose up -d
```

## 技术栈

**后端:** Node.js, TypeScript, Express, WebSocket, better-sqlite3, pino, FFmpeg, @discordjs/opus

**前端:** Vue 3, Vite, Pinia, Vue Router, SCSS, axios

**TS3 协议:** @honeybbq/teamspeak-client（完整客户端协议，ECDH + AES-EAX）

**音源:** NeteaseCloudMusicApi, @sansenjian/qq-music-api

## License

MIT
