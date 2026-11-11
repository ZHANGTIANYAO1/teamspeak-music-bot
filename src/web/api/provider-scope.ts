import type { Request } from "express";
import type { BotDatabase, GrantedMusicAccount } from "../../data/database.js";
import type { MusicProvider } from "../../music/provider.js";

/**
 * Resolves which music provider a WEB request should read from (#164 follow-up).
 *
 * The bot keeps one shared login per platform (data/cookies/<platform>.json).
 * Before this module, a web user could only replace the SHARED login's taste for
 * their own private FM — every search, playlist and playback URL still came from
 * the admin's account, so members saw the admin's library.
 *
 * With `perUserMusicAccounts` enabled, the resolution order is:
 *
 *   1. the caller's OWN linked account  (`user_music_cookies`, scanned by them)
 *   2. an account an admin ASSIGNED    (`music_account_grants`, admin-owned)
 *   3. the bot's shared login           (always the fallback)
 *
 * Own-beats-assigned is deliberate: someone who linked their own account keeps
 * it even if an admin later hands them a pool account, and unlinking on the
 * member side can never revoke an admin's assignment (different table).
 *
 * Everything falls back to the shared instance when:
 *   - the admin left the feature off (the default — zero behaviour change),
 *   - the caller is a guest (guests share one anonymous identity and cannot link
 *     an account; /api/me/music already rejects them),
 *   - the caller has no linked and no assigned account for that platform,
 *   - the assigned account was disabled by the admin (instant rollback), or
 *   - the platform has no per-account login implemented (`withCookie` absent).
 *
 * The cookie never reaches the browser: it is read from the database here and
 * only ever lives inside the provider view.
 */
export interface MusicScopeDeps {
  /** Omitted by unit-test routers → personal accounts are simply unavailable. */
  database?: BotDatabase;
  /** Omitted by unit-test routers → treated as "feature off". */
  config?: { perUserMusicAccounts?: boolean };
}

interface ScopedUser {
  id?: string;
  role?: string;
}

/** Whether per-user music accounts are switched on for this router instance. */
export function perUserMusicEnabled(deps: MusicScopeDeps): boolean {
  return deps.config?.perUserMusicAccounts === true;
}

/**
 * The caller, when they may hold a per-user account at all. Guests never
 * qualify: they all map to one anonymous identity, so a linked or assigned
 * account would leak across every guest on the instance.
 */
function scopedUser(req: Request | undefined, deps: MusicScopeDeps): ScopedUser | null {
  if (!req) return null;
  const user = (req as { user?: ScopedUser }).user;
  if (!user?.id || user.role === "guest") return null;
  return user;
}

/**
 * The caller's own cookie for `platform`, or null when personal accounts do not
 * apply to this request.
 *
 * `alwaysPersonal` keeps the pre-existing #164 behaviour for personal FM: that
 * feature shipped BEFORE the admin toggle existed, so a linked account must keep
 * driving someone's private FM even while the toggle is off. Turning the toggle
 * on only widens the scope to search/playlists/playback URLs.
 */
export function personalCookieFor(
  req: Request | undefined,
  platform: string,
  deps: MusicScopeDeps,
  alwaysPersonal = false,
): string | null {
  if (!alwaysPersonal && !perUserMusicEnabled(deps)) return null;
  const user = scopedUser(req, deps);
  if (!user || !deps.database) return null;
  const cookie = deps.database.getUserMusicCookie(user.id!, platform);
  return cookie && cookie.trim() ? cookie : null;
}

/**
 * The admin-assigned account for this caller, or null.
 *
 * Unlike `personalCookieFor` this has NO `alwaysPersonal` escape hatch: an
 * assignment only exists because the admin turned the feature on, so turning it
 * off must hand everyone back to the shared login immediately. Doing otherwise
 * would leave members reading an admin's account after the admin "disabled"
 * the feature.
 */
export function grantedAccountFor(
  req: Request | undefined,
  platform: string,
  deps: MusicScopeDeps,
): GrantedMusicAccount | null {
  if (!perUserMusicEnabled(deps)) return null;
  const user = scopedUser(req, deps);
  if (!user || !deps.database) return null;
  return deps.database.getGrantedMusicAccount(user.id!, platform);
}

/**
 * Whether the member explicitly asked to play through the shared login.
 *
 * This exists for one concrete case: their own account has no membership, the
 * admin's does, and they would rather hear the paid tracks than their own
 * recommendations. Choosing it overrides BOTH their own link and any admin
 * assignment — it is an explicit instruction, not a fallback.
 */
export function preferSharedFor(
  req: Request | undefined,
  platform: string,
  deps: MusicScopeDeps,
): boolean {
  if (!perUserMusicEnabled(deps)) return false;
  const user = scopedUser(req, deps);
  if (!user || !deps.database) return false;
  return deps.database.getUserMusicPreference(user.id!, platform)?.preferShared === true;
}

/** Where the cookie driving this request came from. */
export interface ResolvedMusicCookie {
  source: "personal" | "granted";
  cookie: string;
  /** Admin-facing name of an assigned account; undefined for self-linked ones. */
  label?: string;
  /** Set for `source: "granted"` so callers can show "由管理员分配". */
  accountId?: string;
}

/**
 * The single place that decides "which login does this request use".
 * Returns null when the shared login applies.
 */
export function resolveMusicCookie(
  req: Request | undefined,
  platform: string,
  deps: MusicScopeDeps,
  options: { alwaysPersonal?: boolean } = {},
): ResolvedMusicCookie | null {
  // An explicit "use the shared account" outranks everything, including the
  // `alwaysPersonal` escape hatch: someone who chose membership over their own
  // recommendations wants the shared login for FM too.
  if (preferSharedFor(req, platform, deps)) return null;
  const own = personalCookieFor(req, platform, deps, options.alwaysPersonal);
  if (own) return { source: "personal", cookie: own };
  const granted = grantedAccountFor(req, platform, deps);
  if (granted) {
    return {
      source: "granted",
      cookie: granted.cookie,
      label: granted.label,
      accountId: granted.accountId,
    };
  }
  return null;
}

/**
 * Give `view` a single-shot fallback to the shared login when its own playback
 * attempt comes up empty.
 *
 * The case this exists for: the member's own account is real but has no
 * membership, so `/song/url/v1` answers `url: null` (or 400 for the paid track)
 * while the admin's account plays it fine. Without this the member has to go
 * into settings and switch manually before every such track.
 *
 * Only `getSongUrl` is wrapped — search, playlists and FM stay on the member's
 * own account, which is the whole point of per-user logins. The wrapper keeps
 * the shared instance untouched, so nothing leaks between callers.
 */
function withSharedPlaybackFallback(view: MusicProvider, shared: MusicProvider): MusicProvider {
  // Guard for partial implementations (and for test doubles): without both
  // sides resolvable there is nothing to fall back to.
  if (typeof view.getSongUrl !== "function" || typeof shared.getSongUrl !== "function") {
    return view;
  }
  const ownResolve = view.getSongUrl.bind(view);
  view.getSongUrl = async (songId: string, quality?: string) => {
    try {
      const result = await ownResolve(songId, quality);
      if (result?.url) return result;
    } catch {
      // A failure on the personal side (no membership, -460, expired cookie)
      // is not a reason for this track to go grey — try the shared login.
    }
    return shared.getSongUrl(songId, quality);
  };
  return view;
}

/**
 * Wrap `shared` in a per-account view when the request carries a usable login;
 * otherwise return `shared` untouched.
 *
 * A provider whose `withCookie` throws (malformed/persisted cookie) degrades to
 * the shared login rather than failing the request — a bad stored cookie must
 * not break search/playback for that user.
 */
export function resolveProviderForRequest(
  req: Request | undefined,
  platform: string,
  shared: MusicProvider,
  deps: MusicScopeDeps,
  options: { alwaysPersonal?: boolean; fallbackToShared?: boolean } = {},
): MusicProvider {
  const resolved = resolveMusicCookie(req, platform, deps, options);
  if (!resolved) return shared;
  if (typeof shared.withCookie !== "function") return shared;
  let view: MusicProvider;
  try {
    view = shared.withCookie(resolved.cookie);
  } catch {
    return shared;
  }
  // On by default: the common complaint is "my account has no membership, the
  // admin's does". Set false to keep playback strictly on the member's account.
  if (options.fallbackToShared === false) return view;
  return withSharedPlaybackFallback(view, shared);
}
