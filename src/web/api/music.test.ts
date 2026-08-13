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
import { createMusicRouter, createLocalUploadBody } from "./music.js";

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

  it("GET /providers reports a configured defaultPlatform override (#126)", async () => {
    const config = getDefaultConfig();
    config.defaultPlatform = "qq"; // operator prefers QQ over the priority order
    const { app } = mount(config);
    const res = await request(app).get("/api/music/providers");
    expect(res.status).toBe(200);
    expect(res.body.default).toBe("qq");
  });

  it("routes a platform-less /search to the configured defaultPlatform (#126)", async () => {
    const config = getDefaultConfig();
    config.defaultPlatform = "bilibili";
    const { app, netease } = mount(config);
    const res = await request(app).get("/api/music/search?q=hello");
    expect(res.status).toBe(200);
    // Default is now bilibili, so the netease provider must NOT be hit.
    expect(netease.search).not.toHaveBeenCalled();
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

// #149: video containers must survive the transport layer. Before this the
// express.raw type filter only matched audio/*, video/webm and
// application/octet-stream, so a browser-sent video/mp4 body was never parsed
// and the handler answered 400 "raw audio body is required".
describe("music router POST /local/upload — content types and size cap (#149)", () => {
  let app: express.Express;
  let botDb: BotDatabase;
  let cookie: string;
  let uploadAudio: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    botDb = createDatabase(":memory:");
    const users = createUserStore(botDb.db);
    const sessions = createSessionStore(botDb.db);
    const admin = await users.createUser("admin", "pw-admin", "admin");
    cookie = `${SESSION_COOKIE_NAME}=${sessions.createSession(admin.id).token}`;

    uploadAudio = vi.fn(async (input: { originalName: string }) => ({
      id: "local-1", name: input.originalName, artist: "本地上传", album: "本地音乐",
      duration: 1, coverUrl: "", platform: "local",
    }));
    const local = { platform: "local", search: vi.fn().mockResolvedValue(empty), uploadAudio } as unknown as MusicProvider;

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use("/api", createRequireAuth(sessions, createPermissionStore(botDb.db), () => getDefaultConfig().guestMode));
    app.use("/api/music", createMusicRouter(
      fakeProvider("netease"), fakeProvider("qq"), fakeProvider("bilibili"),
      pino({ level: "silent" }), local, getDefaultConfig(),
    ));
  });

  afterEach(() => botDb.close());

  const post = (contentType: string, body: Buffer, name = "clip.mp4") =>
    request(app)
      .post("/api/music/local/upload")
      .set("Cookie", cookie)
      .set("Content-Type", contentType)
      .set("X-Filename", encodeURIComponent(name))
      .send(body);

  it("accepts the video MIME types browsers actually send", async () => {
    // These are what Chrome/Firefox put on a File for .mp4/.mov/.avi/.mkv.
    for (const ct of ["video/mp4", "video/quicktime", "video/x-msvideo", "video/x-matroska", "video/webm"]) {
      uploadAudio.mockClear();
      const res = await post(ct, Buffer.from("fake video bytes"));
      expect(res.status, `content-type ${ct}`).toBe(200);
      expect(uploadAudio).toHaveBeenCalledOnce();
      expect(res.body.song.platform).toBe("local");
    }
  });

  it("still accepts audio and octet-stream bodies", async () => {
    for (const ct of ["audio/mpeg", "audio/flac", "application/octet-stream"]) {
      uploadAudio.mockClear();
      const res = await post(ct, Buffer.from("fake audio"), "tune.mp3");
      expect(res.status, `content-type ${ct}`).toBe(200);
      expect(uploadAudio).toHaveBeenCalledOnce();
    }
  });

  it("passes the decoded filename and the content type through to the provider", async () => {
    await post("video/mp4", Buffer.from("bytes"), "我的 视频.mp4");
    expect(uploadAudio).toHaveBeenCalledWith(
      expect.objectContaining({ originalName: "我的 视频.mp4", mimeType: "video/mp4" }),
    );
  });

  it("surfaces a provider rejection as a 400 with its message", async () => {
    uploadAudio.mockRejectedValueOnce(new Error("这个视频里没有音轨，无法播放"));
    const res = await post("video/mp4", Buffer.from("bytes"));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("这个视频里没有音轨，无法播放");
  });

  it("requires authentication", async () => {
    const res = await request(app)
      .post("/api/music/local/upload")
      .set("Content-Type", "video/mp4")
      .send(Buffer.from("bytes"));
    expect(res.status).toBe(401);
  });

  it("rejects an oversize body as JSON, not an HTML stack trace", async () => {
    // Same middleware the route mounts, built with a small limit so the test
    // does not have to allocate half a gigabyte to reach the cap.
    const tiny = express();
    const reached = vi.fn();
    tiny.post("/u", createLocalUploadBody("1kb"), (_req, res) => { reached(); res.json({ ok: true }); });

    const res = await request(tiny)
      .post("/u")
      .set("Content-Type", "video/mp4")
      .send(Buffer.alloc(4096, 1));

    expect(res.status).toBe(413);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body.error).toContain("文件太大");
    // The HTML default handler leaked absolute server paths and a stack.
    expect(res.text).not.toMatch(/node_modules|<\/pre>|at read/);
    expect(reached).not.toHaveBeenCalled();
  });

  it("lets a body under the cap through the same middleware", async () => {
    const tiny = express();
    tiny.post("/u", createLocalUploadBody("1kb"), (req, res) => {
      res.json({ bytes: (req.body as Buffer).length });
    });
    const res = await request(tiny)
      .post("/u")
      .set("Content-Type", "video/mp4")
      .send(Buffer.alloc(512, 1));
    expect(res.status).toBe(200);
    expect(res.body.bytes).toBe(512);
  });

  it("rejects local uploads when the feature is switched off", async () => {
    const off = getDefaultConfig();
    off.localAudioEnabled = false;
    const users = createUserStore(botDb.db);
    const sessions = createSessionStore(botDb.db);
    const a2 = await users.createUser("admin2", "pw-admin2", "admin");
    const c2 = `${SESSION_COOKIE_NAME}=${sessions.createSession(a2.id).token}`;
    const app2 = express();
    app2.use(cookieParser());
    app2.use("/api", createRequireAuth(sessions, createPermissionStore(botDb.db), () => getDefaultConfig().guestMode));
    app2.use("/api/music", createMusicRouter(
      fakeProvider("netease"), fakeProvider("qq"), fakeProvider("bilibili"),
      pino({ level: "silent" }),
      { platform: "local", search: vi.fn(), uploadAudio } as unknown as MusicProvider, off,
    ));
    const res = await request(app2)
      .post("/api/music/local/upload")
      .set("Cookie", c2)
      .set("Content-Type", "video/mp4")
      .send(Buffer.from("bytes"));
    expect(res.status).toBe(403);
    expect(uploadAudio).not.toHaveBeenCalled();
  });
});
