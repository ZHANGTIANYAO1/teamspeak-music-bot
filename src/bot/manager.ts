import crypto from "node:crypto";
import {
  BotInstance,
  type BotInstanceOptions,
} from "./instance.js";
import type { MusicProvider } from "../music/provider.js";
import type { BotDatabase } from "../data/database.js";
import type { BotConfig } from "../data/config.js";
import type { Logger } from "../logger.js";

export interface CreateBotParams {
  name: string;
  serverAddress: string;
  serverPort: number;
  queryPort?: number;
  nickname: string;
  defaultChannel?: string;
  channelPassword?: string;
  serverPassword?: string;
  autoStart?: boolean;
}

export class BotManager {
  private bots = new Map<string, BotInstance>();
  private neteaseProvider: MusicProvider;
  private qqProvider: MusicProvider;
  private bilibiliProvider: MusicProvider;
  private database: BotDatabase;
  private config: BotConfig;
  private logger: Logger;

  constructor(
    neteaseProvider: MusicProvider,
    qqProvider: MusicProvider,
    bilibiliProvider: MusicProvider,
    database: BotDatabase,
    config: BotConfig,
    logger: Logger
  ) {
    this.neteaseProvider = neteaseProvider;
    this.qqProvider = qqProvider;
    this.bilibiliProvider = bilibiliProvider;
    this.database = database;
    this.config = config;
    this.logger = logger;
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
        channelPassword: params.channelPassword,
        serverPassword: params.serverPassword,
      },
      neteaseProvider: this.neteaseProvider,
      qqProvider: this.qqProvider,
      bilibiliProvider: this.bilibiliProvider,
      database: this.database,
      config: this.config,
      logger: this.logger,
    });

    this.bots.set(id, bot);

    this.database.saveBotInstance({
      id,
      name: params.name,
      serverAddress: params.serverAddress,
      serverPort: params.serverPort,
      nickname: params.nickname,
      defaultChannel: params.defaultChannel ?? "",
      channelPassword: params.channelPassword ?? "",
      serverPassword: params.serverPassword ?? "",
      autoStart: params.autoStart ?? false,
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
      channelPassword: params.channelPassword ?? existing.channelPassword,
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

  async startBot(id: string): Promise<void> {
    const bot = this.bots.get(id);
    if (!bot) throw new Error(`Bot ${id} not found`);
    await bot.connect();
  }

  stopBot(id: string): void {
    const bot = this.bots.get(id);
    if (!bot) throw new Error(`Bot ${id} not found`);
    bot.disconnect();
  }

  async loadSavedBots(): Promise<void> {
    const savedInstances = this.database.getBotInstances();
    for (const saved of savedInstances) {
      const bot = new BotInstance({
        id: saved.id,
        name: saved.name,
        tsOptions: {
          host: saved.serverAddress,
          port: saved.serverPort,
          queryPort: 10011,
          nickname: saved.nickname,
          defaultChannel: saved.defaultChannel || undefined,
          channelPassword: saved.channelPassword || undefined,
          serverPassword: saved.serverPassword || undefined,
        },
        neteaseProvider: this.neteaseProvider,
        qqProvider: this.qqProvider,
        bilibiliProvider: this.bilibiliProvider,
        database: this.database,
        config: this.config,
        logger: this.logger,
      });

      this.bots.set(saved.id, bot);

      // Auto-connect in background (non-blocking, won't affect other bots)
      bot.connect().then(() => {
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
    }

    this.logger.info(
      { count: savedInstances.length },
      "Loaded saved bot instances"
    );
  }

  shutdown(): void {
    for (const bot of this.bots.values()) {
      bot.disconnect();
    }
    this.bots.clear();
  }
}
