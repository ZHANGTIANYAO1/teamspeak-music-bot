import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import pino from "pino";
import type { MusicProvider, SearchResult } from "../../music/provider.js";
import { getDefaultConfig, type BotConfig } from "../../data/config.js";
import { createMusicRouter } from "./music.js";

const empty: SearchResult = { songs: [], albums: [], playlists: [] };

function fakeProvider(platform: MusicProvider["platform"]): MusicProvider {
  return {
    platform,
    search: vi.fn().mockResolvedValue(empty),
  } as unknown as MusicProvider;
}

describe("music router GET /search offset pagination", () => {
  let app: express.Express;
  let netease: MusicProvider;

  beforeEach(() => {
    netease = fakeProvider("netease");
    const router = createMusicRouter(
      netease,
      fakeProvider("qq"),
      fakeProvider("bilibili"),
      pino({ level: "silent" })
    );
    app = express();
    app.use("/api/music", router);
  });

  it("parses offset and passes it as the 3rd arg to provider.search", async () => {
    const res = await request(app).get("/api/music/search?q=hello&limit=20&offset=20");
    expect(res.status).toBe(200);
    expect(netease.search).toHaveBeenCalledWith("hello", 20, 20);
  });

  it("defaults a missing offset to 0", async () => {
    const res = await request(app).get("/api/music/search?q=hello&limit=20");
    expect(res.status).toBe(200);
    expect(netease.search).toHaveBeenCalledWith("hello", 20, 0);
  });

  it("clamps a negative offset to 0", async () => {
    const res = await request(app).get("/api/music/search?q=hello&limit=20&offset=-5");
    expect(res.status).toBe(200);
    expect(netease.search).toHaveBeenCalledWith("hello", 20, 0);
  });
});

describe("music router provider gating (enabledProviders) + jellyfin endpoints", () => {
  function jellyfinFake(): MusicProvider {
    return {
      platform: "jellyfin",
      search: vi.fn().mockResolvedValue(empty),
      getQuality: vi.fn().mockReturnValue("direct"),
      getLatestAlbums: vi
        .fn()
        .mockResolvedValue([{ id: "a1", name: "Album", platform: "jellyfin" }]),
      getFavoriteSongs: vi.fn().mockResolvedValue([]),
    } as unknown as MusicProvider;
  }

  function mount(config: BotConfig) {
    const netease = fakeProvider("netease");
    const jellyfin = jellyfinFake();
    const router = createMusicRouter(
      netease,
      fakeProvider("qq"),
      fakeProvider("bilibili"),
      pino({ level: "silent" }),
      undefined,
      config,
      fakeProvider("kugou"),
      fakeProvider("spotify"),
      jellyfin,
    );
    const app = express();
    app.use("/api/music", router);
    return { app, netease, jellyfin };
  }

  it("routes a platform-less /search to the default platform (netease)", async () => {
    const { app, netease, jellyfin } = mount(getDefaultConfig());
    const res = await request(app).get("/api/music/search?q=hello");
    expect(res.status).toBe(200);
    expect(netease.search).toHaveBeenCalledWith("hello", 20, 0);
    expect(jellyfin.search).not.toHaveBeenCalled();
  });

  it("rejects a disabled platform with 400 without calling its provider", async () => {
    // Default config leaves jellyfin (opt-in) disabled.
    const { app, jellyfin } = mount(getDefaultConfig());
    const res = await request(app).get("/api/music/search?q=hello&platform=jellyfin");
    expect(res.status).toBe(400);
    expect(jellyfin.search).not.toHaveBeenCalled();
  });

  it("allows an explicitly enabled jellyfin platform", async () => {
    const config = getDefaultConfig();
    config.enabledProviders = [...config.enabledProviders, "jellyfin"];
    const { app, jellyfin } = mount(config);
    const res = await request(app).get("/api/music/search?q=hello&platform=jellyfin");
    expect(res.status).toBe(200);
    expect(jellyfin.search).toHaveBeenCalledWith("hello", 20, 0);
  });

  it("GET /providers reports enabled sources and the default platform", async () => {
    const { app } = mount(getDefaultConfig());
    const res = await request(app).get("/api/music/providers");
    expect(res.status).toBe(200);
    expect(res.body.default).toBe("netease");
    expect(res.body.enabled).toContain("netease");
    expect(res.body.enabled).toContain("local"); // localAudioEnabled defaults on
    expect(res.body.enabled).not.toContain("jellyfin"); // opt-in, off by default
    expect(res.body.enabled).not.toContain("spotify"); // spotify.enabled defaults off
  });

  /** Default config plus the opt-in jellyfin source enabled. */
  function configWithJellyfin() {
    const config = getDefaultConfig();
    config.enabledProviders = [...config.enabledProviders, "jellyfin"];
    return config;
  }

  it("GET /jellyfin/latest-albums returns provider data", async () => {
    const { app, jellyfin } = mount(configWithJellyfin());
    const res = await request(app).get("/api/music/jellyfin/latest-albums?limit=5");
    expect(res.status).toBe(200);
    expect(
      (jellyfin as unknown as { getLatestAlbums: ReturnType<typeof vi.fn> }).getLatestAlbums,
    ).toHaveBeenCalledWith(5);
    expect(res.body.albums).toHaveLength(1);
  });

  it("GET /jellyfin/latest-albums is 400 when jellyfin is disabled (the default)", async () => {
    const { app } = mount(getDefaultConfig());
    const res = await request(app).get("/api/music/jellyfin/latest-albums");
    expect(res.status).toBe(400);
  });

  it("GET /jellyfin/favorites denies unauthenticated/guest access", async () => {
    const { app } = mount(configWithJellyfin());
    const res = await request(app).get("/api/music/jellyfin/favorites");
    expect(res.status).toBe(401);
  });
});
