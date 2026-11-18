import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import pino from "pino";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase, type BotDatabase } from "../../data/database.js";
import { createUserStore } from "../../data/users.js";
import { createSessionStore } from "../../data/sessions.js";
import { createAvatarStore } from "../../data/avatars.js";
import { createRequireAuth } from "../middleware/requireAuth.js";
import { createPermissionStore } from "../../data/permissions.js";
import { createBotRouter } from "./bot.js";
import {
  getDefaultConfig,
  type BotConfig,
  type JellyfinConfig,
  type VoiceDuckingConfig,
} from "../../data/config.js";
import { SESSION_COOKIE_NAME } from "../auth/validateSession.js";
import type { BotManager } from "../../bot/manager.js";

/** Records live settings updates so the tests can assert per-bot propagation. */
function makeFakeBot() {
  return {
    idleTimeoutCalls: [] as number[],
    autoPauseCalls: [] as boolean[],
    voiceDuckingCalls: [] as VoiceDuckingConfig[],
    updateIdleTimeout(minutes: number) {
      this.idleTimeoutCalls.push(minutes);
    },
    updateAutoPause(enabled: boolean) {
      this.autoPauseCalls.push(enabled);
    },
    updateVoiceDucking(settings: VoiceDuckingConfig) {
      this.voiceDuckingCalls.push({ ...settings });
    },
  };
}

describe("bot router /settings", () => {
  let botDb: BotDatabase;
  let app: express.Express;
  let cookie: string;
  let config: BotConfig;
  let configPath: string;
  let tmpDir: string;
  let fakeBots: ReturnType<typeof makeFakeBot>[];

  beforeEach(async () => {
    botDb = createDatabase(":memory:");
    const users = createUserStore(botDb.db);
    const sessions = createSessionStore(botDb.db);
    const alice = await users.createUser("alice", "pw-alice", "admin");
    cookie = `${SESSION_COOKIE_NAME}=${sessions.createSession(alice.id).token}`;

    tmpDir = mkdtempSync(join(tmpdir(), "botsettings-"));
    configPath = join(tmpDir, "config.json");
    config = { ...getDefaultConfig(), idleTimeoutMinutes: 15, autoPauseOnEmpty: true };

    fakeBots = [makeFakeBot(), makeFakeBot()];
    const fakeManager = {
      getAllBots: () => fakeBots,
    } as unknown as BotManager;
    const avatarStore = createAvatarStore(tmpDir);

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use("/api", createRequireAuth(sessions, createPermissionStore(botDb.db), () => getDefaultConfig().guestMode));
    app.use(
      "/api/bot",
      createBotRouter(fakeManager, config, configPath, pino({ level: "silent" }), botDb, avatarStore),
    );
  });

  afterEach(() => {
    botDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("requires auth", async () => {
    const res = await request(app).get("/api/bot/settings");
    expect(res.status).toBe(401);
  });

  it("GET /settings includes autoPauseOnEmpty reflecting config", async () => {
    const res = await request(app).get("/api/bot/settings").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.idleTimeoutMinutes).toBe(15);
    expect(res.body.autoPauseOnEmpty).toBe(true);
  });

  it("GET /settings includes voiceDucking with safe defaults", async () => {
    const res = await request(app).get("/api/bot/settings").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.voiceDucking).toEqual({ enabled: false, volumePercent: 30 });
  });

  it("POST /settings safely partial-merges, persists and hot-applies voiceDucking", async () => {
    const enable = await request(app)
      .post("/api/bot/settings")
      .set("Cookie", cookie)
      .send({ voiceDucking: { enabled: true } });
    expect(enable.status).toBe(200);
    expect(enable.body.voiceDucking).toEqual({ enabled: true, volumePercent: 30 });

    const setVolume = await request(app)
      .post("/api/bot/settings")
      .set("Cookie", cookie)
      .send({ voiceDucking: { volumePercent: 42.5 } });
    expect(setVolume.status).toBe(200);
    expect(config.voiceDucking).toEqual({ enabled: true, volumePercent: 42.5 });

    for (const bot of fakeBots) {
      expect(bot.voiceDuckingCalls).toEqual([
        { enabled: true, volumePercent: 30 },
        { enabled: true, volumePercent: 42.5 },
      ]);
    }

    const persisted = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(persisted.voiceDucking).toEqual({ enabled: true, volumePercent: 42.5 });
    const followUp = await request(app).get("/api/bot/settings").set("Cookie", cookie);
    expect(followUp.body.voiceDucking).toEqual({ enabled: true, volumePercent: 42.5 });
  });

  it("POST /settings ignores malformed voiceDucking fields and non-object blocks", async () => {
    config.voiceDucking = { enabled: true, volumePercent: 25 };
    const invalidFields = await request(app)
      .post("/api/bot/settings")
      .set("Cookie", cookie)
      .send({ voiceDucking: { enabled: "yes", volumePercent: 101 } });
    expect(invalidFields.status).toBe(200);
    expect(config.voiceDucking).toEqual({ enabled: true, volumePercent: 25 });

    const arrayBlock = await request(app)
      .post("/api/bot/settings")
      .set("Cookie", cookie)
      .send({ voiceDucking: [{ enabled: false, volumePercent: 0 }] });
    expect(arrayBlock.status).toBe(200);
    expect(config.voiceDucking).toEqual({ enabled: true, volumePercent: 25 });
    for (const bot of fakeBots) {
      expect(bot.voiceDuckingCalls).toEqual([{ enabled: true, volumePercent: 25 }]);
    }
  });

  it("POST /settings with autoPauseOnEmpty:false persists and propagates to bots", async () => {
    const res = await request(app)
      .post("/api/bot/settings")
      .set("Cookie", cookie)
      .send({ autoPauseOnEmpty: false });
    expect(res.status).toBe(200);

    // in-memory config mutated
    expect(config.autoPauseOnEmpty).toBe(false);

    // propagated to every live bot
    for (const bot of fakeBots) {
      expect(bot.autoPauseCalls).toEqual([false]);
    }

    // follow-up GET reflects the new value
    const followUp = await request(app).get("/api/bot/settings").set("Cookie", cookie);
    expect(followUp.body.autoPauseOnEmpty).toBe(false);
  });

  it("POST /settings still handles idleTimeoutMinutes (no regression)", async () => {
    const res = await request(app)
      .post("/api/bot/settings")
      .set("Cookie", cookie)
      .send({ idleTimeoutMinutes: 42 });
    expect(res.status).toBe(200);
    expect(config.idleTimeoutMinutes).toBe(42);
    for (const bot of fakeBots) {
      expect(bot.idleTimeoutCalls).toEqual([42]);
    }
    const followUp = await request(app).get("/api/bot/settings").set("Cookie", cookie);
    expect(followUp.body.idleTimeoutMinutes).toBe(42);
  });

  it("POST /settings handles both fields together", async () => {
    const res = await request(app)
      .post("/api/bot/settings")
      .set("Cookie", cookie)
      .send({ idleTimeoutMinutes: 7, autoPauseOnEmpty: false });
    expect(res.status).toBe(200);
    expect(config.idleTimeoutMinutes).toBe(7);
    expect(config.autoPauseOnEmpty).toBe(false);
    for (const bot of fakeBots) {
      expect(bot.idleTimeoutCalls).toEqual([7]);
      expect(bot.autoPauseCalls).toEqual([false]);
    }
  });

  it("POST /settings with only autoPauseOnEmpty does not touch idleTimeout bots", async () => {
    const res = await request(app)
      .post("/api/bot/settings")
      .set("Cookie", cookie)
      .send({ autoPauseOnEmpty: false });
    expect(res.status).toBe(200);
    for (const bot of fakeBots) {
      expect(bot.idleTimeoutCalls).toEqual([]);
      expect(bot.autoPauseCalls).toEqual([false]);
    }
  });

  it("POST /settings ignores non-boolean autoPauseOnEmpty without 400", async () => {
    const res = await request(app)
      .post("/api/bot/settings")
      .set("Cookie", cookie)
      .send({ idleTimeoutMinutes: 5, autoPauseOnEmpty: "yes" });
    expect(res.status).toBe(200);
    // idleTimeout still applied
    expect(config.idleTimeoutMinutes).toBe(5);
    // autoPause left at its prior value, not propagated
    expect(config.autoPauseOnEmpty).toBe(true);
    for (const bot of fakeBots) {
      expect(bot.autoPauseCalls).toEqual([]);
    }
  });

  it("GET /settings includes adminGroups reflecting config", async () => {
    config.adminGroups = [6, 8];
    const res = await request(app).get("/api/bot/settings").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.adminGroups).toEqual([6, 8]);
  });

  it("POST /settings persists a validated adminGroups and GET returns it", async () => {
    const res = await request(app)
      .post("/api/bot/settings")
      .set("Cookie", cookie)
      .send({ adminGroups: [6, 8] });
    expect(res.status).toBe(200);
    expect(res.body.adminGroups).toEqual([6, 8]);
    expect(config.adminGroups).toEqual([6, 8]);
    const followUp = await request(app).get("/api/bot/settings").set("Cookie", cookie);
    expect(followUp.body.adminGroups).toEqual([6, 8]);
  });

  it("POST /settings filters invalid adminGroups entries (negative, non-integer, non-number)", async () => {
    const res = await request(app)
      .post("/api/bot/settings")
      .set("Cookie", cookie)
      .send({ adminGroups: [6, -1, 2.5, "x", 8] });
    expect(res.status).toBe(200);
    expect(config.adminGroups).toEqual([6, 8]);
  });

  it("POST /settings ignores a non-array adminGroups (leaves config unchanged)", async () => {
    config.adminGroups = [6];
    const res = await request(app)
      .post("/api/bot/settings")
      .set("Cookie", cookie)
      .send({ adminGroups: "6" });
    expect(res.status).toBe(200);
    expect(config.adminGroups).toEqual([6]);
  });

  it("GET /settings includes a masked spotify block (hasClientSecret, never a raw secret)", async () => {
    config.spotify.enabled = true;
    config.spotify.backend = "librespot";
    config.spotify.clientId = "cid-1";
    config.spotify.deviceName = "MyDevice";
    config.spotify.bitrate = 160;
    config.spotify.clientSecret = "supersecret";

    const withSecret = await request(app).get("/api/bot/settings").set("Cookie", cookie);
    expect(withSecret.status).toBe(200);
    expect(withSecret.body.spotify).toEqual({
      enabled: true,
      backend: "librespot",
      clientId: "cid-1",
      deviceName: "MyDevice",
      bitrate: 160,
      hasClientSecret: true,
    });
    // The raw secret is never serialized to the client.
    expect(withSecret.body.spotify).not.toHaveProperty("clientSecret");

    config.spotify.clientSecret = "";
    const noSecret = await request(app).get("/api/bot/settings").set("Cookie", cookie);
    expect(noSecret.body.spotify.hasClientSecret).toBe(false);
    expect(noSecret.body.spotify).not.toHaveProperty("clientSecret");
  });

  it("POST /settings updates the spotify block, echoes the masked view, and persists", async () => {
    const res = await request(app)
      .post("/api/bot/settings")
      .set("Cookie", cookie)
      .send({ spotify: { enabled: true, backend: "librespot", clientId: "cid", deviceName: "Dev", bitrate: 160 } });
    expect(res.status).toBe(200);
    expect(config.spotify.enabled).toBe(true);
    expect(config.spotify.backend).toBe("librespot");
    expect(config.spotify.clientId).toBe("cid");
    expect(config.spotify.deviceName).toBe("Dev");
    expect(config.spotify.bitrate).toBe(160);

    expect(res.body.spotify).toEqual({
      enabled: true,
      backend: "librespot",
      clientId: "cid",
      deviceName: "Dev",
      bitrate: 160,
      hasClientSecret: false,
    });
    expect(res.body.spotify).not.toHaveProperty("clientSecret");

    // saveConfig persisted the block to disk.
    expect(existsSync(configPath)).toBe(true);
    const persisted = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(persisted.spotify.clientId).toBe("cid");
    expect(persisted.spotify.backend).toBe("librespot");
  });

  it("POST /settings ignores an invalid spotify backend/bitrate (partial-merge, no 400)", async () => {
    config.spotify.backend = "auto";
    config.spotify.bitrate = 320;
    const res = await request(app)
      .post("/api/bot/settings")
      .set("Cookie", cookie)
      .send({ spotify: { backend: "bogus", bitrate: 999 } });
    expect(res.status).toBe(200);
    expect(config.spotify.backend).toBe("auto");
    expect(config.spotify.bitrate).toBe(320);
  });

  it("POST /settings sets a non-empty clientSecret but a blank one never wipes it", async () => {
    const set = await request(app)
      .post("/api/bot/settings")
      .set("Cookie", cookie)
      .send({ spotify: { clientSecret: "newsecret" } });
    expect(set.status).toBe(200);
    expect(config.spotify.clientSecret).toBe("newsecret");
    expect(set.body.spotify.hasClientSecret).toBe(true);
    expect(set.body.spotify).not.toHaveProperty("clientSecret");

    const blank = await request(app)
      .post("/api/bot/settings")
      .set("Cookie", cookie)
      .send({ spotify: { clientSecret: "" } });
    expect(blank.status).toBe(200);
    expect(config.spotify.clientSecret).toBe("newsecret");
    expect(blank.body.spotify.hasClientSecret).toBe(true);
  });

  it("POST /settings ignores a blank/whitespace deviceName but stores a trimmed non-empty one", async () => {
    config.spotify.deviceName = "OldDevice";

    // Empty string leaves the prior deviceName untouched.
    const empty = await request(app)
      .post("/api/bot/settings")
      .set("Cookie", cookie)
      .send({ spotify: { deviceName: "" } });
    expect(empty.status).toBe(200);
    expect(config.spotify.deviceName).toBe("OldDevice");
    expect(empty.body.spotify.deviceName).toBe("OldDevice");

    // Whitespace-only is likewise ignored (trim().length === 0).
    const ws = await request(app)
      .post("/api/bot/settings")
      .set("Cookie", cookie)
      .send({ spotify: { deviceName: "   " } });
    expect(ws.status).toBe(200);
    expect(config.spotify.deviceName).toBe("OldDevice");

    // A non-empty value is stored TRIMMED.
    const set = await request(app)
      .post("/api/bot/settings")
      .set("Cookie", cookie)
      .send({ spotify: { deviceName: "  Dev  " } });
    expect(set.status).toBe(200);
    expect(config.spotify.deviceName).toBe("Dev");
    expect(set.body.spotify.deviceName).toBe("Dev");
  });

  it("POST /settings that omits spotify leaves config.spotify untouched (no regression)", async () => {
    config.spotify.clientId = "keep-me";
    config.spotify.clientSecret = "keep-secret";
    const before = { ...config.spotify };
    const res = await request(app)
      .post("/api/bot/settings")
      .set("Cookie", cookie)
      .send({ autoPauseOnEmpty: false });
    expect(res.status).toBe(200);
    expect(config.spotify).toEqual(before);
  });

  it("GET /settings echoes savedQueuesEnabled + playKeepsQueue (default false)", async () => {
    const res = await request(app).get("/api/bot/settings").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.savedQueuesEnabled).toBe(false);
    expect(res.body.playKeepsQueue).toBe(false);
  });

  it("POST /settings persists savedQueuesEnabled and playKeepsQueue", async () => {
    const res = await request(app)
      .post("/api/bot/settings")
      .set("Cookie", cookie)
      .send({ savedQueuesEnabled: true, playKeepsQueue: true });
    expect(res.status).toBe(200);
    expect(res.body.savedQueuesEnabled).toBe(true);
    expect(res.body.playKeepsQueue).toBe(true);
    expect(config.savedQueuesEnabled).toBe(true);
    expect(config.playKeepsQueue).toBe(true);

    const get = await request(app).get("/api/bot/settings").set("Cookie", cookie);
    expect(get.body.savedQueuesEnabled).toBe(true);
    expect(get.body.playKeepsQueue).toBe(true);
  });

  it("POST /settings ignores non-boolean savedQueuesEnabled without 400", async () => {
    const res = await request(app)
      .post("/api/bot/settings")
      .set("Cookie", cookie)
      .send({ savedQueuesEnabled: "nope" });
    expect(res.status).toBe(200);
    expect(config.savedQueuesEnabled).toBe(false); // unchanged from default
  });
});

// Whole-branch I2: saving a Client ID in Settings must re-configure the single
// live SpotifyOAuth so the operator can Connect without a process restart.
describe("bot router /settings applies spotify creds to the live OAuth (I2)", () => {
  let botDb: BotDatabase;
  let app: express.Express;
  let cookie: string;
  let config: BotConfig;
  let configPath: string;
  let tmpDir: string;
  let configureCalls: Array<[string | undefined, string | undefined]>;

  beforeEach(async () => {
    botDb = createDatabase(":memory:");
    const users = createUserStore(botDb.db);
    const sessions = createSessionStore(botDb.db);
    const alice = await users.createUser("alice", "pw-alice", "admin");
    cookie = `${SESSION_COOKIE_NAME}=${sessions.createSession(alice.id).token}`;

    tmpDir = mkdtempSync(join(tmpdir(), "botsettings-oauth-"));
    configPath = join(tmpDir, "config.json");
    config = getDefaultConfig(); // webPort defaults to 3000

    const fakeManager = { getAllBots: () => [] } as unknown as BotManager;
    const avatarStore = createAvatarStore(tmpDir);

    // Fake OAuth recording every configure(clientId, redirectUri) call.
    configureCalls = [];
    const fakeOAuth = {
      configure(clientId?: string, redirectUri?: string) {
        configureCalls.push([clientId, redirectUri]);
      },
    };

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use("/api", createRequireAuth(sessions, createPermissionStore(botDb.db), () => getDefaultConfig().guestMode));
    app.use(
      "/api/bot",
      createBotRouter(fakeManager, config, configPath, pino({ level: "silent" }), botDb, avatarStore, undefined, fakeOAuth),
    );
  });

  afterEach(() => {
    botDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("configures the live OAuth once with the derived callback redirectUri when a Client ID is saved", async () => {
    const res = await request(app)
      .post("/api/bot/settings")
      .set("Cookie", cookie)
      .send({ spotify: { clientId: "cid", enabled: true } });
    expect(res.status).toBe(200);
    expect(configureCalls).toEqual([
      ["cid", `http://127.0.0.1:${config.webPort}/api/spotify/callback`],
    ]);
  });

  it("does NOT touch the OAuth when the request has no spotify block", async () => {
    const res = await request(app)
      .post("/api/bot/settings")
      .set("Cookie", cookie)
      .send({ autoPauseOnEmpty: false });
    expect(res.status).toBe(200);
    expect(configureCalls).toEqual([]);
  });

  it("configures with ('', undefined) when a spotify block clears the Client ID (disables OAuth)", async () => {
    const res = await request(app)
      .post("/api/bot/settings")
      .set("Cookie", cookie)
      .send({ spotify: { clientId: "" } });
    expect(res.status).toBe(200);
    expect(configureCalls).toEqual([["", undefined]]);
  });
});

// R2-4: saving Spotify creds in Settings must also refresh the Web API SEARCH
// provider (spotifyProvider.setCreds), not only the OAuth playback path. Without
// this, a fresh install (enabled defaults false) keeps empty search creds until a
// full process restart even after an admin enters Client ID + Secret.
describe("bot router /settings refreshes the Web API search provider creds (R2-4)", () => {
  let botDb: BotDatabase;
  let app: express.Express;
  let cookie: string;
  let config: BotConfig;
  let configPath: string;
  let tmpDir: string;
  let setCredsCalls: Array<[string, string]>;
  let configureCalls: Array<[string | undefined, string | undefined]>;

  beforeEach(async () => {
    botDb = createDatabase(":memory:");
    const users = createUserStore(botDb.db);
    const sessions = createSessionStore(botDb.db);
    const alice = await users.createUser("alice", "pw-alice", "admin");
    cookie = `${SESSION_COOKIE_NAME}=${sessions.createSession(alice.id).token}`;

    tmpDir = mkdtempSync(join(tmpdir(), "botsettings-provider-"));
    configPath = join(tmpDir, "config.json");
    config = getDefaultConfig();

    const fakeManager = { getAllBots: () => [] } as unknown as BotManager;
    const avatarStore = createAvatarStore(tmpDir);

    // Fake search provider recording every setCreds(clientId, clientSecret) call.
    setCredsCalls = [];
    const fakeProvider = {
      setCreds(clientId: string, clientSecret: string) {
        setCredsCalls.push([clientId, clientSecret]);
      },
    };
    // Fake OAuth so we can assert the playback path is still wired alongside.
    configureCalls = [];
    const fakeOAuth = {
      configure(clientId?: string, redirectUri?: string) {
        configureCalls.push([clientId, redirectUri]);
      },
    };

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use("/api", createRequireAuth(sessions, createPermissionStore(botDb.db), () => getDefaultConfig().guestMode));
    app.use(
      "/api/bot",
      createBotRouter(fakeManager, config, configPath, pino({ level: "silent" }), botDb, avatarStore, undefined, fakeOAuth, fakeProvider),
    );
  });

  afterEach(() => {
    botDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("calls setCreds once with (clientId, clientSecret) when a spotify block is saved (and OAuth is still configured)", async () => {
    const res = await request(app)
      .post("/api/bot/settings")
      .set("Cookie", cookie)
      .send({ spotify: { clientId: "cid", clientSecret: "sec", enabled: true } });
    expect(res.status).toBe(200);
    expect(setCredsCalls).toEqual([["cid", "sec"]]);
    // The OAuth playback path is still wired on the same save.
    expect(configureCalls.length).toBe(1);
  });

  it("does NOT call setCreds when the request has no spotify block", async () => {
    const res = await request(app)
      .post("/api/bot/settings")
      .set("Cookie", cookie)
      .send({ autoPauseOnEmpty: false });
    expect(res.status).toBe(200);
    expect(setCredsCalls).toEqual([]);
  });

  it("calls setCreds with the PRESERVED stored secret when the spotify block omits/blanks clientSecret", async () => {
    config.spotify.clientId = "cid0";
    config.spotify.clientSecret = "stored-secret";
    const res = await request(app)
      .post("/api/bot/settings")
      .set("Cookie", cookie)
      .send({ spotify: { clientId: "cid0", clientSecret: "", enabled: true } });
    expect(res.status).toBe(200);
    // Post-merge values: masked/blank secret must keep the stored one, never "".
    expect(setCredsCalls).toEqual([["cid0", "stored-secret"]]);
  });
});

describe("bot router /settings guest-mode gating + persistence", () => {
  let tmpDir: string;
  let configPath: string;
  let config: BotConfig;
  let botDb: BotDatabase;

  beforeEach(() => {
    botDb = createDatabase(":memory:");
    tmpDir = mkdtempSync(join(tmpdir(), "botsettings-gm-"));
    configPath = join(tmpDir, "config.json");
    config = getDefaultConfig();
  });

  afterEach(() => {
    botDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Mounts createBotRouter with an injected req.user (no session/cookie). */
  function mountBot(injectUser: () => unknown): express.Express {
    const fakeManager = { getAllBots: () => [] } as unknown as BotManager;
    const avatarStore = createAvatarStore(tmpDir);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as { user?: unknown }).user = injectUser(); next(); });
    app.use(
      "/api/bot",
      createBotRouter(fakeManager, config, configPath, pino({ level: "silent" }), botDb, avatarStore),
    );
    return app;
  }

  it("GET /settings is 403 for guests and includes guestMode for admins", async () => {
    const guestApp = mountBot(() => ({ role: "guest", guest: {} }));
    expect((await request(guestApp).get("/api/bot/settings")).status).toBe(403);
    const adminApp = mountBot(() => ({ role: "admin" }));
    const res = await request(adminApp).get("/api/bot/settings");
    expect(res.status).toBe(200);
    expect(res.body.guestMode).toBeDefined();
    expect(res.body.guestMode.enabled).toBe(false);
  });

  it("POST /settings persists a guestMode block", async () => {
    const adminApp = mountBot(() => ({ role: "admin" }));
    const res = await request(adminApp).post("/api/bot/settings").send({
      guestMode: { enabled: true, bots: ["bot1"], permissions: { playNext: true } },
    });
    expect(res.status).toBe(200);
    expect(res.body.guestMode.enabled).toBe(true);
    expect(res.body.guestMode.bots).toEqual(["bot1"]);
    expect(res.body.guestMode.permissions.playNext).toBe(true);
    expect(res.body.guestMode.permissions.addToQueue).toBe(true); // untouched default
  });

  it("POST /settings spotify write is 403 for a member lacking bot.manage", async () => {
    const memberApp = mountBot(() => ({ role: "member", capabilities: new Set([]) }));
    const res = await request(memberApp)
      .post("/api/bot/settings")
      .send({ spotify: { enabled: true, clientId: "cid" } });
    expect(res.status).toBe(403);
    // Gate rejected before any mutation.
    expect(config.spotify.enabled).toBe(false);
    expect(config.spotify.clientId).toBe("");
  });
});

describe("bot router /settings jellyfin block + enabledProviders", () => {
  let tmpDir: string;
  let configPath: string;
  let config: BotConfig;
  let botDb: BotDatabase;
  let configureCalls: JellyfinConfig[];

  beforeEach(() => {
    botDb = createDatabase(":memory:");
    tmpDir = mkdtempSync(join(tmpdir(), "botsettings-jf-"));
    configPath = join(tmpDir, "config.json");
    config = getDefaultConfig();
    configureCalls = [];
  });

  afterEach(() => {
    botDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function mountBot(): express.Express {
    const fakeManager = { getAllBots: () => [] } as unknown as BotManager;
    const avatarStore = createAvatarStore(tmpDir);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as { user?: unknown }).user = { role: "admin" }; next(); });
    app.use(
      "/api/bot",
      createBotRouter(
        fakeManager, config, configPath, pino({ level: "silent" }), botDb, avatarStore,
        undefined, undefined, undefined,
        { configure: (cfg: JellyfinConfig) => configureCalls.push({ ...cfg }) },
      ),
    );
    return app;
  }

  it("GET /settings exposes a masked jellyfin block (no password/apiKey echo)", async () => {
    config.jellyfin.serverUrl = "https://jf.example.com";
    config.jellyfin.password = "secret";
    const res = await request(mountBot()).get("/api/bot/settings");
    expect(res.status).toBe(200);
    expect(res.body.jellyfin).toEqual({
      serverUrl: "https://jf.example.com",
      authMode: "userpass",
      username: "",
      userId: "",
      hasPassword: true,
      hasApiKey: false,
    });
    // Default: online sources on, jellyfin opt-in (not listed).
    expect(res.body.enabledProviders).toEqual(["netease", "qq", "bilibili", "youtube", "kugou"]);
  });

  it("POST /settings merges jellyfin, keeps stored secrets on blank, hot-configures", async () => {
    config.jellyfin.password = "stored-pw";
    const app = mountBot();
    const res = await request(app).post("/api/bot/settings").send({
      jellyfin: { serverUrl: "https://jf.example.com///", username: "bob", password: "" },
    });
    expect(res.status).toBe(200);
    // Trailing slashes normalized; blank password kept the stored one.
    expect(config.jellyfin.serverUrl).toBe("https://jf.example.com");
    expect(config.jellyfin.username).toBe("bob");
    expect(config.jellyfin.password).toBe("stored-pw");
    expect(res.body.jellyfin.hasPassword).toBe(true);
    // Live provider re-configured with the post-merge values.
    expect(configureCalls).toHaveLength(1);
    expect(configureCalls[0].serverUrl).toBe("https://jf.example.com");
    expect(configureCalls[0].password).toBe("stored-pw");
    // Persisted to disk.
    const onDisk = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(onDisk.jellyfin.username).toBe("bob");
  });

  it("POST /settings filters enabledProviders to known providers", async () => {
    const res = await request(mountBot()).post("/api/bot/settings").send({
      enabledProviders: ["jellyfin", "netease", "bogus", 42],
    });
    expect(res.status).toBe(200);
    expect(res.body.enabledProviders).toEqual(["jellyfin", "netease"]);
    expect(config.enabledProviders).toEqual(["jellyfin", "netease"]);
    // No jellyfin block in the request → no reconfigure call.
    expect(configureCalls).toHaveLength(0);
  });

  // --- #126: operator-chosen default source ---

  it("GET /settings exposes defaultPlatform (null by default)", async () => {
    const res = await request(mountBot()).get("/api/bot/settings");
    expect(res.status).toBe(200);
    expect(res.body.defaultPlatform).toBeNull();
  });

  it("POST /settings sets an enabled defaultPlatform and persists it", async () => {
    const res = await request(mountBot()).post("/api/bot/settings").send({
      defaultPlatform: "bilibili",
    });
    expect(res.status).toBe(200);
    expect(res.body.defaultPlatform).toBe("bilibili");
    expect(config.defaultPlatform).toBe("bilibili");
    const onDisk = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(onDisk.defaultPlatform).toBe("bilibili");
  });

  it("POST /settings ignores an unknown or disabled defaultPlatform", async () => {
    const app = mountBot();
    // jellyfin is opt-in and not enabled in the default config → rejected.
    await request(app).post("/api/bot/settings").send({ defaultPlatform: "jellyfin" });
    expect(config.defaultPlatform).toBeNull();
    // Unknown value → rejected.
    await request(app).post("/api/bot/settings").send({ defaultPlatform: "bogus" });
    expect(config.defaultPlatform).toBeNull();
  });

  it("POST /settings clears defaultPlatform with null", async () => {
    const app = mountBot();
    await request(app).post("/api/bot/settings").send({ defaultPlatform: "qq" });
    expect(config.defaultPlatform).toBe("qq");
    const res = await request(app).post("/api/bot/settings").send({ defaultPlatform: null });
    expect(res.body.defaultPlatform).toBeNull();
    expect(config.defaultPlatform).toBeNull();
  });

  it("POST /settings drops a default whose source gets disabled in the same request", async () => {
    const app = mountBot();
    await request(app).post("/api/bot/settings").send({ defaultPlatform: "qq" });
    expect(config.defaultPlatform).toBe("qq");
    // Disabling qq via enabledProviders clears the now-invalid default.
    const res = await request(app).post("/api/bot/settings").send({
      enabledProviders: ["netease", "bilibili"],
    });
    expect(res.body.defaultPlatform).toBeNull();
    expect(config.defaultPlatform).toBeNull();
  });
});
