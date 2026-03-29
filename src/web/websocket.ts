import { WebSocketServer, WebSocket } from "ws";
import type { BotManager } from "../bot/manager.js";
import type { Logger } from "../logger.js";

export function setupWebSocket(
  wss: WebSocketServer,
  botManager: BotManager,
  logger: Logger
): () => void {
  const clients = new Set<WebSocket>();

  wss.on("connection", (ws) => {
    clients.add(ws);
    logger.debug("WebSocket client connected");

    const bots = botManager.getAllBots().map((b) => b.getStatus());
    ws.send(JSON.stringify({ type: "init", bots }));

    ws.on("close", () => {
      clients.delete(ws);
      logger.debug("WebSocket client disconnected");
    });

    ws.on("error", (err) => {
      logger.error({ err }, "WebSocket error");
      clients.delete(ws);
    });
  });

  const broadcast = (data: object) => {
    const message = JSON.stringify(data);
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  };

  const attachBotListeners = () => {
    for (const bot of botManager.getAllBots()) {
      bot.removeAllListeners("stateChange");
      bot.removeAllListeners("connected");
      bot.removeAllListeners("disconnected");

      bot.on("stateChange", () => {
        broadcast({
          type: "stateChange",
          botId: bot.id,
          status: bot.getStatus(),
          queue: bot.getQueue(),
        });
      });

      bot.on("connected", () => {
        broadcast({
          type: "botConnected",
          botId: bot.id,
          status: bot.getStatus(),
        });
      });

      bot.on("disconnected", () => {
        broadcast({ type: "botDisconnected", botId: bot.id });
      });
    }
  };

  const intervalId = setInterval(attachBotListeners, 5000);
  attachBotListeners();

  return () => {
    clearInterval(intervalId);
  };
}
