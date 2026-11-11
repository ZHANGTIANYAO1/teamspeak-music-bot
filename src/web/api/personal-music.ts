import { Router } from "express";
import type { BotDatabase } from "../../data/database.js";
import type { MusicProvider, QrCodeResult } from "../../music/provider.js";
import type { Logger } from "../../logger.js";
import { perUserMusicEnabled, type MusicScopeDeps } from "./provider-scope.js";

/**
 * A provider that can log a web user into their OWN account without touching
 * the bot's shared login, and hand out a view bound to that account (#164).
 */
export interface PersonalLoginProvider {
  getQrCode(): Promise<QrCodeResult>;
  pollQrLogin(key: string): Promise<{ status: "waiting" | "scanned" | "confirmed" | "expired"; cookie?: string }>;
  withCookie(cookie: string): MusicProvider;
}

export function supportsPersonalLogin(
  provider: MusicProvider | undefined,
): provider is MusicProvider & PersonalLoginProvider {
  const p = provider as Partial<PersonalLoginProvider> | undefined;
  return typeof p?.pollQrLogin === "function" && typeof p?.withCookie === "function";
}

/** Platforms a member can link an account for. Kept in sync with the providers map. */
export const PERSONAL_MUSIC_PLATFORMS = ["netease", "qq", "kugou", "bilibili"] as const;

/**
 * A web user's own music account (#164), generalised to every platform that
 * implements `withCookie` (#164 follow-up).
 *
 * Three states are reported, and the member UI needs all three:
 *   - `personal`: the caller scanned their own QR code. They may unlink it.
 *   - `granted` : an ADMIN assigned one of the pool accounts to them. It cannot
 *                 be unlinked from here — only the admin can take it back —
 *                 which is why `canUnlink` is part of the payload instead of
 *                 the UI guessing from `linked`.
 *   - `none`    : nothing linked; playback falls back to the bot's shared login.
 *
 * The cookie is stored server-side and never sent back to the browser; the
 * `label` of an assigned account is what the member sees instead of a nickname.
 */
export function createPersonalMusicRouter(
  database: BotDatabase,
  providers: Partial<Record<string, MusicProvider>>,
  logger: Logger,
  config?: MusicScopeDeps["config"],
): Router {
  const router = Router();

  const providerFor = (platform: string): MusicProvider | undefined => providers[platform];

  /** 404 for platforms this build does not expose at all. */
  router.param("platform", (req, res, next, platform: string) => {
    if (!providerFor(platform)) {
      res.status(404).json({ error: `Unknown platform: ${platform}` });
      return;
    }
    next();
  });

  /** Read the account state for one platform: own first, then admin-assigned. */
  const describeAccount = (
    userId: string,
    platform: string,
  ): { source: "personal" | "granted" | "none"; cookie: string | null; label?: string; canUnlink: boolean } => {
    const own = database.getUserMusicCookie(userId, platform);
    if (own && own.trim()) {
      return { source: "personal", cookie: own, canUnlink: true };
    }
    // An assignment only exists because the admin turned the feature on, so it
    // stops applying the moment the toggle goes off (same rule as playback).
    if (perUserMusicEnabled({ database, config })) {
      const granted = database.getGrantedMusicAccount(userId, platform);
      if (granted) {
        return { source: "granted", cookie: granted.cookie, label: granted.label, canUnlink: false };
      }
    }
    return { source: "none", cookie: null, canUnlink: false };
  };

  router.get("/:platform/status", async (req, res) => {
    const platform = req.params.platform;
    const provider = providerFor(platform)!;
    const account = describeAccount(req.user!.id, platform);
    // Lets the member UI hide "扫码绑定" on platforms that only accept an
    // admin-assigned account (qq / kugou / bilibili today).
    const supportsQrLogin = supportsPersonalLogin(provider);
    // The member's explicit "play through the shared login" choice, so the UI
    // can render the radio without a second round-trip.
    const preferShared =
      database.getUserMusicPreference(req.user!.id, platform)?.preferShared === true;
    // The choice only exists while the admin has per-user accounts on; with it
    // off everyone is already on the shared login and the radio is meaningless.
    const featureEnabled = perUserMusicEnabled({ database, config });

    if (!account.cookie) {
      res.json({
        linked: false,
        loggedIn: false,
        source: "none",
        canUnlink: false,
        supportsQrLogin,
        preferShared,
        featureEnabled,
      });
      return;
    }
    if (typeof provider.withCookie !== "function") {
      // Account stored but this platform cannot build a per-account view yet.
      res.json({
        linked: true,
        loggedIn: false,
        source: account.source,
        label: account.label,
        canUnlink: account.canUnlink,
        supportsQrLogin,
        preferShared,
        featureEnabled,
        unsupported: true,
      });
      return;
    }
    try {
      const status = await provider.withCookie(account.cookie).getAuthStatus();
      res.json({
        linked: true,
        source: account.source,
        label: account.label,
        canUnlink: account.canUnlink,
        supportsQrLogin,
        preferShared,
        featureEnabled,
        ...status,
      });
    } catch (err) {
      logger.warn({ err, platform, source: account.source }, "Personal music status check failed");
      res.json({
        linked: true,
        loggedIn: false,
        source: account.source,
        label: account.label,
        canUnlink: account.canUnlink,
        supportsQrLogin,
        preferShared,
        featureEnabled,
      });
    }
  });

  router.post("/:platform/qrcode", async (req, res) => {
    const platform = req.params.platform;
    const provider = providerFor(platform)!;
    if (!supportsPersonalLogin(provider)) {
      // Only NetEase ships "poll and hand back the cookie" today. The other
      // platforms can still receive an admin-assigned account.
      res.status(501).json({
        error: "Personal QR login is not implemented for this platform yet",
        platform,
      });
      return;
    }
    try {
      res.json(await provider.getQrCode());
    } catch (err) {
      logger.error({ err, platform }, "Personal music QR generation failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/:platform/qrcode/status", async (req, res) => {
    const platform = req.params.platform;
    const provider = providerFor(platform)!;
    if (!supportsPersonalLogin(provider)) {
      res.status(501).json({
        error: "Personal QR login is not implemented for this platform yet",
        platform,
      });
      return;
    }
    const key = req.query.key;
    if (typeof key !== "string" || !key) {
      res.status(400).json({ error: "key is required" });
      return;
    }
    try {
      const { status, cookie } = await provider.pollQrLogin(key);
      if (status === "confirmed" && cookie) {
        database.setUserMusicCookie(req.user!.id, platform, cookie);
        logger.info({ userId: req.user!.id, platform }, "Personal music account linked");
      }
      res.json({ status });
    } catch (err) {
      logger.error({ err, platform }, "Personal music QR status check failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.delete("/:platform", (req, res) => {
    const platform = req.params.platform;
    const userId = req.user!.id;
    // Only the member's OWN login is removed. An admin-assigned account lives
    // in a different table and must stay put — otherwise a member could revoke
    // (or accidentally destroy) what the admin handed them.
    const removed = database.deleteUserMusicCookie(userId, platform);
    if (removed) {
      logger.info({ userId, platform }, "Personal music account unlinked");
    }
    const remaining = describeAccount(userId, platform);
    res.json({
      ok: true,
      removed,
      // What playback falls back to now — the member UI shows the right hint.
      fallback: remaining.source === "granted" ? "granted" : "shared",
    });
  });

  /**
   * Which login this member plays through.
   *
   * `preferShared: true` = ignore my own (and any assigned) account and use the
   * bot's shared login — the admin's, usually the one with a membership. It is
   * the answer to "my NetEase account has no VIP, the admin's does, and I want
   * the paid track". Nothing is deleted: flipping it back restores the personal
   * account exactly as it was.
   */
  router.put("/:platform/preference", (req, res) => {
    const platform = req.params.platform;
    const { preferShared } = req.body ?? {};
    if (typeof preferShared !== "boolean") {
      res.status(400).json({ error: "preferShared must be a boolean" });
      return;
    }
    // With the feature off there is nothing to choose between — everything
    // already runs on the shared login. Refuse instead of storing a value that
    // would silently do nothing.
    if (!perUserMusicEnabled({ database, config })) {
      res.status(409).json({ error: "per_user_accounts_disabled" });
      return;
    }
    database.setUserMusicPreference(req.user!.id, platform, preferShared);
    logger.info({ userId: req.user!.id, platform, preferShared }, "Music account preference set");
    res.json({ platform, preferShared });
  });

  router.get("/:platform/preference", (req, res) => {
    const platform = req.params.platform;
    const pref = database.getUserMusicPreference(req.user!.id, platform);
    res.json({ platform, preferShared: pref?.preferShared === true });
  });

  return router;
}
