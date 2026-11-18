/** All music source platforms. Jellyfin ItemIds are GUID strings — never
 *  assume numeric ids when handling a generic Platform. */
export type Platform =
  | "netease"
  | "qq"
  | "bilibili"
  | "youtube"
  | "local"
  | "kugou"
  | "spotify"
  | "jellyfin";

export interface Song {
  id: string;
  name: string;
  artist: string;
  album: string;
  duration: number; // seconds
  coverUrl: string;
  platform: Platform;
  /** VIP / copyright-restricted: non-VIP users can only play a trial fragment
   *  (NetEase fee=1 VIP / fee=4 album-only, or QQ pay.payplay/paytrackprice=1). */
  vip?: boolean;
}

export interface SongWithUrl extends Song {
  url: string;
}

/** getSongUrl 解析结果。trialDuration 缺省 = 完整可播放（VIP 账号 / 免费曲）。 */
export interface SongUrlResult {
  url: string;
  /** 试听片段时长（秒）。VIP/免费曲为 undefined → 调用方回退完整 duration。 */
  trialDuration?: number;
}

/** NetEase upstream risk-control response code. */
export const RISK_CONTROL_CODE = -460;

export class RiskControlError extends Error {
  readonly code: number = RISK_CONTROL_CODE;
  constructor(message: string) {
    super(message);
    this.name = "RiskControlError";
  }
}

/**
 * Why a track could not be turned into a playable URL.
 *
 * Every one of these used to reach the user as the same string —
 * 「无法播放（区域/版权限制）」 — which is why a genuine -460, a lapsed membership
 * and a delisted track were indistinguishable for weeks of debugging. Naming
 * the cause is the whole point of this type.
 */
export type PlayFailureCode =
  /** Upstream refused the caller's IP (-460). Transient by nature. */
  | "risk_control"
  /** Paid track with no entitlement on the account (NetEase fee=1 VIP / fee=4). */
  | "vip_required"
  /** Delisted, region-blocked, or the id no longer resolves (upstream 404). */
  | "no_copyright"
  /** The track exists, but this quality level is not ours to serve. */
  | "quality_denied"
  /** The upstream HTTP request failed or the expected API was unreachable. */
  | "upstream_request_failed"
  /** The music service explicitly asked the user to complete verification. */
  | "provider_verification_required"
  /** 200 with no URL and nothing that explains why. */
  | "unknown";

export interface PlayFailure {
  platform: string;
  songId: string;
  code: PlayFailureCode;
  /** One short line in the UI's language — safe to render as-is. */
  message: string;
  /** Selected non-secret diagnostic fields. Logs only, never shown directly. */
  upstream?: Record<string, unknown>;
}

/**
 * Thrown when a provider knows *why* no URL came back.
 *
 * `resolveUrlWithRetry` still runs the full budget on it — a lower level can
 * genuinely help, and "deterministic" judgements about this API have been wrong
 * before — but it remembers the last one so the eventual message can name the
 * cause instead of falling back to a guess.
 */
export class SongUrlUnavailable extends Error {
  readonly failure: PlayFailure;
  constructor(failure: PlayFailure) {
    super(failure.message);
    this.name = "SongUrlUnavailable";
    this.failure = failure;
  }
}

/** Preserve typed status for troubleshooting without forwarding request or response data. */
export function playbackRequestFailure(
  platform: "qq" | "kugou",
  songId: string,
  error: unknown,
): SongUrlUnavailable {
  const raw = error as { code?: unknown; response?: { status?: unknown } } | null;
  const status = raw?.response?.status;
  const httpStatus = typeof status === "number" && Number.isInteger(status) && status >= 100 && status < 600
    ? status : undefined;
  const name = platform === "qq" ? "QQ 音乐 API" : "酷狗";
  const message = httpStatus ? `${name}播放请求失败（HTTP ${httpStatus}）`
    : raw?.code === "QQ_API_PORT_CONFLICT" && platform === "qq" ? "QQ 音乐 API 端口被其他服务占用，请检查 qqMusicApiPort"
    : raw?.code === "ECONNREFUSED" && platform === "qq" ? "无法连接 QQ 音乐 API，请检查服务启动与端口"
    : raw?.code === "ECONNABORTED" || raw?.code === "ETIMEDOUT" ? `${name}播放请求超时`
    : `${name}播放请求失败，请检查服务与网络连接`;
  return new SongUrlUnavailable({
    platform,
    songId,
    code: "upstream_request_failed",
    message,
    upstream: httpStatus ? { httpStatus } : undefined,
  });
}

export function toPlayFailure(platform: string, songId: string, error: unknown): PlayFailure {
  if (error instanceof SongUrlUnavailable) return error.failure;
  if (error instanceof RiskControlError) {
    return {
      platform,
      songId,
      code: "risk_control",
      message: "网易云暂时拒绝播放请求（-460），请稍后重试",
    };
  }
  return { platform, songId, code: "unknown", message: "解析播放地址失败" };
}

export interface Playlist {
  id: string;
  name: string;
  coverUrl: string;
  songCount: number;
  platform: Platform;
}


export interface PlaylistDetail {
  id: string;
  name: string;
  description: string;
  coverUrl: string;
  songCount: number;
}

export interface Album {
  id: string;
  name: string;
  artist: string;
  coverUrl: string;
  songCount: number;
  platform: Platform;
}

/** An artist / singer entity. Only sources with a real artist concept expose
 *  these (NetEase, QQ); the others simply never return `SearchResult.artists`
 *  and leave the optional provider methods unimplemented. */
export interface Artist {
  id: string;
  name: string;
  avatarUrl: string;
  platform: Platform;
  /** Alternate names / romanizations (NetEase alias, QQ other_name). */
  aliases?: string[];
  songCount?: number;
  albumCount?: number;
}

export interface ArtistDetail extends Artist {
  /** Short biography, when the source provides one. */
  description?: string;
}

/** One page of an artist's COMPLETE catalogue (the "全部歌曲" list), as opposed
 *  to `getArtistSongs`, which only ever returns the hot top-N. */
export interface ArtistSongPage {
  songs: Song[];
  /** Total tracks the source reports for this artist (best effort). */
  total: number;
  hasMore: boolean;
}

export interface LyricLine {
  time: number; // seconds
  text: string;
  translation?: string;
}

export interface SearchResult {
  songs: Song[];
  playlists: Playlist[];
  albums: Album[];
  /** Present only for sources with an artist entity (NetEase, QQ). */
  artists?: Artist[];
}

export interface QrCodeResult {
  qrUrl: string;
  qrImg?: string; // base64 data URL of QR image
  key: string;
}

export interface AuthStatus {
  loggedIn: boolean;
  nickname?: string;
  avatarUrl?: string;
}

export interface SongUrlRequestOptions {
  /** CDN hosts that already failed around this playback position (where supported). */
  avoidHosts?: ReadonlySet<string>;
  /** Resolve after an interruption without reusing a cached playback URL. */
  refresh?: boolean;
}

export interface MusicProvider {
  readonly platform: Platform;

  search(query: string, limit?: number, offset?: number): Promise<SearchResult>;
  getSongUrl(songId: string, quality?: string, options?: SongUrlRequestOptions): Promise<SongUrlResult | null>;
  setQuality(quality: string): void;
  getQuality(): string;
  getSongDetail(songId: string): Promise<Song | null>;
  getPlaylistSongs(playlistId: string): Promise<Song[]>;
  getRecommendPlaylists(): Promise<Playlist[]>;
  getAlbumSongs(albumId: string): Promise<Song[]>;
  getLyrics(songId: string): Promise<LyricLine[]>;
  getQrCode(): Promise<QrCodeResult>;
  checkQrCodeStatus(
    key: string
  ): Promise<"waiting" | "scanned" | "confirmed" | "expired">;
  loginWithSms?(phone: string, code: string): Promise<boolean>;
  sendSmsCode?(phone: string): Promise<boolean>;
  setCookie(cookie: string): void;
  getCookie(): string;
  getAuthStatus(): Promise<AuthStatus>;
  /**
   * Lower quality levels to try when the configured one has no URL, ordered
   * best→worst.
   *
   * NetEase does not publish a uniform ladder: a track can be playable at 192k
   * ("higher") while BOTH 320k ("exhigh") and 128k ("standard") return null —
   * so the list has to contain every level below the current one, not just the
   * cheapest. Sources whose quality is not a user-selectable knob (Bilibili,
   * local files, Jellyfin) omit this and the caller keeps its single attempt.
   */
  getFallbackQualities?(): string[];
  /**
   * A view of this same provider logged in as another account, without
   * disturbing the shared instance. Implemented by the sources that support
   * per-account logins — NetEase since #164, QQ / Kugou / Bilibili following in
   * the #164 follow-up. The rest simply omit it and the web layer falls back to
   * the shared login (see web/api/provider-scope.ts).
   */
  withCookie?(cookie: string): MusicProvider;
  getPersonalFm?(): Promise<Song[]>;
  getDailyRecommendSongs?(): Promise<Song[]>;
  getUserPlaylists?(): Promise<Playlist[]>;
  getPlaylistDetail?(playlistId: string): Promise<PlaylistDetail | null>;
  getArtistDetail?(artistId: string): Promise<ArtistDetail | null>;
  /** The artist's most popular tracks, best-first. */
  getArtistSongs?(artistId: string, limit?: number): Promise<Song[]>;
  /** One page of the artist's full catalogue, best-first. Sources that can only
   *  expose a fixed top-N list leave this unimplemented (the route then 501s and
   *  the web hides the "全部歌曲" section). */
  getArtistAllSongs?(
    artistId: string,
    offset?: number,
    limit?: number
  ): Promise<ArtistSongPage>;
  getArtistAlbums?(artistId: string, limit?: number): Promise<Album[]>;
}
