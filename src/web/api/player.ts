import { Router } from "express";
import type { BotManager } from "../../bot/manager.js";
import type { BotDatabase } from "../../data/database.js";
import type { MusicProvider } from "../../music/provider.js";
import type { Logger } from "../../logger.js";
import { parseCommand } from "../../bot/commands.js";
import { requireBotAccess } from "../middleware/requirePermission.js";
import { authorize } from "../middleware/authorize.js";

export function createPlayerRouter(
  botManager: BotManager,
  logger: Logger,
  database?: BotDatabase,
  neteaseProvider?: MusicProvider,
  qqProvider?: MusicProvider,
  bilibiliProvider?: MusicProvider,
): Router {
  const router = Router();

  // Access check runs BEFORE the existence/resolver check so a member who is
  // not allowed a bot always gets a uniform 403 — whether or not the bot
  // exists — instead of a 404 that would leak which bot IDs are real.
  // requireBotAccess only needs req.params.botId and req.user (set by the
  // global requireAuth mounted earlier), so it works before the resolver.
  router.use("/:botId", requireBotAccess("botId"));

  router.use("/:botId", (req, res, next) => {
    const bot = botManager.getBot(req.params.botId);
    if (!bot) {
      res.status(404).json({ error: "Bot not found" });
      return;
    }
    (req as any).bot = bot;
    next();
  });

  /** Map API platform string to the corresponding command flag. */
  const platformFlag = (platform: unknown): string => {
    if (platform === "bilibili") return "-b";
    if (platform === "qq") return "-q";
    if (platform === "youtube") return "-y";
    if (platform === "kugou") return "-k";
    return "";
  };

  function isLocalAudioDisabled(bot: any, platform: unknown): boolean {
    return platform === "local" &&
      typeof bot.isLocalAudioEnabled === "function" &&
      !bot.isLocalAudioEnabled();
  }

  function rejectDisabledLocalAudio(res: any): void {
    res.status(403).json({ error: "本地音频播放已关闭" });
  }

  function requesterName(req: any): string {
    const name = req.user?.username;
    return typeof name === "string" && name.trim() ? name.trim() : "游客";
  }

  router.post("/:botId/play", authorize({ capability: "player.control" }), async (req, res) => {
    try {
      const bot = (req as any).bot;
      const { query, platform } = req.body;
      if (!query) {
        res.status(400).json({ error: "query is required" });
        return;
      }
      const cmd = parseCommand(`!play ${platformFlag(platform)} ${query}`.trim(), "!");
      if (!cmd) {
        res.status(400).json({ error: "Invalid command" });
        return;
      }
      const response = await bot.executeCommand(cmd, undefined, requesterName(req));
      res.json({ message: response });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/:botId/add", authorize({ capability: "player.queue", guestFlag: "addToQueue" }), async (req, res) => {
    try {
      const bot = (req as any).bot;
      const { query, platform } = req.body;
      const cmd = parseCommand(`!add ${platformFlag(platform)} ${query}`.trim(), "!");
      if (!cmd) {
        res.status(400).json({ error: "Invalid command" });
        return;
      }
      const response = await bot.executeCommand(cmd, undefined, requesterName(req));
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

  router.post("/:botId/pause", authorize({ capability: "player.control", guestFlag: "transport" }), simpleCommand("!pause"));
  router.post("/:botId/resume", authorize({ capability: "player.control", guestFlag: "transport" }), simpleCommand("!resume"));
  router.post("/:botId/next", authorize({ capability: "player.control", guestFlag: "skip" }), simpleCommand("!next"));
  router.post("/:botId/prev", authorize({ capability: "player.control" }), simpleCommand("!prev"));
  router.post("/:botId/stop", authorize({ capability: "player.control" }), simpleCommand("!stop"));
  router.post("/:botId/clear", authorize({ capability: "player.queue", guestFlag: "removeClear" }), simpleCommand("!clear"));

  router.post("/:botId/fm", authorize({ capability: "player.control", guestFlag: "playMode" }), async (req, res) => {
    try {
      const bot = (req as any).bot;
      const { platform } = req.body;
      if (isLocalAudioDisabled(bot, platform)) {
        rejectDisabledLocalAudio(res);
        return;
      }
      const provider = bot.getProviderFor(
        platform === "bilibili" || platform === "qq" || platform === "youtube" || platform === "local" || platform === "kugou"
          ? platform
          : "netease"
      );
      const message = await bot.startFm(provider, requesterName(req));
      res.json({
        ok:
          !message.startsWith("No FM songs") &&
          !message.includes("not available") &&
          !message.includes("not connected"),
        message,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/:botId/volume", authorize({ capability: "player.control", guestFlag: "transport" }), async (req, res) => {
    try {
      const bot = (req as any).bot;
      const { volume } = req.body;
      // Reject bad input with a proper 4xx instead of letting cmdVol
      // return a "Usage:" string inside a 200 body — API clients can't
      // detect that failure mode, and the UI would silently swallow it.
      if (
        typeof volume !== "number" ||
        !Number.isFinite(volume) ||
        volume < 0 ||
        volume > 100
      ) {
        res
          .status(400)
          .json({ error: "volume must be a number between 0 and 100" });
        return;
      }
      const cmd = parseCommand(`!vol ${Math.round(volume)}`, "!")!;
      const response = await bot.executeCommand(cmd);
      res.json({ message: response });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  const VALID_MODES = new Set(["seq", "loop", "random", "rloop"]);

  router.post("/:botId/mode", authorize({ capability: "player.control", guestFlag: "playMode" }), async (req, res) => {
    try {
      const bot = (req as any).bot;
      const { mode } = req.body;
      if (typeof mode !== "string" || !VALID_MODES.has(mode)) {
        res
          .status(400)
          .json({ error: "mode must be one of: seq, loop, random, rloop" });
        return;
      }
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
  router.post("/:botId/seek", authorize({ capability: "player.control", guestFlag: "transport" }), async (req, res) => {
    try {
      const bot = (req as any).bot;
      const { position } = req.body; // seconds
      // typeof NaN === "number" and NaN < 0 is false, so a plain range
      // check lets NaN/Infinity through and later corrupts seekOffset.
      if (typeof position !== "number" || !Number.isFinite(position) || position < 0) {
        res
          .status(400)
          .json({ error: "position must be a finite non-negative number" });
        return;
      }
      bot.seek(position);
      res.json({ message: `Seeked to ${Math.floor(position)}s`, seekOffset: position });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/:botId/queue", (req, res) => {
    const bot = (req as any).bot;
    res.json({ queue: bot.getQueue(), status: bot.getStatus() });
  });

  router.delete("/:botId/queue/:index", authorize({ capability: "player.queue", guestFlag: "removeClear" }), async (req, res) => {
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
  router.post("/:botId/play-at", authorize({ capability: "player.control" }), async (req, res) => {
    try {
      const bot = (req as any).bot;
      const { index } = req.body;
      if (typeof index !== "number" || index < 0) {
        res.status(400).json({ error: "index is required" });
        return;
      }
      // Serialize the index-validation + stop/reset/playAt/resolveAndPlay so a
      // concurrent request can't interleave between mutating the queue and
      // starting playback (audible track must match queue.currentIndex).
      const result = await bot.runExclusive(async () => {
        const queue = bot.getQueueManager();
        // Validate the index BEFORE stopping current playback — otherwise an
        // invalid index silently kills the user's current song and leaves the
        // queue idle.
        if (index >= queue.size()) {
          return { status: 400 as const, body: { error: "Invalid queue index" } };
        }
        bot.getPlayer().stop();
        bot.getPlayer().resetFailures();
        const song = queue.playAt(index);
        if (!song) {
          return { status: 400 as const, body: { error: "Invalid queue index" } };
        }
        const ok = await bot.resolveAndPlay(song);
        if (!ok) {
          return { body: { message: `Cannot play: ${song.name}` } };
        }
        return { body: { message: `Now playing: ${song.name} - ${song.artist}` } };
      });
      if (result.status) {
        res.status(result.status).json(result.body);
        return;
      }
      res.json(result.body);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/:botId/playlist", authorize({ capability: "player.queue" }), async (req, res) => {
    try {
      const bot = (req as any).bot;
      const { playlistId, platform } = req.body;
      const cmd = parseCommand(
        `!playlist ${platformFlag(platform)} ${playlistId}`.trim(),
        "!"
      )!;
      const response = await bot.executeCommand(cmd, undefined, requesterName(req));
      res.json({ message: response });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Play a playlist by ID — stores metadata only, resolves URL for first song
  // Respects current play mode (random = pick random first song)
  router.post("/:botId/play-playlist", authorize({ capability: "player.control", guestFlag: "playCollection" }), async (req, res) => {
    try {
      const bot = (req as any).bot;
      const { playlistId, platform } = req.body;
      if (isLocalAudioDisabled(bot, platform)) {
        rejectDisabledLocalAudio(res);
        return;
      }
      // Use the bot's own provider lookup — it already knows about youtube,
      // which the router's constructor params did not.
      const provider = bot.getProviderFor(
        platform === "bilibili" || platform === "qq" || platform === "youtube" || platform === "local" || platform === "kugou"
          ? platform
          : "netease"
      );

      // Stop current playback
      bot.getPlayer().stop();
      bot.getPlayer().resetFailures();

      const songs = await provider.getPlaylistSongs(playlistId);
      if (songs.length === 0) {
        res.json({ message: "Playlist is empty" });
        return;
      }

      // QQ-specific optimization: many users' QQ playlists contain a
      // large fraction of songs that return result=104003 (region/copyright
      // restricted). Batch-resolve URLs once and only queue the playable
      // ones, otherwise the playback retry loop wastes time guessing.
      let queueable: { id: string }[] = songs;
      const totalCount = songs.length;
      const qqLike = provider as { getPlayableSongIds?: (ids: string[]) => Promise<Set<string> | null> };
      if (typeof qqLike.getPlayableSongIds === "function") {
        const playable = await qqLike.getPlayableSongIds(songs.map((s: { id: string }) => s.id));
        if (playable !== null) {
          // Authoritative answer from upstream — even an empty set means
          // "we know none are playable", short-circuit immediately rather
          // than wasting 20+ retries.
          queueable = songs.filter((s: { id: string }) => playable.has(s.id));
        }
        // If null, the batch endpoint itself errored — fall through to
        // the sequential retry path, which still has a chance.
      }
      if (queueable.length === 0) {
        res.json({ ok: false, message: `歌单 ${totalCount} 首歌曲均无版权可播放（区域/版权限制）` });
        return;
      }

      const queue = bot.getQueueManager();
      queue.clear();
      for (const song of queueable) {
        queue.add({ ...song, platform: provider.platform, requestedBy: requesterName(req) });
      }
      // Sweep AFTER the queue is rebuilt: the previous queue's local uploads are
      // released and deleted, but an empty/failed playlist (early return above)
      // leaves the previous queue — and its files — intact.
      bot.cleanupQueuedLocalSongs?.("queue_replaced");

      // Use queue.play() for sequential, or pick random index for random modes
      const mode = queue.getMode();
      let first;
      if (mode === "random" || mode === "rloop") {
        const idx = Math.floor(Math.random() * queue.size());
        first = queue.playAt(idx);
      } else {
        first = queue.play();
      }

      // If the first picked song can't resolve (e.g., QQ song with no
      // streaming entitlement → result 104003), fall back to playNext's
      // retry-skip behavior. Use a higher retry budget than the default
      // trackEnd auto-advance because user-initiated playlist plays
      // commonly have long contiguous runs of unplayable songs.
      let started = first ? await bot.resolveAndPlay(first) : false;
      if (first && !started) {
        started = await bot.playNext(20);
      }

      const playing = queue.current();
      const loadedMsg = queueable.length < totalCount
        ? `已加载 ${queueable.length}/${totalCount} 首（其余区域/版权限制）`
        : `已加载 ${queueable.length} 首`;
      if (started && playing) {
        res.json({ ok: true, message: `${loadedMsg}，正在播放：${playing.name}` });
      } else {
        res.json({ ok: false, message: `${loadedMsg}，但无法开始播放。` });
      }
    } catch (err) {
      logger.error({ err }, "Play playlist failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Play an album by ID — mirrors play-playlist but calls getAlbumSongs
  router.post("/:botId/play-album", authorize({ capability: "player.control", guestFlag: "playCollection" }), async (req, res) => {
    try {
      const bot = (req as any).bot;
      const { albumId, platform } = req.body;
      if (isLocalAudioDisabled(bot, platform)) {
        rejectDisabledLocalAudio(res);
        return;
      }
      const provider = bot.getProviderFor(
        platform === "bilibili" || platform === "qq" || platform === "youtube" || platform === "local" || platform === "kugou"
          ? platform
          : "netease"
      );

      // Stop current playback
      bot.getPlayer().stop();
      bot.getPlayer().resetFailures();

      const songs = await provider.getAlbumSongs(albumId);
      if (songs.length === 0) {
        res.json({ message: "Album is empty" });
        return;
      }

      // QQ-specific optimization: batch-resolve playable IDs to avoid
      // wasting retries on region/copyright-restricted tracks.
      let queueable: { id: string }[] = songs;
      const totalCount = songs.length;
      const qqLike = provider as { getPlayableSongIds?: (ids: string[]) => Promise<Set<string> | null> };
      if (typeof qqLike.getPlayableSongIds === "function") {
        const playable = await qqLike.getPlayableSongIds(songs.map((s: { id: string }) => s.id));
        if (playable !== null) {
          queueable = songs.filter((s: { id: string }) => playable.has(s.id));
        }
      }
      if (queueable.length === 0) {
        res.json({ ok: false, message: `专辑 ${totalCount} 首歌曲均无版权可播放（区域/版权限制）` });
        return;
      }

      const queue = bot.getQueueManager();
      queue.clear();
      for (const song of queueable) {
        queue.add({ ...song, platform: provider.platform, requestedBy: requesterName(req) });
      }
      // Sweep AFTER the queue is rebuilt (see play-playlist).
      bot.cleanupQueuedLocalSongs?.("queue_replaced");

      const mode = queue.getMode();
      let first;
      if (mode === "random" || mode === "rloop") {
        const idx = Math.floor(Math.random() * queue.size());
        first = queue.playAt(idx);
      } else {
        first = queue.play();
      }

      let started = first ? await bot.resolveAndPlay(first) : false;
      if (first && !started) {
        started = await bot.playNext(20);
      }

      const playing = queue.current();
      const loadedMsg = queueable.length < totalCount
        ? `已加载 ${queueable.length}/${totalCount} 首（其余区域/版权限制）`
        : `已加载 ${queueable.length} 首`;
      if (started && playing) {
        res.json({ ok: true, message: `${loadedMsg}，正在播放：${playing.name}` });
      } else {
        res.json({ ok: false, message: `${loadedMsg}，但无法开始播放。` });
      }
    } catch (err) {
      logger.error({ err }, "play-album failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Play a single song by ID — resolves URL on demand
  router.post("/:botId/play-song", authorize({ capability: "player.control" }), async (req, res) => {
    try {
      const bot = (req as any).bot;
      const { song } = req.body;
      if (!song || !song.id || !song.platform) {
        res.status(400).json({ error: "song object with id and platform is required" });
        return;
      }
      if (isLocalAudioDisabled(bot, song.platform)) {
        rejectDisabledLocalAudio(res);
        return;
      }
      const queue = bot.getQueueManager();
      bot.getPlayer().stop();
      queue.clear();
      queue.add({ ...song, requestedBy: requesterName(req) });
      queue.play();

      bot.getPlayer().resetFailures();
      const ok = await bot.resolveAndPlay(queue.current()!);
      // Sweep AFTER the new song is queued+resolved, so replaying a local song
      // that was still in the queue doesn't delete the file we're about to play.
      bot.cleanupQueuedLocalSongs?.("queue_replaced");
      if (!ok) {
        res.json({ ok: false, message: `无法播放「${song.name || song.id}」（区域/版权限制）` });
        return;
      }

      res.json({ ok: true, message: `正在播放：${song.name || 'Unknown'} - ${song.artist || 'Unknown'}` });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Insert a single song to play right after the current one.
  // If nothing is playing, behaves like /play-song (start immediately).
  router.post("/:botId/play-next-song", authorize({ capability: "player.control", guestFlag: "playNext" }), async (req, res) => {
    try {
      const bot = (req as any).bot;
      const { song } = req.body;
      if (!song || !song.id || !song.platform) {
        res.status(400).json({ error: "song object with id and platform is required" });
        return;
      }
      if (isLocalAudioDisabled(bot, song.platform)) {
        rejectDisabledLocalAudio(res);
        return;
      }
      // Serialize the queue mutation + playback so concurrent requests can't
      // interleave (audible track must match queue.currentIndex).
      const body = await bot.runExclusive(async () => {
        const queue = bot.getQueueManager();
        const wasIdle = bot.getPlayer().getState() === "idle";
        // Capture the slot addNext WILL insert at, before mutating the queue.
        // addNext pushes when currentIndex<0 (slot = size); otherwise splices
        // at currentIndex+1. Using size-1 after addNext was wrong when the
        // queue had stale currentIndex>=0 while the player was idle (e.g.,
        // after natural track end without queue.clear()).
        const insertedAt =
          queue.getCurrentIndex() < 0 ? queue.size() : queue.getCurrentIndex() + 1;
        queue.addNext({ ...song, requestedBy: requesterName(req) });

        if (wasIdle) {
          // Promote the just-added song to current and start it.
          queue.playAt(insertedAt);
          bot.getPlayer().resetFailures();
          const ok = await bot.resolveAndPlay(queue.current()!);
          if (!ok) {
            return { ok: false, message: `无法播放「${song.name || song.id}」（区域/版权限制）` };
          }
          return { ok: true, message: `正在播放：${song.name || 'Unknown'} - ${song.artist || 'Unknown'}` };
        }

        return { ok: true, message: `已加入下一首：${song.name || 'Unknown'} - ${song.artist || 'Unknown'}` };
      });
      res.json(body);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Play a song "now" without clearing the queue: insert after current, then
  // promote to current and start it. Non-destructive (unlike /play-song which
  // clears the whole queue) — this is the guest-safe "play now".
  router.post("/:botId/play-now-song", authorize({ capability: "player.control", guestFlag: "playNow" }), async (req, res) => {
    try {
      const bot = (req as any).bot;
      const { song } = req.body;
      if (!song || !song.id || !song.platform) {
        res.status(400).json({ error: "song object with id and platform is required" });
        return;
      }
      if (isLocalAudioDisabled(bot, song.platform)) {
        rejectDisabledLocalAudio(res);
        return;
      }
      // Serialize the insert-after-current + promote + playback so concurrent
      // requests can't interleave (audible track must match queue.currentIndex).
      const body = await bot.runExclusive(async () => {
        const queue = bot.getQueueManager();
        const insertedAt =
          queue.getCurrentIndex() < 0 ? queue.size() : queue.getCurrentIndex() + 1;
        queue.addNext({ ...song, requestedBy: requesterName(req) });
        queue.playAt(insertedAt);
        bot.getPlayer().resetFailures();
        const ok = await bot.resolveAndPlay(queue.current()!);
        if (!ok) {
          return { ok: false, message: `无法播放「${song.name || song.id}」（区域/版权限制）` };
        }
        return { ok: true, message: `正在播放：${song.name || "Unknown"} - ${song.artist || "Unknown"}` };
      });
      res.json(body);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/:botId/add-song", authorize({ capability: "player.queue", guestFlag: "addToQueue" }), async (req, res) => {
    try {
      const bot = (req as any).bot;
      const { song } = req.body;
      if (!song || !song.id || !song.platform) {
        res.status(400).json({ error: "song object with id and platform is required" });
        return;
      }
      if (isLocalAudioDisabled(bot, song.platform)) {
        rejectDisabledLocalAudio(res);
        return;
      }
      // Serialize the queue mutation + (possible) playback so concurrent
      // requests can't interleave (audible track must match queue.currentIndex).
      const body = await bot.runExclusive(async () => {
        const queue = bot.getQueueManager();
        const wasIdle = bot.getPlayer().getState() === "idle";
        queue.add({ ...song, requestedBy: requesterName(req) });

        // If nothing was playing, start this newly-added song immediately.
        if (wasIdle) {
          queue.playAt(queue.size() - 1);
          bot.getPlayer().resetFailures();
          await bot.resolveAndPlay(queue.current()!);
          return { message: `Now playing: ${song.name || 'Unknown'} - ${song.artist || 'Unknown'}` };
        }

        return { message: `Added to queue: ${song.name || 'Unknown'} - ${song.artist || 'Unknown'} (position ${queue.size()})` };
      });
      res.json(body);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Add a song to queue by ID — metadata only
  router.post("/:botId/add-by-id", authorize({ capability: "player.queue", guestFlag: "addToQueue" }), async (req, res) => {
    try {
      const bot = (req as any).bot;
      const { songId, platform } = req.body;
      if (isLocalAudioDisabled(bot, platform)) {
        rejectDisabledLocalAudio(res);
        return;
      }
      const provider = bot.getProviderFor(
        platform === "bilibili" || platform === "qq" || platform === "youtube" || platform === "local" || platform === "kugou"
          ? platform
          : "netease"
      );

      const song = await provider.getSongDetail(songId);
      if (!song) {
        res.json({ message: "Song not found" });
        return;
      }

      const queue = bot.getQueueManager();
      queue.add({ ...song, platform: provider.platform, requestedBy: requesterName(req) });

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

  // --- Profile config endpoints ---

  router.get("/:botId/profile", (req, res) => {
    const bot = (req as any).bot;
    res.json(bot.getProfileManager().getConfig());
  });

  router.put("/:botId/profile", authorize({ capability: "bot.manage" }), (req, res) => {
    try {
      const bot = (req as any).bot;
      const pm = bot.getProfileManager();
      pm.updateConfig(req.body);
      if (database) {
        database.saveProfileConfig(bot.id, pm.getConfig());
      }
      res.json(pm.getConfig());
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
      requestedBy: r.requestedBy,
    }));
    res.json({ history });
  });

  return router;
}
