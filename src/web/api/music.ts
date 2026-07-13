import express, { Router, type Response } from "express";
import type { MusicProvider, Song, Album } from "../../music/provider.js";
import { YouTubeProvider } from "../../music/youtube.js";
import type { Logger } from "../../logger.js";
import { isProviderEnabled, defaultPlatform, type BotConfig } from "../../data/config.js";
import { requirePermission } from "../middleware/requirePermission.js";
import { requireNotGuest } from "../middleware/requireNotGuest.js";
import { authorize } from "../middleware/authorize.js";

export function createMusicRouter(
  neteaseProvider: MusicProvider,
  qqProvider: MusicProvider,
  bilibiliProvider: MusicProvider,
  logger: Logger,
  localProvider?: MusicProvider,
  config?: BotConfig,
  kugouProvider?: MusicProvider,
  spotifyProvider?: MusicProvider,
  jellyfinProvider?: MusicProvider
): Router {
  const router = Router();
  const youtubeProvider: MusicProvider = new YouTubeProvider();

  function isLocalAudioEnabled(): boolean {
    return config?.localAudioEnabled !== false;
  }

  function getProvider(platform?: string): MusicProvider {
    if (platform === "bilibili") return bilibiliProvider;
    if (platform === "youtube") return youtubeProvider;
    if (platform === "local" && localProvider) return localProvider;
    if (platform === "kugou" && kugouProvider) return kugouProvider;
    if (platform === "spotify" && spotifyProvider) return spotifyProvider;
    if (platform === "jellyfin" && jellyfinProvider) return jellyfinProvider;
    return platform === "qq" ? qqProvider : neteaseProvider;
  }

  /**
   * Provider gating for user-supplied platform params. No platform → the
   * configured default (jellyfin unless disabled). A disabled platform gets a
   * friendly 400 and null back — the handler must return immediately.
   * Without a config (unit-test routers), everything stays enabled.
   */
  function resolveProvider(platform: unknown, res: Response): MusicProvider | null {
    const requested = typeof platform === "string" && platform ? platform : undefined;
    const target = requested ?? (config ? defaultPlatform(config) : "netease");
    if (config && !isProviderEnabled(config, target)) {
      res.status(400).json({ error: `音源未启用：${target} (provider disabled)` });
      return null;
    }
    return getProvider(target);
  }

  router.post(
    "/local/upload",
    authorize({ capability: "player.queue", guestFlag: "addToQueue" }),
    (_req, res, next) => {
      if (!isLocalAudioEnabled()) {
        res.status(403).json({ error: "本地音频播放已关闭" });
        return;
      }
      next();
    },
    express.raw({
      type: ["audio/*", "video/webm", "application/octet-stream"],
      limit: "200mb",
    }),
    async (req, res) => {
      try {
        if (!localProvider) {
          res.status(501).json({ error: "Local upload is not configured" });
          return;
        }
        const uploadCapable = localProvider as MusicProvider & {
          uploadAudio?: (input: { buffer: Buffer; originalName: string; mimeType?: string }) => Promise<unknown>;
        };
        if (typeof uploadCapable.uploadAudio !== "function") {
          res.status(501).json({ error: "Local upload is not supported" });
          return;
        }
        if (!Buffer.isBuffer(req.body)) {
          res.status(400).json({ error: "raw audio body is required" });
          return;
        }
        const headerName = req.header("x-filename") || req.header("x-file-name") || "audio";
        let originalName = headerName;
        try {
          originalName = decodeURIComponent(headerName);
        } catch {
          // Keep the raw header value if it is not URI encoded.
        }
        const song = await uploadCapable.uploadAudio({
          buffer: req.body,
          originalName,
          mimeType: req.header("content-type") || undefined,
        });
        res.json({ song });
      } catch (err) {
        logger.warn({ err }, "Local audio upload failed");
        res.status(400).json({ error: (err as Error).message });
      }
    },
  );

  router.get("/search", async (req, res) => {
    try {
      const { q, platform, limit, offset } = req.query;
      if (!q) {
        res.status(400).json({ error: "q (query) is required" });
        return;
      }
      if (platform === "local" && !isLocalAudioEnabled()) {
        res.json({ songs: [], playlists: [], albums: [] });
        return;
      }
      const provider = resolveProvider(platform, res);
      if (!provider) return;
      // Server-side pagination: offset lets the web load past the first page.
      // Clamp to >= 0 so a bad/negative value falls back to the first page.
      const parsedOffset = Math.max(0, parseInt(offset as string) || 0);
      const result = await provider.search(
        q as string,
        parseInt(limit as string) || 20,
        parsedOffset
      );
      res.json(result);
    } catch (err) {
      logger.error({ err }, "Search failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/search/all", async (req, res) => {
    try {
      const { q, limit } = req.query;
      if (!q) {
        res.status(400).json({ error: "q (query) is required" });
        return;
      }
      const parsedLimit = parseInt(limit as string) || 20;
      // Spotify is intentionally EXCLUDED from unified /search/all in Stage 1:
      // its tracks are metadata-only (not yet playable) until the librespot audio
      // backend lands (Stage 2/3), so surfacing them in the default all-sources
      // view would only yield results that get skipped. Spotify search remains
      // available from its own tab via /search?platform=spotify.
      // Provider gating (#enabledProviders): disabled sources are skipped, not
      // searched. Jellyfin — the primary source — leads the merged results.
      const enabled = (p: string) => !config || isProviderEnabled(config, p);
      const none = { songs: [], albums: [], playlists: [] };
      const [jellyfinResult, neteaseResult, qqResult, bilibiliResult, localResult, kugouResult] = await Promise.allSettled([
        jellyfinProvider && enabled("jellyfin") ? jellyfinProvider.search(q as string, parsedLimit) : Promise.resolve(none),
        enabled("netease") ? neteaseProvider.search(q as string, parsedLimit) : Promise.resolve(none),
        enabled("qq") ? qqProvider.search(q as string, parsedLimit) : Promise.resolve(none),
        enabled("bilibili") ? bilibiliProvider.search(q as string, parsedLimit) : Promise.resolve(none),
        localProvider && isLocalAudioEnabled() ? localProvider.search(q as string, parsedLimit) : Promise.resolve(none),
        kugouProvider && enabled("kugou") ? kugouProvider.search(q as string, parsedLimit) : Promise.resolve(none),
      ]);

      const songs = [
        ...(jellyfinResult.status === "fulfilled" ? jellyfinResult.value.songs : []),
        ...(neteaseResult.status === "fulfilled" ? neteaseResult.value.songs : []),
        ...(qqResult.status === "fulfilled" ? qqResult.value.songs : []),
        ...(bilibiliResult.status === "fulfilled" ? bilibiliResult.value.songs : []),
        ...(localResult.status === "fulfilled" ? localResult.value.songs : []),
        ...(kugouResult.status === "fulfilled" ? kugouResult.value.songs : []),
      ];
      const albums = [
        ...(jellyfinResult.status === "fulfilled" ? jellyfinResult.value.albums : []),
        ...(neteaseResult.status === "fulfilled" ? neteaseResult.value.albums : []),
        ...(qqResult.status === "fulfilled" ? qqResult.value.albums : []),
      ];
      const playlists = [
        ...(jellyfinResult.status === "fulfilled" ? jellyfinResult.value.playlists : []),
        ...(neteaseResult.status === "fulfilled" ? neteaseResult.value.playlists : []),
        ...(qqResult.status === "fulfilled" ? qqResult.value.playlists : []),
      ];

      res.json({ songs, albums, playlists });
    } catch (err) {
      logger.error({ err }, "Unified search failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/song/:id", async (req, res) => {
    try {
      if (req.query.platform === "local" && !isLocalAudioEnabled()) {
        res.status(403).json({ error: "本地音频播放已关闭" });
        return;
      }
      const provider = resolveProvider(req.query.platform, res);
      if (!provider) return;
      const song = await provider.getSongDetail(req.params.id);
      if (!song) {
        res.status(404).json({ error: "Song not found" });
        return;
      }
      res.json(song);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/playlist/:id", async (req, res) => {
    try {
      const provider = resolveProvider(req.query.platform, res);
      if (!provider) return;
      const songs = await provider.getPlaylistSongs(req.params.id);
      res.json({ songs });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/recommend/playlists", async (req, res) => {
    try {
      const provider = resolveProvider(req.query.platform, res);
      if (!provider) return;
      const playlists = await provider.getRecommendPlaylists();
      res.json({ playlists });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/album/:id", async (req, res) => {
    try {
      const provider = resolveProvider(req.query.platform, res);
      if (!provider) return;
      const songs = await provider.getAlbumSongs(req.params.id);
      res.json({ songs });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/lyrics/:id", async (req, res) => {
    try {
      const provider = resolveProvider(req.query.platform, res);
      if (!provider) return;
      const lyrics = await provider.getLyrics(req.params.id);
      res.json({ lyrics });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/recommend/songs", requireNotGuest, async (req, res) => {
    try {
      const provider = resolveProvider(req.query.platform, res);
      if (!provider) return;
      if (!provider.getDailyRecommendSongs) {
        res.status(501).json({ error: "Not supported by this provider" });
        return;
      }
      const songs = await provider.getDailyRecommendSongs();
      res.json({ songs });
    } catch (err) {
      logger.error({ err }, "Get daily recommend songs failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/personal/fm", requireNotGuest, async (req, res) => {
    try {
      const provider = resolveProvider(req.query.platform, res);
      if (!provider) return;
      if (!provider.getPersonalFm) {
        res.status(501).json({ error: "Not supported by this provider" });
        return;
      }
      const songs = await provider.getPersonalFm();
      res.json({ songs });
    } catch (err) {
      logger.error({ err }, "Get personal FM failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/user/playlists", requireNotGuest, async (req, res) => {
    try {
      const provider = resolveProvider(req.query.platform, res);
      if (!provider) return;
      if (!provider.getUserPlaylists) {
        res.status(501).json({ error: "Not supported by this provider" });
        return;
      }
      const playlists = await provider.getUserPlaylists();
      res.json({ playlists });
    } catch (err) {
      logger.error({ err }, "Get user playlists failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/playlist/:id/detail", async (req, res) => {
    try {
      const provider = resolveProvider(req.query.platform, res);
      if (!provider) return;
      if (!provider.getPlaylistDetail) {
        res.status(501).json({ error: "Not supported by this provider" });
        return;
      }
      const detail = await provider.getPlaylistDetail(req.params.id);
      if (!detail) {
        res.status(404).json({ error: "Playlist not found" });
        return;
      }
      res.json({ playlist: detail });
    } catch (err) {
      logger.error({ err }, "Get playlist detail failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // B站热门视频
  router.get("/bilibili/popular", async (req, res) => {
    try {
      const provider = bilibiliProvider as any;
      if (provider.getPopularVideos) {
        const limit = parseInt(req.query.limit as string) || 20;
        const songs = await provider.getPopularVideos(limit);
        res.json({ songs });
      } else {
        res.json({ songs: [] });
      }
    } catch (err) {
      logger.error({ err }, "Get bilibili popular failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Enabled sources + default platform, for the web UI (source tabs, default
  // search/playback source). Without a config (unit-test routers) everything
  // reports enabled with the legacy netease default.
  router.get("/providers", (_req, res) => {
    const ALL_PLATFORMS = [
      "jellyfin",
      "netease",
      "qq",
      "bilibili",
      "youtube",
      "kugou",
      "spotify",
      "local",
    ];
    res.json({
      enabled: config ? ALL_PLATFORMS.filter((p) => isProviderEnabled(config, p)) : ALL_PLATFORMS,
      default: config ? defaultPlatform(config) : "netease",
    });
  });

  // ─── Jellyfin home-page data ───────────────────────────────────────────
  // The concrete JellyfinProvider surface these endpoints consume; the router
  // only knows the MusicProvider interface, so narrow structurally (same
  // pattern as localProvider.uploadAudio above).
  type JellyfinHomeProvider = MusicProvider & {
    getLatestAlbums?: (limit?: number) => Promise<Album[]>;
    getMostPlayed?: (limit?: number) => Promise<Song[]>;
    getFavoriteSongs?: (limit?: number) => Promise<Song[]>;
    getGenres?: (limit?: number) => Promise<{ id: string; name: string }[]>;
    getGenreSongs?: (genreId: string, limit?: number) => Promise<Song[]>;
  };
  const jellyfinHome = jellyfinProvider as JellyfinHomeProvider | undefined;

  /** 501 when no provider is wired, 400 when the source is disabled. */
  function jellyfinOrReject(res: Response): JellyfinHomeProvider | null {
    if (!jellyfinHome) {
      res.status(501).json({ error: "Jellyfin provider not configured" });
      return null;
    }
    if (config && !isProviderEnabled(config, "jellyfin")) {
      res.status(400).json({ error: "音源未启用：jellyfin (provider disabled)" });
      return null;
    }
    return jellyfinHome;
  }

  router.get("/jellyfin/latest-albums", async (req, res) => {
    try {
      const p = jellyfinOrReject(res);
      if (!p) return;
      const limit = parseInt(req.query.limit as string) || 12;
      res.json({ albums: (await p.getLatestAlbums?.(limit)) ?? [] });
    } catch (err) {
      logger.error({ err }, "Jellyfin latest albums failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/jellyfin/most-played", async (req, res) => {
    try {
      const p = jellyfinOrReject(res);
      if (!p) return;
      const limit = parseInt(req.query.limit as string) || 12;
      res.json({ songs: (await p.getMostPlayed?.(limit)) ?? [] });
    } catch (err) {
      logger.error({ err }, "Jellyfin most played failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Favorites are account-level data — guests don't get them (matches the
  // requireNotGuest gate on /user/playlists).
  router.get("/jellyfin/favorites", requireNotGuest, async (req, res) => {
    try {
      const p = jellyfinOrReject(res);
      if (!p) return;
      const limit = parseInt(req.query.limit as string) || 100;
      res.json({ songs: (await p.getFavoriteSongs?.(limit)) ?? [] });
    } catch (err) {
      logger.error({ err }, "Jellyfin favorites failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/jellyfin/genres", async (req, res) => {
    try {
      const p = jellyfinOrReject(res);
      if (!p) return;
      const limit = parseInt(req.query.limit as string) || 30;
      res.json({ genres: (await p.getGenres?.(limit)) ?? [] });
    } catch (err) {
      logger.error({ err }, "Jellyfin genres failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/jellyfin/genre/:id/songs", async (req, res) => {
    try {
      const p = jellyfinOrReject(res);
      if (!p) return;
      const limit = parseInt(req.query.limit as string) || 100;
      res.json({ songs: (await p.getGenreSongs?.(req.params.id, limit)) ?? [] });
    } catch (err) {
      logger.error({ err }, "Jellyfin genre songs failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Get current quality
  router.get("/quality", requireNotGuest, (_req, res) => {
    res.json({
      netease: neteaseProvider.getQuality(),
      qq: qqProvider.getQuality(),
      bilibili: bilibiliProvider.getQuality(),
      local: localProvider?.getQuality() ?? "original",
      kugou: kugouProvider?.getQuality() ?? "128",
      spotify: spotifyProvider?.getQuality() ?? "320",
      jellyfin: jellyfinProvider?.getQuality() ?? "direct",
    });
  });

  // Set quality
  router.post("/quality", requirePermission("quality"), (req, res) => {
    const { quality, platform } = req.body;
    if (!quality) {
      res.status(400).json({ error: "quality is required" });
      return;
    }
    if (!platform || platform === "netease") {
      neteaseProvider.setQuality(quality);
    }
    if (!platform || platform === "qq") {
      qqProvider.setQuality(quality);
    }
    if (!platform || platform === "bilibili") {
      bilibiliProvider.setQuality(quality);
    }
    if ((!platform || platform === "kugou") && kugouProvider) {
      kugouProvider.setQuality(quality);
    }
    if ((!platform || platform === "spotify") && spotifyProvider) {
      spotifyProvider.setQuality(quality);
    }
    // Safe in the platform-less broadcast: JellyfinProvider.setQuality ignores
    // values outside its own tier list (direct/320/192/128).
    if ((!platform || platform === "jellyfin") && jellyfinProvider) {
      jellyfinProvider.setQuality(quality);
    }
    logger.info({ quality, platform }, "Audio quality changed");
    res.json({ success: true, quality });
  });

  return router;
}
