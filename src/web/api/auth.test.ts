import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import pino from "pino";
import type { MusicProvider } from "../../music/provider.js";
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
