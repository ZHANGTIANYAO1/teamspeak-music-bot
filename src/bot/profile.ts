import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import axios from "axios";
import { TS3Client, escapeTS3 } from "../ts-protocol/client.js";
import { HttpQueryError } from "../ts-protocol/http-query.js";
import type { ProfileConfig } from "../data/database.js";
import type { QueuedSong } from "../audio/queue.js";
import type { Logger } from "../logger.js";

const TS3_NICKNAME_MAX = 30;
/** TS3 avatar max size — server default is ~300 KB. Use 200 KB to be safe. */
const AVATAR_MAX_BYTES = 200 * 1024;
/** Timeout for file-transfer operations (upload / delete). */
const FILE_TRANSFER_TIMEOUT_MS = 6000;

/**
 * Manages the bot's TeamSpeak presence (avatar, description, nickname,
 * away status, channel description, now-playing messages).
 *
 * Every update is permission-safe: if a feature fails due to insufficient
 * server permissions, it silently disables itself until the next reconnect.
 */
export class BotProfileManager {
  private tsClient: TS3Client;
  private logger: Logger;
  private config: ProfileConfig;
  private defaultNickname: string;
  private customAvatar: Buffer | null = null;
  /**
   * Tracks the last song handed to onSongChange. null means stopped/idle.
   * Used by setCustomAvatar to decide whether the new buffer should be
   * pushed immediately (idle) or wait for the next stop event (playing).
   */
  private currentSong: QueuedSong | null = null;

  /** Per-feature permission-denied flags. Reset on reconnect. */
  private permDenied = {
    avatar: false,
    description: false,
    nickname: false,
    awayStatus: false,
    channelDesc: false,
    nowPlayingMsg: false,
  };

  /**
   * Monotonically increasing generation counter. Incremented on every
   * onSongChange / onConnect call. Long-running operations (avatar
   * download/upload) check this before committing their result — if
   * the generation changed, a newer update has superseded them.
   */
  private generation = 0;

  constructor(
    tsClient: TS3Client,
    logger: Logger,
    config: ProfileConfig,
    defaultNickname: string,
  ) {
    this.tsClient = tsClient;
    this.logger = logger.child({ component: "profile" });
    this.config = { ...config };
    this.defaultNickname = defaultNickname;
  }

  // --- Public API ---

  /**
   * Store a persisted custom avatar WITHOUT touching TeamSpeak (#148).
   *
   * Used during BotInstance construction, when the TS connection does not
   * exist yet: setCustomAvatar would immediately fire the three-step file
   * transfer (fileTransferInitUpload → uploadFileData → clientupdate) against
   * a client that has not connected, so the upload always failed and the
   * saved avatar never appeared. onConnect() re-applies this.customAvatar
   * once the handshake completes, so loading it silently here loses nothing.
   */
  loadCustomAvatar(buffer: Buffer | null): void {
    this.customAvatar = buffer;
  }

  /**
   * Set/clear the persistent idle avatar. Pass null to remove.
   *
   * If the bot is currently in an idle state (no song playing OR
   * avatarEnabled is off), the new buffer is pushed to TS3 right away;
   * otherwise the cover-art sync is in charge until the next stop event,
   * at which point clearAvatar restores from this.customAvatar.
   */
  setCustomAvatar(buffer: Buffer | null): void {
    this.customAvatar = buffer;
    const idle = this.currentSong === null || !this.config.avatarEnabled;
    if (!idle) return;
    const gen = ++this.generation;
    if (buffer && buffer.length > 0) {
      void this.applyIdleAvatar(gen);
    } else {
      void this.clearAvatar(gen);
    }
  }

  /**
   * Called when a new song starts playing (song != null) or playback
   * stops (song == null).
   *
   * Commands are serialized to avoid overwhelming the TS3 command queue.
   * Nickname + away status are merged into a single `clientupdate` call.
   *
   * A generation counter guards against stale updates: if a newer
   * onSongChange fires while the avatar is still downloading, the old
   * update is discarded.
   */
  async onSongChange(song: QueuedSong | null): Promise<void> {
    const gen = ++this.generation;
    this.currentSong = song;

    // 1. Avatar first — file transfer uses its own response tracker and
    //    must run before sendCommandNoWait calls whose orphaned responses
    //    could confuse the command matcher.
    await this.updateAvatar(song?.coverUrl ?? null, gen);
    if (this.generation !== gen) return; // superseded

    // 2. Combined clientupdate (nickname + away in one fire-and-forget)
    await this.updateClientProperties(song);
    // 3. Description (clientedit on TS3, httpQuery on TS6)
    await this.updateDescription(song);
    // 4. Channel description (fire-and-forget channeledit)
    await this.updateChannelDescription(song);
    // 5. Now-playing chat message
    if (song) await this.sendNowPlayingMessage(song);
  }

  /** Reset permission-denied flags and bump generation on new connection. */
  onConnect(): void {
    this.generation++;
    this.currentSong = null;
    this.permDenied = {
      avatar: false,
      description: false,
      nickname: false,
      awayStatus: false,
      channelDesc: false,
      nowPlayingMsg: false,
    };
    // No song is playing on a fresh connect, so the matrix says the
    // custom avatar should be visible regardless of avatarEnabled.
    if (this.customAvatar) {
      const gen = this.generation;
      void this.applyIdleAvatar(gen);
    }
  }

  getConfig(): ProfileConfig {
    return { ...this.config };
  }

  updateConfig(partial: Partial<ProfileConfig>): void {
    Object.assign(this.config, partial);
  }

  // --- Internal update methods ---

  private async updateAvatar(coverUrl: string | null, gen: number): Promise<void> {
    if (!this.config.avatarEnabled || this.permDenied.avatar) return;
    try {
      if (!coverUrl) {
        await this.clearAvatar(gen);
        return;
      }
      // Request a thumbnail from the CDN to stay within TS3's avatar size limit.
      const thumbUrl = this.thumbnailUrl(coverUrl);
      const imageBuffer = await this.downloadImage(thumbUrl);

      // Check generation after the slow download — bail if superseded.
      if (this.generation !== gen) return;

      if (!imageBuffer || imageBuffer.length === 0) return;
      if (imageBuffer.length > AVATAR_MAX_BYTES) {
        this.logger.warn(
          { bytes: imageBuffer.length, max: AVATAR_MAX_BYTES },
          "Cover image still too large after resize — skipping avatar update",
        );
        return;
      }

      // Wrap the file-transfer sequence with a timeout — the TS3
      // full-client file transfer can silently hang.
      const start = Date.now();
      await this.withTimeout(this.doAvatarUpload(imageBuffer), FILE_TRANSFER_TIMEOUT_MS);
      this.logger.info(
        { bytes: imageBuffer.length, elapsedMs: Date.now() - start },
        "Avatar updated",
      );
    } catch (err) {
      this.handleFeatureError("avatar", err);
    }
  }

  /**
   * Three-step upload. Each step is logged so the log can tell us whether
   * a broken/loading avatar on the client is from:
   *   (a) init failing (no permission)
   *   (b) file transfer hanging on TCP 30033
   *   (c) client_flag_avatar not applying
   * If (b) happens, the avatar MD5 would still be set in the past — leaving
   * clients showing a placeholder. The flag is now only set after the TCP
   * transfer resolves.
   */
  private async doAvatarUpload(imageBuffer: Buffer): Promise<void> {
    const host = this.tsClient.getHost();
    this.logger.debug({ bytes: imageBuffer.length, host }, "Avatar: init file transfer");
    const info = await this.tsClient.fileTransferInitUpload(
      0n, "/avatar", "", BigInt(imageBuffer.length), true,
    );
    this.logger.debug({ bytes: imageBuffer.length }, "Avatar: uploading file data");
    await this.tsClient.uploadFileData(host, info, Readable.from(imageBuffer));
    const md5 = createHash("md5").update(imageBuffer).digest("hex");
    this.logger.debug({ md5 }, "Avatar: setting client_flag_avatar");
    await this.tsClient.sendCommandNoWait(`clientupdate client_flag_avatar=${escapeTS3(md5)}`);
  }

  private async clearAvatar(gen: number): Promise<void> {
    if (this.customAvatar && this.customAvatar.length > 0) {
      await this.applyIdleAvatar(gen);
      return;
    }
    try {
      await this.withTimeout(
        this.tsClient.fileTransferDeleteFile(0n, ["/avatar"]),
        FILE_TRANSFER_TIMEOUT_MS,
      );
    } catch {
      // File may not exist or transfer timed out — that's fine
    }
    if (this.generation !== gen) return;
    try {
      await this.tsClient.sendCommandNoWait("clientupdate client_flag_avatar=");
    } catch (err) {
      this.handleFeatureError("avatar", err);
    }
  }

  private async applyIdleAvatar(gen: number): Promise<void> {
    if (!this.customAvatar || this.customAvatar.length === 0) return;
    if (this.permDenied.avatar) return;
    try {
      await this.withTimeout(this.doAvatarUpload(this.customAvatar), FILE_TRANSFER_TIMEOUT_MS);
      if (this.generation !== gen) return;
      this.logger.info({ bytes: this.customAvatar.length }, "Idle (custom) avatar applied");
    } catch (err) {
      this.handleFeatureError("avatar", err);
    }
  }

  private async updateDescription(song: QueuedSong | null): Promise<void> {
    if (!this.config.descriptionEnabled || this.permDenied.description) return;
    try {
      const text = song
        ? `${song.name} - ${song.artist} [${song.album}]`
        : "";
      const httpQuery = this.tsClient.getHttpQuery();
      if (httpQuery) {
        // TS6 HTTP API: send the raw (unescaped) text. clientUpdate
        // throws HttpQueryError on non-2xx so a silent 400/403 cannot
        // be misreported as success.
        const result = await httpQuery.clientUpdate({ client_description: text });
        this.logger.info({ status: result.status }, "Description updated");
      } else {
        // clientupdate rejects client_description (error 1538).
        // Use clientedit on our own clid instead — this is what
        // TS3AudioBot does via TSLib's ChangeDescription().
        const clid = this.tsClient.getClientId();
        if (clid <= 0) return;
        // Use a 5s timeout — if clientedit hangs, don't block the
        // remaining profile updates (channeledit, now-playing msg).
        await this.withTimeout(
          this.tsClient.execCommand(
            `clientedit clid=${clid} client_description=${escapeTS3(text)}`,
          ),
          5000,
        );
        this.logger.info("Description updated");
      }
    } catch (err) {
      this.handleFeatureError("description", err);
    }
  }

  /**
   * Build and send a single `clientupdate` command that sets nickname
   * and away status together, avoiding multiple round-trips that can
   * cause command-queue timeouts on the TS3 protocol.
   *
   * Values are collected as raw strings/numbers. The TS6 HTTP path
   * forwards them as JSON (the server expects real spaces, not `\s`);
   * the TS3 wire path escapes them on the fly. Previously the code
   * escaped upfront and then split the escaped string to build the
   * JSON body, so TS6 received literal backslashes and silently
   * rejected the update.
   */
  private async updateClientProperties(song: QueuedSong | null): Promise<void> {
    const rawProps: Record<string, string | number> = {};

    // --- Nickname ---
    if (this.config.nicknameEnabled && !this.permDenied.nickname) {
      if (!song) {
        rawProps.client_nickname = this.defaultNickname;
      } else {
        const nickname = this.buildNickname(song);
        if (nickname) {
          rawProps.client_nickname = nickname;
        }
      }
    }

    // --- Away status ---
    if (this.config.awayStatusEnabled && !this.permDenied.awayStatus) {
      if (song) {
        rawProps.client_away = 0;
      } else {
        rawProps.client_away = 1;
        rawProps.client_away_message = "\u7B49\u5F85\u64AD\u653E";
      }
    }

    if (Object.keys(rawProps).length === 0) return;

    try {
      const httpQuery = this.tsClient.getHttpQuery();
      if (httpQuery) {
        // TS6: send raw values as JSON. Throws HttpQueryError on 4xx/5xx.
        const result = await httpQuery.clientUpdate(rawProps);
        this.logger.info(
          { status: result.status, props: Object.keys(rawProps) },
          "Client properties updated (nickname + away)",
        );
      } else {
        // TS3 wire protocol: escape string values inline.
        // sendCommandNoWait: the TS3 full-client protocol often
        // doesn't return a timely error response for clientupdate,
        // causing execCommand to time out after 10s.
        const parts = Object.entries(rawProps).map(([k, v]) =>
          typeof v === "string" ? `${k}=${escapeTS3(v)}` : `${k}=${v}`,
        );
        await this.tsClient.sendCommandNoWait(`clientupdate ${parts.join(" ")}`);
        this.logger.info(
          { props: Object.keys(rawProps) },
          "Client properties updated (nickname + away)",
        );
      }
    } catch (err) {
      // Flag both features on permission error
      this.handleFeatureError("nickname", err);
      this.handleFeatureError("awayStatus", err);
    }
  }

  /**
   * Build a nickname string that fits within TS3_NICKNAME_MAX.
   * Uses UTF-8 byte length for the limit since TS3 counts bytes,
   * not characters.
   */
  private buildNickname(song: QueuedSong): string | null {
    const songInfo = `${song.name} - ${song.artist}`;
    const prefix = "\u266A "; // ♪
    const sep = " - ";
    const suffix = `${sep}${this.defaultNickname}`;

    const overheadBytes = Buffer.byteLength(prefix, "utf8") + Buffer.byteLength(suffix, "utf8");
    if (overheadBytes >= TS3_NICKNAME_MAX) {
      // Default nickname alone is too long with decoration — skip
      return null;
    }

    const maxSongBytes = TS3_NICKNAME_MAX - overheadBytes;
    const truncated = this.truncateUtf8(songInfo, maxSongBytes);
    return `${prefix}${truncated}${suffix}`;
  }

  /**
   * Truncate a string so its UTF-8 byte length does not exceed maxBytes.
   * Appends an ellipsis if truncation occurred, taking its byte cost
   * into account. Never splits a multi-byte character.
   */
  private truncateUtf8(str: string, maxBytes: number): string {
    if (Buffer.byteLength(str, "utf8") <= maxBytes) return str;
    const ellipsis = "\u2026"; // …
    const ellipsisBytes = Buffer.byteLength(ellipsis, "utf8"); // 3
    const target = maxBytes - ellipsisBytes;
    if (target <= 0) return ellipsis;
    // Walk characters, accumulating byte length
    let byteLen = 0;
    let end = 0;
    for (const ch of str) {
      const chBytes = Buffer.byteLength(ch, "utf8");
      if (byteLen + chBytes > target) break;
      byteLen += chBytes;
      end += ch.length; // ch.length handles surrogate pairs
    }
    return str.slice(0, end) + ellipsis;
  }

  private async updateChannelDescription(song: QueuedSong | null): Promise<void> {
    if (!this.config.channelDescEnabled || this.permDenied.channelDesc) return;
    try {
      const channelId = this.tsClient.getChannelId();
      if (channelId === 0n) return; // unknown channel

      if (!song) {
        await this.tsClient.sendCommandNoWait(
          `channeledit cid=${channelId} channel_description=`,
        );
        return;
      }

      const lines = [
        `\u266A \u6B63\u5728\u64AD\u653E: ${song.name} - ${song.artist}`, // ♪ 正在播放:
        `\u4E13\u8F91: ${song.album}`, // 专辑:
        `\u5E73\u53F0: ${song.platform}`, // 平台:
      ];
      const desc = lines.join("\\n");
      await this.tsClient.sendCommandNoWait(
        `channeledit cid=${channelId} channel_description=${escapeTS3(desc)}`,
      );
    } catch (err) {
      this.handleFeatureError("channelDesc", err);
    }
  }

  private async sendNowPlayingMessage(song: QueuedSong): Promise<void> {
    if (!this.config.nowPlayingMsgEnabled || this.permDenied.nowPlayingMsg) return;
    try {
      const text = `\u266A \u6B63\u5728\u64AD\u653E: ${song.name} - ${song.artist} [${song.album}]`;
      await this.tsClient.sendTextMessage(text);
    } catch (err) {
      this.handleFeatureError("nowPlayingMsg", err);
    }
  }

  // --- Helpers ---

  /**
   * Append CDN resize parameters to get a thumbnail suitable for TS3 avatars.
   * NetEase and QQ Music CDNs support URL-based image resizing.
   * BiliBili and YouTube covers fall through to the size-check guard.
   */
  private thumbnailUrl(url: string): string {
    if (url.includes("music.126.net") || url.includes("netease")) {
      return url.includes("?") ? url : `${url}?param=200y200`;
    }
    if (url.includes("qqmusic") || url.includes("qq.com")) {
      return url.replace(/\/\d+$/, "/200");
    }
    if (url.includes("bilivideo") || url.includes("hdslb")) {
      // BiliBili CDN supports @<w>w_<h>h suffix
      return url.includes("@") ? url : `${url}@200w_200h`;
    }
    return url;
  }

  private async downloadImage(url: string): Promise<Buffer | null> {
    try {
      const resp = await axios.get(url, {
        responseType: "arraybuffer",
        timeout: 8000,
        maxContentLength: 2 * 1024 * 1024, // 2 MB cap
      });
      return Buffer.from(resp.data);
    } catch (err) {
      this.logger.warn({ err, url }, "Failed to download cover image");
      return null;
    }
  }

  /** Race a promise against a timeout. */
  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms),
      ),
    ]);
  }

  private handleFeatureError(
    feature: keyof typeof this.permDenied,
    err: unknown,
  ): void {
    const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
    const status = err instanceof HttpQueryError ? err.status : undefined;
    const body = err instanceof HttpQueryError ? err.body : undefined;
    // Disable the feature for this session on unrecoverable errors:
    // - permission / insufficient → server denies the action
    // - invalid parameter → command not supported by this protocol
    // - HTTP 401/403 → TS6 server rejects the API key/role
    // - HTTP 400 → bad parameter; retrying on every song change is wasteful
    const isUnrecoverable =
      msg.includes("permission") ||
      msg.includes("insufficient") ||
      msg.includes("invalid parameter") ||
      status === 400 ||
      status === 401 ||
      status === 403;
    if (isUnrecoverable) {
      this.permDenied[feature] = true;
      this.logger.info(
        { feature, status, body, reason: msg },
        "Feature disabled for this session (will retry after reconnect)",
      );
    } else {
      this.logger.warn({ feature, status, body, err }, "Profile update failed");
    }
  }
}
