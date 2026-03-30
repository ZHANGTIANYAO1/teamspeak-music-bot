import axios, { type AxiosInstance } from "axios";
import type {
  MusicProvider,
  Song,
  Playlist,
  LyricLine,
  SearchResult,
  QrCodeResult,
  AuthStatus,
} from "./provider.js";

const BILIBILI_HEADERS = {
  Referer: "https://www.bilibili.com",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

export class BiliBiliProvider implements MusicProvider {
  readonly platform = "bilibili" as const;
  private api: AxiosInstance;
  private passportApi: AxiosInstance;
  private cookie = "";
  private quality = "high";
  private cidCache = new Map<string, number>();
  private buvidCookie = ""; // anonymous session cookie (buvid3) for anti-412
  private buvidInitialized = false;

  constructor() {
    this.api = axios.create({
      baseURL: "https://api.bilibili.com",
      timeout: 15000,
      headers: BILIBILI_HEADERS,
    });
    this.passportApi = axios.create({
      baseURL: "https://passport.bilibili.com",
      timeout: 15000,
      headers: BILIBILI_HEADERS,
    });
  }

  /** Fetch buvid3 via SPI API (required by search API to avoid 412) */
  private async ensureBuvidCookie(): Promise<void> {
    if (this.buvidInitialized) return;
    this.buvidInitialized = true;
    try {
      const res = await axios.get(
        "https://api.bilibili.com/x/frontend/finger/spi",
        { headers: BILIBILI_HEADERS, timeout: 10000 }
      );
      const b3 = res.data?.data?.b_3;
      const b4 = res.data?.data?.b_4;
      if (b3) {
        this.buvidCookie = `buvid3=${b3}; buvid4=${b4 ?? ""}`;
      }
    } catch {
      // If it fails, continue without — view/playurl APIs work without buvid
    }
  }

  private get cookieHeaders(): Record<string, string> {
    const combined = [this.buvidCookie, this.cookie].filter(Boolean).join("; ");
    return combined ? { Cookie: combined } : {};
  }

  setQuality(quality: string): void {
    this.quality = quality;
  }

  getQuality(): string {
    return this.quality;
  }

  /** Strip HTML tags from BiliBili search results */
  private stripHtml(str: string): string {
    return str.replace(/<[^>]+>/g, "");
  }

  /** Normalize B站 cover URL: fix protocol, add square crop via CDN param */
  private normalizeCover(url: string): string {
    if (!url) return "";
    let fixed = url;
    if (fixed.startsWith("//")) fixed = `https:${fixed}`;
    else if (fixed.startsWith("http://")) fixed = fixed.replace("http://", "https://");
    // B站 CDN supports @{w}w_{h}h_1c for center crop
    // Append square crop if no @ params exist
    if (!fixed.includes("@") && (fixed.includes("hdslb.com") || fixed.includes("bilibili.com"))) {
      fixed += "@300w_300h_1c";
    }
    return fixed;
  }

  async search(query: string, limit = 20): Promise<SearchResult> {
    await this.ensureBuvidCookie();
    const res = await this.api.get("/x/web-interface/search/type", {
      params: {
        search_type: "video",
        keyword: query,
        page_size: limit,
      },
      headers: this.cookieHeaders,
    });

    const results = res.data?.data?.result ?? [];
    const songs: Song[] = results.map((v: any) => ({
      id: String(v.bvid),
      name: this.stripHtml(v.title ?? ""),
      artist: v.author ?? "",
      album: "",
      duration: v.duration
        ? typeof v.duration === "string"
          ? this.parseDurationString(v.duration)
          : v.duration
        : 0,
      coverUrl: this.normalizeCover(v.pic ?? ""),
      platform: "bilibili" as const,
    }));

    return { songs, playlists: [], albums: [] };
  }

  /** Parse "MM:SS" duration string to seconds */
  private parseDurationString(dur: string): number {
    const parts = dur.split(":");
    if (parts.length === 2) {
      return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
    }
    return parseInt(dur, 10) || 0;
  }

  async getSongDetail(songId: string): Promise<Song | null> {
    try {
      const res = await this.api.get("/x/web-interface/view", {
        params: { bvid: songId },
        headers: this.cookieHeaders,
      });

      const data = res.data?.data;
      if (!data) return null;

      // Cache cid for later audio URL fetching
      if (data.pages?.[0]?.cid) {
        this.cidCache.set(songId, data.pages[0].cid);
      }

      return {
        id: String(data.bvid),
        name: data.title ?? "",
        artist: data.owner?.name ?? "",
        album: "",
        duration: data.duration ?? 0,
        coverUrl: this.normalizeCover(data.pic ?? ""),
        platform: "bilibili" as const,
      };
    } catch {
      return null;
    }
  }

  /** Get CID for a bvid, using cache when available */
  private async getCid(bvid: string): Promise<number | null> {
    const cached = this.cidCache.get(bvid);
    if (cached) return cached;

    const detail = await this.getSongDetail(bvid);
    if (!detail) return null;
    return this.cidCache.get(bvid) ?? null;
  }

  async getSongUrl(songId: string, _quality?: string): Promise<string | null> {
    const cid = await this.getCid(songId);
    if (!cid) return null;

    try {
      const res = await this.api.get("/x/player/playurl", {
        params: {
          cid,
          bvid: songId,
          fnval: 16, // DASH format
        },
        headers: this.cookieHeaders,
      });

      const audioStreams = res.data?.data?.dash?.audio;
      if (!audioStreams || audioStreams.length === 0) return null;

      // Pick highest bandwidth audio stream
      const best = audioStreams.reduce((a: any, b: any) =>
        (b.bandwidth ?? 0) > (a.bandwidth ?? 0) ? b : a
      );

      return best.baseUrl ?? best.base_url ?? null;
    } catch {
      return null;
    }
  }

  // --- QR Code Login ---

  async getQrCode(): Promise<QrCodeResult> {
    const res = await this.passportApi.get(
      "/x/passport-login/web/qrcode/generate"
    );
    const data = res.data?.data ?? {};
    return {
      qrUrl: data.url ?? "",
      key: data.qrcode_key ?? "",
    };
  }

  async checkQrCodeStatus(
    key: string
  ): Promise<"waiting" | "scanned" | "confirmed" | "expired"> {
    const res = await this.passportApi.get(
      "/x/passport-login/web/qrcode/poll",
      { params: { qrcode_key: key }, headers: this.cookieHeaders }
    );

    const code = res.data?.data?.code;
    switch (code) {
      case 0: {
        // Login success — extract cookie from response headers
        const setCookieHeaders = res.headers["set-cookie"];
        if (setCookieHeaders) {
          this.cookie = setCookieHeaders
            .map((c: string) => c.split(";")[0])
            .join("; ");
        }
        // Also check if cookie is returned in response data
        if (res.data?.data?.url) {
          // BiliBili returns refresh info in the URL, cookie comes from set-cookie headers
        }
        return "confirmed";
      }
      case 86038:
        return "expired";
      case 86090:
        return "scanned";
      case 86101:
      default:
        return "waiting";
    }
  }

  // --- Auth Status ---

  async getAuthStatus(): Promise<AuthStatus> {
    if (!this.cookie) return { loggedIn: false };
    try {
      const res = await this.api.get("/x/web-interface/nav", {
        headers: this.cookieHeaders,
      });
      const data = res.data?.data;
      if (data && data.isLogin) {
        return {
          loggedIn: true,
          nickname: data.uname,
          avatarUrl: data.face,
        };
      }
    } catch {
      // ignore
    }
    return { loggedIn: false };
  }

  setCookie(cookie: string): void {
    this.cookie = cookie;
  }

  getCookie(): string {
    return this.cookie;
  }

  // --- B站推荐内容 ---

  /** 热门视频 (无需登录) */
  async getRecommendPlaylists(): Promise<Playlist[]> {
    // B站没有"歌单"概念，返回空
    return [];
  }

  /** 音乐区排行榜 + 个性化推荐（如果已登录）作为"每日推荐" */
  async getDailyRecommendSongs(): Promise<Song[]> {
    await this.ensureBuvidCookie();
    const songs: Song[] = [];

    // 1. 个性化推荐（带 cookie 效果更好）
    try {
      const res = await this.api.get("/x/web-interface/index/top/rcmd", {
        params: { ps: 10, fresh_type: 3 },
        headers: this.cookieHeaders,
      });
      const items = res.data?.data?.item ?? [];
      for (const v of items) {
        songs.push({
          id: String(v.bvid),
          name: v.title ?? "",
          artist: v.owner?.name ?? "",
          album: "",
          duration: v.duration ?? 0,
          coverUrl: this.normalizeCover(v.pic ?? ""),
          platform: "bilibili" as const,
        });
      }
    } catch {
      // fallback to popular
    }

    // 2. 如果推荐为空，用音乐区排行榜（tid=3）
    if (songs.length === 0) {
      try {
        const res = await this.api.get("/x/web-interface/ranking/v2", {
          params: { rid: 3, type: "all" },
          headers: this.cookieHeaders,
        });
        const list = res.data?.data?.list ?? [];
        for (const v of list.slice(0, 20)) {
          songs.push({
            id: String(v.bvid),
            name: v.title ?? "",
            artist: v.owner?.name ?? "",
            album: "",
            duration: v.duration ?? 0,
            coverUrl: this.normalizeCover(v.pic ?? ""),
            platform: "bilibili" as const,
          });
        }
      } catch {
        // ignore
      }
    }

    return songs;
  }

  /** 热门视频列表 */
  async getPopularVideos(limit = 20): Promise<Song[]> {
    try {
      const res = await this.api.get("/x/web-interface/popular", {
        params: { ps: limit, pn: 1 },
        headers: this.cookieHeaders,
      });
      return (res.data?.data?.list ?? []).map((v: any) => ({
        id: String(v.bvid),
        name: v.title ?? "",
        artist: v.owner?.name ?? "",
        album: "",
        duration: v.duration ?? 0,
        coverUrl: this.normalizeCover(v.pic ?? ""),
        platform: "bilibili" as const,
      }));
    } catch {
      return [];
    }
  }

  // --- 不适用于B站 ---

  async getPlaylistSongs(_playlistId: string): Promise<Song[]> {
    return [];
  }

  async getAlbumSongs(_albumId: string): Promise<Song[]> {
    return [];
  }

  async getLyrics(_songId: string): Promise<LyricLine[]> {
    return [];
  }
}
