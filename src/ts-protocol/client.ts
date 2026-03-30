import { EventEmitter } from "node:events";
import {
  Client as TS3FullClient,
  generateIdentity as genTS3Identity,
  identityFromString,
  sendTextMessage,
  listChannels,
  listClients,
  clientMove,
  type Identity,
  type TextMessage,
  type ClientInfo,
} from "@honeybbq/teamspeak-client";
import type { Logger } from "../logger.js";

export { CODEC_OPUS_MUSIC } from "./voice.js";

export interface TS3ClientOptions {
  host: string;
  port: number; // Voice/virtual server port (default 9987)
  queryPort: number; // ServerQuery port (default 10011) — unused now, kept for compat
  nickname: string;
  identity?: string; // Exported identity string, or undefined to generate new
  defaultChannel?: string;
  channelPassword?: string;
  serverPassword?: string;
}

export interface TS3TextMessage {
  invokerName: string;
  invokerId: string;
  invokerUid: string;
  message: string;
  targetMode: number; // 1=private, 2=channel, 3=server
}

export class TS3Client extends EventEmitter {
  private client: TS3FullClient | null = null;
  private identity: Identity;
  private clientId = 0;
  private logger: Logger;
  private disconnecting = false;

  constructor(private options: TS3ClientOptions, logger: Logger) {
    super();
    this.logger = logger;

    if (options.identity) {
      this.identity = identityFromString(options.identity);
    } else {
      this.identity = genTS3Identity(8);
    }
  }

  async connect(): Promise<void> {
    const addr = `${this.options.host}:${this.options.port}`;
    this.logger.info({ addr }, "Connecting to TeamSpeak server (full client protocol)");

    this.client = new TS3FullClient(this.identity, addr, this.options.nickname, {
      logger: {
        debug: (msg) => this.logger.debug(msg),
        info: (msg) => this.logger.info(msg),
        warn: (msg) => this.logger.warn(msg),
        error: (msg) => this.logger.error(msg),
      },
    });

    this.client.on("textMessage", (msg: TextMessage) => {
      const tsMsg: TS3TextMessage = {
        invokerName: msg.invokerName,
        invokerId: String(msg.invokerID),
        invokerUid: msg.invokerUID,
        message: msg.message,
        targetMode: msg.targetMode,
      };
      this.emit("textMessage", tsMsg);
    });

    this.client.on("disconnected", (err) => {
      this.logger.warn({ err: err?.message }, "Connection closed");
      this.clientId = 0;
      this.emit("disconnected");
    });

    this.client.on("clientEnter", (info: ClientInfo) => {
      this.logger.debug(
        { nickname: info.nickname, id: info.id },
        "Client entered"
      );
    });

    await this.client.connect();
    await this.client.waitConnected();
    this.clientId = this.client.clientID();
    this.logger.info({ clientId: this.clientId }, "Logged in (visible client)");

    // Join default channel if specified
    if (this.options.defaultChannel) {
      await this.joinChannel(
        this.options.defaultChannel,
        this.options.channelPassword
      );
    }

    this.emit("connected");
  }

  async joinChannel(channelName: string, password?: string): Promise<void> {
    if (!this.client) return;

    try {
      const channels = await listChannels(this.client);
      const channel = channels.find((ch) => ch.name === channelName);

      if (!channel) {
        this.logger.warn({ channelName }, "Channel not found");
        return;
      }

      await clientMove(
        this.client,
        this.clientId,
        channel.id,
        password
      );
      this.logger.info(
        { channelName, cid: channel.id.toString() },
        "Joined channel"
      );
    } catch (err) {
      this.logger.error({ err, channelName }, "Failed to join channel");
    }
  }

  async sendTextMessage(
    message: string,
    targetMode: number = 2
  ): Promise<void> {
    if (!this.client) return;
    // targetMode 2 = channel, target 0 = current channel
    const target = targetMode === 2 ? BigInt(0) : BigInt(this.clientId);
    await sendTextMessage(this.client, targetMode, target, message);
  }

  async getClientsInChannel(): Promise<ClientInfo[]> {
    if (!this.client) return [];
    try {
      const allClients = await listClients(this.client);
      const myChannelId = this.client.channelID();
      return allClients.filter((c) => c.channelID === myChannelId);
    } catch {
      return [];
    }
  }

  sendVoiceData(opusFrame: Buffer): void {
    if (!this.client || this.disconnecting) return;
    this.client.sendVoice(opusFrame, 5);
  }

  getIdentityExport(): string {
    return this.identity.toString();
  }

  getClientId(): number {
    return this.clientId;
  }

  disconnect(): void {
    if (this.client && !this.disconnecting) {
      this.disconnecting = true;
      const client = this.client;
      client.disconnect().catch(() => {}).finally(() => {
        if (this.client === client) {
          this.client = null;
        }
        this.disconnecting = false;
      });
    }
    this.clientId = 0;
    this.logger.info("Disconnected from TeamSpeak server");
  }
}
