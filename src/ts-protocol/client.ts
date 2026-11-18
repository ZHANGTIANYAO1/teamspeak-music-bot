import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import {
  asChannelID,
  asClientID,
  Codec,
  deleteFile,
  getClientProperties,
  initFileUpload,
  listChannels,
  listClients,
  moveClient,
  sendChannelMessage,
  sendPluginCommand as sdkSendPluginCommand,
  sendPrivateMessage,
  sendServerMessage,
  type ChannelID,
  type ClientEnterEvent,
  type ClientEntry,
  type ClientLeaveEvent,
  type ClientMovedEvent,
  type DisconnectedEvent,
  type FileUploadInfo,
  type PluginCommandEvent,
  type PluginCommandTarget,
  type TextMessageEvent,
  type VoiceDataEvent,
} from "@honeybbq/teamspeak";
import {
  Client as TS3FullClient,
  generateIdentitySync as genTS3Identity,
  parseIdentity,
  UIDAlgorithm,
  type ClientOptions as SDKClientOptions,
  type Identity,
} from "@honeybbq/teamspeak/client";
import type { Logger } from "../logger.js";
import {
  detectServerProtocol,
  type ServerProtocol,
} from "./protocol-detect.js";
import { TS6HttpQuery } from "./http-query.js";
import {
  TrackingVoiceEndpointResolver,
  type ResolvedVoiceEndpoint,
} from "./voice-endpoint.js";

export { CODEC_OPUS_MUSIC } from "./voice.js";
export type { ServerProtocol } from "./protocol-detect.js";
export type { FileUploadInfo, PluginCommandTarget } from "@honeybbq/teamspeak";

/** Escape a string for use in TS3 ServerQuery-style commands. */
export function escapeTS3(str: string): string {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/ /g, "\\s")
    .replace(/\//g, "\\/")
    .replace(/\|/g, "\\p")
    .replace(/\t/g, "\\t")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
}

export interface TS3ClientOptions {
  host: string;
  port: number; // Voice/virtual server port (default 9987)
  queryPort: number; // ServerQuery port (10011 for TS3, 10080 for TS6 HTTP)
  nickname: string;
  identity?: string; // Exported identity string, or undefined to generate new
  defaultChannel?: string;
  channelId?: string; // Numeric channel ID (takes precedence over defaultChannel)
  channelPassword?: string;
  serverPassword?: string;
  /** Force a specific protocol instead of auto-detecting. */
  serverProtocol?: ServerProtocol;
  /** API key for TS6 HTTP Query authentication. */
  ts6ApiKey?: string;
  /** @internal Test seam to substitute the underlying SDK Client instance. */
  sdkClientFactory?: (
    identity: Identity,
    addr: string,
    nickname: string,
    options: SDKClientOptions,
  ) => TS3FullClient;
}

export interface TS3TextMessage {
  invokerName: string;
  invokerId: string;
  invokerUid: string;
  message: string;
  targetMode: number; // 1=private, 2=channel, 3=server
  invokerGroups: string[]; // sender's TS server-group ids; [] when not in view cache
}

export interface TS3PluginCommand {
  name: string;
  data: string;
  invokerId: number;
  invokerName: string;
  invokerUid: string;
}

/** Lightweight voice-packet signal used for activity detection. The encoded
 * payload is intentionally not forwarded beyond this protocol wrapper. */
export interface TS3VoiceActivity {
  clientId: number;
  codec: number;
  /** Stable TeamSpeak identity when the sender is present in the client view. */
  clientUid?: string;
}

/** Send acceptance only: an accepted UDP call does not confirm delivery. */
export interface TS3VoiceSendFailure {
  code?: string;
  consecutiveFailures: number;
  durationMs: number;
}

/** Sticky failure status lets playback stay paused when the terminal event
 * already fired during another track or an idle URL lookup. */
export type TS3VoiceSendResult = "accepted" | "retrying" | "failed" | "unavailable";

const VOICE_SEND_FAILURE_TIMEOUT_MS = 2_000;
const SAFE_SOCKET_ERROR_CODES = new Set([
  "ERR_SOCKET_DGRAM_NOT_RUNNING", "ERR_SOCKET_DGRAM_NOT_CONNECTED",
  "EPIPE", "ENOBUFS", "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH",
  "ENETUNREACH", "ENETDOWN", "EACCES", "EPERM", "EINVAL", "EMSGSIZE",
  "EAGAIN", "ENOTCONN", "EBADF",
]);

function safeSocketErrorCode(error: unknown): string | undefined {
  try {
    if (!error || typeof error !== "object") return undefined;
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" && SAFE_SOCKET_ERROR_CODES.has(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

// Command notifications and UDP voice packets can be reordered in flight.
// Retain a leaving client's UID briefly so its final packet is still
// attributable; a new clientEnter for the same id cancels and overwrites it.
const VISIBLE_CLIENT_UID_RELEASE_GRACE_MS = 1_000;

/**
 * Map the library's TextMessageEvent to our wrapper. Preserves invokerGroups (the
 * sender's TS server groups), which the library populates only when the sender
 * is in the bot's client-view cache; otherwise it is []. Used by the chat
 * command permission gate.
 */
export function toTS3TextMessage(msg: TextMessageEvent): TS3TextMessage {
  return {
    invokerName: msg.invokerName,
    invokerId: String(msg.invokerID),
    invokerUid: msg.invokerUID,
    message: msg.message,
    targetMode: msg.targetMode,
    invokerGroups: (msg.invokerGroups ?? []).map((groupId) => String(groupId)),
  };
}

export function toTS3PluginCommand(ev: PluginCommandEvent): TS3PluginCommand {
  return {
    name: ev.name,
    data: ev.data,
    invokerId: Number(ev.invokerID),
    invokerName: ev.invokerName,
    invokerUid: ev.invokerUID,
  };
}

export class TS3Client extends EventEmitter {
  private client: TS3FullClient | null = null;
  private identity: Identity;
  private clientUid: string;
  private clientId = 0;
  private readonly visibleClientUids = new Map<number, string>();
  private readonly visibleClientUidReleaseTimers = new Map<
    number,
    ReturnType<typeof setTimeout>
  >();
  private logger: Logger;
  private disconnecting = false;
  private detectedProtocol: ServerProtocol = "unknown";
  private httpQuery: TS6HttpQuery | null = null;
  private udpErrorTimer: ReturnType<typeof setTimeout> | null = null;
  private connectionGeneration = 0;
  private voiceFailureTimer: ReturnType<typeof setTimeout> | null = null;
  private voiceFailure: { code?: string; consecutiveFailures: number; startedAt: number } | null = null;
  private voiceEndpointResolver = new TrackingVoiceEndpointResolver();

  constructor(private options: TS3ClientOptions, logger: Logger) {
    super();
    this.logger = logger;

    if (options.identity) {
      this.identity = parseIdentity(options.identity);
    } else {
      this.identity = genTS3Identity(8);
    }
    this.clientUid = this.identity.uid(UIDAlgorithm.SHA1);
  }

  /** The detected (or forced) server protocol after connect(). */
  getServerProtocol(): ServerProtocol {
    return this.detectedProtocol;
  }

  /** TS6 HTTP Query client (available after connecting to a TS6 server). */
  getHttpQuery(): TS6HttpQuery | null {
    return this.httpQuery;
  }

  async connect(): Promise<void> {
    const generation = ++this.connectionGeneration;
    this.resetVoiceSendState();
    this.disconnecting = false;
    const voiceEndpointResolver = new TrackingVoiceEndpointResolver();
    this.voiceEndpointResolver = voiceEndpointResolver;
    this.clearVisibleClientUids();
    this.httpQuery = null;
    // Clean up any existing connection before creating a new one
    const previousClient = this.client;
    this.client = null;
    this.clientId = 0;
    if (previousClient) {
      this.logger.info("Cleaning up previous connection before reconnecting");
      try {
        await previousClient.disconnect();
      } catch {
        // Ignore errors during cleanup
      }
      if (generation !== this.connectionGeneration) return;
    }

    const addr = `${this.options.host}:${this.options.port}`;

    // Detect or use forced protocol
    if (this.options.serverProtocol && this.options.serverProtocol !== "unknown") {
      this.detectedProtocol = this.options.serverProtocol;
      this.logger.info(
        { addr, protocol: this.detectedProtocol },
        "Using forced server protocol",
      );
    } else {
      this.logger.info({ addr }, "Detecting server protocol (TS3/TS6)...");
      const detection = await detectServerProtocol(
        this.options.host,
        this.options.port,
        3000,
        { ts3QueryPort: 10011, ts6HttpPort: 10080 },
      );
      if (generation !== this.connectionGeneration) return;
      this.detectedProtocol = detection.protocol;
      if (this.detectedProtocol === "unknown") {
        this.logger.warn(
          { addr },
          "Could not detect server protocol (query ports 10011/10080 unreachable). " +
            "Will attempt voice connection anyway. Use serverProtocol option to force TS3 or TS6.",
        );
      } else {
        this.logger.info(
          { addr, protocol: this.detectedProtocol, queryPort: detection.queryPort },
          `Server protocol detected: ${this.detectedProtocol.toUpperCase()}`,
        );
      }
    }

    // Set up TS6 HTTP Query if applicable
    if (this.detectedProtocol === "ts6") {
      const queryPort = this.options.queryPort !== 10011 ? this.options.queryPort : 10080;
      this.httpQuery = new TS6HttpQuery({
        host: this.options.host,
        port: queryPort,
        apiKey: this.options.ts6ApiKey,
      });
    }

    this.logger.info(
      { addr, protocol: this.detectedProtocol },
      "Connecting to TeamSpeak server (full client protocol)",
    );

    // Throttle repeated "udp send error" warnings (fires every 20ms during playback if UDP breaks)
    let sdkClient: TS3FullClient | null = null;
    const isCurrent = () => sdkClient !== null && this.client === sdkClient &&
      this.connectionGeneration === generation && !this.disconnecting;
    let udpErrorCount = 0;
    let udpErrorCode: string | undefined;
    const throttledWarn = (msg: string, ...args: unknown[]) => {
      if (!isCurrent()) return;
      if (typeof msg === "string" && msg.includes("udp send error")) {
        udpErrorCount++;
        udpErrorCode = args.map(safeSocketErrorCode).find(code => code !== undefined) ?? udpErrorCode;
        if (udpErrorCount === 1) {
          this.logger.warn({ ...(udpErrorCode ? { code: udpErrorCode } : {}), count: 1 }, "udp send error");
          // After 2 seconds, log a summary and reset.
          // Clear any previous timer to avoid leaking it.
          if (this.udpErrorTimer) clearTimeout(this.udpErrorTimer);
          this.udpErrorTimer = setTimeout(() => {
            if (!isCurrent()) return;
            if (udpErrorCount > 1) {
              this.logger.warn({ ...(udpErrorCode ? { code: udpErrorCode } : {}), count: udpErrorCount }, "Repeated udp send error; connection may be lost");
            }
            udpErrorCount = 0;
            udpErrorCode = undefined;
            this.udpErrorTimer = null;
          }, 2000);
          this.udpErrorTimer.unref?.();
        }
        return;
      }
      this.logger.warn(msg);
    };

    const sdkOptions: SDKClientOptions = {
      // Forward server password to the protocol library so it can be
      // included in clientinit for password-protected servers
      serverPassword: this.options.serverPassword,
      resolver: voiceEndpointResolver,
      logger: {
        debug: (msg: string) => { if (isCurrent()) this.logger.debug(msg); },
        info: (msg: string) => { if (isCurrent()) this.logger.info(msg); },
        warn: throttledWarn,
        error: (msg: string) => { if (isCurrent()) this.logger.error(msg); },
      },
    };
    sdkClient = this.options.sdkClientFactory
      ? this.options.sdkClientFactory(this.identity, addr, this.options.nickname, sdkOptions)
      : new TS3FullClient(this.identity, addr, this.options.nickname, sdkOptions);
    this.client = sdkClient;

    sdkClient.on("textMessage", (msg: TextMessageEvent) => {
      if (!isCurrent()) return;
      if (msg.invokerID === this.clientId) return;
      this.emit("textMessage", toTS3TextMessage(msg));
    });

    sdkClient.on("pluginCommand", (ev: PluginCommandEvent) => {
      if (!isCurrent()) return;
      this.emit("pluginCommand", toTS3PluginCommand(ev));
    });

    sdkClient.on("voiceData", (voice: VoiceDataEvent) => {
      if (!isCurrent()) return;
      // The library normally suppresses our own packets; retain the explicit
      // guard so a future protocol change cannot make a bot duck itself.
      const voiceClientId = Number(voice.clientID);
      if (voiceClientId === this.clientId) return;
      const clientUid = this.visibleClientUids.get(voiceClientId);
      const activity: TS3VoiceActivity = {
        clientId: voiceClientId,
        codec: voice.codec,
        ...(clientUid ? { clientUid } : {}),
      };
      this.emit("voiceActivity", activity);
    });

    sdkClient.on("disconnected", (ev: DisconnectedEvent) => {
      if (!isCurrent()) return;
      const code = safeSocketErrorCode(ev.error);
      this.logger.warn(code ? { code } : {}, "Connection closed");
      ++this.connectionGeneration;
      this.resetVoiceSendState();
      this.client = null;
      this.clientId = 0;
      this.clearVisibleClientUids();
      this.emit("disconnected");
    });

    sdkClient.on("clientEnter", (info: ClientEnterEvent) => {
      if (!isCurrent()) return;
      this.rememberVisibleClientUid(Number(info.id), info.uid ?? "");
      this.logger.debug(
        { nickname: info.nickname, id: Number(info.id) },
        "Client entered"
      );
      this.emit("clientEnter", info);
    });

    sdkClient.on("clientLeave", (ev: ClientLeaveEvent) => {
      if (!isCurrent()) return;
      const id = Number(ev.clientID);
      this.releaseVisibleClientUid(id);
      this.logger.debug({ id }, "Client left");
      this.emit("clientLeave", { ...ev, id });
    });

    sdkClient.on("clientMoved", (ev: ClientMovedEvent) => {
      if (!isCurrent()) return;
      const id = Number(ev.clientID);
      this.logger.debug(
        { id, targetChannelID: ev.targetChannelID.toString() },
        "Client moved"
      );
      this.emit("clientMoved", { ...ev, id });
    });

    await sdkClient.connect();
    if (!isCurrent()) {
      // Handshake may finish after disconnect() or a newer connect() superseded it.
      await sdkClient.disconnect().catch(() => {});
      return;
    }
    this.clientId = Number(sdkClient.clientID);
    if (sdkClient.uid) {
      this.clientUid = sdkClient.uid;
    }
    this.voiceFramesSent = 0;
    this.logger.info(
      { clientId: this.clientId, protocol: this.detectedProtocol },
      `Logged in (visible client, ${this.detectedProtocol.toUpperCase()} server)`,
    );

    // Join channel by numeric ID (takes precedence) or by name
    if (this.options.channelId) {
      await this.joinChannel(this.options.channelId, this.options.channelPassword);
    } else if (this.options.defaultChannel) {
      await this.joinChannel(
        this.options.defaultChannel,
        this.options.channelPassword
      );
    }

    if (isCurrent()) this.emit("connected");
  }

  async joinChannel(channelName: string, password?: string): Promise<void> {
    const client = this.client;
    if (!client || this.disconnecting) return;
    const clientId = this.clientId;
    const generation = this.connectionGeneration;
    const isCurrent = () => this.client === client && this.clientId === clientId &&
      this.connectionGeneration === generation && !this.disconnecting;

    const isNumeric = /^\d+$/.test(channelName);
    if (isNumeric) {
      try {
        await moveClient(
          client,
          asClientID(clientId),
          asChannelID(BigInt(channelName)),
          password ? { password } : undefined,
        );
        if (!isCurrent()) return;
        this.logger.info({ channelName }, "Joined channel");
      } catch (err) {
        if (isCurrent()) this.logger.error({ err, channelName }, "Failed to join channel");
      }
      return;
    }

    try {
      const channels = await listChannels(client);
      if (!isCurrent()) return;
      const channel = channels.find((ch) => ch.name === channelName);

      if (!channel) {
        this.logger.warn({ channelName }, "Channel not found");
        return;
      }

      await moveClient(
        client,
        asClientID(clientId),
        channel.id,
        password ? { password } : undefined,
      );
      if (!isCurrent()) return;
      this.logger.info(
        { channelName, cid: channel.id.toString() },
        "Joined channel"
      );
    } catch (err) {
      if (isCurrent()) this.logger.error({ err, channelName }, "Failed to join channel");
    }
  }

  async sendTextMessage(
    message: string,
    targetMode: number = 2,
    targetClientId?: number,
  ): Promise<void> {
    if (!this.client) return;
    if (targetMode === 1) {
      if (targetClientId === undefined) return;
      await sendPrivateMessage(this.client, asClientID(targetClientId), message);
      return;
    }
    if (targetMode === 3) {
      await sendServerMessage(this.client, message);
      return;
    }
    await sendChannelMessage(this.client, message);
  }

  async sendPluginCommand(
    name: string,
    data: string,
    target: PluginCommandTarget | number = "channel",
  ): Promise<void> {
    if (!this.client) throw new Error("Not connected");
    const resolvedTarget: PluginCommandTarget =
      typeof target === "number" ? { clientID: asClientID(target) } : target;
    await sdkSendPluginCommand(this.client, name, data, resolvedTarget);
  }

  async getClientsInChannel(): Promise<ClientEntry[]> {
    if (!this.client) return [];
    try {
      const allClients = await listClients(this.client);
      const myChannelId = this.client.channelID;
      return allClients.filter((c) => c.channelID === myChannelId);
    } catch {
      return [];
    }
  }

  /**
   * Resolve a client's CURRENT server groups by client id, server-wide (works
   * regardless of channel/view) via a targeted `clientinfo` query. The raw
   * `client_servergroups` field is a comma-separated list (same field
   * `listClients` parses). Returns [] if the client can't be resolved or the
   * query fails, so callers fail closed.
   */
  async getClientServerGroups(clid: number): Promise<string[]> {
    if (!this.client) return [];
    try {
      const info = await getClientProperties(this.client, asClientID(clid));
      const raw = info.client_servergroups ?? "";
      return raw ? raw.split(",") : [];
    } catch {
      return [];
    }
  }

  // --- Raw command & file transfer pass-through ---

  async execCommand(cmd: string): Promise<void> {
    if (!this.client) throw new Error("Not connected");
    await this.client.exec(cmd);
  }

  /** Fire a command without waiting for the server's response. */
  async sendCommandNoWait(cmd: string): Promise<void> {
    if (!this.client) throw new Error("Not connected");
    await this.client.execNoWait(cmd);
  }

  async execCommandWithResponse(cmd: string): Promise<Record<string, string>[]> {
    if (!this.client) throw new Error("Not connected");
    return this.client.exec(cmd);
  }

  async fileTransferInitUpload(
    channelID: bigint | ChannelID,
    path: string,
    password: string,
    size: bigint,
    overwrite = true,
  ): Promise<FileUploadInfo> {
    if (!this.client) throw new Error("Not connected");
    return initFileUpload(this.client, asChannelID(channelID), path, size, {
      password,
      overwrite,
    });
  }

  async uploadFileData(host: string, info: FileUploadInfo, data: Readable): Promise<void> {
    if (!this.client) throw new Error("Not connected");
    await this.client.uploadFileData(host, info, data);
  }

  async fileTransferDeleteFile(channelID: bigint | ChannelID, paths: string[]): Promise<void> {
    if (!this.client) throw new Error("Not connected");
    await deleteFile(this.client, asChannelID(channelID), paths);
  }

  /** The server host (needed for file transfer TCP connections). */
  getHost(): string {
    return this.options.host;
  }

  /** The current channel ID of this client. */
  getChannelId(): bigint {
    if (!this.client) return 0n;
    return this.client.channelID;
  }

  private voiceFramesSent = 0;

  sendVoiceData(opusFrame: Buffer): TS3VoiceSendResult {
    const client = this.client;
    if (!client || this.disconnecting) return "unavailable";
    try {
      client.sendVoice(opusFrame, Codec.OpusMusic);
    } catch (err) {
      if (this.voiceFailure) {
        this.voiceFailure.consecutiveFailures++;
        this.voiceFailure.code = safeSocketErrorCode(err) ?? this.voiceFailure.code;
        return this.voiceFailureTimer ? "retrying" : "failed";
      }
      const code = safeSocketErrorCode(err);
      const failure = this.voiceFailure = {
        ...(code ? { code } : {}), consecutiveFailures: 1, startedAt: Date.now(),
      };
      const generation = this.connectionGeneration;
      this.voiceFailureTimer = setTimeout(() => {
        if (this.client !== client || this.connectionGeneration !== generation ||
          this.disconnecting || this.voiceFailure !== failure) return;
        this.voiceFailureTimer = null;
        const event = this.voiceFailureDetails(failure);
        this.logger.error(event, "Voice sends have failed continuously; pausing playback is required");
        this.emit("voiceSendFailed", event);
      }, VOICE_SEND_FAILURE_TIMEOUT_MS);
      this.voiceFailureTimer.unref?.();
      const event = this.voiceFailureDetails(failure);
      this.logger.warn(event, "Voice send failed");
      this.emit("voiceSendFailure", event);
      return "retrying";
    }
    this.voiceFramesSent++;
    if (this.voiceFramesSent === 1) {
      this.logger.info({ opusBytes: opusFrame.length, clientId: this.clientId }, "First voice packet accepted by TeamSpeak client");
    }
    if (this.voiceFailure) {
      const event = this.voiceFailureDetails(this.voiceFailure);
      this.clearVoiceFailure();
      this.logger.info(event, "Voice send recovered");
      this.emit("voiceSendRecovered", event);
    }
    return "accepted";
  }

  private voiceFailureDetails(failure: NonNullable<TS3Client["voiceFailure"]>): TS3VoiceSendFailure {
    return {
      ...(failure.code ? { code: failure.code } : {}),
      consecutiveFailures: failure.consecutiveFailures,
      durationMs: Math.max(0, Date.now() - failure.startedAt),
    };
  }

  private clearVoiceFailure(): void {
    if (this.voiceFailureTimer) clearTimeout(this.voiceFailureTimer);
    this.voiceFailureTimer = null;
    this.voiceFailure = null;
  }

  private resetVoiceSendState(): void {
    this.clearVoiceFailure();
    this.voiceFramesSent = 0;
    if (this.udpErrorTimer) clearTimeout(this.udpErrorTimer);
    this.udpErrorTimer = null;
  }

  getIdentityExport(): string {
    return this.identity.export();
  }

  getClientId(): number {
    return this.clientId;
  }

  /** Actual endpoint selected by the SDK's SRV/TSDNS discovery and DNS lookup. */
  getResolvedVoiceEndpoint(): ResolvedVoiceEndpoint | null {
    return this.voiceEndpointResolver.getEndpoint();
  }

  /** Stable identity of this managed TeamSpeak client. */
  getClientUid(): string {
    return this.clientUid;
  }

  private rememberVisibleClientUid(clientId: number, clientUid: string): void {
    const pendingRelease = this.visibleClientUidReleaseTimers.get(clientId);
    if (pendingRelease) clearTimeout(pendingRelease);
    this.visibleClientUidReleaseTimers.delete(clientId);

    if (clientId > 0 && clientUid) {
      this.visibleClientUids.set(clientId, clientUid);
    } else {
      this.visibleClientUids.delete(clientId);
    }
  }

  private releaseVisibleClientUid(clientId: number): void {
    const clientUid = this.visibleClientUids.get(clientId);
    if (!clientUid) return;

    const previous = this.visibleClientUidReleaseTimers.get(clientId);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      if (this.visibleClientUids.get(clientId) === clientUid) {
        this.visibleClientUids.delete(clientId);
      }
      this.visibleClientUidReleaseTimers.delete(clientId);
    }, VISIBLE_CLIENT_UID_RELEASE_GRACE_MS);
    timer.unref?.();
    this.visibleClientUidReleaseTimers.set(clientId, timer);
  }

  private clearVisibleClientUids(): void {
    for (const timer of this.visibleClientUidReleaseTimers.values()) {
      clearTimeout(timer);
    }
    this.visibleClientUidReleaseTimers.clear();
    this.visibleClientUids.clear();
  }

  disconnect(): void {
    const generation = ++this.connectionGeneration;
    this.resetVoiceSendState();
    const client = this.client;
    this.client = null;
    if (client && !this.disconnecting) {
      this.disconnecting = true;
      client.disconnect().catch(() => {}).finally(() => {
        if (generation === this.connectionGeneration) this.disconnecting = false;
      });
    }
    this.clientId = 0;
    this.clearVisibleClientUids();
    this.httpQuery = null;
    this.detectedProtocol = "unknown";
    this.logger.info("Disconnected from TeamSpeak server");
  }
}
