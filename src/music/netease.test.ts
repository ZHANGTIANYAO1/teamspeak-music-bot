import { describe, it, expect, vi } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import {
  parseLyrics,
  mapNeteaseAlbums,
  mapNeteaseSongs,
  mapNeteaseArtists,
  parseNeteaseTrial,
  NeteaseProvider,
} from "./netease.js";

describe("NeteaseProvider realIP", () => {
  it("applies live IP changes to search, login, playback and existing personal views", async () => {
    const requests: URL[] = [];
    const server = createServer((req, res) => {
      requests.push(new URL(req.url!, "http://localhost"));
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ code: 200, data: [{ url: "https://example.com/song.mp3" }] }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      let realIP = "";
      const provider = new NeteaseProvider(baseUrl, () => realIP);
      provider.setCookie("MUSIC_U=shared");
      const personal = provider.withCookie("MUSIC_U=personal");
      await provider.getSongUrl("1");
      expect(requests.at(-1)!.searchParams.has("realIP")).toBe(false);

      requests.length = 0;
      realIP = "203.0.113.10";
      await provider.search("hello");
      await provider.getQrCode();
      await provider.sendSmsCode("13800000000");
      await provider.getSongUrl("2");
      expect(requests).toHaveLength(8);
      expect(requests.every((url) => url.searchParams.get("realIP") === realIP)).toBe(true);
      expect(requests.at(-1)!.searchParams.get("cookie")).toBe("MUSIC_U=shared");

      realIP = "2001:db8::1";
      await personal.getSongUrl("3");
      expect(requests.at(-1)!.searchParams.get("realIP")).toBe(realIP);
      expect(requests.at(-1)!.searchParams.get("cookie")).toBe("MUSIC_U=personal");
      expect(provider.getCookie()).toBe("MUSIC_U=shared");

      realIP = "";
      await personal.getSongUrl("4");
      expect(requests.at(-1)!.searchParams.has("realIP")).toBe(false);
      await new NeteaseProvider(baseUrl).getSongUrl("5");
      expect(requests.at(-1)!.searchParams.has("realIP")).toBe(false);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    }
  });
});

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
