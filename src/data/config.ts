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
 * The default platform for !play/!add/!playlist/!album and all REST/WebUI calls:
 * the first enabled provider in a fixed priority order (netease with the default
 * config; jellyfin ranks after the online music platforms because it is an
 * opt-in source, but ahead of the video sites for users who run it as their
 * only music library). Falls back to "netease" when nothing is enabled so
 * callers always get a provider — the enabled-gate then produces the friendly
 * error.
 */
export function defaultPlatform(config: BotConfig): GateableProvider {
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
  idleTimeoutMinutes: number;
  /** Enable uploading and playback of server-stored local audio files. */
  localAudioEnabled: boolean;
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
  /**
   * Which gateable providers are active (see GATEABLE_PROVIDERS). Default is
   * the online sources (NetEase/QQ/Bilibili/YouTube/Kugou); jellyfin is an
   * opt-in extra that must be listed here (Settings → Jellyfin 音乐库 toggles
   * it). Sources not listed stay disabled — the NetEase/QQ embedded sidecar
   * API servers must not start (or bind ports 3001/3200) unless enabled.
   */
  enabledProviders: GateableProvider[];
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
    idleTimeoutMinutes: 0,
    localAudioEnabled: true,
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
    enabledProviders: ["netease", "qq", "bilibili", "youtube", "kugou"],
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

    return {
      ...defaults,
      ...partial,
      adminGroups,
      guestMode: gm,
      spotify,
      jellyfin,
      enabledProviders,
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
