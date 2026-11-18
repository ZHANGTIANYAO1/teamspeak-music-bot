import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  copyFileSync,
  rmSync,
  renameSync,
} from "node:fs";
import { dirname } from "node:path";
import type { BotAccess, GuestPermissions } from "./permissions.js";
import { GUEST_PERMISSION_FLAGS } from "./permissions.js";

export interface GuestModeConfig {
  enabled: boolean;
  bots: BotAccess; // "all" | string[]
  permissions: GuestPermissions;
}

export interface SpotifyConfig {
  enabled: boolean;
  backend: "auto" | "go-librespot" | "librespot";
  clientId: string;
  clientSecret: string;
  deviceName: string;
  bitrate: number;
}

export interface JellyfinConfig {
  /** Base URL of the Jellyfin server, e.g. "https://jellyfin.example.com". */
  serverUrl: string;
  authMode: "userpass" | "apikey";
  // userpass mode
  username: string;
  password: string;
  // apikey mode: admin API key + the user whose library/favorites/playlists are used
  apiKey: string;
  userId: string;
}

/**
 * Per-provider audio quality (音质), persisted so a restart keeps the user's
 * choice instead of resetting each provider to its in-memory default (#125).
 * The values are the same strings the WebUI/REST `POST /api/music/quality`
 * endpoint sends and each provider's setQuality() accepts; on startup they are
 * replayed onto the (shared, process-wide) providers. Providers ignore/normalize
 * unknown values, so a stale/hand-edited entry can never break playback.
 */
export interface AudioQualityConfig {
  netease: string;
  qq: string;
  bilibili: string;
  kugou: string;
  jellyfin: string;
}

export interface VoiceDuckingConfig {
  enabled: boolean;
  /** Percentage of the normal playback volume retained while someone speaks. */
  volumePercent: number;
}

/**
 * Providers gated by `enabledProviders`. Not listed here:
 *  - "local"   → governed by the existing `localAudioEnabled` flag
 *  - "spotify" → governed by the existing `spotify.enabled` flag
 */
export const GATEABLE_PROVIDERS = [
  "jellyfin",
  "netease",
  "qq",
  "bilibili",
  "youtube",
  "kugou",
] as const;
export type GateableProvider = (typeof GATEABLE_PROVIDERS)[number];

/** Whether a platform may be used for search/playback under the current config. */
export function isProviderEnabled(config: BotConfig, platform: string): boolean {
  if (platform === "local") return config.localAudioEnabled !== false;
  if (platform === "spotify") return config.spotify.enabled;
  return config.enabledProviders.includes(platform as GateableProvider);
}

/**
 * The default platform for !play/!add/!playlist/!album and all REST/WebUI calls.
 *
 * An explicit user preference (`config.defaultPlatform`) wins whenever it points
 * at a source that is currently enabled — this lets e.g. a Bilibili-loving server
 * set B站 as the default so `!play <歌名>` needs no `-b` flag (issue #126). The
 * enabled-guard here matters at runtime too: if the operator later disables the
 * preferred source, we must fall through instead of returning a dead default.
 *
 * With no (usable) preference we fall back to the first enabled provider in a
 * fixed priority order (netease with the default config; jellyfin ranks after
 * the online music platforms because it is an opt-in source, but ahead of the
 * video sites for users who run it as their only music library). Falls back to
 * "netease" when nothing is enabled so callers always get a provider — the
 * enabled-gate then produces the friendly error.
 */
export function defaultPlatform(config: BotConfig): GateableProvider {
  const pref = config.defaultPlatform;
  if (pref && config.enabledProviders.includes(pref)) return pref;
  for (const p of ["netease", "qq", "kugou", "jellyfin", "bilibili", "youtube"] as const) {
    if (config.enabledProviders.includes(p)) return p;
  }
  return "netease";
}

export interface BotConfig {
  webPort: number;
  locale: "zh" | "en";
  theme: "dark" | "light";
  commandPrefix: string;
  commandAliases: Record<string, string>;
  neteaseApiPort: number;
  qqMusicApiPort: number;
  adminPassword: string;
  adminGroups: number[];
  autoReturnDelay: number;
  autoPauseOnEmpty: boolean;
  /** Lower music volume while voice from another client is being received. */
  voiceDucking: VoiceDuckingConfig;
  idleTimeoutMinutes: number;
  /** Enable uploading and playback of server-stored local audio files. */
  localAudioEnabled: boolean;
  /**
   * Enable named save/load of queues (chat + web) AND auto-restore of the live
   * queue across a restart. Admin-controlled; default false so nothing is
   * persisted/restored until an operator opts in.
   */
  savedQueuesEnabled: boolean;
  /**
   * When true, a single-song immediate !play (chat) / play-song (web) inserts
   * after the current track and jumps to it instead of clearing the queue, so
   * the rest of the queue survives and continues afterwards. Default false
   * keeps today's clear-and-play behavior.
   */
  playKeepsQueue: boolean;
  // Public base URL used when generating share links (e.g. the bot专属链接).
  // Leave empty to use the browser's current origin. Example:
  //   "https://music.example.com" or "http://1.2.3.4:3000"
  publicUrl: string;
  // When true, Express trusts X-Forwarded-* headers from a reverse proxy
  // (nginx/Caddy/Cloudflare). Required for correct protocol/host detection
  // behind HTTPS-terminating proxies.
  trustProxy: boolean;
  guestMode: GuestModeConfig;
  spotify: SpotifyConfig;
  jellyfin: JellyfinConfig;
  /** Persisted per-provider audio quality (音质), restored on startup (#125). */
  audioQuality: AudioQualityConfig;
  /**
   * Which gateable providers are active (see GATEABLE_PROVIDERS). Default is
   * the online sources (NetEase/QQ/Bilibili/YouTube/Kugou); jellyfin is an
   * opt-in extra that must be listed here (Settings → Jellyfin 音乐库 toggles
   * it). Sources not listed stay disabled — the NetEase/QQ embedded sidecar
   * API servers must not start (or bind ports 3001/3200) unless enabled.
   */
  enabledProviders: GateableProvider[];
  /**
   * Optional operator-chosen default source for commands/REST/WebUI calls that
   * omit a platform (issue #126). When set to an enabled gateable provider it
   * overrides the fixed priority order in defaultPlatform(); `null` (the default)
   * keeps that priority order. loadConfig cleans stale/unknown/disabled values
   * back to null.
   */
  defaultPlatform: GateableProvider | null;
}

export function getDefaultConfig(): BotConfig {
  return {
    webPort: 3000,
    locale: "zh",
    theme: "dark",
    commandPrefix: "!",
    commandAliases: { p: "play", s: "skip", n: "next" },
    neteaseApiPort: 3001,
    qqMusicApiPort: 3200,
    adminPassword: "",
    adminGroups: [],
    autoReturnDelay: 300,
    // Default OFF: occupancy detection relies on the full-client `clientlist`
    // command, which is unreliable on some servers (it can time out when other
    // clients are present). Users can opt in from the web UI.
    autoPauseOnEmpty: false,
    voiceDucking: {
      enabled: false,
      volumePercent: 30,
    },
    idleTimeoutMinutes: 0,
    localAudioEnabled: true,
    savedQueuesEnabled: false,
    playKeepsQueue: false,
    publicUrl: "",
    trustProxy: false,
    guestMode: {
      enabled: false,
      bots: "all",
      permissions: {
        addToQueue: true,
        playNext: false,
        playNow: false,
        skip: false,
        transport: false,
        removeClear: false,
        playMode: false,
        playCollection: false,
      },
    },
    spotify: {
      enabled: false,
      backend: "auto",
      clientId: "",
      clientSecret: "",
      deviceName: "TSMusicBot",
      bitrate: 320,
    },
    jellyfin: {
      serverUrl: "",
      authMode: "userpass",
      username: "",
      password: "",
      apiKey: "",
      userId: "",
    },
    // Mirrors each provider's own in-memory default quality; overwritten on
    // startup once the user has changed a quality (persisted via #125).
    audioQuality: {
      netease: "exhigh",
      qq: "exhigh",
      bilibili: "high",
      kugou: "128",
      jellyfin: "direct",
    },
    enabledProviders: ["netease", "qq", "bilibili", "youtube", "kugou"],
    defaultPlatform: null,
  };
}

/**
 * Move an unusable config aside to a timestamped `*.corrupt-*` backup so the data
 * stays recoverable (it is NEVER deleted), for both the corrupt-JSON case and the
 * parses-but-not-an-object case. Prefer an atomic same-dir rename; if that fails,
 * copy instead. If it can't be preserved at all, rethrow rather than let the caller
 * overwrite unrecoverable data.
 */
function backupCorruptConfig(path: string): void {
  const backup = `${path}.corrupt-${Date.now()}`;
  try {
    renameSync(path, backup);
  } catch {
    try {
      copyFileSync(path, backup);
    } catch (backupErr) {
      throw backupErr;
    }
  }
}

export function loadConfig(path: string): BotConfig {
  const defaults = getDefaultConfig();

  // Distinguish the three failure modes so a *real* on-disk config is NEVER
  // silently replaced with defaults (the caller saveConfig()s right after load,
  // which would otherwise erase spotify creds / adminPassword / adminGroups /
  // guestMode permanently):
  //   (a) file ABSENT (ENOENT) — normal first run → defaults.
  //   (b) any OTHER read error (EBUSY/EACCES/EPERM/EISDIR/…) on an existing file —
  //       rethrow (fail-fast at boot). A loud crash beats silent credential loss.
  //   (c) file readable but JSON.parse fails (corrupt) — back the file up first
  //       (never delete it), THEN return defaults so boot can proceed.
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return defaults; // (a) missing file — first run
    }
    throw err; // (b) transient/permission error on an existing file — do not clobber it
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // (c) Corrupt content: move the unreadable file aside to a timestamped backup
    // so the data stays recoverable, then fall back to defaults.
    backupCorruptConfig(path);
    return defaults;
  }

  // (d) Parses cleanly but is NOT a non-null object (e.g. `null`, `42`, `"str"`,
  // `[]`). The per-field sanitize below assumes an object and would throw a raw
  // TypeError (or silently spread junk), bypassing the corrupt-backup path. Treat
  // it EXACTLY like corrupt JSON: back it up (never delete), then return defaults.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    backupCorruptConfig(path);
    return defaults;
  }
  const partial = parsed as Partial<BotConfig>;

  {
    // Normalize/sanitize guestMode on load. The WRITE path (POST /api/bot/settings)
    // sanitizes too, but a hand-edited/legacy/corrupt config.json reaches the gate
    // directly — so coerce it here as well, mirroring that write-path logic.
    const partialGm = (partial.guestMode ?? {}) as Partial<GuestModeConfig>;
    const gm: GuestModeConfig = {
      ...defaults.guestMode,
      ...partialGm,
      // bots → "all" | string[]; anything else falls back to the default ("all").
      bots:
        partialGm.bots === "all"
          ? "all"
          : Array.isArray(partialGm.bots)
            ? partialGm.bots.filter((id): id is string => typeof id === "string")
            : defaults.guestMode.bots,
      // permissions → defaults, then spread ONLY a plain object, then strict-coerce
      // each known flag to a boolean (drops index keys + non-boolean values).
      permissions: { ...defaults.guestMode.permissions },
    };
    const partialPerms = partialGm.permissions;
    if (
      partialPerms !== null &&
      typeof partialPerms === "object" &&
      !Array.isArray(partialPerms)
    ) {
      Object.assign(gm.permissions, partialPerms);
    }
    for (const f of GUEST_PERMISSION_FLAGS) {
      gm.permissions[f] = gm.permissions[f] === true;
    }

    // Sanitize adminGroups on load too: the WebUI write path filters it, but a
    // hand-edited / legacy / corrupt config.json reaches the command gate
    // directly. Keep only non-negative integers; a non-array falls back to the
    // default []. Mirrors the guestMode sanitization above.
    const adminGroups = Array.isArray(partial.adminGroups)
      ? partial.adminGroups.filter(
          (g): g is number => typeof g === "number" && Number.isInteger(g) && g >= 0,
        )
      : defaults.adminGroups;

    const partialSp = (partial.spotify ?? {}) as Partial<SpotifyConfig>;
    const validBackends = ["auto", "go-librespot", "librespot"] as const;
    const validBitrates = [96, 160, 320];
    const spotify: SpotifyConfig = {
      enabled: partialSp.enabled === true,
      backend: (validBackends as readonly string[]).includes(partialSp.backend as string)
        ? (partialSp.backend as SpotifyConfig["backend"])
        : defaults.spotify.backend,
      clientId: typeof partialSp.clientId === "string" ? partialSp.clientId : defaults.spotify.clientId,
      clientSecret:
        typeof partialSp.clientSecret === "string" ? partialSp.clientSecret : defaults.spotify.clientSecret,
      deviceName:
        typeof partialSp.deviceName === "string" && partialSp.deviceName.trim()
          ? partialSp.deviceName
          : defaults.spotify.deviceName,
      bitrate: validBitrates.includes(partialSp.bitrate as number)
        ? (partialSp.bitrate as number)
        : defaults.spotify.bitrate,
    };

    // Sanitize the jellyfin block on load, mirroring the spotify handling: a
    // hand-edited/legacy config.json must never smuggle wrong shapes past the
    // gate. Unknown/invalid sub-fields fall back to defaults.
    const partialJf = (partial.jellyfin ?? {}) as Partial<JellyfinConfig>;
    const jellyfin: JellyfinConfig = {
      serverUrl:
        typeof partialJf.serverUrl === "string"
          ? partialJf.serverUrl.trim().replace(/\/+$/, "")
          : defaults.jellyfin.serverUrl,
      authMode:
        partialJf.authMode === "apikey" ? "apikey" : defaults.jellyfin.authMode,
      username:
        typeof partialJf.username === "string" ? partialJf.username : defaults.jellyfin.username,
      password:
        typeof partialJf.password === "string" ? partialJf.password : defaults.jellyfin.password,
      apiKey: typeof partialJf.apiKey === "string" ? partialJf.apiKey : defaults.jellyfin.apiKey,
      userId: typeof partialJf.userId === "string" ? partialJf.userId : defaults.jellyfin.userId,
    };

    // enabledProviders → known providers only; a non-array falls back to the
    // default (online sources, jellyfin off). An explicitly-empty array is
    // respected (operator chose to disable every gateable source).
    const enabledProviders = Array.isArray(partial.enabledProviders)
      ? partial.enabledProviders.filter((p): p is GateableProvider =>
          (GATEABLE_PROVIDERS as readonly string[]).includes(p as string),
        )
      : defaults.enabledProviders;

    // Strict-coerce the two feature flags exactly like spotify.enabled so a
    // hand-edited / legacy / corrupt config.json can never silently enable
    // them (`"yes"`, `1`, `null` → false; only a literal `true` enables).
    const savedQueuesEnabled = partial.savedQueuesEnabled === true;
    const playKeepsQueue = partial.playKeepsQueue === true;

    // Voice ducking is opt-in and the retained-volume percentage is consumed
    // directly by the audio path. Only a plain-object block with correctly
    // typed, finite and in-range fields may override the safe defaults.
    const rawVoiceDucking = partial.voiceDucking;
    const partialVoiceDucking =
      rawVoiceDucking !== null &&
      typeof rawVoiceDucking === "object" &&
      !Array.isArray(rawVoiceDucking)
        ? (rawVoiceDucking as Partial<VoiceDuckingConfig>)
        : {};
    const rawVolumePercent = partialVoiceDucking.volumePercent;
    const voiceDucking: VoiceDuckingConfig = {
      enabled:
        typeof partialVoiceDucking.enabled === "boolean"
          ? partialVoiceDucking.enabled
          : defaults.voiceDucking.enabled,
      volumePercent:
        typeof rawVolumePercent === "number" &&
        Number.isFinite(rawVolumePercent) &&
        rawVolumePercent >= 0 &&
        rawVolumePercent <= 100
          ? rawVolumePercent
          : defaults.voiceDucking.volumePercent,
    };

    // defaultPlatform → an explicit operator default (issue #126). Keep it only
    // when it names a KNOWN gateable provider that is ALSO currently enabled;
    // anything else (unknown value, disabled source, wrong type, missing) becomes
    // null so defaultPlatform() falls back to the fixed priority order.
    const rawDefault = partial.defaultPlatform;
    const defaultPlatformPref: GateableProvider | null =
      typeof rawDefault === "string" &&
      (GATEABLE_PROVIDERS as readonly string[]).includes(rawDefault) &&
      enabledProviders.includes(rawDefault as GateableProvider)
        ? (rawDefault as GateableProvider)
        : null;

    // audioQuality → per-provider strings; each field falls back to its default
    // when missing/blank/non-string (a hand-edited/legacy config must never smuggle
    // a non-string past the gate — the value is fed straight to provider.setQuality).
    const partialAq = (partial.audioQuality ?? {}) as Partial<AudioQualityConfig>;
    const coerceQuality = (v: unknown, fallback: string): string =>
      typeof v === "string" && v.trim() ? v : fallback;
    const audioQuality: AudioQualityConfig = {
      netease: coerceQuality(partialAq.netease, defaults.audioQuality.netease),
      qq: coerceQuality(partialAq.qq, defaults.audioQuality.qq),
      bilibili: coerceQuality(partialAq.bilibili, defaults.audioQuality.bilibili),
      kugou: coerceQuality(partialAq.kugou, defaults.audioQuality.kugou),
      jellyfin: coerceQuality(partialAq.jellyfin, defaults.audioQuality.jellyfin),
    };

    return {
      ...defaults,
      ...partial,
      adminGroups,
      guestMode: gm,
      spotify,
      jellyfin,
      audioQuality,
      enabledProviders,
      savedQueuesEnabled,
      playKeepsQueue,
      voiceDucking,
      defaultPlatform: defaultPlatformPref,
    };
  }
}

export function saveConfig(path: string, config: BotConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  const json = JSON.stringify(config, null, 2);

  // Atomic write: serialize to a sibling temp file in the SAME directory, then
  // rename it onto the final path. rename is an atomic replace on POSIX and modern
  // Windows, so a crash / power loss / ENOSPC mid-write can never leave config.json
  // truncated — a reader always sees either the previous file or the fully-written
  // new one, never a partial. The temp lives in the same dir so the rename stays on
  // one filesystem (a cross-device rename would fail); pid + timestamp keep
  // concurrent writers from colliding on the temp name.
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, json, "utf-8");
    renameSync(tmp, path);
  } catch (err) {
    // Never leave a partial temp file behind on failure.
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
}

/**
 * One-time migration for the config location fix (#86).
 *
 * Older versions wrote config.json to the app/repo ROOT, which is NOT inside the
 * persisted data directory (the Docker volume is mounted at data/). That meant the
 * file never landed in the volume on first run and a manually-placed data/config.json
 * was ignored. config.json now lives under the data dir alongside the DB/cookies/logs.
 *
 * If a legacy root-level config exists and the new data-dir config does not yet exist,
 * move it so existing local installs keep their customized settings. Best-effort:
 * any failure is swallowed and loadConfig falls back to defaults.
 *
 * @returns true if a legacy config was migrated, false otherwise.
 */
export function migrateLegacyConfig(legacyPath: string, newPath: string): boolean {
  try {
    if (legacyPath === newPath) return false;
    if (existsSync(newPath)) return false; // new location already populated — leave it
    if (!existsSync(legacyPath)) return false; // nothing to migrate
    mkdirSync(dirname(newPath), { recursive: true });
    copyFileSync(legacyPath, newPath); // copy first (works across filesystems)
    try {
      rmSync(legacyPath);
    } catch {
      /* leave the legacy file if it can't be removed; the new one wins */
    }
    return true;
  } catch {
    return false;
  }
}
