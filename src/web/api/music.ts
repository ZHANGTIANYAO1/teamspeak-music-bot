import { Router } from "express";
import type { MusicProvider } from "../../music/provider.js";
import type { Logger } from "../../logger.js";

export function createMusicRouter(
  neteaseProvider: MusicProvider,
  qqProvider: MusicProvider,
  bilibiliProvider: MusicProvider,
  youtubeProvider: MusicProvider,
  logger: Logger
): Router {
  const router = Router();

  function getProvider(platform?: string): MusicProvider {
    if (platform === "youtube") return youtubeProvider;
    if (platform === "bilibili") return bilibiliProvider;
    return platform === "qq" ? qqProvider : neteaseProvider;
  }

  router.get("/search", async (req, res) => {
    try {
      const { q, platform, limit } = req.query;
      if (!q) {
        res.status(400).json({ error: "q (query) is required" });
        return;
      }
      const provider = getProvider(platform as string);
      const result = await provider.search(
        q as string,
        parseInt(limit as string) || 20
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
      const [neteaseResult, qqResult, bilibiliResult, youtubeResult] = await Promise.allSettled([
        neteaseProvider.search(q as string, parsedLimit),
        qqProvider.search(q as string, parsedLimit),
        bilibiliProvider.search(q as string, parsedLimit),
        youtubeProvider.search(q as string, parsedLimit),
      ]);

      const songs = [
        ...(neteaseResult.status === "fulfilled"
          ? neteaseResult.value.songs
          : []),
        ...(qqResult.status === "fulfilled" ? qqResult.value.songs : []),
        ...(bilibiliResult.status === "fulfilled" ? bilibiliResult.value.songs : []),
        ...(youtubeResult.status === "fulfilled" ? youtubeResult.value.songs : []),
      ];

      res.json({ songs });
    } catch (err) {
      logger.error({ err }, "Unified search failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/song/:id", async (req, res) => {
    try {
      const provider = getProvider(req.query.platform as string);
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
      const provider = getProvider(req.query.platform as string);
      const songs = await provider.getPlaylistSongs(req.params.id);
      res.json({ songs });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/recommend/playlists", async (req, res) => {
    try {
      const provider = getProvider(req.query.platform as string);
      const playlists = await provider.getRecommendPlaylists();
      res.json({ playlists });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/album/:id", async (req, res) => {
    try {
      const provider = getProvider(req.query.platform as string);
      const songs = await provider.getAlbumSongs(req.params.id);
      res.json({ songs });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/lyrics/:id", async (req, res) => {
    try {
      const provider = getProvider(req.query.platform as string);
      const lyrics = await provider.getLyrics(req.params.id);
      res.json({ lyrics });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/recommend/songs", async (req, res) => {
    try {
      const provider = getProvider(req.query.platform as string);
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

  router.get("/personal/fm", async (req, res) => {
    try {
      const provider = getProvider(req.query.platform as string);
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

  router.get("/user/playlists", async (req, res) => {
    try {
      const provider = getProvider(req.query.platform as string);
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
      const provider = getProvider(req.query.platform as string);
      // Use the playlist songs endpoint to get basic info,
      // but we also need detail info (name, cover, description).
      // For netease, we access the underlying API directly.
      const nProvider = provider as any;
      if (nProvider.api) {
        const cookieParams = nProvider.cookie
          ? { cookie: nProvider.cookie }
          : {};
        const detailRes = await nProvider.api.get("/playlist/detail", {
          params: { id: req.params.id, ...cookieParams },
        });
        const p = detailRes.data?.playlist;
        if (p) {
          res.json({
            playlist: {
              id: String(p.id),
              name: p.name,
              description: p.description ?? "",
              coverUrl: p.coverImgUrl ?? "",
              songCount: p.trackCount ?? 0,
            },
          });
          return;
        }
      }
      res.status(404).json({ error: "Playlist not found" });
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

  // Get current quality
  router.get("/quality", (_req, res) => {
    res.json({
      netease: neteaseProvider.getQuality(),
      qq: qqProvider.getQuality(),
      bilibili: bilibiliProvider.getQuality(),
      youtube: youtubeProvider.getQuality(),
    });
  });

  // Set quality
  router.post("/quality", (req, res) => {
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
    if (!platform || platform === "youtube") {
      youtubeProvider.setQuality(quality);
    }
    logger.info({ quality, platform }, "Audio quality changed");
    res.json({ success: true, quality });
  });

  return router;
}
