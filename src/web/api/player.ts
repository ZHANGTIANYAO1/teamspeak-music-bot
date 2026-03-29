import { Router } from "express";
import type { BotManager } from "../../bot/manager.js";
import type { Logger } from "../../logger.js";
import { parseCommand } from "../../bot/commands.js";

export function createPlayerRouter(
  botManager: BotManager,
  logger: Logger
): Router {
  const router = Router();

  router.use("/:botId", (req, res, next) => {
    const bot = botManager.getBot(req.params.botId);
    if (!bot) {
      res.status(404).json({ error: "Bot not found" });
      return;
    }
    (req as any).bot = bot;
    next();
  });

  router.post("/:botId/play", async (req, res) => {
    try {
      const bot = (req as any).bot;
      const { query, platform } = req.body;
      if (!query) {
        res.status(400).json({ error: "query is required" });
        return;
      }
      const flags = platform === "qq" ? "-q" : "";
      const cmd = parseCommand(`!play ${flags} ${query}`.trim(), "!");
      if (!cmd) {
        res.status(400).json({ error: "Invalid command" });
        return;
      }
      const response = await bot.executeCommand(cmd);
      res.json({ message: response });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/:botId/add", async (req, res) => {
    try {
      const bot = (req as any).bot;
      const { query, platform } = req.body;
      const flags = platform === "qq" ? "-q" : "";
      const cmd = parseCommand(`!add ${flags} ${query}`.trim(), "!");
      if (!cmd) {
        res.status(400).json({ error: "Invalid command" });
        return;
      }
      const response = await bot.executeCommand(cmd);
      res.json({ message: response });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  const simpleCommand = (cmdStr: string) => async (req: any, res: any) => {
    try {
      const bot = req.bot;
      const cmd = parseCommand(cmdStr, "!")!;
      const response = await bot.executeCommand(cmd);
      res.json({ message: response });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  };

  router.post("/:botId/pause", simpleCommand("!pause"));
  router.post("/:botId/resume", simpleCommand("!resume"));
  router.post("/:botId/next", simpleCommand("!next"));
  router.post("/:botId/prev", simpleCommand("!prev"));
  router.post("/:botId/stop", simpleCommand("!stop"));
  router.post("/:botId/clear", simpleCommand("!clear"));

  router.post("/:botId/volume", async (req, res) => {
    try {
      const bot = (req as any).bot;
      const { volume } = req.body;
      const cmd = parseCommand(`!vol ${volume}`, "!")!;
      const response = await bot.executeCommand(cmd);
      res.json({ message: response });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/:botId/mode", async (req, res) => {
    try {
      const bot = (req as any).bot;
      const { mode } = req.body;
      const cmd = parseCommand(`!mode ${mode}`, "!")!;
      const response = await bot.executeCommand(cmd);
      res.json({ message: response });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/:botId/queue", (req, res) => {
    const bot = (req as any).bot;
    res.json({ queue: bot.getQueue(), status: bot.getStatus() });
  });

  router.delete("/:botId/queue/:index", async (req, res) => {
    try {
      const bot = (req as any).bot;
      const cmd = parseCommand(`!remove ${req.params.index}`, "!")!;
      const response = await bot.executeCommand(cmd);
      res.json({ message: response });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/:botId/playlist", async (req, res) => {
    try {
      const bot = (req as any).bot;
      const { playlistId, platform } = req.body;
      const flags = platform === "qq" ? "-q" : "";
      const cmd = parseCommand(
        `!playlist ${flags} ${playlistId}`.trim(),
        "!"
      )!;
      const response = await bot.executeCommand(cmd);
      res.json({ message: response });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/:botId/history", (req, res) => {
    // Will be wired when database access is available through bot
    res.json({ history: [] });
  });

  return router;
}
