import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  MusicProvider,
  Song,
  Playlist,
  LyricLine,
  SearchResult,
  QrCodeResult,
  AuthStatus,
} from "./provider.js";

const execFileAsync = promisify(execFile);

/**
 * YouTube music provider using yt-dlp for search and audio URL extraction.
 *
 * Requirements: yt-dlp must be installed and available in PATH.
 *   Install: pip install yt-dlp   OR   brew install yt-dlp
 */
export class YouTubeProvider implements MusicProvider {
  readonly platform = "youtube" as const;
  private quality = "high";
  private cookie = "";

  setQuality(quality: string): void {
    this.quality = quality;
  }

  getQuality(): string {
    return this.quality;
  }

  async search(query: string, limit = 20): Promise<SearchResult> {
    try {
      const { stdout } = await execFileAsync("yt-dlp", [
        `ytsearch${limit}:${query}`,
        "--dump-json",
        "--flat-playlist",
        "--no-warnings",
        "--default-search", "ytsearch",
      ], { timeout: 30000, maxBuffer: 10 * 1024 * 1024 });

      const songs: Song[] = [];
      // yt-dlp outputs one JSON object per line for flat-playlist
      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;
        try {
          const item = JSON.parse(line);
          songs.push({
            id: item.id ?? item.url ?? "",
            name: item.title ?? "Unknown",
            artist: item.uploader ?? item.channel ?? "Unknown",
            album: "",
            duration: item.duration ?? 0,
            coverUrl: this.getBestThumbnail(item),
            platform: "youtube" as const,
          });
        } catch {
          // skip malformed JSON lines
        }
      }

      return { songs, playlists: [], albums: [] };
    } catch {
      return { songs: [], playlists: [], albums: [] };
    }
  }

  async getSongUrl(songId: string, _quality?: string): Promise<string | null> {
    try {
      const videoUrl = songId.startsWith("http")
        ? songId
        : `https://www.youtube.com/watch?v=${songId}`;

      const { stdout } = await execFileAsync("yt-dlp", [
        videoUrl,
        "-f", "bestaudio",
        "-g",             // print URL only
        "--no-warnings",
        "--no-playlist",
      ], { timeout: 30000 });

      const url = stdout.trim().split("\n")[0];
      return url || null;
    } catch {
      return null;
    }
  }

  async getSongDetail(songId: string): Promise<Song | null> {
    try {
      const videoUrl = songId.startsWith("http")
        ? songId
        : `https://www.youtube.com/watch?v=${songId}`;

      const { stdout } = await execFileAsync("yt-dlp", [
        videoUrl,
        "--dump-json",
        "--no-warnings",
        "--no-playlist",
      ], { timeout: 30000 });

      const item = JSON.parse(stdout.trim());
      return {
        id: item.id ?? songId,
        name: item.title ?? "Unknown",
        artist: item.uploader ?? item.channel ?? "Unknown",
        album: "",
        duration: item.duration ?? 0,
        coverUrl: this.getBestThumbnail(item),
        platform: "youtube" as const,
      };
    } catch {
      return null;
    }
  }

  async getPlaylistSongs(playlistId: string): Promise<Song[]> {
    try {
      const playlistUrl = playlistId.startsWith("http")
        ? playlistId
        : `https://www.youtube.com/playlist?list=${playlistId}`;

      const { stdout } = await execFileAsync("yt-dlp", [
        playlistUrl,
        "--dump-json",
        "--flat-playlist",
        "--no-warnings",
      ], { timeout: 60000, maxBuffer: 20 * 1024 * 1024 });

      const songs: Song[] = [];
      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;
        try {
          const item = JSON.parse(line);
          songs.push({
            id: item.id ?? item.url ?? "",
            name: item.title ?? "Unknown",
            artist: item.uploader ?? item.channel ?? "Unknown",
            album: "",
            duration: item.duration ?? 0,
            coverUrl: this.getBestThumbnail(item),
            platform: "youtube" as const,
          });
        } catch {
          // skip malformed lines
        }
      }
      return songs;
    } catch {
      return [];
    }
  }

  /** Pick the best available thumbnail URL */
  private getBestThumbnail(item: any): string {
    if (item.thumbnails && item.thumbnails.length > 0) {
      // yt-dlp sorts thumbnails by preference; last is usually best
      return item.thumbnails[item.thumbnails.length - 1].url ?? "";
    }
    if (item.thumbnail) return item.thumbnail;
    // Fallback to standard YouTube thumbnail
    if (item.id) return `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`;
    return "";
  }

  // --- Not applicable for YouTube ---

  async getRecommendPlaylists(): Promise<Playlist[]> {
    return [];
  }

  async getAlbumSongs(_albumId: string): Promise<Song[]> {
    return [];
  }

  async getLyrics(_songId: string): Promise<LyricLine[]> {
    return [];
  }

  async getQrCode(): Promise<QrCodeResult> {
    return { qrUrl: "", key: "" };
  }

  async checkQrCodeStatus(
    _key: string
  ): Promise<"waiting" | "scanned" | "confirmed" | "expired"> {
    return "expired";
  }

  setCookie(cookie: string): void {
    this.cookie = cookie;
  }

  getCookie(): string {
    return this.cookie;
  }

  async getAuthStatus(): Promise<AuthStatus> {
    return { loggedIn: false };
  }
}
