import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import pino from "pino";
import { createDatabase } from "../../data/database.js";
import { createPersonalMusicRouter } from "./personal-music.js";
import { createPlayerRouter } from "./player.js";

function mount(opts: {
  config?: { perUserMusicAccounts?: boolean };
  extraProviders?: Record<string, unknown>;
} = {}) {
  const db = createDatabase(":memory:");
  db.db
    .prepare("INSERT INTO users (id, username, passwordHash, createdAt, updatedAt, role) VALUES (?,?,?,?,?,?)")
    .run("u1", "alice", "x", 0, 0, "member");
  const personalView = {
    getAuthStatus: vi.fn(async () => ({ loggedIn: true, nickname: "Alice163" })),
  };
  const provider: any = {
    platform: "netease",
    getQrCode: vi.fn(async () => ({ qrUrl: "u", qrImg: "data:img", key: "k1" })),
    pollQrLogin: vi.fn(async () => ({ status: "waiting" })),
    withCookie: vi.fn(() => personalView),
    setCookie: vi.fn(),
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { id: "u1", username: "alice", role: "member" };
    next();
  });
  app.use(
    "/api/me/music",
    createPersonalMusicRouter(
      db,
      { netease: provider, ...(opts.extraProviders as object) },
      pino({ level: "silent" }),
      opts.config,
    ),
  );
  return { app, db, provider, personalView };
}

/** Seed an admin-owned account and assign it to u1. */
function assignAccount(db: ReturnType<typeof createDatabase>, label = "网易云-主号") {
  const account = db.createMusicAccount({
    platform: "netease",
    label,
    cookie: "MUSIC_U=granted",
  });
  db.assignMusicAccount("u1", account.id, "admin");
  return account;
}

describe("personal music account router (#164)", () => {
  it("reports not linked until the user logs in", async () => {
    const { app } = mount();
    const res = await request(app).get("/api/me/music/netease/status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      linked: false, loggedIn: false, source: "none", canUnlink: false, supportsQrLogin: true,
      preferShared: false, featureEnabled: false,
    });
  });

  it("creates a QR code", async () => {
    const { app } = mount();
    const res = await request(app).post("/api/me/music/netease/qrcode");
    expect(res.body).toEqual({ qrUrl: "u", qrImg: "data:img", key: "k1" });
  });

  it("stores the cookie for this user on confirm, never on the shared provider, and never returns it", async () => {
    const { app, db, provider } = mount();
    provider.pollQrLogin.mockResolvedValue({ status: "confirmed", cookie: "MUSIC_U=alice" });
    const res = await request(app).get("/api/me/music/netease/qrcode/status").query({ key: "k1" });
    expect(res.body).toEqual({ status: "confirmed" });
    expect(JSON.stringify(res.body)).not.toContain("MUSIC_U");
    expect(db.getUserMusicCookie("u1", "netease")).toBe("MUSIC_U=alice");
    expect(provider.setCookie).not.toHaveBeenCalled();
  });

  it("requires a key to poll", async () => {
    const { app } = mount();
    expect((await request(app).get("/api/me/music/netease/qrcode/status")).status).toBe(400);
  });

  it("reports the linked account's nickname via a view on the user's cookie", async () => {
    const { app, db, provider } = mount();
    db.setUserMusicCookie("u1", "netease", "MUSIC_U=alice");
    const res = await request(app).get("/api/me/music/netease/status");
    expect(res.body).toEqual({
      linked: true,
      source: "personal",
      canUnlink: true,
      supportsQrLogin: true,
      preferShared: false,
      featureEnabled: false,
      loggedIn: true,
      nickname: "Alice163",
    });
    expect(provider.withCookie).toHaveBeenCalledWith("MUSIC_U=alice");
  });

  it("unlinks", async () => {
    const { app, db } = mount();
    db.setUserMusicCookie("u1", "netease", "MUSIC_U=alice");
    expect((await request(app).delete("/api/me/music/netease")).status).toBe(200);
    expect(db.getUserMusicCookie("u1", "netease")).toBeNull();
  });

  // 404 for a platform this build does not expose — keeps the param route from
  // silently answering "not linked" for a typo'd URL.
  it("404s an unknown platform", async () => {
    const { app } = mount();
    expect((await request(app).get("/api/me/music/deezer/status")).status).toBe(404);
  });

  // qq/kugou/bilibili ship withCookie but not pollQrLogin yet: linking is 501,
  // while an admin-assigned account still works (see below).
  it("501s QR login on a platform without per-user polling", async () => {
    const { app } = mount({ extraProviders: { qq: { platform: "qq", withCookie: vi.fn() } } });
    expect((await request(app).post("/api/me/music/qq/qrcode")).status).toBe(501);
  });

  describe("admin-assigned account", () => {
    it("reports source=granted with the admin's label and forbids unlinking", async () => {
      const { app, db, provider } = mount({ config: { perUserMusicAccounts: true } });
      assignAccount(db);
      const res = await request(app).get("/api/me/music/netease/status");
      expect(res.body).toEqual({
        linked: true,
        source: "granted",
        label: "网易云-主号",
        canUnlink: false,
        supportsQrLogin: true,
        preferShared: false,
        featureEnabled: true,
        loggedIn: true,
        nickname: "Alice163",
      });
      expect(provider.withCookie).toHaveBeenCalledWith("MUSIC_U=granted");
    });

    it("is invisible while the admin toggle is off", async () => {
      const { app, db } = mount({ config: { perUserMusicAccounts: false } });
      assignAccount(db);
      const res = await request(app).get("/api/me/music/netease/status");
      expect(res.body).toEqual({
      linked: false, loggedIn: false, source: "none", canUnlink: false, supportsQrLogin: true,
      preferShared: false, featureEnabled: false,
    });
    });

    // Unlinking on the member side must never revoke what the admin granted:
    // the two live in separate tables on purpose.
    it("survives a member unlink and is reported as the fallback", async () => {
      const { app, db } = mount({ config: { perUserMusicAccounts: true } });
      assignAccount(db);
      db.setUserMusicCookie("u1", "netease", "MUSIC_U=alice");
      const res = await request(app).delete("/api/me/music/netease");
      expect(res.body).toEqual({ ok: true, removed: true, fallback: "granted" });
      expect(db.getUserMusicCookie("u1", "netease")).toBeNull();
      expect(db.getGrantedMusicAccount("u1", "netease")?.cookie).toBe("MUSIC_U=granted");
    });
  });
});

describe("web FM uses the caller's linked NetEase account (#164)", () => {
  async function startFm(opts: { linked: boolean; role?: string; platform?: string }) {
    const db = createDatabase(":memory:");
    db.db
      .prepare("INSERT INTO users (id, username, passwordHash, createdAt, updatedAt, role) VALUES (?,?,?,?,?,?)")
      .run("u1", "alice", "x", 0, 0, "member");
    if (opts.linked) db.setUserMusicCookie("u1", "netease", "MUSIC_U=alice");
    const personal = { platform: "netease", personal: true };
    const shared: any = { platform: "netease", pollQrLogin: vi.fn(), withCookie: vi.fn(() => personal) };
    const qq: any = { platform: "qq" };
    const bot = {
      id: "b1",
      getProviderFor: (p: string) => (p === "qq" ? qq : shared),
      startFm: vi.fn(async (_provider: unknown) => "Personal FM started"),
    };
    const botManager: any = { getBot: () => bot };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).user = {
        id: "u1", username: "alice", role: opts.role ?? "member",
        capabilities: new Set(["player.control"]), bots: "all", guest: { playMode: true },
      };
      next();
    });
    app.use("/api/player", createPlayerRouter(botManager, pino({ level: "silent" }), db));
    const res = await request(app).post("/api/player/b1/fm").send({ platform: opts.platform ?? "netease" });
    return { res, bot, shared, personal, qq };
  }

  it("starts FM on the user's own account when linked", async () => {
    const { res, bot, shared, personal } = await startFm({ linked: true });
    expect(res.status).toBe(200);
    expect(shared.withCookie).toHaveBeenCalledWith("MUSIC_U=alice");
    expect(bot.startFm.mock.calls[0][0]).toBe(personal);
  });

  it("falls back to the shared account when the user has not linked one", async () => {
    const { bot, shared } = await startFm({ linked: false });
    expect(bot.startFm.mock.calls[0][0]).toBe(shared);
  });

  it("leaves other platforms alone", async () => {
    const { bot, qq } = await startFm({ linked: true, platform: "qq" });
    expect(bot.startFm.mock.calls[0][0]).toBe(qq);
  });
});

// ---------------------------------------------------------------------------
// "Play through the shared account" preference (#164 follow-up)
//
// The case this exists for: the member's own NetEase login has no VIP, the
// admin's does. The preference is per-platform and per-user, and it must not
// touch either stored login.
// ---------------------------------------------------------------------------
describe("personal music — shared-account preference", () => {
  const ON = { config: { perUserMusicAccounts: true } };

  it("defaults to the member's own account", async () => {
    const { app } = mount(ON);
    const res = await request(app).get("/api/me/music/netease/preference");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ platform: "netease", preferShared: false });
  });

  it("stores the choice and reports it back", async () => {
    const { app } = mount(ON);
    const put = await request(app).put("/api/me/music/netease/preference").send({ preferShared: true });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ platform: "netease", preferShared: true });

    const get = await request(app).get("/api/me/music/netease/preference");
    expect(get.body.preferShared).toBe(true);
  });

  it("keeps the choice per platform", async () => {
    const { app } = mount({
      ...ON,
      extraProviders: { qq: { platform: "qq", withCookie: () => ({ getAuthStatus: async () => ({ loggedIn: true }) }) } },
    });
    await request(app).put("/api/me/music/netease/preference").send({ preferShared: true });
    const qq = await request(app).get("/api/me/music/qq/preference");
    expect(qq.body.preferShared).toBe(false);
  });

  it("does not touch the stored login", async () => {
    const { app, db } = mount(ON);
    db.setUserMusicCookie("u1", "netease", "MUSIC_U=mine");
    await request(app).put("/api/me/music/netease/preference").send({ preferShared: true });

    expect(db.getUserMusicCookie("u1", "netease")).toBe("MUSIC_U=mine");
    expect(db.getUserMusicPreference("u1", "netease")).toEqual({ preferShared: true });
  });

  it("surfaces the choice on the status payload the UI already reads", async () => {
    const { app, db } = mount(ON);
    db.setUserMusicCookie("u1", "netease", "MUSIC_U=mine");
    await request(app).put("/api/me/music/netease/preference").send({ preferShared: true });

    const res = await request(app).get("/api/me/music/netease/status");
    expect(res.body.preferShared).toBe(true);
    expect(res.body.featureEnabled).toBe(true);
  });

  it("rejects a non-boolean", async () => {
    const { app } = mount(ON);
    const res = await request(app).put("/api/me/music/netease/preference").send({ preferShared: "yes" });
    expect(res.status).toBe(400);
  });

  it("refuses when the admin has the feature off", async () => {
    const { app } = mount({ config: { perUserMusicAccounts: false } });
    const res = await request(app).put("/api/me/music/netease/preference").send({ preferShared: true });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("per_user_accounts_disabled");
  });
});
