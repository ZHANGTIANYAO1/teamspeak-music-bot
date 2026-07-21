import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import path from "node:path";
import {
  BotInstance,
  type BotInstanceOptions,
} from "./instance.js";
import type { MusicProvider } from "../music/provider.js";
import { YouTubeProvider } from "../music/youtube.js";
import type { BotDatabase } from "../data/database.js";
import { saveConfig, type BotConfig } from "../data/config.js";
import type { Logger } from "../logger.js";

import type { ServerProtocol } from "../ts-protocol/client.js";
import type { AvatarStore } from "../data/avatars.js";
import type { PermissionStore } from "../data/permissions.js";
import type { SpotifyOAuth } from "../music/spotify/spotify-oauth.js";
import { ManagedVoiceClientRegistry } from "./managed-voice-clients.js";

/**
 * Run bot.connect() with a hard deadline. If the handshake hangs (e.g. the
 * server silently drops the connection after initivexpand2), we tear the
 * instance down instead of waiting for the library's 60s idle timeout, so
 * the HTTP /start call returns promptly and the UI doesn't lock up.
 */
async function connectWithTimeout(
  bot: BotInstance,
  ms: number,
  logger: Logger
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`connect timeout after ${ms}ms`)),
      ms
    );
  });
  try {
    await Promise.race([bot.connect(), timeout]);
  } catch (err) {
    logger.warn(
      { err, botId: bot.id },
      "Connect failed or timed out — tearing down instance"
    );
    try {
      bot.disconnect();
    } catch {
      // ignore teardown errors
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface CreateBotParams {
  name: string;
  serverAddress: string;
  serverPort: number;
  queryPort?: number;
  nickname: string;
  defaultChannel?: string;
  channelId?: string;
  channelPassword?: string;
  autoStart?: boolean;
  /** Force TS3 or TS6 protocol; omit or "unknown" for auto-detect. */
  serverProtocol?: ServerProtocol;
  /** API key for TS6 HTTP Query (port 10080/10443). */
  ts6ApiKey?: string;
  /** Password required to join the TS server. */
  serverPassword?: string;
}

export class BotManager extends EventEmitter {
  private bots = new Map<string, BotInstance>();
  private readonly managedVoiceClients = new ManagedVoiceClientRegistry();
  private neteaseProvider: MusicProvider;
  private qqProvider: MusicProvider;
  private bilibiliProvider: MusicProvider;
  private youtubeProvider: MusicProvider;
  private localProvider: MusicProvider;
  private kugouProvider: MusicProvider;
  private spotifyProvider: MusicProvider;
  private jellyfinProvider: MusicProvider;
  private spotifyDataDir: string;
  private readonly spotifyOAuth?: SpotifyOAuth;
  private database: BotDatabase;
  private config: BotConfig;
  private logger: Logger;
  private avatarStore: AvatarStore;
  private permissions: PermissionStore;
  private configPath: string;

  constructor(
    neteaseProvider: MusicProvider,
    qqProvider: MusicProvider,
    bilibiliProvider: MusicProvider,
    database: BotDatabase,
    config: BotConfig,
    logger: Logger,
    avatarStore: AvatarStore,
    permissions: PermissionStore,
    configPath: string,
    localProvider?: MusicProvider,
    kugouProvider?: MusicProvider,
    spotifyProvider?: MusicProvider,
    spotifyDataDir?: string,
    spotifyOAuth?: SpotifyOAuth,
    jellyfinProvider?: MusicProvider
  ) {
    super();
    this.neteaseProvider = neteaseProvider;
    this.qqProvider = qqProvider;
    this.bilibiliProvider = bilibiliProvider;
    this.youtubeProvider = new YouTubeProvider();
    this.localProvider = localProvider ?? neteaseProvider;
    this.kugouProvider = kugouProvider ?? neteaseProvider;
    this.spotifyProvider = spotifyProvider ?? neteaseProvider;
    this.jellyfinProvider = jellyfinProvider ?? neteaseProvider;
    this.spotifyDataDir = spotifyDataDir ?? path.join(process.cwd(), "data", "spotify");
    this.spotifyOAuth = spotifyOAuth;
    // Let the local provider see which uploads are still referenced by any
    // bot's queue, so it never deletes a file another queue/bot still needs.
    const referenceable = this.localProvider as Partial<{
      setInUseResolver: (resolver: () => Set<string>) => void;
    }>;
    referenceable.setInUseResolver?.(() => this.getReferencedLocalSongIds());
    this.database = database;
    this.config = config;
    this.logger = logger;
    this.avatarStore = avatarStore;
    this.permissions = permissions;
    this.configPath = configPath;
  }

  async createBot(params: CreateBotParams): Promise<BotInstance> {
    const id = crypto.randomUUID();

    const bot = new BotInstance({
      id,
      name: params.name,
      tsOptions: {
        host: params.serverAddress,
        port: params.serverPort,
        queryPort: params.queryPort ?? 10011,
        nickname: params.nickname,
        defaultChannel: params.defaultChannel,
        channelId: params.channelId,
        channelPassword: params.channelPassword,
        serverPassword: params.serverPassword,
        serverProtocol: params.serverProtocol,
        ts6ApiKey: params.ts6ApiKey,
      },
      neteaseProvider: this.neteaseProvider,
      qqProvider: this.qqProvider,
      bilibiliProvider: this.bilibiliProvider,
      youtubeProvider: this.youtubeProvider,
      localProvider: this.localProvider,
      kugouProvider: this.kugouProvider,
      spotifyProvider: this.spotifyProvider,
      jellyfinProvider: this.jellyfinProvider,
      database: this.database,
      config: this.config,
      logger: this.logger,
      avatarStore: this.avatarStore,
      managedVoiceClients: this.managedVoiceClients,
      spotifyDataDir: this.spotifyDataDir,
      spotifyOAuth: this.spotifyOAuth,
    });

    this.bots.set(id, bot);
    this.emit("botInstance", bot);

    this.database.saveBotInstance({
      id,
      name: params.name,
      serverAddress: params.serverAddress,
      serverPort: params.serverPort,
      nickname: params.nickname,
      defaultChannel: params.defaultChannel ?? "",
      channelId: params.channelId ?? "",
      channelPassword: params.channelPassword ?? "",
      autoStart: params.autoStart ?? false,
      serverProtocol: params.serverProtocol ?? "",
      ts6ApiKey: params.ts6ApiKey ?? "",
      serverPassword: params.serverPassword ?? "",
    });

    this.logger.info({ botId: id, name: params.name }, "Bot instance created");
    return bot;
  }

  async removeBot(id: string): Promise<void> {
    const bot = this.bots.get(id);
    if (bot) {
      bot.disconnect();
      this.bots.delete(id);
    }
    this.database.deleteBotInstance(id);
    this.permissions.pruneBot(id);
    // Prune the deleted bot from the guest scope allow-list (mirrors permissions.pruneBot).
    if (Array.isArray(this.config.guestMode.bots) && this.config.guestMode.bots.includes(id)) {
      this.config.guestMode.bots = this.config.guestMode.bots.filter((b) => b !== id);
      saveConfig(this.configPath, this.config);
    }
    this.emit("botInstanceRemoved", id);
    this.logger.info({ botId: id }, "Bot instance removed");
  }

  updateBot(id: string, params: Partial<CreateBotParams>): void {
    const instances = this.database.getBotInstances();
    const existing = instances.find((i) => i.id === id);
    if (!existing) throw new Error(`Bot ${id} not found`);

    this.database.saveBotInstance({
      ...existing,
      name: params.name ?? existing.name,
      serverAddress: params.serverAddress ?? existing.serverAddress,
      serverPort: params.serverPort ?? existing.serverPort,
      nickname: params.nickname ?? existing.nickname,
      defaultChannel: params.defaultChannel ?? existing.defaultChannel,
      channelId: params.channelId ?? existing.channelId,
      channelPassword: params.channelPassword ?? existing.channelPassword,
      serverProtocol: params.serverProtocol ?? existing.serverProtocol,
      ts6ApiKey: params.ts6ApiKey ?? existing.ts6ApiKey,
      serverPassword: params.serverPassword ?? existing.serverPassword,
    });
    // Update in-memory name immediately (other fields need reconnect)
    const bot = this.bots.get(id);
    if (bot && params.name) {
      bot.name = params.name;
    }
    this.logger.info({ botId: id }, "Bot instance config updated (connection changes need restart)");
  }

  getBotConfig(id: string): import("../data/database.js").BotInstance | undefined {
    return this.database.getBotInstances().find((i) => i.id === id);
  }

  getBot(id: string): BotInstance | undefined {
    return this.bots.get(id);
  }

  getAllBots(): BotInstance[] {
    return Array.from(this.bots.values());
  }

  /** Local upload ids still referenced by any bot's queue. The local provider
   *  uses this to avoid deleting a file another queue/bot is still using. */
  getReferencedLocalSongIds(): Set<string> {
    const ids = new Set<string>();
    for (const bot of this.bots.values()) {
      for (const song of bot.getQueueManager().list()) {
        if (song.platform === "local") ids.add(song.id);
      }
    }
    return ids;
  }

  async startBot(id: string): Promise<void> {
    const oldBot = this.bots.get(id);
    if (!oldBot) throw new Error(`Bot ${id} not found`);

    // Always tear down the outgoing instance before creating a replacement.
    // Covers three cases:
    //   1. oldBot is fully connected (manual restart)
    //   2. oldBot is mid-handshake from a prior rapid start (isConnected()
    //      still returns false but the library client is live and will leak
    //      a TS session if we abandon it)
    //   3. oldBot was just created by createBot but never connected — the
    //      disconnect call is a cheap no-op here.
    // Calling disconnect() is idempotent (disconnectEmitted guards event
    // emission), so this is safe in all states.
    oldBot.disconnect();

    // Reload config from database so updated settings (channel, nickname, etc.) take effect
    const saved = this.database.getBotInstances().find((i) => i.id === id);
    if (saved) {
      const proto = saved.serverProtocol as "ts3" | "ts6" | "" | undefined;
      const bot = new BotInstance({
        id: saved.id,
        name: saved.name,
        tsOptions: {
          host: saved.serverAddress,
          port: saved.serverPort,
          queryPort: proto === "ts6" ? 10080 : 10011,
          nickname: saved.nickname,
          // Reuse the stored identity so server groups assigned to this bot
          // survive restarts — without this the TS server sees a new UID
          // each connect and strips all previously granted groups.
          identity: saved.identity || undefined,
          defaultChannel: saved.defaultChannel || undefined,
          channelId: saved.channelId || undefined,
          channelPassword: saved.channelPassword || undefined,
          serverPassword: saved.serverPassword || undefined,
          serverProtocol: proto === "ts3" || proto === "ts6" ? proto : undefined,
          ts6ApiKey: saved.ts6ApiKey || undefined,
        },
        neteaseProvider: this.neteaseProvider,
        qqProvider: this.qqProvider,
        bilibiliProvider: this.bilibiliProvider,
        youtubeProvider: this.youtubeProvider,
        localProvider: this.localProvider,
        kugouProvider: this.kugouProvider,
        spotifyProvider: this.spotifyProvider,
        jellyfinProvider: this.jellyfinProvider,
        database: this.database,
        config: this.config,
        logger: this.logger,
        avatarStore: this.avatarStore,
        managedVoiceClients: this.managedVoiceClients,
        spotifyDataDir: this.spotifyDataDir,
        spotifyOAuth: this.spotifyOAuth,
      });
      this.bots.set(id, bot);
      this.emit("botInstance", bot);
      await connectWithTimeout(bot, 15_000, this.logger);
      // Mark as autoStart so it reconnects on Docker restart, and persist identity
      this.database.saveBotInstance({ ...saved, autoStart: true });
      this.persistBotIdentity(saved, bot);
    } else {
      await connectWithTimeout(oldBot, 15_000, this.logger);
    }
  }

  stopBot(id: string): void {
    const bot = this.bots.get(id);
    if (!bot) throw new Error(`Bot ${id} not found`);
    bot.disconnect();

    // Mark as not autoStart so it stays stopped on Docker restart
    const saved = this.database.getBotInstances().find((i) => i.id === id);
    if (saved) {
      this.database.saveBotInstance({ ...saved, autoStart: false });
    }
  }

  async loadSavedBots(): Promise<void> {
    const savedInstances = this.database.getBotInstances();
    for (const saved of savedInstances) {
      const proto = saved.serverProtocol as "ts3" | "ts6" | "" | undefined;
      const bot = new BotInstance({
        id: saved.id,
        name: saved.name,
        tsOptions: {
          host: saved.serverAddress,
          port: saved.serverPort,
          queryPort: proto === "ts6" ? 10080 : 10011,
          nickname: saved.nickname,
          identity: saved.identity || undefined,
          defaultChannel: saved.defaultChannel || undefined,
          channelId: saved.channelId || undefined,
          channelPassword: saved.channelPassword || undefined,
          serverPassword: saved.serverPassword || undefined,
          serverProtocol: proto === "ts3" || proto === "ts6" ? proto : undefined,
          ts6ApiKey: saved.ts6ApiKey || undefined,
        },
        neteaseProvider: this.neteaseProvider,
        qqProvider: this.qqProvider,
        bilibiliProvider: this.bilibiliProvider,
        youtubeProvider: this.youtubeProvider,
        localProvider: this.localProvider,
        kugouProvider: this.kugouProvider,
        spotifyProvider: this.spotifyProvider,
        jellyfinProvider: this.jellyfinProvider,
        database: this.database,
        config: this.config,
        logger: this.logger,
        avatarStore: this.avatarStore,
        managedVoiceClients: this.managedVoiceClients,
        spotifyDataDir: this.spotifyDataDir,
        spotifyOAuth: this.spotifyOAuth,
      });

      this.bots.set(saved.id, bot);
      this.emit("botInstance", bot);

      // Only auto-connect bots that have autoStart enabled
      if (saved.autoStart) {
        bot.connect().then(() => {
          // Persist identity after successful connection for future restarts
          this.persistBotIdentity(saved, bot);
          this.logger.info(
            { botId: saved.id, name: saved.name },
            "Auto-connected saved bot"
          );
        }).catch((err) => {
          this.logger.error(
            { err, botId: saved.id, name: saved.name },
            "Failed to auto-connect bot (start manually from Settings)"
          );
        });

        // Stagger connections to avoid overwhelming the TS server
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } else {
        this.logger.info(
          { botId: saved.id, name: saved.name },
          "Loaded bot (autoStart disabled, not connecting)"
        );
      }
    }

    this.logger.info(
      { count: savedInstances.length },
      "Loaded saved bot instances"
    );
  }

  private persistBotIdentity(saved: import("../data/database.js").BotInstance, bot: BotInstance): void {
    const identity = bot.getIdentityExport();
    if (identity && identity !== saved.identity) {
      this.database.saveBotInstance({ ...saved, identity });
    }
  }

  shutdown(): void {
    for (const bot of this.bots.values()) {
      bot.disconnect();
    }
    this.bots.clear();
  }
}
