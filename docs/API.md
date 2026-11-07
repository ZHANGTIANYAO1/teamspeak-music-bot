# REST API 参考

本文档列出机器人对外提供的全部 REST API 端点、参数与返回。所有端点均支持两种认证方式(见下),除单独标注「仅浏览器 session」的端点外。

## 通用约定

### 认证

```
Authorization: Bearer tsmb_xxxxxxxxxxxx
# 或
X-API-Key: tsmb_xxxxxxxxxxxx
```

Key 在 WebUI 设置页创建,权限与所属账户一致。除标注「仅浏览器 session」的端点外,API Key 与浏览器 session(cookie)使用相同的账户权限。

管理员 API Key 保留完整的 REST 管理权限,包括 `/api/users` 的创建用户、重置密码与权限变更;因此也可以创建新的可登录账户。`/api/keys` 的 session 限制只约束直接密钥管理,不能作为管理员 Key 的权限隔离措施。

### 密钥吊销与密码变更

API Key 没有自动到期时间,可在设置页随时吊销。删除账户会同时删除其全部 Key。成功修改自己的密码或由管理员重置密码,都会吊销该账户的全部 Key;依赖这些 Key 的外部集成需要重新生成并更新凭据。失败的密码变更不会吊销 Key。

修改自己的密码会保留当前浏览器 session,使其余 session 失效。管理员重置其他账户的密码会使目标账户的全部 session 失效;重置自己的密码时同样保留当前浏览器 session。

### 错误格式

所有错误返回统一为 JSON `{ "error": "..." }`:

| 状态码 | 含义 |
|--------|------|
| 400 | 参数缺失或格式错误 |
| 401 | 未认证 / API Key 无效(`invalid api key`) |
| 403 | 无权限(能力不足、机器人未授权、API Key 试图管理 Key 等) |
| 404 | 资源不存在 |
| 409 | 冲突(如收藏已存在、Key 数量达上限) |
| 500 | 服务器内部错误 |

### 权限模型

| 标注 | 含义 |
|------|------|
| 公开 | 无需认证 |
| 已认证 | 任意登录用户 / 有效 API Key |
| 非游客 | API Key 用户恒满足(guest session 除外) |
| `player.control` / `player.queue` / `bot.manage` / `platform.auth` / `quality` | 需要账户持有对应能力;管理员恒通过 |
| 机器人访问 | 成员只能操作被授予的机器人(账户权限中的 bot 范围),管理员不限 |
| 管理员 | 仅 `role=admin` |

### 平台(platform)取值

`netease` / `qq` / `bilibili` / `youtube` / `kugou` / `jellyfin` / `local` / `spotify`

省略 `platform` 时使用设置页配置的默认音源;已禁用的音源返回 `400 音源未启用`。

### 点歌归属

`/play`、`/add`、`/play-*`、`/add-*` 等入队端点会把 `requestedBy` 记为 Key 所属账户的用户名,队列与播放历史中可见。

---

## 数据模型

```ts
// 歌曲(搜索结果 / 队列元素)
interface Song {
  id: string;            // 平台内歌曲 id
  name: string;
  artist: string;
  album: string;
  duration: number;      // 秒
  coverUrl: string;
  platform: Platform;
  vip?: boolean;         // VIP/版权受限(仅试听)
}

// 队列中的歌曲(Song + 归属;url 仅播放时内部解析,不出现在响应里)
interface QueuedSong extends Omit<Song, "vip"> {
  requestedBy?: string;
}

interface Album  { id: string; name: string; artist: string; coverUrl: string; songCount: number; platform: Platform }
interface Playlist { id: string; name: string; coverUrl: string; songCount: number; platform: Platform }

// 机器人实时状态
interface BotStatus {
  id: string;
  name: string;
  connected: boolean;
  playing: boolean;
  paused: boolean;
  currentSong: QueuedSong | null;
  queueSize: number;
  volume: number;            // 0-100
  playMode: "seq" | "loop" | "random" | "rloop";
  elapsed: number;           // 当前曲目已播秒数
  effectiveDuration?: number; // 当前曲实际播放时长(试听片段=试听秒数)
}
```

---

## 公开端点(无需认证)

### GET /api/health

```json
{ "status": "ok", "version": "0.1.0" }
```

### GET /api/config/public-url

```json
{ "publicUrl": "https://bot.example.com" }   // 未配置时为 null
```

---

## 机器人管理 /api/bot

| 方法 | 路径 | 权限 | 说明 |
|------|------|------|------|
| GET | `/api/bot` | 已认证 | 机器人列表(成员只返回被授权的) |
| GET | `/api/bot/settings` | 非游客 | 全局行为设置 |
| POST | `/api/bot/settings` | `bot.manage` | 保存全局设置(部分合并) |
| POST | `/api/bot` | `bot.manage` | 创建机器人 |
| GET | `/api/bot/:id` | 机器人访问 | 单个机器人状态 |
| PUT | `/api/bot/:id` | `bot.manage` + 机器人访问 | 更新连接配置 |
| DELETE | `/api/bot/:id` | `bot.manage` + 机器人访问 | 删除机器人 |
| POST | `/api/bot/:id/start` | `bot.manage` + 机器人访问 | 连接服务器 |
| POST | `/api/bot/:id/stop` | `bot.manage` + 机器人访问 | 断开连接 |
| GET | `/api/bot/:id/config` | `bot.manage` + 机器人访问 | 保存的连接配置(不含 identity/TS6 key) |
| GET / PUT / DELETE | `/api/bot/:id/avatar` | `bot.manage` + 机器人访问 | 自定义头像 |

### GET /api/bot

```json
{ "bots": [ { "id": "…", "name": "客厅bot", "connected": true, "playing": true, "paused": false,
              "currentSong": { "…": "QueuedSong" }, "queueSize": 3, "volume": 75,
              "playMode": "seq", "elapsed": 42.5, "effectiveDuration": 269 } ] }
```

### POST /api/bot

```json
// 请求体(name、serverAddress、nickname 必填;serverPort 默认 9987)
{ "name": "客厅bot", "serverAddress": "ts.example.com", "serverPort": 9987,
  "nickname": "♪ 音乐机器人", "defaultChannel": "音乐频道", "channelId": "12",
  "channelPassword": "", "serverPassword": "", "autoStart": true }
// 201 返回 BotStatus
```

### PUT /api/bot/:id

请求体字段同上(全部可选),返回 `{ "success": true }`。连接相关修改需重启机器人(`stop` 后 `start`)生效。

### POST /api/bot/settings(部分合并,未传的字段不变)

```json
{
  "idleTimeoutMinutes": 30,          // 空闲自动断开,0=不启用
  "autoPauseOnEmpty": true,          // 频道无人自动暂停
  "localAudioEnabled": true,         // 本地音频
  "voiceDucking": { "enabled": true, "volumePercent": 20 },
  "savedQueuesEnabled": true,
  "playKeepsQueue": false,           // !play 是否保留队列
  "adminGroups": [6],
  "enabledProviders": ["netease","qq","bilibili","youtube","kugou"],
  "defaultPlatform": "netease",      // null/"" 清除
  "guestMode": { "enabled": false, "bots": "all", "permissions": { "…": true } },
  "spotify":     { "enabled": false, "clientId": "…", "clientSecret": "…", "backend": "auto", "bitrate": 160, "deviceName": "…" },
  "jellyfin":    { "serverUrl": "…", "authMode": "userpass", "username": "…", "password": "…" }
}
// 返回:与 GET /settings 相同结构(spotify.clientSecret / jellyfin.password 永不回传,仅 hasClientSecret / hasPassword 布尔)
```

### PUT /api/bot/:id/avatar

请求体 `{ "dataUrl": "data:image/png;base64,…" }`(png/jpeg/webp,≤200KB),返回 `{ "path": "avatars/xx.png" }`。

---

## 播放控制 /api/player/:botId

以下所有端点都要求机器人访问权限;标注能力的管理类操作还需对应能力。`{ "message": "…" }` 为命令执行回执文本(与聊天命令回执一致),失败时 message 中带原因或返回 4xx/5xx。

### 播放入口

| 方法 | 路径 | 能力 | 请求体 | 返回 |
|------|------|------|--------|------|
| POST | `/play` | `player.control` | `{ query, platform? }`(搜索文本) | `{ message }` |
| POST | `/add` | `player.queue` | `{ query, platform? }` | `{ message }` |
| POST | `/play-song` | `player.control` | `{ song }`(Song 对象,清空队列播放) | `{ ok, message }` |
| POST | `/play-now-song` | `player.control` | `{ song }`(插入当前曲后立即播放,保留队列) | `{ ok, message }` |
| POST | `/play-next-song` | `player.control` | `{ song }`(插播下一首;空闲时直接播放) | `{ ok, message }` |
| POST | `/add-song` | `player.queue` | `{ song }`(入队;空闲时立即播放) | `{ message }` |
| POST | `/add-by-id` | `player.queue` | `{ songId, platform? }` | `{ message }` |
| POST | `/play-playlist` | `player.control` | `{ playlistId, platform? }`(清队列载入歌单) | `{ ok, message }` |
| POST | `/play-album` | `player.control` | `{ albumId, platform? }`(清队列载入专辑) | `{ ok, message }` |
| POST | `/playlist` | `player.queue` | `{ playlistId, platform? }`(追加整个歌单) | `{ message }` |
| POST | `/fm` | `player.control` | `{ platform? }`(私人 FM 模式) | `{ ok, message }` |

`/play` 与 `/add` 接受搜索文本,内部按 `platform` 调对应音源搜索并播放/入队第一个结果;`/play-song` 系列接受 `/api/music` 返回的完整 Song 对象。B站多P视频的 Song `id` 形如 `BVxxxx?p=2`(见 `/api/music/bilibili/parts`),传对应分P的 id 即播放该分P。

`/fm` 的平台为网易时,若调用者账户已绑定个人网易账号(见 `/api/me/music`),FM 曲目按**个人账号**的口味推荐;未绑定则使用机器人共享登录。

### 播放器控制

| 方法 | 路径 | 能力 | 请求体 | 返回 |
|------|------|------|--------|------|
| POST | `/pause` | `player.control` | — | `{ message }` |
| POST | `/resume` | `player.control` | — | `{ message }` |
| POST | `/next` | `player.control` | — | `{ message }` |
| POST | `/prev` | `player.control` | — | `{ message }` |
| POST | `/stop` | `player.control` | — | `{ message }` |
| POST | `/clear` | `player.queue` | — | `{ message }` |
| POST | `/volume` | `player.control` | `{ volume: 0-100 }` | `{ message }` |
| POST | `/mode` | `player.control` | `{ mode: "seq"|"loop"|"random"|"rloop" }` | `{ message }` |
| POST | `/seek` | `player.control` | `{ position: 秒 }` | `{ message, seekOffset }` |
| POST | `/play-at` | `player.control` | `{ index: 队列下标 }` | `{ message }`,越界 400 |

### 状态与队列

| 方法 | 路径 | 返回 |
|------|------|------|
| GET | `/queue` | `{ queue: QueuedSong[], status: BotStatus }` |
| GET | `/elapsed` | `{ elapsed: 42.5 }` |
| DELETE | `/queue/:index` | `{ message }`(移除指定下标,能力 `player.queue`) |
| GET | `/history?limit=50` | `{ history: [{ rowId, id, name, artist, album, coverUrl, platform, playedAt, requestedBy }] }` |
| DELETE | `/history/:rowId` | `{ deleted }`(删除单条记录,能力 `player.queue`) |
| DELETE | `/history` | `{ deleted }`(请求体 `{ ids: number[] }` 批量删除或 `{ all: true }` 清空,能力 `player.queue`) |
| GET | `/profile` | ProfileConfig |
| PUT | `/profile` | ProfileConfig(能力 `bot.manage`) |

ProfileConfig:`{ avatarEnabled, descriptionEnabled, nicknameEnabled, awayStatusEnabled, channelDescEnabled, nowPlayingMsgEnabled }`(机器人头像/昵称/频道描述等自动更新开关)。

---

## 音乐数据 /api/music

除特别标注外均为「已认证」;`platform` 为可选 query 参数。

| 方法 | 路径 | 参数 | 返回 |
|------|------|------|------|
| GET | `/search` | `q`(必填)、`platform`、`limit`(默认 20)、`offset`(默认 0) | `{ songs, albums, playlists }` |
| GET | `/search/all` | `q`(必填)、`limit` | 各音源合并的 `{ songs, albums, playlists }`(不含 spotify) |
| GET | `/song/:id` | `platform` | Song 对象,无则 404 |
| GET | `/album/:id` | `platform` | `{ songs: Song[] }` |
| GET | `/playlist/:id` | `platform` | `{ songs: Song[] }` |
| GET | `/playlist/:id/detail` | `platform` | `{ playlist: { id, name, description, coverUrl, songCount } }`(音源不支持时 501) |
| GET | `/lyrics/:id` | `platform` | `{ lyrics }` |
| GET | `/recommend/playlists` | `platform` | `{ playlists }` |
| GET | `/recommend/songs` | `platform` | `{ songs }`(每日推荐;非游客) |
| GET | `/personal/fm` | `platform` | `{ songs }`(私人 FM;非游客) |
| GET | `/user/playlists` | `platform` | `{ playlists }`(当前登录音源账号的歌单;非游客) |
| GET | `/bilibili/popular` | `limit`(默认 20) | `{ songs }` |
| GET | `/bilibili/parts` | `bvid`(BV 号或视频链接) | `{ bvid, title, coverUrl, artist, parts }`(无此视频 404) |
| GET | `/providers` | — | `{ enabled: Platform[], default: Platform }` |
| GET | `/quality` | — | `{ netease, qq, bilibili, local, kugou, spotify, jellyfin }` |
| POST | `/quality` | `{ quality, platform? }`(能力 `quality`;省略 platform 时对所有音源生效) | `{ success, quality }` |

### Jellyfin 音乐库

| 方法 | 路径 | 参数 | 返回 |
|------|------|------|------|
| GET | `/jellyfin/latest-albums` | `limit`(默认 12) | `{ albums }` |
| GET | `/jellyfin/most-played` | `limit`(默认 12) | `{ songs }` |
| GET | `/jellyfin/favorites` | `limit`(默认 100) | `{ songs }`(非游客) |
| GET | `/jellyfin/genres` | `limit`(默认 30) | `{ genres: [{ id, name }] }` |
| GET | `/jellyfin/genre/:id/songs` | `limit`(默认 100) | `{ songs }` |

### 本地音频上传

`POST /api/music/local/upload` — 能力 `player.queue`。请求体为**原始音频文件**(audio/* 或 video/*,≤500MB,非 multipart;文件名放 `x-filename` 请求头)。返回 `{ song }`;本地音频关闭时 403。

```bash
curl -X POST -H "X-API-Key: $KEY" -H "x-filename: theme.mp3" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @theme.mp3 http://127.0.0.1:3000/api/music/local/upload
```

---

## 收藏 /api/favorites(非游客,仅本人数据)

| 方法 | 路径 | 参数 | 返回 |
|------|------|------|------|
| GET | `/` | — | `{ favorites: [{ id, platform, playlistId, name, coverUrl, songCount, createdAt }] }` |
| POST | `/` | `{ platform, playlistId, name, coverUrl?, songCount? }` | `{ success: true }`;已收藏 409 |
| GET | `/check` | `platform`、`playlistId` | `{ favorited: bool }` |
| DELETE | `/:id` | 收藏记录 id | `{ success: true }` |

---

## 保存的队列 /api/saved-queues(非游客;需在设置页开启「保存队列」)

所有权:私有为本人,`shared: true` 保存到共享桶;列表返回本人的+共享的;他人私有队列 404。

| 方法 | 路径 | 参数 | 返回 |
|------|------|------|------|
| GET | `/` | — | `{ queues: [{ id, ownerId, name, songCount, createdAt, updatedAt }] }` |
| POST | `/` | `{ botId, name, shared? }`(快照该 bot 当前队列,同名覆盖) | `{ queue }`;队列空 400 |
| POST | `/:id/load` | `{ botId, mode?: "replace"(默认)|"append" }` | `{ ok, loaded, mode }` |
| DELETE | `/:id` | — | `{ ok: true }` |

---

## 平台账号 /api/auth

| 方法 | 路径 | 权限 | 参数 | 返回 |
|------|------|------|------|------|
| GET | `/status` | 非游客 | `platform` | `{ platform, loggedIn, nickname?, avatarUrl? }` |
| POST | `/qrcode` | `platform.auth` | `{ platform }`(netease/qq/bilibili/kugou) | `{ qrUrl, qrImg?(base64 data URL), key }` |
| GET | `/qrcode/status` | 非游客 | `key`、`platform` | `{ status: "waiting"|"scanned"|"confirmed"|"expired" }`;confirmed 自动持久化登录态 |
| POST | `/jellyfin/test` | `platform.auth` | `{ serverUrl?, authMode?, username?, password?, apiKey?, userId? }`(空字段回退已存配置) | `{ ok, serverName?, version?, error? }` |
| POST | `/sms/send` | `platform.auth` | `{ phone }`(网易手机号登录) | `{ success }` |
| POST | `/sms/verify` | `platform.auth` | `{ phone, code }` | `{ success }` |
| POST | `/cookie` | `platform.auth` | `{ platform, cookie }`(不支持 youtube/jellyfin) | `{ success: true }` |

## Spotify /api/spotify(配置 Spotify OAuth 后挂载)

| 方法 | 路径 | 权限 | 返回 |
|------|------|------|------|
| GET | `/login` | `platform.auth` | `{ url }`(accounts.spotify.com 授权页,浏览器打开) |
| GET | `/callback` | — | OAuth 回调,重定向回 WebUI(浏览器流程,脚本无需调用) |
| GET | `/status` | 非游客 | `{ authorized, backend, deviceName, binaryAvailable }` |

---

## 个人音乐账号 /api/me/music(非游客,仅本人数据)

绑定**自己的**网易账号,让 `POST /api/player/:botId/fm` 按个人口味推荐;cookie 只存服务端,任何接口都不会回传。与 `/api/auth` 的机器人共享登录互不影响。

| 方法 | 路径 | 参数 | 返回 |
|------|------|------|------|
| GET | `/netease/status` | — | `{ linked, loggedIn, nickname?, avatarUrl? }` |
| POST | `/netease/qrcode` | — | `{ qrUrl, qrImg?(base64 data URL), key }`(个人绑定专用二维码) |
| GET | `/netease/qrcode/status` | `key` | `{ status: "waiting"|"scanned"|"confirmed"|"expired" }`;confirmed 后自动绑定到当前账户 |
| DELETE | `/netease` | — | `{ ok: true }`(解除绑定) |

---

## API 密钥管理 /api/keys(仅浏览器 session)

API Key **不能直接调用这些密钥管理端点**(403);游客 session 也被拒绝。浏览器登录后调用。管理员 Key 仍保留上文所述的用户管理权限。

| 方法 | 路径 | 参数 | 返回 |
|------|------|------|------|
| GET | `/` | `?all=1`(管理员可看全部,含 username) | `{ keys: [{ id, userId, username?, name, keyPrefix, createdAt, lastUsedAt }] }` |
| POST | `/` | `{ name: "1-64字符" }` | `201 { key: {...}, rawKey: "tsmb_…" }`(明文仅此一次);达上限 409 |
| DELETE | `/:id` | — | `{ success: true }`(仅本人;管理员可删任意) |

---

## 用户管理 /api/users(管理员)

| 方法 | 路径 | 参数 | 返回 |
|------|------|------|------|
| GET | `/` | — | `{ users: [{ id, username, createdAt, role }] }` |
| POST | `/` | `{ username, password(≥8位), role: "admin"|"member" }` | `201 { id, username, role }`;重名 409 |
| DELETE | `/:id` | — | `204`(级联删除其 session 与 API Key) |
| POST | `/:id/reset-password` | `{ newPassword }` | `204`(该用户的 API Key 全部失效,session 按上文密码变更规则处理) |
| PATCH | `/:id/role` | `{ role: "admin"|"member" }` | `204`(不能降级最后一个管理员) |
| GET | `/:id/permissions` | — | `{ capabilities: string[], bots: "all" | string[] }` |
| PUT | `/:id/permissions` | `{ capabilities, bots: "all"|string[] }` | `{ success: true }` |

## 操作审计 /api/audit(管理员)

| 方法 | 路径 | 参数 | 返回 |
|------|------|------|------|
| GET | `/` | `limit`(1-500,默认 100)、`offset`(默认 0) | `{ entries: [{ id, timestamp, actorId, actorUsername, targetUserId, targetUsername, action }] }` |

action 取值:`admin.first_created`、`user.created`、`user.deleted`、`user.password_reset`、`user.password_changed`、`user.role_changed`、`user.permissions_changed`、`api_key.created`、`api_key.deleted`。

## 会话 /api/session(仅浏览器,API Key 不可用)

会话登录本身无法用 API Key 完成:`GET /needs-setup`、`POST /setup`、`POST /login`、`POST /guest`、`POST /logout`、`GET /me`、`POST /change-password` 均基于 cookie。`/login` 有每 IP 每分钟 5 次、`/setup` 3 次的限流。
