import axios, { type AxiosInstance } from "axios";
import { RISK_CONTROL_CODE, RiskControlError, SongUrlUnavailable } from "./provider.js";
import type { PlayFailure } from "./provider.js";
import type {
  MusicProvider,
  Song,
  SongUrlResult,
  Playlist,
  PlaylistDetail,
  LyricLine,
  SearchResult,
  QrCodeResult,
  AuthStatus,
  Album,
  Artist,
  ArtistDetail,
  ArtistSongPage,
} from "./provider.js";

export function parseLyrics(lrc: string, tlyric?: string): LyricLine[] {
  if (!lrc) return [];

  const parseLine = (
    line: string
  ): { time: number; text: string } | null => {
    const match = line.match(/^\[(\d{2}):(\d{2})\.(\d{2,3})\](.+)$/);
    if (!match) return null;
    const minutes = parseInt(match[1], 10);
    const seconds = parseInt(match[2], 10);
    const ms = parseInt(match[3].padEnd(3, "0"), 10);
    const text = match[4].trim();

    if (/^(作词|作曲|编曲|制作|混音|母带)\s*[:：]/.test(text)) return null;

    return { time: minutes * 60 + seconds + ms / 1000, text };
  };

  const lines: LyricLine[] = [];
  const translationMap = new Map<number, string>();

  if (tlyric) {
    for (const line of tlyric.split("\n")) {
      const parsed = parseLine(line);
      if (parsed) {
        translationMap.set(Math.round(parsed.time * 100), parsed.text);
      }
    }
  }

  for (const line of lrc.split("\n")) {
    const parsed = parseLine(line);
    if (parsed) {
      const timeKey = Math.round(parsed.time * 100);
      lines.push({
        time: parsed.time,
        text: parsed.text,
        translation: translationMap.get(timeKey),
      });
    }
  }

  return lines.sort((a, b) => a.time - b.time);
}

export function mapNeteaseAlbums(raw: any[] | null | undefined): Album[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((a) => ({
    id: String(a.id),
    name: a.name ?? "",
    artist: (a.artists ?? []).map((x: any) => x.name).join(" / "),
    coverUrl: a.picUrl ?? "",
    songCount: a.size ?? 0,
    platform: "netease",
  }));
}

export function mapNeteaseArtists(raw: any[] | null | undefined): Artist[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((a: any) => ({
    id: String(a.id),
    name: a.name ?? "",
    avatarUrl: a.picUrl ?? a.img1v1Url ?? "",
    aliases: (a.alias ?? a.alia ?? []).filter(
      (x: unknown): x is string => typeof x === "string" && x.length > 0
    ),
    songCount: a.musicSize ?? undefined,
    albumCount: a.albumSize ?? undefined,
    platform: "netease",
  }));
}

export function mapNeteaseSongs(raw: any[] | null | undefined): Song[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((s: any) => ({
    id: String(s.id),
    name: s.name,
    artist: (s.ar ?? s.artists ?? []).map((a: any) => a.name).join(" / "),
    album: s.al?.name ?? s.album?.name ?? "",
    duration: Math.round((s.dt ?? s.duration ?? 0) / 1000),
    coverUrl: s.al?.picUrl ?? s.album?.picUrl ?? "",
    platform: "netease",
    // fee: 0=free, 1=VIP, 4=album-only, 8=free low-quality (plays in full, NOT vip)
    vip: s.fee === 1 || s.fee === 4,
  }));
}

/** 解析网易云 freeTrialInfo → 试听秒数；无片段（VIP/免费）返回 undefined。
 *  真实字段 {start,end} 单位秒；容忍 begin/trialBegin 别名 + 毫秒兜底（end>1000）。 */
export function parseNeteaseTrial(item: any): number | undefined {
  const t = item?.freeTrialInfo;
  if (!t || typeof t !== "object") return undefined;
  const start = Number(t.start ?? t.begin ?? t.trialBegin ?? 0);
  const end = Number(t.end ?? t.trialEnd);
  if (!Number.isFinite(end) || end <= start) return undefined;
  const secs = end > 1000 ? (end - start) / 1000 : end - start;
  return Math.round(secs);
}

/**
 * Recognise NetEase's IP risk control inside an axios error. The status alone
 * is not enough — axios reports every 4xx as ERR_BAD_REQUEST — so the body has
 * to be read. See RiskControlError for the measured behaviour.
 */
function riskControlFrom(err: unknown): RiskControlError | null {
  const e = err as {
    response?: { status?: number; data?: { code?: number; message?: string } };
  };
  if (e?.response?.status === 400 && e.response.data?.code === RISK_CONTROL_CODE) {
    return new RiskControlError(e.response.data.message ?? "网络环境风险 (-460)");
  }
  return null;
}

/**
 * Classify a 200-with-no-URL answer.
 *
 * `/song/url/v1` reports "no URL here" for at least four unrelated reasons, and
 * they need different fixes: open a membership, pick another track, drop the
 * quality, or just wait. The response does carry enough to tell them apart
 * (`code`, `fee`, `payed`, `level`), and not reading those fields is exactly
 * why every one of them reached the user as 「区域/版权限制」.
 *
 * Field meanings (NetEase):
 *   fee 0 = free, 1 = VIP, 4 = album-only purchase, 8 = free / low quality
 *   payed 1 = this account already paid for it
 *   code 404 on the item = the id does not resolve to a playable track
 */
export function diagnoseNeteaseMiss(
  songId: string,
  level: string,
  item: Record<string, any> | undefined,
  body: Record<string, any> | undefined,
): PlayFailure {
  const upstream = {
    code: item?.code ?? body?.code,
    fee: item?.fee,
    payed: item?.payed,
    level: item?.level ?? level,
    br: item?.br,
    freeTrial: Boolean(item?.freeTrialInfo),
  };
  const suffix = `（${String(upstream.level)}）`;
  const base = { platform: "netease" as const, songId, upstream };

  if (!item) {
    return {
      ...base,
      code: "unknown",
      message: `音源没有返回该曲目${suffix}`,
    };
  }
  if (upstream.code === 404) {
    return {
      ...base,
      code: "no_copyright",
      message: `无版权或已下架${suffix}`,
    };
  }
  const fee = typeof upstream.fee === "number" ? upstream.fee : -1;
  if ((fee === 1 || fee === 4) && !upstream.payed) {
    return {
      ...base,
      code: "vip_required",
      message: fee === 4 ? `需要购买该专辑${suffix}` : `需要会员${suffix}`,
    };
  }
  // Everything else that has the track but no URL is a per-level restriction:
  // the same id often plays at another level (measured: 192k OK while both
  // 320k and 128k returned null).
  return {
    ...base,
    code: "quality_denied",
    message: `当前音质无播放权限${suffix}`,
  };
}

// NetEase quality levels: standard(128k) higher(192k) exhigh(320k) lossless(flac) hires(hi-res) jyeffect jymaster
export const NETEASE_QUALITY_LEVELS = [
  { value: "standard", label: "标准 (128kbps)", bitrate: 128 },
  { value: "higher", label: "较高 (192kbps)", bitrate: 192 },
  { value: "exhigh", label: "极高 (320kbps)", bitrate: 320 },
  { value: "lossless", label: "无损 (FLAC)", bitrate: 900 },
  { value: "hires", label: "Hi-Res", bitrate: 1500 },
  { value: "jymaster", label: "超清母带", bitrate: 4000 },
] as const;

export class NeteaseProvider implements MusicProvider {
  readonly platform = "netease" as const;
  private api: AxiosInstance;
  private cookie = "";
  private quality = "exhigh";
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
    this.api = axios.create({
      baseURL: baseUrl,
      timeout: 10000,
    });
  }

  setQuality(quality: string): void {
    this.quality = quality;
  }

  getQuality(): string {
    return this.quality;
  }

  private get cookieParams(): Record<string, string> {
    return this.cookie ? { cookie: this.cookie } : {};
  }

  async search(query: string, limit = 20, offset = 0): Promise<SearchResult> {
    // /cloudsearch supports offset for every type. Songs, playlists (type 1000)
    // and albums (type 10) are all limit/offset-driven so the web can page past
    // the first page (playlists/albums were previously hardcoded to limit: 10).
    const [songRes, playlistRes, albumRes, artistRes] = await Promise.all([
      this.api.get("/cloudsearch", {
        params: { keywords: query, type: 1, limit, offset, ...this.cookieParams },
      }),
      this.api.get("/cloudsearch", {
        params: {
          keywords: query,
          type: 1000,
          limit,
          offset,
          ...this.cookieParams,
        },
      }),
      this.api.get("/cloudsearch", {
        params: { keywords: query, type: 10, limit, offset, ...this.cookieParams },
      }),
      this.api.get("/cloudsearch", {
        params: { keywords: query, type: 100, limit, offset, ...this.cookieParams },
      }),
    ]);

    const songs: Song[] = mapNeteaseSongs(songRes.data?.result?.songs);

    const playlists: Playlist[] = (
      playlistRes.data?.result?.playlists ?? []
    ).map((p: any) => ({
      id: String(p.id),
      name: p.name,
      coverUrl: p.coverImgUrl ?? "",
      songCount: p.trackCount ?? 0,
      platform: "netease",
    }));

    const albums = mapNeteaseAlbums(albumRes.data?.result?.albums);

    const artists = mapNeteaseArtists(artistRes.data?.result?.artists);

    return { songs, playlists, albums, artists };
  }

  async getSongUrl(songId: string, quality?: string): Promise<SongUrlResult | null> {
    const level = quality ?? this.quality;
    let res;
    try {
      res = await this.api.get("/song/url/v1", {
        params: { id: songId, level, ...this.cookieParams },
      });
    } catch (err) {
      // -460 arrives as HTTP 400, and left as-is it looks like "this track is
      // unavailable" to every caller. Surface it as its own error type so the
      // retry layer can wait out the risk-control window instead of giving up.
      const risk = riskControlFrom(err);
      if (risk) throw risk;
      throw err;
    }
    const item = res.data?.data?.[0];
    const url = item?.url;
    // A bare `null` here forced every caller to invent an explanation, and the
    // one they invented was 「区域/版权限制」 — wrong for a lapsed membership, for
    // a delisted track, and for a quality the account cannot stream. Throw the
    // reason instead; the retry layer still spends its budget, it just stops
    // lying about why nothing worked.
    if (!url) throw new SongUrlUnavailable(diagnoseNeteaseMiss(songId, level, item, res.data));
    return { url, trialDuration: parseNeteaseTrial(item) };
  }

  /**
   * Levels to fall back to when the configured one returns no URL.
   *
   * NetEase does not offer a continuous quality ladder per track: measured on a
   * real library, a track can be available at "higher" (192k) while BOTH
   * "exhigh" (320k) and "standard" (128k) answer `url: null`. So the caller must
   * sweep every level BELOW the current one instead of assuming "just drop to
   * the cheapest".
   */
  getFallbackQualities(): string[] {
    const order = NETEASE_QUALITY_LEVELS.map((l) => l.value as string);
    const index = order.indexOf(this.quality);
    if (index <= 0) return [];
    // order is low→high, so everything before the current level reversed gives
    // best→worst below it (exhigh → ["higher", "standard"]).
    return order.slice(0, index).reverse();
  }

  async getSongDetail(songId: string): Promise<Song | null> {
    const res = await this.api.get("/song/detail", {
      params: { ids: songId, ...this.cookieParams },
    });
    return mapNeteaseSongs(res.data?.songs)[0] ?? null;
  }

  async getPlaylistSongs(playlistId: string): Promise<Song[]> {
    const res = await this.api.get("/playlist/track/all", {
      params: { id: playlistId, ...this.cookieParams },
    });
    return mapNeteaseSongs(res.data?.songs);
  }

  async getRecommendPlaylists(): Promise<Playlist[]> {
    const res = await this.api.get("/personalized", {
      params: { limit: 10, ...this.cookieParams },
    });
    return (res.data?.result ?? []).map((p: any) => ({
      id: String(p.id),
      name: p.name,
      coverUrl: p.picUrl ?? "",
      songCount: p.trackCount ?? 0,
      platform: "netease",
    }));
  }

  async getAlbumSongs(albumId: string): Promise<Song[]> {
    const res = await this.api.get("/album", {
      params: { id: albumId, ...this.cookieParams },
    });
    return mapNeteaseSongs(res.data?.songs);
  }

  async getArtistDetail(artistId: string): Promise<ArtistDetail | null> {
    // /artists returns { artist, hotSongs }; the hot songs are fetched
    // separately via /artist/songs (order=hot) so the artist page's three
    // upstream calls stay independent of each other.
    const res = await this.api.get("/artists", {
      params: { id: artistId, ...this.cookieParams },
    });
    const a = res.data?.artist;
    if (!a) return null;
    return {
      ...mapNeteaseArtists([a])[0],
      description: a.briefDesc ?? "",
    };
  }

  async getArtistSongs(artistId: string, limit = 50): Promise<Song[]> {
    const res = await this.api.get("/artist/songs", {
      params: {
        id: artistId,
        limit,
        offset: 0,
        order: "hot",
        ...this.cookieParams,
      },
    });
    return mapNeteaseSongs(res.data?.songs);
  }

  async getArtistAlbums(artistId: string, limit = 20): Promise<Album[]> {
    const res = await this.api.get("/artist/album", {
      params: { id: artistId, limit, offset: 0, ...this.cookieParams },
    });
    return mapNeteaseAlbums(res.data?.hotAlbums);
  }

  /**
   * Full catalogue page for the artist page's "全部歌曲" list: /artist/songs
   * supports real offset paging (Adele reports total 345 with more=true, and
   * offset=50/100/150 each return a fresh slice of 50). order=hot keeps the page
   * ordering identical to getArtistSongs so the hot preview and the full list
   * are one continuous ranking.
   */
  async getArtistAllSongs(artistId: string, offset = 0, limit = 50): Promise<ArtistSongPage> {
    const safeOffset = Math.max(0, Math.trunc(offset) || 0);
    const safeLimit = Math.max(1, Math.min(Math.trunc(limit) || 50, 100));
    const res = await this.api.get("/artist/songs", {
      params: {
        id: artistId,
        limit: safeLimit,
        offset: safeOffset,
        order: "hot",
        ...this.cookieParams,
      },
    });
    const songs = mapNeteaseSongs(res.data?.songs);
    const reported = Number(res.data?.total);
    const total = Number.isFinite(reported) && reported > 0 ? reported : safeOffset + songs.length;
    const more = res.data?.more;
    const hasMore =
      typeof more === "boolean" ? more : safeOffset + songs.length < total;
    return { songs, total, hasMore };
  }

  async getLyrics(songId: string): Promise<LyricLine[]> {
    const res = await this.api.get("/lyric", {
      params: { id: songId, ...this.cookieParams },
    });
    return parseLyrics(
      res.data?.lrc?.lyric ?? "",
      res.data?.tlyric?.lyric
    );
  }

  async getQrCode(): Promise<QrCodeResult> {
    const keyRes = await this.api.get("/login/qr/key", {
      params: { timestamp: Date.now() },
    });
    const key = keyRes.data?.data?.unikey ?? "";
    const createRes = await this.api.get("/login/qr/create", {
      params: { key, qrimg: true },
    });
    return {
      qrUrl: createRes.data?.data?.qrurl ?? "",
      qrImg: createRes.data?.data?.qrimg ?? "",
      key,
    };
  }

  async checkQrCodeStatus(
    key: string
  ): Promise<"waiting" | "scanned" | "confirmed" | "expired"> {
    const { status, cookie } = await this.pollQrLogin(key);
    if (cookie) this.cookie = cookie;
    return status;
  }

  /**
   * Poll a QR login and hand back the resulting cookie WITHOUT storing it on
   * this provider — for a web user linking their own account (#164), which
   * must never replace the bot's shared login.
   */
  async pollQrLogin(
    key: string
  ): Promise<{ status: "waiting" | "scanned" | "confirmed" | "expired"; cookie?: string }> {
    const res = await this.api.get("/login/qr/check", {
      params: { key, timestamp: Date.now() },
    });
    switch (res.data?.code) {
      case 801:
        return { status: "waiting" };
      case 802:
        return { status: "scanned" };
      case 803:
        return res.data?.cookie
          ? { status: "confirmed", cookie: res.data.cookie }
          : { status: "confirmed" };
      default:
        return { status: "expired" };
    }
  }

  /**
   * A provider for the same API server logged in as another account (#164):
   * a web user's personal FM uses their own taste instead of the shared login.
   */
  withCookie(cookie: string): NeteaseProvider {
    const view = new NeteaseProvider(this.baseUrl);
    view.setQuality(this.quality);
    view.setCookie(cookie);
    return view;
  }

  async sendSmsCode(phone: string): Promise<boolean> {
    const res = await this.api.get("/captcha/sent", {
      params: { phone },
    });
    return res.data?.code === 200;
  }

  async loginWithSms(phone: string, code: string): Promise<boolean> {
    const res = await this.api.get("/captcha/verify", {
      params: { phone, captcha: code },
    });
    if (res.data?.cookie) {
      this.cookie = res.data.cookie;
    }
    return res.data?.code === 200;
  }

  setCookie(cookie: string): void {
    this.cookie = cookie;
  }

  getCookie(): string {
    return this.cookie;
  }

  async getAuthStatus(): Promise<AuthStatus> {
    if (!this.cookie) return { loggedIn: false };
    try {
      const res = await this.api.get("/login/status", {
        params: { ...this.cookieParams },
      });
      const profile = res.data?.data?.profile;
      if (profile) {
        return {
          loggedIn: true,
          nickname: profile.nickname,
          avatarUrl: profile.avatarUrl,
        };
      }
    } catch {
      // ignore
    }
    return { loggedIn: false };
  }

  async getPersonalFm(): Promise<Song[]> {
    const res = await this.api.get("/personal_fm", {
      params: { ...this.cookieParams },
    });
    return mapNeteaseSongs(res.data?.data);
  }

  async getDailyRecommendSongs(): Promise<Song[]> {
    const res = await this.api.get("/recommend/songs", {
      params: { ...this.cookieParams },
    });
    return mapNeteaseSongs(res.data?.data?.dailySongs);
  }

  async getPlaylistDetail(playlistId: string): Promise<PlaylistDetail | null> {
    const res = await this.api.get("/playlist/detail", {
      params: { id: playlistId, ...this.cookieParams },
    });
    const p = res.data?.playlist;
    if (!p) return null;
    return {
      id: String(p.id),
      name: p.name ?? "",
      description: p.description ?? "",
      coverUrl: p.coverImgUrl ?? "",
      songCount: p.trackCount ?? 0,
    };
  }

  async getUserPlaylists(): Promise<Playlist[]> {
    // First get user ID from login status
    const statusRes = await this.api.get("/login/status", {
      params: { ...this.cookieParams },
    });
    const uid = statusRes.data?.data?.profile?.userId;
    if (!uid) return [];

    const res = await this.api.get("/user/playlist", {
      params: { uid, ...this.cookieParams },
    });
    return (res.data?.playlist ?? []).map((p: any) => ({
      id: String(p.id),
      name: p.name,
      coverUrl: p.coverImgUrl ?? "",
      songCount: p.trackCount ?? 0,
      platform: "netease",
    }));
  }
}
