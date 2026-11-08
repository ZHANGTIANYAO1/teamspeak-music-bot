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
