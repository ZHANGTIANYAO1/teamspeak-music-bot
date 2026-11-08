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

    if (!account.cookie) {
      res.json({
        linked: false,
        loggedIn: false,
        source: "none",
        canUnlink: false,
        supportsQrLogin,
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

  return router;
}
