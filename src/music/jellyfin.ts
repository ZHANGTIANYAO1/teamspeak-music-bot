import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import axios, { type AxiosError, type AxiosInstance } from "axios";
import type { JellyfinConfig } from "../data/config.js";
import type { Logger } from "../logger.js";
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
} from "./provider.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 1 tick = 100 ns → 10,000,000 ticks = 1 second (Jellyfin RunTimeTicks / lyric Start). */
export const TICKS_PER_SECOND = 10_000_000;

export function ticksToSeconds(ticks: number | null | undefined): number {
  if (typeof ticks !== "number" || !Number.isFinite(ticks)) return 0;
  return ticks / TICKS_PER_SECOND;
}

const CLIENT_NAME = "TSMusicBot";

/** Best-effort package version for the MediaBrowser auth header. */
const PKG_VERSION = (() => {
  try {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, "..", "..", "package.json"), "utf-8"),
    ) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

// Jellyfin quality tiers replace the NetEase labels for this source. "direct"
// (default) streams the original file — the bot re-encodes to Opus anyway, so
// this is max quality. The transcode tiers exist for remote/low-bandwidth
// Jellyfin servers.
export const JELLYFIN_QUALITY_LEVELS = [
  { value: "direct", label: "原始直传 Direct", bitrate: 0 },
  { value: "320", label: "320kbps 转码", bitrate: 320 },
  { value: "192", label: "192kbps 转码", bitrate: 192 },
  { value: "128", label: "128kbps 转码", bitrate: 128 },
] as const;

/** Subset of Jellyfin's BaseItemDto that this provider consumes. */
export interface JellyfinItem {
  Id: string;
  Name?: string;
  Artists?: string[];
  AlbumArtist?: string;
  Album?: string;
  AlbumId?: string;
  AlbumPrimaryImageTag?: string;
  RunTimeTicks?: number;
  ImageTags?: { Primary?: string };
  ChildCount?: number;
  SongCount?: number;
  Overview?: string;
}

/**
 * Primary cover art URL for an item; falls back to the parent album's primary
 * image (AlbumPrimaryImageTag) and finally to "" (the UI renders a placeholder
 * for missing art). The api_key query param authenticates browser <img> loads
 * and the TS-avatar download alike.
 */
export function buildCoverUrl(baseUrl: string, apiKey: string, item: JellyfinItem): string {
  if (!baseUrl) return "";
  const key = apiKey ? `&api_key=${encodeURIComponent(apiKey)}` : "";
  if (item.ImageTags?.Primary) {
    return `${baseUrl}/Items/${item.Id}/Images/Primary?maxWidth=512&tag=${item.ImageTags.Primary}${key}`;
  }
  if (item.AlbumId && item.AlbumPrimaryImageTag) {
    return `${baseUrl}/Items/${item.AlbumId}/Images/Primary?maxWidth=512&tag=${item.AlbumPrimaryImageTag}${key}`;
  }
  return "";
}

/** Direct (untranscoded) stream URL — the default playback path. */
export function buildStreamUrl(baseUrl: string, apiKey: string, itemId: string): string {
  const params = new URLSearchParams({ static: "true", api_key: apiKey });
  return `${baseUrl}/Audio/${itemId}/stream?${params.toString()}`;
}

/** Server-side transcode URL for the 320/192/128 kbps tiers. */
export function buildUniversalUrl(
  baseUrl: string,
  o: { apiKey: string; userId: string; deviceId: string; itemId: string; kbps: number },
): string {
  const params = new URLSearchParams({
    userId: o.userId,
    deviceId: o.deviceId,
    api_key: o.apiKey,
    maxStreamingBitrate: String(o.kbps * 1000),
    container: "mp3,aac,m4a|aac,flac,webma,webm,wav,ogg",
    transcodingContainer: "mp3",
    transcodingProtocol: "http",
  });
  return `${baseUrl}/Audio/${o.itemId}/universal?${params.toString()}`;
}

export function mapJellyfinSong(item: JellyfinItem, coverUrl: string): Song {
  return {
    id: String(item.Id),
    name: item.Name ?? "",
    artist: (item.Artists?.length ? item.Artists : [item.AlbumArtist ?? ""])
      .filter(Boolean)
      .join(" / "),
    album: item.Album ?? "",
    duration: Math.round(ticksToSeconds(item.RunTimeTicks)),
    coverUrl,
    platform: "jellyfin",
  };
}

export function mapJellyfinAlbum(item: JellyfinItem, coverUrl: string): Album {
  return {
    id: String(item.Id),
    name: item.Name ?? "",
    artist: item.AlbumArtist ?? (item.Artists ?? []).join(" / "),
    coverUrl,
    songCount: item.ChildCount ?? item.SongCount ?? 0,
    platform: "jellyfin",
  };
}

export function mapJellyfinPlaylist(item: JellyfinItem, coverUrl: string): Playlist {
  return {
    id: String(item.Id),
    name: item.Name ?? "",
    coverUrl,
    songCount: item.ChildCount ?? item.SongCount ?? 0,
    platform: "jellyfin",
  };
}

/**
 * Map `GET /Audio/{id}/Lyrics` → the bot's synced-lyric format. `Start` is in
 * ticks; entries without Start (plain-text lyrics) collapse to time 0 so the
 * lyric view still renders them, just without sync. Translation stays empty —
 * Jellyfin has no translated-lyrics concept.
 */
export function mapJellyfinLyrics(payload: unknown): LyricLine[] {
  const lyrics = (payload as { Lyrics?: { Text?: string; Start?: number }[] })?.Lyrics;
  if (!Array.isArray(lyrics)) return [];
  return lyrics
    .filter((l) => typeof l?.Text === "string" && l.Text.trim() !== "")
    .map((l) => ({ time: ticksToSeconds(l.Start), text: l.Text!.trim() }))
    .sort((a, b) => a.time - b.time);
}

/** Operator-friendly connection/auth error description (test-connection UI + logs). */
export function describeJellyfinError(err: unknown): string {
  const e = err as AxiosError;
  if (e?.response) {
    const s = e.response.status;
    if (s === 401) return "认证失败：用户名/密码或 API Key 不正确 (401 Unauthorized)";
    if (s === 403) return "该账号没有访问权限 (403 Forbidden)";
    if (s === 404) return "接口不存在——请确认地址指向 Jellyfin 根路径 (404 Not Found)";
    return `Jellyfin 返回 HTTP ${s}`;
  }
  const code = (e as { code?: string })?.code;
  if (code === "ECONNREFUSED") return "无法连接 Jellyfin 服务器 (connection refused)";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "无法解析服务器地址 (DNS lookup failed)";
  if (code === "ETIMEDOUT" || code === "ECONNABORTED") return "连接 Jellyfin 超时 (timeout)";
  return (err as Error)?.message ?? String(err);
}

/**
 * Per-bot playback reporting handle. One playback session (PlaySessionId) per
 * track start; the previous session is closed with its last known position so
 * Jellyfin's played/PlayCount bookkeeping sees natural track ends as ~complete
 * plays and mid-track skips as partial ones. Every call is fire-and-forget —
 * reporting must never affect playback.
 */
export interface JellyfinPlaybackReporter {
  onTrackStart(itemId: string): void;
  onTick(itemId: string, positionSec: number, paused: boolean): void;
  onStop(): void;
}

interface PersistedAuth {
  accessToken?: string;
  userId?: string;
  deviceId?: string;
}

function emptyConfig(): JellyfinConfig {
  return { serverUrl: "", authMode: "userpass", username: "", password: "", apiKey: "", userId: "" };
}

export class JellyfinProvider implements MusicProvider {
  readonly platform = "jellyfin" as const;
  private api: AxiosInstance;
  private cfg: JellyfinConfig = emptyConfig();
  private token = "";
  private userId = "";
  private deviceId = "";
  private quality: string = "direct";
  private loginPromise: Promise<void> | null = null;
  private persistFn: ((serialized: string) => void) | null = null;
  private logger: Logger | null = null;

  constructor(logger?: Logger) {
    this.api = axios.create({ timeout: 10000 });
    this.logger = logger ?? null;
  }

  /**
   * Apply (or re-apply, on settings save) the admin-configured connection.
   * Changing any credential-relevant field drops the cached token so the next
   * request re-authenticates; the stable deviceId survives reconfiguration.
   */
  configure(cfg: JellyfinConfig): void {
    const prev = this.cfg;
    this.cfg = { ...cfg, serverUrl: (cfg.serverUrl ?? "").trim().replace(/\/+$/, "") };
    const credsChanged =
      prev.serverUrl !== this.cfg.serverUrl ||
      prev.authMode !== this.cfg.authMode ||
      prev.username !== this.cfg.username ||
      prev.password !== this.cfg.password ||
      prev.apiKey !== this.cfg.apiKey ||
      prev.userId !== this.cfg.userId;
    if (credsChanged) {
      this.token = "";
      this.userId = "";
    }
  }

  isConfigured(): boolean {
    return this.cfg.serverUrl.length > 0;
  }

  /** Wire the on-disk persistence used after a successful login (cookie store). */
  setPersist(fn: (serialized: string) => void): void {
    this.persistFn = fn;
  }

  setQuality(quality: string): void {
    // Ignore foreign values: the legacy platform-less POST /api/music/quality
    // broadcasts NetEase levels to every provider, which must not clobber the
    // jellyfin default ("direct").
    if (JELLYFIN_QUALITY_LEVELS.some((l) => l.value === quality)) {
      this.quality = quality;
    }
  }

  getQuality(): string {
    return this.quality;
  }

  // --- Auth ---

  private authHeader(): string {
    return (
      `MediaBrowser Client="${CLIENT_NAME}", Device="${CLIENT_NAME}", ` +
      `DeviceId="${this.deviceId}", Version="${PKG_VERSION}"`
    );
  }

  private ensureDeviceId(): void {
    if (!this.deviceId) {
      this.deviceId = crypto.randomUUID();
      this.persistState();
    }
  }

  private persistState(): void {
    try {
      this.persistFn?.(this.getCookie());
    } catch (err) {
      this.logger?.warn({ err }, "Failed to persist Jellyfin auth state");
    }
  }

  private async login(): Promise<void> {
    this.ensureDeviceId();
    const res = await this.api.post(
      `${this.cfg.serverUrl}/Users/AuthenticateByName`,
      { Username: this.cfg.username, Pw: this.cfg.password },
      { headers: { Authorization: this.authHeader() } },
    );
    const token = res.data?.AccessToken as string | undefined;
    const userId = res.data?.User?.Id as string | undefined;
    if (!token || !userId) {
      throw new Error("Jellyfin 登录响应缺少 AccessToken/User.Id");
    }
    this.token = token;
    this.userId = userId;
    this.persistState();
    this.logger?.info({ userId }, "Jellyfin authenticated");
  }

  private async ensureAuth(): Promise<void> {
    if (!this.cfg.serverUrl) {
      throw new Error("Jellyfin 未配置服务器地址 (server URL not configured)");
    }
    if (this.cfg.authMode === "apikey") {
      if (!this.cfg.apiKey || !this.cfg.userId) {
        throw new Error("Jellyfin API Key 模式需要 apiKey 和 userId");
      }
      this.token = this.cfg.apiKey;
      this.userId = this.cfg.userId;
      this.ensureDeviceId();
      return;
    }
    if (this.token && this.userId) return;
    if (!this.cfg.username) {
      throw new Error("Jellyfin 未配置用户名/密码 (username not configured)");
    }
    if (!this.loginPromise) {
      this.loginPromise = this.login().finally(() => {
        this.loginPromise = null;
      });
    }
    return this.loginPromise;
  }

  /** Authenticated request with a single re-auth retry on 401 (userpass mode). */
  private async request<T = unknown>(
    method: "get" | "post",
    path: string,
    opts: { params?: Record<string, unknown>; data?: unknown; retried?: boolean } = {},
  ): Promise<T> {
    await this.ensureAuth();
    // Callers snapshot `userId: this.userId` while building params, which is
    // still empty before the first login. ensureAuth() has populated it by
    // now, so backfill the stale-empty snapshot instead of sending userId="".
    const params = opts.params ? { ...opts.params } : undefined;
    if (params && "userId" in params && !params.userId) params.userId = this.userId;
    try {
      const res = await this.api.request<T>({
        method,
        url: this.cfg.serverUrl + path,
        params,
        data: opts.data,
        headers: { "X-Emby-Token": this.token },
      });
      return res.data;
    } catch (err) {
      const status = (err as AxiosError).response?.status;
      if (status === 401 && this.cfg.authMode === "userpass" && !opts.retried) {
        this.token = "";
        this.userId = "";
        return this.request(method, path, { ...opts, retried: true });
      }
      throw err;
    }
  }

  // --- MusicProvider ---

  private coverFor(item: JellyfinItem): string {
    return buildCoverUrl(this.cfg.serverUrl, this.token, item);
  }

  private mapSongs(items: JellyfinItem[] | undefined | null): Song[] {
    return (items ?? []).map((i) => mapJellyfinSong(i, this.coverFor(i)));
  }

  async search(query: string, limit = 20, offset = 0): Promise<SearchResult> {
    const common = {
      searchTerm: query,
      Recursive: true,
      Limit: limit,
      StartIndex: offset,
      userId: this.userId,
    };
    const [songRes, albumRes, playlistRes] = await Promise.all([
      this.request<{ Items?: JellyfinItem[] }>("get", "/Items", {
        params: { ...common, IncludeItemTypes: "Audio" },
      }),
      this.request<{ Items?: JellyfinItem[] }>("get", "/Items", {
        params: { ...common, IncludeItemTypes: "MusicAlbum", Fields: "ChildCount" },
      }),
      this.request<{ Items?: JellyfinItem[] }>("get", "/Items", {
        params: { ...common, IncludeItemTypes: "Playlist", Fields: "ChildCount" },
      }),
    ]);
    return {
      songs: this.mapSongs(songRes?.Items),
      albums: (albumRes?.Items ?? []).map((i) => mapJellyfinAlbum(i, this.coverFor(i))),
      playlists: (playlistRes?.Items ?? []).map((i) => mapJellyfinPlaylist(i, this.coverFor(i))),
    };
  }

  async getSongUrl(songId: string, quality?: string): Promise<SongUrlResult | null> {
    await this.ensureAuth();
    const level = quality ?? this.quality;
    const tier = JELLYFIN_QUALITY_LEVELS.find((l) => l.value === level);
    if (!tier || tier.value === "direct") {
      return { url: buildStreamUrl(this.cfg.serverUrl, this.token, songId) };
    }
    return {
      url: buildUniversalUrl(this.cfg.serverUrl, {
        apiKey: this.token,
        userId: this.userId,
        deviceId: this.deviceId,
        itemId: songId,
        kbps: tier.bitrate,
      }),
    };
  }

  async getSongDetail(songId: string): Promise<Song | null> {
    const res = await this.request<{ Items?: JellyfinItem[] }>("get", "/Items", {
      params: { ids: songId, userId: this.userId },
    });
    const item = res?.Items?.[0];
    return item ? mapJellyfinSong(item, this.coverFor(item)) : null;
  }

  async getPlaylistSongs(playlistId: string): Promise<Song[]> {
    const res = await this.request<{ Items?: JellyfinItem[] }>(
      "get",
      `/Playlists/${playlistId}/Items`,
      { params: { userId: this.userId } },
    );
    return this.mapSongs(res?.Items);
  }

  async getAlbumSongs(albumId: string): Promise<Song[]> {
    const res = await this.request<{ Items?: JellyfinItem[] }>("get", "/Items", {
      params: {
        parentId: albumId,
        sortBy: "ParentIndexNumber,IndexNumber",
        userId: this.userId,
      },
    });
    return this.mapSongs(res?.Items);
  }

  async getRecommendPlaylists(): Promise<Playlist[]> {
    return this.getUserPlaylists();
  }

  async getUserPlaylists(): Promise<Playlist[]> {
    const res = await this.request<{ Items?: JellyfinItem[] }>("get", "/Items", {
      params: {
        IncludeItemTypes: "Playlist",
        Recursive: true,
        Fields: "ChildCount",
        SortBy: "SortName",
        userId: this.userId,
      },
    });
    return (res?.Items ?? []).map((i) => mapJellyfinPlaylist(i, this.coverFor(i)));
  }

  async getPlaylistDetail(playlistId: string): Promise<PlaylistDetail | null> {
    const res = await this.request<{ Items?: JellyfinItem[] }>("get", "/Items", {
      params: { ids: playlistId, Fields: "ChildCount,Overview", userId: this.userId },
    });
    const item = res?.Items?.[0];
    if (!item) return null;
    return {
      id: String(item.Id),
      name: item.Name ?? "",
      description: item.Overview ?? "",
      coverUrl: this.coverFor(item),
      songCount: item.ChildCount ?? 0,
    };
  }

  async getLyrics(songId: string): Promise<LyricLine[]> {
    try {
      const res = await this.request<unknown>("get", `/Audio/${songId}/Lyrics`);
      return mapJellyfinLyrics(res);
    } catch (err) {
      // 404 = the track simply has no lyrics — not an error.
      if ((err as AxiosError).response?.status === 404) return [];
      throw err;
    }
  }

  // No QR-code login concept — connection is global and admin-configured.
  async getQrCode(): Promise<QrCodeResult> {
    return { qrUrl: "", key: "" };
  }

  async checkQrCodeStatus(): Promise<"waiting" | "scanned" | "confirmed" | "expired"> {
    return "expired";
  }

  setCookie(cookie: string): void {
    try {
      const parsed = JSON.parse(cookie) as PersistedAuth;
      if (parsed && typeof parsed === "object") {
        if (typeof parsed.accessToken === "string") this.token = parsed.accessToken;
        if (typeof parsed.userId === "string") this.userId = parsed.userId;
        if (typeof parsed.deviceId === "string") this.deviceId = parsed.deviceId;
      }
    } catch {
      // Not the JSON blob we persist — ignore rather than corrupt auth state.
    }
  }

  getCookie(): string {
    return JSON.stringify({
      accessToken: this.token,
      userId: this.userId,
      deviceId: this.deviceId,
    });
  }

  async getAuthStatus(): Promise<AuthStatus> {
    if (!this.cfg.serverUrl) return { loggedIn: false };
    try {
      const info = await this.request<{ ServerName?: string }>("get", "/System/Info");
      const who = this.cfg.authMode === "apikey" ? "API Key" : this.cfg.username;
      return { loggedIn: true, nickname: `${who}@${info?.ServerName ?? "Jellyfin"}` };
    } catch (err) {
      this.logger?.debug({ err: describeJellyfinError(err) }, "Jellyfin auth status check failed");
      return { loggedIn: false };
    }
  }

  /**
   * Authenticated round-trip to /System/Info for the Settings "test connection"
   * button. `candidate` (when given) tests form values in a throwaway instance
   * so a failed test never disturbs the live token state.
   */
  async testConnection(
    candidate?: JellyfinConfig,
  ): Promise<{ ok: boolean; serverName?: string; version?: string; error?: string }> {
    const probe = candidate ? new JellyfinProvider() : this;
    if (candidate) probe.configure(candidate);
    try {
      const info = await probe.request<{ ServerName?: string; Version?: string }>(
        "get",
        "/System/Info",
      );
      return { ok: true, serverName: info?.ServerName, version: info?.Version };
    } catch (err) {
      return { ok: false, error: describeJellyfinError(err) };
    }
  }

  /**
   * Personal FM = Instant Mix seeded from a random favorite, falling back to a
   * random recently-played track, then a random library track. A final safety
   * net returns 50 random tracks when Instant Mix itself yields nothing.
   */
  async getPersonalFm(): Promise<Song[]> {
    const seed = await this.pickFmSeed();
    if (seed) {
      const mix = await this.request<{ Items?: JellyfinItem[] }>(
        "get",
        `/Items/${seed}/InstantMix`,
        { params: { userId: this.userId, limit: 50 } },
      );
      const songs = this.mapSongs(mix?.Items);
      if (songs.length > 0) return songs;
    }
    const random = await this.request<{ Items?: JellyfinItem[] }>("get", "/Items", {
      params: {
        IncludeItemTypes: "Audio",
        Recursive: true,
        SortBy: "Random",
        Limit: 50,
        userId: this.userId,
      },
    });
    return this.mapSongs(random?.Items);
  }

  private async pickFmSeed(): Promise<string | null> {
    const favorite = await this.request<{ Items?: JellyfinItem[] }>("get", "/Items", {
      params: {
        Filters: "IsFavorite",
        IncludeItemTypes: "Audio",
        Recursive: true,
        SortBy: "Random",
        Limit: 1,
        userId: this.userId,
      },
    });
    if (favorite?.Items?.[0]?.Id) return favorite.Items[0].Id;

    const played = await this.request<{ Items?: JellyfinItem[] }>("get", "/Items", {
      params: {
        Filters: "IsPlayed",
        IncludeItemTypes: "Audio",
        Recursive: true,
        SortBy: "DatePlayed",
        SortOrder: "Descending",
        Limit: 20,
        userId: this.userId,
      },
    });
    const playedItems = played?.Items ?? [];
    if (playedItems.length > 0) {
      return playedItems[Math.floor(Math.random() * playedItems.length)].Id;
    }

    const random = await this.request<{ Items?: JellyfinItem[] }>("get", "/Items", {
      params: {
        IncludeItemTypes: "Audio",
        Recursive: true,
        SortBy: "Random",
        Limit: 1,
        userId: this.userId,
      },
    });
    return random?.Items?.[0]?.Id ?? null;
  }

  // --- Home sections ---

  async getLatestAlbums(limit = 12): Promise<Album[]> {
    await this.ensureAuth();
    const items = await this.request<JellyfinItem[]>(
      "get",
      `/Users/${this.userId}/Items/Latest`,
      { params: { IncludeItemTypes: "MusicAlbum", Limit: limit, Fields: "ChildCount" } },
    );
    return (Array.isArray(items) ? items : []).map((i) =>
      mapJellyfinAlbum(i, this.coverFor(i)),
    );
  }

  async getMostPlayed(limit = 12): Promise<Song[]> {
    const res = await this.request<{ Items?: JellyfinItem[] }>("get", "/Items", {
      params: {
        SortBy: "PlayCount",
        SortOrder: "Descending",
        IncludeItemTypes: "Audio",
        Recursive: true,
        Filters: "IsPlayed",
        Limit: limit,
        userId: this.userId,
      },
    });
    return this.mapSongs(res?.Items);
  }

  async getFavoriteSongs(limit = 100): Promise<Song[]> {
    const res = await this.request<{ Items?: JellyfinItem[] }>("get", "/Items", {
      params: {
        Filters: "IsFavorite",
        IncludeItemTypes: "Audio",
        Recursive: true,
        SortBy: "SortName",
        Limit: limit,
        userId: this.userId,
      },
    });
    return this.mapSongs(res?.Items);
  }

  async getGenres(limit = 30): Promise<{ id: string; name: string }[]> {
    const res = await this.request<{ Items?: JellyfinItem[] }>("get", "/MusicGenres", {
      params: { userId: this.userId, Limit: limit, SortBy: "SortName" },
    });
    return (res?.Items ?? []).map((i) => ({ id: String(i.Id), name: i.Name ?? "" }));
  }

  async getGenreSongs(genreId: string, limit = 100): Promise<Song[]> {
    const res = await this.request<{ Items?: JellyfinItem[] }>("get", "/Items", {
      params: {
        GenreIds: genreId,
        IncludeItemTypes: "Audio",
        Recursive: true,
        SortBy: "AlbumArtist,Album,SortName",
        Limit: limit,
        userId: this.userId,
      },
    });
    return this.mapSongs(res?.Items);
  }

  // --- Playback reporting (Sessions API) ---

  private async report(path: string, body: Record<string, unknown>): Promise<void> {
    try {
      await this.request("post", path, { data: body });
    } catch (err) {
      // Reporting must never affect playback — log and swallow.
      this.logger?.debug(
        { err: describeJellyfinError(err), path },
        "Jellyfin playback report failed",
      );
    }
  }

  createPlaybackReporter(): JellyfinPlaybackReporter {
    // One session per track start; remember the last reported position so the
    // implicit stop on track change carries a sane PositionTicks (a natural
    // track end reports ~full duration → Jellyfin counts the play).
    let current: { itemId: string; sessionId: string; lastPosSec: number } | null = null;
    const report = this.report.bind(this);
    return {
      onTrackStart(itemId: string): void {
        if (current) {
          void report("/Sessions/Playing/Stopped", {
            ItemId: current.itemId,
            PlaySessionId: current.sessionId,
            PositionTicks: Math.round(current.lastPosSec * TICKS_PER_SECOND),
          });
        }
        current = { itemId, sessionId: crypto.randomUUID(), lastPosSec: 0 };
        void report("/Sessions/Playing", {
          ItemId: itemId,
          PlaySessionId: current.sessionId,
          PositionTicks: 0,
          CanSeek: true,
        });
      },
      onTick(itemId: string, positionSec: number, paused: boolean): void {
        if (!current || current.itemId !== itemId) return;
        current.lastPosSec = positionSec;
        void report("/Sessions/Playing/Progress", {
          ItemId: itemId,
          PlaySessionId: current.sessionId,
          PositionTicks: Math.round(positionSec * TICKS_PER_SECOND),
          IsPaused: paused,
        });
      },
      onStop(): void {
        if (!current) return;
        void report("/Sessions/Playing/Stopped", {
          ItemId: current.itemId,
          PlaySessionId: current.sessionId,
          PositionTicks: Math.round(current.lastPosSec * TICKS_PER_SECOND),
        });
        current = null;
      },
    };
  }
}
