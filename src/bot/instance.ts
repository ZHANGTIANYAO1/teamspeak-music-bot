import { EventEmitter } from "node:events";
import {
  TS3Client,
  type TS3ClientOptions,
  type TS3TextMessage,
} from "../ts-protocol/client.js";
import { AudioPlayer } from "../audio/player.js";
import { PlayQueue, PlayMode, type QueuedSong } from "../audio/queue.js";
import type { MusicProvider, Song } from "../music/provider.js";
import {
  parseCommand,
  canRunCommand,
  type ParsedCommand,
} from "./commands.js";
import { parseSongRef, parseSelectionIndex } from "./song-ref.js";
import { splitTextIntoChunks } from "./text-chunk.js";
import type { Logger } from "../logger.js";
import type { BotDatabase, ProfileConfig } from "../data/database.js";
import type { BotConfig, SpotifyConfig } from "../data/config.js";
import { BotProfileManager } from "./profile.js";
import type { AvatarStore } from "../data/avatars.js";
import {
  decideOccupancyAction,
  occupancyFromClientList,
  shouldResumeOnReturn,
} from "./auto-pause.js";
import { isSpotifyUri } from "../music/spotify/webapi.js";
import path from "node:path";
import { SpotifyController } from "../music/spotify/controller.js";
import type { SpotifyTrackEndedEvent } from "../music/spotify/backend.js";
import type { SpotifyOAuth } from "../music/spotify/spotify-oauth.js";

/** Reply sent when a non-admin invokes an admin-only chat command. */
export const COMMAND_DENIED_MESSAGE = "⛔ 需要管理员权限（该命令仅限管理员服务器组）";

/** Fallback message when Spotify audio can't be served (backend unavailable
 *  OR a per-track playTrack failure against a dead/failed sidecar). */
const SPOTIFY_UNAVAILABLE_MESSAGE =
  "⚠️ Spotify 播放尚未启用（需要 librespot 音频后端，将在后续版本支持）。";

/** FNV-1a deterministic string hash (unsigned 32-bit). Stable across restarts
 *  and processes, unlike a random/insertion-order value — used to derive
 *  per-bot go-librespot ports. */
function stableHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * STABLE per-bot go-librespot ports derived from the bot id, kept fixed across
 * restarts. The two ranges (37xx / 87xx) are disjoint so a single bot's API and
 * callback ports never clash with each other.
 *
 * NOTE: the hash (`% 1000`) only REDUCES collisions between bots — it does NOT
 * guarantee uniqueness. Two Spotify-enabled bots whose ids collide mod 1000
 * (birthday-bound: likely well below 1000 bots) get IDENTICAL ports; the second
 * bot's go-librespot sidecar then fails to bind 127.0.0.1:<apiPort>, start()
 * throws, and that bot's Spotify stays permanently unavailable. Proper fix (out
 * of scope here): assign each Spotify-enabled bot a unique free port —
 * manager-coordinated allocation or bind-retry on EADDRINUSE — instead of a
 * pure hash.
 */
export function spotifyPortsForBotId(id: string): { apiPort: number; callbackPort: number } {
  const off = stableHash(id) % 1000;
  return { apiPort: 3700 + off, callbackPort: 8700 + off };
}

export interface BotInstanceOptions {
  id: string;
  name: string;
  tsOptions: TS3ClientOptions;
  neteaseProvider: MusicProvider;
  qqProvider: MusicProvider;
  bilibiliProvider: MusicProvider;
  youtubeProvider: MusicProvider;
  localProvider?: MusicProvider;
  kugouProvider?: MusicProvider;
  spotifyProvider?: MusicProvider;
  database: BotDatabase;
  config: BotConfig;
  logger: Logger;
  avatarStore: AvatarStore;
  /** Base dir (under DATA_DIR) for per-bot go-librespot work/config trees. */
  spotifyDataDir?: string;
  /** Process-wide shared Spotify OAuth (single account); injected into the
   *  SpotifyController so web-login authorization is visible to playback (C3.1). */
  spotifyOAuth?: SpotifyOAuth;
  /** Test seam: build a fake controller instead of a real go-librespot one. */
  spotifyControllerFactory?: (o: {
    config: SpotifyConfig;
    workDir: string;
    configDir: string;
    logger: Logger;
    instanceId: string;
    apiPort: number;
    callbackPort: number;
    oauth?: SpotifyOAuth;
  }) => SpotifyController;
}

export interface BotStatus {
  id: string;
  name: string;
  connected: boolean;
  playing: boolean;
  paused: boolean;
  currentSong: QueuedSong | null;
  queueSize: number;
  volume: number;
  playMode: PlayMode;
  elapsed: number; // ground truth elapsed seconds from frame count
  /** 当前曲实际播放时长（秒）。试听片段=试听秒数；完整曲=duration。缺失时前端回退 currentSong.duration。 */
  effectiveDuration?: number;
}

export class BotInstance extends EventEmitter {
  readonly id: string;
  name: string;

  private tsClient: TS3Client;
  private player: AudioPlayer;
  private spotifyController: SpotifyController;
  private queue: PlayQueue;
  private neteaseProvider: MusicProvider;
  private qqProvider: MusicProvider;
  private bilibiliProvider: MusicProvider;
  private youtubeProvider: MusicProvider;
  private localProvider: MusicProvider;
  private kugouProvider: MusicProvider;
  private spotifyProvider: MusicProvider;
  private database: BotDatabase;
  private config: BotConfig;
  private logger: Logger;
  private avatarStore: AvatarStore;
  private connected = false;
  private disconnectEmitted = false;
  private voteSkipUsers = new Set<string>();
  private isAdvancing = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private channelUserCount = 0;
  private autoPaused = false;
  /** True while the audible track is served by the Spotify sidecar (external
   *  PCM mode) — drives fence/handoff decisions in resolveAndPlay + cmdStop. */
  private currentSourceIsSpotify = false;
  private profileManager: BotProfileManager;
  private isFmMode = false;
  private fmProvider: MusicProvider | null = null;
  private fmRequesterName: string | undefined;
  /** Results of the most recent !search, for "#N" selection (issue #90). */
  private lastSearchResults: Song[] = [];
  /** 当前曲实际播放时长（试听片段秒数或完整 duration）；resolveAndPlay 赋值。 */
  private effectiveDuration: number | undefined;
  private playGate: Promise<unknown> = Promise.resolve();

  constructor(options: BotInstanceOptions) {
    super();
    this.id = options.id;
    this.name = options.name;
    this.neteaseProvider = options.neteaseProvider;
    this.qqProvider = options.qqProvider;
    this.bilibiliProvider = options.bilibiliProvider;
    this.youtubeProvider = options.youtubeProvider;
    this.localProvider = options.localProvider ?? options.neteaseProvider;
    this.kugouProvider = options.kugouProvider ?? options.neteaseProvider;
    this.spotifyProvider = options.spotifyProvider ?? options.neteaseProvider;
    this.database = options.database;
    this.config = options.config;
    this.logger = options.logger.child({ botId: this.id });
    this.avatarStore = options.avatarStore;

    this.tsClient = new TS3Client(options.tsOptions, this.logger);
    this.player = new AudioPlayer(this.logger);
    this.queue = new PlayQueue();

    // One long-lived Spotify sidecar controller per bot. Construction is
    // cheap and side-effect-free — nothing spawns until ensureStarted().
    const spotifyBase =
      options.spotifyDataDir ?? path.join(process.cwd(), "data", "spotify");
    const spotifyWorkDir = path.join(spotifyBase, this.id, "work");
    const spotifyConfigDir = path.join(spotifyBase, this.id, "config");
    // Stable per-bot ports for the go-librespot control API / OAuth callback.
    // These only reduce (not eliminate) cross-bot collisions: two bot ids that
    // hash to the same % 1000 bucket share ports and the second sidecar fails to
    // bind — see spotifyPortsForBotId() for the recommended per-bot free-port fix.
    const { apiPort: spotifyApiPort, callbackPort: spotifyCallbackPort } =
      spotifyPortsForBotId(this.id);
    const buildController =
      options.spotifyControllerFactory ??
      ((o) => new SpotifyController({ ...o }));
    this.spotifyController = buildController({
      config: this.config.spotify,
      workDir: spotifyWorkDir,
      configDir: spotifyConfigDir,
      logger: this.logger,
      // Per-bot id → unique Spotify Connect device name ("<base>-<id>"), so two
      // bots under the one shared account never register the same name and
      // misroute Connect commands (corner-case R2-5).
      instanceId: this.id,
      apiPort: spotifyApiPort,
      callbackPort: spotifyCallbackPort,
      oauth: options.spotifyOAuth,
    });

    const profileConfig = this.database.getProfileConfig(this.id);
    this.profileManager = new BotProfileManager(
      this.tsClient,
      this.logger,
      profileConfig,
      options.tsOptions.nickname,
    );

    // Best-effort: a corrupted/locked avatar file must not block bot startup.
    try {
      const relPath = this.database.getCustomAvatarPath(this.id);
      if (relPath) {
        const buf = this.avatarStore.read(relPath);
        if (buf) this.profileManager.setCustomAvatar(buf);
      }
    } catch (err) {
      this.logger.warn({ err }, "Failed to load custom avatar — skipping");
    }

    this.setupPlayerEvents();
    this.setupTsEvents();
  }

  private setupPlayerEvents(): void {
    this.player.on("frame", (opusFrame: Buffer) => {
      this.tsClient.sendVoiceData(opusFrame);
    });

    this.player.on("trackEnd", () => {
      this.logger.debug("Track ended, advancing queue");
      this.playNext().catch((err) => {
        this.logger.error({ err }, "playNext failed after trackEnd");
      });
    });

    this.player.on("error", (err: Error) => {
      this.logger.error({ err }, "Player error");
      this.playNext().catch((err2) => {
        this.logger.error({ err: err2 }, "playNext failed after player error");
      });
    });

    // Spotify advances exclusively via the sidecar's WebSocket "trackEnded"
    // (the continuous go-librespot→ffmpeg pipe never EOFs per track, so the
    // player's own underrun "trackEnd" is suppressed in external mode). Guard
    // on the current song being spotify so a stray event can't double-advance
    // a URL track; playNext()'s isAdvancing guard covers any residual race.
    this.spotifyController.on("trackEnded", (_e: SpotifyTrackEndedEvent) => {
      if (this.queue.current()?.platform !== "spotify") return;
      this.logger.debug("Spotify track ended, advancing queue");
      this.playNext().catch((err) => {
        this.logger.error({ err }, "playNext failed after spotify trackEnded");
      });
    });
  }

  isLocalAudioEnabled(): boolean {
    return this.config.localAudioEnabled !== false;
  }

  /**
   * Reference-aware cleanup of uploaded local audio files. Delegates to the
   * local provider, which deletes a file only when it has been played AND is
   * no longer referenced by ANY bot's queue — so loop replays, prev, the song
   * being re-started, and the same upload queued on another bot are all safe.
   * Call this AFTER the queue mutation, so released songs are unreferenced
   * (and deleted) while songs that remain queued are preserved.
   */
  cleanupQueuedLocalSongs(reason: string): void {
    this.sweepLocalAudio(reason);
  }

  private sweepLocalAudio(reason: string): void {
    const provider = this.localProvider as MusicProvider & {
      sweepUnreferenced?: () => string[];
    };
    if (typeof provider.sweepUnreferenced !== "function") return;
    try {
      const deleted = provider.sweepUnreferenced();
      if (deleted.length) {
        this.logger.info({ count: deleted.length, reason }, "Cleaned up local audio files");
      }
    } catch (err) {
      this.logger.warn({ err, reason }, "Local audio cleanup failed");
    }
  }

  private isSameSong(a: QueuedSong | Song | null | undefined, b: QueuedSong | Song | null | undefined): boolean {
    return !!a && !!b && a.platform === b.platform && a.id === b.id;
  }

  private setupTsEvents(): void {
    this.tsClient.on("textMessage", (msg: TS3TextMessage) => {
      this.handleTextMessage(msg).catch((err) => {
        this.logger.error({ err }, "Unhandled error in text message handler");
      });
    });

    this.tsClient.on("disconnected", () => {
      // Always reset local state — covers the case where connect() never
      // completed (hanging handshake → 60s library idle timeout) and
      // this.connected was never flipped to true. Previously this handler
      // short-circuited on !this.connected, leaving player stuck as "playing".
      this.connected = false;
      this.spotifyController.stop();
      this.currentSourceIsSpotify = false;
      this.player.stop();
      this.queue.clear();
      this.sweepLocalAudio("disconnected");
      // A lifecycle change must not leave a stale auto-resume armed.
      this.autoPaused = false;
      // Only emit externally once per lifecycle so clients don't see a
      // duplicate "disconnected" after an explicit disconnect() call.
      if (this.disconnectEmitted) return;
      this.disconnectEmitted = true;
      this.emit("disconnected");
    });

    this.tsClient.on("connected", () => {
      // Fresh connection — clear any stale auto-pause flag from a prior session.
      this.autoPaused = false;
      this._startIdlePoller();
    });

    // React near-instantly to channel membership changes. The 30s idle
    // poller remains the fallback if any of these events are missed.
    //
    // clientEnter additionally arms auto-RESUME directly from the event,
    // because the occupancy query (clientlist) times out whenever another
    // client is present — i.e. exactly when a listener returns — so it cannot
    // be used to confirm the return. See _resumeIfReturning().
    this.tsClient.on("clientEnter", () => {
      this._resumeIfReturning();
      void this.refreshOccupancy();
    });
    this.tsClient.on("clientLeave", () => void this.refreshOccupancy());
    this.tsClient.on("clientMoved", () => void this.refreshOccupancy());
  }

  /**
   * Resume playback when a listener returns after an auto-pause, driven by the
   * clientEnter push event rather than a (timing-out) occupancy query.
   *
   * We only auto-pause while alone on the server, so `autoPaused` is a reliable
   * "paused because empty" flag; any client appearing while it's set means a
   * listener returned. Delegating to handleOccupancy(1) routes through
   * decideOccupancyAction (resume iff autoPaused && paused) and also cancels the
   * idle-disconnect timer. This path NEVER pauses — userCount is always > 0 —
   * so a spurious or unrelated enter can only (harmlessly) resume, never stop
   * playback. Pause remains exclusively on the authoritative clientlist path.
   */
  private _resumeIfReturning(): void {
    if (!this.connected) return;
    if (shouldResumeOnReturn(this.autoPaused, this.player.getState())) {
      this.handleOccupancy(1);
    }
  }

  private async refreshOccupancy(): Promise<void> {
    if (!this.connected) return;
    try {
      const clients = await this.tsClient.getClientsInChannel();
      // A 0-length result means the clientlist query failed (the bot is always
      // in its own channel) — occupancy is unknown, so don't act. Acting on it
      // would mis-read it as "empty" and falsely auto-pause / idle-disconnect.
      const userCount = occupancyFromClientList(clients.length);
      if (userCount !== null) this.handleOccupancy(userCount);
    } catch {
      // ignore — the 30s poll is the fallback
    }
  }

  async connect(): Promise<void> {
    this.disconnectEmitted = false;
    await this.tsClient.connect();
    // Race guard: if disconnect() was called while the handshake was
    // awaiting, don't flip connected back to true — that would leave the
    // bot in an inconsistent state (externally "connected" but the tsClient
    // has already been torn down).
    if (this.disconnectEmitted) {
      throw new Error("Connect aborted by concurrent disconnect");
    }
    this.connected = true;
    this.profileManager.onConnect();
    this.emit("connected");
  }

  disconnect(): void {
    this._cancelIdleTimer();
    this.spotifyController.stop();
    this.currentSourceIsSpotify = false;
    this.player.stop();
    this.queue.clear();
    this.sweepLocalAudio("disconnected");
    this.connected = false;
    if (!this.disconnectEmitted) {
      this.disconnectEmitted = true;
      this.emit("disconnected");
    }
    this.tsClient.disconnect();
  }

  /** 外部更新 idleTimeoutMinutes（由 API 保存时调用） */
  updateIdleTimeout(minutes: number): void {
    this.config.idleTimeoutMinutes = minutes;
    if (minutes === 0) this._cancelIdleTimer();
  }

  /** 外部更新 autoPauseOnEmpty（由 API 保存时调用） */
  updateAutoPause(enabled: boolean): void {
    this.config.autoPauseOnEmpty = enabled;
    if (!enabled && this.autoPaused && this.player.getState() === "paused") {
      this.player.resume();
      if (this.queue.current()?.platform === "spotify") {
        this.spotifyController.resume().catch((err) =>
          this.logger.warn({ err }, "Spotify resume failed (auto-pause disabled)"));
      }
      this.autoPaused = false;
      this.emit("stateChange");
    }
  }

  private _startIdlePoller(): void {
    // 每 30 秒检查一次频道人数
    const poll = async () => {
      if (!this.connected) return;
      try {
        const clients = await this.tsClient.getClientsInChannel();
        // null = clientlist query failed (occupancy unknown) → don't act.
        const userCount = occupancyFromClientList(clients.length);
        if (userCount !== null) this.handleOccupancy(userCount);
      } catch { /* ignore */ }
      setTimeout(poll, 30_000);
    };
    setTimeout(poll, 30_000);
  }

  private handleOccupancy(userCount: number): void {
    // idle-disconnect (unchanged behavior)
    if (userCount <= 0) this._scheduleIdleCheck();
    else this._cancelIdleTimer();
    // auto-pause
    const action = decideOccupancyAction(
      this.player.getState(),
      this.autoPaused,
      this.config.autoPauseOnEmpty,
      userCount,
    );
    if (action === "pause") {
      this.player.pause();
      // Occupancy paths drive player.pause()/resume() DIRECTLY (bypassing the
      // cmd handlers), so they must ALSO stop/resume the sidecar — else it
      // keeps decoding into an empty channel.
      if (this.queue.current()?.platform === "spotify") {
        this.spotifyController.pause().catch((err) =>
          this.logger.warn({ err }, "Spotify pause failed (occupancy)"));
      }
      this.autoPaused = true;
      this.emit("stateChange");
    } else if (action === "resume") {
      this.player.resume();
      if (this.queue.current()?.platform === "spotify") {
        this.spotifyController.resume().catch((err) =>
          this.logger.warn({ err }, "Spotify resume failed (occupancy)"));
      }
      this.autoPaused = false;
      this.emit("stateChange");
    }
  }

  private _scheduleIdleCheck(): void {
    if (this.idleTimer !== null) return; // 已经在倒计时，不重复创建
    const minutes = this.config.idleTimeoutMinutes ?? 0;
    if (!this.connected || minutes <= 0) return;
    this.idleTimer = setTimeout(() => {
      if (!this.connected) return;
      this.logger.info({ idleMinutes: minutes }, "Channel empty, disconnecting due to idle timeout");
      this.disconnect();
    }, minutes * 60 * 1000);
  }

  private _cancelIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private async handleTextMessage(msg: TS3TextMessage): Promise<void> {
    const parsed = parseCommand(
      msg.message,
      this.config.commandPrefix,
      this.config.commandAliases
    );
    if (!parsed) return;

    if (!(await this.isCommandAllowed(parsed.name, msg))) {
      this.logger.info(
        { command: parsed.name, invoker: msg.invokerName },
        "Command denied: invoker not in adminGroups"
      );
      try {
        await this.tsClient.sendTextMessage(COMMAND_DENIED_MESSAGE);
      } catch (sendErr) {
        this.logger.error({ err: sendErr }, "Failed to send permission-denied message to chat");
      }
      return;
    }

    this.logger.info(
      { command: parsed.name, args: parsed.args, invoker: msg.invokerName },
      "Command received"
    );

    try {
      const response = await this.executeCommand(parsed, msg);
      if (response) {
        // A single long reply (e.g. full lyrics) would exceed TeamSpeak's
        // per-message byte cap, so split it and send the chunks in order.
        for (const chunk of splitTextIntoChunks(response)) {
          await this.tsClient.sendTextMessage(chunk);
        }
      }
    } catch (err) {
      this.logger.error({ err, command: parsed.name }, "Command execution error");
      try {
        await this.tsClient.sendTextMessage(
          `Error: ${(err as Error).message}`
        );
      } catch (sendErr) {
        this.logger.error({ err: sendErr }, "Failed to send error message to chat");
      }
    }
  }

  /**
   * Decide whether a chat command may run for this sender. Reads adminGroups
   * live from this.config. Public commands and the enforcement-off case are
   * allowed with NO query. For an ENFORCED admin command we resolve the
   * sender's CURRENT server groups with a targeted server-wide lookup rather
   * than trusting the text event's cached groups — those are empty for
   * out-of-channel senders and stale after a live promotion/demotion. Fails
   * closed when the groups can't be determined.
   */
  private async isCommandAllowed(commandName: string, msg: TS3TextMessage): Promise<boolean> {
    const adminGroups = this.config.adminGroups;
    // Public command, or enforcement off → allow without any lookup.
    // (canRunCommand with empty groups is true iff the command is public OR
    // adminGroups is empty.)
    if (canRunCommand(commandName, [], adminGroups)) return true;
    // Enforced admin command: authoritative decision uses freshly-resolved,
    // server-wide groups. Fail closed if they can't be determined.
    const groups = await this.lookupInvokerGroups(msg.invokerId);
    return canRunCommand(commandName, groups, adminGroups);
  }

  /**
   * Resolve the sender's current server groups by client id, server-wide.
   * Returns [] on a bad id or query failure (→ fail-closed deny upstream).
   */
  private async lookupInvokerGroups(invokerId: string): Promise<string[]> {
    const clid = Number(invokerId);
    if (!Number.isFinite(clid) || clid <= 0) return [];
    try {
      return await this.tsClient.getClientServerGroups(clid);
    } catch {
      return [];
    }
  }

  async executeCommand(
    cmd: ParsedCommand,
    msg?: TS3TextMessage,
    requesterName = this.requesterNameFromMessage(msg),
  ): Promise<string | null> {
    // Reject commands that would push audio when the bot isn't connected:
    // otherwise ffmpeg spawns and voice goes to a half-initialized or
    // torn-down TS client, leaving player.state="playing" on a disconnected
    // bot. Config-only commands (vol, mode, clear, stop, queue, now) are
    // still allowed so the UI stays usable while the bot is offline.
    const AUDIO_COMMANDS = new Set([
      "play",
      "add",
      "playnext",
      "pn",
      "next",
      "skip",
      "prev",
      "playlist",
      "album",
      "fm",
      "artist",
    ]);
    if (!this.connected && AUDIO_COMMANDS.has(cmd.name)) {
      throw new Error("Bot is not connected to TeamSpeak");
    }
    switch (cmd.name) {
      case "search":
      case "find":
        return this.cmdSearch(cmd);
      case "play":
        return this.cmdPlay(cmd, requesterName);
      case "add":
        return this.cmdAdd(cmd, requesterName);
      case "playnext":
      case "pn":
        return this.cmdPlayNext(cmd, requesterName);
      case "pause":
        return this.cmdPause();
      case "resume":
        return this.cmdResume();
      case "stop":
        return this.cmdStop();
      case "next":
      case "skip":
        return this.cmdNext();
      case "prev":
        return this.cmdPrev();
      case "vol":
        return this.cmdVol(cmd);
      case "now":
        return this.cmdNow();
      case "queue":
      case "list":
        return this.cmdQueue();
      case "clear":
        return this.cmdClear();
      case "remove":
        return this.cmdRemove(cmd);
      case "mode":
        return this.cmdMode(cmd);
      case "playlist":
        return this.cmdPlaylist(cmd, requesterName);
      case "album":
        return this.cmdAlbum(cmd, requesterName);
      case "fm":
        return this.cmdFm(cmd, requesterName);
      case "artist":
        return this.cmdArtist(cmd, requesterName);
      case "vote":
        return this.cmdVote(msg);
      case "lyrics":
        return this.cmdLyrics();
      case "move":
        return this.cmdMove(cmd);
      case "follow":
        return this.cmdFollow(msg);
      case "help":
        return this.cmdHelp();
      default:
        return `Unknown command: ${cmd.name}. Type ${this.config.commandPrefix}help for help.`;
    }
  }

  getProviderFor(platform: "netease" | "qq" | "bilibili" | "youtube" | "local" | "kugou" | "spotify"): MusicProvider {
    if (platform === "bilibili") return this.bilibiliProvider;
    if (platform === "youtube") return this.youtubeProvider;
    if (platform === "local") return this.localProvider;
    if (platform === "kugou") return this.kugouProvider;
    if (platform === "spotify") return this.spotifyProvider;
    return platform === "qq" ? this.qqProvider : this.neteaseProvider;
  }

  private disableFmMode(): void {
    this.isFmMode = false;
    this.fmProvider = null;
    this.fmRequesterName = undefined;
  }

  private requesterNameFromMessage(msg?: TS3TextMessage): string | undefined {
    const name = msg?.invokerName?.trim();
    return name || undefined;
  }

  private withRequester<T extends Song | QueuedSong>(
    song: T,
    requesterName?: string,
  ): T & { requestedBy?: string } {
    const requestedBy = requesterName?.trim();
    return requestedBy ? { ...song, requestedBy } : { ...song };
  }

  private getProvider(flags: Set<string>): MusicProvider {
    if (flags.has("b")) return this.bilibiliProvider;
    if (flags.has("q")) return this.qqProvider;
    if (flags.has("y")) return this.youtubeProvider;
    if (flags.has("k")) return this.kugouProvider;
    if (flags.has("s")) return this.spotifyProvider;
    return this.neteaseProvider;
  }

  /** Resolve URL for a song and start playing it. Skips to next if URL fails. */
  async resolveAndPlay(song: QueuedSong): Promise<boolean> {
    if (!this.connected) {
      this.logger.warn({ songId: song.id, name: song.name }, "resolveAndPlay called on disconnected bot — skipping");
      return false;
    }
    if (song.platform === "local" && !this.isLocalAudioEnabled()) {
      this.logger.warn({ songId: song.id, name: song.name }, "Local audio playback disabled — refusing track");
      return false;
    }
    // Clear any accumulated skip votes — every fresh track starts with a
    // clean slate, regardless of which code path loaded it (cmdPlay,
    // cmdPlaylist, cmdAlbum, cmdFm, trackEnd auto-advance, etc.).
    this.voteSkipUsers.clear();
    const provider = this.getProviderFor(song.platform);
    try {
      const result = await provider.getSongUrl(song.id);
      if (!result?.url) {
        this.logger.warn({ songId: song.id, name: song.name }, "No URL available, skipping");
        return false;
      }
      // Re-check connection state AFTER the network round-trip — the URL
      // resolve can take multiple seconds and the user may have called stop
      // during that window. Without this, we'd spawn ffmpeg on a
      // disconnected bot and land back in the same "connected=false but
      // playing=true" inconsistency that Bug C was about.
      if (!this.connected) {
        this.logger.warn(
          { songId: song.id, name: song.name },
          "bot disconnected during URL resolve — aborting playback",
        );
        return false;
      }
      // Stage 2: a `spotify:` sentinel URI means the go-librespot sidecar
      // serves the audio, NOT ffmpeg. Start the per-bot sidecar on demand; if
      // it can't run (disabled / non-Linux / binary missing) keep the Stage-1
      // fallback message + skip so the queue keeps moving.
      if (isSpotifyUri(result.url)) {
        const ready = await this.spotifyController.ensureStarted();
        if (!ready) {
          this.logger.info({ songId: song.id, name: song.name }, "Spotify backend unavailable — skipping");
          await this.tsClient.sendTextMessage(SPOTIFY_UNAVAILABLE_MESSAGE);
          return false;
        }
        // `spotify:track:<id>` is the URI. go-librespot decodes into a SINGLE
        // continuous FIFO/PCM stream, so per-track playback is just a REST
        // playTrack — the stream keeps flowing. A false result means the
        // sidecar failed the play (dead/errored backend): never attach the
        // player to a dead stream — send the same fallback and skip.
        const played = await this.spotifyController.playTrack(result.url);
        if (!played) {
          this.logger.info({ songId: song.id, name: song.name }, "Spotify playTrack failed — skipping");
          await this.tsClient.sendTextMessage(SPOTIFY_UNAVAILABLE_MESSAGE);
          return false;
        }
        // Only ATTACH the persistent PCM stream when the player is NOT already
        // attached to it. Gate on the player's ACTUAL external state, not the
        // currentSourceIsSpotify flag: command paths (cmdPlay/cmdPlaylist/…)
        // call player.stop() (which detaches the external stream) WITHOUT
        // clearing the flag, so a stale-true flag would skip the re-attach and
        // silence playback. playPcmStream internally fences the prior url-ffmpeg
        // (so NO player.stop() here). On the gapless auto-advance path the
        // player is still attached (isExternalActive() === true) so we do NOT
        // re-attach — the sidecar rolls the SAME FIFO into the next track.
        // KNOWN LIMITATION: on a gapless spotify->spotify advance the player's
        // frame counter is not reset, so player.getElapsed() over-reads for the
        // 2nd+ consecutive Spotify track. Cosmetic only — the authoritative
        // elapsed shown to users is status.track.position from the backend poll.
        if (!this.player.isExternalActive()) {
          this.player.playPcmStream(this.spotifyController.getPcmStream(), {
            // The sidecar PCM pipe is long-lived; per-track end arrives via the
            // controller "trackEnded" WS event, not stream EOF. A real EOF here
            // means the sidecar died mid-session — RECOVER instead of emitting
            // silence forever (which would also leave the player stuck in
            // externalMode, so the re-attach gate skips every future track).
            // Tear the controller down (next ensureStarted() rebuilds a fresh
            // backend), stop the player (drop external mode so it re-attaches),
            // and clear the flag so a non-spotify track isn't mis-handled.
            onExternalEnd: () => {
              this.logger.warn("Spotify PCM stream ended unexpectedly — recovering");
              this.spotifyController.stop();
              this.player.stop();
              this.currentSourceIsSpotify = false;
            },
          });
        } else {
          // External-stream-reuse path: the persistent PCM stream is still
          // attached (e.g. we arrived here via pause → skip-within-spotify,
          // where the stream stays attached through the pause). playPcmStream —
          // which is what puts the player into the 'playing' state — is skipped,
          // so without this the player would stay 'paused' and emit silence
          // while the sidecar decodes the new track (corner-case R3-3). resume()
          // is a no-op on an already-playing player, so the normal (non-paused)
          // spotify→spotify handoff is unaffected.
          this.player.resume();
        }
        this.currentSourceIsSpotify = true;
        song.url = result.url;
        // No trial clip for Spotify — full-track duration only (the near-end
        // stall watchdog is disabled for the external stream anyway).
        this.effectiveDuration = song.duration;
        this.autoPaused = false;
        this.database.addPlayHistory({
          botId: this.id,
          songId: song.id,
          songName: song.name,
          artist: song.artist,
          album: song.album,
          platform: song.platform,
          coverUrl: song.coverUrl,
          requestedBy: song.requestedBy,
        });
        await this.syncProfileToSong(song);
        this.emit("stateChange");
        return true;
      }
      // Non-Spotify track: if we were on Spotify, pause the sidecar so it stops
      // decoding ahead before the URL ffmpeg reclaims the PCM buffer.
      if (this.currentSourceIsSpotify) {
        this.spotifyController.pause().catch((err) =>
          this.logger.warn({ err }, "Failed to pause Spotify sidecar on source switch"));
        this.currentSourceIsSpotify = false;
      }
      song.url = result.url;
      // 试听片段用试听时长（让 player nearEnd 正确触发自动切歌）；完整曲回退 song.duration
      this.effectiveDuration = result.trialDuration ?? song.duration;
      this.player.play(result.url, 0, this.effectiveDuration);
      // Fresh playback (re)start — clear auto-pause so a later occupancy
      // change won't try to "resume" a track the user already restarted.
      this.autoPaused = false;
      this.database.addPlayHistory({
        botId: this.id,
        songId: song.id,
        songName: song.name,
        artist: song.artist,
        album: song.album,
        platform: song.platform,
        coverUrl: song.coverUrl,
      });
      // Keep TeamSpeak-side profile updates on the same path for play/next/FM.
      await this.syncProfileToSong(song);
      this.emit("stateChange");
      return true;
    } catch (err) {
      this.logger.error({ err, songId: song.id }, "Failed to resolve URL");
      return false;
    }
  }

  private async syncProfileToSong(song: QueuedSong | null): Promise<void> {
    try {
      await this.profileManager.onSongChange(song);
    } catch (err) {
      this.logger.warn({ err }, "Profile update failed after song change");
    }
  }

  /**
   * Resolve a !play/!add/!playnext argument into a single Song, supporting three
   * forms (issue #90):
   *   1) "#N"          — the Nth result of the previous !search
   *   2) id:<id> / URL — an exact song (disambiguates same-name songs)
   *   3) plain text    — search, returning the single most-popular hit (legacy)
   */
  private async resolvePlayQuery(cmd: ParsedCommand): Promise<{ song?: Song; error?: string }> {
    const args = (cmd.args ?? "").trim();
    const p = this.config.commandPrefix;

    // 1) "#N" — pick from the previous !search.
    const sel = parseSelectionIndex(args);
    if (sel !== null) {
      if (this.lastSearchResults.length === 0)
        return { error: `No recent search. Use ${p}search <name> first.` };
      if (sel > this.lastSearchResults.length)
        return { error: `Invalid selection #${sel}. ${p}search returned ${this.lastSearchResults.length} results.` };
      return { song: this.lastSearchResults[sel - 1] };
    }

    // 2) id:/URL — fetch that exact song.
    const ref = parseSongRef(args);
    if (ref) {
      const provider = ref.platform ? this.getProviderFor(ref.platform) : this.getProvider(cmd.flags);
      const song = await provider.getSongDetail(ref.id);
      if (!song) return { error: `No song found for ${ref.platform ?? provider.platform} id: ${ref.id}` };
      return { song: { ...song, platform: provider.platform } };
    }

    // 3) Plain search term — single most-popular hit (historical behavior).
    const provider = this.getProvider(cmd.flags);
    const result = await provider.search(args, 1);
    if (result.songs.length === 0) return { error: `No results found for: ${args}` };
    return { song: { ...result.songs[0], platform: provider.platform } };
  }

  private async cmdSearch(cmd: ParsedCommand): Promise<string> {
    const p = this.config.commandPrefix;
    if (!cmd.args) return `Usage: ${p}search <name> [-q|-k|-b|-y]`;
    const provider = this.getProvider(cmd.flags);
    const result = await provider.search(cmd.args, 8);
    if (result.songs.length === 0) return `No results found for: ${cmd.args}`;
    this.lastSearchResults = result.songs.map((s) => ({ ...s, platform: provider.platform }));
    const lines = this.lastSearchResults.map(
      (s, i) => `${i + 1}. ${s.name} - ${s.artist}${s.album ? ` 《${s.album}》` : ""} [id:${s.id}]`,
    );
    return [
      `搜索结果（用 ${p}play #序号 播放，或 ${p}play id:<id>）:`,
      ...lines,
    ].join("\n");
  }

  private async cmdPlay(cmd: ParsedCommand, requesterName?: string): Promise<string> {
    if (!cmd.args) return `Usage: ${this.config.commandPrefix}play <song name | #N | id:<id> | URL>`;
    const { song, error } = await this.resolvePlayQuery(cmd);
    if (error) return error;
    const song0 = song!;
    const previous = this.queue.current();
    if (previous && !this.isSameSong(previous, song0)) {
      this.player.stop();
    }
    this.queue.clear();
    this.disableFmMode();
    this.queue.add(this.withRequester(song0, requesterName));
    this.queue.play();

    // Reset failure counter on user-initiated play
    this.player.resetFailures();
    const ok = await this.resolveAndPlay(this.queue.current()!);
    // Sweep AFTER the new song is queued+resolved: the replaced songs are no
    // longer referenced (and get deleted), but song0 — if it is the same local
    // upload that was already playing — stays referenced and is preserved.
    this.sweepLocalAudio("replaced");
    if (!ok) return `Cannot play: ${song0.name}`;
    return `Now playing: ${song0.name} - ${song0.artist}`;
  }

  private async cmdAdd(cmd: ParsedCommand, requesterName?: string): Promise<string> {
    if (!cmd.args) return `Usage: ${this.config.commandPrefix}add <song name | #N | id:<id> | URL>`;
    const { song, error } = await this.resolvePlayQuery(cmd);
    if (error) return error;
    const s = song!;

    const wasIdle = this.player.getState() === "idle";
    this.queue.add(this.withRequester(s, requesterName));

    // If nothing was playing, start this newly-added song immediately.
    // Matches /api/player/:id/add-by-id behavior so both add paths feel
    // the same to the user (add to idle bot → plays now).
    if (wasIdle) {
      this.queue.playAt(this.queue.size() - 1);
      this.player.resetFailures();
      await this.resolveAndPlay(this.queue.current()!);
      this.emit("stateChange");
      return `Now playing: ${s.name} - ${s.artist}`;
    }

    this.emit("stateChange");
    return `Added to queue: ${s.name} - ${s.artist} (position ${this.queue.size()})`;
  }

  private async cmdPlayNext(cmd: ParsedCommand, requesterName?: string): Promise<string> {
    if (!cmd.args) return `Usage: ${this.config.commandPrefix}playnext <song name | #N | id:<id> | URL>`;
    const { song, error } = await this.resolvePlayQuery(cmd);
    if (error) return error;
    const s = song!;

    const wasIdle = this.player.getState() === "idle";
    // Capture the slot addNext WILL insert at, before mutating the queue.
    // addNext pushes when currentIndex<0 (slot = size); otherwise splices
    // at currentIndex+1. Using size-1 after addNext was wrong when the
    // queue had stale currentIndex>=0 while the player was idle (e.g.,
    // after natural track end without queue.clear()).
    const insertedAt =
      this.queue.getCurrentIndex() < 0
        ? this.queue.size()
        : this.queue.getCurrentIndex() + 1;
    this.queue.addNext(this.withRequester(s, requesterName));

    if (wasIdle) {
      this.queue.playAt(insertedAt);
      this.player.resetFailures();
      const ok = await this.resolveAndPlay(this.queue.current()!);
      this.emit("stateChange");
      if (!ok) return `Cannot play: ${s.name}`;
      return `Now playing: ${s.name} - ${s.artist}`;
    }

    this.emit("stateChange");
    return `Up next: ${s.name} - ${s.artist}`;
  }

  private cmdPause(): string {
    this.player.pause();
    if (this.queue.current()?.platform === "spotify") {
      this.spotifyController.pause().catch((err) =>
        this.logger.warn({ err }, "Spotify pause failed"));
    }
    // User-initiated pause — clear auto-pause so occupancy won't auto-resume it.
    this.autoPaused = false;
    this.emit("stateChange");
    return "Paused";
  }

  private cmdResume(): string {
    this.player.resume();
    if (this.queue.current()?.platform === "spotify") {
      this.spotifyController.resume().catch((err) =>
        this.logger.warn({ err }, "Spotify resume failed"));
    }
    // User-initiated resume — drop any auto-pause flag.
    this.autoPaused = false;
    this.emit("stateChange");
    return "Resumed";
  }

  private cmdStop(): string {
    // Read the current song BEFORE queue.clear() so we can tell whether the
    // sidecar needs stopping.
    if (this.queue.current()?.platform === "spotify") {
      this.spotifyController.stop();
    }
    this.currentSourceIsSpotify = false;
    this.player.stop();
    this.autoPaused = false;
    this.queue.clear();
    this.sweepLocalAudio("stopped");
    this.disableFmMode();
    this.profileManager.onSongChange(null).catch((err) => {
      this.logger.warn({ err }, "Profile restore failed on stop");
    });
    this.emit("stateChange");
    return "Stopped and queue cleared";
  }

  private async cmdNext(): Promise<string> {
    await this.playNext();
    const current = this.queue.current();
    if (current)
      return `Now playing: ${current.name} - ${current.artist}`;
    return "Queue is empty";
  }

  private async cmdPrev(): Promise<string> {
    // Retry-skip up to 4 attempts: history can include failed songs
    // that playNext's auto-advance retry-skipped past, so a single
    // prev would otherwise land on an unplayable song and leave the
    // queue's currentIndex stuck mid-failure.
    for (let i = 0; i < 4; i++) {
      const prev = this.queue.prev();
      if (!prev) return "No previous song";
      const ok = await this.resolveAndPlay(prev);
      if (ok) return `Now playing: ${prev.name} - ${prev.artist}`;
    }
    return "Cannot play any previous songs (all failed to resolve)";
  }

  private cmdVol(cmd: ParsedCommand): string {
    const vol = parseInt(cmd.args, 10);
    if (isNaN(vol) || vol < 0 || vol > 100) return "Usage: !vol <0-100>";
    this.player.setVolume(vol);
    this.emit("stateChange");
    return `Volume set to ${vol}%`;
  }

  private cmdNow(): string {
    const song = this.queue.current();
    if (!song) return "Nothing is playing";
    return `Now playing: ${song.name} - ${song.artist} [${song.album}] (${song.platform})`;
  }

  private cmdQueue(): string {
    const songs = this.queue.list();
    if (songs.length === 0) return "Queue is empty";
    const currentIdx = this.queue.getCurrentIndex();
    const lines = songs.map((s, i) => {
      const marker = i === currentIdx ? "▶ " : "  ";
      return `${marker}${i + 1}. ${s.name} - ${s.artist}`;
    });
    return `Queue (${songs.length} songs, mode: ${this.queue.getMode()}):\n${lines.join("\n")}`;
  }

  private cmdClear(): string {
    this.spotifyController.stop();
    this.currentSourceIsSpotify = false;
    this.player.stop();
    this.queue.clear();
    this.sweepLocalAudio("queue_cleared");
    this.disableFmMode();
    this.profileManager.onSongChange(null).catch((err) => {
      this.logger.warn({ err }, "Profile restore failed on clear");
    });
    this.emit("stateChange");
    return "Queue cleared";
  }

  private async cmdRemove(cmd: ParsedCommand): Promise<string> {
    const index = parseInt(cmd.args, 10) - 1;
    if (isNaN(index) || index < 0) return "Usage: !remove <number>";
    // Capture BEFORE the splice whether we're removing the currently-playing
    // Spotify track: queue.remove() decrements currentIndex, so getCurrentIndex()
    // is only meaningful pre-remove.
    const removingCurrentSpotify =
      index === this.queue.getCurrentIndex() && this.currentSourceIsSpotify;
    const removed = this.queue.remove(index);
    if (!removed) return "Invalid position";
    // Corner-case R3-2: removing the track the Spotify sidecar is decoding
    // right now leaves it running while queue.current() is no longer that
    // track. Since a spotify track has NO player self-EOF advance path, the
    // controller "trackEnded" handler would return early (current is no longer
    // spotify) and the bot would wedge in silence. Reconcile like cmdStop/skip:
    // tear the sidecar down, then advance to whatever is now current — or stop
    // cleanly if the queue is now empty (playNext's exhausted branch stops the
    // player). Non-current or non-spotify removals are untouched (a URL current
    // track self-heals via its own EOF).
    if (removingCurrentSpotify) {
      this.spotifyController.stop();
      this.currentSourceIsSpotify = false;
      this.player.stop();
      await this.playNext();
    }
    // Sweep after the entry is gone — the file is deleted only if no other
    // queue position (or bot) still references this upload.
    this.sweepLocalAudio("removed_from_queue");
    this.emit("stateChange");
    return `Removed: ${removed.name}`;
  }

  private cmdMode(cmd: ParsedCommand): string {
    const modeMap: Record<string, PlayMode> = {
      seq: PlayMode.Sequential,
      loop: PlayMode.Loop,
      random: PlayMode.Random,
      rloop: PlayMode.RandomLoop,
    };
    const mode = modeMap[cmd.args];
    if (mode === undefined) return "Usage: !mode <seq|loop|random|rloop>";
    this.queue.setMode(mode);
    this.emit("stateChange");
    return `Play mode set to: ${cmd.args}`;
  }

  private async cmdPlaylist(cmd: ParsedCommand, requesterName?: string): Promise<string> {
    if (!cmd.args) return "Usage: !playlist <playlist name or ID>";
    const provider = this.getProvider(cmd.flags);

    // Determine if input is a numeric ID or a name search
    const id = this.extractId(cmd.args);
    const isNumericId = /^\d+$/.test(cmd.args.trim());

    let playlistId: string;

    if (isNumericId || id !== cmd.args) {
      // Input is a numeric ID or URL containing an ID — use existing logic
      playlistId = id;
    } else {
      // Name-based search
      const result = await provider.search(cmd.args);
      let playlists = result.playlists ?? [];

      // Also search user's personal playlists if logged in
      if (provider.getUserPlaylists) {
        try {
          const userPlaylists = await provider.getUserPlaylists();
          const query = cmd.args.toLowerCase();
          const matched = userPlaylists.filter(
            p => p.name.toLowerCase().includes(query)
          );
          // Merge: public results first (API-ranked), then user matches
          playlists = [...playlists, ...matched];
        } catch {
          // User playlists unavailable — continue with public results
        }
      }

      if (playlists.length === 0)
        return `No playlists found for: ${cmd.args}`;
      playlistId = playlists[0].id;
    }

    const songs = await provider.getPlaylistSongs(playlistId);
    if (songs.length === 0) return "Playlist is empty or not found";

    this.player.stop();
    this.queue.clear();
    this.disableFmMode();
    for (const song of songs) {
      this.queue.add(this.withRequester({ ...song, platform: provider.platform }, requesterName));
    }
    const first = this.queue.play();
    if (first) await this.resolveAndPlay(first);
    this.sweepLocalAudio("queue_replaced");
    this.emit("stateChange");
    return `Loaded ${songs.length} songs. Now playing: ${first?.name ?? "unknown"}`;
  }

  private async cmdAlbum(cmd: ParsedCommand, requesterName?: string): Promise<string> {
    if (!cmd.args) return "Usage: !album <album name or ID>";
    const provider = this.getProvider(cmd.flags);

    const id = this.extractId(cmd.args);
    const isNumericId = /^\d+$/.test(cmd.args.trim());

    let albumId: string;

    if (isNumericId || id !== cmd.args) {
      // Input is a numeric ID or URL containing an ID — use directly
      albumId = id;
    } else {
      // Name-based search
      const result = await provider.search(cmd.args);
      const albums = result.albums ?? [];
      if (albums.length === 0)
        return `No albums found for: ${cmd.args}`;
      albumId = albums[0].id;
    }

    const songs = await provider.getAlbumSongs(albumId);
    if (songs.length === 0) return "Album is empty or not found";

    this.player.stop();
    this.queue.clear();
    this.disableFmMode();
    for (const song of songs) {
      this.queue.add(this.withRequester({ ...song, platform: provider.platform }, requesterName));
    }
    const first = this.queue.play();
    if (first) await this.resolveAndPlay(first);
    this.sweepLocalAudio("queue_replaced");
    this.emit("stateChange");
    return `Loaded ${songs.length} songs. Now playing: ${first?.name ?? "unknown"}`;
  }

  private async cmdFm(cmd: ParsedCommand, requesterName?: string): Promise<string> {
    return this.startFm(this.getProvider(cmd.flags), requesterName);
  }

  async startFm(provider: MusicProvider = this.neteaseProvider, requesterName?: string): Promise<string> {
    // Match the !fm chat-command guard: refuse before mutating the queue when
    // offline, so the web /fm route can't wipe the queue + flip into FM mode
    // while nothing can actually play.
    if (!this.connected) {
      return "Bot is not connected to TeamSpeak";
    }
    if (!provider.getPersonalFm) {
      return `Personal FM is not available for ${provider.platform}`;
    }
    const songs = await provider.getPersonalFm();
    if (songs.length === 0)
      return "No FM songs available (need to login first)";

    this.player.stop();
    this.queue.clear();
    for (const song of songs) {
      this.queue.add(this.withRequester({ ...song, platform: provider.platform }, requesterName));
    }
    this.queue.setMode(PlayMode.Random);
    this.isFmMode = true;
    this.fmProvider = provider;
    this.fmRequesterName = requesterName?.trim() || undefined;
    this.player.resetFailures();

    const first = this.queue.play();
    if (first) await this.resolveAndPlay(first);
    this.sweepLocalAudio("queue_replaced");
    this.emit("stateChange");
    const label = provider.platform === "qq" ? "QQ Radar FM" : "Personal FM";
    return `${label} started: ${first?.name ?? "unknown"} - ${first?.artist ?? ""}`;
  }

  private async cmdArtist(cmd: ParsedCommand, requesterName?: string): Promise<string> {
    if (!cmd.args) return "Usage: !artist <artist name>";
    const provider = this.getProvider(cmd.flags);
    const result = await provider.search(cmd.args, 50);
    if (result.songs.length === 0)
      return `No results found for artist: ${cmd.args}`;

    const query = cmd.args.toLowerCase();
    let filtered = result.songs.filter(
      s => s.artist.toLowerCase().includes(query)
    );

    // Fallback to unfiltered results if filtering drops everything
    if (filtered.length === 0) {
      filtered = result.songs.slice(0, 20);
    }

    this.player.stop();
    this.queue.clear();
    this.disableFmMode();
    for (const song of filtered) {
      this.queue.add(this.withRequester({ ...song, platform: provider.platform }, requesterName));
    }
    this.queue.setMode(PlayMode.Loop);
    this.player.resetFailures();

    const first = this.queue.play();
    if (first) await this.resolveAndPlay(first);
    this.sweepLocalAudio("queue_replaced");
    this.emit("stateChange");
    return `Artist mode: ${cmd.args} — ${filtered.length} songs loaded. Now playing: ${first?.name ?? "unknown"}`;
  }

  private async refillFm(): Promise<void> {
    const provider = this.fmProvider;
    if (!this.isFmMode || !provider?.getPersonalFm) return;
    try {
      const songs = await provider.getPersonalFm();
      if (songs.length === 0) return;
      for (const song of songs) {
        this.queue.add(this.withRequester({ ...song, platform: provider.platform }, this.fmRequesterName));
      }
      this.logger.debug({ count: songs.length, platform: provider.platform }, "FM queue refilled");
    } catch (err) {
      this.logger.error({ err }, "Failed to refill FM queue");
    }
  }

  private async cmdVote(msg?: TS3TextMessage): Promise<string> {
    if (!msg) return "Vote can only be used in TeamSpeak";
    this.voteSkipUsers.add(msg.invokerUid);
    const clients = await this.tsClient.getClientsInChannel();
    const totalUsers = clients.length - 1; // exclude the bot itself
    // At least 1 vote is always required — otherwise a single voter in an
    // otherwise empty channel (or a transient clients.length=1 race) could
    // unanimously "win" with needed=0.
    const needed = Math.max(1, Math.ceil(totalUsers / 2));
    const votes = this.voteSkipUsers.size;

    if (votes >= needed) {
      this.voteSkipUsers.clear();
      this.playNext().catch((err) => {
        this.logger.error({ err }, "playNext failed after vote skip");
      });
      return `Vote passed (${votes}/${needed}). Skipping to next song.`;
    }
    return `Vote to skip: ${votes}/${needed} (need ${needed - votes} more)`;
  }

  private async cmdLyrics(): Promise<string> {
    const song = this.queue.current();
    if (!song) return "Nothing is playing";
    const provider = this.getProviderFor(song.platform);
    const lyrics = await provider.getLyrics(song.id);
    if (lyrics.length === 0) return "No lyrics available";
    // Include the FULL lyrics (the send path chunks them under the message
    // cap). Cap only to avoid pathological spam — far above any normal song.
    const MAX_LYRIC_LINES = 200;
    const lines = lyrics.slice(0, MAX_LYRIC_LINES).map((l) => l.text);
    return `Lyrics for ${song.name}:\n${lines.join("\n")}`;
  }

  private async cmdMove(cmd: ParsedCommand): Promise<string> {
    if (!cmd.args) return "Usage: !move <channel name or ID>";
    await this.tsClient.joinChannel(cmd.args);
    return `Moved to channel: ${cmd.args}`;
  }

  private async cmdFollow(msg?: TS3TextMessage): Promise<string> {
    if (!msg) return "Follow can only be used in TeamSpeak";
    return "Following you to your channel";
  }

  private cmdHelp(): string {
    const p = this.config.commandPrefix;
    return [
      "TSMusicBot Commands:",
      `${p}play <song>  — Search and play (most popular match)`,
      `${p}play -q <song> — Search from QQ Music`,
      `${p}play -b <song> — Search from BiliBili`,
      `${p}play -y <song> — Search from YouTube (yt-dlp)`,
      `${p}search <name> — List top matches to pick a specific (same-name) song`,
      `${p}play #N       — Play the Nth result of the last ${p}search`,
      `${p}play id:<id>  — Play an exact song by id / URL (NetEase·QQ·BiliBili)`,
      `${p}add <song>   — Add to queue (also accepts #N / id: / URL)`,
      `${p}playnext <song> — Insert as next song (alias: ${p}pn)`,
      `${p}pause/resume — Pause/resume`,
      `${p}next/prev    — Next/previous`,
      `${p}stop         — Stop and clear queue`,
      `${p}vol <0-100>  — Set volume`,
      `${p}queue        — Show queue`,
      `${p}remove <pos> — Remove song at position (see ${p}queue)`,
      `${p}mode <seq|loop|random|rloop> — Play mode`,
      `${p}playlist <name or id> — Load playlist by name or ID`,
      `${p}playlist -q <name or id> — Load playlist from QQ Music`,
      `${p}album <id>   — Load album`,
      `${p}fm           — Personal FM (NetEase)`,
      `${p}artist <name> — Play songs by artist (loop)`,
      `${p}artist -q <name> — Artist loop from QQ Music`,
      `${p}vote         — Vote to skip`,
      `${p}lyrics       — Show lyrics`,
      `${p}now          — Current song info`,
      `${p}help         — This help message`,
    ].join("\n");
  }

  /**
   * Advance the queue and play the next song. If the resolved URL fails
   * (e.g., copyright/region restrictions for QQ), skips up to `maxRetries`
   * more songs looking for a playable one. Public so REST endpoints that
   * seed the queue can fall back to this retry-skip behavior.
   *
   * Returns true if a song actually started playing, false otherwise.
   */
  async playNext(maxRetries = 3): Promise<boolean> {
    if (this.isAdvancing || !this.connected) return false;
    this.isAdvancing = true;
    let started = false;
    try {
      this.voteSkipUsers.clear();
      const next = this.queue.next();
      if (next) {
        started = await this.resolveAndPlay(next);
        if (!started) {
          for (let i = 0; i < maxRetries && this.connected; i++) {
            const retry = this.queue.next();
            if (!retry) break;
            if (await this.resolveAndPlay(retry)) {
              started = true;
              break;
            }
          }
        }
        if (!started) {
          this.player.stop();
          this.profileManager.onSongChange(null).catch(() => {});
        } else if (this.isFmMode && this.queue.unplayedCount() <= 3) {
          // Proactive refill: when queue is running low, fetch more FM songs
          this.refillFm().catch(err => this.logger.error({ err }, "Proactive FM refill failed"));
        }
      } else {
        // Queue exhausted — in FM Random mode, refill and continue
        if (this.isFmMode) {
          await this.refillFm();
          const refillNext = this.queue.next();
          if (refillNext) {
            started = await this.resolveAndPlay(refillNext);
          }
          if (!started) {
            this.player.stop();
            this.profileManager.onSongChange(null).catch(() => {});
          }
        } else {
          // Queue exhausted on a non-FM source (skip-past-end or natural
          // last-track end via trackEnded→playNext). If the ending track was
          // served by the Spotify sidecar, tear it down like cmdStop —
          // otherwise the go-librespot Connect device stays active with the
          // track loaded (decoding into a detached/backpressured stream) and
          // currentSourceIsSpotify stays stale (corner-case R3-6).
          if (this.currentSourceIsSpotify) {
            this.spotifyController.stop();
            this.currentSourceIsSpotify = false;
          }
          this.player.stop();
          this.profileManager.onSongChange(null).catch(() => {});
        }
      }
      this.emit("stateChange");
      return started;
    } finally {
      // Reference-aware sweep: a finished local song that still sits in the
      // queue (sequential history, loop/repeat, or queued on another bot) is
      // preserved; only uploads no longer referenced anywhere are deleted.
      this.sweepLocalAudio("playback_finished");
      this.isAdvancing = false;
    }
  }

  private extractId(input: string): string {
    const match = input.match(/[?&]id=(\d+)/);
    if (match) return match[1];
    const pathMatch = input.match(/\/(\d+)/);
    if (pathMatch) return pathMatch[1];
    return input;
  }

  /** Serialize queue-mutation + play sequences so concurrent requests can't
   *  interleave (audible track must match queue.currentIndex). */
  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.playGate.then(fn, fn);
    this.playGate = next.catch(() => {});
    return next;
  }

  getStatus(): BotStatus {
    return {
      id: this.id,
      name: this.name,
      connected: this.connected,
      playing: this.player.getState() === "playing",
      paused: this.player.getState() === "paused",
      currentSong: this.queue.current(),
      queueSize: this.queue.size(),
      volume: this.player.getVolume(),
      playMode: this.queue.getMode(),
      elapsed: this.player.getElapsed(),
      effectiveDuration: this.effectiveDuration,
    };
  }

  getQueue(): QueuedSong[] {
    return this.queue.list();
  }

  getPlayer(): AudioPlayer {
    return this.player;
  }

  /** The per-bot Spotify sidecar controller. Exposed like getPlayer()/
   *  getQueueManager() so the shared, process-wide OAuth threaded in at
   *  construction (C3.1) is observable to callers/tests via getOAuth(). */
  getSpotifyController(): SpotifyController {
    return this.spotifyController;
  }

  /**
   * Route a seek to the Spotify sidecar for a spotify track (its PCM stream is
   * external — AudioPlayer.seek would respawn ffmpeg on the `spotify:` sentinel
   * and collide with the running stream), otherwise to the URL player.
   */
  seek(seconds: number): void {
    if (this.queue.current()?.platform === "spotify") {
      // The web route + AudioPlayer.seek are seconds-based, but
      // SpotifyController.seek expects milliseconds — convert here.
      this.spotifyController.seek(seconds * 1000).catch((err) =>
        this.logger.warn({ err }, "Spotify seek failed"));
      return;
    }
    this.player.seek(seconds);
  }

  getQueueManager(): PlayQueue {
    return this.queue;
  }

  isConnected(): boolean {
    return this.connected;
  }

  getProfileManager(): BotProfileManager {
    return this.profileManager;
  }

  getIdentityExport(): string | undefined {
    return this.tsClient.getIdentityExport();
  }
}
