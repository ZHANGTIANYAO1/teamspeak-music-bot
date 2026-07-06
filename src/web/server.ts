import express from "express";
import http from "node:http";
import path from "node:path";
import cookieParser from "cookie-parser";
import { WebSocketServer } from "ws";
import type { BotManager } from "../bot/manager.js";
import type { MusicProvider } from "../music/provider.js";
import type { BotDatabase } from "../data/database.js";
import type { BotConfig, GuestModeConfig } from "../data/config.js";
import type { Logger } from "../logger.js";
import type { CookieStore } from "../music/auth.js";
import type { AvatarStore } from "../data/avatars.js";
import { createBotRouter } from "./api/bot.js";
import { createMusicRouter } from "./api/music.js";
import { createPlayerRouter } from "./api/player.js";
import { createAuthRouter } from "./api/auth.js";
import { createSessionRouter } from "./api/session.js";
import { createUsersRouter } from "./api/users.js";
import { createAuditStore } from "../data/audit.js";
import { createAuditRouter } from "./api/audit.js";
import { createFavoritesRouter } from "./api/favorites.js";
import { createSpotifyRouter } from "./api/spotify.js";
import type { SpotifyOAuth } from "../music/spotify/spotify-oauth.js";
import type { SpotifyProvider } from "../music/spotify/provider.js";
import type { JellyfinProvider } from "../music/jellyfin.js";
import { resolveSpotifyBackendKind } from "../music/spotify/backend-select.js";
import {
  isGoLibrespotPresent,
  isLibrespotPresent,
} from "../music/spotify/binary.js";
import { setupWebSocket } from "./websocket.js";
import { createUserStore } from "../data/users.js";
import { createSessionStore } from "../data/sessions.js";
import { createPermissionStore } from "../data/permissions.js";
import { createRequireAuth } from "./middleware/requireAuth.js";
import { requireAdmin } from "./middleware/requireAdmin.js";
import { requireNotGuest } from "./middleware/requireNotGuest.js";
import { csrfOriginCheck } from "./middleware/csrf.js";
import { createRateLimit } from "./middleware/rateLimit.js";
import { validateSessionFromHeaders } from "./auth/validateSession.js";

const SESSION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export interface WebServerOptions {
  port: number;
  botManager: BotManager;
  neteaseProvider: MusicProvider;
  qqProvider: MusicProvider;
  bilibiliProvider: MusicProvider;
  localProvider: MusicProvider;
  kugouProvider: MusicProvider;
  spotifyProvider: MusicProvider;
  jellyfinProvider: MusicProvider;
  database: BotDatabase;
  config: BotConfig;
  configPath: string;
  logger: Logger;
  cookieStore?: CookieStore;
  avatarStore: AvatarStore;
  staticDir?: string;
  /** Process-wide shared Spotify OAuth (single account, Stage 3). When set, the
   *  /api/spotify {login,callback,status} router is mounted. */
  spotifyOAuth?: SpotifyOAuth;
}

export interface WebServer {
  start(): Promise<void>;
  stop(): void;
}

export function createWebServer(options: WebServerOptions): WebServer {
  const app = express();
  const server = http.createServer(app);
  const logger = options.logger.child({ component: "web" });

  if (options.config.trustProxy) {
    app.set("trust proxy", true);
  }

  // Security headers: prevent the WebUI from being embedded in a third-party
  // iframe (clickjacking defence). CSP frame-ancestors is the modern equivalent
  // of X-Frame-Options; both are set for compatibility across browsers.
  app.use((_req, res, next) => {
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
    next();
  });

  app.use(express.json({ limit: "400kb" }));
  app.use(cookieParser());

  const users = createUserStore(options.database.db);
  const sessions = createSessionStore(options.database.db);
  const audit = createAuditStore(options.database.db);
  const permissions = createPermissionStore(options.database.db);

  // ─── Public routes (no auth, no CSRF) ───────────────────────────────────
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", version: "0.1.0" });
  });

  app.get("/api/config/public-url", (_req, res) => {
    const raw = (options.config.publicUrl ?? "").trim();
    res.json({ publicUrl: raw ? raw.replace(/\/+$/, "") : null });
  });

  // Anti-DoS: throttle expensive (bcrypt) auth endpoints.
  // 5 req per minute per IP for /login (capacity 5, refill 5/60 = ~0.083/sec).
  // 3 req per minute per IP for /setup (more limited; first-run is rare).
  const loginLimit = createRateLimit({ capacity: 5, refillPerSec: 5 / 60 });
  const setupLimit = createRateLimit({ capacity: 3, refillPerSec: 3 / 60 });
  app.use("/api/session/login", loginLimit);
  app.use("/api/session/setup", setupLimit);

  app.use("/api/session", createSessionRouter(users, sessions, audit, logger, permissions, () => options.config.guestMode));

  // ─── Gates for everything else under /api ───────────────────────────────
  const requireAuth = createRequireAuth(sessions, permissions, () => options.config.guestMode);
  app.use("/api", csrfOriginCheck);
  app.use("/api", requireAuth);

  // ─── Protected routes ───────────────────────────────────────────────────
  // The bot router is mounted BEFORE setupWebSocket runs, but its /settings
  // handler needs to trigger a guest-policy refresh on the (later-created) WS
  // controller. Bridge the two with a mutable indirection that starts as a
  // no-op and is wired to the real refreshGuestPolicy once the WS is set up.
  let onGuestPolicyChanged: (cfg: GuestModeConfig) => void = () => {};
  app.use(
    "/api/bot",
    createBotRouter(
      options.botManager,
      options.config,
      options.configPath,
      logger,
      options.database,
      options.avatarStore,
      (cfg) => onGuestPolicyChanged(cfg),
      // I2: so saving a Client ID in Settings re-configures the live OAuth
      // (no restart needed for the UI-entered-creds -> Connect flow).
      options.spotifyOAuth,
      // R2-4: so saving Spotify creds in Settings also refreshes the live Web API
      // search provider (search + getAuthStatus) without a process restart. The
      // runtime object is a SpotifyProvider (see index.ts); WebServerOptions types
      // it as the wider MusicProvider, so narrow it here for the setCreds contract.
      options.spotifyProvider as SpotifyProvider,
      // Same live-reconfigure contract for Jellyfin: a Settings save re-points
      // the connection without a restart. Runtime object is a JellyfinProvider
      // (see index.ts); WebServerOptions types it as the wider MusicProvider.
      options.jellyfinProvider as JellyfinProvider,
    )
  );
  app.use(
    "/api/music",
    createMusicRouter(options.neteaseProvider, options.qqProvider, options.bilibiliProvider, logger, options.localProvider, options.config, options.kugouProvider, options.spotifyProvider, options.jellyfinProvider)
  );
  app.use("/api/player", createPlayerRouter(
    options.botManager, logger, options.database,
    options.neteaseProvider, options.qqProvider, options.bilibiliProvider,
  ));
  app.use(
    "/api/auth",
    createAuthRouter(options.neteaseProvider, options.qqProvider, options.bilibiliProvider, logger, options.cookieStore, options.kugouProvider, options.spotifyProvider, options.jellyfinProvider, options.config)
  );
  if (options.spotifyOAuth) {
    app.use(
      "/api/spotify",
      createSpotifyRouter({
        oauth: options.spotifyOAuth,
        logger,
        getBackendInfo: () => {
          // PATH-aware presence (Bug m1): a PATH-installed binary (bare name)
          // is resolved against $PATH, not existsSync()'d against cwd.
          const goPresent = isGoLibrespotPresent();
          const rustPresent = isLibrespotPresent();
          const resolved = resolveSpotifyBackendKind(
            options.config.spotify.backend,
            goPresent,
            rustPresent,
          );
          return {
            backend: resolved ?? "none",
            deviceName: options.config.spotify.deviceName,
            binaryAvailable: resolved !== null,
          };
        },
        webUiRedirect: "/",
      }),
    );
  }
  app.use("/api/favorites", requireNotGuest, createFavoritesRouter(options.database, logger));

  // admin-only routes
  app.use("/api/users", requireAdmin, createUsersRouter(users, sessions, audit, logger, permissions));
  app.use("/api/audit", requireAdmin, createAuditRouter(audit));

  // ─── Static SPA (public) ────────────────────────────────────────────────
  if (options.staticDir) {
    app.use(express.static(options.staticDir));
    app.get(/^(?!\/api|\/ws)/, (_req, res) => {
      res.sendFile(path.join(options.staticDir!, "index.html"));
    });
  }

  server.on("error", (err) => {
    logger.error({ err }, "HTTP server error");
  });

  // ─── WebSocket with manual upgrade auth ────────────────────────────────
  const wss = new WebSocketServer({ noServer: true });
  wss.on("error", (err) => {
    logger.error({ err }, "WebSocket server error");
  });
  server.on("upgrade", (req, socket, head) => {
    if (req.url !== "/ws") {
      socket.destroy();
      return;
    }
    const reqHost = req.headers.host;
    const originHeader = req.headers.origin;
    if (originHeader) {
      let originHost: string | null = null;
      try {
        originHost = new URL(originHeader).host;
      } catch {
        // fall through; treat as missing/invalid origin
      }
      if (!originHost || originHost !== reqHost) {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
    }
    const result = validateSessionFromHeaders(req.headers.cookie as string | undefined, sessions);
    if (!result) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    // Guest sessions are only valid while guest mode is enabled.
    if (result.role === "guest" && !options.config.guestMode.enabled) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const guestBots = options.config.guestMode.bots;
    const botScope: "all" | Set<string> =
      result.role === "guest"
        ? guestBots === "all" ? "all" : new Set(guestBots)
        : "all";
    wss.handleUpgrade(req, socket, head, (ws) => {
      const w = ws as unknown as { userId: string; isGuest: boolean; botScope: "all" | Set<string> };
      w.userId = result.userId;
      w.isGuest = result.role === "guest";
      w.botScope = botScope;
      wss.emit("connection", ws, req);
    });
  });
  const controller = setupWebSocket(wss, options.botManager, logger);
  onGuestPolicyChanged = controller.refreshGuestPolicy;

  // ─── Session cleanup interval ──────────────────────────────────────────
  let cleanupTimer: ReturnType<typeof setInterval> | null = null;

  return {
    async start(): Promise<void> {
      return new Promise((resolve) => {
        server.listen(options.port, () => {
          logger.info({ port: options.port }, "Web server started");
          cleanupTimer = setInterval(() => {
            try {
              sessions.cleanupExpired();
            } catch (err) {
              logger.error({ err }, "session cleanup failed");
            }
          }, SESSION_CLEANUP_INTERVAL_MS);
          resolve();
        });
      });
    },
    stop(): void {
      if (cleanupTimer) {
        clearInterval(cleanupTimer);
        cleanupTimer = null;
      }
      controller.cleanup();
      wss.close();
      server.close();
    },
  };
}
