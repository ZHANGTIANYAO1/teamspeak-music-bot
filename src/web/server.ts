import express from "express";
import http from "node:http";
import path from "node:path";
import { WebSocketServer } from "ws";
import type { BotManager } from "../bot/manager.js";
import type { MusicProvider } from "../music/provider.js";
import type { BotDatabase } from "../data/database.js";
import type { BotConfig } from "../data/config.js";
import type { Logger } from "../logger.js";
import type { CookieStore } from "../music/auth.js";
import { createBotRouter } from "./api/bot.js";
import { createMusicRouter } from "./api/music.js";
import { createPlayerRouter } from "./api/player.js";
import { createAuthRouter } from "./api/auth.js";
import { setupWebSocket } from "./websocket.js";

export interface WebServerOptions {
  port: number;
  botManager: BotManager;
  neteaseProvider: MusicProvider;
  qqProvider: MusicProvider;
  bilibiliProvider: MusicProvider;
  youtubeProvider: MusicProvider;
  database: BotDatabase;
  config: BotConfig;
  logger: Logger;
  cookieStore?: CookieStore;
  staticDir?: string;
}

export interface WebServer {
  start(): Promise<void>;
  stop(): void;
}

export function createWebServer(options: WebServerOptions): WebServer {
  const app = express();
  const server = http.createServer(app);
  const logger = options.logger.child({ component: "web" });

  app.use(express.json());

  app.use(
    "/api/bot",
    createBotRouter(options.botManager, options.config, logger)
  );
  app.use(
    "/api/music",
    createMusicRouter(options.neteaseProvider, options.qqProvider, options.bilibiliProvider, options.youtubeProvider, logger)
  );
  app.use("/api/player", createPlayerRouter(
    options.botManager, logger, options.database,
    options.neteaseProvider, options.qqProvider, options.bilibiliProvider, options.youtubeProvider,
  ));
  app.use(
    "/api/auth",
    createAuthRouter(options.neteaseProvider, options.qqProvider, options.bilibiliProvider, options.youtubeProvider, logger, options.cookieStore)
  );

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", version: "0.1.0" });
  });

  if (options.staticDir) {
    app.use(express.static(options.staticDir));
    app.get(/^(?!\/api|\/ws)/, (_req, res) => {
      res.sendFile(path.join(options.staticDir!, "index.html"));
    });
  }

  server.on("error", (err) => {
    logger.error({ err }, "HTTP server error");
  });

  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("error", (err) => {
    logger.error({ err }, "WebSocket server error");
  });
  const cleanupWs = setupWebSocket(wss, options.botManager, logger);

  return {
    async start(): Promise<void> {
      return new Promise((resolve) => {
        server.listen(options.port, () => {
          logger.info({ port: options.port }, "Web server started");
          resolve();
        });
      });
    },
    stop(): void {
      cleanupWs();
      wss.close();
      server.close();
    },
  };
}
