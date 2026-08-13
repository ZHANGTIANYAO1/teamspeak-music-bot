import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import pino from "pino";
import { createDatabase, type BotDatabase } from "../../data/database.js";
import { createUserStore, type UserStore } from "../../data/users.js";
import { createSessionStore, type SessionStore } from "../../data/sessions.js";
import { createAuditStore } from "../../data/audit.js";
import { createPermissionStore } from "../../data/permissions.js";
import { getDefaultConfig, type GuestModeConfig } from "../../data/config.js";
import type { GuestPermissions, BotAccess } from "../../data/permissions.js";
import { createSessionRouter } from "./session.js";
import { SESSION_COOKIE_NAME } from "../auth/validateSession.js";

function makeApp(botDb: BotDatabase, users: UserStore, sessions: SessionStore) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  const audit = createAuditStore(botDb.db);
  const permissions = createPermissionStore(botDb.db);
  app.use(
    "/api/session",
    createSessionRouter(
      users,
      sessions,
      audit,
      pino({ level: "silent" }),
      permissions,
      () => getDefaultConfig().guestMode
    )
  );
  return app;
}

function extractCookie(res: request.Response): string {
  const header = res.headers["set-cookie"];
  const arr = Array.isArray(header) ? header : header ? [header] : [];
  const found = arr.find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
  if (!found) throw new Error("no session cookie set");
  return found.split(";")[0]; // "tsmb_session=xxxx"
}

describe("session router", () => {
  let botDb: BotDatabase;
  let users: UserStore;
  let sessions: SessionStore;
  let app: express.Express;

  beforeEach(() => {
    botDb = createDatabase(":memory:");
    users = createUserStore(botDb.db);
    sessions = createSessionStore(botDb.db);
    app = makeApp(botDb, users, sessions);
  });

  afterEach(() => botDb.close());

  it("GET /needs-setup returns true on an empty db", async () => {
    const res = await request(app).get("/api/session/needs-setup");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ needsSetup: true, guestAllowed: false });
  });

  it("POST /setup creates the first admin, logs them in, and returns false from /needs-setup afterwards", async () => {
    const setupRes = await request(app)
      .post("/api/session/setup")
      .send({ username: "alice", password: "hunter2-hunter2" });
    expect(setupRes.status).toBe(200);
    expect(setupRes.body.username).toBe("alice");
    extractCookie(setupRes);

    const needs = await request(app).get("/api/session/needs-setup");
    expect(needs.body).toEqual({ needsSetup: false, guestAllowed: false });
  });

  it("POST /setup returns 409 once a user already exists", async () => {
    await users.createUser("admin", "pw-admin-pw", "admin");
    const res = await request(app)
      .post("/api/session/setup")
      .send({ username: "alice", password: "pw" });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "already initialized" });
  });

  it("POST /login returns 401 with constant-time delay on bad credentials", async () => {
    await users.createUser("alice", "correct-pw-pw", "admin");
    const start = Date.now();
    const res = await request(app)
      .post("/api/session/login")
      .send({ username: "alice", password: "wrong" });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "invalid credentials" });
    expect(Date.now() - start).toBeGreaterThanOrEqual(200);
  }, 10_000);

  it("POST /login sets a session cookie on success", async () => {
    await users.createUser("alice", "pw-alice", "admin");
    const res = await request(app)
      .post("/api/session/login")
      .send({ username: "alice", password: "pw-alice" });
    expect(res.status).toBe(200);
    expect(res.body.username).toBe("alice");
    extractCookie(res);
  });

  it("GET /me returns the current user when cookie is present, 401 otherwise", async () => {
    await users.createUser("alice", "pw-alice", "admin");
    const loginRes = await request(app)
      .post("/api/session/login")
      .send({ username: "alice", password: "pw-alice" });
    const cookie = extractCookie(loginRes);

    const me = await request(app).get("/api/session/me").set("Cookie", cookie);
    expect(me.status).toBe(200);
    expect(me.body.username).toBe("alice");
    // alice is the first user (an admin), so /me exposes all capabilities and full bot access.
    expect(Array.isArray(me.body.capabilities)).toBe(true);
    expect(me.body.capabilities).toEqual(
      expect.arrayContaining(["player.control", "player.queue", "bot.manage", "platform.auth", "quality"])
    );
    expect(me.body.bots).toBe("all");

    const anon = await request(app).get("/api/session/me");
    expect(anon.status).toBe(401);
  });

  it("POST /logout deletes the session and clears the cookie", async () => {
    await users.createUser("alice", "pw-alice", "admin");
    const loginRes = await request(app)
      .post("/api/session/login")
      .send({ username: "alice", password: "pw-alice" });
    const cookie = extractCookie(loginRes);

    const logout = await request(app).post("/api/session/logout").set("Cookie", cookie);
    expect(logout.status).toBe(204);

    const me = await request(app).get("/api/session/me").set("Cookie", cookie);
    expect(me.status).toBe(401);
  });

  it("POST /change-password requires old password and invalidates other sessions", async () => {
    const u = await users.createUser("alice", "old-pw-pw", "admin");
    const cookieA = extractCookie(
      await request(app).post("/api/session/login").send({ username: "alice", password: "old-pw-pw" })
    );
    const cookieB = extractCookie(
      await request(app).post("/api/session/login").send({ username: "alice", password: "old-pw-pw" })
    );

    const wrongOld = await request(app)
      .post("/api/session/change-password")
      .set("Cookie", cookieA)
      .send({ oldPassword: "WRONG", newPassword: "newpassword" });
    expect(wrongOld.status).toBe(401);

    const ok = await request(app)
      .post("/api/session/change-password")
      .set("Cookie", cookieA)
      .send({ oldPassword: "old-pw-pw", newPassword: "newpassword" });
    expect(ok.status).toBe(204);

    const meA = await request(app).get("/api/session/me").set("Cookie", cookieA);
    expect(meA.status).toBe(200);

    const meB = await request(app).get("/api/session/me").set("Cookie", cookieB);
    expect(meB.status).toBe(401);

    expect(u.id).toBe(meA.body.id);
    // 20s, not the 5s default: this case runs SIX bcryptjs rounds (one hash to
    // create the user, four verifies, one hash for the new password), and
    // bcryptjs is pure JS. It takes ~4.5s on an idle machine — close enough to
    // the default that it tipped over whenever the full suite saturated the
    // CPU, which made it look like a real intermittent failure. The work is
    // genuinely slow, not hung, so the timeout is what was wrong.
  }, 20000);
});

describe("session router — guest mode", () => {
  let botDb: BotDatabase;

  afterEach(() => botDb.close());

  function makeApp(opts: {
    guestEnabled: boolean;
    guestPermissions?: GuestPermissions;
    guestBots?: BotAccess;
  }) {
    botDb = createDatabase(":memory:");
    const users = createUserStore(botDb.db);
    const sessions = createSessionStore(botDb.db);
    const audit = createAuditStore(botDb.db);
    const permissions = createPermissionStore(botDb.db);
    const guestCfg: GuestModeConfig = {
      enabled: opts.guestEnabled,
      bots: opts.guestBots ?? getDefaultConfig().guestMode.bots,
      permissions: opts.guestPermissions ?? getDefaultConfig().guestMode.permissions,
    };
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use(
      "/api/session",
      createSessionRouter(users, sessions, audit, pino({ level: "silent" }), permissions, () => guestCfg)
    );
    return { app, users, sessions };
  }

  it("POST /guest is 403 when guest mode disabled", async () => {
    const { app } = makeApp({ guestEnabled: false });
    const res = await request(app).post("/api/session/guest");
    expect(res.status).toBe(403);
  });

  it("POST /guest mints a guest session when enabled, and /me reports role guest + flags", async () => {
    const { app } = makeApp({
      guestEnabled: true,
      guestPermissions: {
        addToQueue: true,
        playNext: true,
        playNow: false,
        skip: false,
        transport: false,
        removeClear: false,
        playMode: false,
        playCollection: false,
      },
      guestBots: "all",
    });
    const login = await request(app).post("/api/session/guest");
    expect(login.status).toBe(200);
    expect(login.body.role).toBe("guest");
    const cookie = login.headers["set-cookie"];
    const me = await request(app).get("/api/session/me").set("Cookie", cookie);
    expect(me.body.role).toBe("guest");
    expect(me.body.guest.addToQueue).toBe(true);
    expect(me.body.guest.playNext).toBe(true);
    expect(me.body.capabilities).toEqual([]);
  });

  it("GET /needs-setup exposes guestAllowed", async () => {
    const { app } = makeApp({ guestEnabled: true });
    const res = await request(app).get("/api/session/needs-setup");
    expect(res.body.guestAllowed).toBe(true);
  });

  it("GET /me returns 401 for a guest session once guest mode is disabled", async () => {
    // Build an app whose guest config can be toggled at runtime, mirroring an
    // admin flipping the setting mid-session (requireAuthInline must reject).
    botDb = createDatabase(":memory:");
    const users = createUserStore(botDb.db);
    const sessions = createSessionStore(botDb.db);
    const audit = createAuditStore(botDb.db);
    const permissions = createPermissionStore(botDb.db);
    const guestCfg: GuestModeConfig = {
      enabled: true,
      bots: getDefaultConfig().guestMode.bots,
      permissions: getDefaultConfig().guestMode.permissions,
    };
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use(
      "/api/session",
      createSessionRouter(users, sessions, audit, pino({ level: "silent" }), permissions, () => guestCfg)
    );

    const login = await request(app).post("/api/session/guest");
    expect(login.status).toBe(200);
    const cookie = login.headers["set-cookie"];

    // While enabled, /me works for the guest.
    expect((await request(app).get("/api/session/me").set("Cookie", cookie)).status).toBe(200);

    // Admin disables guest mode → the in-flight guest session is now invalid.
    guestCfg.enabled = false;
    expect((await request(app).get("/api/session/me").set("Cookie", cookie)).status).toBe(401);
  });
});
