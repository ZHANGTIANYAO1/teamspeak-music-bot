import { Router } from "express";
import type { BotDatabase } from "../../data/database.js";
import { SHARED_QUEUE_OWNER } from "../../data/database.js";
import type { BotManager } from "../../bot/manager.js";
import type { Logger } from "../../logger.js";

/**
 * The /api/saved-queues router (Feature 1, #119). Named save/load of queues,
 * per-user with a reserved shared bucket. Every route is inert (403) unless
 * savedQueuesEnabled is on, so the feature is fully gated behind the admin flag.
 *
 * Ownership model:
 *  - WebUI save with `shared:true` → SHARED_QUEUE_OWNER; otherwise the caller's
 *    own user id (private to them).
 *  - list returns the caller's own queues + shared ones.
 *  - load/delete are allowed only for the caller's own queues or shared ones;
 *    another user's private queue 404s (no existence leak, matching favorites).
 */
export function createSavedQueuesRouter(
  database: BotDatabase,
  botManager: BotManager,
  isEnabled: () => boolean,
  logger: Logger,
): Router {
  const router = Router();

  // Feature gate — inert (403) when savedQueuesEnabled is false.
  router.use((_req, res, next) => {
    if (!isEnabled()) {
      res.status(403).json({ error: "此功能未启用" });
      return;
    }
    next();
  });

  // GET / — the caller's own + shared saved queues (meta only, no songs blob).
  router.get("/", (req, res) => {
    const userId = req.user!.id;
    res.json({ queues: database.listSavedQueues(userId, true) });
  });

  // POST / — snapshot a bot's CURRENT queue and upsert it.
  // body: { botId, name, shared? }
  router.post("/", (req, res) => {
    const userId = req.user!.id;
    const { botId, name, shared } = req.body ?? {};
    if (typeof name !== "string" || !name.trim() || typeof botId !== "string" || !botId) {
      res.status(400).json({ error: "botId and name are required" });
      return;
    }
    const bot = botManager.getBot(botId);
    if (!bot) {
      res.status(404).json({ error: "bot not found" });
      return;
    }
    const songs = bot.getQueueManager().list();
    if (songs.length === 0) {
      res.status(400).json({ error: "队列为空，无法保存" });
      return;
    }
    const ownerId = shared === true ? SHARED_QUEUE_OWNER : userId;
    try {
      const saved = database.saveQueue(ownerId, name.trim(), songs);
      logger.info({ userId, ownerId, name: saved.name, count: saved.songCount }, "saved queue upserted");
      res.json({
        queue: {
          id: saved.id,
          ownerId: saved.ownerId,
          name: saved.name,
          songCount: saved.songCount,
        },
      });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // POST /:id/load — load a saved queue into a bot. body: { botId, mode }
  router.post("/:id/load", async (req, res) => {
    const userId = req.user!.id;
    const username = req.user!.username;
    const id = parseInt(req.params.id, 10);
    const { botId, mode } = req.body ?? {};
    if (Number.isNaN(id) || typeof botId !== "string" || !botId) {
      res.status(400).json({ error: "invalid id/botId" });
      return;
    }
    const sq = database.getSavedQueue(id);
    if (!sq || (sq.ownerId !== userId && sq.ownerId !== SHARED_QUEUE_OWNER)) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const bot = botManager.getBot(botId);
    if (!bot) {
      res.status(404).json({ error: "bot not found" });
      return;
    }
    const loadMode = mode === "append" ? "append" : "replace";
    await bot.loadSavedQueue(sq.songs, loadMode, username || "游客");
    res.json({ ok: true, loaded: sq.songs.length, mode: loadMode });
  });

  // DELETE /:id — delete a saved queue (own or shared only).
  router.delete("/:id", (req, res) => {
    const userId = req.user!.id;
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ error: "invalid id" });
      return;
    }
    const sq = database.getSavedQueue(id);
    if (!sq || (sq.ownerId !== userId && sq.ownerId !== SHARED_QUEUE_OWNER)) {
      res.status(404).json({ error: "not found" });
      return;
    }
    database.deleteSavedQueue(id);
    logger.info({ userId, id }, "saved queue deleted");
    res.json({ ok: true });
  });

  return router;
}
