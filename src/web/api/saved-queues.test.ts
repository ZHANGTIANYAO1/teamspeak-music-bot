import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import pino from "pino";
import { createDatabase, SHARED_QUEUE_OWNER, type BotDatabase } from "../../data/database.js";
import type { BotManager } from "../../bot/manager.js";
import { createSavedQueuesRouter } from "./saved-queues.js";

const song = (id: string) => ({
  id,
  name: id,
  artist: "",
  album: "",
  platform: "netease" as const,
  coverUrl: "",
  duration: 1,
});

function mount(enabled: boolean, opts: { queue?: unknown[] } = {}) {
  const db = createDatabase(":memory:");
  const loads: Array<{ songs: unknown[]; mode: string; by?: string }> = [];
  const bot = {
    getQueueManager: () => ({ list: () => opts.queue ?? [song("a"), song("b")] }),
    loadSavedQueue: async (songs: unknown[], mode: string, by?: string) => {
      loads.push({ songs, mode, by });
    },
  };
  const botManager = { getBot: (_id: string) => bot } as unknown as BotManager;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: unknown }).user = { id: "u1", username: "alice", role: "member" };
    next();
  });
  app.use(
    "/api/saved-queues",
    createSavedQueuesRouter(db, botManager, () => enabled, pino({ level: "silent" })),
  );
  return { app, db, loads };
}

describe("saved-queues router", () => {
  it("403s every route when the feature is disabled", async () => {
    const { app } = mount(false);
    expect((await request(app).get("/api/saved-queues")).status).toBe(403);
    expect((await request(app).post("/api/saved-queues").send({ botId: "b", name: "x" })).status).toBe(403);
    expect((await request(app).post("/api/saved-queues/1/load").send({ botId: "b" })).status).toBe(403);
    expect((await request(app).delete("/api/saved-queues/1")).status).toBe(403);
  });

  it("saves the current queue (private) and lists it back", async () => {
    const { app } = mount(true);
    const save = await request(app).post("/api/saved-queues").send({ botId: "b", name: "night" });
    expect(save.status).toBe(200);
    expect(save.body.queue.name).toBe("night");
    expect(save.body.queue.songCount).toBe(2);
    expect(save.body.queue.ownerId).toBe("u1");

    const list = await request(app).get("/api/saved-queues");
    expect(list.status).toBe(200);
    expect(list.body.queues.map((q: { name: string }) => q.name)).toContain("night");
  });

  it("saves to the shared bucket when shared:true", async () => {
    const { app, db } = mount(true);
    const save = await request(app).post("/api/saved-queues").send({ botId: "b", name: "party", shared: true });
    expect(save.status).toBe(200);
    expect(save.body.queue.ownerId).toBe(SHARED_QUEUE_OWNER);
    expect(db.listSavedQueues(SHARED_QUEUE_OWNER, false).map((q) => q.name)).toEqual(["party"]);
  });

  it("rejects saving an empty queue", async () => {
    const { app } = mount(true, { queue: [] });
    const save = await request(app).post("/api/saved-queues").send({ botId: "b", name: "empty" });
    expect(save.status).toBe(400);
  });

  it("requires botId and name", async () => {
    const { app } = mount(true);
    expect((await request(app).post("/api/saved-queues").send({ name: "x" })).status).toBe(400);
    expect((await request(app).post("/api/saved-queues").send({ botId: "b" })).status).toBe(400);
  });

  it("loads a shared queue (replace by default) into the bot", async () => {
    const { app, db, loads } = mount(true);
    const saved = db.saveQueue(SHARED_QUEUE_OWNER, "party", [song("a"), song("b")]);
    const load = await request(app).post(`/api/saved-queues/${saved.id}/load`).send({ botId: "b" });
    expect(load.status).toBe(200);
    expect(load.body).toMatchObject({ ok: true, loaded: 2, mode: "replace" });
    expect(loads).toHaveLength(1);
    expect(loads[0].mode).toBe("replace");
    expect(loads[0].by).toBe("alice");
  });

  it("loads in append mode when requested", async () => {
    const { app, db, loads } = mount(true);
    const saved = db.saveQueue("u1", "mine", [song("a")]);
    const load = await request(app).post(`/api/saved-queues/${saved.id}/load`).send({ botId: "b", mode: "append" });
    expect(load.status).toBe(200);
    expect(loads[0].mode).toBe("append");
  });

  it("404s loading another user's private queue (no existence leak)", async () => {
    const { app, db } = mount(true);
    db.saveQueue("someoneElse", "private", [song("z")]);
    const other = db.listSavedQueues("someoneElse", false)[0];
    const load = await request(app).post(`/api/saved-queues/${other.id}/load`).send({ botId: "b", mode: "replace" });
    expect(load.status).toBe(404);
  });

  it("deletes an own queue but 404s another user's private one", async () => {
    const { app, db } = mount(true);
    const mine = db.saveQueue("u1", "mine", [song("a")]);
    const theirs = db.saveQueue("someoneElse", "private", [song("z")]);
    expect((await request(app).delete(`/api/saved-queues/${theirs.id}`)).status).toBe(404);
    expect((await request(app).delete(`/api/saved-queues/${mine.id}`)).status).toBe(200);
    expect(db.getSavedQueue(mine.id)).toBeNull();
  });
});
