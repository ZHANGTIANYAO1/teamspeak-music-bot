import { Router } from "express";
import type { BotDatabase, MusicAccount } from "../../data/database.js";
import type { MusicProvider } from "../../music/provider.js";
import type { CookieStore } from "../../music/auth.js";
import type { UserStore } from "../../data/users.js";
import type { Logger } from "../../logger.js";
import { PERSONAL_MUSIC_PLATFORMS } from "./personal-music.js";

/**
 * Admin console for the music-account pool (#164 follow-up).
 *
 * Why a pool instead of "everyone links their own account":
 *   - Most members do not own a paid NetEase/QQ/Kugou login, and the bot's
 *     shared account is usually the ADMIN's. Handing the shared login to some
 *     members while giving others their own is exactly the "mixed" case this
 *     feature has to support.
 *   - So the admin keeps a pool of logins (`music_accounts`) and assigns one to
 *     a member (`music_account_grants`). Assignment is per platform, and a
 *     member can hold at most one assigned account per platform.
 *
 * The controls that stop assignments from turning into a mess:
 *   1. OWN BEATS ASSIGNED. A member who linked their own account ignores the
 *      assignment entirely (see provider-scope.ts). Assigning never overrides
 *      a member's own login.
 *   2. CAPACITY. `capacity = 1` means exclusive: the API refuses to hand the
 *      same login to a second member (409). `capacity = 0` means unlimited
 *      (fine for a throwaway account, NOT for one whose recommendations you
 *      care about — every grantee writes to that account's history).
 *   3. ENABLED FLAG. Disabling an account is an instant, reversible rollback:
 *      every grantee falls back to their own login / the shared login without
 *      the grants being deleted.
 *   4. DELETE CASCADES. Removing an account deletes its grants in the same
 *      transaction (FK ON DELETE CASCADE), so no member is left pointing at a
 *      row that no longer exists.
 *   5. COOKIES NEVER LEAVE THE SERVER. Every response carries a masked
 *      preview only; the full value is only ever written, never read back.
 *
 * The whole router is admin-only (requireAdmin at the mount point): a member
 * with `bot.manage` still must not see what other people are assigned.
 */
export function createMusicAccountsRouter(
  database: BotDatabase,
  users: UserStore,
  providers: Partial<Record<string, MusicProvider>>,
  logger: Logger,
  cookieStore?: CookieStore,
): Router {
  const router = Router();

  const knownPlatforms = new Set<string>(PERSONAL_MUSIC_PLATFORMS);

  /**
   * Cookies are bearer credentials: showing one in full once is enough to take
   * the account over. The console only ever needs to tell two logins apart.
   */
  const maskCookie = (cookie: string): string => {
    if (!cookie) return "";
    if (cookie.length <= 16) return "••••••";
    return `${cookie.slice(0, 6)}…${cookie.slice(-4)}  (${cookie.length} 字符)`;
  };

  const toWire = (a: MusicAccount) => {
    const holders = database.listMusicAccountGrants(a.id);
    return {
      id: a.id,
      platform: a.platform,
      label: a.label,
      cookiePreview: maskCookie(a.cookie),
      ownerId: a.ownerId,
      capacity: a.capacity,
      enabled: a.enabled,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
      // The UI needs the count to grey out "assign" on an exclusive account.
      granteeCount: holders.length,
      grantees: holders.map((g) => ({
        userId: g.userId,
        username: g.username,
        grantedAt: g.grantedAt,
      })),
      // A platform without withCookie stores the cookie but cannot build a
      // per-account view yet — surfaced so the admin is not left guessing.
      playbackSupported: typeof providers[a.platform]?.withCookie === "function",
    };
  };

  const isPlatform = (v: unknown): v is (typeof PERSONAL_MUSIC_PLATFORMS)[number] =>
    typeof v === "string" && knownPlatforms.has(v);

  const nonEmpty = (v: unknown, max: number): v is string =>
    typeof v === "string" && v.trim().length > 0 && v.length <= max;

  /** Every real (non-guest) user, for the assign dropdown. */
  const assignableUsers = () =>
    users.listUsers().map((u) => ({ id: u.id, username: u.username, role: u.role }));

  router.get("/", (_req, res) => {
    const accounts = database.listMusicAccounts().map(toWire);
    res.json({
      accounts,
      users: assignableUsers(),
      platforms: [...PERSONAL_MUSIC_PLATFORMS].map((p) => ({
        platform: p,
        // Only platforms that implement withCookie can actually play back a
        // per-user login; the rest accept a paste but fall back to shared.
        playbackSupported: typeof providers[p]?.withCookie === "function",
      })),
    });
  });

  router.post("/", (req, res) => {
    const { platform, label, cookie, capacity, ownerId, enabled } = req.body ?? {};
    if (!isPlatform(platform)) {
      res.status(400).json({ error: "unsupported platform" });
      return;
    }
    if (!nonEmpty(label, 64)) {
      res.status(400).json({ error: "label is required (max 64 chars)" });
      return;
    }
    if (!nonEmpty(cookie, 8192)) {
      res.status(400).json({ error: "cookie is required" });
      return;
    }
    if (capacity !== undefined && (typeof capacity !== "number" || capacity < 0)) {
      res.status(400).json({ error: "capacity must be a non-negative number" });
      return;
    }
    if (ownerId !== undefined && ownerId !== null && typeof ownerId !== "string") {
      res.status(400).json({ error: "ownerId must be a string or null" });
      return;
    }
    if (enabled !== undefined && typeof enabled !== "boolean") {
      res.status(400).json({ error: "enabled must be a boolean" });
      return;
    }
    const created = database.createMusicAccount({
      platform,
      label: label.trim(),
      cookie: cookie.trim(),
      ownerId: ownerId ?? null,
      capacity,
      // Creating a disabled account is allowed: it lets the admin stage a
      // cookie before handing it out.
      enabled: enabled !== false,
    });
    logger.info({ accountId: created.id, platform, label: created.label }, "Music account added");
    res.status(201).json(toWire(created));
  });

  router.patch("/:id", (req, res) => {
    const account = database.getMusicAccount(req.params.id);
    if (!account) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const { label, cookie, capacity, enabled } = req.body ?? {};
    if (label !== undefined && !nonEmpty(label, 64)) {
      res.status(400).json({ error: "invalid label" });
      return;
    }
    if (cookie !== undefined && !nonEmpty(cookie, 8192)) {
      res.status(400).json({ error: "invalid cookie" });
      return;
    }
    if (capacity !== undefined && (typeof capacity !== "number" || capacity < 0)) {
      res.status(400).json({ error: "capacity must be a non-negative number" });
      return;
    }
    if (enabled !== undefined && typeof enabled !== "boolean") {
      res.status(400).json({ error: "enabled must be a boolean" });
      return;
    }
    // Replacing the cookie invalidates any device-bound session (Kugou binds
    // the token to guid/mid) — the existing grants keep pointing at the row,
    // so the admin only has to paste a fresh cookie to fix everyone at once.
    database.updateMusicAccount(account.id, {
      label: label === undefined ? undefined : label.trim(),
      cookie: cookie === undefined ? undefined : cookie.trim(),
      capacity,
      enabled,
    });
    logger.info(
      { accountId: account.id, enabled: enabled ?? account.enabled },
      "Music account updated",
    );
    res.json(toWire(database.getMusicAccount(account.id)!));
  });

  router.delete("/:id", (req, res) => {
    const account = database.getMusicAccount(req.params.id);
    if (!account) {
      res.status(404).json({ error: "not found" });
      return;
    }
    // FK ON DELETE CASCADE removes the grants with it, so no member is left
    // pointing at a deleted row. `changes` on the parent is what we report.
    const deleted = database.deleteMusicAccount(account.id);
    logger.info(
      { accountId: account.id, platform: account.platform, deleted },
      "Music account removed",
    );
    res.json({ ok: deleted, revokedGrants: true });
  });

  /**
   * Assign an account to a user (member OR another admin — an admin can be a
   * grantee too, they are just not forced onto the shared login).
   */
  router.post("/:id/assign", (req, res) => {
    const account = database.getMusicAccount(req.params.id);
    if (!account) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const { userId } = req.body ?? {};
    if (typeof userId !== "string" || !userId) {
      res.status(400).json({ error: "userId is required" });
      return;
    }
    const target = users.findById(userId);
    if (!target || target.role === "guest") {
      res.status(404).json({ error: "user not found" });
      return;
    }

    // Enabled + capacity are enforced inside a single transaction in the data
    // layer, so two concurrent assignments cannot both slip past the check.
    const result = database.assignMusicAccount(userId, account.id, req.user!.id);
    if (!result.ok) {
      if (result.reason === "not_found") {
        res.status(404).json({ error: "not_found" });
        return;
      }
      if (result.reason === "disabled") {
        res.status(409).json({ error: "account_disabled" });
        return;
      }
      const holders = database.listMusicAccountGrants(account.id).map((h) => ({
        userId: h.userId,
        username: h.username,
      }));
      if (result.reason === "exclusive") {
        res.status(409).json({ error: "account_exclusive", holders });
        return;
      }
      res.status(409).json({ error: "account_full", capacity: account.capacity, holders });
      return;
    }

    logger.info(
      { accountId: account.id, userId, replacedAccountId: result.replacedAccountId },
      "Music account assigned",
    );
    res.json({
      ok: true,
      userId,
      username: target.username,
      accountId: account.id,
      platform: account.platform,
      replacedAccountId: result.replacedAccountId,
    });
  });

  router.delete("/:id/assign/:userId", (req, res) => {
    const account = database.getMusicAccount(req.params.id);
    if (!account) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const removed = database.deleteMusicAccountGrant(req.params.userId, account.platform);
    logger.info(
      { accountId: account.id, userId: req.params.userId, removed },
      "Music account assignment revoked",
    );
    res.json({ ok: true, removed });
  });

  /** Live check: is this cookie still logged in? */
  router.post("/:id/probe", async (req, res) => {
    const account = database.getMusicAccount(req.params.id);
    if (!account) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const provider = providers[account.platform];
    if (!provider || typeof provider.withCookie !== "function") {
      res.status(501).json({ error: "playback not supported for this platform" });
      return;
    }
    try {
      const status = await provider.withCookie(account.cookie).getAuthStatus();
      res.json({ ok: true, ...status });
    } catch (err) {
      logger.warn({ err, accountId: account.id }, "Music account probe failed");
      res.status(502).json({ error: (err as Error).message, loggedIn: false });
    }
  });

  /**
   * Seed the pool with the login the bot already uses, so an admin who scanned
   * the shared account can hand it to selected members without re-scanning.
   */
  router.post("/import-shared", (req, res) => {
    const { platform, label, capacity } = req.body ?? {};
    // QQ 的共享登录以"运行中的 provider"为准：登录写的是它内存里的 cookie，
    // qq.json 只是落盘副本。托管会话轮换凭据之后文件就旧了（#188），
    // 从这里导入会把一个过期 cookie 塞进账号池。
    const sharedQq = platform === "qq" ? providers.qq : undefined;
    if (!sharedQq && !cookieStore) {
      res.status(501).json({ error: "cookie store unavailable" });
      return;
    }
    if (!isPlatform(platform)) {
      res.status(400).json({ error: "unsupported platform" });
      return;
    }
    if (capacity !== undefined && (typeof capacity !== "number" || capacity < 0)) {
      res.status(400).json({ error: "capacity must be a non-negative number" });
      return;
    }
    // 没有 qq provider（例如单测只挂了 netease）时仍然回落到 cookie store，
    // 所以这个改动对已有平台零影响。
    let cookie: string | undefined;
    if (sharedQq) {
      try {
        cookie = sharedQq.getCookie();
      } catch {
        // Provider 还没建立登录态时抛错等价于「没有可导入的登录」
        cookie = "";
      }
    } else {
      cookie = cookieStore?.load(platform);
    }
    if (!cookie || !cookie.trim()) {
      res.status(409).json({ error: "no_shared_login", platform });
      return;
    }
    const created = database.createMusicAccount({
      platform,
      label: nonEmpty(label, 64) ? label.trim() : `${platform} 共享账号`,
      cookie: cookie.trim(),
      // ownerId stays null: this login was provided by the bot, not a person.
      ownerId: null,
      capacity,
      enabled: true,
    });
    logger.info({ accountId: created.id, platform }, "Shared login imported into pool");
    res.status(201).json(toWire(created));
  });

  return router;
}
