import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import pino from "pino";
import type { MusicProvider } from "../../music/provider.js";
import type { QQMusicProvider } from "../../music/qq.js";
import { getDefaultConfig, type JellyfinConfig } from "../../data/config.js";
import { createAuthRouter } from "./auth.js";

function fakeProvider(platform: MusicProvider["platform"]): MusicProvider {
  return { platform } as unknown as MusicProvider;
}

describe("auth router POST /jellyfin/test", () => {
  function mount(
    stored: Partial<JellyfinConfig>,
    user: unknown = { role: "admin" },
  ) {
    const config = getDefaultConfig();
    Object.assign(config.jellyfin, stored);
    const testConnection = vi.fn().mockResolvedValue({ ok: true, serverName: "JF" });
    const jellyfin = { platform: "jellyfin", testConnection } as unknown as MusicProvider;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as { user?: unknown }).user = user; next(); });
    app.use(
      "/api/auth",
      createAuthRouter(
        fakeProvider("netease"), fakeProvider("qq"), fakeProvider("bilibili"),
        pino({ level: "silent" }), undefined, undefined, undefined, jellyfin, config,
      ),
    );
    return { app, testConnection };
  }

  it("fills empty credential fields from the stored config (masked password case)", async () => {
    const { app, testConnection } = mount({
      serverUrl: "https://old.example.com",
      username: "bob",
      password: "stored-pw",
    });
    const res = await request(app)
      .post("/api/auth/jellyfin/test")
      .send({ serverUrl: "https://new.example.com", username: "bob", password: "" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(testConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        serverUrl: "https://new.example.com",
        username: "bob",
        password: "stored-pw",
      }),
    );
  });

  it("passes freshly entered credentials through", async () => {
    const { app, testConnection } = mount({});
    await request(app).post("/api/auth/jellyfin/test").send({
      serverUrl: "https://jf.example.com",
      authMode: "apikey",
      apiKey: "key123",
      userId: "u1",
    });
    expect(testConnection).toHaveBeenCalledWith(
      expect.objectContaining({ authMode: "apikey", apiKey: "key123", userId: "u1" }),
    );
  });

  it("is 403 for a member lacking platform.auth", async () => {
    const { app, testConnection } = mount({}, { role: "member", capabilities: new Set([]) });
    const res = await request(app).post("/api/auth/jellyfin/test").send({});
    expect(res.status).toBe(403);
    expect(testConnection).not.toHaveBeenCalled();
  });
});

describe("managed QQ authentication routes", () => {
  function mount(managed: boolean, user: unknown = { role: "admin" }) {
    const renewal = {
      renewalStatus: "scheduled" as const,
      nextRefreshAt: "2026-11-10T00:00:00.000Z",
      lastRefreshAt: "2026-11-09T00:00:00.000Z",
    };
    const refresh = vi.fn().mockResolvedValue("refreshed");
    const qq = {
      platform: "qq",
      managedSession: managed ? { refresh, getStatus: () => renewal } : undefined,
      checkQrCodeStatus: vi.fn().mockResolvedValue("confirmed"),
      setCookie: vi.fn(),
      getCookie: () => "private-test-cookie",
      getAuthStatus: vi.fn().mockResolvedValue({ loggedIn: true }),
    } as unknown as QQMusicProvider;
    const legacyStore = { load: vi.fn(), save: vi.fn() };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as { user?: unknown }).user = user; next(); });
    app.use("/api/auth", createAuthRouter(
      fakeProvider("netease"), qq, fakeProvider("bilibili"), pino({ level: "silent" }), legacyStore,
    ));
    return { app, qq, refresh, legacyStore };
  }

  it("returns status only and delegates persistence to the managed session", async () => {
    const { app, qq, refresh, legacyStore } = mount(true);
    await request(app).get("/api/auth/qrcode/status").query({ platform: "qq", key: "opaque" }).expect(200);
    await request(app).post("/api/auth/cookie").send({ platform: "qq", cookie: "uin=1" }).expect(200);
    expect(qq.setCookie).toHaveBeenCalledWith("uin=1");
    expect(legacyStore.save).not.toHaveBeenCalled();
    const status = await request(app).get("/api/auth/status").query({ platform: "qq" }).expect(200);
    expect(status.body.lastRefreshAt).toBe("2026-11-09T00:00:00.000Z");
    const res = await request(app).post("/api/auth/qq/refresh").expect(200);
    expect(res.body).toEqual({
      outcome: "refreshed", renewalStatus: "scheduled", nextRefreshAt: "2026-11-10T00:00:00.000Z",
      lastRefreshAt: "2026-11-09T00:00:00.000Z",
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("guards managed QQ polling and refresh with platform.auth", async () => {
    const { app, qq, refresh } = mount(true, { role: "member", capabilities: new Set() });
    await request(app).get("/api/auth/qrcode/status").query({ platform: "qq", key: "opaque" }).expect(403);
    await request(app).post("/api/auth/qq/refresh").expect(403);
    expect(qq.checkQrCodeStatus).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("continues persisting the legacy cookie when the feature is disabled", async () => {
    const { app, legacyStore } = mount(false);
    await request(app).get("/api/auth/qrcode/status").query({ platform: "qq", key: "legacy" }).expect(200);
    expect(legacyStore.save).toHaveBeenCalledWith("qq", "private-test-cookie");
    await request(app).post("/api/auth/qq/refresh").expect(404);
  });

  it("keeps the current QQ cookie when an unmanaged import cannot be saved", async () => {
    const { app, qq, legacyStore } = mount(false);
    legacyStore.save.mockImplementationOnce(() => { throw new Error("test write failed"); });
    await request(app).post("/api/auth/cookie").send({ platform: "qq", cookie: "uin=999" }).expect(503);
    expect(qq.setCookie).not.toHaveBeenCalled();
    await request(app).post("/api/auth/cookie").send({ platform: "qq", cookie: "uin=999" }).expect(200);
    expect(legacyStore.save).toHaveBeenLastCalledWith("qq", "uin=999");
    expect(qq.setCookie).toHaveBeenCalledWith("uin=999");
  });
});
