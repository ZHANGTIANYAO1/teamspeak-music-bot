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

/**
 * NetEase rate-limits by IP, not by request shape. When it decides the caller's
 * network looks risky it answers **HTTP 400** with
 *
 *   {"code":-460,"message":"检测到您的网络环境存在风险，请稍后再试"}
 *
 * Cloud-host IPs hit this constantly; it clears up on its own after a few
 * seconds. Because it is a 4xx, axios reports `ERR_BAD_REQUEST` — identical to
 * a genuinely malformed request — so the only way to tell them apart is to read
 * the response body. The distinction matters: -460 is worth retrying, a bad
 * request never is.
 *
 * Measured on a live host: the anonymous call `?id=…&level=exhigh` answered
 * 400/-460 every time, while the same call with the account cookie answered 200
 * and returned a full 320k URL. Intermittently, the cookie version is also
 * rejected — which is exactly the "click play five times until it works"
 * behaviour users report.
 */
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
  /** 200 with no URL and nothing that explains why. */
  | "unknown";

export interface PlayFailure {
  platform: string;
  songId: string;
  code: PlayFailureCode;
  /** One short line in the UI's language — safe to render as-is. */
  message: string;
  /** Raw upstream fields (fee / payed / code / level). Logs only, never shown. */
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

/** Build the -460 flavour. Kept here so every provider names it identically. */
export function riskControlFailure(
  platform: string,
  songId: string,
  detail?: string,
): PlayFailure {
  return {
    platform,
    songId,
    code: "risk_control",
    // 「约 5 秒」是有依据的：实测同一 IP 连续请求一般是 -460 几次之后放行，
    // 重试预算也已经只留一次（RISK_CONTROL_BACKOFF_MS）。给一个具体的等待值，
    // 比「请稍后重试」更能让人知道该干嘛。
    message: "被网易云风控拦截（-460），约 5 秒后再试",
    upstream: detail ? { detail } : undefined,
  };
}

/**
 * Normalise anything a failed attempt threw into a `PlayFailure`, so callers
 * never have to pattern-match on error classes themselves.
 *
 * The `unknown` branch truncates the message: axios errors carry the whole
 * request config (including the cookie) and would otherwise put kilobytes into
 * a UI toast and the log.
 */
export function toPlayFailure(platform: string, songId: string, error: unknown): PlayFailure {
  if (error instanceof SongUrlUnavailable) return error.failure;
  if (error instanceof RiskControlError) {
    return riskControlFailure(platform, songId, error.message);
  }
  const raw = error instanceof Error ? error.message : "";
  const short = raw.replace(/\s+/g, " ").trim().slice(0, 120);
  return {
    platform,
    songId,
    code: "unknown",
    message: short ? `解析播放地址失败：${short}` : "解析播放地址失败",
  };
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

export interface MusicProvider {
  readonly platform: Platform;

  search(query: string, limit?: number, offset?: number): Promise<SearchResult>;
  getSongUrl(songId: string, quality?: string): Promise<SongUrlResult | null>;
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
