import { describe, it, expect, vi } from "vitest";
import { RiskControlError, SongUrlUnavailable } from "./provider.js";
import {
  parseLyrics,
  mapNeteaseAlbums,
  mapNeteaseSongs,
  mapNeteaseArtists,
  parseNeteaseTrial,
  NeteaseProvider,
} from "./netease.js";

describe("NetEase adapter", () => {
  it("parses LRC format lyrics", () => {
    const lrc = `[00:00.00] 作词 : 周杰伦
[00:01.00] 作曲 : 周杰伦
[00:12.50]故事的小黄花
[00:15.80]从出生那年就飘着`;

    const lines = parseLyrics(lrc);
    expect(lines).toHaveLength(2);
    expect(lines[0].time).toBeCloseTo(12.5, 1);
    expect(lines[0].text).toBe("故事的小黄花");
    expect(lines[1].time).toBeCloseTo(15.8, 1);
    expect(lines[1].text).toBe("从出生那年就飘着");
  });

  it("handles empty lyrics", () => {
    const lines = parseLyrics("");
    expect(lines).toHaveLength(0);
  });

  it("merges translation lyrics", () => {
    const lrc = "[00:12.50]Hello world";
    const tlyric = "[00:12.50]你好世界";
    const lines = parseLyrics(lrc, tlyric);
    expect(lines[0].text).toBe("Hello world");
    expect(lines[0].translation).toBe("你好世界");
  });

  it("mapNeteaseAlbums maps raw cloudsearch albums to Album shape", () => {
    const raw = [
      {
        id: 42,
        name: "Album A",
        picUrl: "https://x/p.jpg",
        artists: [{ name: "Artist X" }, { name: "Featured Y" }],
        size: 12,
      },
      {
        id: 99,
        name: "Album B",
        picUrl: "",
        artists: [],
      },
    ];
    expect(mapNeteaseAlbums(raw)).toEqual([
      { id: "42", name: "Album A", artist: "Artist X / Featured Y", coverUrl: "https://x/p.jpg", songCount: 12, platform: "netease" },
      { id: "99", name: "Album B", artist: "", coverUrl: "", songCount: 0, platform: "netease" },
    ]);
  });

  it("mapNeteaseAlbums returns [] for empty/null input", () => {
    expect(mapNeteaseAlbums([])).toEqual([]);
    expect(mapNeteaseAlbums(null as any)).toEqual([]);
    expect(mapNeteaseAlbums(undefined as any)).toEqual([]);
  });

  it("mapNeteaseSongs maps fee to vip flag (1/4 = vip, 0/8 = free)", () => {
    const raw = [
      { id: 1, name: "VIP", ar: [{ name: "A" }], al: { name: "Al", picUrl: "p" }, dt: 180000, fee: 1 },
      { id: 2, name: "Album-only", ar: [], al: { name: "Al", picUrl: "" }, dt: 0, fee: 4 },
      { id: 3, name: "Free", ar: [], al: {}, dt: 0, fee: 0 },
      { id: 4, name: "Free low-quality", ar: [], al: {}, dt: 0, fee: 8 },
    ];
    const out = mapNeteaseSongs(raw);
    expect(out[0].vip).toBe(true);
    expect(out[1].vip).toBe(true);
    expect(out[2].vip).toBe(false);
    expect(out[3].vip).toBe(false); // fee=8 plays in full (low quality), NOT vip
  });

  it("mapNeteaseSongs accepts artists/album/duration aliases (personal_fm shape)", () => {
    const out = mapNeteaseSongs([
      { id: 9, name: "FM", artists: [{ name: "B" }], album: { name: "Al2", picUrl: "p2" }, duration: 200000, fee: 0 },
    ]);
    expect(out[0]).toMatchObject({ artist: "B", album: "Al2", coverUrl: "p2", vip: false });
  });

  it("parseNeteaseTrial maps freeTrialInfo to trial seconds", () => {
    // 无试听（VIP/免费）
    expect(parseNeteaseTrial({})).toBeUndefined();
    expect(parseNeteaseTrial({ freeTrialInfo: null })).toBeUndefined();
    // 标准秒
    expect(parseNeteaseTrial({ freeTrialInfo: { start: 0, end: 30 } })).toBe(30);
    expect(parseNeteaseTrial({ freeTrialInfo: { start: 5, end: 35 } })).toBe(30);
    // 别名容忍 begin/trialBegin
    expect(parseNeteaseTrial({ freeTrialInfo: { begin: 0, end: 30 } })).toBe(30);
    // 毫秒兜底（end>1000）
    expect(parseNeteaseTrial({ freeTrialInfo: { start: 0, end: 30000 } })).toBe(30);
    // 异常 end<=start
    expect(parseNeteaseTrial({ freeTrialInfo: { start: 0, end: 0 } })).toBeUndefined();
  });
});

describe("NeteaseProvider.search pagination", () => {
  function mockProvider() {
    const p = new NeteaseProvider("http://x");
    const get = vi.fn().mockResolvedValue({
      data: { result: { songs: [], playlists: [], albums: [] } },
    });
    (p as any).api = { get };
    return { p, get };
  }

  /** Find the /cloudsearch call whose params.type matches. */
  function callByType(get: ReturnType<typeof vi.fn>, type: number) {
    const call = get.mock.calls.find((c: any[]) => c[1]?.params?.type === type);
    expect(call, `expected a /cloudsearch call with type=${type}`).toBeTruthy();
    return call![1].params as Record<string, unknown>;
  }

  it("forwards offset for songs and uses real limit+offset for playlists/albums", async () => {
    const { p, get } = mockProvider();
    await p.search("hello", 20, 20);

    // songs (type 1): offset forwarded, limit unchanged
    const songs = callByType(get, 1);
    expect(songs.limit).toBe(20);
    expect(songs.offset).toBe(20);

    // playlists (type 1000): limit-driven (NOT hardcoded 10) + offset
    const playlists = callByType(get, 1000);
    expect(playlists.limit).toBe(20);
    expect(playlists.offset).toBe(20);

    // albums (type 10): limit-driven (NOT hardcoded 10) + offset
    const albums = callByType(get, 10);
    expect(albums.limit).toBe(20);
    expect(albums.offset).toBe(20);
  });

  it("defaults offset to 0 (backward compatible)", async () => {
    const { p, get } = mockProvider();
    await p.search("hello", 20);
    expect(callByType(get, 1).offset).toBe(0);
    expect(callByType(get, 1000).offset).toBe(0);
    expect(callByType(get, 10).offset).toBe(0);
  });

  it("requests artists (type=100) and returns them alongside songs/albums/playlists", async () => {
    const p = new NeteaseProvider("http://x");
    const get = vi.fn(async (_path: string, cfg: any) => ({
      data:
        cfg.params.type === 100
          ? { result: { artists: [{ id: 6452, name: "Adele", picUrl: "http://p/1.jpg", musicSize: 120 }] } }
          : { result: { songs: [], playlists: [], albums: [] } },
    }));
    (p as any).api = { get };

    const res = await p.search("adele", 20, 0);

    expect(callByType(get, 100).limit).toBe(20);
    expect(callByType(get, 100).offset).toBe(0);
    expect(res.artists).toEqual([
      {
        id: "6452",
        name: "Adele",
        avatarUrl: "http://p/1.jpg",
        aliases: [],
        songCount: 120,
        albumCount: undefined,
        platform: "netease",
      },
    ]);
  });
});

describe("mapNeteaseArtists (artist search + detail)", () => {
  it("maps cloudsearch type=100 artist entries", () => {
    const out = mapNeteaseArtists([
      {
        id: 6452,
        name: "Adele",
        picUrl: "http://p/1.jpg",
        alias: ["阿黛尔"],
        musicSize: 120,
        albumSize: 9,
      },
    ]);
    expect(out).toEqual([
      {
        id: "6452",
        name: "Adele",
        avatarUrl: "http://p/1.jpg",
        aliases: ["阿黛尔"],
        songCount: 120,
        albumCount: 9,
        platform: "netease",
      },
    ]);
  });

  it("falls back to img1v1Url/alia and drops non-string or empty aliases", () => {
    const out = mapNeteaseArtists([
      { id: 1, name: "X", img1v1Url: "http://p/2.jpg", alia: ["a", "", null, 3] },
    ]);
    expect(out[0].avatarUrl).toBe("http://p/2.jpg");
    expect(out[0].aliases).toEqual(["a"]);
    expect(out[0].songCount).toBeUndefined();
    expect(out[0].albumCount).toBeUndefined();
  });

  it("returns [] for empty/null input", () => {
    expect(mapNeteaseArtists([])).toEqual([]);
    expect(mapNeteaseArtists(null as any)).toEqual([]);
    expect(mapNeteaseArtists(undefined as any)).toEqual([]);
  });
});

describe("NeteaseProvider per-user login (#164)", () => {
  function withGet(p: NeteaseProvider, impl: (path: string, cfg: any) => any) {
    const get = vi.fn(async (path: string, cfg: any) => ({ data: impl(path, cfg) }));
    (p as any).api = { get, defaults: { baseURL: "http://127.0.0.1:3001" } };
    return get;
  }

  it("pollQrLogin returns the cookie without touching the shared account", async () => {
    const p = new NeteaseProvider("http://127.0.0.1:3001");
    p.setCookie("MUSIC_U=shared");
    withGet(p, () => ({ code: 803, cookie: "MUSIC_U=personal" }));
    expect(await p.pollQrLogin("k")).toEqual({ status: "confirmed", cookie: "MUSIC_U=personal" });
    expect(p.getCookie()).toBe("MUSIC_U=shared");
  });

  it("pollQrLogin maps the waiting / scanned / expired codes", async () => {
    const p = new NeteaseProvider("http://127.0.0.1:3001");
    let code = 801;
    withGet(p, () => ({ code }));
    expect(await p.pollQrLogin("k")).toEqual({ status: "waiting" });
    code = 802;
    expect(await p.pollQrLogin("k")).toEqual({ status: "scanned" });
    code = 800;
    expect(await p.pollQrLogin("k")).toEqual({ status: "expired" });
  });

  it("checkQrCodeStatus still stores the cookie on the shared provider (admin login)", async () => {
    const p = new NeteaseProvider("http://127.0.0.1:3001");
    withGet(p, () => ({ code: 803, cookie: "MUSIC_U=admin" }));
    expect(await p.checkQrCodeStatus("k")).toBe("confirmed");
    expect(p.getCookie()).toBe("MUSIC_U=admin");
  });

  it("withCookie gives a view that fetches FM with the other account's cookie", async () => {
    const p = new NeteaseProvider("http://127.0.0.1:3001");
    p.setCookie("MUSIC_U=shared");
    const personal = p.withCookie("MUSIC_U=personal");
    const get = withGet(personal, () => ({ data: [] }));
    await personal.getPersonalFm();
    expect(get.mock.calls[0][1].params.cookie).toBe("MUSIC_U=personal");
    expect(p.getCookie()).toBe("MUSIC_U=shared");
    expect(personal.platform).toBe("netease");
  });
});

describe("NeteaseProvider.getArtistAllSongs (全部歌曲 paging)", () => {
  const rawSongs = [
    { id: 1, name: "A", artists: [{ name: "X" }], album: { name: "Al" }, duration: 200000, fee: 0 },
    { id: 2, name: "B", artists: [{ name: "X" }], album: { name: "Al" }, duration: 100000, fee: 0 },
  ];

  function withGet(p: NeteaseProvider, impl: (path: string, cfg: any) => any) {
    const get = vi.fn(async (path: string, cfg: any) => ({ data: impl(path, cfg) }));
    (p as any).api = { get };
    return get;
  }

  it("pages /artist/songs with order=hot and reports total/hasMore", async () => {
    const p = new NeteaseProvider("http://x");
    const get = withGet(p, () => ({ songs: rawSongs, total: 345, more: true }));

    const page = await p.getArtistAllSongs("46487", 50, 50);

    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0][0]).toBe("/artist/songs");
    expect(get.mock.calls[0][1].params).toMatchObject({
      id: "46487",
      limit: 50,
      offset: 50,
      order: "hot",
    });
    expect(page.songs.map((s) => s.id)).toEqual(["1", "2"]);
    expect(page.total).toBe(345);
    expect(page.hasMore).toBe(true);
  });

  it("derives hasMore from total when the upstream omits `more`", async () => {
    const p = new NeteaseProvider("http://x");
    withGet(p, (_path, cfg) => ({
      songs: rawSongs.slice(cfg.params.offset, cfg.params.offset + cfg.params.limit),
      total: 2,
    }));

    expect((await p.getArtistAllSongs("1", 0, 1)).hasMore).toBe(true);
    expect((await p.getArtistAllSongs("1", 1, 1)).hasMore).toBe(false);
  });

  it("clamps limit to 100, offset to >= 0, and derives a total when absent", async () => {
    const p = new NeteaseProvider("http://x");
    const get = withGet(p, () => ({ songs: rawSongs }));

    const page = await p.getArtistAllSongs("1", -5, 500);

    expect(get.mock.calls[0][1].params).toMatchObject({ limit: 100, offset: 0 });
    expect(page.total).toBe(2);
    expect(page.hasMore).toBe(false);
  });
});

describe("NetEase quality fallback ladder", () => {
  it("offers every lower level, best-first, for the default 320k setting", () => {
    const p = new NeteaseProvider("http://x");
    // Default quality is exhigh (320k) → 192k then 128k.
    expect(p.getFallbackQualities()).toEqual(["higher", "standard"]);
  });

  // The real-world case that produced «点四五次才能播»: a track playable at
  // 192k while BOTH 320k and 128k return null. Dropping only to the cheapest
  // level would still fail, so 192k has to be in the list.
  it("includes intermediate levels, not just the cheapest", () => {
    const p = new NeteaseProvider("http://x");
    p.setQuality("lossless");
    expect(p.getFallbackQualities()).toEqual(["exhigh", "higher", "standard"]);
  });

  it("has nothing to offer once already at the lowest level", () => {
    const p = new NeteaseProvider("http://x");
    p.setQuality("standard");
    expect(p.getFallbackQualities()).toEqual([]);
  });

  it("never proposes a level above the configured one", () => {
    const p = new NeteaseProvider("http://x");
    p.setQuality("higher");
    expect(p.getFallbackQualities()).toEqual(["standard"]);
  });
});

// ---------------------------------------------------------------------------
// Risk control (-460)
//
// Live measurement on a cloud host, same song, same second:
//   GET /song/url/v1?id=1827600686&level=exhigh                  → 400 {"code":-460}
//   GET …&cookie=<account cookie>                                → 200, 320k url
// axios reports both 400s and 200s alike as ERR_BAD_REQUEST when it fails, so
// the body has to be inspected to know whether retrying is worthwhile.
// ---------------------------------------------------------------------------
describe("NetEase risk control (-460)", () => {
  /** Swap the axios instance for a stub — no module mocking needed. */
  function providerWithApi(get: (url: string, cfg: unknown) => Promise<unknown>) {
    const p = new NeteaseProvider("http://127.0.0.1:3001");
    (p as unknown as { api: { get: typeof get } }).api = { get };
    return p;
  }

  function httpError(status: number, data: unknown) {
    const err = new Error(`Request failed with status code ${status}`) as Error & {
      response: unknown;
    };
    err.response = { status, data };
    return err;
  }

  it("turns 400 + code -460 into a RiskControlError", async () => {
    const p = providerWithApi(async () => {
      throw httpError(400, {
        code: -460,
        message: "检测到您的网络环境存在风险，请稍后再试",
      });
    });
    await expect(p.getSongUrl("1827600686")).rejects.toBeInstanceOf(RiskControlError);
  });

  it("keeps the upstream message so the log says what happened", async () => {
    const p = providerWithApi(async () => {
      throw httpError(400, { code: -460, message: "检测到您的网络环境存在风险，请稍后再试" });
    });
    await expect(p.getSongUrl("1827600686")).rejects.toThrow(/风险/);
  });

  it("does not disguise a genuine bad request", async () => {
    const p = providerWithApi(async () => {
      throw httpError(400, { code: 400, msg: "参数错误" });
    });
    await expect(p.getSongUrl("1")).rejects.not.toBeInstanceOf(RiskControlError);
  });

  it("does not disguise an unrelated 400 without a body code", async () => {
    const p = providerWithApi(async () => {
      throw httpError(400, "<html>Bad Request</html>");
    });
    await expect(p.getSongUrl("1")).rejects.not.toBeInstanceOf(RiskControlError);
  });

  // A 200 with no url is not "the track does not exist" — it is one of five
  // different things, and this used to collapse all of them into a bare null.
  it("names the cause for a 200 that carries no url", async () => {
    const p = providerWithApi(async () => ({ data: { data: [{ url: null, code: 404 }] } }));
    await expect(p.getSongUrl("1")).rejects.toMatchObject({
      failure: { code: "no_copyright" },
    });
  });

  it("returns the url and the trial window on success", async () => {
    const p = providerWithApi(async () => ({
      data: { data: [{ url: "http://cdn.example/x.mp3", freeTrialInfo: { start: 0, end: 60 } }] },
    }));
    const r = await p.getSongUrl("1");
    expect(r?.url).toBe("http://cdn.example/x.mp3");
    expect(r?.trialDuration).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// Naming the cause of a 200-with-no-URL
//
// `/song/url/v1` says "no URL here" for at least four unrelated reasons and the
// fix differs for each: open a membership, pick another track, drop the quality,
// or wait. Collapsing them into `null` is what produced the catch-all
// 「无法播放（区域/版权限制）」 for a problem that was usually not about copyright.
// ---------------------------------------------------------------------------
describe("NetEase — why a track has no URL", () => {
  /** Resolve and return the thrown error; fails loudly if it does not throw. */
  async function miss(item: Record<string, unknown> | undefined): Promise<any> {
    const p = new NeteaseProvider("http://127.0.0.1:3001");
    (p as unknown as { api: { get: () => Promise<unknown> } }).api = {
      get: async () => ({ data: { data: item ? [item] : [] } }),
    };
    try {
      await p.getSongUrl("1");
    } catch (err) {
      return err;
    }
    throw new Error("expected getSongUrl to throw for a URL-less response");
  }

  it("fee=1 未购买 → 需要会员", async () => {
    const err = await miss({ url: null, code: 200, fee: 1, payed: 0, level: "exhigh" });
    expect(err.failure.code).toBe("vip_required");
    expect(err.failure.message).toMatch(/需要会员/);
  });

  it("fee=4 未购买 → 需要购买专辑（不是「会员」）", async () => {
    const err = await miss({ url: null, code: 200, fee: 4, payed: 0, level: "exhigh" });
    expect(err.failure.code).toBe("vip_required");
    expect(err.failure.message).toMatch(/专辑/);
  });

  it("已付款的曲目不算会员问题", async () => {
    const err = await miss({ url: null, code: 200, fee: 1, payed: 1, level: "exhigh" });
    expect(err.failure.code).toBe("quality_denied");
  });

  it("upstream code 404 → 无版权", async () => {
    const err = await miss({ url: null, code: 404, level: "exhigh" });
    expect(err.failure.code).toBe("no_copyright");
    expect(err.failure.message).toMatch(/无版权|下架/);
  });

  // The measured case that broke the old single-message assumption: a free
  // track (fee=8) with no URL at exhigh that plays fine at higher.
  it("fee=8 且无 URL → 音质受限，而不是版权", async () => {
    const err = await miss({ url: null, code: 200, fee: 8, level: "exhigh" });
    expect(err.failure.code).toBe("quality_denied");
    expect(err.failure.message).toMatch(/音质/);
  });

  it("空 data 数组 → 未知，但仍带得出上游字段", async () => {
    const err = await miss(undefined);
    expect(err.failure.code).toBe("unknown");
    expect(err.failure.upstream).toBeDefined();
  });

  it("把 fee / payed / level 留在 upstream 里供日志使用", async () => {
    const err = await miss({ url: null, code: 200, fee: 8, payed: 0, level: "higher", br: 192000 });
    expect(err.failure.upstream).toMatchObject({ fee: 8, payed: 0, level: "higher", br: 192000 });
  });
});

// ---------------------------------------------------------------------------
// Outbound proxy
//
// On a cloud host NetEase answers -460 by IP, so the request has to leave from
// somewhere else. The sidecar (NeteaseCloudMusicApi) supports this natively via
// a `proxy` request parameter — no new dependency, no global-agent patching.
// These tests pin that it is carried on EVERY call and that the default stays
// exactly as before.
// ---------------------------------------------------------------------------
describe("NetEase — outbound proxy", () => {
  function capture() {
    const seen: Array<Record<string, unknown>> = [];
    const p = new NeteaseProvider("http://127.0.0.1:3001");
    (p as unknown as { api: { get: (u: string, c: any) => Promise<unknown> } }).api = {
      get: async (_url: string, cfg: any) => {
        seen.push({ ...cfg?.params });
        return { data: { result: {}, data: [{ url: null, code: 200, fee: 8, level: "exhigh" }] } };
      },
    };
    return { p, seen };
  }

  it("sends no proxy parameter by default — behaviour is unchanged", async () => {
    const { p, seen } = capture();
    await p.search("x").catch(() => {});
    expect(seen.length).toBeGreaterThan(0);
    for (const params of seen) expect(params.proxy).toBeUndefined();
  });

  it("carries the proxy on every call once configured", async () => {
    const { p, seen } = capture();
    p.setProxy("http://192.168.1.9:8118");
    await p.search("x").catch(() => {});
    expect(seen.length).toBeGreaterThan(0);
    for (const params of seen) expect(params.proxy).toBe("http://192.168.1.9:8118");
  });

  it("carries it on the playback call too — that is the one that gets -460", async () => {
    const { p, seen } = capture();
    p.setProxy("http://192.168.1.9:8118");
    await p.getSongUrl("1", "standard").catch(() => {});
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ id: "1", level: "standard", proxy: "http://192.168.1.9:8118" });
  });

  it("keeps the cookie alongside the proxy", async () => {
    const { p, seen } = capture();
    p.setCookie("MUSIC_U=abc");
    p.setProxy("http://h:1");
    await p.getSongUrl("1").catch(() => {});
    // cookie is normalised on the way in, so compare loosely.
    expect(String(seen[0].cookie)).toContain("MUSIC_U=abc");
    expect(seen[0].proxy).toBe("http://h:1");
  });

  it("treats a blank value as direct service", async () => {
    const { p, seen } = capture();
    p.setProxy("   ");
    await p.search("x").catch(() => {});
    for (const params of seen) expect(params.proxy).toBeUndefined();
    expect(p.getProxy()).toBe("");
  });

  it("trims the value it is given", () => {
    const p = new NeteaseProvider("http://x");
    p.setProxy("  http://h:1  ");
    expect(p.getProxy()).toBe("http://h:1");
  });
});
