# Jellyfin 音源（主音源化）实施计划

目标：自建 Jellyfin 服务器成为默认且主要的音源；现有 NetEase / QQ / Bilibili / YouTube / Kugou
继续编译但默认停用（`enabledProviders` 配置门控，本次不删除）。约束：`src/audio/*`、
`src/ts-protocol/*` 不改（唯一例外：`queue.ts` 中 `QueuedSong.platform` 联合类型加一个成员，
纯类型加宽，无任何逻辑改动，否则无法编译）。

## 触点地图

后端：
- `src/music/provider.ts` — platform 联合类型加 `"jellyfin"`（Song/Playlist/Album/MusicProvider）
- `src/audio/queue.ts` — 同上（仅类型，一个词）
- `src/data/database.ts` — PlayHistoryRecord.platform 加 `"jellyfin"`
- `src/music/auth.ts` — CookieStore 平台加 `"jellyfin"`（token JSON 与 cookie 同路径持久化）
- `src/data/config.ts` — 新增 `JellyfinConfig`（serverUrl / authMode / username / password /
  apiKey / userId）+ `enabledProviders`（默认 `["jellyfin"]`）+ 载入清洗 + `isProviderEnabled` /
  `defaultPlatform` 助手。spotify 仍由 `spotify.enabled` 门控、local 仍由 `localAudioEnabled` 门控
- `src/music/jellyfin.ts` — 新 Provider：认证（userpass=AuthenticateByName + MediaBrowser 头，
  401 重登一次；apikey=X-Emby-Token）、搜索（Audio/MusicAlbum/Playlist, StartIndex 翻页）、
  懒解析播放 URL（direct=`/Audio/{id}/stream?static=true`；320/192/128=`/Audio/{id}/universal`
  转码）、歌单/专辑/歌词（ticks→秒，404=无歌词）、收藏→InstantMix 电台链（收藏→最近播放→随机曲目）、
  最近添加/最多播放/流派、播放上报（Sessions/Playing[/Progress|/Stopped]，全部吞错）、
  音质档（direct 原始直传 / 320k / 192k / 128k）
- `src/music/api-server.ts` — 按 provider 开关决定是否绑定 3001/3200
- `src/index.ts` — 构造 JellyfinProvider、加载持久化 token、穿线
- `src/bot/manager.ts` — 穿线 jellyfinProvider（与 spotifyProvider 同模式）
- `src/bot/instance.ts` — jellyfin 分支（getProviderFor / getProvider，新 flag `-j`/`-n`）、
  默认平台=jellyfin、停用音源友好报错、歌单/专辑命令识别 GUID、播放上报挂钩、帮助文本
- `src/web/api/music.ts` — provider 选择 + 门控、`/providers`、jellyfin 首页数据端点、音质路由
- `src/web/api/auth.ts` — jellyfin 状态 + 测试连接（/System/Info）；无 QR
- `src/web/api/player.ts` — 平台白名单 + platformFlag（netease 显式 `-n`）
- `src/web/api/bot.ts` — settings 读写 jellyfin 配置块（密码/APIKey 写入不回显）+ 热更新 provider

前端（Vue 3，保持 YesPlayMusic 风格；新增文案 zh+en）：
- `stores/player.ts` — Source 加 jellyfin、enabledProviders 状态、jellyfin 首页数据
- `views/Search.vue` — 音源条只显示启用的 provider、Jellyfin 徽标
- `views/Home.vue` — 最近添加 / 播放最多 / 我的歌单 / 收藏 / 流派 区块 + jellyfin FM 卡片
- `views/Settings.vue` — Jellyfin 连接卡（地址/认证模式/凭据/测试连接）、隐藏停用 provider 的
  登录卡、jellyfin 音质档
- `views/Setup.vue` — 向导第 3 步换成 Jellyfin 连接卡
- `views/Playlist.vue` 等 — ID 均按 string 处理，审计通过（GUID 无数字假设）

文档：README 增加「Jellyfin 音源」章节 + fork 出处与 MIT 归属（上游
ZHANGTIANYAO1/teamspeak-music-bot）。

## 阶段与验证

1. 类型 + 配置 → `npx tsc --noEmit`
2. JellyfinProvider + 单测 → tsc + vitest
3. 门控 + bot 穿线 → tsc + vitest
4. REST → tsc + vitest
5. WebUI → `cd web && npm run build`
6. README + 全量构建/测试
