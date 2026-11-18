import { describe, it, expect, vi, beforeEach } from "vitest";

// All axios.create(...) instances in qq.ts (qqMusicuApi / qqSearchApi / qqFavApi
// and the per-instance api) share this single mock so the search test can
// inspect the outgoing params/body regardless of which client issued them.
const { mockGet, mockPost } = vi.hoisted(() => ({ mockGet: vi.fn(), mockPost: vi.fn() }));
vi.mock("axios", () => ({
  default: { create: () => ({ get: mockGet, post: mockPost }) },
}));

import { mapQqAlbums, mapQqArtists, mapQqSongs, parseQqTrial, QQMusicProvider } from "./qq.js";

describe("QQ playback sidecar contract", () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  it("maps app playback quality to the installed sidecar format", async () => {
    const provider = new QQMusicProvider("http://127.0.0.1:3200");
    provider.setQuality("lossless");
    mockGet.mockResolvedValue({ data: { data: { playUrl: { abc: { url: "https://example.com/audio" } } } } });
    await expect(provider.getSongUrl("abc")).resolves.toMatchObject({ url: "https://example.com/audio" });
    expect(mockGet).toHaveBeenLastCalledWith("/getMusicPlay", { params: expect.objectContaining({ songmid: "abc", quality: "flac" }) });
  });

  it.each([320, "320"])("accepts QQ quality %j from the settings API", async (quality) => {
    const provider = new QQMusicProvider("http://127.0.0.1:3200");
    provider.setQuality(quality);
    expect(provider.getQuality()).toBe("320");
    mockGet.mockResolvedValue({ data: { data: { playUrl: { abc: { url: "https://example.com/audio" } } } } });
    await provider.getSongUrl("abc");
    expect(mockGet).toHaveBeenLastCalledWith("/getMusicPlay", { params: expect.objectContaining({ quality: "320" }) });
  });

  it("resolves a numeric ID to a MID before asking the sidecar for playback", async () => {
    const provider = new QQMusicProvider("http://127.0.0.1:3200");
    mockGet.mockResolvedValueOnce({ data: { response: { songinfo: { data: { track_info: { mid: "abc" } } } } } });
    mockGet.mockResolvedValueOnce({ data: { data: { playUrl: { abc: { url: "https://example.com/audio" } } } } });
    await expect(provider.getSongUrl("12345")).resolves.toMatchObject({ url: "https://example.com/audio" });
    expect(mockGet).toHaveBeenNthCalledWith(1, "/getSongInfo", { params: expect.objectContaining({ songid: "12345" }) });
    expect(mockGet).toHaveBeenNthCalledWith(2, "/getMusicPlay", { params: expect.objectContaining({ songmid: "abc" }) });
  });

  it("separates a broken sidecar from a track without a URL", async () => {
    const provider = new QQMusicProvider("http://127.0.0.1:3200");
    mockGet.mockRejectedValue({ response: { status: 502, data: { hidden: "test-cookie" } } });
    await expect(provider.getSongUrl("abc")).rejects.toMatchObject({
      failure: { code: "upstream_request_failed", upstream: { httpStatus: 502 } },
    });
    expect(mockGet).toHaveBeenCalledOnce();
  });

  it("keeps tracks playable at a supported fallback quality during batch preflight", async () => {
    const provider = new QQMusicProvider("http://127.0.0.1:3200");
    provider.setQuality("exhigh");
    mockGet.mockResolvedValueOnce({ data: { data: { playUrl: { abc: { url: "https://example.com/audio1" }, def: { url: "" } } } } });
    mockGet.mockResolvedValueOnce({ data: { data: { playUrl: { def: { url: "https://example.com/audio2" } } } } });
    await expect(provider.getPlayableSongIds(["abc", "def"])).resolves.toEqual(new Set(["abc", "def"]));
    expect(mockGet).toHaveBeenNthCalledWith(2, "/getMusicPlay", { params: expect.objectContaining({ songmid: "def", quality: "128" }) });
  });

  it.each([{}, { abc: { url: "" } }, { abc: { url: "" }, def: { url: 17 } }])(
    "does not interpret incomplete or unconfirmed HTTP 200 play maps as unavailable",
    async (playUrl) => {
      const provider = new QQMusicProvider("http://127.0.0.1:3200");
      provider.setQuality("128");
      mockGet.mockResolvedValue({ status: 200, data: { data: { playUrl } } });
      await expect(provider.getPlayableSongIds(["abc", "def"])).resolves.toBeNull();
    },
  );

  it("does not treat an upstream error inside HTTP 200 as a final no-URL result", async () => {
    const provider = new QQMusicProvider("http://127.0.0.1:3200");
    provider.setQuality("128");
    mockGet.mockResolvedValue({ status: 200, data: { data: { code: 0, req_0: { code: 502 }, playUrl: { abc: { url: "" } } } } });
    await expect(provider.getPlayableSongIds(["abc"])).resolves.toBeNull();
    await expect(provider.getSongUrl("abc")).rejects.toMatchObject({
      failure: { code: "upstream_request_failed", upstream: { code: 502 } },
    });
  });

  it("accepts a fully confirmed no-play result and a numeric HTTP envelope success code", async () => {
    const provider = new QQMusicProvider("http://127.0.0.1:3200");
    provider.setQuality("128");
    mockGet.mockResolvedValue({ status: 200, data: { code: 200, data: {
      code: "0", req_0: { code: 0, data: { midurlinfo: [{ songmid: "abc", purl: "" }] } }, playUrl: { abc: { url: "" } },
    } } });
    await expect(provider.getPlayableSongIds(["abc"])).resolves.toEqual(new Set());
  });

  it("stops playback before sending a request when the sidecar port is occupied by another service", async () => {
    const guard = () => { throw Object.assign(new Error("QQ sidecar port conflict"), { code: "QQ_API_PORT_CONFLICT" }); };
    const provider = new QQMusicProvider("http://127.0.0.1:3200", undefined, guard);
    await expect(provider.getSongUrl("abc")).rejects.toMatchObject({
      failure: { code: "upstream_request_failed", message: expect.stringContaining("端口") },
    });
    expect(mockGet).not.toHaveBeenCalled();
  });
});

describe("QQ adapter", () => {
  it("mapQqSongs maps QQMusicApi-style song entries", () => {
    const out = mapQqSongs([
      {
        mid: "001abc",
        name: "Radar Song",
        singer: [{ name: "Singer A" }, { name: "Singer B" }],
        album: { name: "Album A", mid: "alb001" },
        interval: 243,
      },
    ]);

    expect(out).toEqual([
      {
        id: "001abc",
        name: "Radar Song",
        artist: "Singer A / Singer B",
        album: "Album A",
        duration: 243,
        coverUrl: "https://y.gtimg.cn/music/photo_new/T002R300x300M000alb001.jpg",
        platform: "qq",
        vip: false,
      },
    ]);
  });

  it("mapQqSongs maps pay field to vip flag", () => {
    const out = mapQqSongs([
      { mid: "v1", name: "VIP playplay", singer: [], album: {}, interval: 100, pay: { payplay: 1, paytrackprice: 0 } },
      { mid: "v2", name: "VIP trackprice", singer: [], album: {}, interval: 100, pay: { payplay: 0, paytrackprice: 1 } },
      { mid: "f1", name: "Free", singer: [], album: {}, interval: 100, pay: { payplay: 0, paytrackprice: 0 } },
      { mid: "f2", name: "No pay field", singer: [], album: {}, interval: 100 },
    ]);
    expect(out[0].vip).toBe(true);
    expect(out[1].vip).toBe(true);
    expect(out[2].vip).toBe(false);
    expect(out[3].vip).toBe(false);
  });

  it("parseQqTrial maps isTryout/tryout to trial seconds", () => {
    // 非试听（VIP/免费）
    expect(parseQqTrial({ isTryout: 0 })).toBeUndefined();
    expect(parseQqTrial({})).toBeUndefined();
    // 试听（秒）
    expect(parseQqTrial({ isTryout: 1, tryBegin: 0, tryEnd: 30 })).toBe(30);
    expect(parseQqTrial({ tryout: true, begin: 0, end: 45 })).toBe(45);
    // 毫秒兜底
    expect(parseQqTrial({ isTryout: 1, tryBegin: 0, tryEnd: 30000 })).toBe(30);
    // 异常
    expect(parseQqTrial({ isTryout: 1, tryEnd: 0 })).toBeUndefined();
  });

  it("mapQqAlbums maps albumMID-style raw entries", () => {
    const raw = [
      {
        albumMID: "abc",
        albumName: "Aero",
        singerName: "Singer A",
      },
      {
        albumMID: "xyz",
        albumName: "Beta",
        singer: [{ name: "Singer B" }, { name: "Singer C" }],
      },
    ];
    const out = mapQqAlbums(raw);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      id: "abc",
      name: "Aero",
      artist: "Singer A",
      platform: "qq",
    });
    expect(out[0].coverUrl).toContain("T002R300x300M000abc.jpg");
    expect(out[1].artist).toBe("Singer B / Singer C");
    expect(out[1].coverUrl).toContain("xyz");
  });

  it("mapQqAlbums returns [] for empty/null input", () => {
    expect(mapQqAlbums([])).toEqual([]);
    expect(mapQqAlbums(null as any)).toEqual([]);
    expect(mapQqAlbums(undefined as any)).toEqual([]);
  });

  it("mapQqAlbums falls back to albumPic when no albumMID", () => {
    const raw = [{ albumName: "C", albumPic: "https://x/p.jpg", singerName: "S" }];
    const out = mapQqAlbums(raw);
    expect(out[0].coverUrl).toBe("https://x/p.jpg");
    expect(out[0].id).toBe("");
  });
});

describe("QQMusicProvider.search pagination", () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
  });

  /** musicu.fcg returns one song → primary path succeeds. */
  function musicuOk() {
    mockGet.mockImplementation(async (url: string) => {
      if (url === "/cgi-bin/musicu.fcg") {
        return {
          data: {
            req_0: { data: { body: { song: { list: [{ mid: "m1", name: "S", singer: [], album: {}, interval: 100 }] } } } },
            req_album: { data: { body: { album: { list: [] } } } },
            req_playlist: { data: { body: { songlist: { list: [] } } } },
          },
        };
      }
      return { data: {} };
    });
  }

  function musicuReqData() {
    const call = mockGet.mock.calls.find((c: any[]) => c[0] === "/cgi-bin/musicu.fcg");
    expect(call, "expected a musicu.fcg call").toBeTruthy();
    return JSON.parse(call![1].params.data);
  }

  it("adds page_num (offset/limit+1) and limit-driven num_per_page for songs/albums/playlists", async () => {
    musicuOk();
    const p = new QQMusicProvider("http://x");
    await p.search("hello", 20, 20); // page 2

    const d = musicuReqData();
    expect(d.req_0.param.page_num).toBe(2);
    expect(d.req_0.param.num_per_page).toBe(20);
    // Albums/playlists: num_per_page must be limit-driven (NOT hardcoded 10).
    expect(d.req_album.param.page_num).toBe(2);
    expect(d.req_album.param.num_per_page).toBe(20);
    expect(d.req_playlist.param.page_num).toBe(2);
    expect(d.req_playlist.param.num_per_page).toBe(20);
  });

  it("defaults offset to 0 → page_num 1 (backward compatible)", async () => {
    musicuOk();
    const p = new QQMusicProvider("http://x");
    await p.search("hello", 20);
    const d = musicuReqData();
    expect(d.req_0.param.page_num).toBe(1);
  });

  it("fallback client_search_cp sets p to the page cursor", async () => {
    // musicu returns no songs → primary returns null → fallback runs.
    mockGet.mockImplementation(async (url: string) => {
      if (url === "/cgi-bin/musicu.fcg") {
        return { data: { req_0: { data: { body: { song: { list: [] } } } } } };
      }
      // client_search_cp
      return { data: { data: { song: { list: [] }, album: { list: [] } } } };
    });
    const p = new QQMusicProvider("http://x");
    await p.search("hello", 20, 20); // page 2

    const songCall = mockGet.mock.calls.find(
      (c: any[]) => c[0] === "/soso/fcgi-bin/client_search_cp" && c[1]?.params?.type === 0
    );
    expect(songCall, "expected a client_search_cp song call").toBeTruthy();
    expect(songCall![1].params.p).toBe(2);
  });

  it("adds the singer sub-request (search_type 1) to the same musicu batch", async () => {
    musicuOk();
    const p = new QQMusicProvider("http://x");
    await p.search("周杰伦", 20, 0);

    const d = musicuReqData();
    expect(d.req_artist.param.search_type).toBe(1);
    expect(d.req_artist.param.num_per_page).toBe(20);
    expect(d.req_artist.param.page_num).toBe(1);
  });

  it("returns singers even when the song list is empty (no client_search_cp fallback)", async () => {
    mockGet.mockImplementation(async (url: string) => {
      if (url === "/cgi-bin/musicu.fcg") {
        return {
          data: {
            req_0: { data: { body: { song: { list: [] } } } },
            req_album: { data: { body: { album: { list: [] } } } },
            req_playlist: { data: { body: { songlist: { list: [] } } } },
            req_artist: {
              data: { body: { singer: { list: [{ singerMID: "m1", singerName: "Adele", songNum: 88 }] } } },
            },
          },
        };
      }
      return { data: {} };
    });
    const p = new QQMusicProvider("http://x");
    const res = await p.search("Adele", 20, 0);

    expect(res.songs).toEqual([]);
    expect(res.artists).toEqual([
      {
        id: "m1",
        name: "Adele",
        avatarUrl: "https://y.gtimg.cn/music/photo_new/T001R500x500M000m1.jpg",
        songCount: 88,
        albumCount: undefined,
        platform: "qq",
      },
    ]);
    expect(mockGet.mock.calls.some((c: any[]) => c[0] === "/soso/fcgi-bin/client_search_cp")).toBe(false);
  });
});

describe("mapQqArtists (singer search + detail)", () => {
  it("maps singer list entries and builds the 500px portrait from the MID", () => {
    const out = mapQqArtists([
      {
        singerMID: "abc",
        singerName: "周杰伦",
        singerPic: "http://y.gtimg.cn/music/photo_new/T001R150x150M000abc_11.jpg",
        songNum: 500,
        albumNum: 30,
      },
    ]);
    expect(out).toEqual([
      {
        id: "abc",
        name: "周杰伦",
        avatarUrl: "https://y.gtimg.cn/music/photo_new/T001R500x500M000abc.jpg",
        songCount: 500,
        albumCount: 30,
        platform: "qq",
      },
    ]);
  });

  it("falls back to the given picture when no MID is present", () => {
    const out = mapQqArtists([
      { singerID: 42, singerName: "Y", singerPic: "https://y.gtimg.cn/music/photo_new/x.jpg" },
    ]);
    expect(out).toEqual([
      {
        id: "42",
        name: "Y",
        avatarUrl: "https://y.gtimg.cn/music/photo_new/x.jpg",
        songCount: undefined,
        albumCount: undefined,
        platform: "qq",
      },
    ]);
  });

  it("drops entries without an id or name and tolerates empty input", () => {
    expect(mapQqArtists([{ singerName: "no id" }, { singerMID: "x" }])).toEqual([]);
    expect(mapQqArtists([])).toEqual([]);
    expect(mapQqArtists(null as any)).toEqual([]);
    expect(mapQqArtists(undefined as any)).toEqual([]);
  });
});

describe("QQMusicProvider.getArtistAllSongs (album aggregation)", () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  function songRaw(mid: string, title: string) {
    return { mid, title, singer: [{ name: "Adele" }], album: { mid: "al1", name: "Album" }, interval: 200 };
  }

  it("does not cache a hot-only catalogue when the singer lookup for the album scan fails", async () => {
    let singerCalls = 0;
    mockGet.mockImplementation(async (url: string, cfg: any) => {
      if (url === "/getAlbumInfo") {
        return { data: { response: { data: { list: [songRaw("album-track", "Album track")] } } } };
      }
      if (url !== "/cgi-bin/musicu.fcg") return { data: {} };
      const data = JSON.parse(cfg.params.data);
      if (data.req_0) {
        if (++singerCalls === 2) throw new Error("temporary singer lookup failure");
        return { data: { req_0: { data: { singer_info: { mid: "m1", name: "Adele" }, songlist: [songRaw("hot", "Hot")] } } } };
      }
      const list = data.req_album.param.page_num === 1 ? [{ albumMID: "al1", singerMID: "m1" }] : [];
      return { data: { req_album: { data: { body: { album: { list } } } } } };
    });
    const provider = new QQMusicProvider("http://x");
    expect((await provider.getArtistAllSongs("m1")).songs.map((s) => s.id)).toEqual(["hot"]);
    expect((await provider.getArtistAllSongs("m1")).songs.map((s) => s.id)).toEqual(["hot", "album-track"]);
  });

  it.each([
    { code: 0, req_album: { code: 2000 } },
    { code: 500, req_album: { data: { body: { album: { list: [] } } } } },
    { req_album: { data: { body: {} } } },
    { req_album: { data: { body: { album: { list: {} } } } } },
  ])("does not cache logical or malformed album-search failure %#", async (failedResponse) => {
    let failed = true;
    mockGet.mockImplementation(async (url: string, cfg: any) => {
      if (url === "/getAlbumInfo") return { data: { response: { data: { list: [songRaw("album-track", "Album track")] } } } };
      if (url !== "/cgi-bin/musicu.fcg") return { data: {} };
      const data = JSON.parse(cfg.params.data);
      if (data.req_0) return { data: { req_0: { data: { singer_info: { mid: "m1", name: "Adele" }, songlist: [songRaw("hot", "Hot")] } } } };
      if (failed) return { data: failedResponse };
      const list = data.req_album.param.page_num === 1 ? [{ albumMID: "al1", singerMID: "m1" }] : [];
      return { data: { code: 0, req_album: { code: 0, data: { body: { album: { list } } } } } };
    });
    const provider = new QQMusicProvider("http://x");
    const degraded = await provider.getArtistAllSongs("m1");
    expect(degraded.songs.map((s) => s.id)).toEqual(["hot"]);
    failed = false;
    expect((await provider.getArtistAllSongs("m1")).songs.map((s) => s.id)).toEqual(["hot", "album-track"]);
  });

  it("includes more than 50 short albums when the catalogue is below the 500-song ceiling", async () => {
    mockCatalogue({
      hot: [songRaw("hot", "Hot")],
      albumSearch: (page) => Array.from({ length: page === 1 ? 50 : page === 2 ? 10 : 0 }, (_, i) => ({ albumMID: `al${(page - 1) * 50 + i}`, singerMID: "m1" })),
      albumSongs: Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`al${i}`, [songRaw(`s${i}`, `${i}`)]])),
    });
    const result = await new QQMusicProvider("http://x").getArtistAllSongs("m1", 0, 100);
    expect(result.songs).toHaveLength(61);
    expect(result.total).toBe(61);
    expect(result.hasMore).toBe(false);
  });

  it.each([
    { response: { code: 2000, data: { list: [] } } },
    { response: { data: {} } },
    { response: { data: { list: [{}] } } },
    { response: { data: { list: [{ mid: "" }] } } },
    { response: { data: { list: [{ mid: "   " }] } } },
    { response: { data: { list: [{ mid: {} }] } } },
  ])("does not cache a catalogue after a logical or malformed album-song failure %#", async (failedResponse) => {
    let failed = true;
    mockGet.mockImplementation(async (url: string, cfg: any) => {
      if (url === "/getAlbumInfo") return { data: failed ? failedResponse : { response: { data: { list: [songRaw("album-track", "Album track")] } } } };
      if (url !== "/cgi-bin/musicu.fcg") return { data: {} };
      const data = JSON.parse(cfg.params.data);
      if (data.req_0) return { data: { req_0: { data: { singer_info: { mid: "m1", name: "Adele" }, songlist: [songRaw("hot", "Hot")] } } } };
      const list = data.req_album.param.page_num === 1 ? [{ albumMID: "al1", singerMID: "m1" }] : [];
      return { data: { req_album: { data: { body: { album: { list } } } } } };
    });
    const provider = new QQMusicProvider("http://x");
    expect((await provider.getArtistAllSongs("m1")).songs.map((s) => s.id)).toEqual(["hot"]);
    failed = false;
    expect((await provider.getArtistAllSongs("m1")).songs.map((s) => s.id)).toEqual(["hot", "album-track"]);
  });

  it("does not cache a catalogue whose hot-song rows contain no song identifier", async () => {
    let failed = true;
    mockGet.mockImplementation(async (url: string, cfg: any) => {
      if (url === "/getAlbumInfo") return { data: { response: { data: { list: [songRaw("album-track", "Album track")] } } } };
      if (url !== "/cgi-bin/musicu.fcg") return { data: {} };
      const data = JSON.parse(cfg.params.data);
      if (data.req_0) return { data: { req_0: { data: { singer_info: { mid: "m1", name: "Adele" }, songlist: failed ? [{}] : [songRaw("hot", "Hot")] } } } };
      const list = data.req_album.param.page_num === 1 ? [{ albumMID: "al1", singerMID: "m1" }] : [];
      return { data: { req_album: { data: { body: { album: { list } } } } } };
    });
    const provider = new QQMusicProvider("http://x");
    await provider.getArtistAllSongs("m1");
    failed = false;
    const recovered = await provider.getArtistAllSongs("m1");
    expect(recovered.songs.map((s) => s.id)).toEqual(["hot", "album-track"]);
    expect(recovered.hasMore).toBe(false);
  });

  it("bounds a large catalogue at 500 unique songs while reporting remaining tracks", async () => {
    mockCatalogue({
      hot: [songRaw("hot", "Hot")],
      albumSearch: () => [{ albumMID: "al1", singerMID: "m1" }],
      albumSongs: { al1: Array.from({ length: 600 }, (_, i) => songRaw(`s${i}`, `${i}`)) },
    });
    const provider = new QQMusicProvider("http://x");
    const last = await provider.getArtistAllSongs("m1", 400, 100);
    expect(last.songs).toHaveLength(100);
    expect(last.hasMore).toBe(true);
    expect(last.total).toBeGreaterThan(500);
    expect((await provider.getArtistAllSongs("m1", 500, 100)).songs).toEqual([]);
  });

  it("reports a complete catalogue of exactly 500 songs without an extra page", async () => {
    mockCatalogue({
      hot: [songRaw("hot", "Hot")],
      albumSearch: () => [{ albumMID: "al1", singerMID: "m1" }],
      albumSongs: { al1: Array.from({ length: 499 }, (_, i) => songRaw(`s${i}`, `${i}`)) },
    });
    const last = await new QQMusicProvider("http://x").getArtistAllSongs("m1", 400, 100);
    expect(last.total).toBe(500);
    expect(last.hasMore).toBe(false);
  });

  it("does not treat a page without matching singers as the end of the search", async () => {
    mockCatalogue({
      hot: [songRaw("hot", "Hot")],
      albumSearch: (page) => page === 1
        ? Array.from({ length: 50 }, (_, i) => ({ albumMID: `other${i}`, singerMID: "other" }))
        : page === 2 ? [{ albumMID: "al1", singerMID: "m1" }] : [],
      albumSongs: { al1: [songRaw("album-track", "Album track")] },
    });
    expect((await new QQMusicProvider("http://x").getArtistAllSongs("m1")).songs.map((s) => s.id)).toEqual(["hot", "album-track"]);
  });

  it("leaves repeated search pages incomplete and retryable", async () => {
    mockCatalogue({
      hot: [songRaw("hot", "Hot")],
      albumSearch: () => Array.from({ length: 50 }, (_, i) => ({ albumMID: `al${i}`, singerMID: "m1" })),
    });
    const provider = new QQMusicProvider("http://x");
    expect((await provider.getArtistAllSongs("m1")).hasMore).toBe(true);
    mockCatalogue({ hot: [songRaw("hot", "Hot")], albumSearch: () => [] });
    const recovered = await provider.getArtistAllSongs("m1");
    expect(recovered.total).toBe(1);
    expect(recovered.hasMore).toBe(false);
  });

  it("bounds endless search pages of empty albums and leaves the partial result uncached", async () => {
    let searchCalls = 0;
    mockCatalogue({
      hot: [songRaw("hot", "Hot")],
      albumSearch: (page) => {
        if (++searchCalls > 110) throw new Error("unbounded upstream scan");
        return Array.from({ length: 50 }, (_, i) => ({ albumMID: `al${page}-${i}`, singerMID: "m1" }));
      },
    });
    const provider = new QQMusicProvider("http://x");
    const partial = await provider.getArtistAllSongs("m1");
    expect(searchCalls).toBeLessThanOrEqual(100);
    expect(partial.hasMore).toBe(true);
    mockCatalogue({ hot: [songRaw("hot", "Hot")], albumSearch: () => [] });
    expect((await provider.getArtistAllSongs("m1")).hasMore).toBe(false);
  });

  /** singer detail (top 50) + album search pages + per-album song lists. */
  function mockCatalogue(opts: {
    hot?: any[];
    albumSearch?: (page: number) => any[];
    albumSongs?: Record<string, any[]>;
    albumInfoFails?: boolean;
  }) {
    mockGet.mockImplementation(async (url: string, cfg: any) => {
      if (url === "/cgi-bin/musicu.fcg") {
        const data = JSON.parse(cfg.params.data);
        if (data.req_0) {
          return {
            data: {
              req_0: {
                data: {
                  singer_info: { mid: "m1", name: "Adele" },
                  total_song: 250,
                  songlist: opts.hot ?? [],
                },
              },
            },
          };
        }
        const page = data.req_album?.param?.page_num ?? 1;
        return {
          data: {
            req_album: { data: { body: { album: { list: (opts.albumSearch ?? (() => []))(page) } } } },
          },
        };
      }
      if (url === "/getAlbumInfo") {
        if (opts.albumInfoFails) throw new Error("album down");
        return { data: { response: { data: { list: opts.albumSongs?.[cfg.params.albummid] ?? [] } } } };
      }
      return { data: {} };
    });
  }

  it("merges the hot tracks with every album track, de-duplicated and paged", async () => {
    mockCatalogue({
      hot: [songRaw("s1", "Hot 1"), songRaw("s2", "Hot 2")],
      albumSearch: () => [
        { albumMID: "al1", albumName: "A", singerMID: "m1" },
        { albumMID: "al2", albumName: "B", singerMID: "m1" },
        { albumMID: "other", albumName: "C", singerMID: "m9" },
      ],
      albumSongs: {
        al1: [songRaw("s1", "Hot 1"), songRaw("s3", "Album 1")],
        al2: [songRaw("s4", "Album 2")],
      },
    });
    const p = new QQMusicProvider("http://x");

    const page = await p.getArtistAllSongs("m1", 0, 10);

    expect(page.songs.map((s) => s.id)).toEqual(["s1", "s2", "s3", "s4"]);
    expect(page.total).toBe(4);
    expect(page.hasMore).toBe(false);

    // The unrelated album (singerMID m9) is never fetched.
    const albumCalls = mockGet.mock.calls.filter((c: any[]) => c[0] === "/getAlbumInfo");
    expect(albumCalls.map((c: any[]) => c[1].params.albummid).sort()).toEqual(["al1", "al2"]);
    // A short page exhausts the search without another upstream request.
    const searchPages = mockGet.mock.calls
      .filter((c: any[]) => c[0] === "/cgi-bin/musicu.fcg")
      .map((c: any[]) => JSON.parse(c[1].params.data).req_album?.param?.page_num)
      .filter(Boolean);
    expect(searchPages).toEqual([1]);
  });

  it("slices pages with offset/limit and reports hasMore", async () => {
    mockCatalogue({
      hot: [songRaw("s1", "1"), songRaw("s2", "2"), songRaw("s3", "3")],
      albumSearch: () => [],
    });
    const p = new QQMusicProvider("http://x");

    const first = await p.getArtistAllSongs("m1", 0, 2);
    expect(first.songs.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(first.total).toBe(3);
    expect(first.hasMore).toBe(true);

    const second = await p.getArtistAllSongs("m1", 2, 2);
    expect(second.songs.map((s) => s.id)).toEqual(["s3"]);
    expect(second.hasMore).toBe(false);
  });

  it("caches the assembled catalogue (one upstream sweep per singer)", async () => {
    mockCatalogue({
      hot: [songRaw("s1", "1")],
      albumSearch: () => [{ albumMID: "al1", albumName: "A", singerMID: "m1" }],
      albumSongs: { al1: [songRaw("s9", "9")] },
    });
    const p = new QQMusicProvider("http://x");

    await p.getArtistAllSongs("m1", 0, 50);
    const callsAfterFirst = mockGet.mock.calls.length;
    const page = await p.getArtistAllSongs("m1", 0, 50);

    expect(mockGet.mock.calls.length).toBe(callsAfterFirst);
    expect(page.songs.map((s) => s.id)).toEqual(["s1", "s9"]);
  });

  it("degrades to the hot list when album lookups fail", async () => {
    mockCatalogue({
      hot: [songRaw("s1", "1")],
      albumSearch: () => [{ albumMID: "al1", albumName: "A", singerMID: "m1" }],
      albumInfoFails: true,
    });
    const p = new QQMusicProvider("http://x");

    const page = await p.getArtistAllSongs("m1", 0, 50);

    expect(page.songs.map((s) => s.id)).toEqual(["s1"]);
    expect(page.total).toBe(250);
    expect(page.hasMore).toBe(true);
  });

  it("retries a failed album search once before giving up", async () => {
    let albumSearchCalls = 0;
    mockGet.mockImplementation(async (url: string, cfg: any) => {
      if (url === "/cgi-bin/musicu.fcg") {
        const data = JSON.parse(cfg.params.data);
        if (data.req_0) {
          return {
            data: {
              req_0: {
                data: { singer_info: { mid: "m1", name: "Adele" }, songlist: [songRaw("s1", "1")] },
              },
            },
          };
        }
        albumSearchCalls++;
        if (albumSearchCalls === 1) throw new Error("blip");
        const list =
          data.req_album.param.page_num === 1
            ? [{ albumMID: "al1", albumName: "A", singerMID: "m1" }]
            : [];
        return { data: { req_album: { data: { body: { album: { list } } } } } };
      }
      if (url === "/getAlbumInfo") {
        return { data: { response: { data: { list: [songRaw("s9", "9")] } } } };
      }
      return { data: {} };
    });
    const p = new QQMusicProvider("http://x");

    const page = await p.getArtistAllSongs("m1", 0, 50);

    const page1Calls = mockGet.mock.calls.filter((c: any[]) => {
      if (c[0] !== "/cgi-bin/musicu.fcg") return false;
      return JSON.parse(c[1].params.data).req_album?.param?.page_num === 1;
    }).length;
    expect(page1Calls).toBe(2);
    expect(page.songs.map((s) => s.id)).toEqual(["s1", "s9"]);
  });

  it("does not cache a catalogue degraded by a failed album search", async () => {
    let albumSearchFails = true;
    mockGet.mockImplementation(async (url: string, cfg: any) => {
      if (url === "/cgi-bin/musicu.fcg") {
        const data = JSON.parse(cfg.params.data);
        if (data.req_0) {
          return {
            data: {
              req_0: {
                data: {
                  singer_info: { mid: "m1", name: "Adele" },
                  songlist: [songRaw("s1", "1")],
                },
              },
            },
          };
        }
        if (albumSearchFails) throw new Error("upstream hiccup");
        return {
          data: {
            req_album: {
              data: { body: { album: { list: [{ albumMID: "al1", albumName: "A", singerMID: "m1" }] } } },
            },
          },
        };
      }
      if (url === "/getAlbumInfo") {
        return { data: { response: { data: { list: [songRaw("s9", "9")] } } } };
      }
      return { data: {} };
    });
    const p = new QQMusicProvider("http://x");

    // The album search fails twice (call + retry) → hot list only, and the
    // degraded result must not be cached.
    const degraded = await p.getArtistAllSongs("m1", 0, 50);
    expect(degraded.songs.map((s) => s.id)).toEqual(["s1"]);
    expect(degraded.total).toBe(1);

    albumSearchFails = false;
    const full = await p.getArtistAllSongs("m1", 0, 50);
    expect(full.songs.map((s) => s.id)).toEqual(["s1", "s9"]);
    expect(full.total).toBe(2);
  });
});
