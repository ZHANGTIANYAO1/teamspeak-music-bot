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

export interface LyricLine {
  time: number; // seconds
  text: string;
  translation?: string;
}

export interface SearchResult {
  songs: Song[];
  playlists: Playlist[];
  albums: Album[];
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
  getPersonalFm?(): Promise<Song[]>;
  getDailyRecommendSongs?(): Promise<Song[]>;
  getUserPlaylists?(): Promise<Playlist[]>;
  getPlaylistDetail?(playlistId: string): Promise<PlaylistDetail | null>;
}
