export interface Song {
  id: string;
  name: string;
  artist: string;
  album: string;
  duration: number; // seconds
  coverUrl: string;
  platform: "netease" | "qq" | "bilibili" | "youtube";
}

export interface SongWithUrl extends Song {
  url: string;
}

export interface Playlist {
  id: string;
  name: string;
  coverUrl: string;
  songCount: number;
  platform: "netease" | "qq" | "bilibili" | "youtube";
}

export interface Album {
  id: string;
  name: string;
  artist: string;
  coverUrl: string;
  songCount: number;
  platform: "netease" | "qq" | "bilibili" | "youtube";
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
  readonly platform: "netease" | "qq" | "bilibili" | "youtube";

  search(query: string, limit?: number): Promise<SearchResult>;
  getSongUrl(songId: string, quality?: string): Promise<string | null>;
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
}
