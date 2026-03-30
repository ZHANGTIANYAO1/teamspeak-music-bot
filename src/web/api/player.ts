import { Router } from "express";
import type { BotManager } from "../../bot/manager.js";
import type { BotDatabase } from "../../data/database.js";
import type { MusicProvider } from "../../music/provider.js";
import type { Logger } from "../../logger.js";
import { parseCommand } from "../../bot/commands.js";

export function createPlayerRouter(
  botManager: BotManager,
  logger: Logger,
  database?: BotDatabase,
  neteaseProvider?: MusicProvider,
  qqProvider?: MusicProvider,
): Router {
  const router = Router();

  router.use("/:botId", (req, res, next) => {
    const bot = botManager.getBot(req.params.botId);
    if (!bot) {
      res.status(404).json({ error: "Bot not found" });
      return;
    }
    (req as any).bot = bot;
    next();
  });

  router.post("/:botId/play", async (req, res) => {
    try {
      const bot = (req as any).bot;
      const { query, platform } = req.body;
      if (!query) {
        res.status(400).json({ error: "query is required" });
        return;
      }
      const flags = platform === "qq" ? "-q" : "";
      const cmd = parseCommand(`!play ${flags} ${query}`.trim(), "!");
      if (!cmd) {
        res.status(400).json({ error: "Invalid command" });
        return;
      }
      const response = await bot.executeCommand(cmd);
      res.json({ message: response });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/:botId/add", async (req, res) => {
    try {
      const bot = (req as any).bot;
      const { query, platform } = req.body;
      const flags = platform === "qq" ? "-q" : "";
      const cmd = parseCommand(`!add ${flags} ${query}`.trim(), "!");
      if (!cmd) {
        res.status(400).json({ error: "Invalid command" });
        return;
      }
      const response = await bot.executeCommand(cmd);
      res.json({ message: response });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  const simpleCommand = (cmdStr: string) => async (req: any, res: any) => {
    try {
      const bot = req.bot;
      const cmd = parseCommand(cmdStr, "!")!;
      const response = await bot.executeCommand(cmd);
      res.json({ message: response });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  };

  router.post("/:botId/pause", simpleCommand("!pause"));
  router.post("/:botId/resume", simpleCommand("!resume"));
  router.post("/:botId/next", simpleCommand("!next"));
  router.post("/:botId/prev", simpleCommand("!prev"));
  router.post("/:botId/stop", simpleCommand("!stop"));
  router.post("/:botId/clear", simpleCommand("!clear"));

  router.post("/:botId/volume", async (req, res) => {
    try {
      const bot = (req as any).bot;
      const { volume } = req.body;
      const cmd = parseCommand(`!vol ${volume}`, "!")!;
      const response = await bot.executeCommand(cmd);
      res.json({ message: response });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/:botId/mode", async (req, res) => {
    try {
      const bot = (req as any).bot;
      const { mode } = req.body;
      const cmd = parseCommand(`!mode ${mode}`, "!")!;
      const response = await bot.executeCommand(cmd);
      res.json({ message: response });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Get current elapsed time (ground truth from server)
  router.get("/:botId/elapsed", (req, res) => {
    const bot = (req as any).bot;
    res.json({ elapsed: bot.getPlayer().getElapsed() });
  });

  // Seek to position
  router.post("/:botId/seek", async (req, res) => {
    try {
      const bot = (req as any).bot;
      const { position } = req.body; // seconds
      if (typeof position !== "number" || position < 0) {
        res.status(400).json({ error: "position (seconds) is required" });
        return;
      }
      bot.getPlayer().seek(position);
      res.json({ message: `Seeked to ${Math.floor(position)}s`, seekOffset: position });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/:botId/queue", (req, res) => {
    const bot = (req as any).bot;
    res.json({ queue: bot.getQueue(), status: bot.getStatus() });
  });

  router.delete("/:botId/queue/:index", async (req, res) => {
    try {
      const bot = (req as any).bot;
      const cmd = parseCommand(`!remove ${req.params.index}`, "!")!;
      const response = await bot.executeCommand(cmd);
      res.json({ message: response });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Jump to a specific index in the queue (without clearing it)
  router.post("/:botId/play-at", async (req, res) => {
    try {
      const bot = (req as any).bot;
      const { index } = req.body;
      if (typeof index !== "number" || index < 0) {
        res.status(400).json({ error: "index is required" });
        return;
      }
      const queue = bot.getQueueManager();
      bot.getPlayer().stop(); // Stop current playback first
      const song = queue.playAt(index);
      if (!song) {
        res.status(400).json({ error: "Invalid queue index" });
        return;
      }
      const ok = await bot.resolveAndPlay(song);
      if (!ok) {
        res.json({ message: `Cannot play: ${song.name}` });
        return;
      }
      res.json({ message: `Now playing: ${song.name} - ${song.artist}` });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/:botId/playlist", async (req, res) => {
    try {
      const bot = (req as any).bot;
      const { playlistId, platform } = req.body;
      const flags = platform === "qq" ? "-q" : "";
      const cmd = parseCommand(
        `!playlist ${flags} ${playlistId}`.trim(),
        "!"
      )!;
      const response = await bot.executeCommand(cmd);
      res.json({ message: response });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Play a playlist by ID — stores metadata only, resolves URL for first song
  // Respects current play mode (random = pick random first song)
  router.post("/:botId/play-playlist", async (req, res) => {
    try {
      const bot = (req as any).bot;
      const { playlistId, platform } = req.body;
      const provider = platform === "qq" ? qqProvider : neteaseProvider;
      if (!provider) {
        res.status(500).json({ error: "Provider not available" });
        return;
      }

      // Stop current playback
      bot.getPlayer().stop();

      const songs = await provider.getPlaylistSongs(playlistId);
      if (songs.length === 0) {
        res.json({ message: "Playlist is empty" });
        return;
      }

      const queue = bot.getQueueManager();
      queue.clear();
      for (const song of songs) {
        queue.add({ ...song, platform: provider.platform });
      }

      // Use queue.play() for sequential, or pick random index for random modes
      const mode = queue.getMode();
      let first;
      if (mode === "random" || mode === "rloop") {
        const idx = Math.floor(Math.random() * queue.size());
        first = queue.playAt(idx);
      } else {
        first = queue.play();
      }

      if (first) {
        await bot.resolveAndPlay(first);
      }

      res.json({ message: `Loaded ${songs.length} songs. Now playing: ${first?.name ?? "unknown"}` });
    } catch (err) {
      logger.error({ err }, "Play playlist failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Play a single song by ID — resolves URL on demand
  router.post("/:botId/play-by-id", async (req, res) => {
    try {
      const bot = (req as any).bot;
      const { songId, platform } = req.body;
      const provider = platform === "qq" ? qqProvider : neteaseProvider;
      if (!provider) {
        res.status(500).json({ error: "Provider not available" });
        return;
      }

      const song = await provider.getSongDetail(songId);
      if (!song) {
        res.json({ message: "Song not found" });
        return;
      }

      const queue = bot.getQueueManager();
      queue.clear();
      queue.add({ ...song, platform: provider.platform });
      queue.play();

      const ok = await bot.resolveAndPlay(queue.current()!);
      if (!ok) {
        res.json({ message: `Cannot play: ${song.name}` });
        return;
      }

      res.json({ message: `Now playing: ${song.name} - ${song.artist}` });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Add a song to queue by ID — metadata only
  router.post("/:botId/add-by-id", async (req, res) => {
    try {
      const bot = (req as any).bot;
      const { songId, platform } = req.body;
      const provider = platform === "qq" ? qqProvider : neteaseProvider;
      if (!provider) {
        res.status(500).json({ error: "Provider not available" });
        return;
      }

      const song = await provider.getSongDetail(songId);
      if (!song) {
        res.json({ message: "Song not found" });
        return;
      }

      const queue = bot.getQueueManager();
      queue.add({ ...song, platform: provider.platform });

      // If nothing is playing, start the first song
      if (bot.getPlayer().getState() === "idle") {
        const first = queue.play();
        if (first) await bot.resolveAndPlay(first);
      }

      res.json({ message: `Added: ${song.name} - ${song.artist} (position ${queue.size()})` });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/:botId/history", (req, res) => {
    if (!database) {
      res.json({ history: [] });
      return;
    }
    const limit = parseInt(req.query.limit as string) || 50;
    const records = database.getPlayHistory(req.params.botId, limit);
    const history = records.map((r) => ({
      id: r.songId,
      name: r.songName,
      artist: r.artist,
      album: r.album,
      duration: 0,
      coverUrl: r.coverUrl,
      platform: r.platform,
      playedAt: r.playedAt,
    }));
    res.json({ history });
  });

  return router;
}
