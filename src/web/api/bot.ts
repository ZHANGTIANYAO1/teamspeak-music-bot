import { Router } from "express";
import type { BotManager } from "../../bot/manager.js";
import type { BotConfig } from "../../data/config.js";
import type { Logger } from "../../logger.js";

export function createBotRouter(
  botManager: BotManager,
  config: BotConfig,
  logger: Logger
): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    const bots = botManager.getAllBots().map((b) => b.getStatus());
    res.json({ bots });
  });

  router.get("/:id", (req, res) => {
    const bot = botManager.getBot(req.params.id);
    if (!bot) {
      res.status(404).json({ error: "Bot not found" });
      return;
    }
    res.json(bot.getStatus());
  });

  // Get saved config for a bot
  router.get("/:id/config", (req, res) => {
    const saved = botManager.getBotConfig(req.params.id);
    if (!saved) {
      res.status(404).json({ error: "Bot config not found" });
      return;
    }
    res.json(saved);
  });

  router.post("/", async (req, res) => {
    try {
      const {
        name,
        serverAddress,
        serverPort,
        nickname,
        defaultChannel,
        channelPassword,
        serverPassword,
        autoStart,
      } = req.body;
      if (!name || !serverAddress || !nickname) {
        res
          .status(400)
          .json({ error: "name, serverAddress, and nickname are required" });
        return;
      }
      const bot = await botManager.createBot({
        name,
        serverAddress,
        serverPort: serverPort ?? 9987,
        nickname,
        defaultChannel,
        channelPassword,
        serverPassword,
        autoStart: autoStart ?? false,
      });
      res.status(201).json(bot.getStatus());
    } catch (err) {
      logger.error({ err }, "Failed to create bot");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Update bot config (must be stopped first to apply connection changes)
  router.put("/:id", async (req, res) => {
    try {
      const bot = botManager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ error: "Bot not found" });
        return;
      }
      const { name, serverAddress, serverPort, nickname, defaultChannel, channelPassword, serverPassword } = req.body;
      // Update in database
      botManager.updateBot(req.params.id, {
        name, serverAddress, serverPort, nickname, defaultChannel, channelPassword, serverPassword,
      });
      res.json({ success: true });
    } catch (err) {
      logger.error({ err }, "Failed to update bot");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.delete("/:id", async (req, res) => {
    try {
      await botManager.removeBot(req.params.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/:id/start", async (req, res) => {
    try {
      await botManager.startBot(req.params.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/:id/stop", (req, res) => {
    try {
      botManager.stopBot(req.params.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
