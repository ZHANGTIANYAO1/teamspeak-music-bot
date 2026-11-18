import { normalizeCookie } from "./cookie-normalize.js";
import { createHash } from "node:crypto";
import axios, { type AxiosInstance } from "axios";
import type {
  MusicProvider,
  Song,
  SongUrlResult,
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

// Permutation used by B站 to derive the wbi mixin key from img_key+sub_key.
const WBI_MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
];

const WBI_KEY_TTL_MS = 6 * 60 * 60 * 1000; // wbi keys rotate ~daily; refresh every 6h

export interface BiliVideoPart {
  part: number;
  cid: number;
  title: string;
  duration: number;
}

export interface BiliVideoPartsResult {
  bvid: string;
  title: string;
  coverUrl: string;
  artist: string;
  parts: BiliVideoPart[];
}

/**
 * PCDN / P2P edge hosts (xy*.mcdn.bilivideo.cn:<port>, *.szbdyd.com). Their
 * sessions get cut mid-file, which kills long streams partway (#89, #161),
 * and a reconnect to the same host rarely recovers.
 */
const BILI_PCDN_HOST = /\.mcdn\.bilivideo\.cn$|\.szbdyd\.com$/i;

/**
 * Pick the audio URL least likely to die mid-stream: the first upos/cos
 * mirror among baseUrl + backupUrl, else the baseUrl as before.
 */
export function pickStableAudioUrl(stream: {
  baseUrl?: string;
  base_url?: string;
  backupUrl?: string[];
  backup_url?: string[];
}): string | undefined {
  const primary = stream.baseUrl ?? stream.base_url;
  const candidates = [primary, ...(stream.backupUrl ?? stream.backup_url ?? [])].filter(
    (u): u is string => typeof u === "string" && u.length > 0,
  );
  const stable = candidates.find((u) => {
    try {
      return !BILI_PCDN_HOST.test(new URL(u).hostname);
    } catch {
      return false;
    }
  });
  return stable ?? primary;
}

/**
 * 解析带有分P信息的 B站 ID 或 URL。
 * 支持形如 "BVxxxx", "BVxxxx?p=2", "BVxxxx:p2" 以及完整 URL 等格式，默认 page 为 1。
 */
export function parseBilibiliId(songId: string): { bvid: string; page: number } {
  const str = (songId ?? "").trim();
  const bvMatch = str.match(/BV[0-9A-Za-z]+/i);
  if (!bvMatch) {
    return { bvid: str, page: 1 };
  }
  const bvid = bvMatch[0];
  const pageMatch = str.match(/[?&]p=(\d+)|:p?(\d+)/i);
  const pageStr = pageMatch ? (pageMatch[1] ?? pageMatch[2]) : undefined;
  const page = pageStr ? parseInt(pageStr, 10) : 1;
  return { bvid, page: Math.max(1, page) };
}

export class BiliBiliProvider implements MusicProvider {
  readonly platform = "bilibili" as const;
  private api: AxiosInstance;
  private passportApi: AxiosInstance;
  private cookie = "";
  private quality = "high";
  private cidCache = new Map<string, number>();
  private buvidCookie = ""; // anonymous session cookie (buvid3) for anti-412
  private buvidInitialized = false;
  private wbiMixinKey = "";
  private wbiKeyFetchedAt = 0;

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

  /**
   * Fetch wbi img_key/sub_key from /x/web-interface/nav and derive the
   * mixin key used to sign search params. Required since B站 moved the
   * search endpoint behind wbi signing — unsigned /search/type now
   * returns an anti-bot HTML page.
   */
  private async ensureWbiKeys(): Promise<void> {
    if (this.wbiMixinKey && Date.now() - this.wbiKeyFetchedAt < WBI_KEY_TTL_MS) {
      return;
    }
    const res = await this.api.get("/x/web-interface/nav", {
      headers: this.cookieHeaders,
      validateStatus: () => true, // nav returns -101 when not logged in but still includes wbi_img
    });
    const wbi = res.data?.data?.wbi_img;
    const imgUrl: string = wbi?.img_url ?? "";
    const subUrl: string = wbi?.sub_url ?? "";
    const imgKey = imgUrl.split("/").pop()?.split(".")[0] ?? "";
    const subKey = subUrl.split("/").pop()?.split(".")[0] ?? "";
    if (!imgKey || !subKey) {
      throw new Error("Bilibili wbi keys unavailable");
    }
    const raw = imgKey + subKey;
    this.wbiMixinKey = WBI_MIXIN_KEY_ENC_TAB.map((i) => raw[i] ?? "")
      .join("")
      .slice(0, 32);
    this.wbiKeyFetchedAt = Date.now();
  }

  /** Sign params for wbi-protected endpoints. Returns a new params object including wts and w_rid. */
  private signWbi(params: Record<string, string | number>): Record<string, string> {
    const withTs: Record<string, string> = {};
    for (const [k, v] of Object.entries(params)) withTs[k] = String(v);
    withTs.wts = String(Math.floor(Date.now() / 1000));
    const sorted = Object.keys(withTs)
      .sort()
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(withTs[k])}`)
      .join("&");
    withTs.w_rid = createHash("md5")
      .update(sorted + this.wbiMixinKey)
      .digest("hex");
    return withTs;
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

  async search(query: string, limit = 20, offset = 0): Promise<SearchResult> {
    await this.ensureBuvidCookie();
    await this.ensureWbiKeys();
    // /search/type is page-based; the web pages in limit-aligned steps so
    // offset is a multiple of page_size.
    const page = Math.floor(offset / limit) + 1;
    const signed = this.signWbi({
      search_type: "video",
      keyword: query,
      page,
      page_size: limit,
    });
    const res = await this.api.get("/x/web-interface/wbi/search/type", {
      params: signed,
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
    const { bvid, page } = parseBilibiliId(songId);
    try {
      const res = await this.api.get("/x/web-interface/view", {
        params: { bvid },
        headers: this.cookieHeaders,
      });

      const data = res.data?.data;
      if (!data) return null;

      const pages = data.pages ?? [];
      // 缓存所有分P的 cid 映射
      for (const p of pages) {
        this.cidCache.set(`${bvid}?p=${p.page}`, p.cid);
      }
      if (pages[0]?.cid) {
        this.cidCache.set(bvid, pages[0].cid);
      }

      const targetPage = pages.find((p: any) => p.page === page) ?? pages[0];

      // 若为多P视频，返回对应分P的名称与独立时长
      if (pages.length > 1 && targetPage) {
        const partTitle = targetPage.part && targetPage.part !== data.title
          ? `${data.title} - P${targetPage.page} ${targetPage.part}`
          : `${data.title} (P${targetPage.page})`;
        return {
          id: `${bvid}?p=${targetPage.page}`,
          name: partTitle,
          artist: data.owner?.name ?? "",
          album: "",
          duration: targetPage.duration ?? 0,
          coverUrl: this.normalizeCover(data.pic ?? ""),
          platform: "bilibili" as const,
        };
      }

      return {
        id: String(data.bvid),
        name: data.title ?? "",
        artist: data.owner?.name ?? "",
        album: "",
        duration: targetPage?.duration ?? data.duration ?? 0,
        coverUrl: this.normalizeCover(data.pic ?? ""),
        platform: "bilibili" as const,
      };
    } catch {
      return null;
    }
  }

  /** 获取视频所有分P列表 */
  async getVideoParts(bvid: string): Promise<BiliVideoPartsResult | null> {
    const { bvid: cleanBvid } = parseBilibiliId(bvid);
    try {
      const res = await this.api.get("/x/web-interface/view", {
        params: { bvid: cleanBvid },
        headers: this.cookieHeaders,
      });

      const data = res.data?.data;
      if (!data) return null;

      const pages = data.pages ?? [];
      for (const p of pages) {
        this.cidCache.set(`${cleanBvid}?p=${p.page}`, p.cid);
      }
      if (pages[0]?.cid) {
        this.cidCache.set(cleanBvid, pages[0].cid);
      }

      return {
        bvid: cleanBvid,
        title: data.title ?? "",
        coverUrl: this.normalizeCover(data.pic ?? ""),
        artist: data.owner?.name ?? "",
        parts: pages.map((p: any) => ({
          part: p.page,
          cid: p.cid,
          title: p.part ?? `P${p.page}`,
          duration: p.duration ?? 0,
        })),
      };
    } catch {
      return null;
    }
  }

  /** Get CID for a bvid, using cache when available */
  private async getCid(bvid: string, page = 1): Promise<number | null> {
    const key = page > 1 ? `${bvid}?p=${page}` : bvid;
    const cached = this.cidCache.get(key) ?? (page === 1 ? this.cidCache.get(`${bvid}?p=1`) : undefined);
    if (cached) return cached;

    // Limit cache size to prevent unbounded growth
    if (this.cidCache.size > 500) {
      const firstKey = this.cidCache.keys().next().value;
      if (firstKey) this.cidCache.delete(firstKey);
    }

    const songId = page > 1 ? `${bvid}?p=${page}` : bvid;
    const detail = await this.getSongDetail(songId);
    if (!detail) return null;
    return this.cidCache.get(key) ?? this.cidCache.get(`${bvid}?p=${page}`) ?? this.cidCache.get(bvid) ?? null;
  }

  async getSongUrl(songId: string, _quality?: string): Promise<SongUrlResult | null> {
    const { bvid, page } = parseBilibiliId(songId);
    const cid = await this.getCid(bvid, page);
    if (!cid) return null;

    try {
      const res = await this.api.get("/x/player/playurl", {
        params: {
          cid,
          bvid,
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

      const biliUrl = pickStableAudioUrl(best);
      return biliUrl ? { url: biliUrl } : null;
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
    this.cookie = normalizeCookie(cookie);
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
