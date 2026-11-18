import { Router, type Request } from "express";
import type { BotInstance } from "../../bot/instance.js";
import { blocksProviderForAdvance } from "../../bot/url-retry.js";
import type { QueuedSong } from "../../audio/queue.js";
import type { BotManager } from "../../bot/manager.js";
import type { BotDatabase } from "../../data/database.js";
import type { MusicProvider, Song, ArtistSongPage, PlayFailure } from "../../music/provider.js";
import { musicRequestError } from "../../music/request-error.js";
import type { Logger } from "../../logger.js";
import { parseCommand } from "../../bot/commands.js";
import { requireBotAccess } from "../middleware/requirePermission.js";
import { authorize } from "../middleware/authorize.js";
import { resolveProviderForRequest } from "./provider-scope.js";

/** Hard cap on how many tracks one "播放全部" request may queue — a safety net
 *  against a pathological catalogue (and against an upstream paging bug). */
const MAX_ARTIST_QUEUE = 500;
const ARTIST_QUEUE_PAGE = 100;
const MAX_HISTORY_DELETE_BATCH = 500;

function isHistoryRowId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Walks every page of an artist's catalogue (best-first, de-duplicated). */
export async function collectArtistSongs(
  fetchPage: (artistId: string, offset?: number, limit?: number) => Promise<ArtistSongPage>,
  artistId: string
): Promise<Song[]> {
  const songs: Song[] = [];
  const seen = new Set<string>();
  for (let offset = 0; offset < MAX_ARTIST_QUEUE; offset += ARTIST_QUEUE_PAGE) {
    const page = await fetchPage(artistId, offset, ARTIST_QUEUE_PAGE);
    for (const song of page.songs) {
      if (!seen.has(song.id)) {
        seen.add(song.id);
        songs.push(song);
        if (songs.length === MAX_ARTIST_QUEUE) return songs;
      }
    }
    if (!page.hasMore || page.songs.length === 0) break;
  }
  return songs;
}

async function filterCollectionForRoom(
  bot: BotInstance,
  platform: Song["platform"],
  songs: Song[],
): Promise<Song[]> {
  if (platform !== "qq") return songs;
  // Metadata can come from the caller's account. Room playback uses the
  // bot's shared account, so its entitlements must drive the batch check too.
  const playbackProvider = bot.getProviderFor("qq") as MusicProvider & {
    getPlayableSongIds?: (ids: string[]) => Promise<Set<string> | null>;
  };
  const available = await playbackProvider.getPlayableSongIds?.(songs.map(song => song.id));
  return available ? songs.filter(song => available.has(song.id)) : songs;
}

export function createPlayerRouter(
  botManager: BotManager,
  logger: Logger,
  database?: BotDatabase,
  neteaseProvider?: MusicProvider,
  qqProvider?: MusicProvider,
  bilibiliProvider?: MusicProvider,
  // Per-user music accounts (#164 follow-up). Omitted by unit-test routers →
  // the feature reads as off and every request uses the shared login.
  config?: { perUserMusicAccounts?: boolean },
): Router {
  const router = Router();

  /** Platform names the bot resolves as-is; anything else means NetEase. */
  const PASSTHROUGH = new Set(["bilibili", "qq", "youtube", "local", "kugou", "jellyfin"]);
  const sharedProviderFor = (bot: any, platform: unknown): MusicProvider =>
    bot.getProviderFor(PASSTHROUGH.has(platform as string) ? platform : "netease");

  /**
   * The provider this request should read from. With per-user accounts enabled,
   * a caller who linked their own account gets a view built from THEIR cookie;
   * otherwise the bot's shared provider comes back untouched.
   */
  const scopedProvider = (req: Request, bot: any, platform: unknown): MusicProvider => {
    const shared = sharedProviderFor(bot, platform);
    return resolveProviderForRequest(req, shared.platform, shared, { database, config });
  };

  /**
   * Personal FM predates the admin toggle (#164), so a linked account has always
   * driven it. `alwaysPersonal` keeps that guarantee while the toggle is off;
   * with the toggle on, FM simply inherits the same account as everything else.
   */
  const fmProvider = (req: Pick<Request, "user">, bot: any, platform: unknown): MusicProvider => {
    const shared = sharedProviderFor(bot, platform);
    return resolveProviderForRequest(req, shared.platform, shared, { database, config }, {
      alwaysPersonal: true,
    });
  };

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

  const whyUnplayable = (song: { name?: string; id?: string }, reason?: string): string => {
    const label = song.name || song.id || "这首歌";
    return reason ? `无法播放「${label}」：${reason}` : `无法播放「${label}」`;
  };

  async function startCollection(
    bot: BotInstance, songs: Song[], platform: Song["platform"], requestedBy: string | undefined, totalCount: number,
  ) {
    return bot.runExclusive(async () => {
      bot.getPlayer().stop();
      bot.getPlayer().resetFailures();
      const queue = bot.getQueueManager();
      queue.clear();
      for (const song of songs) {
        queue.add({ ...song, platform, requestedBy });
      }
      bot.cleanupQueuedLocalSongs?.("queue_replaced");

      const mode = queue.getMode();
      const first: QueuedSong | null = mode === "random" || mode === "rloop"
        ? queue.playAt(Math.floor(Math.random() * queue.size()))
        : queue.play();
      // Publish the new idle queue even if the first URL lookup ultimately fails.
      bot.emit("stateChange");

      let failure: PlayFailure | undefined;
      const capture = (reason: PlayFailure) => { failure = reason; };
      let started = first ? await bot.resolveAndPlay(first, capture) : false;
      if (first && !started && failure && !blocksProviderForAdvance(failure.code) && queue.current() === first) {
        // Many collections contain several consecutive unavailable tracks.
        started = await bot.playNext(20, capture);
      }

      const playing = queue.current();
      const loaded = songs.length < totalCount
        ? `已加载 ${songs.length}/${totalCount} 首（其余无法播放）`
        : `已加载 ${songs.length} 首`;
      const reason = failure?.message;
      return started && playing
        ? { ok: true, message: `${loaded}，正在播放：${playing.name}` }
        : { ok: false, message: `${loaded}，但无法开始播放${reason ? `：${reason}` : "。"}` };
    });
  }

  /** Map API platform string to the corresponding command flag. */
  const platformFlag = (platform: unknown): string => {
    if (platform === "bilibili") return "-b";
    if (platform === "qq") return "-q";
    if (platform === "youtube") return "-y";
    if (platform === "kugou") return "-k";
    if (platform === "jellyfin") return "-j";
    // The flag-less default is now the configured default platform (jellyfin
    // unless disabled), so netease needs an explicit flag.
    if (platform === "netease") return "-n";
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
  router.post("/:botId/next", authorize({ capability: "player.control", guestFlag: "skip" }), async (req, res) => {
    try {
      const bot: BotInstance = (req as any).bot;
      res.json(await bot.skipToNext());
    } catch (err) {
      res.status(500).json({ error: musicRequestError(err).message });
    }
  });
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
      // Resolve FM recommendations with the caller's account. The bot resolves
      // each queued track's playback URL using the shared account.
      const scope = { user: req.user };
      const resolveFmProvider = () => fmProvider(scope, bot, platform);
      const message = await bot.startFm(resolveFmProvider(), requesterName(req), resolveFmProvider);
      res.json({
        ok: message.startsWith("Personal FM started") || message.startsWith("QQ Radar FM started"),
        message,
      });
    } catch (err) {
      res.status(500).json({ error: musicRequestError(err).message });
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
      const bot: BotInstance = (req as any).bot;
      const { index } = req.body;
      if (!Number.isSafeInteger(index) || index < 0) {
        res.status(400).json({ error: "index must be a non-negative integer" });
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
        const song = queue.playAt(index);
        if (!song) {
          return { status: 400 as const, body: { error: "Invalid queue index" } };
        }
        const player = bot.getPlayer();
        player.stop(true);
        player.resetFailures();
        const session = player.getPlaybackSessionId();
        bot.emit("stateChange");
        let reason: string | undefined;
        const ok = await bot.resolveAndPlay(song, failure => { reason = failure.message; });
        if (!ok) {
          // Abandon this transition's silence loop, leaving newer playback alone.
          if (queue.current() === song && player.getPlaybackSessionId() === session) player.stop();
          return { body: { ok: false, message: whyUnplayable(song, reason) } };
        }
        return { body: { ok: true, message: `Now playing: ${song.name} - ${song.artist}` } };
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
      const provider = scopedProvider(req, bot, platform);

      const songs = await provider.getPlaylistSongs(playlistId);
      if (songs.length === 0) {
        res.json({ ok: false, message: "Playlist is empty" });
        return;
      }

      const totalCount = songs.length;
      const queueable = await filterCollectionForRoom(bot, provider.platform, songs);
      if (queueable.length === 0) {
        res.json({ ok: false, message: `歌单 ${totalCount} 首歌曲均无法播放` });
        return;
      }

      res.json(await startCollection(bot, queueable, provider.platform, requesterName(req), totalCount));
    } catch (err) {
      const error = musicRequestError(err);
      logger.error({ err: error }, "Play playlist failed");
      res.status(500).json({ error: error.message });
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
      const provider = scopedProvider(req, bot, platform);

      const songs = await provider.getAlbumSongs(albumId);
      if (songs.length === 0) {
        res.json({ ok: false, message: "Album is empty" });
        return;
      }

      const totalCount = songs.length;
      const queueable = await filterCollectionForRoom(bot, provider.platform, songs);
      if (queueable.length === 0) {
        res.json({ ok: false, message: `专辑 ${totalCount} 首歌曲均无法播放` });
        return;
      }

      res.json(await startCollection(bot, queueable, provider.platform, requesterName(req), totalCount));
    } catch (err) {
      const error = musicRequestError(err);
      logger.error({ err: error }, "play-album failed");
      res.status(500).json({ error: error.message });
    }
  });

  // Play an artist's songs. An artist page queues the singer's FULL catalogue —
  // never just the hot 50 — so this pages through getArtistAllSongs when the
  // source can page a catalogue, and falls back to getArtistSongs (hot songs)
  // when it cannot.
  router.post("/:botId/play-artist", authorize({ capability: "player.control", guestFlag: "playCollection" }), async (req, res) => {
    try {
      const bot = (req as any).bot;
      const { artistId, platform } = req.body;
      if (!artistId) {
        res.status(400).json({ error: "artistId is required" });
        return;
      }
      if (isLocalAudioDisabled(bot, platform)) {
        rejectDisabledLocalAudio(res);
        return;
      }
      const provider = scopedProvider(req, bot, platform);
      if (typeof provider.getArtistSongs !== "function") {
        res.status(501).json({ error: "Not supported by this provider" });
        return;
      }
      // Whole catalogue when the source can page it (bounded by the collector's
      // safety cap); otherwise the hot songs are the best it can offer.
      const fetchPage = provider.getArtistAllSongs?.bind(provider);

      const songs = fetchPage
        ? await collectArtistSongs(fetchPage, artistId)
        : await provider.getArtistSongs(artistId, 50);
      if (songs.length === 0) {
        res.json({ ok: false, message: "该歌手暂无可用歌曲" });
        return;
      }

      const totalCount = songs.length;
      const queueable = await filterCollectionForRoom(bot, provider.platform, songs);
      if (queueable.length === 0) {
        res.json({ ok: false, message: `歌手 ${totalCount} 首歌曲均无法播放` });
        return;
      }

      res.json(await startCollection(bot, queueable, provider.platform, requesterName(req), totalCount));
    } catch (err) {
      const error = musicRequestError(err);
      logger.error({ err: error }, "play-artist failed");
      res.status(500).json({ error: error.message });
    }
  });

  // Play a single song by ID — resolves URL on demand. Funnels through
  // bot.playSingleSong so the config.playKeepsQueue decision (clear-and-play vs
  // insert-and-jump, keeping the queue) lives in one place shared with chat
  // !play. Serialized via runExclusive like /play-now-song so concurrent
  // requests can't interleave the queue mutation + playback (#119).
  router.post("/:botId/play-song", authorize({ capability: "player.control" }), async (req, res) => {
    try {
      const bot: BotInstance = (req as any).bot;
      const { song } = req.body;
      if (!song || !song.id || !song.platform) {
        res.status(400).json({ error: "song object with id and platform is required" });
        return;
      }
      if (isLocalAudioDisabled(bot, song.platform)) {
        rejectDisabledLocalAudio(res);
        return;
      }
      // The cleanupQueuedLocalSongs sweep now lives inside playSingleSong's
      // clear branch — do NOT also call it here, or it would delete retained
      // local uploads in keep-queue mode.
      const body = await bot.runExclusive(async () => {
        let errorMessage = whyUnplayable(song);
        const ok = await bot.playSingleSong({ ...song }, requesterName(req), (failure, currentTrackContinues) => {
          errorMessage = currentTrackContinues
            ? `未能重新播放「${song.name || song.id}」，当前曲目继续播放：${failure.message}`
            : whyUnplayable(song, failure.message);
        });
        return ok
          ? { ok: true, message: `正在播放：${song.name || 'Unknown'} - ${song.artist || 'Unknown'}` }
          : { ok: false, message: errorMessage };
      });
      res.json(body);
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
          let reason: string | undefined;
          const ok = await bot.resolveAndPlay(queue.current()!, (failure: PlayFailure) => { reason = failure.message; });
          if (!ok) {
            return { ok: false, message: whyUnplayable(song, reason) };
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
        let reason: string | undefined;
        const ok = await bot.resolveAndPlay(queue.current()!, (failure: PlayFailure) => { reason = failure.message; });
        if (!ok) {
          return { ok: false, message: whyUnplayable(song, reason) };
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
      const bot: BotInstance = (req as any).bot;
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
          const added = queue.playAt(queue.size() - 1)!;
          bot.getPlayer().resetFailures();
          let reason: string | undefined;
          const ok = await bot.resolveAndPlay(added, failure => { reason = failure.message; });
          if (!ok) {
            bot.emit("stateChange");
            return { ok: false, message: `已加入队列，但${whyUnplayable(added, reason)}` };
          }
          return { ok: true, message: `Now playing: ${song.name || 'Unknown'} - ${song.artist || 'Unknown'}` };
        }

        return { ok: true, message: `Added to queue: ${song.name || 'Unknown'} - ${song.artist || 'Unknown'} (position ${queue.size()})` };
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
      const provider = scopedProvider(req, bot, platform);

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
      res.status(500).json({ error: musicRequestError(err).message });
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
      // rowId is the history row primary key — needed to delete a single record.
      // `id` stays the platform song id so existing players keep working.
      rowId: r.id,
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

  // Delete one history record: /:botId/history/:rowId
  router.delete(
    "/:botId/history/:rowId",
    authorize({ capability: "player.queue", guestFlag: "removeClear" }),
    (req, res) => {
      if (!database) {
        res.status(404).json({ error: "history unavailable" });
        return;
      }
      const rowId = Number(req.params.rowId);
      if (!/^\d+$/.test(req.params.rowId) || !isHistoryRowId(rowId)) {
        res.status(400).json({ error: "invalid rowId" });
        return;
      }
      const deleted = database.deletePlayHistory(req.params.botId, [rowId]);
      res.json({ deleted });
    }
  );

  // Batch delete / clear all: body { ids: number[] } or { all: true }
  router.delete(
    "/:botId/history",
    authorize({ capability: "player.queue", guestFlag: "removeClear" }),
    (req, res) => {
      if (!database) {
        res.status(404).json({ error: "history unavailable" });
        return;
      }
      const body = (req.body ?? {}) as { ids?: unknown; all?: unknown };
      if (body.all === true && body.ids === undefined) {
        const deleted = database.clearPlayHistory(req.params.botId);
        res.json({ deleted });
        return;
      }
      const { ids } = body;
      if (body.all !== undefined || !Array.isArray(ids) || ids.length === 0 ||
          ids.length > MAX_HISTORY_DELETE_BATCH || !ids.every(isHistoryRowId)) {
        res.status(400).json({ error: "Provide 1 to 500 history IDs or all:true" });
        return;
      }
      const deleted = database.deletePlayHistory(req.params.botId, ids);
      res.json({ deleted });
    }
  );

  return router;
}
