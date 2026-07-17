import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import pino from "pino";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MusicProvider, SearchResult } from "../../music/provider.js";
import { getDefaultConfig, loadConfig, type BotConfig } from "../../data/config.js";
import { createDatabase, type BotDatabase } from "../../data/database.js";
import { createUserStore } from "../../data/users.js";
import { createSessionStore } from "../../data/sessions.js";
import { createPermissionStore } from "../../data/permissions.js";
import { createRequireAuth } from "../middleware/requireAuth.js";
import { SESSION_COOKIE_NAME } from "../auth/validateSession.js";
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

describe("music router POST /quality — persistence (#125)", () => {
  let tmpDir: string;
  let configPath: string;
  let config: BotConfig;
  let botDb: BotDatabase;
  let app: express.Express;
  let cookie: string;
  let providers: Record<string, MusicProvider>;

  /** A provider whose in-memory quality is settable and readable, like the real
   *  ones. */
  function qualityProvider(platform: MusicProvider["platform"], initial: string): MusicProvider {
    let q = initial;
    return {
      platform,
      search: vi.fn().mockResolvedValue(empty),
      getQuality: vi.fn(() => q),
      setQuality: vi.fn((v: string) => { q = v; }),
    } as unknown as MusicProvider;
  }

  /** Jellyfin only accepts its own tiers (mirrors the real provider), so a
   *  broadcast of a foreign value is ignored — proving the snapshot captures each
   *  provider's ACTUAL post-apply state, not just the request value. */
  function jellyfinQualityProvider(): MusicProvider {
    let q = "direct";
    const tiers = new Set(["direct", "320", "192", "128"]);
    return {
      platform: "jellyfin",
      search: vi.fn().mockResolvedValue(empty),
      getQuality: vi.fn(() => q),
      setQuality: vi.fn((v: string) => { if (tiers.has(v)) q = v; }),
    } as unknown as MusicProvider;
  }

  beforeEach(async () => {
    botDb = createDatabase(":memory:");
    const users = createUserStore(botDb.db);
    const sessions = createSessionStore(botDb.db);
    const admin = await users.createUser("admin", "pw-admin", "admin");
    cookie = `${SESSION_COOKIE_NAME}=${sessions.createSession(admin.id).token}`;

    tmpDir = mkdtempSync(join(tmpdir(), "musicquality-"));
    configPath = join(tmpDir, "config.json");
    config = getDefaultConfig();

    providers = {
      netease: qualityProvider("netease", "exhigh"),
      qq: qualityProvider("qq", "exhigh"),
      bilibili: qualityProvider("bilibili", "high"),
      kugou: qualityProvider("kugou", "128"),
      jellyfin: jellyfinQualityProvider(),
    };

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use("/api", createRequireAuth(sessions, createPermissionStore(botDb.db), () => getDefaultConfig().guestMode));
    app.use(
      "/api/music",
      createMusicRouter(
        providers.netease, providers.qq, providers.bilibili, pino({ level: "silent" }),
        undefined, config, providers.kugou, undefined, providers.jellyfin, configPath,
      ),
    );
  });

  afterEach(() => {
    botDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("persists a platform-specific quality change to config.json", async () => {
    const res = await request(app)
      .post("/api/music/quality")
      .set("Cookie", cookie)
      .send({ platform: "netease", quality: "lossless" });
    expect(res.status).toBe(200);
    expect(providers.netease.setQuality).toHaveBeenCalledWith("lossless");
    // in-memory config mutated
    expect(config.audioQuality.netease).toBe("lossless");
    // written to disk + reload reflects it (survives a restart)
    const onDisk = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(onDisk.audioQuality.netease).toBe("lossless");
    expect(loadConfig(configPath).audioQuality.netease).toBe("lossless");
  });

  it("snapshots each provider's post-apply quality on a broadcast change", async () => {
    const res = await request(app)
      .post("/api/music/quality")
      .set("Cookie", cookie)
      .send({ quality: "320" });
    expect(res.status).toBe(200);
    // Broadcast reached every provider…
    expect(providers.netease.setQuality).toHaveBeenCalledWith("320");
    expect(providers.jellyfin.setQuality).toHaveBeenCalledWith("320");
    // …and the snapshot reflects what each one actually accepted. Jellyfin's
    // "320" is a valid tier here, so it takes; a foreign value would be ignored.
    expect(config.audioQuality).toEqual({
      netease: "320",
      qq: "320",
      bilibili: "320",
      kugou: "320",
      jellyfin: "320",
    });
  });

  it("ignores foreign broadcast values that a provider rejects (jellyfin)", async () => {
    const res = await request(app)
      .post("/api/music/quality")
      .set("Cookie", cookie)
      .send({ quality: "lossless" });
    expect(res.status).toBe(200);
    // jellyfin rejects the NetEase-style value → stays at its default tier.
    expect(config.audioQuality.jellyfin).toBe("direct");
    expect(config.audioQuality.netease).toBe("lossless");
  });
});
