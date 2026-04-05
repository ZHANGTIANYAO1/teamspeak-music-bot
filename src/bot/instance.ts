import { EventEmitter } from "node:events";
import {
  TS3Client,
  type TS3ClientOptions,
  type TS3TextMessage,
} from "../ts-protocol/client.js";
import { AudioPlayer } from "../audio/player.js";
import { PlayQueue, PlayMode, type QueuedSong } from "../audio/queue.js";
import type { MusicProvider } from "../music/provider.js";
import {
  parseCommand,
  isAdminCommand,
  type ParsedCommand,
} from "./commands.js";
import type { Logger } from "../logger.js";
import type { BotDatabase } from "../data/database.js";
import type { BotConfig } from "../data/config.js";

export interface BotInstanceOptions {
  id: string;
  name: string;
  tsOptions: TS3ClientOptions;
  neteaseProvider: MusicProvider;
  qqProvider: MusicProvider;
  bilibiliProvider: MusicProvider;
  youtubeProvider: MusicProvider;
  database: BotDatabase;
  config: BotConfig;
  logger: Logger;
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
}

export class BotInstance extends EventEmitter {
  readonly id: string;
  name: string;

  private tsClient: TS3Client;
  private player: AudioPlayer;
  private queue: PlayQueue;
  private neteaseProvider: MusicProvider;
  private qqProvider: MusicProvider;
  private bilibiliProvider: MusicProvider;
  private youtubeProvider: MusicProvider;
  private database: BotDatabase;
  private config: BotConfig;
  private logger: Logger;
  private connected = false;
  private voteSkipUsers = new Set<string>();
  private isAdvancing = false;

  constructor(options: BotInstanceOptions) {
    super();
    this.id = options.id;
    this.name = options.name;
    this.neteaseProvider = options.neteaseProvider;
    this.qqProvider = options.qqProvider;
    this.bilibiliProvider = options.bilibiliProvider;
    this.youtubeProvider = options.youtubeProvider;
    this.database = options.database;
    this.config = options.config;
    this.logger = options.logger.child({ botId: this.id });

    this.tsClient = new TS3Client(options.tsOptions, this.logger);
    this.player = new AudioPlayer(this.logger);
    this.queue = new PlayQueue();

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
  }

  private setupTsEvents(): void {
    this.tsClient.on("textMessage", (msg: TS3TextMessage) => {
      this.handleTextMessage(msg).catch((err) => {
        this.logger.error({ err }, "Unhandled error in text message handler");
      });
    });

    this.tsClient.on("disconnected", () => {
      // Avoid duplicate event if disconnect() was called explicitly
      // (it already set connected = false and emitted "disconnected").
      if (!this.connected) return;
      this.connected = false;
      this.player.stop();
      this.emit("disconnected");
    });
  }

  async connect(): Promise<void> {
    await this.tsClient.connect();
    this.connected = true;
    this.emit("connected");
  }

  disconnect(): void {
    this.player.stop();
    // Set connected = false BEFORE tsClient.disconnect() so that the
    // "disconnected" event handler (setupTsEvents) won't emit a duplicate.
    this.connected = false;
    this.tsClient.disconnect();
    this.emit("disconnected");
  }

  private async handleTextMessage(msg: TS3TextMessage): Promise<void> {
    const parsed = parseCommand(
      msg.message,
      this.config.commandPrefix,
      this.config.commandAliases
    );
    if (!parsed) return;

    if (isAdminCommand(parsed.name)) {
      // TODO: Check if invoker is in adminGroups
    }

    this.logger.info(
      { command: parsed.name, args: parsed.args, invoker: msg.invokerName },
      "Command received"
    );

    try {
      const response = await this.executeCommand(parsed, msg);
      if (response) {
        await this.tsClient.sendTextMessage(response);
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

  async executeCommand(
    cmd: ParsedCommand,
    msg?: TS3TextMessage
  ): Promise<string | null> {
    switch (cmd.name) {
      case "play":
        return this.cmdPlay(cmd);
      case "add":
        return this.cmdAdd(cmd);
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
        return this.cmdPlaylist(cmd);
      case "album":
        return this.cmdAlbum(cmd);
      case "fm":
        return this.cmdFm();
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

  getProviderFor(platform: "netease" | "qq" | "bilibili" | "youtube"): MusicProvider {
    if (platform === "youtube") return this.youtubeProvider;
    if (platform === "bilibili") return this.bilibiliProvider;
    return platform === "qq" ? this.qqProvider : this.neteaseProvider;
  }

  private getProvider(flags: Set<string>): MusicProvider {
    if (flags.has("y")) return this.youtubeProvider;
    if (flags.has("b")) return this.bilibiliProvider;
    if (flags.has("q")) return this.qqProvider;
    return this.neteaseProvider;
  }

  /** Resolve URL for a song and start playing it. Skips to next if URL fails. */
  async resolveAndPlay(song: QueuedSong): Promise<boolean> {
    const provider = this.getProviderFor(song.platform);
    try {
      const url = await provider.getSongUrl(song.id);
      if (!url) {
        this.logger.warn({ songId: song.id, name: song.name }, "No URL available, skipping");
        return false;
      }
      song.url = url;
      this.player.play(url);
      this.database.addPlayHistory({
        botId: this.id,
        songId: song.id,
        songName: song.name,
        artist: song.artist,
        album: song.album,
        platform: song.platform,
        coverUrl: song.coverUrl,
      });
      this.emit("stateChange");
      return true;
    } catch (err) {
      this.logger.error({ err, songId: song.id }, "Failed to resolve URL");
      return false;
    }
  }

  private async cmdPlay(cmd: ParsedCommand): Promise<string> {
    if (!cmd.args) return "Usage: !play <song name or URL>";
    const provider = this.getProvider(cmd.flags);
    const result = await provider.search(cmd.args, 1);
    if (result.songs.length === 0)
      return `No results found for: ${cmd.args}`;

    const song = result.songs[0];
    this.queue.clear();
    this.queue.add({ ...song, platform: provider.platform });
    this.queue.play();

    const ok = await this.resolveAndPlay(this.queue.current()!);
    if (!ok) return `Cannot play: ${song.name}`;
    return `Now playing: ${song.name} - ${song.artist}`;
  }

  private async cmdAdd(cmd: ParsedCommand): Promise<string> {
    if (!cmd.args) return "Usage: !add <song name>";
    const provider = this.getProvider(cmd.flags);
    const result = await provider.search(cmd.args, 1);
    if (result.songs.length === 0)
      return `No results found for: ${cmd.args}`;

    const song = result.songs[0];
    this.queue.add({ ...song, platform: provider.platform });
    this.emit("stateChange");
    return `Added to queue: ${song.name} - ${song.artist} (position ${this.queue.size()})`;
  }

  private cmdPause(): string {
    this.player.pause();
    this.emit("stateChange");
    return "Paused";
  }

  private cmdResume(): string {
    this.player.resume();
    this.emit("stateChange");
    return "Resumed";
  }

  private cmdStop(): string {
    this.player.stop();
    this.queue.clear();
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
    const prev = this.queue.prev();
    if (prev) {
      const ok = await this.resolveAndPlay(prev);
      if (!ok) return "Cannot play previous song";
      return `Now playing: ${prev.name} - ${prev.artist}`;
    }
    return "No previous song";
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
    this.player.stop();
    this.queue.clear();
    this.emit("stateChange");
    return "Queue cleared";
  }

  private cmdRemove(cmd: ParsedCommand): string {
    const index = parseInt(cmd.args, 10) - 1;
    if (isNaN(index) || index < 0) return "Usage: !remove <number>";
    const removed = this.queue.remove(index);
    if (!removed) return "Invalid position";
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

  private async cmdPlaylist(cmd: ParsedCommand): Promise<string> {
    if (!cmd.args) return "Usage: !playlist <playlist ID or URL>";
    const provider = this.getProvider(cmd.flags);
    const id = this.extractId(cmd.args);
    const songs = await provider.getPlaylistSongs(id);
    if (songs.length === 0) return "Playlist is empty or not found";

    this.queue.clear();
    for (const song of songs) {
      this.queue.add({ ...song, platform: provider.platform });
    }
    const first = this.queue.play();
    if (first) await this.resolveAndPlay(first);
    this.emit("stateChange");
    return `Loaded ${songs.length} songs. Now playing: ${first?.name ?? "unknown"}`;
  }

  private async cmdAlbum(cmd: ParsedCommand): Promise<string> {
    if (!cmd.args) return "Usage: !album <album ID>";
    const provider = this.getProvider(cmd.flags);
    const songs = await provider.getAlbumSongs(cmd.args);
    if (songs.length === 0) return "Album is empty or not found";

    this.queue.clear();
    for (const song of songs) {
      this.queue.add({ ...song, platform: provider.platform });
    }
    const first = this.queue.play();
    if (first) await this.resolveAndPlay(first);
    this.emit("stateChange");
    return `Loaded ${songs.length} songs. Now playing: ${first?.name ?? "unknown"}`;
  }

  private async cmdFm(): Promise<string> {
    if (!this.neteaseProvider.getPersonalFm) {
      return "Personal FM is only available for NetEase Cloud Music";
    }
    const songs = await this.neteaseProvider.getPersonalFm();
    if (songs.length === 0)
      return "No FM songs available (need to login first)";

    this.queue.clear();
    for (const song of songs) {
      this.queue.add({ ...song, platform: "netease" });
    }
    const first = this.queue.play();
    if (first) await this.resolveAndPlay(first);
    this.emit("stateChange");
    return `Personal FM started: ${first?.name ?? "unknown"} - ${first?.artist ?? ""}`;
  }

  private async cmdVote(msg?: TS3TextMessage): Promise<string> {
    if (!msg) return "Vote can only be used in TeamSpeak";
    this.voteSkipUsers.add(msg.invokerUid);
    const clients = await this.tsClient.getClientsInChannel();
    const totalUsers = clients.length - 1;
    const needed = Math.ceil(totalUsers / 2);
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
    const lines = lyrics.slice(0, 10).map((l) => l.text);
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
      `${p}play <song>  — Search and play`,
      `${p}play -q <song> — Search from QQ Music`,
      `${p}play -b <song> — Search from BiliBili`,
      `${p}play -y <song> — Search from YouTube`,
      `${p}add <song>   — Add to queue`,
      `${p}pause/resume — Pause/resume`,
      `${p}next/prev    — Next/previous`,
      `${p}stop         — Stop and clear queue`,
      `${p}vol <0-100>  — Set volume`,
      `${p}queue        — Show queue`,
      `${p}mode <seq|loop|random|rloop> — Play mode`,
      `${p}playlist <id> — Load playlist`,
      `${p}album <id>   — Load album`,
      `${p}fm           — Personal FM (NetEase)`,
      `${p}vote         — Vote to skip`,
      `${p}lyrics       — Show lyrics`,
      `${p}now          — Current song info`,
      `${p}help         — This help message`,
    ].join("\n");
  }

  private async playNext(): Promise<void> {
    if (this.isAdvancing || !this.connected) return;
    this.isAdvancing = true;
    try {
      this.voteSkipUsers.clear();
      const next = this.queue.next();
      if (next) {
        let started = await this.resolveAndPlay(next);
        if (!started) {
          // Skip to next if URL resolve fails (up to 3 retries)
          for (let i = 0; i < 3 && this.connected; i++) {
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
        }
      } else {
        this.player.stop();
      }
      this.emit("stateChange");
    } finally {
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
    };
  }

  getQueue(): QueuedSong[] {
    return this.queue.list();
  }

  getPlayer(): AudioPlayer {
    return this.player;
  }

  getQueueManager(): PlayQueue {
    return this.queue;
  }

  isConnected(): boolean {
    return this.connected;
  }
}
