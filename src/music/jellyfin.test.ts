import { describe, it, expect, vi } from "vitest";
import {
  ticksToSeconds,
  TICKS_PER_SECOND,
  buildCoverUrl,
  buildStreamUrl,
  buildUniversalUrl,
  mapJellyfinSong,
  mapJellyfinAlbum,
  mapJellyfinPlaylist,
  mapJellyfinLyrics,
  describeJellyfinError,
  JELLYFIN_QUALITY_LEVELS,
  JellyfinProvider,
} from "./jellyfin.js";
import type { JellyfinConfig } from "../data/config.js";

function cfg(partial: Partial<JellyfinConfig> = {}): JellyfinConfig {
  return {
    serverUrl: "https://jf.example.com",
    authMode: "apikey",
    username: "",
    password: "",
    apiKey: "KEY",
    userId: "user-1",
    ...partial,
  };
}

/** Provider with a mocked axios instance; returns the request spy. */
function mockProvider(config = cfg(), responder?: (req: any) => any) {
  const p = new JellyfinProvider();
  p.configure(config);
  const request = vi.fn(async (req: any) => ({
    data: responder ? responder(req) : { Items: [] },
  }));
  (p as any).api = { request, post: vi.fn() };
  return { p, request };
}

describe("Jellyfin mapping helpers", () => {
  it("converts ticks to seconds (1 tick = 100ns)", () => {
    expect(ticksToSeconds(TICKS_PER_SECOND)).toBe(1);
    expect(ticksToSeconds(2_275_000_000)).toBeCloseTo(227.5, 3);
    expect(ticksToSeconds(undefined)).toBe(0);
    expect(ticksToSeconds(NaN)).toBe(0);
  });

  it("maps a Jellyfin audio item to Song (GUID id stays a string)", () => {
    const song = mapJellyfinSong(
      {
        Id: "3fa85f6457174562b3fc2c963f66afa6",
        Name: "Track",
        Artists: ["A", "B"],
        AlbumArtist: "A",
        Album: "The Album",
        RunTimeTicks: 1_855_000_000,
      },
      "https://jf/x.jpg",
    );
    expect(song).toEqual({
      id: "3fa85f6457174562b3fc2c963f66afa6",
      name: "Track",
      artist: "A / B",
      album: "The Album",
      duration: 186, // 185.5s rounded
      coverUrl: "https://jf/x.jpg",
      platform: "jellyfin",
    });
  });

  it("falls back to AlbumArtist when Artists is empty", () => {
    const song = mapJellyfinSong({ Id: "1", Artists: [], AlbumArtist: "Solo" }, "");
    expect(song.artist).toBe("Solo");
  });

  it("maps albums and playlists with ChildCount", () => {
    const album = mapJellyfinAlbum(
      { Id: "a1", Name: "LP", AlbumArtist: "X", ChildCount: 10 },
      "c",
    );
    expect(album).toMatchObject({ id: "a1", artist: "X", songCount: 10, platform: "jellyfin" });
    const pl = mapJellyfinPlaylist({ Id: "p1", Name: "Mix", ChildCount: 7 }, "c");
    expect(pl).toMatchObject({ id: "p1", songCount: 7, platform: "jellyfin" });
  });

  it("cover URL prefers the item's Primary image, falls back to the album's", () => {
    const own = buildCoverUrl("https://jf", "K", {
      Id: "i1",
      ImageTags: { Primary: "tag1" },
      AlbumId: "a1",
      AlbumPrimaryImageTag: "tag2",
    });
    expect(own).toBe("https://jf/Items/i1/Images/Primary?maxWidth=512&tag=tag1&api_key=K");
    const album = buildCoverUrl("https://jf", "K", {
      Id: "i1",
      AlbumId: "a1",
      AlbumPrimaryImageTag: "tag2",
    });
    expect(album).toBe("https://jf/Items/a1/Images/Primary?maxWidth=512&tag=tag2&api_key=K");
    expect(buildCoverUrl("https://jf", "K", { Id: "i1" })).toBe("");
  });

  it("builds direct and transcoded stream URLs", () => {
    expect(buildStreamUrl("https://jf", "K", "i1")).toBe(
      "https://jf/Audio/i1/stream?static=true&api_key=K",
    );
    const url = buildUniversalUrl("https://jf", {
      apiKey: "K",
      userId: "u",
      deviceId: "d",
      itemId: "i1",
      kbps: 320,
    });
    expect(url).toContain("https://jf/Audio/i1/universal?");
    expect(url).toContain("maxStreamingBitrate=320000");
    expect(url).toContain("transcodingContainer=mp3");
    expect(url).toContain("transcodingProtocol=http");
    // The container list must be URL-encoded ("|" → %7C)
    expect(url).toContain("container=mp3%2Caac%2Cm4a%7Caac%2Cflac%2Cwebma%2Cwebm%2Cwav%2Cogg");
  });

  it("maps lyrics with tick offsets; entries without Start collapse to 0; empty text dropped", () => {
    const lines = mapJellyfinLyrics({
      Lyrics: [
        { Text: "line two", Start: 125_000_000 },
        { Text: "line one", Start: 5_000_000 },
        { Text: "   ", Start: 1 },
        { Text: "untimed" },
      ],
    });
    expect(lines).toEqual([
      { time: 0, text: "untimed" },
      { time: 0.5, text: "line one" },
      { time: 12.5, text: "line two" },
    ]);
  });

  it("mapJellyfinLyrics tolerates junk payloads", () => {
    expect(mapJellyfinLyrics(null)).toEqual([]);
    expect(mapJellyfinLyrics({})).toEqual([]);
    expect(mapJellyfinLyrics({ Lyrics: "nope" })).toEqual([]);
  });

  it("describes common connection errors in a friendly way", () => {
    expect(describeJellyfinError({ response: { status: 401 } })).toContain("401");
    expect(describeJellyfinError({ code: "ECONNREFUSED" })).toContain("无法连接");
    expect(describeJellyfinError(new Error("boom"))).toBe("boom");
  });
});

describe("JellyfinProvider", () => {
  it("quality: defaults to direct, ignores foreign (NetEase) values", () => {
    const p = new JellyfinProvider();
    expect(p.getQuality()).toBe("direct");
    p.setQuality("exhigh"); // NetEase value from the legacy platform-less broadcast
    expect(p.getQuality()).toBe("direct");
    p.setQuality("320");
    expect(p.getQuality()).toBe("320");
    expect(JELLYFIN_QUALITY_LEVELS[0].value).toBe("direct");
  });

  it("getSongUrl: direct tier → static stream; 320 tier → universal transcode", async () => {
    const { p } = mockProvider();
    p.setCookie(JSON.stringify({ deviceId: "dev-1" }));
    const direct = await p.getSongUrl("item1");
    expect(direct?.url).toBe("https://jf.example.com/Audio/item1/stream?static=true&api_key=KEY");

    p.setQuality("320");
    const transcoded = await p.getSongUrl("item1");
    expect(transcoded?.url).toContain("/Audio/item1/universal?");
    expect(transcoded?.url).toContain("maxStreamingBitrate=320000");
    expect(transcoded?.url).toContain("api_key=KEY");
  });

  it("search hits /Items for Audio, MusicAlbum and Playlist with paging", async () => {
    const { p, request } = mockProvider();
    await p.search("mozart", 30, 60);
    const types = request.mock.calls.map((c) => c[0].params?.IncludeItemTypes);
    expect(types).toContain("Audio");
    expect(types).toContain("MusicAlbum");
    expect(types).toContain("Playlist");
    for (const call of request.mock.calls) {
      expect(call[0].params.Limit).toBe(30);
      expect(call[0].params.StartIndex).toBe(60);
      expect(call[0].params.userId).toBe("user-1");
      expect(call[0].headers["X-Emby-Token"]).toBe("KEY");
    }
  });

  it("userpass: authenticates once via AuthenticateByName, persists token, retries once on 401", async () => {
    const p = new JellyfinProvider();
    p.configure(cfg({ authMode: "userpass", username: "eric", password: "pw", apiKey: "", userId: "" }));
    const persisted: string[] = [];
    p.setPersist((s) => persisted.push(s));

    let tokenCounter = 0;
    const post = vi.fn(async (..._args: any[]) => ({
      data: { AccessToken: `tok-${++tokenCounter}`, User: { Id: "u9" } },
    }));
    // First data request 401s (expired token), the retry succeeds.
    let dataCalls = 0;
    const request = vi.fn(async (req: any) => {
      dataCalls++;
      if (dataCalls === 1) {
        const err: any = new Error("Unauthorized");
        err.response = { status: 401 };
        throw err;
      }
      return { data: { Items: [{ Id: "s1", Name: "N" }] }, config: req };
    });
    (p as any).api = { request, post };

    const songs = await p.getPlaylistSongs("pl1");
    expect(songs).toHaveLength(1);
    // login ran twice: initial auth + re-auth after the 401
    expect(post).toHaveBeenCalledTimes(2);
    const authHeader = post.mock.calls[0][2].headers.Authorization as string;
    expect(authHeader).toContain('MediaBrowser Client="TSMusicBot"');
    expect(authHeader).toContain("DeviceId=");
    expect(post.mock.calls[0][1]).toEqual({ Username: "eric", Pw: "pw" });
    // token + userId + deviceId persisted like cookies
    const last = JSON.parse(persisted[persisted.length - 1]);
    expect(last.accessToken).toBe("tok-2");
    expect(last.userId).toBe("u9");
    expect(last.deviceId).toBeTruthy();
  });

  it("userpass: surfaces the error when the retry also 401s (single retry only)", async () => {
    const p = new JellyfinProvider();
    p.configure(cfg({ authMode: "userpass", username: "eric", password: "bad", apiKey: "" }));
    const post = vi.fn(async () => ({ data: { AccessToken: "t", User: { Id: "u" } } }));
    const err: any = new Error("Unauthorized");
    err.response = { status: 401 };
    const request = vi.fn(async () => {
      throw err;
    });
    (p as any).api = { request, post };
    await expect(p.getPlaylistSongs("pl1")).rejects.toThrow("Unauthorized");
    expect(request).toHaveBeenCalledTimes(2); // original + exactly one retry
  });

  it("setCookie/getCookie round-trip restores token, userId and deviceId", () => {
    const p = new JellyfinProvider();
    p.setCookie(JSON.stringify({ accessToken: "T", userId: "U", deviceId: "D" }));
    expect(JSON.parse(p.getCookie())).toEqual({ accessToken: "T", userId: "U", deviceId: "D" });
    p.setCookie("not json"); // junk must not corrupt state
    expect(JSON.parse(p.getCookie())).toEqual({ accessToken: "T", userId: "U", deviceId: "D" });
  });

  it("getLyrics: 404 means no lyrics (empty), other errors surface", async () => {
    const notFound: any = new Error("nf");
    notFound.response = { status: 404 };
    const { p } = mockProvider(cfg(), () => {
      throw notFound;
    });
    expect(await p.getLyrics("i1")).toEqual([]);

    const boom: any = new Error("server down");
    boom.response = { status: 500 };
    const { p: p2 } = mockProvider(cfg(), () => {
      throw boom;
    });
    await expect(p2.getLyrics("i1")).rejects.toThrow("server down");
  });

  it("getAuthStatus reflects /System/Info reachability; unconfigured = logged out", async () => {
    const blank = new JellyfinProvider();
    expect(await blank.getAuthStatus()).toEqual({ loggedIn: false });

    const { p } = mockProvider(cfg(), () => ({ ServerName: "NAS" }));
    expect(await p.getAuthStatus()).toEqual({ loggedIn: true, nickname: "API Key@NAS" });

    const { p: down } = mockProvider(cfg(), () => {
      throw new Error("ECONNREFUSED");
    });
    expect(await down.getAuthStatus()).toEqual({ loggedIn: false });
  });

  it("getPersonalFm seeds InstantMix from a random favorite", async () => {
    const { p, request } = mockProvider(cfg(), (req: any) => {
      if (req.url.includes("/InstantMix")) {
        return { Items: [{ Id: "m1", Name: "Mixed" }] };
      }
      if (req.params?.Filters === "IsFavorite") {
        return { Items: [{ Id: "fav1", Name: "Fav" }] };
      }
      return { Items: [] };
    });
    const songs = await p.getPersonalFm();
    expect(songs.map((s) => s.id)).toEqual(["m1"]);
    const mixCall = request.mock.calls.find((c) => c[0].url.includes("/InstantMix"));
    expect(mixCall![0].url).toContain("/Items/fav1/InstantMix");
  });

  it("getPersonalFm falls back: favorites → recently played → random", async () => {
    const { p, request } = mockProvider(cfg(), (req: any) => {
      if (req.url.includes("/InstantMix")) return { Items: [{ Id: "m2" }] };
      if (req.params?.Filters === "IsFavorite") return { Items: [] };
      if (req.params?.Filters === "IsPlayed") return { Items: [{ Id: "recent1" }] };
      return { Items: [] };
    });
    const songs = await p.getPersonalFm();
    expect(songs.map((s) => s.id)).toEqual(["m2"]);
    const mixCall = request.mock.calls.find((c) => c[0].url.includes("/InstantMix"));
    expect(mixCall![0].url).toContain("/Items/recent1/InstantMix");
  });

  it("playback reporter posts start/progress/stopped with PositionTicks", async () => {
    const bodies: { url: string; data: any }[] = [];
    const { p } = mockProvider(cfg(), () => ({}));
    ((p as any).api.request as ReturnType<typeof vi.fn>).mockImplementation(
      async (req: any) => {
        bodies.push({ url: req.url, data: req.data });
        return { data: {} };
      },
    );

    const reporter = p.createPlaybackReporter();
    reporter.onTrackStart("song1");
    reporter.onTick("song1", 90.5, false);
    reporter.onStop();
    await vi.waitFor(() => expect(bodies).toHaveLength(3));

    expect(bodies[0].url).toContain("/Sessions/Playing");
    expect(bodies[0].data.ItemId).toBe("song1");
    const sessionId = bodies[0].data.PlaySessionId;
    expect(sessionId).toBeTruthy();

    expect(bodies[1].url).toContain("/Sessions/Playing/Progress");
    expect(bodies[1].data.PositionTicks).toBe(905_000_000);
    expect(bodies[1].data.PlaySessionId).toBe(sessionId);

    // Stop carries the LAST reported position so a natural track end counts as played.
    expect(bodies[2].url).toContain("/Sessions/Playing/Stopped");
    expect(bodies[2].data.PositionTicks).toBe(905_000_000);
  });

  it("reporter: a new track start closes the previous session; failures are swallowed", async () => {
    const bodies: { url: string; data: any }[] = [];
    const { p } = mockProvider(cfg(), () => ({}));
    ((p as any).api.request as ReturnType<typeof vi.fn>).mockImplementation(
      async (req: any) => {
        bodies.push({ url: req.url, data: req.data });
        if (req.url.includes("/Sessions")) throw new Error("reporting endpoint down");
        return { data: {} };
      },
    );

    const reporter = p.createPlaybackReporter();
    reporter.onTrackStart("a");
    reporter.onTick("a", 200, false);
    reporter.onTrackStart("b"); // must post Stopped for "a" at pos 200, then Playing for "b"
    reporter.onStop();
    await vi.waitFor(() => expect(bodies.length).toBeGreaterThanOrEqual(5));

    const stopped = bodies.filter((b) => b.url.includes("/Stopped"));
    expect(stopped[0].data.ItemId).toBe("a");
    expect(stopped[0].data.PositionTicks).toBe(2_000_000_000);
    expect(stopped[1].data.ItemId).toBe("b");
    // ticks for stale items are ignored
    reporter.onTick("a", 999, false);
    expect(bodies.filter((b) => b.url.includes("/Progress"))).toHaveLength(1);
  });

  it("testConnection reports server info on success and friendly errors on failure", async () => {
    const { p } = mockProvider(cfg(), () => ({ ServerName: "NAS", Version: "10.9.11" }));
    expect(await p.testConnection()).toEqual({ ok: true, serverName: "NAS", version: "10.9.11" });

    const bad = new JellyfinProvider();
    bad.configure(cfg({ apiKey: "", userId: "" }));
    const res = await bad.testConnection();
    expect(res.ok).toBe(false);
    expect(res.error).toContain("apiKey");
  });

  it("configure drops the cached token when credentials change, keeps deviceId", () => {
    const p = new JellyfinProvider();
    p.configure(cfg());
    p.setCookie(JSON.stringify({ accessToken: "T", userId: "U", deviceId: "D" }));
    p.configure(cfg({ serverUrl: "https://other.example.com" }));
    const state = JSON.parse(p.getCookie());
    expect(state.accessToken).toBe("");
    expect(state.deviceId).toBe("D");
  });
});
