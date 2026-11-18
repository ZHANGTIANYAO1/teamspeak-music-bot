import express from "express";
import pino from "pino";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type BotDatabase } from "../../data/database.js";
import { createPlayerRouter } from "./player.js";

describe("play history deletion", () => {
  let db: BotDatabase;
  let app: express.Express;
  let firstId: number;
  let secondId: number;

  beforeEach(() => {
    db = createDatabase(":memory:");
    for (const botId of ["first", "second"]) {
      db.addPlayHistory({ botId, songId: "song", songName: "Example", artist: "", album: "", coverUrl: "", platform: "netease" });
    }
    firstId = db.getPlayHistory("first", 1)[0].id;
    secondId = db.getPlayHistory("second", 1)[0].id;
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { id: "u", username: "member", role: "member", capabilities: new Set(["player.queue"]), bots: new Set(["first"]) };
      next();
    });
    const bots = { getBot: (id: string) => ({ id }) } as unknown as Parameters<typeof createPlayerRouter>[0];
    app.use("/player", createPlayerRouter(bots, pino({ level: "silent" }), db));
  });

  afterEach(() => db.close());

  it("rejects malformed and ambiguous selections without deleting a row", async () => {
    await request(app).delete(`/player/first/history/${firstId}x`).expect(400);
    await request(app).delete("/player/first/history").send({ ids: [firstId, "bad"] }).expect(400);
    await request(app).delete("/player/first/history").send({ all: true, ids: [firstId] }).expect(400);
    expect(db.getPlayHistory("first", 10)).toHaveLength(1);
  });

  it("keeps song IDs compatible and scopes deletion to the authorized bot", async () => {
    const response = await request(app).get("/player/first/history").expect(200);
    expect(response.body.history[0]).toMatchObject({ id: "song", rowId: firstId });
    await request(app).delete("/player/second/history").send({ all: true }).expect(403);
    await request(app).delete("/player/first/history").send({ ids: [firstId, firstId, secondId] }).expect(200, { deleted: 1 });
    expect(db.getPlayHistory("second", 10)).toHaveLength(1);
  });
});
