import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDatabase, SHARED_QUEUE_OWNER, type BotDatabase, type BotInstance, type PlayHistoryEntry } from "./database.js";
import { createUserStore, GUEST_USER_ID } from "./users.js";

describe("database", () => {
  let botDb: BotDatabase;

  beforeEach(() => {
    botDb = createDatabase(":memory:");
  });

  afterEach(() => {
    botDb.close();
  });

  it("creates tables on init", () => {
    const tables = botDb.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
      )
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain("play_history");
    expect(names).toContain("bot_instances");
  });

  it("creates users and sessions tables on init", () => {
    const tables = botDb.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain("users");
    expect(names).toContain("sessions");

    const userCols = botDb.db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
    const userColNames = userCols.map((c) => c.name).sort();
    expect(userColNames).toEqual(["createdAt", "id", "passwordHash", "role", "updatedAt", "username"]);

    const sessionCols = botDb.db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
    const sessionColNames = sessionCols.map((c) => c.name).sort();
    expect(sessionColNames).toEqual(["createdAt", "expiresAt", "id", "lastSeenAt", "userId"]);
  });

  it("creates user_audit table on init", () => {
    const tables = botDb.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toContain("user_audit");
  });

  it("records and retrieves play history", () => {
    botDb.addPlayHistory({
      botId: "bot1",
      songId: "song1",
      songName: "Test Song",
      artist: "Test Artist",
      album: "Test Album",
      platform: "netease",
      coverUrl: "https://example.com/cover.jpg",
      requestedBy: "alice",
    });

    botDb.addPlayHistory({
      botId: "bot1",
      songId: "song2",
      songName: "Another Song",
      artist: "Another Artist",
      album: "Another Album",
      platform: "qq",
      coverUrl: "https://example.com/cover2.jpg",
    });

    const history = botDb.getPlayHistory("bot1", 10);
    expect(history).toHaveLength(2);
    expect(history[0].songName).toBe("Another Song");
    expect(history[1].songName).toBe("Test Song");
    expect(history[1].requestedBy).toBe("alice");
  });

  it("saves and loads bot instances", () => {
    const instance: BotInstance = {
      id: "bot1",
      name: "Music Bot",
      serverAddress: "localhost",
      serverPort: 9987,
      nickname: "MusicBot",
      defaultChannel: "Music",
      channelId: "",
      channelPassword: "",
      autoStart: true,
      serverProtocol: "",
      ts6ApiKey: "",
      serverPassword: "",
    };

    botDb.saveBotInstance(instance);
    const instances = botDb.getBotInstances();
    expect(instances).toHaveLength(1);
    expect(instances[0]).toMatchObject(instance);
    expect(instances[0].autoStart).toBe(true);

    // Test upsert
    botDb.saveBotInstance({ ...instance, nickname: "UpdatedBot", autoStart: false });
    const updated = botDb.getBotInstances();
    expect(updated).toHaveLength(1);
    expect(updated[0].nickname).toBe("UpdatedBot");
    expect(updated[0].autoStart).toBe(false);
  });

  it("deletes bot instance", () => {
    botDb.saveBotInstance({
      id: "bot1",
      name: "Music Bot",
      serverAddress: "localhost",
      serverPort: 9987,
      nickname: "MusicBot",
      defaultChannel: "Music",
      channelId: "",
      channelPassword: "",
      autoStart: false,
      serverProtocol: "",
      ts6ApiKey: "",
      serverPassword: "",
    });

    expect(botDb.deleteBotInstance("bot1")).toBe(true);
    expect(botDb.getBotInstances()).toHaveLength(0);
    expect(botDb.deleteBotInstance("nonexistent")).toBe(false);
  });

  it("persists and clears customAvatarPath on a bot instance", () => {
    const inst = {
      id: "bot-1",
      name: "B",
      serverAddress: "x",
      serverPort: 9987,
      nickname: "n",
      defaultChannel: "",
      channelId: "",
      channelPassword: "",
      autoStart: false,
      serverProtocol: "",
      ts6ApiKey: "",
      serverPassword: "",
    };
    botDb.saveBotInstance(inst);
    expect(botDb.getCustomAvatarPath("bot-1")).toBeNull();
    botDb.setCustomAvatarPath("bot-1", "avatars/bot-1.png");
    expect(botDb.getCustomAvatarPath("bot-1")).toBe("avatars/bot-1.png");
    botDb.setCustomAvatarPath("bot-1", null);
    expect(botDb.getCustomAvatarPath("bot-1")).toBeNull();
  });

  const sq = (id: string) => ({
    id,
    name: id,
    artist: "",
    album: "",
    platform: "netease" as const,
    coverUrl: "",
    duration: 1,
  });

  describe("saved_queues", () => {
    it("upserts by (ownerId, name) and returns songs", () => {
      botDb.saveQueue("u1", "night", [sq("a"), sq("b")]);
      const again = botDb.saveQueue("u1", "night", [sq("c")]); // overwrite
      expect(again.songCount).toBe(1);
      expect(botDb.listSavedQueues("u1", false)).toHaveLength(1);
      const full = botDb.getSavedQueue(again.id)!;
      expect(full.songs.map((s) => s.id)).toEqual(["c"]);
    });

    it("strips url before persisting", () => {
      const saved = botDb.saveQueue("u1", "x", [
        { ...sq("a"), url: "http://example.com/a.mp3" } as never,
      ]);
      const full = botDb.getSavedQueue(saved.id)!;
      expect((full.songs[0] as { url?: string }).url).toBeUndefined();
    });

    it("lists own + shared when includeShared, own-only otherwise", () => {
      botDb.saveQueue("u1", "mine", [sq("a")]);
      botDb.saveQueue(SHARED_QUEUE_OWNER, "party", [sq("b")]);
      expect(botDb.listSavedQueues("u1", false).map((q) => q.name)).toEqual(["mine"]);
      expect(
        botDb.listSavedQueues("u1", true).map((q) => q.name).sort(),
      ).toEqual(["mine", "party"]);
    });

    it("caps songs at 1000 and queues at 50", () => {
      expect(() =>
        botDb.saveQueue("u1", "big", Array.from({ length: 1001 }, (_, i) => sq("s" + i))),
      ).toThrow(/1000/);
      for (let i = 0; i < 50; i++) botDb.saveQueue("u1", "q" + i, [sq("a")]);
      expect(() => botDb.saveQueue("u1", "q50", [sq("a")])).toThrow(/50/);
      // Overwriting an existing name is always allowed despite the cap.
      expect(() => botDb.saveQueue("u1", "q0", [sq("z")])).not.toThrow();
    });

    it("deletes and degrades a corrupt blob to empty", () => {
      const q = botDb.saveQueue("u1", "x", [sq("a")]);
      botDb.db.prepare("UPDATE saved_queues SET songs='not json' WHERE id=?").run(q.id);
      expect(botDb.getSavedQueue(q.id)!.songs).toEqual([]);
      expect(botDb.deleteSavedQueue(q.id)).toBe(true);
      expect(botDb.getSavedQueue(q.id)).toBeNull();
      expect(botDb.deleteSavedQueue(q.id)).toBe(false); // already gone
    });
  });

  describe("queue_state", () => {
    it("upserts, reads back, and clears per bot", () => {
      botDb.saveQueueState({ botId: "b1", songs: [sq("a")], currentIndex: 0, mode: "loop", isFmMode: true, fmPlatform: "netease" });
      botDb.saveQueueState({ botId: "b1", songs: [sq("a"), sq("b")], currentIndex: 1, mode: "seq", isFmMode: false, fmPlatform: "" });
      const st = botDb.getQueueState("b1")!;
      expect(st.songs.map((s) => s.id)).toEqual(["a", "b"]);
      expect(st.currentIndex).toBe(1);
      expect(st.mode).toBe("seq");
      expect(st.isFmMode).toBe(false);
      botDb.clearQueueState("b1");
      expect(botDb.getQueueState("b1")).toBeNull();
    });

    it("round-trips FM flags and degrades a corrupt blob", () => {
      botDb.saveQueueState({ botId: "b2", songs: [sq("a")], currentIndex: 0, mode: "random", isFmMode: true, fmPlatform: "qq" });
      const st = botDb.getQueueState("b2")!;
      expect(st.isFmMode).toBe(true);
      expect(st.fmPlatform).toBe("qq");
      botDb.db.prepare("UPDATE queue_state SET songs='{' WHERE botId=?").run("b2");
      expect(botDb.getQueueState("b2")!.songs).toEqual([]);
    });
  });
});

describe("guest principal migration", () => {
  it("creates exactly one reserved guest row, idempotently", () => {
    const dir = mkdtempSync(join(tmpdir(), "tsmb-db-"));
    const p = join(dir, "t.db");
    const a = createDatabase(p); a.db.close();
    const b = createDatabase(p); // run again — must not duplicate
    const row = b.db.prepare("SELECT id, role FROM users WHERE id = ?").get(GUEST_USER_ID) as { id: string; role: string } | undefined;
    expect(row?.role).toBe("guest");
    const n = (b.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='guest'").get() as { n: number }).n;
    expect(n).toBe(1);
    b.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("guest row does not break first-run detection (countUsers excludes it)", () => {
    const dir = mkdtempSync(join(tmpdir(), "tsmb-db2-"));
    const p = join(dir, "t.db");
    const d = createDatabase(p);
    const users = createUserStore(d.db);
    expect(users.countUsers()).toBe(0); // guest excluded → still needs setup
    d.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
